import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlanAction,
  createTaskPlan,
  finishTaskPlan,
  restoreTaskPlan,
} from "../src/planning/state.js";
import type {
  CreateTaskPlanInput,
  TaskPlan,
  TaskStepDraft,
} from "../src/planning/types.js";

const now = "2026-07-26T08:00:00.000Z";
const later = "2026-07-26T09:00:00.000Z";
const steps: readonly TaskStepDraft[] = [
  {
    id: "inspect",
    title: "检查项目",
    successCriteria: "找到需要修改的文件",
    dependsOn: [],
  },
  {
    id: "verify",
    title: "验证结果",
    successCriteria: "测试退出码为 0",
    dependsOn: ["inspect"],
  },
];

function plan(overrides: Partial<CreateTaskPlanInput> = {}): TaskPlan {
  return createTaskPlan({
    id: "plan-1",
    sessionId: "session-1",
    goal: "修复项目并通过测试",
    steps,
    now,
    ...overrides,
  });
}

function completeStep(
  current: TaskPlan,
  stepId: string,
  result = "已完成",
): TaskPlan {
  const started = applyPlanAction(
    current,
    { type: "start_step", stepId },
    later,
  );
  return applyPlanAction(
    started,
    { type: "complete_step", stepId, result },
    later,
  );
}

test("creates an immutable active plan with detached two-step input", () => {
  const mutableSteps = structuredClone(steps) as Array<{
    id: string;
    title: string;
    successCriteria: string;
    dependsOn: string[];
  }>;
  const created = plan({ steps: mutableSteps });

  assert.equal(created.status, "active");
  assert.equal(created.revision, 1);
  assert.equal(created.createdAt, now);
  assert.equal(created.updatedAt, now);
  assert.deepEqual(
    created.steps.map(({ id, status, retryCount }) => ({
      id,
      status,
      retryCount,
    })),
    [
      { id: "inspect", status: "pending", retryCount: 0 },
      { id: "verify", status: "pending", retryCount: 0 },
    ],
  );
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.steps), true);
  assert.equal(Object.isFrozen(created.steps[0]), true);
  assert.equal(Object.isFrozen(created.steps[0]!.dependsOn), true);

  mutableSteps[0]!.title = "已篡改";
  mutableSteps[1]!.dependsOn[0] = "verify";
  assert.equal(created.steps[0]!.title, "检查项目");
  assert.deepEqual(created.steps[1]!.dependsOn, ["inspect"]);
  assert.notEqual(created.steps, mutableSteps);
  assert.notEqual(created.steps[0], mutableSteps[0]);
});

test("enforces the 2 and 12 step boundaries", () => {
  assert.throws(() => plan({ steps: [steps[0]!] }), /2 到 12/u);

  const twelve = Array.from({ length: 12 }, (_, index) => ({
    id: `step_${index}`,
    title: `步骤 ${index}`,
    successCriteria: `完成 ${index}`,
    dependsOn: index === 0 ? [] : [`step_${index - 1}`],
  }));
  assert.equal(plan({ steps: twelve }).steps.length, 12);

  const thirteen = [
    ...twelve,
    {
      id: "step_12",
      title: "步骤 12",
      successCriteria: "完成 12",
      dependsOn: ["step_11"],
    },
  ];
  assert.throws(() => plan({ steps: thirteen }), /2 到 12/u);
});

test("counts Unicode code points for every bounded text field", () => {
  const boundaryPlan = plan({
    goal: "😀".repeat(1000),
    steps: [
      {
        id: "a",
        title: "😀".repeat(120),
        successCriteria: "😀".repeat(300),
        dependsOn: [],
      },
      {
        id: "b",
        title: "一",
        successCriteria: "一",
        dependsOn: ["a"],
      },
    ],
  });
  const started = applyPlanAction(
    boundaryPlan,
    { type: "start_step", stepId: "a" },
    later,
  );
  const failed = applyPlanAction(
    started,
    { type: "fail_step", stepId: "a", result: "😀".repeat(1000) },
    later,
  );
  const restarted = applyPlanAction(
    failed,
    { type: "start_step", stepId: "a" },
    later,
  );
  const blocked = applyPlanAction(
    restarted,
    { type: "block_step", stepId: "a", reason: "😀".repeat(1000) },
    later,
  );
  assert.equal(blocked.steps[0]!.blockReason, "😀".repeat(1000));

  assert.throws(() => plan({ goal: "😀".repeat(1001) }), /goal.*1 到 1000/u);
  assert.throws(
    () =>
      plan({
        steps: [
          { ...steps[0]!, title: "😀".repeat(121) },
          steps[1]!,
        ],
      }),
    /title.*1 到 120/u,
  );
  assert.throws(
    () =>
      plan({
        steps: [
          { ...steps[0]!, successCriteria: "😀".repeat(301) },
          steps[1]!,
        ],
      }),
    /successCriteria.*1 到 300/u,
  );
  assert.throws(
    () =>
      applyPlanAction(
        started,
        { type: "complete_step", stepId: "a", result: "😀".repeat(1001) },
        later,
      ),
    /result.*1 到 1000/u,
  );
  assert.throws(
    () =>
      applyPlanAction(
        restarted,
        { type: "block_step", stepId: "a", reason: "😀".repeat(1001) },
        later,
      ),
    /reason.*1 到 1000/u,
  );

  let finished = completeStep(plan(), "inspect");
  finished = completeStep(finished, "verify");
  assert.equal(
    finishTaskPlan(finished, "😀".repeat(1000), later).status,
    "completed",
  );
  assert.throws(
    () => finishTaskPlan(finished, "😀".repeat(1001), later),
    /summary.*1 到 1000/u,
  );
});

test("trims bounded text and rejects empty or unsafe identity fields", () => {
  const created = createTaskPlan({
    id: " plan-1 ",
    sessionId: " session-1 ",
    goal: " 目标 ",
    steps: [
      {
        id: "a",
        title: " 标题 ",
        successCriteria: " 标准 ",
        dependsOn: [],
      },
      {
        id: "b",
        title: "完成",
        successCriteria: "通过",
        dependsOn: ["a"],
      },
    ],
    now: ` ${now} `,
  });
  assert.equal(created.id, "plan-1");
  assert.equal(created.sessionId, "session-1");
  assert.equal(created.goal, "目标");
  assert.equal(created.steps[0]!.title, "标题");
  assert.equal(created.createdAt, now);

  for (const overrides of [
    { id: " " },
    { sessionId: " " },
    { goal: " " },
    { now: " " },
  ]) {
    assert.throws(() => plan(overrides), /必须|长度/u);
  }
});

test("validates step IDs and dependency graphs", () => {
  assert.equal(
    plan({
      steps: [
        { ...steps[0]!, id: "A-_1".repeat(16) },
        { ...steps[1]!, dependsOn: ["A-_1".repeat(16)] },
      ],
    }).steps[0]!.id.length,
    64,
  );

  const invalidGraphs: ReadonlyArray<readonly TaskStepDraft[]> = [
    [{ ...steps[0]!, id: "same" }, { ...steps[1]!, id: "same" }],
    [{ ...steps[0]!, id: "has space" }, steps[1]!],
    [{ ...steps[0]!, id: "x".repeat(65) }, steps[1]!],
    [{ ...steps[0]!, id: "中文" }, steps[1]!],
    [{ ...steps[0]!, dependsOn: ["missing"] }, steps[1]!],
    [{ ...steps[0]!, dependsOn: ["inspect"] }, steps[1]!],
    [{ ...steps[0]!, dependsOn: ["verify", "verify"] }, steps[1]!],
    [
      { ...steps[0]!, dependsOn: ["verify"] },
      { ...steps[1]!, dependsOn: ["inspect"] },
    ],
  ];
  for (const invalid of invalidGraphs) {
    assert.throws(() => plan({ steps: invalid }), /步骤|依赖|循环/u);
  }
});

test("starts only pending or failed steps with resolved dependencies", () => {
  const initial = plan();
  assert.throws(
    () =>
      applyPlanAction(
        initial,
        { type: "start_step", stepId: "verify" },
        later,
      ),
    /依赖/u,
  );
  const started = applyPlanAction(
    initial,
    { type: "start_step", stepId: "inspect" },
    later,
  );
  assert.equal(started.steps[0]!.status, "in_progress");
  assert.equal(started.revision, 2);
  assert.equal(started.createdAt, now);
  assert.equal(started.updatedAt, later);
  assert.throws(
    () =>
      applyPlanAction(
        started,
        { type: "start_step", stepId: "verify" },
        later,
      ),
    /正在进行|依赖/u,
  );
  assert.throws(
    () =>
      applyPlanAction(
        initial,
        { type: "start_step", stepId: "missing" },
        later,
      ),
    /步骤/u,
  );
});

test("allows only in-progress steps to complete, fail, or block", () => {
  const initial = plan();
  for (const action of [
    { type: "complete_step", stepId: "inspect", result: "完成" },
    { type: "fail_step", stepId: "inspect", result: "失败" },
    { type: "block_step", stepId: "inspect", reason: "等待" },
  ] as const) {
    assert.throws(
      () => applyPlanAction(initial, action, later),
      /in_progress|进行中/u,
    );
  }

  const started = applyPlanAction(
    initial,
    { type: "start_step", stepId: "inspect" },
    later,
  );
  const completed = applyPlanAction(
    started,
    { type: "complete_step", stepId: "inspect", result: " 完成 " },
    later,
  );
  assert.equal(completed.steps[0]!.status, "completed");
  assert.equal(completed.steps[0]!.result, "完成");
  assert.throws(
    () =>
      applyPlanAction(
        completed,
        { type: "start_step", stepId: "inspect" },
        later,
      ),
    /状态/u,
  );

  const failed = applyPlanAction(
    started,
    { type: "fail_step", stepId: "inspect", result: "失败" },
    later,
  );
  assert.equal(failed.status, "active");
  assert.equal(failed.steps[0]!.status, "failed");
});

test("blocks and resumes exactly one step through HITL", () => {
  const started = applyPlanAction(
    plan(),
    { type: "start_step", stepId: "inspect" },
    now,
  );
  const blocked = applyPlanAction(
    started,
    {
      type: "block_step",
      stepId: "inspect",
      reason: "需要用户选择目标文件",
    },
    later,
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.steps[0]!.status, "blocked");
  assert.equal(blocked.steps[0]!.blockReason, "需要用户选择目标文件");
  assert.throws(
    () =>
      applyPlanAction(
        blocked,
        { type: "start_step", stepId: "verify" },
        later,
      ),
    /blocked|阻塞/u,
  );

  const resumed = applyPlanAction(
    blocked,
    { type: "resume_step", stepId: "inspect" },
    later,
  );
  assert.equal(resumed.status, "active");
  assert.equal(resumed.steps[0]!.status, "in_progress");
  assert.equal(resumed.steps[0]!.retryCount, 0);
  assert.equal("blockReason" in resumed.steps[0]!, false);
  assert.throws(
    () =>
      applyPlanAction(
        resumed,
        { type: "resume_step", stepId: "inspect" },
        later,
      ),
    /blocked|阻塞/u,
  );
});

test("increments retries from zero through three and rejects a fourth retry", () => {
  let current = plan();
  for (let failure = 1; failure <= 4; failure += 1) {
    current = applyPlanAction(
      current,
      { type: "start_step", stepId: "inspect" },
      later,
    );
    assert.equal(current.steps[0]!.retryCount, failure - 1);
    current = applyPlanAction(
      current,
      { type: "fail_step", stepId: "inspect", result: `失败 ${failure}` },
      later,
    );
  }
  assert.equal(current.steps[0]!.retryCount, 3);
  assert.throws(
    () =>
      applyPlanAction(
        current,
        { type: "start_step", stepId: "inspect" },
        later,
      ),
    /重试次数/u,
  );
});

test("adds pending steps while preserving existing state and revalidating the graph", () => {
  const completed = completeStep(plan(), "inspect");
  const added = applyPlanAction(
    completed,
    {
      type: "add_steps",
      steps: [
        {
          id: "report",
          title: "汇总",
          successCriteria: "给出报告",
          dependsOn: ["verify"],
        },
      ],
    },
    later,
  );
  assert.equal(added.steps.length, 3);
  assert.equal(added.steps[0]!.status, "completed");
  assert.equal(added.steps[2]!.status, "pending");
  assert.equal(added.steps[2]!.retryCount, 0);
  assert.throws(
    () =>
      applyPlanAction(
        completed,
        { type: "add_steps", steps: [] },
        later,
      ),
    /至少.*1/u,
  );
  assert.throws(
    () =>
      applyPlanAction(
        completed,
        {
          type: "add_steps",
          steps: [
            {
              id: "bad",
              title: "错误",
              successCriteria: "错误",
              dependsOn: ["missing"],
            },
          ],
        },
        later,
      ),
    /依赖/u,
  );
});

test("rejects add_steps when the combined plan would exceed twelve steps", () => {
  const twelve = Array.from({ length: 12 }, (_, index) => ({
    id: `s${index}`,
    title: `步骤 ${index}`,
    successCriteria: `完成 ${index}`,
    dependsOn: index === 0 ? [] : [`s${index - 1}`],
  }));
  assert.throws(
    () =>
      applyPlanAction(
        plan({ steps: twelve }),
        {
          type: "add_steps",
          steps: [
            {
              id: "extra",
              title: "额外",
              successCriteria: "完成额外步骤",
              dependsOn: ["s11"],
            },
          ],
        },
        later,
      ),
    /2 到 12/u,
  );
});

test("replaces pending and failed steps with superseded history", () => {
  let current = applyPlanAction(
    plan(),
    { type: "start_step", stepId: "inspect" },
    later,
  );
  current = applyPlanAction(
    current,
    { type: "fail_step", stepId: "inspect", result: "旧路径失败" },
    later,
  );
  const replaced = applyPlanAction(
    current,
    {
      type: "replace_pending_steps",
      steps: [
        {
          id: "new_verify",
          title: "重新验证",
          successCriteria: "新验证通过",
          dependsOn: [],
        },
        {
          id: "report",
          title: "汇总",
          successCriteria: "给出可验证结果",
          dependsOn: ["new_verify"],
        },
      ],
    },
    later,
  );
  assert.deepEqual(
    replaced.steps.map((step) => [step.id, step.status]),
    [
      ["inspect", "superseded"],
      ["verify", "superseded"],
      ["new_verify", "pending"],
      ["report", "pending"],
    ],
  );
  assert.throws(
    () =>
      applyPlanAction(
        current,
        {
          type: "replace_pending_steps",
          steps: [
            {
              id: "only",
              title: "只有一个",
              successCriteria: "完成",
              dependsOn: [],
            },
          ],
        },
        later,
      ),
    /至少.*2/u,
  );
});

test("replace_pending_steps preserves in-progress and blocked steps", () => {
  const started = applyPlanAction(
    plan(),
    { type: "start_step", stepId: "inspect" },
    later,
  );
  const replacement = [
    {
      id: "new-a",
      title: "新步骤一",
      successCriteria: "完成一",
      dependsOn: ["inspect"],
    },
    {
      id: "new-b",
      title: "新步骤二",
      successCriteria: "完成二",
      dependsOn: ["new-a"],
    },
  ];
  const replacedStarted = applyPlanAction(
    started,
    { type: "replace_pending_steps", steps: replacement },
    later,
  );
  assert.equal(replacedStarted.steps[0]!.status, "in_progress");
  assert.equal(replacedStarted.steps[1]!.status, "superseded");

  const blocked = applyPlanAction(
    started,
    { type: "block_step", stepId: "inspect", reason: "等待用户" },
    later,
  );
  const replacedBlocked = applyPlanAction(
    blocked,
    { type: "replace_pending_steps", steps: replacement },
    later,
  );
  assert.equal(replacedBlocked.status, "blocked");
  assert.equal(replacedBlocked.steps[0]!.status, "blocked");
});

test("finishes only active fully resolved plans with a real completed path", () => {
  let current = completeStep(plan(), "inspect");
  assert.throws(
    () => finishTaskPlan(current, "过早完成", later),
    /尚未解决/u,
  );
  current = completeStep(current, "verify");
  const finished = finishTaskPlan(current, " 全部验证通过 ", later);
  assert.equal(finished.status, "completed");
  assert.equal(finished.revision, current.revision + 1);
  assert.equal(finished.updatedAt, later);
  assert.equal("summary" in finished, false);
  assert.throws(
    () => applyPlanAction(finished, { type: "add_steps", steps }, later),
    /终态/u,
  );
  assert.throws(
    () => finishTaskPlan(finished, "再次完成", later),
    /active|终态/u,
  );

  const allSuperseded = applyPlanAction(
    plan(),
    {
      type: "replace_pending_steps",
      steps: [
        {
          id: "new-a",
          title: "新一",
          successCriteria: "完成一",
          dependsOn: [],
        },
        {
          id: "new-b",
          title: "新二",
          successCriteria: "完成二",
          dependsOn: ["new-a"],
        },
      ],
    },
    later,
  );
  const supersededAgain = applyPlanAction(
    allSuperseded,
    {
      type: "replace_pending_steps",
      steps: [
        {
          id: "final-a",
          title: "最终一",
          successCriteria: "完成最终一",
          dependsOn: [],
        },
        {
          id: "final-b",
          title: "最终二",
          successCriteria: "完成最终二",
          dependsOn: ["final-a"],
        },
      ],
    },
    later,
  );
  const restoredAllSuperseded = restoreTaskPlan({
    ...supersededAgain,
    steps: supersededAgain.steps.map((step) => ({
      ...step,
      status: "superseded",
    })),
  });
  assert.throws(
    () => finishTaskPlan(restoredAllSuperseded, "没有真实完成", later),
    /至少.*一个.*completed/u,
  );
});

test("restores legal persisted fields into detached frozen snapshots", () => {
  const persisted = {
    id: "plan-1",
    sessionId: "session-1",
    goal: "恢复计划",
    status: "active",
    revision: 3,
    steps: [
      {
        ...steps[0]!,
        status: "completed",
        retryCount: 2,
        result: "已找到文件",
      },
      {
        ...steps[1]!,
        dependsOn: [...steps[1]!.dependsOn],
        status: "in_progress",
        retryCount: 1,
      },
    ],
    createdAt: now,
    updatedAt: later,
  };
  const restored = restoreTaskPlan(persisted);
  assert.equal(restored.revision, 3);
  assert.equal(restored.steps[0]!.status, "completed");
  assert.equal(restored.steps[0]!.retryCount, 2);
  assert.equal(restored.steps[0]!.result, "已找到文件");
  assert.equal(restored.steps[1]!.status, "in_progress");
  assert.equal(Object.isFrozen(restored), true);
  assert.equal(Object.isFrozen(restored.steps[1]!.dependsOn), true);

  persisted.goal = "已篡改";
  (persisted.steps[1]!.dependsOn as string[])[0] = "verify";
  assert.equal(restored.goal, "恢复计划");
  assert.deepEqual(restored.steps[1]!.dependsOn, ["inspect"]);
  assert.notEqual(restored.steps, persisted.steps);
});

test("restores valid blocked, completed, and cancelled plans", () => {
  const base = plan();
  const blocked = restoreTaskPlan({
    ...base,
    status: "blocked",
    steps: base.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "blocked" : "pending",
      ...(index === 0 ? { blockReason: "等待选择" } : {}),
    })),
  });
  assert.equal(blocked.status, "blocked");

  const completed = restoreTaskPlan({
    ...base,
    status: "completed",
    steps: base.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "completed" : "superseded",
      ...(index === 0 ? { result: "完成" } : {}),
    })),
  });
  assert.equal(completed.status, "completed");

  const cancelled = restoreTaskPlan({
    ...base,
    status: "cancelled",
    steps: base.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "failed" : "pending",
      ...(index === 0 ? { result: "失败" } : {}),
    })),
  });
  assert.equal(cancelled.status, "cancelled");
});

test("rejects restored started or ended steps with unresolved dependencies", () => {
  const base = plan();
  const dependencyStatuses = ["pending", "failed", "blocked"] as const;
  const dependentStatuses = [
    "in_progress",
    "blocked",
    "completed",
    "failed",
  ] as const;

  for (const dependencyStatus of dependencyStatuses) {
    for (const dependentStatus of dependentStatuses) {
      assert.throws(
        () =>
          restoreTaskPlan({
            ...base,
            status:
              dependencyStatus === "blocked" || dependentStatus === "blocked"
                ? "blocked"
                : "active",
            steps: [
              {
                ...base.steps[0]!,
                status: dependencyStatus,
                ...(dependencyStatus === "failed"
                  ? { result: "前置步骤失败" }
                  : {}),
                ...(dependencyStatus === "blocked"
                  ? { blockReason: "前置步骤阻塞" }
                  : {}),
              },
              {
                ...base.steps[1]!,
                status: dependentStatus,
                ...(dependentStatus === "completed" ||
                dependentStatus === "failed"
                  ? { result: "后续步骤结果" }
                  : {}),
                ...(dependentStatus === "blocked"
                  ? { blockReason: "后续步骤阻塞" }
                  : {}),
              },
            ],
          }),
        /依赖尚未解决/u,
      );
    }
  }
});

test("does not allow restore followed by an action to bypass dependencies", () => {
  const base = plan();
  let restored: TaskPlan | undefined;
  assert.throws(
    () => {
      restored = restoreTaskPlan({
        ...base,
        steps: [
          base.steps[0]!,
          { ...base.steps[1]!, status: "in_progress" },
        ],
      });
      return applyPlanAction(
        restored,
        {
          type: "complete_step",
          stepId: "verify",
          result: "绕过依赖完成",
        },
        later,
      );
    },
    /依赖尚未解决/u,
  );
  assert.equal(restored, undefined);
});

test("allows superseded history to retain unresolved dependencies", () => {
  const base = plan();
  for (const dependencyStatus of ["pending", "failed", "blocked"] as const) {
    const restored = restoreTaskPlan({
      ...base,
      status: dependencyStatus === "blocked" ? "blocked" : "active",
      steps: [
        {
          ...base.steps[0]!,
          status: dependencyStatus,
          ...(dependencyStatus === "failed" ? { result: "前置步骤失败" } : {}),
          ...(dependencyStatus === "blocked"
            ? { blockReason: "前置步骤阻塞" }
            : {}),
        },
        { ...base.steps[1]!, status: "superseded" },
      ],
    });
    assert.equal(restored.steps[1]!.status, "superseded");
  }
});

test("rejects damaged persisted plan and step states", () => {
  const base = plan();
  const corruptions: unknown[] = [
    { ...base, status: "unknown" },
    { ...base, revision: 0 },
    { ...base, revision: 1.5 },
    { ...base, createdAt: "" },
    {
      ...base,
      steps: base.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? "in_progress" : "in_progress",
      })),
    },
    {
      ...base,
      status: "active",
      steps: base.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? "blocked" : "pending",
        ...(index === 0 ? { blockReason: "等待" } : {}),
      })),
    },
    {
      ...base,
      status: "blocked",
      steps: base.steps.map((step) => ({
        ...step,
        status: "blocked",
        blockReason: "等待",
      })),
    },
    {
      ...base,
      status: "blocked",
    },
    {
      ...base,
      status: "completed",
    },
    {
      ...base,
      status: "completed",
      steps: base.steps.map((step) => ({ ...step, status: "superseded" })),
    },
    {
      ...base,
      status: "cancelled",
      steps: base.steps.map((step, index) => ({
        ...step,
        status: index === 0 ? "in_progress" : "pending",
      })),
    },
    {
      ...base,
      steps: base.steps.map((step, index) => ({
        ...step,
        retryCount: index === 0 ? -1 : 0,
      })),
    },
    {
      ...base,
      steps: base.steps.map((step, index) => ({
        ...step,
        retryCount: index === 0 ? 4 : 0,
      })),
    },
  ];
  for (const corrupted of corruptions) {
    assert.throws(
      () => restoreTaskPlan(corrupted),
      /计划|步骤|状态|revision|retryCount|时间|createdAt/u,
    );
  }
});

test("rejects extra fields at every public input layer", () => {
  assert.throws(
    () => createTaskPlan({ ...planInput(), extra: true } as never),
    /额外字段/u,
  );
  assert.throws(
    () =>
      plan({
        steps: [
          { ...steps[0]!, extra: true } as TaskStepDraft,
          steps[1]!,
        ],
      }),
    /额外字段/u,
  );
  assert.throws(
    () => restoreTaskPlan({ ...plan(), extra: true }),
    /额外字段/u,
  );
  assert.throws(
    () =>
      restoreTaskPlan({
        ...plan(),
        steps: [{ ...plan().steps[0]!, extra: true }, plan().steps[1]!],
      }),
    /额外字段/u,
  );
  assert.throws(
    () =>
      applyPlanAction(
        plan(),
        { type: "start_step", stepId: "inspect", extra: true } as never,
        later,
      ),
    /额外字段/u,
  );
});

test("rejects accessors without invoking getters or toJSON", () => {
  let invoked = 0;
  const unsafeStep = {
    id: "inspect",
    get title(): string {
      invoked += 1;
      throw new Error("title getter executed");
    },
    successCriteria: "完成",
    dependsOn: [],
  };
  assert.throws(
    () => plan({ steps: [unsafeStep, steps[1]!] }),
    /安全读取|普通 JSON/u,
  );

  const unsafePlan = planInput() as unknown as Record<string, unknown>;
  Object.defineProperty(unsafePlan, "goal", {
    enumerable: true,
    get() {
      invoked += 1;
      throw new Error("goal getter executed");
    },
  });
  assert.throws(
    () => createTaskPlan(unsafePlan as never),
    /安全读取|普通 JSON/u,
  );

  const toJSON = planInput() as unknown as Record<string, unknown>;
  Object.defineProperty(toJSON, "toJSON", {
    get() {
      invoked += 1;
      throw new Error("toJSON getter executed");
    },
  });
  assert.throws(
    () => createTaskPlan(toJSON as never),
    /额外字段|安全读取|普通 JSON/u,
  );
  assert.equal(invoked, 0);
});

test("rejects inherited fields and polluted prototypes", () => {
  const inherited = Object.create({ goal: "继承目标" }) as Record<string, unknown>;
  Object.assign(inherited, {
    id: "p",
    sessionId: "s",
    steps,
    now,
  });
  assert.throws(
    () => createTaskPlan(inherited as never),
    /普通 JSON|原型/u,
  );

  const polluted = Object.create({ polluted: true }) as Record<string, unknown>;
  Object.assign(polluted, planInput());
  assert.throws(
    () => createTaskPlan(polluted as never),
    /普通 JSON|原型/u,
  );
});

test("accepts own data fields on null-prototype objects", () => {
  const input = Object.create(null) as Record<string, unknown>;
  Object.assign(input, planInput());
  input.steps = (input.steps as TaskStepDraft[]).map((draft) => {
    const copy = Object.create(null) as Record<string, unknown>;
    Object.assign(copy, draft);
    return copy;
  });
  assert.equal(createTaskPlan(input as never).goal, "目标");
});

test("rejects sparse arrays, custom array properties, and non-string dependencies", () => {
  const sparse = new Array(2) as TaskStepDraft[];
  sparse[0] = steps[0]!;
  assert.throws(() => plan({ steps: sparse }), /密集数组|普通 JSON/u);

  const custom = structuredClone(steps) as TaskStepDraft[];
  Object.defineProperty(custom, "extra", { value: true });
  assert.throws(() => plan({ steps: custom }), /额外字段|普通 JSON/u);

  assert.throws(
    () =>
      plan({
        steps: [
          steps[0]!,
          { ...steps[1]!, dependsOn: [1 as unknown as string] },
        ],
      }),
    /依赖.*字符串/u,
  );
});

test("turns throwing Proxy reflection traps into stable validation errors", () => {
  const dangerous = new Proxy(planInput(), {
    getOwnPropertyDescriptor() {
      throw new Error("untrusted trap output " + "x".repeat(10_000));
    },
  });
  assert.throws(
    () => createTaskPlan(dangerous),
    (error: unknown) =>
      error instanceof Error &&
      /普通 JSON|安全读取/u.test(error.message) &&
      error.message.length < 200,
  );

  const revoked = Proxy.revocable(planInput(), {});
  revoked.revoke();
  assert.throws(
    () => createTaskPlan(revoked.proxy),
    (error: unknown) =>
      error instanceof Error &&
      /普通 JSON|安全读取/u.test(error.message) &&
      error.message.length < 200,
  );
});

test("rejects a transparent object Proxy before executing reflection traps", () => {
  const trapCalls = {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
  };
  const transparent = new Proxy(planInput(), {
    getPrototypeOf(target) {
      trapCalls.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCalls.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      trapCalls.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  assert.throws(
    () => createTaskPlan(transparent),
    /Proxy|代理|普通 JSON|安全读取/u,
  );
  assert.deepEqual(trapCalls, {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
  });
});

test("rejects a transparent array Proxy before executing reflection traps", () => {
  const trapCalls = {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
  };
  const transparent = new Proxy(structuredClone(steps), {
    getPrototypeOf(target) {
      trapCalls.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      trapCalls.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      trapCalls.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  assert.throws(
    () =>
      plan({
        steps: transparent as unknown as readonly TaskStepDraft[],
      }),
    /Proxy|代理|普通 JSON|安全读取/u,
  );
  assert.deepEqual(trapCalls, {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
  });
});

test("does not execute coercion hooks or echo untrusted values", () => {
  let invoked = 0;
  const dangerous = {
    toString() {
      invoked += 1;
      throw new Error("toString executed");
    },
    valueOf() {
      invoked += 1;
      throw new Error("valueOf executed");
    },
    toJSON() {
      invoked += 1;
      throw new Error("toJSON executed");
    },
  };
  assert.throws(
    () => plan({ goal: dangerous as unknown as string }),
    (error: unknown) =>
      error instanceof Error &&
      /goal.*字符串/u.test(error.message) &&
      error.message.length < 200,
  );
  assert.equal(invoked, 0);
});

test("all successful state functions return detached recursively frozen plans", () => {
  const created = plan();
  const started = applyPlanAction(
    created,
    { type: "start_step", stepId: "inspect" },
    later,
  );
  assert.notEqual(started, created);
  assert.notEqual(started.steps, created.steps);
  assert.notEqual(started.steps[0], created.steps[0]);
  assert.notEqual(started.steps[0]!.dependsOn, created.steps[0]!.dependsOn);
  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(started.steps), true);
  assert.equal(Object.isFrozen(started.steps[0]), true);
  assert.equal(Object.isFrozen(started.steps[0]!.dependsOn), true);

  const done = applyPlanAction(
    started,
    { type: "complete_step", stepId: "inspect", result: "已完成" },
    later,
  );
  const verified = completeStep(done, "verify");
  const finished = finishTaskPlan(verified, "完成", later);
  assert.notEqual(finished, verified);
  assert.notEqual(finished.steps, verified.steps);
  assert.notEqual(finished.steps[0], verified.steps[0]);
  assert.notEqual(
    finished.steps[0]!.dependsOn,
    verified.steps[0]!.dependsOn,
  );
});

function planInput(): CreateTaskPlanInput {
  return {
    id: "p",
    sessionId: "s",
    goal: "目标",
    steps: structuredClone(steps),
    now,
  };
}
