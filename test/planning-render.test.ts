import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";

import { restoreTaskPlan } from "../src/planning/state.js";
import {
  createPlanProgressRenderer,
  parsePlanCommand,
  renderPlan,
} from "../src/planning/render.js";
import { createStyleContext } from "../src/theme.js";
import type { TaskPlan, TaskPlanStatus, TaskStepStatus } from "../src/planning/types.js";

const timestamp = "2026-07-27T08:00:00.000Z";
const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
const plainStyles = createStyleContext("latte", "none");
const colorStyles = createStyleContext("camp", "truecolor");

function restoredPlan(
  status: TaskPlanStatus,
  statuses: readonly TaskStepStatus[],
  goal = "发布任务计划",
  textOverrides: Partial<Record<"title" | "result" | "blockReason", string>> = {},
): TaskPlan {
  const steps = statuses.map((stepStatus, index) => {
    const step: Record<string, unknown> = {
      id: `step-${index + 1}`,
      title: textOverrides.title ?? `步骤 ${index + 1}`,
      successCriteria: "完成验证",
      dependsOn: index === 0 ? [] : [`step-${index}`],
      status: stepStatus,
      retryCount: 0,
    };
    if (stepStatus === "completed" || stepStatus === "failed") {
      step.result = textOverrides.result ?? "已提供结果";
    }
    if (stepStatus === "blocked") {
      step.blockReason = textOverrides.blockReason ?? "等待依赖";
    }
    return step;
  });
  return restoreTaskPlan({
    id: "plan-1",
    sessionId: "session-1",
    goal,
    status,
    revision: 1,
    steps,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

test("parses only the exact plan show and cancel forms", () => {
  assert.deepEqual(parsePlanCommand(" /plan "), { type: "show" });
  assert.deepEqual(parsePlanCommand("/plan   cancel"), { type: "cancel" });
  for (const input of [
    "/plan cancel now",
    "/PLAN",
    "/plan Cancel",
    "/plan\ncancel",
    "\n/plan",
    "/plan\n",
    "\r/plan\r",
    "/plan cancel\n",
    "/plan\t cancel",
    "/plan\u0000 cancel",
    "/plan\u202ecancel",
    1 as unknown as string,
    null as unknown as string,
  ]) {
    assert.deepEqual(parsePlanCommand(input), { type: "invalid" });
  }
});

test("renders the exact no-plan message", () => {
  assert.equal(renderPlan(undefined, plainStyles), "当前会话还没有任务计划。");
});

test("renders active plan progress, step markers, and results", () => {
  const plan = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);

  assert.equal(
    renderPlan(plan, plainStyles),
    [
      "计划：发布任务计划",
      "状态：进行中 · 1/4",
      "",
      "✓ 1. 步骤 1",
      "   结果：已提供结果",
      "◐ 2. 步骤 2",
      "○ 3. 步骤 3",
      "○ 4. 步骤 4",
    ].join("\n"),
  );
});

test("renders blocked, completed, and cancelled status-specific details", () => {
  const blocked = restoredPlan("blocked", [
    "completed",
    "blocked",
    "pending",
    "pending",
  ]);
  const completed = restoredPlan("completed", [
    "completed",
    "superseded",
    "completed",
    "completed",
  ]);
  const cancelled = restoredPlan("cancelled", [
    "completed",
    "failed",
    "pending",
    "superseded",
  ]);

  const blockedText = renderPlan(blocked, plainStyles);
  assert.match(blockedText, /^状态：已阻塞 · 1\/4/mu);
  assert.match(blockedText, /Ⅱ 2\. 步骤 2\n   阻塞原因：等待依赖/u);

  const completedText = renderPlan(completed, plainStyles);
  assert.match(completedText, /^状态：已完成 · 4\/4/mu);
  assert.match(completedText, /↷ 2\. 步骤 2/u);

  const cancelledText = renderPlan(cancelled, plainStyles);
  assert.match(cancelledText, /^状态：已取消 · 2\/4/mu);
  assert.match(cancelledText, /✗ 2\. 步骤 2\n   结果：已提供结果/u);
  assert.match(cancelledText, /↷ 4\. 步骤 4/u);
});

test("sanitizes external display text without terminal line or ANSI injection", () => {
  const plan = restoredPlan(
    "blocked",
    ["completed", "blocked", "pending", "pending"],
    "目标\u001b[31m\n下一行\u202e",
    {
      title: "标题\u001b[2J\n下一行",
      result: "\u001b[91m\n伪造结果",
      blockReason: "\u001b[2K\n伪造原因",
    },
  );

  const text = renderPlan(plan, plainStyles);
  assert.equal(text.includes("\u001b"), false);
  assert.match(text, /^计划：目标\\n下一行$/mu);
  assert.match(text, /标题\\n下一行/u);
  assert.match(text, /结果：\\n伪造结果/u);
  assert.match(text, /阻塞原因：\\n伪造原因/u);
  assert.equal(text.split("\n").some((line) => line === "伪造结果"), false);
  assert.equal(text.split("\n").some((line) => line === "伪造原因"), false);

  const empty = renderPlan(
    restoredPlan(
      "blocked",
      ["completed", "blocked", "pending", "pending"],
      "\u001b\u202e",
      {
        title: "\u001b\u202e",
        result: "\u001b\u202e",
        blockReason: "\u001b\u202e",
      },
    ),
    plainStyles,
  );
  assert.match(empty, /^计划：未命名任务$/mu);
  assert.match(empty, /未命名步骤/u);
  assert.match(empty, /结果：未提供/u);
  assert.match(empty, /阻塞原因：未提供/u);
});

test("strips complete C1 CSI and OSC sequences instead of exposing their payload", () => {
  const plan = restoredPlan(
    "blocked",
    ["completed", "blocked", "pending", "pending"],
    "目标\u009b31m红色\u009b0m\u009d0;伪造标题\u009c安全",
    {
      title: "步骤\u009b2J标题",
      result: "结果\u001b]0;伪造标题\u0007安全",
      blockReason: "原因\u009d8;;https://evil.example\u009c安全",
    },
  );

  const text = renderPlan(plan, plainStyles);
  assert.equal(text.includes("\u009b"), false);
  assert.equal(text.includes("\u009d"), false);
  assert.equal(text.includes("伪造标题"), false);
  assert.equal(text.includes("https://evil.example"), false);
  assert.match(text, /^计划：目标红色安全$/mu);
  assert.match(text, /步骤标题/u);
  assert.match(text, /结果：结果安全/u);
  assert.match(text, /阻塞原因：原因安全/u);
});

test("uses semantic theme styling without changing text", () => {
  const plan = restoredPlan("blocked", [
    "completed",
    "blocked",
    "pending",
    "pending",
  ]);
  const plain = renderPlan(plan, plainStyles);
  const colored = renderPlan(plan, colorStyles);

  assert.equal(plain.includes("\u001b"), false);
  assert.match(colored, /\u001b\[/u);
  assert.equal(stripAnsi(colored), plain);
  assert.match(colored, /\u001b\[1;38;2;236;222;228m计划：/u);
  assert.match(colored, /\u001b\[38;2;212;126;117m状态：已阻塞/u);
  assert.match(colored, /\u001b\[38;2;212;126;117mⅡ 2\. 步骤 2/u);
});

test("validates a detached plan snapshot without mutation and rejects unsafe plans", () => {
  const input = structuredClone(
    restoredPlan("active", ["completed", "in_progress", "pending", "pending"]),
  );
  const before = structuredClone(input);
  assert.equal(renderPlan(input, plainStyles), renderPlan(input, plainStyles));
  assert.deepEqual(input, before);

  const accessor = structuredClone(input) as unknown as Record<string, unknown>;
  let getterCalls = 0;
  Object.defineProperty(accessor, "goal", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => renderPlan(accessor as unknown as TaskPlan, plainStyles));
  assert.equal(getterCalls, 0);

  let trapCalls = 0;
  const proxy = new Proxy(input, {
    getOwnPropertyDescriptor() {
      trapCalls += 1;
      throw new Error("must not run");
    },
  });
  assert.throws(() => renderPlan(proxy, plainStyles));
  assert.equal(trapCalls, 0);

  assert.throws(
    () => renderPlan({ ...input, status: "invalid" } as unknown as TaskPlan, plainStyles),
  );
  assert.throws(
    () =>
      renderPlan(
        {
          ...input,
          steps: input.steps.map((step, index) =>
            index === 1 ? { ...step, dependsOn: ["missing"] } : step,
          ),
        } as TaskPlan,
        plainStyles,
      ),
  );
});

test("redraws one TTY line, uses a 140ms timer, and fixes completed steps once", () => {
  const writes: string[] = [];
  let tick: (() => void) | undefined;
  let stopped = 0;
  const timer = { unref() {} };
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: plainStyles,
    now: sequenceClock(0, 2_400, 2_400, 2_400),
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

  const active = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);
  renderer.handle(active);
  tick?.();
  renderer.handle(
    restoreTaskPlan({
      ...structuredClone(active),
      revision: 2,
      steps: active.steps.map((step, index) =>
        index === 1
          ? { ...step, status: "completed", result: "修改完成" }
          : index === 2
          ? { ...step, status: "in_progress" }
          : step
      ),
    }),
  );
  renderer.pause();
  renderer.dispose();

  const text = writes.join("");
  assert.match(text, /2\/4 \[███░░░░░░░\] 25% ◐ 步骤 2/u);
  assert.match(text, /\r\u001b\[2K/u);
  assert.doesNotMatch(text, /\u001b\[[1-9][0-9]*[AB]/u);
  assert.equal((text.match(/✓ 2\/4 步骤 2/g) ?? []).length, 1);
  assert.match(text, /3\/4 \[█████░░░░░\] 50% ◐ 步骤 3/u);
  assert.doesNotMatch(text, /☕|♡/u);
  assert.equal(stopped, 2);
});

test("isolates dynamic step state when a new plan reuses step ids", () => {
  const writes: string[] = [];
  const timers = [{ unref() {} }, { unref() {} }];
  const stopped: object[] = [];
  let timerStarts = 0;
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: plainStyles,
    now: sequenceClock(0, 0, 1_000, 5_000, 5_000, 5_500),
    startTimer(_callback, delay) {
      assert.equal(delay, 140);
      const timer = timers[timerStarts];
      assert.ok(timer);
      timerStarts += 1;
      return timer;
    },
    stopTimer(timer) {
      stopped.push(timer);
    },
  });
  const basePlanA = restoredPlan("active", [
    "in_progress",
    "pending",
    "pending",
    "pending",
  ]);
  const planA = restoreTaskPlan({
    ...structuredClone(basePlanA),
    steps: basePlanA.steps.map((step, index) => ({
      ...step,
      title: `A-step-${index + 1}`,
    })),
  });
  const planB = restoreTaskPlan({
    ...structuredClone(planA),
    id: "plan-2",
    steps: planA.steps.map((step, index) => ({
      ...step,
      title: `B-step-${index + 1}`,
    })),
  });

  renderer.handle(planA);
  renderer.handle(planB);
  renderer.dispose();

  const text = writes.join("");
  assert.equal(timerStarts, 2);
  assert.deepEqual(stopped, timers);
  assert.match(text, /1\/4 \[░░░░░░░░░░\] 0% ◐ A-step-1 · 1\.0s/u);
  assert.match(text, /1\/4 \[░░░░░░░░░░\] 0% ◐ B-step-1 · 0\.5s/u);
});

test("animates in a TTY without depending on a coffee preference", () => {
  let written = "";
  let timerStarts = 0;
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => { written += chunk; } },
    isTTY: true,
    styles: plainStyles,
    now: () => 0,
    startTimer() {
      timerStarts += 1;
      return {};
    },
    stopTimer() {},
  });
  renderer.handle(
    restoredPlan("active", ["completed", "in_progress", "pending", "pending"]),
  );
  renderer.dispose();

  assert.equal(timerStarts, 1);
  assert.match(written, /2\/4 .*[◐◓◑◒]/u);
  assert.doesNotMatch(written, /☕|♡|╭|╰/u);
});

test("appends non-TTY transitions once without cursor controls or duplicate copy", () => {
  let written = "";
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => { written += chunk; } },
    isTTY: false,
    styles: plainStyles,
    now: sequenceClock(0, 1_000),
  });
  const active = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);
  renderer.handle(active);
  renderer.handle(active);
  const blocked = restoreTaskPlan({
    ...structuredClone(active),
    status: "blocked",
    revision: 2,
    steps: active.steps.map((step, index) =>
      index === 1
        ? { ...step, status: "blocked", blockReason: "等待用户选择" }
        : step
    ),
  });
  renderer.handle(blocked);
  renderer.handle(blocked);
  renderer.dispose();

  assert.doesNotMatch(written, /\u001b\[/u);
  assert.equal((written.match(/◐ 2\/4 步骤 2/g) ?? []).length, 1);
  assert.equal((written.match(/Ⅱ 2\/4 步骤 2 · 等待用户选择/g) ?? []).length, 1);
});

test("announces each newly created pending plan once, safely and without starting progress", () => {
  for (const isTTY of [true, false] as const) {
    const writes: string[] = [];
    let timerStarts = 0;
    const renderer = createPlanProgressRenderer({
      output: { write: (chunk) => writes.push(String(chunk)) },
      isTTY,
      styles: isTTY ? colorStyles : plainStyles,
      getColumns: () => 22,
      startTimer() {
        timerStarts += 1;
        return {};
      },
    });
    const created = restoredPlan(
      "active",
      ["pending", "pending", "pending", "pending"],
      "不安全\u001b[31m\n中文目标".repeat(4),
    );
    const revision = restoreTaskPlan({ ...structuredClone(created), revision: 2 });
    const otherPlan = restoreTaskPlan({
      ...structuredClone(created),
      id: `plan-${isTTY ? "tty" : "plain"}`,
      revision: 1,
    });

    renderer.handle(created);
    renderer.handle(created);
    renderer.handle(revision);
    renderer.handle(otherPlan);
    renderer.dispose();

    const text = stripAnsi(writes.join(""));
    assert.equal(timerStarts, 0);
    assert.equal((text.match(/已创建计划：0\/4/g) ?? []).length, 2);
    assert.equal(text.includes("\u001b"), false);
    assert.equal(text.includes("\n中文目标"), false);
    assert.doesNotMatch(text, /☕|♡/u);
    if (isTTY) {
      for (const line of text.trimEnd().split("\n")) {
        assert.ok(stringWidth(line) <= 21, line);
      }
    } else {
      assert.match(text, /不安全\\n中文目标/u);
    }
  }
});

test("permanently disables plan creation summaries after an output failure", () => {
  let writes = 0;
  const renderer = createPlanProgressRenderer({
    output: {
      write() {
        writes += 1;
        throw new Error("broken output");
      },
    },
    isTTY: false,
    styles: plainStyles,
  });
  const created = restoredPlan("active", ["pending", "pending", "pending", "pending"]);

  assert.doesNotThrow(() => renderer.handle(created));
  assert.doesNotThrow(() =>
    renderer.handle(restoreTaskPlan({ ...structuredClone(created), revision: 2 }))
  );
  assert.equal(writes, 1);
});

test("renders superseded and failed terminal transitions distinctly", () => {
  let written = "";
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => { written += chunk; } },
    isTTY: false,
    styles: plainStyles,
  });
  renderer.handle(
    restoredPlan("active", ["superseded", "failed", "pending", "pending"]),
  );

  assert.match(written, /↷ 1\/4 步骤 1/u);
  assert.match(written, /✗ 2\/4 步骤 2 · 已提供结果/u);
  assert.doesNotMatch(written, /✓ 1\/4/u);
});

test("swallows output and timer failures and stops drawing permanently", () => {
  let writes = 0;
  let stopped = 0;
  const timer = {};
  const renderer = createPlanProgressRenderer({
    output: {
      write() {
        writes += 1;
        throw new Error("broken output");
      },
    },
    isTTY: true,
    styles: plainStyles,
    startTimer() {
      throw new Error("broken timer");
    },
    stopTimer(handle) {
      assert.equal(handle, timer);
      stopped += 1;
    },
  });
  const active = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);

  assert.doesNotThrow(() => renderer.handle(active));
  assert.doesNotThrow(() => renderer.handle(active));
  assert.doesNotThrow(() => renderer.pause());
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(writes, 1);
  assert.equal(stopped, 0);

  let timerFailureWrites = 0;
  const timerFailureRenderer = createPlanProgressRenderer({
    output: { write: () => { timerFailureWrites += 1; } },
    isTTY: true,
    styles: plainStyles,
    startTimer() {
      throw new Error("broken timer");
    },
  });
  assert.doesNotThrow(() => timerFailureRenderer.handle(active));
  assert.doesNotThrow(() => timerFailureRenderer.pause());
  assert.doesNotThrow(() => timerFailureRenderer.dispose());
  assert.equal(timerFailureWrites, 2);

  let tick: (() => void) | undefined;
  let nowCalls = 0;
  let callbackTimerStops = 0;
  const callbackFailureRenderer = createPlanProgressRenderer({
    output: { write() {} },
    isTTY: true,
    styles: plainStyles,
    now() {
      nowCalls += 1;
      if (nowCalls >= 4) throw new Error("broken clock callback");
      return 0;
    },
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {
      callbackTimerStops += 1;
    },
  });
  callbackFailureRenderer.handle(active);
  assert.doesNotThrow(() => tick?.());
  assert.equal(callbackTimerStops, 1);
});

test("swallows initial and transition clock failures and stays permanently stopped", () => {
  const active = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);

  let initialNowCalls = 0;
  let initialWrites = 0;
  const initialFailureRenderer = createPlanProgressRenderer({
    output: { write() { initialWrites += 1; } },
    isTTY: true,
    styles: plainStyles,
    now() {
      initialNowCalls += 1;
      throw new Error("initial clock failure");
    },
  });
  assert.doesNotThrow(() => initialFailureRenderer.handle(active));
  assert.doesNotThrow(() => initialFailureRenderer.handle(active));
  assert.doesNotThrow(() => initialFailureRenderer.pause());
  assert.doesNotThrow(() => initialFailureRenderer.dispose());
  assert.equal(initialNowCalls, 1);
  assert.equal(initialWrites, 1);

  let transitionNowCalls = 0;
  let transitionWrites = 0;
  const transitionFailureRenderer = createPlanProgressRenderer({
    output: { write() { transitionWrites += 1; } },
    isTTY: false,
    styles: plainStyles,
    now() {
      transitionNowCalls += 1;
      if (transitionNowCalls >= 3) {
        throw new Error("transition clock failure");
      }
      return 0;
    },
  });
  transitionFailureRenderer.handle(active);
  const writesBeforeFailure = transitionWrites;
  const completed = restoreTaskPlan({
    ...structuredClone(active),
    revision: 2,
    steps: active.steps.map((step, index) =>
      index === 1
        ? { ...step, status: "completed", result: "完成" }
        : index === 2
        ? { ...step, status: "in_progress" }
        : step
    ),
  });
  assert.doesNotThrow(() => transitionFailureRenderer.handle(completed));
  assert.doesNotThrow(() => transitionFailureRenderer.handle(completed));
  assert.doesNotThrow(() => transitionFailureRenderer.pause());
  assert.doesNotThrow(() => transitionFailureRenderer.dispose());
  assert.equal(transitionNowCalls, 3);
  assert.equal(transitionWrites, writesBeforeFailure);
});

test("swallows stop-timer dependency failures and never retries them", () => {
  const active = restoredPlan("active", [
    "completed",
    "in_progress",
    "pending",
    "pending",
  ]);
  let stopTimerCalls = 0;
  let stopTimerWrites = 0;
  const stopTimerFailureRenderer = createPlanProgressRenderer({
    output: { write() { stopTimerWrites += 1; } },
    isTTY: true,
    styles: plainStyles,
    startTimer() {
      return {};
    },
    stopTimer() {
      stopTimerCalls += 1;
      throw new Error("stop timer failure");
    },
  });
  stopTimerFailureRenderer.handle(active);
  assert.doesNotThrow(() => stopTimerFailureRenderer.pause());
  const stopTimerWritesAfterFailure = stopTimerWrites;
  assert.doesNotThrow(() => stopTimerFailureRenderer.handle(active));
  assert.doesNotThrow(() => stopTimerFailureRenderer.dispose());
  assert.equal(stopTimerCalls, 1);
  assert.equal(stopTimerWrites, stopTimerWritesAfterFailure);
});

test("updates plan styling without recreating the renderer", () => {
  const writes: string[] = [];
  let tick: (() => void) | undefined;
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    now: () => 0,
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {},
  });
  renderer.handle(
    restoredPlan("active", ["completed", "in_progress", "pending", "pending"]),
  );
  renderer.setStyleContext(colorStyles);
  tick?.();

  assert.match(writes.at(-1) ?? "", /\u001b\[38;2;201;145;167m/u);
  renderer.dispose();
});

test("keeps long TTY progress on one physical line and adapts to resize", () => {
  const writes: string[] = [];
  let tick: (() => void) | undefined;
  let columns = 24;
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    styles: colorStyles,
    getColumns: () => columns,
    now: () => 0,
    startTimer(callback) {
      tick = callback;
      return {};
    },
    stopTimer() {},
  });
  renderer.handle(
    restoredPlan(
      "active",
      ["in_progress", "pending", "pending", "pending"],
      "长目标",
      { title: "这是一个非常非常长的中文步骤标题".repeat(6) },
    ),
  );
  const first = stripAnsi(writes.at(-1) ?? "").replace(/^\r\u001b\[2K/u, "");
  assert.ok(stringWidth(first) <= columns - 1, first);
  assert.match(first, /1\/4/u);
  assert.match(first, /%/u);
  assert.match(first, /[◐◓◑◒]/u);
  assert.doesNotMatch(first, /☕|♡/u);

  columns = 60;
  tick?.();
  const resized = stripAnsi(writes.at(-1) ?? "").replace(/^\r\u001b\[2K/u, "");
  assert.ok(stringWidth(resized) <= columns - 1, resized);
  assert.ok(stringWidth(resized) > stringWidth(first));
  assert.doesNotMatch(writes.join(""), /\u001b\[[1-9][0-9]*A/u);
  renderer.dispose();
});

test("treats invalid plan snapshots as a permanent best-effort renderer failure", () => {
  let writes = 0;
  const renderer = createPlanProgressRenderer({
    output: { write() { writes += 1; } },
    isTTY: true,
    styles: plainStyles,
  });
  const valid = restoredPlan("active", [
    "in_progress",
    "pending",
    "pending",
    "pending",
  ]);

  assert.doesNotThrow(() =>
    renderer.handle({ ...valid, status: "corrupt" } as unknown as TaskPlan)
  );
  assert.doesNotThrow(() => renderer.handle(valid));
  assert.doesNotThrow(() => renderer.pause());
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(writes, 0);
});

test("stops a timer handle returned after a synchronous callback failure", () => {
  let writes = 0;
  let stopped = 0;
  let unrefCalls = 0;
  const timer = { unref() { unrefCalls += 1; } };
  const renderer = createPlanProgressRenderer({
    output: {
      write() {
        writes += 1;
        if (writes === 2) throw new Error("callback output failure");
      },
    },
    isTTY: true,
    styles: plainStyles,
    now: () => 0,
    startTimer(callback) {
      callback();
      return timer;
    },
    stopTimer(handle) {
      assert.equal(handle, timer);
      stopped += 1;
    },
  });
  const active = restoredPlan("active", [
    "in_progress",
    "pending",
    "pending",
    "pending",
  ]);

  assert.doesNotThrow(() => renderer.handle(active));
  assert.doesNotThrow(() => renderer.handle(active));
  assert.doesNotThrow(() => renderer.pause());
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(stopped, 1);
  assert.equal(unrefCalls, 0);
  assert.equal(writes, 2);
});

test("swallows a startTimer throw after its synchronous callback", () => {
  let writes = 0;
  let timerCalls = 0;
  const renderer = createPlanProgressRenderer({
    output: { write() { writes += 1; } },
    isTTY: true,
    styles: plainStyles,
    now: () => 0,
    startTimer(callback) {
      timerCalls += 1;
      callback();
      throw new Error("timer failed after callback");
    },
  });
  const active = restoredPlan("active", [
    "in_progress",
    "pending",
    "pending",
    "pending",
  ]);

  assert.doesNotThrow(() => renderer.handle(active));
  const writesAfterFailure = writes;
  assert.doesNotThrow(() => renderer.handle(active));
  assert.doesNotThrow(() => renderer.dispose());
  assert.equal(timerCalls, 1);
  assert.equal(writes, writesAfterFailure);
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
