# Coffee Stable Streaming Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Coffee's growing full-response redraw with a committed-line renderer so completed text is written once and unsupported or wrapping terminals fall back to safe append-only output.

**Architecture:** Keep the existing `StreamingMarkdownRenderer` public methods and the model/Agent event flow unchanged. The renderer will sanitize streamed text incrementally, render only the current short logical line as a transient preview, commit completed lines once, and permanently disable cursor redraw for the current segment when terminal capability or width is unsafe.

**Tech Stack:** TypeScript 7, Node.js streams and timers, ANSI terminal controls, `string-width`, Node test runner, existing `renderMarkdown()` formatter.

**Version-control note:** `/Users/sevan/ai-tasks/pi-agent/coffee` is not currently inside a Git repository. The checkpoints below run tests and inspect the changed-file list instead of creating commits. Do not initialize a repository as part of this feature.

---

## File map

- Modify: `src/streaming-markdown-renderer.ts` — replace full-segment frame accounting with incremental sanitization, committed logical lines, one-line previews, and safe segment fallback.
- Modify: `src/cli.ts` — pass live terminal metadata to the renderer and let the renderer preserve its active line before SIGINT prints the final newline.
- Modify: `test/streaming-markdown-renderer.test.ts` — replace full-frame redraw expectations with committed-line, dynamic-width, fallback, cleanup, and sanitization coverage.
- Modify: `test/cli.test.ts` — add end-to-end regressions for repeated growing frames and active-stream SIGINT cleanup.
- Modify: `README.md` — describe line-committed streaming and safe fallback instead of full Markdown segment redraw.

### Task 1: Lock the new renderer contract with failing tests

**Files:**
- Modify: `test/streaming-markdown-renderer.test.ts:14-50`
- Modify: `test/streaming-markdown-renderer.test.ts:53-167`
- Test: `test/streaming-markdown-renderer.test.ts`

- [ ] **Step 1: Make the harness expose live columns and terminal capability**

Replace the fixed `columns` option in `createHarness()` with a mutable output object and an explicit `term` option:

```ts
function createHarness(options: {
  isTTY?: boolean;
  useColor?: boolean;
  columns?: number;
  term?: string;
  prefix?: string;
  onWrite?: (chunk: string) => void;
} = {}) {
  const writes: string[] = [];
  const timers: PendingTimer[] = [];
  const output = {
    columns: options.columns ?? 80,
    write(chunk: string) {
      writes.push(chunk);
      options.onWrite?.(chunk);
    },
  };
  const renderer = createStreamingMarkdownRenderer({
    output,
    isTTY: options.isTTY ?? true,
    useColor: options.useColor ?? false,
    term: options.term ?? "xterm-256color",
    prefix: options.prefix ?? "Coffee> ",
    schedule(callback, delay) {
      const timer: PendingTimer = {
        callback,
        delay,
        cancelled: false,
        unrefCalls: 0,
        unref() { this.unrefCalls += 1; },
      };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      (timer as PendingTimer).cancelled = true;
    },
  });
  return { renderer, output, writes, timers };
}
```

- [ ] **Step 2: Replace the full-buffer expectation with a completed-line-once test**

Add this test near the first coalescing test:

```ts
test("commits completed logical lines once and never redraws them", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("第一");
  timers[0]?.callback();
  renderer.append("行\n");
  const afterFirstCommit = writes.length;
  renderer.append("第二");
  timers[1]?.callback();
  renderer.append("行");
  renderer.finishSegment();

  const laterOutput = writes.slice(afterFirstCommit).join("");
  assert.doesNotMatch(laterOutput, /第一行/);
  assert.match(laterOutput, /第二行/);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});
```

- [ ] **Step 3: Add a growing-prefix regression that represents the screenshot**

```ts
test("does not retain growing full-answer snapshots", () => {
  const { renderer, writes, timers } = createHarness({ columns: 100 });

  renderer.append("当前项目是 Coffee");
  timers[0]?.callback();
  renderer.append("。\n");
  const afterFirstCommit = writes.length;
  renderer.append("从项目结构来看");
  timers[1]?.callback();
  renderer.append("，这是一个 CLI。\n");
  renderer.finishSegment();

  const laterOutput = writes.slice(afterFirstCommit).join("");
  assert.doesNotMatch(laterOutput, /当前项目是 Coffee/);
  assert.match(laterOutput, /从项目结构来看/);
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test test/streaming-markdown-renderer.test.ts
```

Expected: TypeScript compilation fails because `term` is not yet part of `StreamingMarkdownRendererOptions`, or the new once-only assertions fail against the full-buffer renderer.

- [ ] **Step 5: Record the checkpoint**

Run:

```bash
git rev-parse --is-inside-work-tree 2>/dev/null || echo "checkpoint: no git repository"
```

Expected: `checkpoint: no git repository`.

### Task 2: Implement committed-line rendering for capable TTYs

**Files:**
- Modify: `src/streaming-markdown-renderer.ts:5-12`
- Modify: `src/streaming-markdown-renderer.ts:168-208`
- Modify: `src/streaming-markdown-renderer.ts:210-464`
- Test: `test/streaming-markdown-renderer.test.ts`

- [ ] **Step 1: Change the options to read live output columns and TERM**

Use this options shape and remove the old top-level `columns` option:

```ts
export interface StreamingMarkdownRendererOptions {
  output: { write(chunk: string): unknown; columns?: number };
  isTTY: boolean | undefined;
  useColor: boolean;
  term: string | undefined;
  prefix: string;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}
```

Add the single-line erase code:

```ts
const ANSI = {
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clearLine: "\u001b[2K",
} as const;
```

Derive capability without treating every TTY as ANSI-capable:

```ts
const canPreview = isTTY === true && term !== "dumb";
const continuation = " ".repeat(stringWidth(prefix));
```

- [ ] **Step 2: Replace full-frame state with logical-line state**

Remove `buffer`, `frameVisible`, `frameRows`, `statusVisible` redraw height, `visualRows()`, `clearFrame()`, `drawFrame()`, and `textFrame()`. Introduce:

```ts
let currentLine = "";
let lineIndex = 0;
let segmentStarted = false;
let previewVisible = false;
let safeSegment = !canPreview;
let safePrefixWritten = false;
let statusVisible = false;
let dirty = false;
let disposed = false;
let cursorHidden = false;
let pendingFlush: PendingFlush | undefined;
const sanitizer = createPlainTerminalSanitizer();
```

Add helpers whose output is limited to the current physical line:

```ts
function liveColumns(): number | undefined {
  const value = output.columns;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : undefined;
}

function linePrefix(): string {
  if (lineIndex === 0) return prefix;
  return currentLine.length === 0 ? "" : continuation;
}

function renderedCurrentLine(): string {
  return `${linePrefix()}${renderMarkdown(currentLine, useColor)}`;
}

function clearPreview(): void {
  if (!previewVisible) return;
  output.write(`\r${ANSI.clearLine}`);
  previewVisible = false;
}
```

- [ ] **Step 3: Implement one-line preview and permanent safe fallback**

The preview must reserve one column so the terminal never enters delayed-wrap state:

```ts
function enterSafeSegment(): void {
  if (safeSegment) return;
  clearPreview();
  output.write(`${linePrefix()}${currentLine}`);
  safeSegment = true;
  safePrefixWritten = true;
  segmentStarted = true;
  dirty = false;
  showCursor();
}

function flushPreview(): void {
  if (!dirty || currentLine.length === 0 || safeSegment) return;
  const columns = liveColumns();
  const frame = renderedCurrentLine();
  if (columns === undefined || stringWidth(frame) >= columns) {
    enterSafeSegment();
    return;
  }
  clearPreview();
  hideCursor();
  output.write(frame);
  previewVisible = true;
  segmentStarted = true;
  dirty = false;
}
```

Keep the existing 40ms scheduler, but have it call `flushPreview()` rather than render the complete accumulated answer.

- [ ] **Step 4: Commit newline-terminated lines exactly once**

```ts
function commitLine(): void {
  cancelPending();
  if (safeSegment) {
    output.write("\n");
  } else {
    clearPreview();
    output.write(`${renderedCurrentLine()}\n`);
  }
  currentLine = "";
  lineIndex += 1;
  segmentStarted = true;
  dirty = false;
  previewVisible = false;
}

function acceptVisibleText(text: string): void {
  for (const character of text) {
    if (character === "\n") {
      commitLine();
      continue;
    }
    currentLine += character;
    dirty = true;
    if (safeSegment) {
      if (!safePrefixWritten) {
        output.write(prefix);
        safePrefixWritten = true;
      }
      output.write(character);
      segmentStarted = true;
      dirty = false;
    }
  }
  if (dirty) scheduleFlush();
}
```

`safePrefixWritten` remains true across logical newlines because safe append mode uses one prefix per segment, matching existing non-TTY output. When a capable TTY switches after earlier committed lines, `enterSafeSegment()` writes that line's continuation prefix and current text once before enabling direct append.

- [ ] **Step 5: Route append through the incremental sanitizer**

```ts
append(delta) {
  if (disposed || delta.length === 0) return;
  acceptVisibleText(sanitizer.push(delta));
}
```

Do not retain a second unsanitized display buffer. Model history continues to use the authoritative reply from the gateway, not renderer state.

- [ ] **Step 6: Run the renderer tests**

Run:

```bash
node --import tsx --test \
  --test-name-pattern="commits completed|does not retain growing" \
  test/streaming-markdown-renderer.test.ts
```

Expected: both selected tests pass. Task 3 then updates the remaining renderer tests before the full file is run.

### Task 3: Complete fallback, status, finish, dispose, and sanitization behavior

**Files:**
- Modify: `src/streaming-markdown-renderer.ts`
- Modify: `test/streaming-markdown-renderer.test.ts`
- Test: `test/streaming-markdown-renderer.test.ts`

- [ ] **Step 1: Add failing dynamic-width and dumb-terminal tests**

```ts
test("uses live columns and falls back before a preview can wrap", () => {
  const { renderer, output, writes, timers } = createHarness({ columns: 20 });
  renderer.append("短行");
  timers[0]?.callback();
  output.columns = 8;
  renderer.append("继续增长");
  timers[1]?.callback();
  renderer.finishSegment();

  assert.equal(writes.join("").match(/短行继续增长/g)?.length, 1);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("TERM dumb uses append-only output without cursor ANSI", () => {
  const { renderer, writes } = createHarness({ term: "dumb" });
  renderer.append("**稳定**");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> **稳定**\n");
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});
```

- [ ] **Step 2: Add failing finish and preserve tests**

```ts
test("finishSegment fixes an unfinished preview once and restores the cursor", () => {
  const { renderer, writes, timers } = createHarness();
  renderer.append("**完成**");
  timers[0]?.callback();
  renderer.finishSegment();
  renderer.finishSegment();

  const output = writes.join("");
  assert.equal(output.match(/Coffee> 完成/g)?.length, 1);
  assert.equal(output.match(/\u001b\[\?25h/g)?.length, 1);
});

test("dispose preserve fixes visible partial text once without adding a line", () => {
  const { renderer, writes, timers } = createHarness();
  renderer.append("部分回答");
  timers[0]?.callback();
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  assert.equal(writes.join("").match(/Coffee> 部分回答/g)?.length, 1);
  assert.doesNotMatch(writes.join(""), /部分回答\n/);
});
```

- [ ] **Step 3: Implement status clearing without multi-row movement**

`showStatus(text)` must use the same single physical line rule:

```ts
showStatus(text) {
  if (disposed || segmentStarted || currentLine.length > 0) return;
  if (!canPreview) {
    if (text.length > 0) output.write(`${prefix}${text}\n`);
    return;
  }
  if (text.length === 0) {
    clearPreview();
    statusVisible = false;
    showCursor();
    return;
  }
  clearPreview();
  hideCursor();
  output.write(`${prefix}${sanitizeTerminalMarkdown(text)}`);
  previewVisible = true;
  statusVisible = true;
}
```

Before the first body preview or committed line, clear a visible status and set `statusVisible = false`.

- [ ] **Step 4: Implement segment finalization and preservation**

Create one internal finalizer with an explicit newline policy:

```ts
function finalizeCurrent({ newline }: { newline: boolean }): void {
  cancelPending();
  acceptVisibleText(sanitizer.finish());
  cancelPending();
  if (currentLine.length > 0 || previewVisible) {
    if (safeSegment) {
      if (newline) output.write("\n");
    } else {
      clearPreview();
      output.write(`${renderedCurrentLine()}${newline ? "\n" : ""}`);
    }
    segmentStarted = true;
  } else if (statusVisible) {
    clearPreview();
  }
  currentLine = "";
  dirty = false;
  previewVisible = false;
  statusVisible = false;
  showCursor();
}
```

`finishSegment()` calls `finalizeCurrent({ newline: true })`, resets `lineIndex`, `segmentStarted`, `safeSegment`, and safe-prefix state for the next segment. `dispose({ preserve: true })` calls `finalizeCurrent({ newline: false })`; default dispose clears only transient preview/status and restores the cursor. Both paths remain idempotent.

- [ ] **Step 5: Retain split-control sanitization tests and remove obsolete frame-row tests**

Keep tests for split CSI, OSC, DCS, CRLF, tabs, C0/C1 controls, re-entrant writes, timer cancellation, and cursor recovery. Remove or rewrite only assertions that require `ESC[nA`, full-segment `ESC[J`, or `frameRows` accounting.

Add one TTY split-control test:

```ts
test("TTY sanitizer drops a control sequence split across deltas", () => {
  const { renderer, writes } = createHarness();
  renderer.append("安全\u001b[");
  renderer.append("2J正文\n");
  renderer.finishSegment();

  const output = writes.join("");
  assert.match(output, /Coffee> 安全正文/);
  assert.doesNotMatch(output, /2J/);
});
```

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
node --import tsx --test test/streaming-markdown-renderer.test.ts
npm run check
```

Expected: all renderer tests pass and TypeScript exits 0.

### Task 4: Integrate live terminal metadata and SIGINT ordering in the CLI

**Files:**
- Modify: `src/cli.ts:181-213`
- Modify: `src/cli.ts:680-686`
- Modify: `test/cli.test.ts:405-457`
- Test: `test/cli.test.ts`

- [ ] **Step 1: Add `term` and live columns at renderer creation**

Change the call site to pass the output object instead of a captured width:

```ts
const renderer = createStreamingMarkdownRenderer({
  output,
  isTTY: output.isTTY,
  useColor,
  term: process.env.TERM,
  prefix: styleText("Coffee> ", "assistant", useColor),
});
```

- [ ] **Step 2: Preserve the active line before SIGINT adds its newline**

Change the interrupt handler ordering:

```ts
const handleInterrupt = () => {
  if (abortController.signal.aborted) return;
  const renderer = activeStreamRenderer;
  activeStreamRenderer = undefined;
  renderer?.dispose({ preserve: true });
  output.write("\n");
  abortController.abort();
};
```

The loop's `finally` may call `dispose()` again on its local renderer; idempotence makes that a no-op.

- [ ] **Step 3: Add a CLI fixture that emits growing deltas**

Extend `test/streaming-fetch.mjs` with a `stable-lines` scenario that emits these OpenAI-compatible SSE chunks before `[DONE]`:

```js
"当前项目是 Coffee",
"。\n",
"从项目结构来看",
"，这是一个 CLI。"
```

Return the same concatenated content in the authoritative final stream reply.

- [ ] **Step 4: Add end-to-end assertions**

```ts
test("CLI integration emits growing model deltas as one authoritative answer", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
        COFFEE_TEST_STREAM_SCENARIO: "stable-lines",
      },
      "当前项目是什么\n/exit\n",
      { preload: "./test/streaming-fetch.mjs" },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout.match(/当前项目是 Coffee/g)?.length, 1);
    assert.equal(result.stdout.match(/从项目结构来看/g)?.length, 1);
    assert.equal(result.stderr, "");
  });
});
```

Keep the existing SIGINT tests and strengthen them with:

```ts
assert.equal(result.stdout.match(/Coffee> /g)?.length, 1);
assert.doesNotMatch(result.stdout, /\u001b\[[1-9][0-9]*A/);
```

- [ ] **Step 5: Run CLI and renderer tests**

Run:

```bash
node --import tsx --test \
  test/streaming-markdown-renderer.test.ts \
  test/cli.test.ts
```

Expected: all selected tests pass with no timeout, duplicate answer text, unhandled `AbortError`, or cursor-up ANSI sequence.

### Task 5: Update documentation and run the full verification gate

**Files:**
- Modify: `README.md:70-76`
- Verify: `src/streaming-markdown-renderer.ts`
- Verify: `src/cli.ts`
- Verify: `test/streaming-markdown-renderer.test.ts`
- Verify: `test/cli.test.ts`

- [ ] **Step 1: Replace the full-segment redraw description**

Use this README text:

```md
在终端中输入消息开始对话，输入 `/exit` 或按 Ctrl+C 退出。Coffee 默认流式显示模型回答：已经完成的文本行会固定输出，只有当前尚未完成的短行可能刷新，并为标题、加粗、列表、行内代码和链接添加颜色。这样不会随着回答增长反复重绘整段内容。

管道、`TERM=dumb`、宽度异常或当前行可能自动换行时，Coffee 会自动切换为安全追加模式，不使用跨行光标控制。模型的原始推理内容不会显示，CLI 只提供“正在分析问题”等简短状态。工具调用会先固定当前回答段，再显示咖啡动画，后续结果进入新的稳定段。
```

- [ ] **Step 2: Verify obsolete full-frame concepts are gone**

Run:

```bash
rg -n "frameRows|visualRows|clearDown|\\[[0-9]+A" \
  src/streaming-markdown-renderer.ts \
  test/streaming-markdown-renderer.test.ts
```

Expected: no production references to full-frame row accounting or cursor-up clearing. Any test fixture reference must be a negative assertion.

- [ ] **Step 3: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all tests pass; test output contains no failing, cancelled, or skipped test.

- [ ] **Step 4: Run TypeScript validation**

Run:

```bash
npm run check
```

Expected: `tsc --noEmit` exits 0.

- [ ] **Step 5: Inspect the final scope**

Run:

```bash
find src test docs/superpowers README.md -type f -newer \
  docs/superpowers/specs/2026-07-20-stable-streaming-output-design.md \
  -print | sort
```

Expected: changes are limited to the renderer, CLI integration, their tests, README, and this plan. Because the project has no Git repository, use this only as a supporting review and inspect the exact files listed in the file map.

## Completion criteria

- Completed logical lines are emitted exactly once.
- No production code moves the cursor upward to redraw an accumulated answer.
- Current-line preview never crosses the live terminal width.
- Unsafe terminal conditions use append-only output without cursor ANSI.
- Tool boundaries, errors, Ctrl+C, and disposal preserve visible content once and restore the cursor.
- Model/history content remains authoritative and display prefixes never enter SQLite.
- Focused tests, the complete suite, and `npm run check` all pass.
