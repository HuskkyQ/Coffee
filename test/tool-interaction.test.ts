import assert from "node:assert/strict";
import test from "node:test";

import { createToolInteraction } from "../src/tool-interaction.js";
import {
  createStyleContext,
  type TerminalStyleContext,
} from "../src/theme.js";

function createInteraction({
  answer = "y",
  interactive = true,
  onAsk = (_message: string) => {},
  onPause = () => {},
  onWrite = (_chunk: string) => {},
  styles = createStyleContext("latte", "none"),
}: {
  answer?: string | undefined;
  interactive?: boolean;
  onAsk?: (message: string) => void;
  onPause?: () => void;
  onWrite?: (chunk: string) => void;
  styles?: TerminalStyleContext;
} = {}) {
  return createToolInteraction({
    input: {
      isInteractive: interactive,
      async ask(message) { onAsk(message); return answer; },
      async askSecret() { return "secret"; },
      async select() { return undefined; },
      setStyleContext() {},
      close() {},
    },
    activity: {
      handle() {},
      pause: onPause,
      setStyleContext() {},
      dispose() {},
    },
    output: { write: onWrite },
    styles,
  });
}

test("renders an inline diff, pauses activity once, and accepts only y", async () => {
  let output = "";
  let paused = 0;
  const interaction = createInteraction({
    onPause() { paused += 1; },
    onWrite(chunk) { output += chunk; },
  });

  assert.equal(await interaction.confirmMutation({
    kind: "edit",
    path: "src/a.ts",
    patch: "--- a\n+++ a\n-x\n+y\n",
    changedLines: 2,
  }), true);
  assert.equal(paused, 1);
  assert.match(output, /Coffee 准备修改 src\/a\.ts/);
  assert.match(output, /-x\n\+y/);
});

test("updates diff colors without recreating the interaction", async () => {
  let output = "";
  const interaction = createInteraction({
    onWrite(chunk) { output += chunk; },
  });

  interaction.setStyleContext(createStyleContext("camp", "truecolor"));
  await interaction.confirmMutation({
    kind: "edit",
    path: "src/a.ts",
    patch: "-old\n+new",
    changedLines: 2,
  });

  assert.match(output, /\u001b\[38;2;212;126;117m-old/u);
  assert.match(output, /\u001b\[38;2;168;189;136m\+new/u);
});

test("non-interactive input denies writes and secrets without prompting", async () => {
  const interaction = createToolInteraction({
    input: {
      isInteractive: false,
      async ask() { throw new Error("must not ask"); },
      async askSecret() { throw new Error("must not ask"); },
      async select() { throw new Error("must not select"); },
      setStyleContext() {},
      close() {},
    },
    activity: { handle() {}, pause() {}, setStyleContext() {}, dispose() {} },
    output: { write() { throw new Error("must not write"); } },
    styles: createStyleContext("latte", "none"),
  });

  assert.equal(await interaction.confirmMutation({
    kind: "write",
    path: "a.ts",
    patch: "patch",
    changedLines: 1,
  }), false);
  assert.equal(
    await interaction.requestSecret({ path: ".env", key: "TOKEN" }),
    undefined,
  );
});

for (const answer of ["n", "", "\u001b"]) {
  test("rejects non-y confirmation answer " + JSON.stringify(answer), async () => {
    const interaction = createInteraction({ answer });
    assert.equal(await interaction.confirmMutation({
      kind: "edit",
      path: "a.ts",
      patch: "patch",
      changedLines: 1,
    }), false);
  });
}

test("aborted confirmation propagates AbortError", async () => {
  const controller = new AbortController();
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask() {
        controller.abort();
        return "y";
      },
      async askSecret() { return undefined; },
      async select() { return undefined; },
      setStyleContext() {},
      close() {},
    },
    activity: { handle() {}, pause() {}, setStyleContext() {}, dispose() {} },
    output: { write() {} },
    styles: createStyleContext("latte", "none"),
  });

  await assert.rejects(
    interaction.confirmMutation({
      kind: "edit",
      path: "a.ts",
      patch: "patch",
      changedLines: 1,
    }, controller.signal),
    (error) => (error as Error).name === "AbortError",
  );
});

test("sanitizes path and patch controls before writing to the terminal", async () => {
  let output = "";
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask() { return "n"; },
      async askSecret() { return undefined; },
      async select() { return undefined; },
      setStyleContext() {},
      close() {},
    },
    activity: { handle() {}, pause() {}, setStyleContext() {}, dispose() {} },
    output: { write(chunk: string) { output += chunk; }, columns: 40 },
    styles: createStyleContext("latte", "none"),
  });

  await interaction.confirmMutation({
    kind: "edit",
    path: "bad\u001b[31m.ts",
    patch: "--- a\n+++ a\n+\u001b[31mred\n",
    changedLines: 1,
  });

  assert.doesNotMatch(output, /\u001b/);
});

test("removes C1 controls from protected prompts, secret prompts, and diffs", async () => {
  const prompts: string[] = [];
  let output = "";
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask(message) { prompts.push(message); return "n"; },
      async askSecret(message) { prompts.push(message); return undefined; },
      async select() { return undefined; },
      setStyleContext() {},
      close() {},
    },
    activity: { handle() {}, pause() {}, setStyleContext() {}, dispose() {} },
    output: { write(chunk: string) { output += chunk; } },
    styles: createStyleContext("latte", "none"),
  });
  const controls = "\u0085\u009b\u009c\u009d";

  await interaction.authorizeProtected({
    path: `path${controls}`,
    operation: "read",
    reason: `reason${controls}`,
  });
  await interaction.requestSecret({
    path: `.env${controls}`,
    key: `TOKEN${controls}`,
  });
  await interaction.confirmMutation({
    kind: "edit",
    path: `a.ts${controls}`,
    patch: `+value${controls}\n`,
    changedLines: 1,
  });

  assert.doesNotMatch(prompts.join("\n") + output, /[\u0080-\u009f]/);
});

test("confirms a sanitized Shell command once and accepts y", async () => {
  const prompts: string[] = [];
  let paused = 0;
  const interaction = createInteraction({
    answer: " Y ",
    onAsk(message) { prompts.push(message); },
    onPause() { paused += 1; },
  });

  assert.equal(await interaction.confirmShell?.({
    command: "node bad\u001b[31m.js\nnext\u0007\u009b",
    reason: "需要执行\u001b[2J\n测试\u0085",
  }), true);

  assert.equal(paused, 1);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Coffee 准备执行命令/);
  assert.match(prompts[0] ?? "", /\$ node bad\[31m\.js\\nnext/);
  assert.match(prompts[0] ?? "", /原因：需要执行\[2J\\n测试/);
  assert.match(prompts[0] ?? "", /仅允许本次执行？ \[y\/N\] /);
  assert.doesNotMatch(prompts[0] ?? "", /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
});

test("non-interactive input rejects Shell confirmation without asking or pausing", async () => {
  let asked = 0;
  let paused = 0;
  const interaction = createInteraction({
    interactive: false,
    onAsk() { asked += 1; },
    onPause() { paused += 1; },
  });

  assert.equal(await interaction.confirmShell?.({
    command: "node script.js",
    reason: "执行脚本",
  }), false);
  assert.equal(asked, 0);
  assert.equal(paused, 0);
});

test("aborted Shell confirmation preserves the abort reason before prompting", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel shell prompt");
  controller.abort(reason);
  let asked = 0;
  let paused = 0;
  const interaction = createInteraction({
    onAsk() { asked += 1; },
    onPause() { paused += 1; },
  });

  await assert.rejects(
    async () => {
      await interaction.confirmShell?.({
        command: "node script.js",
        reason: "执行脚本",
      }, controller.signal);
    },
    (error: unknown) => error === reason,
  );
  assert.equal(asked, 0);
  assert.equal(paused, 0);
});

test("starts Shell output append-only and displays only auto-approved commands", () => {
  const writes: string[] = [];
  let paused = 0;
  const interaction = createInteraction({
    onPause() { paused += 1; },
    onWrite(chunk) { writes.push(chunk); },
  });

  interaction.beginShell?.({
    command: "npm\u001b[31m test\nignored",
    displayCommand: true,
  });
  interaction.beginShell?.({
    command: "node confirmed.js",
    displayCommand: false,
  });

  assert.equal(paused, 2);
  assert.deepEqual(writes, ["\n$ npm[31m test\\nignored\n\n"]);
  assert.doesNotMatch(writes.join(""), /\u001b\[[0-9;]*[A-Za-z]/);
  assert.doesNotMatch(writes.join(""), /node confirmed\.js/);
});

test("appends each defensively sanitized Shell output chunk exactly once", () => {
  const writes: string[] = [];
  const interaction = createInteraction({
    onWrite(chunk) { writes.push(chunk); },
  });

  interaction.writeShellOutput?.("one\u001b[31m\rnext\u0007\u009b\n");
  interaction.writeShellOutput?.("two\n");

  assert.deepEqual(writes, ["one[31m\\rnext\n", "two\n"]);
  assert.doesNotMatch(writes.join(""), /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.doesNotMatch(writes.join(""), /\u001b\[[0-9;]*A/);
});
