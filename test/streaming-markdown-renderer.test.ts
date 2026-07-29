import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { createStreamingMarkdownRenderer } from "../src/streaming-markdown-renderer.js";
import {
  createStyleContext,
  type TerminalStyleContext,
} from "../src/theme.js";

interface PendingTimer {
  callback: () => void;
  delay: number;
  cancelled: boolean;
  unrefCalls: number;
  unref(): void;
}

function createHarness(options: {
  isTTY?: boolean;
  styles?: TerminalStyleContext;
  columns?: number;
  term?: string;
  prefix?: string;
  beforeWrite?: (chunk: string) => void;
  onWrite?: (chunk: string) => void;
} = {}) {
  const writes: string[] = [];
  const timers: PendingTimer[] = [];
  const output = {
    columns: options.columns ?? 80,
    write(chunk: string) {
      options.beforeWrite?.(chunk);
      writes.push(chunk);
      options.onWrite?.(chunk);
    },
  };
  const renderer = createStreamingMarkdownRenderer({
    output,
    isTTY: options.isTTY ?? true,
    styles: options.styles ?? createStyleContext("latte", "none"),
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

test("coalesces multiple deltas into one 40ms redraw", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("你");
  renderer.append("好");

  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, 40);
  assert.equal(timers[0]?.unrefCalls, 1);
  assert.deepEqual(writes, []);

  timers[0]?.callback();
  assert.equal(writes.join(""), "\u001b[?25lCoffee> 你好");
});

test("commits completed logical lines once and never redraws them", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("第一");
  timers[0]?.callback();
  renderer.append("行\n");
  const afterFirstCommit = writes.length;
  const firstCommitOutput = writes.slice(0, afterFirstCommit).join("");
  assert.match(firstCommitOutput, /Coffee> 第一行/);
  assert.equal(firstCommitOutput.match(/Coffee> 第一行/g)?.length, 1);
  renderer.append("第二");
  timers[1]?.callback();
  renderer.append("行");
  renderer.finishSegment();

  const laterOutput = writes.slice(afterFirstCommit).join("");
  assert.doesNotMatch(laterOutput, /第一行/);
  assert.match(laterOutput, /第二行/);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("does not retain growing full-answer snapshots", () => {
  const { renderer, writes, timers } = createHarness({ columns: 100 });

  renderer.append("当前项目是 Coffee");
  timers[0]?.callback();
  renderer.append("。\n");
  const afterFirstCommit = writes.length;
  const firstCommitOutput = writes.slice(0, afterFirstCommit).join("");
  assert.match(firstCommitOutput, /Coffee> 当前项目是 Coffee。/);
  assert.equal(firstCommitOutput.match(/Coffee> 当前项目是 Coffee。/g)?.length, 1);
  renderer.append("从项目结构来看");
  timers[1]?.callback();
  renderer.append("，这是一个 CLI。\n");
  renderer.finishSegment();

  const laterOutput = writes.slice(afterFirstCommit).join("");
  assert.doesNotMatch(laterOutput, /当前项目是 Coffee/);
  assert.match(laterOutput, /从项目结构来看/);
});

test("falls back after a width shrink by appending only the unseen suffix", () => {
  const { renderer, output, writes, timers } = createHarness({ columns: 80 });

  renderer.append("abc");
  timers[0]?.callback();
  const boundary = writes.length;

  output.columns = 10;
  renderer.append("def");
  timers[1]?.callback();

  const fallbackOutput = writes.slice(boundary).join("");
  assert.equal(fallbackOutput, "def\u001b[?25h");
  assert.equal(writes.join("").match(/Coffee> abc/g)?.length, 1);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("uses the previous Markdown preview width when columns shrink", () => {
  const { renderer, output, writes, timers } = createHarness({ columns: 19 });

  renderer.append("**abcdefgh");
  timers[0]?.callback();
  const boundary = writes.length;

  output.columns = 17;
  renderer.append("**");
  timers[1]?.callback();

  const fallbackOutput = writes.slice(boundary).join("");
  assert.equal(fallbackOutput, "**\u001b[?25h");
  assert.doesNotMatch(fallbackOutput, /\r\u001b\[2K/);
  assert.equal(writes.join("").match(/Coffee> \*\*abcdefgh/g)?.length, 1);
});

test("re-renders Markdown from the complete current buffer", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("# 标");
  timers[0]?.callback();
  renderer.append("题\n* **晨光**");
  timers[1]?.callback();

  const output = writes.join("");
  assert.match(output, /Coffee> 标$/m);
  assert.match(output, /Coffee> 标题\n {8}• 晨光/);
  assert.doesNotMatch(output, /\*\*/);
});

test("renders streamed Markdown with the selected theme", () => {
  const { renderer, writes, timers } = createHarness({
    styles: createStyleContext("coast", "truecolor"),
  });

  renderer.append("# 标题\n**重点**和`代码`");
  timers[0]?.callback();

  const output = writes.join("");
  assert.match(output, /\u001b\[1;38;2;224;235;231m标题/u);
  assert.match(output, /\u001b\[1;38;2;212;178;120m重点/u);
  assert.match(output, /\u001b\[38;2;128;193;183m代码/u);
});

test("falls back safely when ANSI-aware CJK and Emoji width fills the line", () => {
  const { renderer, writes, timers } = createHarness({
    columns: 6,
    prefix: "C> ",
    styles: createStyleContext("latte", "ansi"),
  });

  renderer.append("**你**☕");
  timers[0]?.callback();
  const boundary = writes.length;
  renderer.append("好");
  timers[1]?.callback();

  const fallback = writes.slice(boundary).join("");
  assert.equal(fallback, "好");
  assert.equal(writes.join("").match(/C> /g)?.length, 1);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("commits empty lines once and appends later narrow-line text", () => {
  const { renderer, writes, timers } = createHarness({
    columns: 1,
    prefix: "C> ",
  });

  renderer.append("a\n\nb");
  timers[0]?.callback();
  const boundary = writes.length;
  renderer.append("c");
  timers[1]?.callback();

  assert.equal(writes.slice(boundary).join(""), "c");
  assert.match(writes.join(""), /C> a\n\n {3}bc/);
  assert.equal(writes.join("").match(/C> a/g)?.length, 1);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("invalid columns use synchronous append-only output without cursor ANSI", () => {
  const { renderer, writes, timers } = createHarness({ columns: 0 });

  renderer.append("a\nb");
  renderer.append("c");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> a\nbc\n");
  assert.equal(timers.length, 0);
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});

test("treats a fractional column width below one as invalid", () => {
  const { renderer, writes, timers } = createHarness({ columns: 0.5 });

  renderer.append("a\nb");
  renderer.append("c");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> a\nbc\n");
  assert.equal(timers.length, 0);
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});

test("expands raw tabs to four safe spaces and counts their visual width", () => {
  const { renderer, writes, timers } = createHarness({
    columns: 6,
    prefix: "C> ",
  });

  renderer.append("a\tb");
  timers[0]?.callback();
  const boundary = writes.length;
  renderer.append("c");
  timers[1]?.callback();

  assert.doesNotMatch(writes.join(""), /\t/);
  assert.match(writes.join(""), /C> a {4}b/);
  assert.equal(writes.slice(boundary).join(""), "c");
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("normalizes CRLF and lone carriage returns to safe newlines", () => {
  const { renderer, writes, timers } = createHarness({ prefix: "C> " });

  renderer.append("a\r\nb\rc");
  timers[0]?.callback();

  assert.equal(
    writes.join(""),
    "C> a\n   b\n\u001b[?25l   c",
  );
});

test("TERM dumb uses append-only output without cursor ANSI", () => {
  const { renderer, writes, timers } = createHarness({ term: "dumb" });

  renderer.append("**稳定**");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> **稳定**\n");
  assert.equal(timers.length, 0);
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});

test("authoritative final equal to streamed text is not printed twice", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("abc");
  renderer.finishSegment("abc");

  assert.equal(writes.join(""), "Coffee> abc\n");
  assert.equal(writes.join("").split("abc").length - 1, 1);
});

test("authoritative final extends streamed text with only its missing suffix", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("abc");
  renderer.finishSegment("abcdef");

  assert.equal(writes.join(""), "Coffee> abcdef\n");
  assert.equal(writes.join("").split("abc").length - 1, 1);
});

test("authoritative final divergence starts a complete corrected segment", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("abcX");
  renderer.finishSegment("abcY");

  assert.equal(writes.join(""), "Coffee> abcX\nCoffee> abcY\n");
  assert.doesNotMatch(writes.join(""), /abcXY/);
});

test("authoritative Unicode divergence preserves both complete code points", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("你好😀X");
  renderer.finishSegment("你好😀Y");

  const output = writes.join("");
  assert.equal(output, "Coffee> 你好😀X\nCoffee> 你好😀Y\n");
  assert.doesNotMatch(output, /�|😀X.*😀Y[^\n]*$/);
});

test("authoritative correction stays separate from an append re-entered at its boundary", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    isTTY: false,
    onWrite(chunk) {
      if (!reentered && chunk === "\n") {
        reentered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("abcX");
  renderer.finishSegment("abcY");
  const finished = harness.writes.join("");

  assert.equal(finished, "Coffee> abcX\nCoffee> B\nCoffee> abcY\n");
  assert.doesNotMatch(finished, /BabcY|abcXY/);
  assert.equal(finished.match(/Coffee> abcX/g)?.length, 1);
  assert.equal(finished.match(/Coffee> B\n/g)?.length, 1);
  assert.equal(finished.match(/Coffee> abcY/g)?.length, 1);

  renderer.finishSegment();
  renderer.dispose();
  assert.equal(harness.writes.join(""), finished);
});

test("TTY sanitizer drops a control sequence split across deltas", () => {
  const { renderer, writes } = createHarness();

  renderer.append("安全\u001b[");
  renderer.append("2J正文\n");
  renderer.finishSegment();

  const output = writes.join("");
  assert.match(output, /Coffee> 安全正文/);
  assert.doesNotMatch(output, /2J/);
});

test("strips raw C0, CSI, and OSC controls before TTY Markdown rendering", () => {
  const { renderer, writes, timers } = createHarness({
    prefix: "",
    styles: createStyleContext("latte", "ansi"),
  });

  renderer.append(
    "**安全**\b\u0001\u001b[2JCSI\u001b]0;owned\u0007OSC",
  );
  timers[0]?.callback();
  const output = writes.join("");

  assert.match(output, /\u001b\[1;93m/u);
  assert.match(output, /安全.*CSIOSC/);
  assert.doesNotMatch(output, /\u001b\[2J|owned/);
  assert.equal(output.includes("\b"), false);
  assert.equal(output.includes("\u0001"), false);
  assert.equal(output.includes("\u0007"), false);
});

test("non-TTY strips terminal controls while preserving visible Markdown once", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append(
    "*raw*\b\u0001\u001b[2Jtext\u001b]0;owned\u0007osc\u001bPsecret\u001b\\dcs\u001b7esc",
  );
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> *raw*textoscdcsesc\n");
  assert.doesNotMatch(writes.join(""), /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
});

test("non-TTY strips CSI split across deltas without leaking its suffix", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("before\u001b[");
  renderer.append("2Jafter");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> beforeafter\n");
});

test("non-TTY strips OSC split across deltas with BEL or split ST terminators", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("A\u001b]0;ow");
  renderer.append("ned\u0007B\u001b]8;;https://evil.example");
  renderer.append("\u001b");
  renderer.append("\\C");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> ABC\n");
});

test("non-TTY strips a DCS sequence split across deltas", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("A\u001bPprivate");
  renderer.append(" payload\u001b");
  renderer.append("\\B");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> AB\n");
});

test("non-TTY safely normalizes CR, expands tabs, and removes C0 and C1 controls", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("a\r");
  renderer.append("\nb\rc\td\b\u0001\u0085e\n");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> a\nb\nc    de\n");
});

test("non-TTY joins a UTF-16 surrogate pair split across deltas", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("\ud83d");
  assert.deepEqual(writes, []);
  renderer.append("\ude00");
  renderer.finishSegment();

  const bytes = Buffer.concat(writes.map((chunk) => Buffer.from(chunk)));
  assert.deepEqual(bytes, Buffer.from("Coffee> 😀\n"));
  assert.doesNotMatch(bytes.toString("utf8"), /�/);
});

test("TTY waits for a split UTF-16 surrogate pair before scheduling output", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("\ud83d");
  assert.equal(timers.length, 0);
  assert.deepEqual(writes, []);
  renderer.append("\ude00");
  assert.equal(timers.length, 1);
  timers[0]?.callback();
  renderer.finishSegment();

  const bytes = Buffer.concat(writes.map((chunk) => Buffer.from(chunk)));
  assert.deepEqual(bytes, Buffer.from("\u001b[?25lCoffee> 😀\n\u001b[?25h"));
  assert.doesNotMatch(bytes.toString("utf8"), /�/);
});

test("non-TTY discards an unfinished control sequence at a segment boundary", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("A\u001b]0;unfinished");
  renderer.finishSegment();
  renderer.append("B");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> A\nCoffee> B\n");
});

test("non-TTY dispose drops unfinished control-sequence state", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("A\u001b]0;unfinished");
  renderer.dispose({ preserve: true });
  renderer.append("leak");

  assert.equal(writes.join(""), "Coffee> A");
});

test("non-TTY finish preserves a re-entered append as a prefixed next segment", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggered = false;
  const harness = createHarness({
    isTTY: false,
    onWrite(chunk) {
      if (!triggered && chunk === "\n") {
        triggered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  renderer.finishSegment();
  renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> A\nCoffee> B\n");
});

test("non-TTY queues an append re-entered from the first prefixed write", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let firstWrite = true;
  const harness = createHarness({
    isTTY: false,
    onWrite() {
      if (firstWrite) {
        firstWrite = false;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> AB\n");
  assert.equal(harness.writes.join("").match(/Coffee> /g)?.length, 1);
});

test("non-TTY drains multiple nested appends in FIFO order", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let writeCount = 0;
  const harness = createHarness({
    isTTY: false,
    onWrite() {
      writeCount += 1;
      if (writeCount === 1) {
        renderer.append("B");
      } else if (writeCount === 2) {
        renderer.append("C");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> ABC\n");
  assert.equal(harness.writes.join("").match(/Coffee> /g)?.length, 1);
});

test("non-TTY remains usable after a writer throws after recording", () => {
  const writeError = new Error("plain write failed");
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let failFirstWrite = true;
  const harness = createHarness({
    isTTY: false,
    onWrite() {
      if (failFirstWrite) {
        failFirstWrite = false;
        renderer.append("B");
        throw writeError;
      }
    },
  });
  renderer = harness.renderer;

  let caught: unknown;
  try {
    renderer.append("A");
  } catch (error) {
    caught = error;
  }
  renderer.append("C");
  renderer.finishSegment();

  assert.equal(caught, writeError);
  assert.match(harness.writes.join(""), /Coffee> ABC\n$/);
});

test("non-TTY retries a queued chunk rejected before the writer accepts it", () => {
  const writeError = new Error("plain write rejected");
  let rejectFirstWrite = true;
  const harness = createHarness({
    isTTY: false,
    beforeWrite() {
      if (rejectFirstWrite) {
        rejectFirstWrite = false;
        throw writeError;
      }
    },
  });

  assert.throws(() => harness.renderer.append("A"), writeError);
  harness.renderer.append("B");
  harness.renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> AB\n");
});

test("non-TTY drains a rejected first write before its reentrant append", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let rejectFirstWrite = true;
  const harness = createHarness({
    isTTY: false,
    beforeWrite() {
      if (rejectFirstWrite) {
        rejectFirstWrite = false;
        renderer.append("C");
        throw new Error("plain write rejected before write");
      }
    },
  });
  renderer = harness.renderer;

  assert.throws(
    () => renderer.append("B"),
    /plain write rejected before write/,
  );
  renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> BC\n");
});

test("a timed preview write failure is contained and remains finishable", () => {
  const frameError = new Error("frame rejected");
  let rejectFrame = true;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (rejectFrame && chunk === "Coffee> A") {
        rejectFrame = false;
        throw frameError;
      }
    },
  });

  harness.renderer.append("A");
  assert.doesNotThrow(() => harness.timers[0]?.callback());
  harness.renderer.finishSegment();

  assert.equal(harness.writes.join("").match(/Coffee> A/g)?.length, 1);
});

test("safe fallback drains rejected suffix output before a reentrant append", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let rejectSuffix = true;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (rejectSuffix && chunk === "B") {
        rejectSuffix = false;
        renderer.append("C");
        throw new Error("fallback suffix rejected before write");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  renderer.append("B");
  harness.output.columns = 9;
  assert.doesNotThrow(() => harness.timers[1]?.callback());
  renderer.finishSegment();

  const plain = harness.writes
    .join("")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.equal(plain, "Coffee> ABC\n");
});

test("the default timer contains a transient writer failure in a child process", () => {
  const rendererUrl = new URL(
    "../src/streaming-markdown-renderer.ts",
    import.meta.url,
  ).href;
  const themeUrl = new URL("../src/theme.ts", import.meta.url).href;
  const script = `
    import { createStreamingMarkdownRenderer } from ${JSON.stringify(rendererUrl)};
    import { createStyleContext } from ${JSON.stringify(themeUrl)};
    const writes = [];
    let rejectFirstWrite = true;
    const renderer = createStreamingMarkdownRenderer({
      output: {
        columns: 80,
        write(chunk) {
          if (rejectFirstWrite) {
            rejectFirstWrite = false;
            throw new Error("transient writer failure");
          }
          writes.push(chunk);
        },
      },
      isTTY: true,
      styles: createStyleContext("latte", "none"),
      term: "xterm-256color",
      prefix: "Coffee> ",
    });
    renderer.append("A");
    await new Promise((resolve) => setTimeout(resolve, 80));
    renderer.finishSegment();
    process.stdout.write(writes.join(""));
  `;

  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8" },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Coffee> A/);
});

test("non-TTY can dispose after a writer throws after recording", () => {
  const writeError = new Error("plain write failed");
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let failFirstWrite = true;
  const harness = createHarness({
    isTTY: false,
    onWrite() {
      if (failFirstWrite) {
        failFirstWrite = false;
        renderer.append("B");
        throw writeError;
      }
    },
  });
  renderer = harness.renderer;

  assert.throws(() => renderer.append("A"), writeError);
  assert.doesNotThrow(() => renderer.dispose());
  renderer.append("C");

  assert.match(harness.writes.join(""), /AB$/);
});

test("retains an append re-entered while hiding the cursor", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!triggered && chunk === "\u001b[?25l") {
        triggered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();

  assert.equal(harness.timers.length, 2);
  harness.timers[1]?.callback();
  assert.match(harness.writes.join(""), /Coffee> AB$/);
});

test("retains an append re-entered while writing a frame", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!triggered && chunk === "Coffee> A") {
        triggered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();

  assert.equal(harness.timers.length, 2);
  harness.timers[1]?.callback();
  assert.match(harness.writes.join(""), /Coffee> AB$/);
});

test("does not revive a preview when frame output re-enters finishSegment", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!triggered && chunk === "Coffee> A") {
        triggered = true;
        renderer.finishSegment();
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  const finished = harness.writes.join("");

  assert.equal(finished.match(/Coffee> A/g)?.length, 1);
  assert.equal(finished, "\u001b[?25lCoffee> A\n\u001b[?25h");

  renderer.finishSegment();
  renderer.dispose();
  assert.equal(harness.writes.join(""), finished);
});

test("stops a flush when clearing its preview re-enters finishSegment", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let finishDuringClear = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (finishDuringClear && chunk === "\r\u001b[2K") {
        finishDuringClear = false;
        renderer.finishSegment();
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  renderer.append("B");
  finishDuringClear = true;
  harness.timers[1]?.callback();
  const finished = harness.writes.join("");

  assert.equal(finished.match(/Coffee> AB/g)?.length, 1);

  renderer.finishSegment();
  renderer.dispose();
  assert.equal(harness.writes.join(""), finished);
});

test("retains an append re-entered while clearing an old preview", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggerClear = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (triggerClear && chunk === "\r\u001b[2K") {
        triggerClear = false;
        renderer.append("C");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  renderer.append("B");
  triggerClear = true;
  harness.timers[1]?.callback();

  assert.equal(harness.timers.length, 3);
  harness.timers[2]?.callback();
  assert.match(harness.writes.join(""), /Coffee> ABC$/);
});

test("a timed frame failure is contained and permits cursor recovery", () => {
  const frameError = new Error("frame write failed");
  const recoveryError = new Error("cursor recovery failed");
  let frameFailures = 1;
  let recoveryFailures = 1;
  let showCursorWrites = 0;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (chunk === "Coffee> A" && frameFailures-- > 0) {
        throw frameError;
      }
    },
    onWrite(chunk) {
      if (chunk === "\u001b[?25h") {
        showCursorWrites += 1;
        if (recoveryFailures-- > 0) {
          throw recoveryError;
        }
      }
    },
  });

  harness.renderer.append("A");
  assert.doesNotThrow(() => harness.timers[0]?.callback());

  assert.equal(harness.timers.length, 1);
  assert.equal(showCursorWrites, 1);
  assert.equal(harness.writes.join("").match(/Coffee> A/g)?.length, 1);

  harness.renderer.dispose();
  harness.renderer.dispose();
  assert.equal(showCursorWrites, 2);
});

test("a timed hide failure is contained and leaves cursor recovery retryable", () => {
  const hideError = new Error("hide write failed");
  const recoveryError = new Error("cursor recovery failed");
  let hideFailures = 1;
  let recoveryFailures = 1;
  let showCursorWrites = 0;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (chunk === "\u001b[?25l" && hideFailures-- > 0) {
        throw hideError;
      }
    },
    onWrite(chunk) {
      if (chunk === "\u001b[?25h") {
        showCursorWrites += 1;
        if (recoveryFailures-- > 0) {
          throw recoveryError;
        }
      }
    },
  });

  harness.renderer.append("A");
  assert.doesNotThrow(() => harness.timers[0]?.callback());

  assert.equal(showCursorWrites, 1);
  assert.equal(harness.writes.join("").match(/Coffee> A/g)?.length, 1);

  harness.renderer.dispose();
  harness.renderer.dispose();
  assert.equal(showCursorWrites, 2);
});

for (const scenario of [
  {
    name: "frame",
    prepare: (_harness: ReturnType<typeof createHarness>) => {},
    matches: (chunk: string) => chunk === "Coffee> A\n",
    cancelled: true,
  },
  {
    name: "newline",
    prepare: (harness: ReturnType<typeof createHarness>) => {
      harness.timers[0]?.callback();
    },
    matches: (chunk: string) => chunk === "\n",
    cancelled: false,
  },
]) {
  test(`finishSegment retains a next-segment append during ${scenario.name}`, () => {
    let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
    let triggered = false;
    const harness = createHarness({
      onWrite(chunk) {
        if (!triggered && scenario.matches(chunk)) {
          triggered = true;
          renderer.append("B");
        }
      },
    });
    renderer = harness.renderer;

    renderer.append("A");
    scenario.prepare(harness);
    renderer.finishSegment();

    assert.equal(harness.timers.length, 2);
    assert.equal(harness.timers[0]?.cancelled, scenario.cancelled);
    assert.equal(harness.writes.join("").match(/\n/g)?.length, 1);
    const afterFinish = harness.writes.join("");

    harness.timers[0]?.callback();
    assert.equal(harness.writes.join(""), afterFinish);

    harness.timers[1]?.callback();
    assert.match(harness.writes.join(""), /Coffee> B$/);
    assert.equal(harness.writes.join("").match(/\n/g)?.length, 1);
  });
}

test("finishSegment fixes an unfinished preview once and restores the cursor", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("**完成**");
  timers[0]?.callback();
  renderer.finishSegment();
  renderer.finishSegment();
  const finished = writes.join("");

  assert.equal(finished.match(/Coffee> 完成/g)?.length, 1);
  assert.equal(finished.match(/\u001b\[\?25h/g)?.length, 1);
  assert.equal(finished, "\u001b[?25lCoffee> 完成\n\u001b[?25h");
});

test("finishSegment restores a hidden cursor when content already ends in newline", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("一行");
  timers[0]?.callback();
  renderer.append("完成\n");
  renderer.finishSegment();
  renderer.finishSegment();

  const output = writes.join("");
  assert.equal(output.match(/Coffee> 一行完成/g)?.length, 1);
  assert.equal(output.match(/\u001b\[\?25h/g)?.length, 1);
  assert.equal(output.match(/\n/g)?.length, 1);
});

test("show-cursor write can re-enter finishSegment without recursion", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!reentered && chunk === "\u001b[?25h") {
        reentered = true;
        renderer.finishSegment();
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("正文");
  harness.timers[0]?.callback();
  renderer.finishSegment();

  const output = harness.writes.join("");
  assert.equal(output.match(/\u001b\[\?25h/g)?.length, 1);
  assert.equal(output.match(/Coffee> 正文/g)?.length, 1);
});

test("dispose preserve flushes dirty text after a drawn frame and is idempotent", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("部分回答");
  timers[0]?.callback();
  renderer.append("未刷新");
  renderer.dispose({ preserve: true });
  const disposed = writes.join("");

  assert.equal(timers[1]?.cancelled, true);
  assert.match(
    disposed,
    /Coffee> 部分回答\r\u001b\[2KCoffee> 部分回答未刷新\u001b\[\?25h$/,
  );
  assert.equal(disposed.match(/未刷新/g)?.length, 1);
  assert.equal(disposed.match(/\u001b\[\?25h/g)?.length, 1);

  timers[1]?.callback();
  renderer.dispose({ preserve: false });
  assert.equal(writes.join(""), disposed);
});

test("dispose preserve synchronously draws a dirty first frame", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("首帧完整内容");
  renderer.dispose({ preserve: true });
  const disposed = writes.join("");

  assert.equal(timers[0]?.cancelled, true);
  assert.equal(
    disposed,
    "Coffee> 首帧完整内容",
  );

  timers[0]?.callback();
  assert.equal(writes.join(""), disposed);
});

test("dispose preserve keeps an already visible partial exactly once", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("可见部分");
  timers[0]?.callback();
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  const output = writes.join("");
  assert.equal(output.match(/Coffee> 可见部分/g)?.length, 1);
  assert.equal(output.match(/\n/g)?.length ?? 0, 0);
  assert.equal(output.match(/\u001b\[\?25h/g)?.length, 1);
});

test("dispose preserve consumes sanitizer tail without adding its own newline", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("部分回答\r");
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  assert.equal(writes.join(""), "Coffee> 部分回答\n");
});

test("dispose preserve still clears a transient status", () => {
  const { renderer, writes } = createHarness();

  renderer.showStatus("仍在思考…");
  renderer.dispose({ preserve: true });

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> 仍在思考…\r\u001b[2K\u001b[?25h",
  );
});

test("default dispose clears a live frame and restores the cursor", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("临时回答");
  timers[0]?.callback();
  const boundary = writes.length;
  renderer.dispose();

  assert.equal(
    writes.slice(boundary).join(""),
    "\r\u001b[2K\u001b[?25h",
  );
});

test("non-TTY writes plain statuses and each raw Markdown delta exactly once", () => {
  const { renderer, writes, timers } = createHarness({
    isTTY: false,
    styles: createStyleContext("latte", "truecolor"),
  });

  renderer.showStatus("正在思考…");
  renderer.append("* **晨");
  renderer.append("光**");
  renderer.finishSegment();
  renderer.dispose();

  assert.equal(
    writes.join(""),
    "Coffee> 正在思考…\nCoffee> * **晨光**\n",
  );
  assert.equal(timers.length, 0);
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});

test("non-TTY suppresses a status that arrives after visible segment text", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("正文");
  renderer.showStatus("正在思考…");
  renderer.append("继续");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> 正文继续\n");
  assert.equal(writes.join("").match(/Coffee> /g)?.length, 1);
});

test("non-TTY permits a status after a delta containing only filtered controls", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.append("\u001b[2J\b\u0001");
  renderer.showStatus("正在思考…");
  renderer.append("正文");
  renderer.finishSegment();

  assert.equal(writes.join(""), "Coffee> 正在思考…\nCoffee> 正文\n");
});

test("non-TTY status is sanitized to one physical line", () => {
  const { renderer, writes } = createHarness({ isTTY: false });

  renderer.showStatus("安全\u001b[2J状态\r下一行\t结束");

  assert.equal(writes.join(""), "Coffee> 安全状态 下一行    结束\n");
  assert.doesNotMatch(writes.join(""), /\u001b\[/);
});

test("capable TTY status is sanitized and never uses cursor-up", () => {
  const { renderer, writes } = createHarness();

  renderer.showStatus("安全\u001b[2J状态\n下一行");
  renderer.showStatus("");

  assert.match(writes.join(""), /Coffee> 安全状态 下一行/);
  assert.doesNotMatch(writes.join(""), /2J|\u001b\[[1-9][0-9]*A/);
});

test("a status widened by resize is committed before body output", () => {
  const { renderer, output, writes, timers } = createHarness({ columns: 30 });

  renderer.showStatus("abcdefghijk");
  output.columns = 15;
  renderer.append("正文");
  timers[0]?.callback();
  renderer.finishSegment();

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> abcdefghijk\nCoffee> 正文\n\u001b[?25h",
  );
  assert.doesNotMatch(writes.join(""), /\r\u001b\[2K/);
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/);
});

test("a status widened by resize is committed before a replacement status", () => {
  const { renderer, output, writes } = createHarness({ columns: 30 });

  renderer.showStatus("abcdefghijk");
  output.columns = 15;
  renderer.showStatus("新状态");
  renderer.showStatus("");

  const rendered = writes.join("");
  assert.match(rendered, /Coffee> abcdefghijk\nCoffee> 新状态/);
  assert.equal(rendered.match(/\r\u001b\[2K/g)?.length, 1);
  assert.match(rendered, /\u001b\[\?25h$/);
  assert.doesNotMatch(rendered, /\u001b\[[1-9][0-9]*A/);
});

test("showStatus stops when committing an unsafe status re-enters showStatus", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    columns: 30,
    onWrite(chunk) {
      if (!reentered && chunk === "\n") {
        reentered = true;
        renderer.showStatus("new");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("abcdefghijk");
  harness.output.columns = 15;
  renderer.showStatus("replacement");
  renderer.showStatus("");

  const rendered = harness.writes.join("");
  assert.match(rendered, /Coffee> abcdefghijk\nCoffee> new/);
  assert.equal(rendered.match(/Coffee> new/g)?.length, 1);
  assert.doesNotMatch(rendered, /replacement/);
  assert.equal(rendered.match(/\r\u001b\[2K/g)?.length, 1);
  assert.match(rendered, /\u001b\[\?25h$/);
});

test("finishSegment commits a resized status instead of clearing it", () => {
  const { renderer, output, writes } = createHarness({ columns: 30 });

  renderer.showStatus("abcdefghijk");
  output.columns = 15;
  renderer.finishSegment();

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> abcdefghijk\n\u001b[?25h",
  );
  assert.doesNotMatch(writes.join(""), /\r\u001b\[2K/);
});

for (const tail of [
  { name: "a lone high surrogate", delta: "\ud83d", body: "�" },
  { name: "a pending carriage return", delta: "\r", body: "" },
]) {
  test(`finishSegment commits a resized status before ${tail.name} becomes body`, () => {
    const { renderer, output, writes } = createHarness({ columns: 30 });

    renderer.showStatus("abcdefghijk");
    renderer.append(tail.delta);
    output.columns = 15;
    renderer.finishSegment();

    assert.equal(
      writes.join(""),
      `\u001b[?25lCoffee> abcdefghijk\nCoffee> ${tail.body}\n\u001b[?25h`,
    );
    assert.doesNotMatch(writes.join(""), /\r\u001b\[2K/);
  });
}

test("dispose preserve commits a resized status instead of clearing it", () => {
  const { renderer, output, writes } = createHarness({ columns: 30 });

  renderer.showStatus("abcdefghijk");
  output.columns = 15;
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> abcdefghijk\n\u001b[?25h",
  );
  assert.doesNotMatch(writes.join(""), /\r\u001b\[2K/);
});

test("finishSegment preserves a status re-entered while committing a resized status", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    columns: 30,
    onWrite(chunk) {
      if (!reentered && chunk === "\n") {
        reentered = true;
        renderer.showStatus("new");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("abcdefghijk");
  harness.output.columns = 15;
  renderer.finishSegment();
  renderer.showStatus("");

  const rendered = harness.writes.join("");
  assert.match(rendered, /Coffee> abcdefghijk\nCoffee> new/);
  assert.equal(rendered.match(/Coffee> new/g)?.length, 1);
  assert.equal(rendered.match(/\r\u001b\[2K/g)?.length, 1);
  assert.match(rendered, /\u001b\[\?25h$/);
});

test("dispose preserve fixes body text re-entered while committing a resized status", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    columns: 30,
    onWrite(chunk) {
      if (!reentered && chunk === "\n") {
        reentered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("abcdefghijk");
  harness.output.columns = 15;
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  const rendered = harness.writes.join("");
  assert.equal(
    rendered,
    "\u001b[?25lCoffee> abcdefghijk\nCoffee> B\u001b[?25h",
  );
  assert.equal(rendered.match(/Coffee> B/g)?.length, 1);
});

test("dispose preserve separates two re-entered body batches and restores the cursor last", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let phase = 0;
  const harness = createHarness({
    columns: 30,
    onWrite(chunk) {
      if (phase === 0 && chunk === "\n") {
        phase = 1;
        renderer.append("B");
      } else if (phase === 1 && chunk === "Coffee> B") {
        phase = 2;
        renderer.append("C");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("abcdefghijk");
  harness.output.columns = 15;
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  const rendered = harness.writes.join("");
  assert.equal(
    rendered,
    "\u001b[?25lCoffee> abcdefghijk\nCoffee> B\nCoffee> C\u001b[?25h",
  );
  assert.equal(rendered.match(/Coffee> B/g)?.length, 1);
  assert.equal(rendered.match(/Coffee> C/g)?.length, 1);
  assert.doesNotMatch(rendered, /Coffee> BCoffee>/);
  assert.equal(rendered.indexOf("\u001b[?25h"), rendered.length - 6);
});

test("dispose preserve drains an append re-entered while restoring the cursor", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!reentered && chunk === "\u001b[?25h") {
        reentered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  const rendered = harness.writes.join("");
  assert.equal(rendered.match(/Coffee> A/g)?.length, 1);
  assert.equal(rendered.match(/Coffee> B/g)?.length, 1);
  assert.doesNotMatch(rendered, /Coffee> ACoffee>/);
  assert.match(
    rendered,
    /Coffee> A(?:\u001b\[[?0-9;]*[A-Za-z])*\n(?:\u001b\[[?0-9;]*[A-Za-z])*Coffee> B/,
  );
  assert.match(rendered, /\u001b\[\?25h$/);
});

test("dispose preserve clears a status re-entered while restoring the cursor", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!reentered && chunk === "\u001b[?25h") {
        reentered = true;
        renderer.showStatus("new");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("old");
  renderer.dispose({ preserve: true });
  renderer.dispose({ preserve: true });

  const rendered = harness.writes.join("");
  const newStatus = rendered.indexOf("Coffee> new");
  const clearAfterNew = rendered.indexOf("\r\u001b[2K", newStatus);
  assert.notEqual(newStatus, -1);
  assert.notEqual(clearAfterNew, -1);
  assert.equal(rendered.match(/Coffee> new/g)?.length, 1);
  assert.match(rendered, /\u001b\[\?25h$/);
});

test("dispose preserve defers a cursor-write append after columns become invalid", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!reentered && chunk === "\u001b[?25h") {
        reentered = true;
        renderer.append("B");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  harness.output.columns = 0;
  renderer.dispose({ preserve: true });

  const plain = harness.writes
    .join("")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.equal(plain, "Coffee> A\nCoffee> B");
  assert.equal(plain.match(/Coffee> B/g)?.length, 1);
  assert.doesNotMatch(plain, /Coffee> ACoffee> B/);
});

test("dispose preserve gives a cursor-write status an open-line boundary", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let reentered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!reentered && chunk === "\u001b[?25h") {
        reentered = true;
        renderer.showStatus("new");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  renderer.dispose({ preserve: true });

  const rendered = harness.writes.join("");
  const plain = rendered.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.match(plain, /^Coffee> A\nCoffee> new/);
  assert.doesNotMatch(plain, /Coffee> ACoffee> new/);
  assert.match(rendered, /Coffee> new\r\u001b\[2K/);
  assert.match(rendered, /\u001b\[\?25h$/);
});

test("dispose preserve remembers an open-line boundary after cursor recovery fails", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let failCursor = true;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (failCursor && chunk === "\u001b[?25h") {
        failCursor = false;
        renderer.append("B");
        throw new Error("cursor recovery failed before write");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  assert.throws(
    () => renderer.dispose({ preserve: true }),
    /cursor recovery failed before write/,
  );
  renderer.dispose({ preserve: true });

  const plain = harness.writes
    .join("")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.equal(plain, "Coffee> A\nCoffee> B");
  assert.equal(plain.match(/Coffee> B/g)?.length, 1);
  assert.doesNotMatch(plain, /Coffee> ACoffee> B/);
});

test("dispose preserve retries a failed deferred finish without replaying append", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let queued = false;
  let failFinish = true;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (failFinish && chunk === "Coffee> B\n") {
        failFinish = false;
        throw new Error("finish failed before write");
      }
    },
    onWrite(chunk) {
      if (!queued && chunk === "\u001b[?25h") {
        queued = true;
        renderer.append("B");
        renderer.finishSegment();
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("A");
  harness.timers[0]?.callback();
  assert.throws(
    () => renderer.dispose({ preserve: true }),
    /finish failed before write/,
  );
  renderer.dispose({ preserve: true });

  const plain = harness.writes
    .join("")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  assert.equal(plain, "Coffee> A\nCoffee> B\n");
  assert.equal(plain.match(/Coffee> B/g)?.length, 1);
});

test("safe finalize drains one rejected plain newline without enqueuing another", () => {
  let failNewline = true;
  const harness = createHarness({
    isTTY: false,
    beforeWrite(chunk) {
      if (failNewline && chunk === "\n") {
        failNewline = false;
        throw new Error("newline failed before write");
      }
    },
  });

  harness.renderer.append("A");
  assert.throws(
    () => harness.renderer.finishSegment(),
    /newline failed before write/,
  );
  harness.renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> A\n");
  assert.equal(harness.writes.filter((chunk) => chunk === "\n").length, 1);
});

test("safe finalize replays an append captured by a rejected plain newline", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let failNewline = true;
  const harness = createHarness({
    isTTY: false,
    beforeWrite(chunk) {
      if (failNewline && chunk === "\n") {
        failNewline = false;
        renderer.append("C");
        throw new Error("newline failed before write");
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("B");
  assert.throws(
    () => renderer.finishSegment(),
    /newline failed before write/,
  );
  renderer.finishSegment();

  assert.equal(harness.writes.join(""), "Coffee> B\nCoffee> C\n");
  assert.equal(harness.writes.filter((chunk) => chunk === "\n").length, 2);
  assert.equal(harness.writes.join("").match(/Coffee> C/g)?.length, 1);
});

test("safe finalize keeps FIFO segments across consecutive plain newline failures", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  const deferred = ["C", "D"];
  const harness = createHarness({
    isTTY: false,
    beforeWrite(chunk) {
      const next = deferred.shift();
      if (chunk === "\n" && next !== undefined) {
        renderer.append(next);
        throw new Error(`newline ${next} failed before write`);
      }
      if (next !== undefined) {
        deferred.unshift(next);
      }
    },
  });
  renderer = harness.renderer;

  renderer.append("B");
  assert.throws(() => renderer.finishSegment(), /newline C failed/);
  assert.throws(() => renderer.finishSegment(), /newline D failed/);
  renderer.finishSegment();

  assert.equal(
    harness.writes.join(""),
    "Coffee> B\nCoffee> C\nCoffee> D\n",
  );
  assert.equal(harness.writes.filter((chunk) => chunk === "\n").length, 3);
  assert.equal(harness.writes.join("").match(/Coffee> C/g)?.length, 1);
});

for (const scenario of [
  {
    name: "frame",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B");
    },
    failureChunk: "Coffee> B\n",
    committedChunk: "Coffee> B\n",
  },
  {
    name: "clearLine",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B");
      harness.timers[0]?.callback();
      harness.renderer.append("2");
    },
    failureChunk: "\r\u001b[2K",
    committedChunk: "Coffee> B2\n",
  },
  {
    name: "preview newline",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B");
      harness.timers[0]?.callback();
    },
    failureChunk: "\n",
    committedChunk: "\n",
  },
]) {
  test(`body finalize defers reentrant append across a failed ${scenario.name} write`, () => {
    let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
    let armed = false;
    const harness = createHarness({
      beforeWrite(chunk) {
        if (armed && chunk === scenario.failureChunk) {
          armed = false;
          renderer.append("C");
          throw new Error(`${scenario.name} failed before write`);
        }
      },
    });
    renderer = harness.renderer;
    scenario.prepare(harness);
    armed = true;

    assert.throws(
      () => renderer.finishSegment(),
      new RegExp(`${scenario.name} failed before write`),
    );
    renderer.finishSegment();
    renderer.finishSegment();

    assert.equal(
      harness.writes.filter((chunk) => chunk === scenario.committedChunk).length,
      1,
    );
    assert.equal(
      harness.writes.filter((chunk) => chunk === "Coffee> C\n").length,
      1,
    );
    assert.ok(
      harness.writes.indexOf(scenario.committedChunk) <
        harness.writes.indexOf("Coffee> C\n"),
    );
  });
}

for (const scenario of [
  {
    name: "frame",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B\n");
    },
    failureChunk: "Coffee> B\n",
    committedChunk: "Coffee> B\n",
  },
  {
    name: "clearLine",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B");
      harness.timers[0]?.callback();
      harness.renderer.append("2\n");
    },
    failureChunk: "\r\u001b[2K",
    committedChunk: "Coffee> B2\n",
  },
  {
    name: "preview newline",
    prepare(harness: ReturnType<typeof createHarness>) {
      harness.renderer.append("B");
      harness.timers[0]?.callback();
      harness.renderer.append("\n");
    },
    failureChunk: "\n",
    committedChunk: "\n",
  },
]) {
  test(`commitLine drains a failed ${scenario.name} before a reentrant append`, () => {
    let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
    let armed = false;
    const harness = createHarness({
      beforeWrite(chunk) {
        if (armed && chunk === scenario.failureChunk) {
          armed = false;
          renderer.append("C");
          throw new Error(`${scenario.name} commit failed before write`);
        }
      },
    });
    renderer = harness.renderer;
    armed = true;

    assert.throws(
      () => scenario.prepare(harness),
      new RegExp(`${scenario.name} commit failed before write`),
    );
    renderer.finishSegment();

    assert.equal(
      harness.writes.filter((chunk) => chunk === scenario.committedChunk).length,
      1,
    );
    assert.equal(
      harness.writes.filter((chunk) => chunk === "        C\n").length,
      1,
    );
    assert.ok(
      harness.writes.indexOf(scenario.committedChunk) <
        harness.writes.indexOf("        C\n"),
    );
  });
}

test("status finalize drains a failed clear before reentrant body output", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let rejectClear = false;
  const harness = createHarness({
    beforeWrite(chunk) {
      if (rejectClear && chunk === "\r\u001b[2K") {
        rejectClear = false;
        renderer.append("C");
        throw new Error("status clear failed before write");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("old");
  rejectClear = true;
  assert.throws(
    () => renderer.finishSegment(),
    /status clear failed before write/,
  );
  renderer.finishSegment();

  assert.equal(
    harness.writes.filter((chunk) => chunk === "\r\u001b[2K").length,
    1,
  );
  assert.equal(
    harness.writes.filter((chunk) => chunk === "Coffee> C\n").length,
    1,
  );
  assert.ok(
    harness.writes.indexOf("\r\u001b[2K") <
      harness.writes.indexOf("Coffee> C\n"),
  );
});

test("showStatus empty commits and restores the cursor after columns become invalid", () => {
  const { renderer, output, writes } = createHarness();

  renderer.showStatus("等待中…");
  output.columns = 0;
  renderer.showStatus("");

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> 等待中…\n\u001b[?25h",
  );
});

test("capable TTY status is clipped before the physical line boundary", () => {
  const { renderer, writes } = createHarness({ columns: 12 });

  renderer.showStatus("abcdef");

  assert.equal(writes.join(""), "\u001b[?25lCoffee> abc");
});

test("status is ignored as soon as visible body text is accepted", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("正文");
  renderer.showStatus("迟到状态");
  timers[0]?.callback();
  renderer.finishSegment();

  assert.doesNotMatch(writes.join(""), /迟到状态/);
  assert.equal(writes.join("").match(/Coffee> 正文/g)?.length, 1);
});

test("clears a transient status before drawing the first text frame", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.showStatus("正在整理…");
  renderer.append("答案");
  timers[0]?.callback();

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> 正在整理…\r\u001b[2KCoffee> 答案",
  );
});

test("replaces and clears statuses without duplicating cursor controls", () => {
  const { renderer, writes } = createHarness();

  renderer.showStatus("状态一");
  renderer.showStatus("状态二");
  renderer.showStatus("");

  const output = writes.join("");
  assert.equal(output.match(/\u001b\[\?25l/g)?.length, 1);
  assert.equal(output.match(/\u001b\[\?25h/g)?.length, 1);
  assert.match(output, /Coffee> 状态一\r\u001b\[2KCoffee> 状态二/);
  assert.match(output, /Coffee> 状态二\r\u001b\[2K\u001b\[\?25h$/);
});

test("finishSegment clears a status without printing an empty answer line", () => {
  const { renderer, writes } = createHarness();

  renderer.showStatus("等待中…");
  renderer.finishSegment();

  assert.equal(
    writes.join(""),
    "\u001b[?25lCoffee> 等待中…\r\u001b[2K\u001b[?25h",
  );
});

test("finishSegment retains body text re-entered while clearing a status", () => {
  let renderer: ReturnType<typeof createStreamingMarkdownRenderer>;
  let triggered = false;
  const harness = createHarness({
    onWrite(chunk) {
      if (!triggered && chunk === "\r\u001b[2K") {
        triggered = true;
        renderer.append("下一段");
      }
    },
  });
  renderer = harness.renderer;

  renderer.showStatus("等待中…");
  renderer.finishSegment();

  assert.equal(harness.timers.length, 1);
  harness.timers[0]?.callback();
  assert.match(harness.writes.join(""), /Coffee> 下一段$/);
});

test("empty operations are no-ops", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.showStatus("");
  renderer.append("");
  renderer.finishSegment();

  assert.deepEqual(writes, []);
  assert.deepEqual(timers, []);
});

test("a cancelled timer callback cannot redraw a finished segment", () => {
  const { renderer, writes, timers } = createHarness();

  renderer.append("结束");
  renderer.finishSegment();
  const finished = writes.join("");
  timers[0]?.callback();

  assert.equal(writes.join(""), finished);
});
