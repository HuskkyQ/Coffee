import assert from "node:assert/strict";
import test from "node:test";

import { createActivityRenderer } from "../src/activity-indicator.js";
import { createStyleContext } from "../src/theme.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

test("animates one TTY line and leaves one timed success result", () => {
  let written = "";
  let tick: (() => void) | undefined;
  let stopped = 0;
  const timer = { unref() {} };
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: true,
    styles: createStyleContext("coast", "truecolor"),
    now: sequenceClock(1_000, 2_300),
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

  renderer.handle({ name: "web_search", phase: "start" });
  tick?.();
  renderer.handle({ name: "web_search", phase: "success" });

  const plain = stripAnsi(written);
  assert.match(plain, /◐ 正在翻找网页…/u);
  assert.match(plain, /◓ 正在翻找网页…/u);
  assert.match(plain, /✓ 网络信息已经带回 · 1\.3s/u);
  assert.match(written, /\u001b\[38;2;155;196;146m✓/u);
  assert.doesNotMatch(written, /\u001b\[[1-9][0-9]*A/u);
  assert.doesNotMatch(written, /冰美式|热拿铁|╭|╰|██████/u);
  assert.equal(stopped, 1);
});

test("uses plain distinct lines outside a TTY", () => {
  let written = "";
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: false,
    styles: createStyleContext("camp", "truecolor"),
    now: sequenceClock(0, 800),
  });

  renderer.handle({ name: "get_current_location", phase: "start" });
  renderer.handle({ name: "get_current_location", phase: "error" });

  assert.equal(
    written,
    "正在感知你的位置…\n✗ 近似定位暂时失败 · 0.8s\n",
  );
  assert.doesNotMatch(written, /\u001b\[/u);
});

for (const scenario of [
  {
    name: "web_fetch",
    action: "正在细读网页…",
    success: "✓ 网页正文已经读完 · 1.2s",
    error: "✗ 网页读取暂时失败 · 1.2s",
  },
  {
    name: "calculator",
    action: "正在研磨数字…",
    success: "✓ 计算结果已经出炉 · 1.2s",
    error: "✗ 这次计算没有成功 · 1.2s",
  },
  {
    name: "shell",
    action: "正在运行命令…",
    success: "✓ 命令执行已经完成 · 1.2s",
    error: "✗ 命令执行暂时失败 · 1.2s",
  },
] as const) {
  test(`keeps dedicated ${scenario.name} wording`, () => {
    for (const phase of ["success", "error"] as const) {
      let written = "";
      const renderer = createActivityRenderer({
        output: { write(chunk) { written += chunk; } },
        isTTY: false,
        styles: createStyleContext("latte", "none"),
        now: sequenceClock(0, 1_200),
      });

      renderer.handle({ name: scenario.name, phase: "start" });
      renderer.handle({ name: scenario.name, phase });

      assert.match(written, new RegExp(scenario.action, "u"));
      assert.match(
        written,
        new RegExp(phase === "success" ? scenario.success : scenario.error, "u"),
      );
    }
  });
}

test("pause clears the animation but preserves its eventual completion", () => {
  let written = "";
  let stopped = 0;
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: true,
    styles: createStyleContext("latte", "ansi"),
    now: sequenceClock(0, 900),
    startTimer() { return { unref() {} }; },
    stopTimer() { stopped += 1; },
  });

  renderer.handle({ name: "edit", phase: "start" });
  renderer.pause();
  const afterPause = written;
  renderer.handle({ name: "edit", phase: "success" });

  assert.equal(stopped, 1);
  assert.match(afterPause, /\u001b\[\?25h/u);
  assert.match(written, /✓ 工具执行已经完成 · 0\.9s/u);
});

test("updates activity styling without recreating the renderer", () => {
  let written = "";
  let tick: (() => void) | undefined;
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {},
  });

  renderer.handle({ name: "web_search", phase: "start" });
  renderer.setStyleContext(createStyleContext("camp", "truecolor"));
  tick?.();

  assert.match(written, /\u001b\[38;2;201;145;167m◓/u);
  renderer.dispose();
});

test("dispose stops an active status and is idempotent", () => {
  let written = "";
  let stopped = 0;
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: true,
    styles: createStyleContext("latte", "ansi"),
    startTimer() { return {}; },
    stopTimer() { stopped += 1; },
  });

  renderer.handle({ name: "web_search", phase: "start" });
  renderer.dispose();
  const afterFirstDispose = written;
  renderer.dispose();
  renderer.handle({ name: "web_search", phase: "success" });

  assert.equal(stopped, 1);
  assert.equal(written, afterFirstDispose);
  assert.match(written, /\u001b\[\?25h/u);
  assert.doesNotMatch(written, /✓|✗/u);
});
