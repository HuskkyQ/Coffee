import assert from "node:assert/strict";
import test from "node:test";

import { createLineStatus } from "../src/line-status.js";
import { createStyleContext } from "../src/theme.js";

test("animates one physical line and clears it safely", () => {
  const writes: string[] = [];
  let tick: (() => void) | undefined;
  let stopped = 0;
  const timer = { unref() {} };
  const renderer = createLineStatus({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    startTimer(callback, delay) {
      assert.equal(delay, 140);
      tick = callback;
      return timer;
    },
    stopTimer(handle) {
      assert.equal(handle, timer);
      stopped += 1;
    },
  });

  renderer.show("正在分析问题…");
  tick?.();
  renderer.clear();

  const output = writes.join("");
  assert.match(output, /◐/u);
  assert.match(output, /◓/u);
  assert.match(output, /正在分析问题…/u);
  assert.match(output, /\u001b\[38;2;211;166;111m◐/u);
  assert.match(output, /\u001b\[38;2;167;147;121m正在分析问题/u);
  assert.doesNotMatch(output, /\u001b\[[0-9]+A/u);
  assert.ok(output.includes("\u001b[?25h"));
  assert.equal(stopped, 1);
});

test("uses an updated theme on the next frame", () => {
  const writes: string[] = [];
  let tick: (() => void) | undefined;
  const renderer = createLineStatus({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {},
  });

  renderer.show("正在处理…");
  renderer.setStyleContext(createStyleContext("camp", "truecolor"));
  tick?.();

  assert.match(writes.at(-1) ?? "", /\u001b\[38;2;201;145;167m◓/u);
  assert.match(
    writes.at(-1) ?? "",
    /\u001b\[38;2;161;140;150m正在处理/u,
  );
  renderer.dispose();
});

test("dispose is idempotent and stops future output", () => {
  const writes: string[] = [];
  let stopped = 0;
  const renderer = createLineStatus({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: createStyleContext("latte", "ansi"),
    startTimer() {
      return {};
    },
    stopTimer() {
      stopped += 1;
    },
  });

  renderer.show("正在处理…");
  renderer.dispose();
  const afterFirstDispose = writes.join("");
  renderer.dispose();
  renderer.show("不应出现");
  renderer.complete("不应完成", "success");

  assert.equal(stopped, 1);
  assert.equal(writes.join(""), afterFirstDispose);
  assert.equal(
    (afterFirstDispose.match(/\u001b\[\?25h/gu) ?? []).length,
    1,
  );
});

test("idle clear and dispose do not write terminal controls", () => {
  const writes: string[] = [];
  const renderer = createLineStatus({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: createStyleContext("latte", "ansi"),
  });

  renderer.clear();
  renderer.dispose();

  assert.deepEqual(writes, []);
});

test("contains a writer failure and stops the timer", () => {
  let writes = 0;
  let stopped = 0;
  let tick: (() => void) | undefined;
  const renderer = createLineStatus({
    output: {
      write() {
        writes += 1;
        if (writes >= 3) {
          throw new Error("writer failed");
        }
      },
    },
    isTTY: true,
    styles: createStyleContext("latte", "ansi"),
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {
      stopped += 1;
    },
  });

  renderer.show("正在处理…");
  assert.doesNotThrow(() => tick?.());
  const afterFailure = writes;
  assert.doesNotThrow(() => renderer.show("不会重试"));
  assert.doesNotThrow(() => renderer.dispose());

  assert.equal(stopped, 1);
  assert.equal(writes, afterFailure);
});

test("writes distinct non-TTY statuses once without cursor controls", () => {
  const writes: string[] = [];
  const renderer = createLineStatus({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: false,
    styles: createStyleContext("coast", "truecolor"),
  });

  renderer.show("正在分析\n问题\u001b[31m");
  renderer.show("正在分析\n问题\u001b[31m");
  renderer.show("正在整理结果…");
  renderer.clear();
  renderer.complete("✓ 已完成", "success");
  renderer.complete("✓ 已完成", "success");

  assert.deepEqual(writes, [
    "正在分析 问题[31m\n",
    "正在整理结果…\n",
    "✓ 已完成\n",
  ]);
  assert.doesNotMatch(writes.join(""), /\u001b\[/u);
});
