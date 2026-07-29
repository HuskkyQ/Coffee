import assert from "node:assert/strict";
import test from "node:test";

import { createPlanningTools } from "../src/planning/tools.js";
import type { PlanManager } from "../src/planning/manager.js";
import type { PlanUpdateAction, TaskPlan } from "../src/planning/types.js";
import { createToolRegistry } from "../src/tool-registry.js";

const DRAFT_STEPS = [
  {
    id: "inspect",
    title: "检查现状",
    successCriteria: "确认当前实现",
    dependsOn: [],
  },
  {
    id: "implement",
    title: "完成实现",
    successCriteria: "测试通过",
    dependsOn: ["inspect"],
  },
] as const;

function plan(revision = 1): TaskPlan {
  return {
    id: "plan-1",
    sessionId: "session-1",
    goal: "完成规划工具",
    status: "active",
    revision,
    steps: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
}

interface RecordedCall {
  readonly kind: "create" | "update" | "finish";
  readonly input: unknown;
  readonly signal: AbortSignal | undefined;
}

function fakeManager(): { readonly manager: PlanManager; readonly calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    manager: {
      getCurrentPlan: () => undefined,
      createPlan(input, signal) {
        calls.push({ kind: "create", input, signal });
        return plan();
      },
      updatePlan(planId, expectedRevision, action, signal) {
        calls.push({
          kind: "update",
          input: { planId, expectedRevision, action },
          signal,
        });
        return plan(expectedRevision + 1);
      },
      finishPlan(planId, expectedRevision, summary, signal) {
        calls.push({
          kind: "finish",
          input: { planId, expectedRevision, summary },
          signal,
        });
        return { ...plan(expectedRevision + 1), status: "completed" };
      },
      cancelCurrent: () => undefined,
    },
  };
}

function tool(
  name: "create_plan" | "update_plan" | "finish_plan",
  manager: PlanManager,
) {
  const found = createPlanningTools(manager).find(
    (candidate) => candidate.definition.name === name,
  );
  assert.ok(found, name);
  return found;
}

test("defines provider-neutral planning tools with the required order and simple schemas", () => {
  const { manager } = fakeManager();
  const tools = createPlanningTools(manager);

  assert.deepEqual(
    tools.map((candidate) => candidate.definition.name),
    ["create_plan", "update_plan", "finish_plan"],
  );
  assert.deepEqual(tools.map((candidate) => candidate.riskLevel), [
    "write",
    "write",
    "write",
  ]);
  for (const candidate of tools) {
    assert.equal(candidate.definition.inputSchema.type, "object");
    assert.equal(candidate.definition.inputSchema.additionalProperties, false);
    assert.equal("oneOf" in candidate.definition.inputSchema, false);
    assert.equal("allOf" in candidate.definition.inputSchema, false);
  }
  assert.deepEqual(tools[0]!.definition.inputSchema.required, ["goal", "steps"]);
  assert.deepEqual(tools[1]!.definition.inputSchema.required, [
    "planId",
    "expectedRevision",
    "action",
  ]);
  assert.deepEqual(tools[2]!.definition.inputSchema.required, [
    "planId",
    "expectedRevision",
    "summary",
  ]);
  const updateProperties = tools[1]!.definition.inputSchema.properties as Record<string, unknown>;
  assert.deepEqual((updateProperties.action as Record<string, unknown>).enum, [
    "start_step",
    "complete_step",
    "fail_step",
    "block_step",
    "resume_step",
    "add_steps",
    "replace_pending_steps",
  ]);
});

test("creates a plan from an exact draft snapshot and returns a JSON-safe result", async () => {
  const { manager, calls } = fakeManager();
  const signal = new AbortController().signal;
  const result = await tool("create_plan", manager).execute(
    { goal: " 完成规划工具 ", steps: DRAFT_STEPS.map((step) => ({ ...step, dependsOn: [...step.dependsOn] })) },
    signal,
  );

  assert.deepEqual(result, { ok: true, plan: plan() });
  assert.deepEqual(calls, [
    {
      kind: "create",
      input: { goal: "完成规划工具", steps: DRAFT_STEPS },
      signal,
    },
  ]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("maps every update action to the plan manager with the same signal", async () => {
  const { manager, calls } = fakeManager();
  const signal = new AbortController().signal;
  const cases: Array<{ args: Record<string, unknown>; action: PlanUpdateAction }> = [
    { args: { planId: "plan-1", expectedRevision: 1, action: "start_step", stepId: "inspect" }, action: { type: "start_step", stepId: "inspect" } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "complete_step", stepId: "inspect", result: "已验证" }, action: { type: "complete_step", stepId: "inspect", result: "已验证" } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "fail_step", stepId: "inspect", result: "失败证据" }, action: { type: "fail_step", stepId: "inspect", result: "失败证据" } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "block_step", stepId: "inspect", reason: "等待输入" }, action: { type: "block_step", stepId: "inspect", reason: "等待输入" } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "resume_step", stepId: "inspect" }, action: { type: "resume_step", stepId: "inspect" } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "add_steps", steps: DRAFT_STEPS }, action: { type: "add_steps", steps: DRAFT_STEPS } },
    { args: { planId: "plan-1", expectedRevision: 1, action: "replace_pending_steps", steps: DRAFT_STEPS }, action: { type: "replace_pending_steps", steps: DRAFT_STEPS } },
  ];

  for (const item of cases) {
    assert.deepEqual(await tool("update_plan", manager).execute(item.args, signal), {
      ok: true,
      plan: plan(2),
    });
  }
  assert.deepEqual(
    calls.map((call) => call.input),
    cases.map(({ action }) => ({ planId: "plan-1", expectedRevision: 1, action })),
  );
  assert.ok(calls.every((call) => call.signal === signal));
});

test("finishes an exact plan and preserves the validated summary", async () => {
  const { manager, calls } = fakeManager();
  const result = await tool("finish_plan", manager).execute({
    planId: "plan-1",
    expectedRevision: 1,
    summary: " 本地测试已通过 ",
  });

  assert.deepEqual(result, {
    ok: true,
    plan: { ...plan(2), status: "completed" },
    summary: "本地测试已通过",
  });
  assert.deepEqual(calls[0]?.input, {
    planId: "plan-1",
    expectedRevision: 1,
    summary: "本地测试已通过",
  });
});

test("rejects invalid action field combinations and invalid scalar values before the manager", async () => {
  const { manager, calls } = fakeManager();
  const invalid: Record<string, unknown>[] = [
    { goal: "x", steps: DRAFT_STEPS, extra: true },
    { goal: "x" },
    { planId: "plan-1", expectedRevision: 1, action: "unknown", stepId: "inspect" },
    { planId: "plan-1", expectedRevision: 1, action: "start_step", stepId: "inspect", result: undefined },
    { planId: "plan-1", expectedRevision: 1, action: "complete_step", stepId: "inspect" },
    { planId: "plan-1", expectedRevision: 1, action: "block_step", stepId: "inspect", reason: "x", steps: DRAFT_STEPS },
    { planId: "plan-1", expectedRevision: 1, action: "add_steps", stepId: "inspect", steps: DRAFT_STEPS },
    { planId: "plan-1", expectedRevision: 0, action: "start_step", stepId: "inspect" },
    { planId: "plan-1", expectedRevision: 1.5, action: "start_step", stepId: "inspect" },
    { planId: " ", expectedRevision: 1, action: "start_step", stepId: "inspect" },
    { planId: "plan-1", expectedRevision: 1 },
  ];

  for (const args of invalid) {
    const name = "goal" in args ? "create_plan" : "summary" in args ? "finish_plan" : "update_plan";
    await assert.rejects(tool(name, manager).execute(args), /参数|字段|字符串|整数|长度|action/);
  }
  assert.deepEqual(calls, []);
});

test("rejects sparse arrays, getters, proxies, inherited data, and symbols without reading them", async () => {
  const { manager, calls } = fakeManager();
  const sparse = [DRAFT_STEPS[0], , DRAFT_STEPS[1]];
  let getterRead = false;
  const getterInput = {
    goal: "x",
    get steps() {
      getterRead = true;
      throw new Error("must not run");
    },
  };
  const proxy = new Proxy({ goal: "x", steps: DRAFT_STEPS }, {
    get() {
      throw new Error("must not run");
    },
  });
  const inherited = Object.create({ goal: "x", steps: DRAFT_STEPS }) as Record<string, unknown>;
  const withSymbol = { goal: "x", steps: DRAFT_STEPS, [Symbol("secret")]: true };

  for (const args of [
    { goal: "x", steps: sparse },
    getterInput,
    proxy,
    inherited,
    withSymbol,
  ]) {
    await assert.rejects(tool("create_plan", manager).execute(args), /普通 JSON|参数|字段/);
  }
  assert.equal(getterRead, false);
  assert.deepEqual(calls, []);
});

test("uses the registry for ordinary manager errors while letting abort reasons escape", async () => {
  const { manager } = fakeManager();
  const registry = createToolRegistry(createPlanningTools({
    ...manager,
    createPlan() {
      throw new Error("计划保存失败");
    },
  }));
  assert.deepEqual(JSON.parse(await registry.execute("create_plan", JSON.stringify({
    goal: "x",
    steps: DRAFT_STEPS,
  }))), { ok: false, error: "计划保存失败" });

  const controller = new AbortController();
  const reason = { kind: "stop" };
  const cancelling = createToolRegistry(createPlanningTools({
    ...manager,
    createPlan(_input, signal) {
      controller.abort(reason);
      assert.equal(signal, controller.signal);
      throw reason;
    },
  }));
  await assert.rejects(
    cancelling.execute("create_plan", JSON.stringify({ goal: "x", steps: DRAFT_STEPS }), controller.signal),
    (error) => error === reason,
  );
});
