# Coffee Structured Task Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, provider-neutral structured task planning to Coffee, including validated plan state transitions, `/plan` commands, conditional HITL blocking, and a compact Codex-style CLI progress display.

**Architecture:** Keep the plan state machine pure and place SQLite persistence behind a dedicated store that reuses the database connection owned by `HistoryStore`. A `PlanManager` coordinates plan mutations with the current `SessionManager`; three registered tools let any compatible model create, update, and finish plans, while the CLI renders the persisted state and remains the only owner of terminal animation.

**Tech Stack:** TypeScript, Node.js 22+, `better-sqlite3`, `AbortSignal`, native Node test runner, existing Coffee tool registry/session/streaming/activity helpers. No new runtime dependency.

**Repository note:** `/Users/sevan/ai-tasks/pi-agent/coffee` is not currently inside a Git repository. Do not initialize Git or manufacture commit steps. Each task ends with a verified checkpoint; commits can be added later only if the user initializes or supplies a repository.

---

## Scope and success boundary

This plan implements the approved V1 specification at
`docs/superpowers/specs/2026-07-24-structured-task-planning-design.md`.
It does not implement an autonomous scheduler loop, background execution, RAG,
automatic retries, parallel step execution, or a generic `ask_user` tool.
Conditional HITL is represented by `block_step`, a normal assistant question,
and `resume_step` after the user's next message.

The feature is complete only when:

- planning state is locally validated instead of trusted from model prose;
- one current plan is persisted per Session in SQLite schema V2;
- a new lazy Session and its first plan are created atomically;
- `create_plan`, `update_plan`, and `finish_plan` work through the existing
  provider-neutral tool registry;
- `/plan` and `/plan cancel` work between turns;
- TTY output uses one dynamic current-step line and non-TTY output is append-only;
- Ctrl+C preserves the last committed plan state;
- `npm test` and `npm run check` pass without network or real-model calls.

## File map

**Create**

- `src/planning/types.ts` — immutable plan, step, draft, action, and persistence contracts.
- `src/planning/state.ts` — hostile-input validation and pure state transitions.
- `src/planning/store.ts` — SQLite plan reads/writes using the connection owned by `HistoryStore`.
- `src/planning/manager.ts` — Session-aware mutation lock, abort boundary, and revision coordination.
- `src/planning/tools.ts` — the three provider-neutral registered Planning tools.
- `src/planning/render.ts` — `/plan` text plus TTY/non-TTY progress renderer.
- `test/planning-state.test.ts` — limits, graphs, transitions, retries, and hostile-input tests.
- `test/planning-store.test.ts` — persistence, replacement, corruption, cascade, and concurrency tests.
- `test/planning-manager.test.ts` — lazy Session materialization, locking, cancellation, and abort tests.
- `test/planning-tools.test.ts` — tool definitions, schemas, parsing, results, and errors.
- `test/planning-render.test.ts` — stable view text and progress renderer behavior.

**Modify**

- `src/history/sqlite.ts` — schema version 2 and transactional V1→V2 migration.
- `src/history/store.ts` — construct/expose `PlanningStore` from the same SQLite connection.
- `src/history/session-manager.ts` — adopt the Session atomically materialized by `create_plan`.
- `src/tools.ts` — append Planning tools to the existing registry.
- `src/agent.ts` — planning prompt, plan events, and the one allowed mid-turn identity refresh.
- `src/commands.ts` — register `/plan` with optional `cancel`.
- `src/cli.ts` — construct `PlanManager`, handle `/plan`, and coordinate progress rendering.
- `src/activity-indicator.ts` — expose a safe pause point before plan/HITL/text output.
- `README.md` — document behavior and V1 limitations.
- `test/history-sqlite.test.ts` — V2 creation and V1 migration.
- `test/history-store.test.ts` — same-connection planning store and close regression.
- `test/session-manager.test.ts` — materialized Session adoption and lifecycle.
- `test/tools.test.ts` — Planning tool registry order/risk.
- `test/agent.test.ts` — complex/simple fixtures, HITL, identity, and Ctrl+C state.
- `test/commands.test.ts` — `/plan` resolution and typo suggestions.
- `test/activity-indicator.test.ts` — pause/dispose compatibility.
- `test/streaming-fetch.mjs` — deterministic plan tool-call scenarios.
- `test/cli.test.ts` — command and progress end-to-end coverage.

---

### Task 1: Planning contracts and pure state machine

**Files:**

- Create: `src/planning/types.ts`
- Create: `src/planning/state.ts`
- Create: `test/planning-state.test.ts`

- [ ] **Step 1: Write failing boundary and graph-validation tests**

Create `test/planning-state.test.ts` with explicit valid and invalid graphs:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPlanAction,
  createTaskPlan,
  finishTaskPlan,
  restoreTaskPlan,
} from "../src/planning/state.js";

const now = "2026-07-26T08:00:00.000Z";
const steps = [
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

function plan() {
  return createTaskPlan({
    id: "plan-1",
    sessionId: "session-1",
    goal: "修复项目并通过测试",
    steps,
    now,
  });
}

test("creates an immutable active plan with two bounded steps", () => {
  const created = plan();
  assert.equal(created.status, "active");
  assert.equal(created.revision, 1);
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
});

test("restores and validates persisted step states", () => {
  const created = plan();
  const restored = restoreTaskPlan({
    ...created,
    steps: created.steps.map((step, index) => ({
      ...step,
      status: index === 0 ? "completed" : "in_progress",
      ...(index === 0 ? { result: "已找到文件" } : {}),
    })),
    revision: 3,
  });
  assert.equal(restored.revision, 3);
  assert.equal(restored.steps[0]!.status, "completed");
  assert.equal(restored.steps[1]!.status, "in_progress");
  assert.equal(Object.isFrozen(restored), true);
});

for (const invalid of [
  [{ ...steps[0]!, id: "same" }, { ...steps[1]!, id: "same" }],
  [{ ...steps[0]!, dependsOn: ["missing"] }, steps[1]!],
  [{ ...steps[0]!, dependsOn: ["inspect"] }, steps[1]!],
  [
    { ...steps[0]!, dependsOn: ["verify"] },
    { ...steps[1]!, dependsOn: ["inspect"] },
  ],
]) {
  test(`rejects invalid dependency graph ${JSON.stringify(invalid)}`, () => {
    assert.throws(
      () =>
        createTaskPlan({
          id: "plan-1",
          sessionId: "session-1",
          goal: "目标",
          steps: invalid,
          now,
        }),
      /步骤|依赖|循环/,
    );
  });
}

test("enforces the 2 and 12 step boundaries", () => {
  assert.throws(
    () =>
      createTaskPlan({
        id: "p",
        sessionId: "s",
        goal: "目标",
        steps: [steps[0]!],
        now,
      }),
    /2 到 12/,
  );
  const twelve = Array.from({ length: 12 }, (_, index) => ({
    id: `step_${index}`,
    title: `步骤 ${index}`,
    successCriteria: `完成 ${index}`,
    dependsOn: index === 0 ? [] : [`step_${index - 1}`],
  }));
  assert.equal(
    createTaskPlan({
      id: "p",
      sessionId: "s",
      goal: "目标",
      steps: twelve,
      now,
    }).steps.length,
    12,
  );
});
```

- [ ] **Step 2: Run the state test and verify the missing-module failure**

Run:

```bash
node --import tsx --test test/planning-state.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/planning/state.js`.

- [ ] **Step 3: Add the exact public Planning contracts**

Create `src/planning/types.ts`:

```ts
export type TaskPlanStatus =
  | "active"
  | "blocked"
  | "completed"
  | "cancelled";

export type TaskStepStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "superseded";

export interface TaskStepDraft {
  readonly id: string;
  readonly title: string;
  readonly successCriteria: string;
  readonly dependsOn: readonly string[];
}

export interface TaskStep extends TaskStepDraft {
  readonly status: TaskStepStatus;
  readonly retryCount: number;
  readonly result?: string;
  readonly blockReason?: string;
}

export interface TaskPlan {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly status: TaskPlanStatus;
  readonly revision: number;
  readonly steps: readonly TaskStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PlanUpdateAction =
  | {
      readonly type: "start_step";
      readonly stepId: string;
    }
  | {
      readonly type: "complete_step" | "fail_step";
      readonly stepId: string;
      readonly result: string;
    }
  | {
      readonly type: "block_step";
      readonly stepId: string;
      readonly reason: string;
    }
  | {
      readonly type: "resume_step";
      readonly stepId: string;
    }
  | {
      readonly type: "add_steps";
      readonly steps: readonly TaskStepDraft[];
    }
  | {
      readonly type: "replace_pending_steps";
      readonly steps: readonly TaskStepDraft[];
    };

export interface CreateTaskPlanInput {
  readonly id: string;
  readonly sessionId: string;
  readonly goal: string;
  readonly steps: readonly TaskStepDraft[];
  readonly now: string;
}
```

- [ ] **Step 4: Implement strict input snapshots and graph validation**

Create `src/planning/state.ts`. Export `createTaskPlan`, `restoreTaskPlan`,
`applyPlanAction`, and `finishTaskPlan`. `restoreTaskPlan(input: unknown)`
must snapshot and validate the full persisted form, including status, revision,
retry count, optional result/block reason, timestamps, graph invariants, at
most one `in_progress` step, and consistency between plan/step statuses. Use
these constants and validation rules:

```ts
import type {
  CreateTaskPlanInput,
  PlanUpdateAction,
  TaskPlan,
  TaskStep,
  TaskStepDraft,
} from "./types.js";

const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_RETRIES = 3;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function boundedText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") throw new Error(`${field}必须是字符串。`);
  const normalized = value.trim();
  const length = codePoints(normalized);
  if (length < min || length > max) {
    throw new Error(`${field}长度必须在 ${min} 到 ${max} 之间。`);
  }
  return normalized;
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freeze(descriptor.value);
  }
  return Object.freeze(value);
}

function validateGraph(steps: readonly TaskStepDraft[]): void {
  if (steps.length < 2 || steps.length > 12) {
    throw new Error("计划必须包含 2 到 12 个步骤。");
  }
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) throw new Error("步骤 ID 不能重复。");
  for (const step of steps) {
    if (!STEP_ID.test(step.id)) throw new Error("步骤 ID 格式无效。");
    if (step.dependsOn.length > 12) throw new Error("步骤依赖不能超过 12 个。");
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) throw new Error("步骤包含未知依赖。");
      if (dependency === step.id) throw new Error("步骤不能依赖自身。");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("步骤依赖存在循环。");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
}
```

Both creation and restoration snapshots must accept only plain own-data JSON
objects/arrays, reject
accessors, inherited properties, Proxy traps, sparse arrays, unknown fields,
non-string dependency IDs, and duplicate dependencies before calling
`validateGraph`. Normalize `goal`, `title`, and `successCriteria` with the
limits in the specification, then return a recursively frozen plan.
`createTaskPlan` supplies the initial active/pending/revision-1 fields;
`restoreTaskPlan` preserves validated persisted fields.

- [ ] **Step 5: Add transition tests before implementing transitions**

Append these tests to `test/planning-state.test.ts`:

```ts
test("starts only an unblocked step and allows one current step", () => {
  const started = applyPlanAction(plan(), {
    type: "start_step",
    stepId: "inspect",
  }, now);
  assert.equal(started.steps[0]!.status, "in_progress");
  assert.throws(
    () =>
      applyPlanAction(started, {
        type: "start_step",
        stepId: "verify",
      }, now),
    /正在进行|依赖/,
  );
});

test("blocks and resumes a step through HITL", () => {
  const started = applyPlanAction(plan(), {
    type: "start_step",
    stepId: "inspect",
  }, now);
  const blocked = applyPlanAction(started, {
    type: "block_step",
    stepId: "inspect",
    reason: "需要用户选择目标文件",
  }, now);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.steps[0]!.blockReason, "需要用户选择目标文件");
  const resumed = applyPlanAction(blocked, {
    type: "resume_step",
    stepId: "inspect",
  }, now);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.steps[0]!.retryCount, 0);
});

test("increments retry count from failed and rejects a fourth retry", () => {
  let current = plan();
  for (let retry = 0; retry < 3; retry += 1) {
    current = applyPlanAction(current, {
      type: "start_step",
      stepId: "inspect",
    }, now);
    current = applyPlanAction(current, {
      type: "fail_step",
      stepId: "inspect",
      result: `失败 ${retry + 1}`,
    }, now);
  }
  assert.equal(current.steps[0]!.retryCount, 2);
  current = applyPlanAction(current, {
    type: "start_step",
    stepId: "inspect",
  }, now);
  current = applyPlanAction(current, {
    type: "fail_step",
    stepId: "inspect",
    result: "失败 4",
  }, now);
  assert.equal(current.steps[0]!.retryCount, 3);
  assert.throws(
    () =>
      applyPlanAction(current, {
        type: "start_step",
        stepId: "inspect",
      }, now),
    /重试次数/,
  );
});

test("replaces pending and failed steps with superseded history", () => {
  const replaced = applyPlanAction(plan(), {
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
  }, now);
  assert.deepEqual(
    replaced.steps.map((step) => [step.id, step.status]),
    [
      ["inspect", "superseded"],
      ["verify", "superseded"],
      ["new_verify", "pending"],
      ["report", "pending"],
    ],
  );
});

test("finishes only after a real completed path", () => {
  let current = applyPlanAction(plan(), {
    type: "start_step",
    stepId: "inspect",
  }, now);
  current = applyPlanAction(current, {
    type: "complete_step",
    stepId: "inspect",
    result: "已找到文件",
  }, now);
  assert.throws(
    () => finishTaskPlan(current, "过早完成", now),
    /尚未解决/,
  );
  current = applyPlanAction(current, {
    type: "start_step",
    stepId: "verify",
  }, now);
  current = applyPlanAction(current, {
    type: "complete_step",
    stepId: "verify",
    result: "测试通过",
  }, now);
  assert.equal(finishTaskPlan(current, "全部验证通过", now).status, "completed");
});
```

- [ ] **Step 6: Run transition tests and verify they fail**

Run:

```bash
node --import tsx --test test/planning-state.test.ts
```

Expected: the creation tests PASS and transition tests FAIL because transition
functions are not yet complete.

- [ ] **Step 7: Implement the minimal transition table**

In `src/planning/state.ts`, implement transitions by cloning the validated
plan, changing exactly one legal state, incrementing `plan.revision` by one,
setting `updatedAt`, and freezing the result. Enforce:

```ts
const terminalPlanStatuses = new Set(["completed", "cancelled"]);
const resolvedDependencyStatuses = new Set(["completed", "superseded"]);
const unresolvedStatuses = new Set([
  "pending",
  "in_progress",
  "blocked",
  "failed",
]);
```

`start_step` accepts `pending` or `failed`; a failed step increments
`retryCount` when it is restarted and must reject when `retryCount >= 3`.
`complete_step`, `fail_step`, and `block_step` accept only `in_progress`.
`resume_step` accepts only `blocked`. `add_steps` validates the combined graph.
`replace_pending_steps` supersedes only `pending` and `failed`, preserves other
steps, appends the new drafts, and validates the full graph. `finishTaskPlan`
rejects every unresolved status and rejects a plan with no completed step.

- [ ] **Step 8: Add hostile-input regression cases**

Append tests that pass a sparse `steps` array, an object with an inherited
`goal`, an accessor for `title`, a polluted prototype, and a Proxy throwing
from `getOwnPropertyDescriptor`. Each must throw a stable validation error
without reading the getter:

```ts
test("rejects accessors without invoking them", () => {
  let invoked = false;
  const unsafe = {
    id: "inspect",
    get title() {
      invoked = true;
      return "检查";
    },
    successCriteria: "完成",
    dependsOn: [],
  };
  assert.throws(
    () =>
      createTaskPlan({
        id: "p",
        sessionId: "s",
        goal: "目标",
        steps: [unsafe, steps[1]!],
        now,
      }),
    /安全读取|普通 JSON/,
  );
  assert.equal(invoked, false);
});
```

- [ ] **Step 9: Verify Task 1**

Run:

```bash
node --import tsx --test test/planning-state.test.ts
npm run check
```

Expected: all planning-state tests PASS and TypeScript reports no errors.

---

### Task 2: SQLite schema V2 and transactional migration

**Files:**

- Modify: `src/history/sqlite.ts`
- Modify: `test/history-sqlite.test.ts`

- [ ] **Step 1: Write failing V2 schema tests**

In `test/history-sqlite.test.ts`, update the expected version to 2 and add a
test that opens a new database and checks both new tables, their columns,
foreign keys, indexes, and CHECK constraints:

```ts
test("creates task planning schema in a new V2 database", async () => {
  await withHistoryPath((databasePath) => {
    const database = openHistoryDatabase(databasePath);
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 2);
      const tables = database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).all() as Array<{ name: string }>;
      assert.equal(tables.some(({ name }) => name === "task_plans"), true);
      assert.equal(tables.some(({ name }) => name === "task_steps"), true);
      const foreignKeys = database.pragma(
        "foreign_key_list(task_steps)",
      ) as Array<{ table: string; on_delete: string }>;
      assert.deepEqual(
        foreignKeys.map(({ table, on_delete }) => [table, on_delete]),
        [["task_plans", "CASCADE"]],
      );
    } finally {
      database.close();
    }
  });
});
```

- [ ] **Step 2: Write a real V1 migration preservation test**

Seed the exact V1 schema, one Session, one turn, one message, and one summary
with `user_version=1`. Open it through `openHistoryDatabase`, then assert the
old rows are byte-for-byte unchanged and the two planning tables exist:

```ts
assert.equal(database.pragma("user_version", { simple: true }), 2);
assert.deepEqual(
  database.prepare("SELECT * FROM sessions").all(),
  originalSessions,
);
assert.deepEqual(
  database.prepare("SELECT * FROM turns").all(),
  originalTurns,
);
assert.deepEqual(
  database.prepare("SELECT * FROM session_summaries").all(),
  originalSummaries,
);
```

- [ ] **Step 3: Run focused SQLite tests and verify failure**

Run:

```bash
node --import tsx --test test/history-sqlite.test.ts
```

Expected: FAIL because `HISTORY_SCHEMA_VERSION` is still 1 and planning tables
do not exist.

- [ ] **Step 4: Add schema V2 and ordered migrations**

In `src/history/sqlite.ts`:

```ts
export const HISTORY_SCHEMA_VERSION = 2;

const SCHEMA_V2 = `
CREATE TABLE task_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE
    REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'blocked', 'completed', 'cancelled')),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_steps (
  plan_id TEXT NOT NULL
    REFERENCES task_plans(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN (
      'pending', 'in_progress', 'blocked',
      'completed', 'failed', 'superseded'
    )),
  depends_on_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  result TEXT,
  block_reason TEXT,
  PRIMARY KEY (plan_id, id),
  UNIQUE (plan_id, position)
);
`;
```

Replace the single initialization branch with an ordered transaction:

```ts
database.transaction(() => {
  let nextVersion = version;
  if (nextVersion === 0) {
    database!.exec(SCHEMA_V1);
    nextVersion = 1;
    database!.pragma("user_version = 1");
  }
  if (nextVersion === 1) {
    database!.exec(SCHEMA_V2);
    nextVersion = 2;
    database!.pragma("user_version = 2");
  }
})();
```

Run this transaction for versions 0 and 1. Keep the existing foreign database,
integrity, WAL, permission, and future-version protections unchanged.

- [ ] **Step 5: Add migration rollback coverage**

Create a V1 database containing a deliberately conflicting `task_plans` table,
record its schema and rows, call `openHistoryDatabase`, and assert:

```ts
assert.throws(() => openHistoryDatabase(databasePath), /无法打开历史数据库/);
const verify = new Database(databasePath);
assert.equal(verify.pragma("user_version", { simple: true }), 1);
assert.deepEqual(
  verify.prepare("SELECT value FROM task_plans").all(),
  [{ value: "keep-me" }],
);
verify.close();
```

- [ ] **Step 6: Verify Task 2**

Run:

```bash
node --import tsx --test test/history-sqlite.test.ts
npm run check
```

Expected: all SQLite tests PASS, including migration rollback and existing file
permission/close cases.

---

### Task 3: PlanningStore persistence on the HistoryStore connection

**Files:**

- Create: `src/planning/store.ts`
- Create: `test/planning-store.test.ts`
- Modify: `src/history/store.ts`
- Modify: `test/history-store.test.ts`

- [ ] **Step 1: Define failing store tests**

Create `test/planning-store.test.ts` using `withHistoryPath`. Cover:

```ts
test("creates and reloads a plan for an existing session", async () => {
  await withHistoryPath((databasePath) => {
    const history = createHistoryStore(databasePath);
    const committed = history.commitTurn({
      title: "现有会话",
      providerId: "deepseek",
      modelId: "deepseek-chat",
      messages: [{ role: "user", content: "你好" }],
    });
    const created = history.plans.create({
      session: {
        kind: "existing",
        id: committed.id,
        expectedRevision: committed.revision,
      },
      plan: {
        id: "plan-1",
        goal: "完成两步任务",
        steps,
        now,
      },
    });
    assert.equal(created.materializedSession, undefined);
    assert.deepEqual(history.plans.loadForSession(committed.id), created.plan);
    history.close();
  });
});

test("atomically materializes a zero-turn session and plan", async () => {
  await withHistoryPath((databasePath) => {
    const history = createHistoryStore(databasePath);
    const created = history.plans.create({
      session: {
        kind: "new",
        title: "修复项目并通过测试",
        providerId: "deepseek",
        modelId: "deepseek-chat",
      },
      plan: {
        id: "plan-1",
        goal: "修复项目并通过测试",
        steps,
        now,
      },
    });
    assert.equal(created.materializedSession?.revision, 1);
    assert.equal(
      history.loadSession(created.plan.sessionId)?.turns.length,
      0,
    );
    assert.equal(history.getActiveSessionId(), created.plan.sessionId);
    history.close();
  });
});
```

Also test:

- active/blocked plan replacement is rejected;
- completed/cancelled plan replacement deletes old steps in the same transaction;
- update requires matching plan revision and persists every field;
- cancel accepts active/blocked and is idempotently rejected for terminal states;
- two store connections updating the same revision yield one success;
- deleting the Session cascades through `task_plans` and `task_steps`;
- malformed `depends_on_json`, status, position, or retry count is rejected on read;
- calling plan methods after `history.close()` returns the same closed-store error style.

- [ ] **Step 2: Run the store test and verify the missing API**

Run:

```bash
node --import tsx --test test/planning-store.test.ts
```

Expected: FAIL because `HistoryStore` has no `plans` property.

- [ ] **Step 3: Add the PlanningStore public contract**

Create `src/planning/store.ts` with:

```ts
import type Database from "better-sqlite3";
import type { TaskPlan, TaskStepDraft } from "./types.js";

export type PlanSessionInput =
  | {
      readonly kind: "existing";
      readonly id: string;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "new";
      readonly title: string;
      readonly providerId: string;
      readonly modelId: string;
    };

export interface MaterializedPlanSession {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: number;
}

export interface PlanningStore {
  loadForSession(sessionId: string): TaskPlan | undefined;
  create(input: {
    readonly session: PlanSessionInput;
    readonly plan: {
      readonly id: string;
      readonly goal: string;
      readonly steps: readonly TaskStepDraft[];
      readonly now: string;
    };
  }): {
    readonly plan: TaskPlan;
    readonly materializedSession?: MaterializedPlanSession;
  };
  save(plan: TaskPlan, expectedRevision: number): TaskPlan;
  cancel(sessionId: string, expectedRevision: number, now: string): TaskPlan;
}

export function createPlanningStore(options: {
  readonly database: Database.Database;
  readonly assertOpen: () => void;
}): PlanningStore;
```

- [ ] **Step 4: Implement strict row decoding and prepared writes**

In `src/planning/store.ts`, decode rows into plain values, parse
`depends_on_json`, and validate the complete reconstructed object through
`restoreTaskPlan`. This verifies persisted
status/revision/result/blockReason fields before returning a frozen object.
Do not repair malformed rows.

Use `database.transaction` for `create`, `save`, and `cancel`. `create` must:

1. verify an existing Session's `revision` without incrementing it, or insert a
   new Session at revision 1;
2. reject replacement when the current plan is active/blocked;
3. delete a terminal current plan before inserting its replacement;
4. insert plan and ordered steps;
5. update `app_metadata.active_session_id`;
6. return the materialized Session only for `kind: "new"`.

`save` must use:

```sql
UPDATE task_plans
SET goal = ?, status = ?, revision = ?, updated_at = ?
WHERE id = ? AND revision = ?
```

and require `changes === 1`; then replace the plan's step rows inside that same
transaction. Use the stable conflict text:

```ts
const PLAN_CONFLICT_MESSAGE =
  "该计划已被其他 Coffee 进程修改，请使用 /plan 重新查看。";
```

- [ ] **Step 5: Expose the store without opening a second database**

In `src/history/store.ts`, import `createPlanningStore` and extend the interface:

```ts
export interface HistoryStore {
  readonly plans: PlanningStore;
  // existing methods remain unchanged
}
```

Create it after the existing `assertOpen` closure:

```ts
const plans = createPlanningStore({ database, assertOpen });
```

Return the same instance as `plans`. Do not call `openHistoryDatabase` from
`src/planning/store.ts`.

- [ ] **Step 6: Add a same-connection regression**

In `test/history-store.test.ts`, assert `history.plans` observes a plan inserted
through the same HistoryStore immediately and that closing HistoryStore makes
both history and planning methods reject without double-closing SQLite.

- [ ] **Step 7: Verify Task 3**

Run:

```bash
node --import tsx --test \
  test/planning-store.test.ts \
  test/history-store.test.ts
npm run check
```

Expected: all focused tests PASS and no second SQLite connection is created.

---

### Task 4: PlanManager and controlled Session materialization

**Files:**

- Create: `src/planning/manager.ts`
- Create: `test/planning-manager.test.ts`
- Modify: `src/history/session-manager.ts`
- Modify: `test/session-manager.test.ts`

- [ ] **Step 1: Write failing Session adoption tests**

In `test/session-manager.test.ts`, add:

```ts
test("adopts a plan-materialized session without creating a turn", async () => {
  await withHistoryPath((databasePath) => {
    const store = createHistoryStore(databasePath);
    const manager = createSessionManager({
      store,
      getModel,
      defaultModel,
    });
    const created = store.plans.create({
      session: {
        kind: "new",
        title: "修复类型错误",
        providerId: defaultModel.providerId,
        modelId: defaultModel.id,
      },
      plan: {
        id: "plan-1",
        goal: "修复类型错误",
        steps,
        now,
      },
    });
    manager.adoptMaterializedSession(created.materializedSession!.id);
    assert.equal(manager.getCurrent().id, created.plan.sessionId);
    assert.equal(manager.getCurrent().revision, 1);
    assert.deepEqual(manager.getCurrent().turns, []);
    store.close();
  });
});
```

Also assert adoption rejects a mismatched active Session, a missing stored
Session, an unresolved model identity, and reentrant adoption.

- [ ] **Step 2: Add the controlled SessionManager method**

Extend `SessionManager`:

```ts
adoptMaterializedSession(sessionId: string): CurrentSession;
```

Implement it through the existing `runMutation`: require the current Session
to still be lazy (`base.id === undefined`), load `sessionId` from HistoryStore,
require zero turns, restore it through `restoredSession`, set it as active, and
assign `current`. This method is for `PlanManager` only; `/sessions` continues
to use `switchSession`.

- [ ] **Step 3: Write failing PlanManager tests**

Create `test/planning-manager.test.ts` with a real HistoryStore/SessionManager:

```ts
test("creates a plan and adopts the new session exactly once", async () => {
  const { history, session, plans } = createFixture();
  const created = plans.createPlan({
    goal: "检查并修复项目",
    steps,
  });
  assert.equal(session.getCurrent().id, created.sessionId);
  assert.deepEqual(plans.getCurrentPlan(), created);
  assert.equal(history.listSessions().length, 1);
  history.close();
});

test("checks AbortSignal before a synchronous transaction", () => {
  const { history, plans } = createFixture();
  const controller = new AbortController();
  controller.abort(new DOMException("Aborted", "AbortError"));
  assert.throws(
    () => plans.createPlan({ goal: "目标", steps }, controller.signal),
    /Aborted/,
  );
  assert.equal(history.listSessions().length, 0);
  history.close();
});

test("rejects reentrant plan mutation", () => {
  const { history, plans } = createFixtureWithReentrantStore();
  assert.throws(
    () => plans.createPlan({ goal: "目标", steps }),
    /计划状态正在更新/,
  );
  history.close();
});
```

Cover update, finish, cancel, Session switch, model switch, terminal plan
replacement, and returning immutable clones.

- [ ] **Step 4: Implement PlanManager**

Create `src/planning/manager.ts`:

```ts
export interface PlanManager {
  getCurrentPlan(): TaskPlan | undefined;
  createPlan(
    input: { readonly goal: string; readonly steps: readonly TaskStepDraft[] },
    signal?: AbortSignal,
  ): TaskPlan;
  updatePlan(
    planId: string,
    expectedRevision: number,
    action: PlanUpdateAction,
    signal?: AbortSignal,
  ): TaskPlan;
  finishPlan(
    planId: string,
    expectedRevision: number,
    summary: string,
    signal?: AbortSignal,
  ): TaskPlan;
  cancelCurrent(signal?: AbortSignal): TaskPlan | undefined;
}
```

`createPlanManager` receives `PlanningStore`, `SessionManager`,
`idFactory = randomUUID`, and `now = () => new Date().toISOString()`.
Every mutating method:

1. calls `signal?.throwIfAborted()` before acquiring the local mutation lock;
2. rejects reentry with
   `计划状态正在更新，不能执行嵌套的计划操作。`;
3. snapshots current Session and plan;
4. applies pure state functions before persistence;
5. persists once;
6. adopts a materialized Session only after the database transaction succeeds;
7. returns an immutable clone.

For a lazy Session, require a selected model and derive the Session title with
the existing `createSessionTitle(goal)`. For an existing Session, pass its id
and revision to `PlanningStore.create`. `finishPlan` validates `summary` as
1–1000 code points, passes it to `finishTaskPlan` as completion evidence, and
does not add a database column because the approved TaskPlan schema has no
summary field. `finish_plan` echoes the validated summary in its tool result;
the completed plan itself remains the persisted source of step-level evidence.

- [ ] **Step 5: Verify Task 4**

Run:

```bash
node --import tsx --test \
  test/session-manager.test.ts \
  test/planning-manager.test.ts
npm run check
```

Expected: all tests PASS; creating a plan for a lazy Session leaves zero turns
and updates the in-memory Session identity once.

---

### Task 5: Provider-neutral Planning tools and registry wiring

**Files:**

- Create: `src/planning/tools.ts`
- Create: `test/planning-tools.test.ts`
- Modify: `src/tools.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write failing tool-definition tests**

Create `test/planning-tools.test.ts`:

```ts
test("defines three write-risk provider-neutral tools", () => {
  const tools = createPlanningTools(fakeManager);
  assert.deepEqual(
    tools.map(({ definition, riskLevel }) => ({
      name: definition.name,
      riskLevel,
    })),
    [
      { name: "create_plan", riskLevel: "write" },
      { name: "update_plan", riskLevel: "write" },
      { name: "finish_plan", riskLevel: "write" },
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.definition.inputSchema.type, "object");
    assert.equal(tool.definition.inputSchema.additionalProperties, false);
  }
});
```

Add fake-manager call assertions for every action and test missing, extra,
wrong-type, unsafe accessor, and invalid-action parameters.

- [ ] **Step 2: Run and verify the missing module**

Run:

```bash
node --import tsx --test test/planning-tools.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact schemas and runtime parsers**

Create `src/planning/tools.ts` exporting:

```ts
export function createPlanningTools(
  manager: PlanManager,
): readonly RegisteredTool[];
```

Use simple OpenAI-compatible object schemas. `create_plan` requires `goal` and
`steps`. `update_plan` declares `planId`, `expectedRevision`, `action`,
`stepId`, `result`, `reason`, and `steps` as flat optional properties, then
runtime parsing enforces the exact allowed fields for each action.
`finish_plan` requires `planId`, `expectedRevision`, and `summary`.

Each handler calls the matching manager method and returns:

```ts
{
  ok: true,
  plan,
  summary?: string,
}
```

The tool descriptions must state that:

- `create_plan` is required before multi-step execution;
- `update_plan` must run before and after each step;
- `finish_plan` succeeds only after local completion validation.

- [ ] **Step 4: Register Planning tools after existing execution tools**

Extend `ToolOptions` in `src/tools.ts`:

```ts
planning?: PlanManager;
```

After all current Web, calculator, code, environment, and Shell tools are
assembled:

```ts
if (planning) {
  registeredTools.push(...createPlanningTools(planning));
}
```

Planning metadata must not call `ToolInteraction.confirmMutation` or
`ShellInteraction.confirmShell`; its `write` risk remains visible to local
policy metadata, while actual file/Shell side effects keep their existing
confirmations.

- [ ] **Step 5: Add registry integration assertions**

In `test/tools.test.ts`, create tools with a fake `PlanManager`, assert the
final three definition names and `write` risks, execute `create_plan`, and
verify the JSON result. Also assert omitting `planning` preserves all existing
tool definitions for isolated tests.

- [ ] **Step 6: Verify Task 5**

Run:

```bash
node --import tsx --test \
  test/planning-tools.test.ts \
  test/tools.test.ts \
  test/tool-registry.test.ts
npm run check
```

Expected: all tests PASS and no model-adapter-specific types appear under
`src/planning/`.

---

### Task 6: Agent prompt, plan events, and controlled identity refresh

**Files:**

- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/streaming-fetch.mjs`

- [ ] **Step 1: Add failing prompt and simple-task tests**

In `test/agent.test.ts`, assert the system prompt says:

```text
复杂任务必须先调用 create_plan；简单问答、翻译、单次读取和单步计算不要创建计划。
每个步骤执行前调用 update_plan(start_step)。
只有满足 successCriteria 且有工具成功证据时才能 complete_step。
工具失败后必须 fail_step、block_step 或重规划。
关键歧义先 block_step，再向用户提出一个明确问题。
全部步骤解决后必须调用 finish_plan。
```

Add a simple-answer fixture whose model returns text without Planning calls;
assert it completes and persists normally.

- [ ] **Step 2: Add a failing complex-task tool-loop test**

Add a deterministic gateway sequence:

1. `create_plan`;
2. `update_plan(start_step)`;
3. `read`;
4. `update_plan(complete_step)`;
5. `update_plan(start_step)`;
6. `shell` with `exitCode: 0`;
7. `update_plan(complete_step)`;
8. `finish_plan`;
9. final assistant text.

Collect Conversation events and assert each committed plan revision produces
one `plan_activity` event and the final persisted plan is completed.

- [ ] **Step 3: Add lazy-Session and Ctrl+C tests**

Start with a Session lacking `id`, let the first model call `create_plan`, then
abort before the next model request. Assert:

```ts
assert.ok(session.getCurrent().id);
assert.equal(session.getCurrent().turns.length, 0);
assert.equal(plans.getCurrentPlan()?.status, "active");
```

Also assert a non-Planning tool that changes Session identity still throws
`历史会话已在回答期间发生变化。`.

- [ ] **Step 4: Extend Conversation options and events**

In `src/agent.ts`:

```ts
export interface ConversationOptions {
  // existing fields
  planning?: PlanManager;
}

export type ConversationEvent =
  | { type: "status"; text: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_activity"; event: ToolActivityEvent }
  | { type: "plan_activity"; plan: TaskPlan }
  | { type: "fallback"; text: string }
  | { type: "segment_end" }
  | { type: "done"; content: string };
```

Pass `planning` into `createTools`.

- [ ] **Step 5: Implement the one legal mid-turn Session refresh**

Immediately after a successful `create_plan` execution, parse the tool result.
If `ok === true` and it includes a plan:

```ts
if (toolCall.name === "create_plan") {
  const current = session.getCurrent();
  if (
    expectedSession.id === undefined &&
    current.id === resultPayload.plan.sessionId &&
    current.revision === 1
  ) {
    expectedSession = sessionIdentity(current);
  } else if (!hasSameSessionIdentity(current, expectedSession)) {
    throw new Error(SESSION_CHANGED_MESSAGE);
  }
}
```

Then emit `{ type: "plan_activity", plan }`. For `update_plan` and
`finish_plan`, Session identity must remain unchanged and their successful
result also emits `plan_activity`. Never trust failed tool output as a plan
event. Planning tools do not emit the generic `tool_activity` start/end pair:
their persisted `plan_activity` is the sole progress source. All other tools
retain the existing tool activity lifecycle.

- [ ] **Step 6: Implement HITL fixture behavior**

Add a deterministic scenario where the model starts a step, calls
`block_step`, asks one question, and ends the turn. On the user's next message,
the model calls `resume_step` before other execution tools. Assert the plan is
blocked after turn one and active after resume.

- [ ] **Step 7: Verify Task 6**

Run:

```bash
node --import tsx --test test/agent.test.ts
npm run check
```

Expected: all Agent tests PASS; simple tasks remain plan-free; interrupted plan
creation is visible through the persisted Session.

---

### Task 7: `/plan` parsing and stable plan rendering

**Files:**

- Create: `src/planning/render.ts`
- Create: `test/planning-render.test.ts`
- Modify: `src/commands.ts`
- Modify: `test/commands.test.ts`

- [ ] **Step 1: Write failing command tests**

In `test/commands.test.ts`, assert:

```ts
assert.equal(resolveCommandInput("/plan").type, "known");
assert.equal(resolveCommandInput("/plan cancel").type, "known");
assert.deepEqual(
  getCommandSuggestions("/p").map(({ name }) => name),
  ["/plan"],
);
assert.deepEqual(resolveCommandInput("/paln"), {
  type: "suggestion",
  unknown: "/paln",
  suggestedInput: "/plan",
});
```

- [ ] **Step 2: Register `/plan`**

Add `"/plan"` to `CommandDefinition["name"]`, insert:

```ts
{
  name: "/plan",
  description: "查看或取消当前任务计划",
  acceptsArguments: true,
},
```

Place it after `/delete` and before `/like`. Keep generic resolution local so
`/plan anything` is known and later rejected by the plan-command parser rather
than sent to the model.

- [ ] **Step 3: Write failing render tests**

Create `test/planning-render.test.ts`:

```ts
test("renders no-plan and active-plan views", () => {
  assert.equal(renderPlan(undefined, false), "当前会话还没有任务计划。");
  assert.equal(
    renderPlan(activePlan, false),
    [
      "计划：修复类型错误并通过测试",
      "状态：进行中 · 1/4",
      "",
      "✓ 1. 定位类型错误",
      "◐ 2. 修改相关代码",
      "○ 3. 运行测试",
      "○ 4. 汇总结果",
    ].join("\n"),
  );
});

test("renders blocked, failed, completed, superseded and cancelled distinctly", () => {
  assert.match(renderPlan(blockedPlan, false), /暂停|阻塞原因/);
  assert.match(renderPlan(failedPlan, false), /✗/);
  assert.match(renderPlan(supersededPlan, false), /↷/);
  assert.match(renderPlan(completedPlan, false), /已完成/);
  assert.match(renderPlan(cancelledPlan, false), /已取消/);
});
```

Include terminal control characters in goal/title/result and assert they are
removed through `sanitizeTerminalText`.

- [ ] **Step 4: Implement pure command parsing and rendering**

In `src/planning/render.ts`, export:

```ts
export type PlanCommand =
  | { readonly type: "show" }
  | { readonly type: "cancel" }
  | { readonly type: "invalid" };

export function parsePlanCommand(input: string): PlanCommand;
export function renderPlan(
  plan: TaskPlan | undefined,
  useColor: boolean,
): string;
```

Only exact `/plan` and `/plan cancel` are valid. Render counts
`completed + superseded` as resolved but use `↷` for superseded. Use stable
markers `✓`, `◐`, `○`, `Ⅱ`, `✗`, and `↷`. Sanitize every untrusted string at
the render boundary and use existing `styleText` roles for optional color.

- [ ] **Step 5: Verify Task 7**

Run:

```bash
node --import tsx --test \
  test/commands.test.ts \
  test/planning-render.test.ts
npm run check
```

Expected: all focused tests PASS and `/pl`, `/paln`, or `/plans` never reach
the model.

---

### Task 8: Single-line progress renderer and CLI integration

**Files:**

- Modify: `src/planning/render.ts`
- Modify: `test/planning-render.test.ts`
- Modify: `src/activity-indicator.ts`
- Modify: `test/activity-indicator.test.ts`
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/streaming-fetch.mjs`

- [ ] **Step 1: Write failing TTY progress tests**

In `test/planning-render.test.ts`, inject fake output, clock, and timer:

```ts
test("redraws only the current TTY line and fixes completed steps once", () => {
  const writes: string[] = [];
  const renderer = createPlanProgressRenderer({
    output: { write: (chunk) => writes.push(String(chunk)) },
    isTTY: true,
    useColor: false,
    getAnimation: () => "americano",
    now: () => 2_400,
    startTimer: (callback) => {
      callback();
      return {};
    },
    stopTimer: () => undefined,
  });
  renderer.handle(activePlan);
  renderer.handle(completedFirstStepPlan);
  renderer.pause();
  renderer.dispose();
  const text = writes.join("");
  assert.match(text, /1\/4/);
  assert.match(text, /\[███/);
  assert.equal((text.match(/✓ 1\/4/g) ?? []).length, 1);
  assert.equal(text.includes("\u001b[8A"), false);
  assert.match(text, /\u001b\\[2K/);
});
```

Add non-TTY assertions that no `\u001b[` cursor sequence appears and each
meaningful state transition is appended once. Add americano/latte icon or
color assertions and an output-throw test proving renderer failure is swallowed.

- [ ] **Step 2: Implement `PlanProgressRenderer`**

Add to `src/planning/render.ts`:

```ts
export interface PlanProgressRenderer {
  handle(plan: TaskPlan): void;
  pause(): void;
  dispose(): void;
}

export function createPlanProgressRenderer(options: {
  readonly output: { write(chunk: string): unknown };
  readonly isTTY: boolean | undefined;
  readonly useColor: boolean;
  readonly getAnimation: () => CoffeeAnimation;
  readonly now?: () => number;
  readonly startTimer?: (
    callback: () => void,
    delay: number,
  ) => { unref?: () => void };
  readonly stopTimer?: (timer: { unref?: () => void }) => void;
}): PlanProgressRenderer;
```

Maintain `lastPlanRevision`, the last emitted status per step, one active timer,
and one current dynamic line. TTY frames cycle through `◐ ◓ ◑ ◒` every 140 ms,
use `\r` plus clear-line only, and show:

```text
☕ 2/4 [█████░░░░░] 50% ◐ 正在修改代码 · 2.4s
```

Non-TTY emits stable lines only. On completed/failed/blocked/superseded states,
clear the dynamic line and emit one final line. Wrap all drawing in a
best-effort boundary that stops the timer and never changes plan data.

- [ ] **Step 3: Preserve the existing activity pause contract**

In `test/activity-indicator.test.ts`, add a regression that `pause()` clears
the active tool animation, restores the cursor, and makes a later success/error
event produce one completion line. Only change `src/activity-indicator.ts` if
this test exposes a lifecycle bug; do not merge plan rendering into the large
coffee-cup tool animation.

- [ ] **Step 4: Construct PlanManager and both renderers in CLI**

In `src/cli.ts`, after `SessionManager` creation:

```ts
const planManager = createPlanManager({
  store: historyStore.plans,
  session: sessionManager,
});
```

Pass `planning: planManager` to `createConversation`. Create one
`PlanProgressRenderer` using the same `output`, TTY/color settings, and
`getAnimation: () => animation`.

- [ ] **Step 5: Handle `/plan` and `/plan cancel` locally**

Inside the known-command branch:

```ts
if (resolution.command.name === "/plan") {
  const command = parsePlanCommand(resolution.input);
  if (command.type === "invalid") {
    console.error(styleText(
      "用法：/plan 或 /plan cancel",
      "error",
      useColor,
    ));
    continue;
  }
  if (command.type === "cancel") {
    const current = planManager.getCurrentPlan();
    if (!current) {
      console.log("当前会话还没有任务计划。");
      continue;
    }
    if (current.status === "completed") {
      console.log("当前计划已经完成，无法取消。");
      continue;
    }
    if (current.status === "cancelled") {
      console.log("当前计划已经取消。");
      continue;
    }
    planManager.cancelCurrent(abortController.signal);
    console.log("✓ 当前计划已取消。");
    continue;
  }
  console.log(renderPlan(planManager.getCurrentPlan(), useColor));
  continue;
}
```

The CLI reads commands only between model turns, so do not add concurrent input
or a second readline loop.

- [ ] **Step 6: Coordinate plan progress with streaming and tools**

In the Conversation event loop:

- on `plan_activity`, finish the markdown segment, pause the tool activity, and
  call `planProgressRenderer.handle(event.plan)`;
- before `text_delta`, `fallback`, `status`, Shell/HITL confirmation, or normal
  error output, call `planProgressRenderer.pause()`;
- before non-Planning tool activity, pause plan progress and let the existing
  ActivityRenderer own the terminal;
- after a plan update, do not separately print generic
  `工具执行已经完成`, preventing duplicate Planning copy;
- dispose the plan renderer in SIGINT and outer cleanup next to the existing
  activity and streaming renderers.

- [ ] **Step 7: Add deterministic CLI scenarios**

Extend `test/streaming-fetch.mjs` with environment-selected fixtures for:

- active plan creation and two progress updates;
- blocked plan followed by assistant question;
- plan completion;
- plan creation followed by a hanging request for SIGINT.

In `test/cli.test.ts`, assert:

- `/plan` shows active, blocked, completed, cancelled, and no-plan views;
- `/plan cancel` changes only the plan;
- switching Session restores that Session's plan;
- `/new` starts with no plan;
- changing model leaves the plan intact;
- SIGINT exits 0 without readline stack text or cursor residue;
- the same step sentence is not repeated;
- non-TTY output contains no cursor movement escape sequences.

- [ ] **Step 8: Verify Task 8**

Run:

```bash
node --import tsx --test \
  test/planning-render.test.ts \
  test/activity-indicator.test.ts \
  test/cli.test.ts
npm run check
```

Expected: all focused tests PASS; TTY uses one dynamic line and non-TTY is
append-only.

---

### Task 9: Lifecycle, corruption, and full regression coverage

**Files:**

- Modify: `test/planning-state.test.ts`
- Modify: `test/planning-store.test.ts`
- Modify: `test/planning-manager.test.ts`
- Modify: `test/planning-tools.test.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add a requirement-matrix regression test set**

Ensure focused tests explicitly cover all of these cases with named tests:

```text
state:
  2/12 step bounds; text/id/dependency bounds; duplicate/unknown/self/cycle;
  every allowed transition; every forbidden transition; one in-progress step;
  retry 0..3; superseded replacement; finish requirements; hostile JSON input.

sqlite/store:
  new V2; real V1 migration; failed migration rollback; one plan per Session;
  zero-turn materialization; terminal replacement; cascade; corruption;
  revision conflict across two connections; permissions; close.

tools/agent:
  three schemas and write risk; all seven update actions; AbortSignal;
  simple answer without plan; complex task with plan; Shell success/failure;
  block/question/resume; controlled identity refresh; unrelated identity conflict.

cli:
  all /plan states; cancel state matrix; Session/model lifecycle; TTY/non-TTY;
  tool/HITL/text pause; both coffee preferences; renderer failure; Ctrl+C;
  no duplicated sentence, readline stack, cursor residue, or temp artifacts.
```

Each test must use local fixtures and temporary SQLite paths. No test may call
a real model, Tavily, IPWho, package registry, or external network.

- [ ] **Step 2: Add a Shell-failure planning assertion**

In `test/agent.test.ts`, return a Shell result with `ok: false` or non-zero
`exitCode`; the next model tool call must be `fail_step` or `block_step`, not
`complete_step`. Assert the persisted step status matches the tool call.

- [ ] **Step 3: Add terminal-plan replacement and deletion E2E**

In `test/cli.test.ts`:

1. complete a plan;
2. create another plan in the same Session and assert the old steps are gone;
3. delete the Session;
4. inspect SQLite and assert no plan/step rows remain.

- [ ] **Step 4: Document the user-facing feature**

Add a concise `README.md` section:

```markdown
## 结构化任务规划

Coffee 会让模型为多文件修改、多个工具协作、需要测试验证或存在步骤依赖的
复杂任务先创建计划。简单问答、翻译、单次读取和单步计算不会强制创建计划。

- `/plan`：查看当前会话的目标、状态和步骤。
- `/plan cancel`：取消 active 或 blocked 计划，不删除对话历史。
- 计划随 Session 保存在 SQLite；`/new` 使用新计划空间，`/sessions`
  会恢复所选会话的计划。
- 遇到关键歧义、高风险确认、重大重规划或重试耗尽时，计划会进入 blocked，
  Coffee 会先询问用户，再在下一轮恢复。
- `Ctrl+C` 会退出当前运行，但已经提交的计划状态会保留。

V1 不包含后台任务、自动调度、自动重试、并行步骤、上层自治 Loop 或 RAG。
```

- [ ] **Step 5: Run the full test suite**

Run:

```bash
npm test
```

Expected: every test passes, zero skipped tests, no uncaught rejection, no
readline stack, and no real network request.

- [ ] **Step 6: Run the full type check**

Run:

```bash
npm run check
```

Expected: TypeScript exits 0 with no diagnostics.

- [ ] **Step 7: Verify no test artifacts remain**

Run:

```bash
find . -maxdepth 3 \
  \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' \
     -o -name '*.pid' -o -name '*.marker' \) -print
```

Expected: no output except files intentionally tracked by the user before this
implementation. Do not delete unrelated existing files.

- [ ] **Step 8: Audit the implementation against the scope boundary**

Run:

```bash
rg -n "RAG|background|parallel step|auto.?retry|scheduler|autonomous loop" \
  src test README.md
```

Expected: matches appear only in explicit limitation/documentation text or
test descriptions; production code does not claim those later-stage features.

---

## Execution checkpoints

Execute tasks in order. After each task, run its focused test command and
`npm run check`; do not continue on a red checkpoint. Tasks 1–4 establish the
trusted state/persistence core, Tasks 5–6 connect models, Tasks 7–8 connect the
CLI, and Task 9 proves the complete behavior.

Because the directory is not a Git repository, preserve the user's unrelated
files and edits manually: inspect the touched files before patching, make
surgical changes only, and never use destructive Git or filesystem cleanup
commands.
