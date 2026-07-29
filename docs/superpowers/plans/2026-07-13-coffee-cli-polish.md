# Coffee CLI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix clean Ctrl+C termination and render common Markdown with native ANSI colors while preserving the user's Coffee system prompt.

**Architecture:** Keep API and conversation state in `agent.ts` unchanged. Add a pure terminal formatter module, then make `cli.ts` own both readline/process interrupt wiring and presentation. Verify the real terminal path in tmux in addition to deterministic unit and child-process tests.

**Tech Stack:** Node.js 22, TypeScript, native ANSI escape codes, `node:readline/promises`, `AbortController`, `node:test`, tmux.

---

The workspace is not a Git repository. Do not initialize one or add commit steps unless the user asks.

### Task 1: Restore the User-Modified System Prompt Test Baseline

**Files:**
- Modify: `test/agent.test.ts`
- Preserve without modification: `src/agent.ts`

- [x] **Step 1: Add a typed request-message shape for assertions**

Add near `CapturedRequest`:

```ts
interface RequestMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
```

Change both `bodies` declarations to:

```ts
const bodies: Array<{ messages: RequestMessage[] }> = [];
```

- [x] **Step 2: Update the first-request assertion**

Replace the first request's `body.messages` assertion with:

```ts
  assert.equal(body.messages[0]?.role, "system");
  assert.match(body.messages[0]?.content, /Coffee/);
  assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "你好" }]);
```

- [x] **Step 3: Update the multi-round assertion**

Assert the system role separately and compare conversation history after it:

```ts
  assert.equal(bodies[1]?.messages[0]?.role, "system");
  assert.deepEqual(bodies[1]?.messages.slice(1), [
    { role: "user", content: "第一条问题" },
    { role: "assistant", content: "第一条回复" },
    { role: "user", content: "第二条问题" },
  ]);
```

- [x] **Step 4: Update the rollback assertion**

```ts
  assert.equal(bodies[1]?.messages[0]?.role, "system");
  assert.deepEqual(bodies[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
```

- [x] **Step 5: Verify the restored baseline**

Run: `npm test`

Expected: the original 7 tests pass. `src/agent.ts` and its `SYSTEM_PROMPT` remain byte-for-byte unchanged.

### Task 2: Native ANSI Markdown Renderer

**Files:**
- Create: `test/terminal-format.test.ts`
- Create: `src/terminal-format.ts`

- [x] **Step 1: Write renderer tests before production code**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  renderMarkdown,
  shouldUseColor,
  styleText,
} from "../src/terminal-format.js";

const markdown = [
  "# 咖啡店推荐",
  "* **晨光咖啡**",
  "适合 `手冲`",
  "[查看地图](https://example.com/map)",
].join("\n");

test("renders common Markdown as clean terminal text", () => {
  assert.equal(
    renderMarkdown(markdown, false),
    [
      "咖啡店推荐",
      "• 晨光咖啡",
      "适合 手冲",
      "查看地图 (https://example.com/map)",
    ].join("\n"),
  );
});

test("adds ANSI colors without leaving Markdown stars", () => {
  const output = renderMarkdown(markdown, true);

  assert.match(output, /\u001b\[/);
  assert.doesNotMatch(output, /\*\*/);
  assert.doesNotMatch(output, /^\s*\*\s/m);
  assert.match(output, /•/);
});

test("enables colors only for a TTY without NO_COLOR", () => {
  assert.equal(shouldUseColor(true, undefined), true);
  assert.equal(shouldUseColor(false, undefined), false);
  assert.equal(shouldUseColor(true, "1"), false);
});

test("styles labels while preserving plain-text mode", () => {
  assert.equal(styleText("Coffee> ", "assistant", false), "Coffee> ");
  assert.match(styleText("Coffee> ", "assistant", true), /\u001b\[92m/);
  assert.match(styleText("Error", "error", true), /\u001b\[91m/);
});
```

- [x] **Step 2: Run renderer tests and observe the missing module**

Run: `node --import tsx --test test/terminal-format.test.ts`

Expected: FAIL because `src/terminal-format.ts` does not exist.

- [x] **Step 3: Add a behavior stub and verify RED**

```ts
export type StyleKind = "user" | "assistant" | "startup" | "error";

export function renderMarkdown(input: string, _color: boolean): string {
  return input;
}

export function shouldUseColor(_isTTY: boolean | undefined, _noColor: string | undefined): boolean {
  return false;
}

export function styleText(text: string, _kind: StyleKind, _color: boolean): string {
  return text;
}
```

Run: `node --import tsx --test test/terminal-format.test.ts`

Expected: FAIL because Markdown markers remain, color mode has no ANSI codes, and TTY detection returns false.

- [x] **Step 4: Replace the stub with the minimal formatter**

```ts
const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  underline: "\u001b[4m",
  redBright: "\u001b[91m",
  greenBright: "\u001b[92m",
  yellowBright: "\u001b[93m",
  blueBright: "\u001b[94m",
  magentaBright: "\u001b[95m",
  cyanBright: "\u001b[96m",
} as const;

export type StyleKind = "user" | "assistant" | "startup" | "error";

const STYLE_CODES: Record<StyleKind, string[]> = {
  user: [ANSI.bold, ANSI.cyanBright],
  assistant: [ANSI.bold, ANSI.greenBright],
  startup: [ANSI.bold, ANSI.magentaBright],
  error: [ANSI.bold, ANSI.redBright],
};

function paint(text: string, codes: string[], color: boolean): string {
  return color ? `${codes.join("")}${text}${ANSI.reset}` : text;
}

function renderInline(input: string, color: boolean): string {
  return input
    .replace(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
      const styledUrl = paint(url, [ANSI.underline, ANSI.blueBright], color);
      return `${label} (${styledUrl})`;
    })
    .replace(/`([^`]+)`/g, (_match, code) => paint(code, [ANSI.cyanBright], color))
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold) =>
      paint(bold, [ANSI.bold, ANSI.yellowBright], color),
    );
}

function renderLine(line: string, color: boolean): string {
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (heading) {
    return paint(renderInline(heading[1] ?? "", color), [ANSI.bold, ANSI.magentaBright], color);
  }

  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) {
    const prefix = `${bullet[1] ?? ""}${paint("•", [ANSI.cyanBright], color)}`;
    return `${prefix} ${renderInline(bullet[2] ?? "", color)}`;
  }

  return renderInline(line, color);
}

export function renderMarkdown(input: string, color: boolean): string {
  return input.split("\n").map((line) => renderLine(line, color)).join("\n");
}

export function shouldUseColor(
  isTTY: boolean | undefined,
  noColor: string | undefined,
): boolean {
  return isTTY === true && noColor === undefined;
}

export function styleText(text: string, kind: StyleKind, color: boolean): string {
  return paint(text, STYLE_CODES[kind], color);
}
```

- [x] **Step 5: Verify renderer GREEN and types**

Run: `node --import tsx --test test/terminal-format.test.ts`

Expected: 4 tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

### Task 3: Ctrl+C Regression and CLI Integration

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts`

- [x] **Step 1: Extend the child-process result and signal helper**

Replace `CliResult` and `runCli` with:

```ts
interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(
  apiKey: string | undefined,
  input: string,
  interruptWhenReady = false,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    if (apiKey !== undefined) {
      env.DEEPSEEK_API_KEY = apiKey;
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (interruptWhenReady && !interrupted && stdout.includes("You>")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (!interruptWhenReady) {
      child.stdin.end(input);
    }
  });
}
```

- [x] **Step 2: Add the failing SIGINT test**

```ts
test("exits cleanly when it receives SIGINT", async () => {
  const result = await runCli("test-key", "", true);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});
```

Also add `assert.match(result.stdout, /Ctrl\+C/);` to the existing `/exit` test.

- [x] **Step 3: Run CLI tests and verify RED**

Run: `node --import tsx --test test/cli.test.ts`

Expected: the `/exit` test fails because the startup text does not mention Ctrl+C, and the SIGINT test fails with `code === null` and `signal === "SIGINT"`.

- [x] **Step 4: Integrate the formatter and dual SIGINT handling**

Replace `src/cli.ts` with:

```ts
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createConversation, type Conversation } from "./agent.js";
import {
  renderMarkdown,
  shouldUseColor,
  styleText,
} from "./terminal-format.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  const useColor = shouldUseColor(output.isTTY, process.env.NO_COLOR);
  let conversation: Conversation;
  try {
    conversation = createConversation({ apiKey: process.env.DEEPSEEK_API_KEY });
  } catch (error) {
    console.error(styleText(`Error: ${getErrorMessage(error)}`, "error", useColor));
    return 1;
  }

  const readline = createInterface({ input, output });
  const abortController = new AbortController();
  const handleInterrupt = () => {
    if (abortController.signal.aborted) {
      return;
    }
    output.write("\n");
    abortController.abort();
  };
  readline.on("SIGINT", handleInterrupt);
  process.once("SIGINT", handleInterrupt);

  console.log(
    `${styleText("Coffee CLI", "startup", useColor)} 已启动，输入 /exit 或按 Ctrl+C 退出。\n`,
  );
  const prompt = styleText("You> ", "user", useColor);

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (
          await readline.question(prompt, { signal: abortController.signal })
        ).trim();
      } catch (error) {
        if (abortController.signal.aborted) {
          return 0;
        }
        throw error;
      }

      if (userInput === "/exit") {
        return 0;
      }
      if (!userInput) {
        continue;
      }

      try {
        const reply = await conversation.send(userInput);
        console.log(
          `${styleText("Coffee> ", "assistant", useColor)}${renderMarkdown(reply, useColor)}\n`,
        );
      } catch (error) {
        console.error(styleText(`Error: ${getErrorMessage(error)}`, "error", useColor));
      }
    }
  } finally {
    readline.off("SIGINT", handleInterrupt);
    process.off("SIGINT", handleInterrupt);
    readline.close();
  }
}

process.exitCode = await main();
```

- [x] **Step 5: Verify CLI GREEN and full automated tests**

Run: `node --import tsx --test test/cli.test.ts`

Expected: 3 CLI tests pass.

Run: `npm test`

Expected: 12 tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

### Task 4: Documentation and Real-TTY Verification

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the README**

Change the exit sentence to:

```markdown
在终端中输入消息开始对话，输入 `/exit` 或按 Ctrl+C 退出。Coffee 会在真实终端中为标题、加粗、列表、行内代码和链接添加颜色；设置 `NO_COLOR=1` 可关闭颜色。
```

- [x] **Step 2: Run a real-TTY Ctrl+C smoke test**

Start a detached tmux session, run the CLI with a non-production test key followed by `echo EXIT:$?`, wait for `You>`, then send Ctrl+C.

Execution note: tmux was unavailable in this environment, so the same check ran in the execution tool's real PTY. The CLI displayed `You>`, received Ctrl+C, emitted no stack trace, and exited with code `0`.

Expected captured pane: startup text, `You>`, and `EXIT:0`. It must not contain `AbortError` or a Node internal stack trace. No user message is submitted, so the DeepSeek API is not called.

- [x] **Step 3: Run final verification**

Run: `npm test`

Expected: 12 tests pass with 0 failures.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

Run: `rg -n 'Ctrl\+C|SIGINT|AbortController|renderMarkdown|NO_COLOR' README.md src test`

Expected: both exit paths, both signal listeners, formatter integration, and no-color behavior are present. `src/agent.ts` retains the user's Coffee `SYSTEM_PROMPT`, and no file under `../pi` is modified.
