import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import Database from "better-sqlite3";

import {
  createHistoryStore,
  type HistoryStore,
} from "../src/history/store.js";
import {
  applyPlanAction,
  finishTaskPlan,
  restoreTaskPlan,
} from "../src/planning/state.js";
import { withHistoryPath } from "./history-fixture.js";

const NOW = "2026-07-27T10:00:00.000Z";
const LATER = "2026-07-27T11:00:00.000Z";

function planInput(id = "plan-1") {
  return {
    id,
    goal: "完成结构化任务",
    now: NOW,
    steps: [
      {
        id: "inspect",
        title: "检查现状",
        successCriteria: "现状已经确认",
        dependsOn: [],
      },
      {
        id: "implement",
        title: "完成实现",
        successCriteria: "测试全部通过",
        dependsOn: ["inspect"],
      },
    ],
  };
}

function createSession(store: HistoryStore, title = "已有会话") {
  return store.commitTurn({
    title,
    providerId: "deepseek",
    modelId: "deepseek-v4",
    messages: [{ role: "user", content: "开始任务" }],
  });
}

function assertSanitizedError(
  error: unknown,
  message: RegExp,
  secret: string,
): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, message);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(error.message, new RegExp(secret.slice(0, 40)));
  assert.doesNotMatch(String(error), new RegExp(secret.slice(0, 40)));
  assert.doesNotMatch(inspect(error), new RegExp(secret.slice(0, 40)));
  return true;
}

async function expectCorruptedPlan(
  corrupt: (database: Database.Database, planId: string) => void,
): Promise<void> {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const plan = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput(),
      }).plan;
      const raw = new Database(databasePath);
      try {
        raw.pragma("ignore_check_constraints = ON");
        corrupt(raw, plan.id);
      } finally {
        raw.close();
      }

      assert.throws(
        () => store.plans.loadForSession(session.id),
        (error: unknown) =>
          assertSanitizedError(
            error,
            /计划数据损坏|读取失败/,
            "TOP_SECRET_CORRUPT_PLAN_1942",
          ),
      );
    } finally {
      store.close();
    }
  });
}

test("creates and loads a plan for an existing session without changing its revision", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const created = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: session.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput(),
      });

      assert.equal(created.materializedSession, undefined);
      assert.equal(created.plan.sessionId, session.id);
      assert.equal(created.plan.revision, 1);
      assert.deepEqual(store.plans.loadForSession(session.id), created.plan);
      assert.equal(store.loadSession(session.id)?.revision, session.revision);
      assert.equal(store.getActiveSessionId(), session.id);
      assert.ok(Object.isFrozen(created.plan));
      assert.ok(Object.isFrozen(created.plan.steps));
    } finally {
      store.close();
    }
  });
});

test("atomically materializes a zero-turn session with its plan", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const created = store.plans.create({
        session: {
          kind: "new",
          title: "规划会话",
          providerId: "openai",
          modelId: "gpt-next",
        },
        plan: planInput("plan-new"),
      });

      assert.ok(created.materializedSession);
      assert.equal(created.materializedSession.id, created.plan.sessionId);
      assert.deepEqual(created.materializedSession, {
        id: created.plan.sessionId,
        title: "规划会话",
        providerId: "openai",
        modelId: "gpt-next",
        revision: 1,
      });
      assert.deepEqual(store.loadSession(created.plan.sessionId)?.turns, []);
      assert.equal(store.getActiveSessionId(), created.plan.sessionId);
      assert.deepEqual(
        store.plans.loadForSession(created.plan.sessionId),
        created.plan,
      );
    } finally {
      store.close();
    }
  });
});

test("returns undefined when a session has no plan", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      assert.equal(store.plans.loadForSession(session.id), undefined);
    } finally {
      store.close();
    }
  });
});

test("rejects replacing active or blocked plans", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const active = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("active-plan"),
      }).plan;

      assert.throws(
        () =>
          store.plans.create({
            session: {
              kind: "existing",
              id: session.id,
              expectedRevision: 1,
              expectedCurrentPlan: {
                id: active.id,
                revision: active.revision,
              },
            },
            plan: planInput("replacement"),
          }),
        /已有进行中的任务计划/,
      );

      const started = applyPlanAction(
        active,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      store.plans.save(started, active.revision);
      const blocked = applyPlanAction(
        started,
        { type: "block_step", stepId: "inspect", reason: "等待授权" },
        "2026-07-27T11:10:00.000Z",
      );
      store.plans.save(blocked, started.revision);

      assert.throws(
        () =>
          store.plans.create({
            session: {
              kind: "existing",
              id: session.id,
              expectedRevision: 1,
              expectedCurrentPlan: {
                id: blocked.id,
                revision: blocked.revision,
              },
            },
            plan: planInput("replacement"),
          }),
        /已有进行中的任务计划/,
      );
    } finally {
      store.close();
    }
  });
});

test("saves complete plan snapshots with exact optimistic revisions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const initial = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput(),
      }).plan;
      const started = applyPlanAction(
        initial,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      const savedStarted = store.plans.save(started, 1);
      assert.deepEqual(savedStarted, started);
      assert.notEqual(savedStarted, started);
      assert.notEqual(savedStarted.steps, started.steps);

      const completed = applyPlanAction(
        savedStarted,
        { type: "complete_step", stepId: "inspect", result: "检查完成" },
        "2026-07-27T11:10:00.000Z",
      );
      assert.deepEqual(store.plans.save(completed, 2), completed);
      const secondStarted = applyPlanAction(
        completed,
        { type: "start_step", stepId: "implement" },
        "2026-07-27T11:20:00.000Z",
      );
      assert.deepEqual(store.plans.save(secondStarted, 3), secondStarted);
      const blocked = applyPlanAction(
        secondStarted,
        { type: "block_step", stepId: "implement", reason: "依赖不可用" },
        "2026-07-27T11:30:00.000Z",
      );
      assert.deepEqual(store.plans.save(blocked, 4), blocked);
      assert.deepEqual(store.plans.loadForSession(session.id), blocked);

      assert.throws(
        () => store.plans.save(blocked, 4),
        /其他 Coffee 进程.*\/plan.*重新查看/,
      );
    } finally {
      store.close();
    }
  });
});

test("lets only one of two history connections save the same plan revision", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const session = createSession(storeA);
      const initial = storeA.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput(),
      }).plan;
      const candidateA = applyPlanAction(
        initial,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      const candidateB = applyPlanAction(
        storeB.plans.loadForSession(session.id)!,
        { type: "start_step", stepId: "inspect" },
        "2026-07-27T11:00:01.000Z",
      );

      assert.deepEqual(storeA.plans.save(candidateA, 1), candidateA);
      assert.throws(
        () => storeB.plans.save(candidateB, 1),
        /其他 Coffee 进程/,
      );
      assert.deepEqual(storeA.plans.loadForSession(session.id), candidateA);
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("cancels active and blocked plans while preserving step history", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const activeSession = createSession(store, "active");
      const active = store.plans.create({
        session: {
          kind: "existing",
          id: activeSession.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("active-plan"),
      }).plan;
      const inProgress = applyPlanAction(
        active,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      store.plans.save(inProgress, 1);
      const cancelledActive = store.plans.cancel(
        activeSession.id,
        2,
        "2026-07-27T12:00:00.000Z",
      );
      assert.equal(cancelledActive.status, "cancelled");
      assert.equal(cancelledActive.revision, 3);
      assert.deepEqual(cancelledActive.steps[0], {
        ...inProgress.steps[0],
        status: "failed",
        result: "计划已由用户取消。",
      });
      assert.deepEqual(cancelledActive.steps[1], inProgress.steps[1]);

      const blockedSession = createSession(store, "blocked");
      const initialBlocked = store.plans.create({
        session: {
          kind: "existing",
          id: blockedSession.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("blocked-plan"),
      }).plan;
      const started = applyPlanAction(
        initialBlocked,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      store.plans.save(started, 1);
      const blocked = applyPlanAction(
        started,
        { type: "block_step", stepId: "inspect", reason: "等待输入" },
        "2026-07-27T11:30:00.000Z",
      );
      store.plans.save(blocked, 2);
      const cancelledBlocked = store.plans.cancel(
        blockedSession.id,
        3,
        "2026-07-27T12:30:00.000Z",
      );
      assert.equal(cancelledBlocked.status, "cancelled");
      assert.deepEqual(cancelledBlocked.steps[0], {
        id: blocked.steps[0]!.id,
        title: blocked.steps[0]!.title,
        successCriteria: blocked.steps[0]!.successCriteria,
        dependsOn: blocked.steps[0]!.dependsOn,
        status: "failed",
        retryCount: blocked.steps[0]!.retryCount,
        result: "计划已由用户取消。",
      });
      assert.deepEqual(
        store.plans.loadForSession(blockedSession.id),
        cancelledBlocked,
      );
    } finally {
      store.close();
    }
  });
});

test("rejects cancelling absent or terminal plans with stable messages", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const empty = createSession(store, "empty");
      assert.throws(
        () => store.plans.cancel(empty.id, 1, LATER),
        /当前会话还没有任务计划/,
      );

      const terminal = createSession(store, "terminal");
      const plan = store.plans.create({
        session: {
          kind: "existing",
          id: terminal.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("terminal-plan"),
      }).plan;
      const cancelled = store.plans.cancel(terminal.id, 1, LATER);
      assert.equal(cancelled.status, "cancelled");
      assert.throws(
        () => store.plans.cancel(terminal.id, 2, LATER),
        /终态|不能取消/,
      );
      assert.throws(
        () => store.plans.cancel(terminal.id, plan.revision, LATER),
        /终态|不能取消/,
      );
    } finally {
      store.close();
    }
  });
});

test("rejects a stale active cancellation without changing the plan", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const plan = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("stale-cancel"),
      }).plan;
      assert.throws(
        () => store.plans.cancel(session.id, plan.revision + 1, LATER),
        /其他 Coffee 进程.*\/plan.*重新查看/,
      );
      assert.deepEqual(store.plans.loadForSession(session.id), plan);
    } finally {
      store.close();
    }
  });
});

test("cancel preserves completed, failed, superseded, and pending steps", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      const initial = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("preserve-cancel"),
      }).plan;
      const mixed = restoreTaskPlan({
        ...initial,
        revision: 2,
        updatedAt: LATER,
        steps: [
          {
            id: "completed",
            title: "已完成",
            successCriteria: "完成结果存在",
            dependsOn: [],
            status: "completed",
            retryCount: 0,
            result: "原完成结果",
          },
          {
            id: "failed",
            title: "已失败",
            successCriteria: "失败历史存在",
            dependsOn: ["completed"],
            status: "failed",
            retryCount: 2,
            result: "原失败结果",
          },
          {
            id: "superseded",
            title: "已替代",
            successCriteria: "替代历史存在",
            dependsOn: [],
            status: "superseded",
            retryCount: 1,
            result: "原替代结果",
          },
          {
            id: "pending",
            title: "待执行",
            successCriteria: "仍待执行",
            dependsOn: ["completed"],
            status: "pending",
            retryCount: 0,
          },
        ],
      });
      const saved = store.plans.save(mixed, initial.revision);
      const cancelled = store.plans.cancel(
        session.id,
        saved.revision,
        "2026-07-27T12:00:00.000Z",
      );

      assert.equal(cancelled.status, "cancelled");
      assert.deepEqual(cancelled.steps, saved.steps);
    } finally {
      store.close();
    }
  });
});

test("replaces terminal plans atomically and removes their old steps", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    let sessionId = "";
    try {
      const session = createSession(store);
      sessionId = session.id;
      const old = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("old-plan"),
      }).plan;
      store.plans.cancel(session.id, old.revision, LATER);

      const replacement = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: {
            id: old.id,
            revision: old.revision + 1,
          },
        },
        plan: {
          ...planInput("new-plan"),
          steps: [
            {
              id: "new-a",
              title: "新步骤一",
              successCriteria: "一完成",
              dependsOn: [],
            },
            {
              id: "new-b",
              title: "新步骤二",
              successCriteria: "二完成",
              dependsOn: ["new-a"],
            },
          ],
        },
      }).plan;
      assert.equal(replacement.id, "new-plan");
    } finally {
      store.close();
    }

    const raw = new Database(databasePath);
    try {
      assert.equal(
        raw
          .prepare("SELECT COUNT(*) FROM task_steps WHERE plan_id = ?")
          .pluck()
          .get("old-plan"),
        0,
      );
      assert.equal(
        raw
          .prepare("SELECT id FROM task_plans WHERE session_id = ?")
          .pluck()
          .get(sessionId),
        "new-plan",
      );
    } finally {
      raw.close();
    }
  });
});

test("rejects hostile create inputs without traps or write transactions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const databasePrototype = Database.prototype as Database.Database & {
      transaction: Database.Database["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionsStarted = 0;
    let proxyTraps = 0;
    let getterReads = 0;
    const hostileSession = new Proxy(
      {
        kind: "new",
        title: "secret",
        providerId: "provider",
        modelId: "model",
      },
      {
        getOwnPropertyDescriptor(target, property) {
          proxyTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    const accessorInput = {
      session: {
        kind: "new",
        title: "safe",
        providerId: "provider",
        modelId: "model",
      },
      plan: planInput(),
    };
    Object.defineProperty(accessorInput, "plan", {
      enumerable: true,
      get() {
        getterReads += 1;
        return planInput("secret-plan");
      },
    });

    try {
      const session = createSession(store);
      const before = store.listSessions();
      databasePrototype.transaction = function patchedTransaction(
        this: Database.Database,
        operation: () => unknown,
      ) {
        transactionsStarted += 1;
        return originalTransaction.call(this, operation);
      } as Database.Database["transaction"];

      const inheritedSession = Object.create({ inherited: true }) as {
        kind: "existing";
        id: string;
        expectedRevision: number;
        expectedCurrentPlan: null;
      };
      Object.assign(inheritedSession, {
        kind: "existing",
        id: session.id,
        expectedRevision: 1,
        expectedCurrentPlan: null,
      });
      const sessionWithExtra = {
        kind: "existing",
        id: session.id,
        expectedRevision: 1,
        expectedCurrentPlan: null,
        extra: "not allowed",
      };
      const accessorSession = {
        id: session.id,
        expectedRevision: 1,
        expectedCurrentPlan: null,
      } as {
        kind: "existing";
        id: string;
        expectedRevision: number;
        expectedCurrentPlan: null;
      };
      Object.defineProperty(accessorSession, "kind", {
        enumerable: true,
        get() {
          getterReads += 1;
          return "existing";
        },
      });
      const transparentProxy = new Proxy(
        {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        {},
      );
      const sparseSteps = new Array(2);
      const planWithExtra = { ...planInput("extra-plan"), extra: true };
      const planProxy = new Proxy(planInput("proxy-plan"), {
        getOwnPropertyDescriptor(target, property) {
          proxyTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      const invalidCreates = [
        {
          session: hostileSession,
          plan: planInput("hostile-session"),
        },
        { session: inheritedSession, plan: planInput("inherited-session") },
        { session: sessionWithExtra, plan: planInput("extra-session") },
        { session: accessorSession, plan: planInput("accessor-session") },
        { session: transparentProxy, plan: planInput("transparent-proxy") },
        {
          session: {
            kind: "existing",
            id: session.id,
            expectedRevision: 1,
            expectedCurrentPlan: null,
          },
          plan: { ...planInput("sparse-plan"), steps: sparseSteps },
        },
        {
          session: {
            kind: "existing",
            id: session.id,
            expectedRevision: 1,
            expectedCurrentPlan: null,
          },
          plan: planWithExtra,
        },
        {
          session: {
            kind: "existing",
            id: session.id,
            expectedRevision: 1,
            expectedCurrentPlan: null,
          },
          plan: planProxy,
        },
        accessorInput,
      ];
      for (const invalid of invalidCreates) {
        assert.throws(
          () => store.plans.create(invalid as never),
          /安全读取|Proxy|普通|密集数组|额外字段|原型/,
        );
      }
      assert.equal(proxyTraps, 0);
      assert.equal(getterReads, 0);
      assert.equal(transactionsStarted, 0);
      databasePrototype.transaction = originalTransaction;
      assert.deepEqual(store.listSessions(), before);
    } finally {
      databasePrototype.transaction = originalTransaction;
      store.close();
    }
  });
});

test("rejects long strings and cancel overflow before opening transactions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const databasePrototype = Database.prototype as Database.Database & {
      transaction: Database.Database["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionsStarted = 0;
    try {
      const session = createSession(store);
      store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput(),
      });
      const before = store.plans.loadForSession(session.id);
      databasePrototype.transaction = function patchedTransaction(
        this: Database.Database,
        operation: () => unknown,
      ) {
        transactionsStarted += 1;
        return originalTransaction.call(this, operation);
      } as Database.Database["transaction"];
      assert.throws(
        () => store.plans.cancel(session.id, 1, "x".repeat(1001)),
        /长度/,
      );
      assert.throws(
        () => store.plans.loadForSession("会".repeat(1001)),
        /长度/,
      );
      assert.throws(
        () => store.plans.cancel("会".repeat(1001), 1, LATER),
        /长度/,
      );
      assert.throws(
        () =>
          store.plans.cancel(
            session.id,
            Number.MAX_SAFE_INTEGER,
            LATER,
          ),
        /revision.*无法继续增加/,
      );
      assert.equal(transactionsStarted, 0);
      databasePrototype.transaction = originalTransaction;
      assert.deepEqual(store.plans.loadForSession(session.id), before);
    } finally {
      databasePrototype.transaction = originalTransaction;
      store.close();
    }
  });
});

test("rejects long create session fields before opening write transactions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const databasePrototype = Database.prototype as Database.Database & {
      transaction: Database.Database["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionsStarted = 0;
    try {
      const existing = createSession(store);
      const before = store.listSessions();
      databasePrototype.transaction = function patchedTransaction(
        this: Database.Database,
        operation: () => unknown,
      ) {
        transactionsStarted += 1;
        return originalTransaction.call(this, operation);
      } as Database.Database["transaction"];
      const long = "密".repeat(1001);
      const invalidSessions = [
        {
          kind: "existing",
          id: long,
          expectedRevision: existing.revision,
          expectedCurrentPlan: null,
        },
        {
          kind: "new",
          title: long,
          providerId: "provider",
          modelId: "model",
        },
        {
          kind: "new",
          title: "title",
          providerId: long,
          modelId: "model",
        },
        {
          kind: "new",
          title: "title",
          providerId: "provider",
          modelId: long,
        },
      ];
      for (const session of invalidSessions) {
        assert.throws(
          () =>
            store.plans.create({
              session: session as never,
              plan: planInput("bounded-plan"),
            }),
          /长度.*1000/,
        );
      }
      assert.equal(transactionsStarted, 0);
      databasePrototype.transaction = originalTransaction;
      assert.deepEqual(store.listSessions(), before);
    } finally {
      databasePrototype.transaction = originalTransaction;
      store.close();
    }
  });
});

test("rejects hostile save plans without traps or write transactions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const databasePrototype = Database.prototype as Database.Database & {
      transaction: Database.Database["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionsStarted = 0;
    let proxyTraps = 0;
    let getterReads = 0;
    try {
      const session = createSession(store);
      const plan = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("save-hostile"),
      }).plan;
      const candidate = applyPlanAction(
        plan,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      const proxy = new Proxy(candidate, {
        getOwnPropertyDescriptor(target, property) {
          proxyTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      });
      const accessor = { ...candidate } as Record<string, unknown>;
      Object.defineProperty(accessor, "id", {
        enumerable: true,
        get() {
          getterReads += 1;
          return candidate.id;
        },
      });
      const extra = { ...candidate, extra: "not allowed" };
      const sparse = {
        ...candidate,
        steps: new Array(candidate.steps.length),
      };
      databasePrototype.transaction = function patchedTransaction(
        this: Database.Database,
        operation: () => unknown,
      ) {
        transactionsStarted += 1;
        return originalTransaction.call(this, operation);
      } as Database.Database["transaction"];

      for (const hostile of [proxy, accessor, extra, sparse]) {
        assert.throws(
          () => store.plans.save(hostile as never, plan.revision),
          /Proxy|安全读取|数据属性|额外字段|密集数组/,
        );
      }
      assert.equal(proxyTraps, 0);
      assert.equal(getterReads, 0);
      assert.equal(transactionsStarted, 0);
      databasePrototype.transaction = originalTransaction;
      assert.deepEqual(store.plans.loadForSession(session.id), plan);
    } finally {
      databasePrototype.transaction = originalTransaction;
      store.close();
    }
  });
});

test("sanitizes unexpected database read errors without a public cause", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const probe = new Database(":memory:");
    const statementPrototype = Object.getPrototypeOf(
      probe.prepare("SELECT 1"),
    ) as {
      get: (this: { source: string }, ...params: unknown[]) => unknown;
    };
    probe.close();
    const originalGet = statementPrototype.get;
    const secret = `TOP_SECRET_READ_1942_${"x".repeat(4000)}`;
    try {
      const session = createSession(store);
      statementPrototype.get = function patchedGet(...params: unknown[]) {
        if (this.source.includes("FROM task_plans WHERE session_id = ?")) {
          throw new Error(secret);
        }
        return originalGet.apply(this, params);
      };
      assert.throws(
        () => store.plans.loadForSession(session.id),
        (error: unknown) =>
          assertSanitizedError(error, /计划数据损坏|读取失败/, secret),
      );
    } finally {
      statementPrototype.get = originalGet;
      store.close();
    }
  });
});

test("rejects corrupted plan rows without exposing persisted values", async () => {
  const corruptions: Array<
    (database: Database.Database, planId: string) => void
  > = [
    (database, planId) => {
      database
        .prepare(
          "UPDATE task_steps SET depends_on_json = ? " +
            "WHERE plan_id = ? AND position = 1",
        )
        .run('["TOP_SECRET_CORRUPT_PLAN_1942"', planId);
    },
    (database, planId) => {
      database
        .prepare(
          "UPDATE task_steps SET position = 3 " +
            "WHERE plan_id = ? AND position = 2",
        )
        .run(planId);
    },
    (database, planId) => {
      database
        .prepare("UPDATE task_plans SET status = ? WHERE id = ?")
        .run("TOP_SECRET_CORRUPT_PLAN_1942", planId);
    },
    (database, planId) => {
      database
        .prepare(
          "UPDATE task_steps SET retry_count = 99 " +
            "WHERE plan_id = ? AND position = 1",
        )
        .run(planId);
    },
    (database, planId) => {
      database
        .prepare(
          "UPDATE task_steps SET result = ? " +
            "WHERE plan_id = ? AND position = 1",
        )
        .run("TOP_SECRET_CORRUPT_PLAN_1942", planId);
    },
    (database, planId) => {
      database
        .prepare(
          "UPDATE task_steps SET block_reason = ? " +
            "WHERE plan_id = ? AND position = 1",
        )
        .run("TOP_SECRET_CORRUPT_PLAN_1942", planId);
    },
  ];

  for (const corrupt of corruptions) {
    await expectCorruptedPlan(corrupt);
  }
});

test("deleting a history session cascades to its plan and steps", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    let planId = "";
    try {
      const session = createSession(store);
      planId = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("cascade-plan"),
      }).plan.id;
      store.deleteSession(session.id, 1);
      assert.equal(store.plans.loadForSession(session.id), undefined);
    } finally {
      store.close();
    }

    const raw = new Database(databasePath);
    try {
      assert.equal(
        raw
          .prepare("SELECT COUNT(*) FROM task_plans WHERE id = ?")
          .pluck()
          .get(planId),
        0,
      );
      assert.equal(
        raw
          .prepare("SELECT COUNT(*) FROM task_steps WHERE plan_id = ?")
          .pluck()
          .get(planId),
        0,
      );
    } finally {
      raw.close();
    }
  });
});

test("rolls back new sessions, terminal replacement, and saves after a step insert failure", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const terminalSession = createSession(store, "terminal");
      const terminal = store.plans.create({
        session: {
          kind: "existing",
          id: terminalSession.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("terminal-old"),
      }).plan;
      const cancelled = store.plans.cancel(
        terminalSession.id,
        terminal.revision,
        LATER,
      );

      const activeSession = createSession(store, "active");
      const active = store.plans.create({
        session: {
          kind: "existing",
          id: activeSession.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("active-old"),
      }).plan;

      const raw = new Database(databasePath);
      try {
        raw.exec(`
          CREATE TRIGGER fail_second_task_step
          BEFORE INSERT ON task_steps
          WHEN NEW.position = 2
          BEGIN
            SELECT RAISE(ABORT, 'TOP_SECRET_TRIGGER_1942');
          END;
        `);
      } finally {
        raw.close();
      }

      store.setActiveSessionId(undefined);
      assert.throws(
        () =>
          store.plans.create({
            session: {
              kind: "new",
              title: "失败新会话",
              providerId: "provider",
              modelId: "model",
            },
            plan: planInput("new-fails"),
          }),
        (error: unknown) =>
          assertSanitizedError(
            error,
            /创建计划失败/,
            "TOP_SECRET_TRIGGER_1942",
          ),
      );
      assert.equal(store.listSessions().length, 2);

      store.setActiveSessionId(terminalSession.id);
      assert.throws(
        () =>
          store.plans.create({
            session: {
              kind: "existing",
              id: terminalSession.id,
              expectedRevision: 1,
              expectedCurrentPlan: {
                id: cancelled.id,
                revision: cancelled.revision,
              },
            },
            plan: planInput("replacement-fails"),
          }),
        /创建计划失败/,
      );
      assert.deepEqual(
        store.plans.loadForSession(terminalSession.id),
        cancelled,
      );

      const started = applyPlanAction(
        active,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      store.setActiveSessionId(activeSession.id);
      assert.throws(
        () => store.plans.save(started, active.revision),
        /保存计划失败/,
      );
      assert.deepEqual(store.plans.loadForSession(activeSession.id), active);
    } finally {
      store.close();
    }
  });
});

test("replaces a completed plan after persisting its terminal state", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSession(store);
      let plan = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: null,
        },
        plan: planInput("completed-old"),
      }).plan;
      plan = applyPlanAction(
        plan,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      plan = store.plans.save(plan, 1);
      plan = applyPlanAction(
        plan,
        { type: "complete_step", stepId: "inspect", result: "完成" },
        "2026-07-27T11:10:00.000Z",
      );
      plan = store.plans.save(plan, 2);
      plan = applyPlanAction(
        plan,
        { type: "start_step", stepId: "implement" },
        "2026-07-27T11:20:00.000Z",
      );
      plan = store.plans.save(plan, 3);
      plan = applyPlanAction(
        plan,
        { type: "complete_step", stepId: "implement", result: "完成" },
        "2026-07-27T11:30:00.000Z",
      );
      plan = store.plans.save(plan, 4);
      plan = finishTaskPlan(plan, "全部完成", "2026-07-27T11:40:00.000Z");
      plan = store.plans.save(plan, 5);
      assert.equal(plan.status, "completed");
      assert.throws(
        () => store.plans.cancel(session.id, plan.revision, LATER),
        /终态|不能取消/,
      );
      assert.deepEqual(store.plans.loadForSession(session.id), plan);

      const replacement = store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: 1,
          expectedCurrentPlan: {
            id: plan.id,
            revision: plan.revision,
          },
        },
        plan: planInput("after-completed"),
      }).plan;
      assert.equal(replacement.id, "after-completed");
      assert.equal(replacement.revision, 1);
    } finally {
      store.close();
    }
  });
});

test("rejects a stale terminal identity without deleting the newer replacement", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const session = createSession(storeA);
      const first = storeA.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: session.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput("race-p1"),
      }).plan;
      const terminalFirst = storeA.plans.cancel(
        session.id,
        first.revision,
        LATER,
      );
      const second = storeB.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: session.revision,
          expectedCurrentPlan: {
            id: terminalFirst.id,
            revision: terminalFirst.revision,
          },
        },
        plan: planInput("race-p2"),
      }).plan;
      const terminalSecond = storeB.plans.cancel(
        session.id,
        second.revision,
        "2026-07-27T12:00:00.000Z",
      );

      assert.throws(
        () =>
          storeA.plans.create({
            session: {
              kind: "existing",
              id: session.id,
              expectedRevision: session.revision,
              expectedCurrentPlan: {
                id: terminalFirst.id,
                revision: terminalFirst.revision,
              },
            },
            plan: planInput("race-p3"),
          }),
        /其他 Coffee 进程.*\/plan.*重新查看/,
      );
      assert.deepEqual(
        storeA.plans.loadForSession(session.id),
        terminalSecond,
      );
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("expected null conflicts with a concurrently created plan", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const session = createSession(storeA);
      const concurrent = storeB.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: session.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput("concurrent-plan"),
      }).plan;

      assert.throws(
        () =>
          storeA.plans.create({
            session: {
              kind: "existing",
              id: session.id,
              expectedRevision: session.revision,
              expectedCurrentPlan: null,
            },
            plan: planInput("must-not-replace"),
          }),
        /其他 Coffee 进程.*\/plan.*重新查看/,
      );
      assert.deepEqual(storeA.plans.loadForSession(session.id), concurrent);
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("rejects hostile expectedCurrentPlan before opening a transaction", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const databasePrototype = Database.prototype as Database.Database & {
      transaction: Database.Database["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionsStarted = 0;
    let proxyTraps = 0;
    let getterReads = 0;
    try {
      const session = createSession(store);
      const hostileProxy = new Proxy(
        { id: "old-plan", revision: 1 },
        {
          getOwnPropertyDescriptor(target, property) {
            proxyTraps += 1;
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );
      const accessor = { revision: 1 } as {
        id: string;
        revision: number;
      };
      Object.defineProperty(accessor, "id", {
        enumerable: true,
        get() {
          getterReads += 1;
          return "old-plan";
        },
      });
      databasePrototype.transaction = function patchedTransaction(
        this: Database.Database,
        operation: () => unknown,
      ) {
        transactionsStarted += 1;
        return originalTransaction.call(this, operation);
      } as Database.Database["transaction"];

      for (const expectedCurrentPlan of [
        hostileProxy,
        accessor,
        { id: "old-plan", revision: 1, extra: true },
        { id: "旧".repeat(1001), revision: 1 },
        { id: "old-plan", revision: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        assert.throws(
          () =>
            store.plans.create({
              session: {
                kind: "existing",
                id: session.id,
                expectedRevision: session.revision,
                expectedCurrentPlan,
              },
              plan: planInput("hostile-current"),
            } as never),
          /安全读取|额外字段|长度|安全整数|正整数/,
        );
      }
      assert.throws(
        () =>
          store.plans.create({
            session: {
              kind: "new",
              title: "new",
              providerId: "provider",
              modelId: "model",
              expectedCurrentPlan: null,
            },
            plan: planInput("new-extra-current"),
          } as never),
        /安全读取|额外字段/,
      );
      assert.equal(proxyTraps, 0);
      assert.equal(getterReads, 0);
      assert.equal(transactionsStarted, 0);
    } finally {
      databasePrototype.transaction = originalTransaction;
      store.close();
    }
  });
});

test("new and existing plan creation require the observed active session", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const subject = createSession(storeA, "subject");
      const subjectBefore = storeA.loadSession(subject.id);

      assert.throws(
        () =>
          storeA.plans.create({
            session: {
              kind: "new",
              title: "must-not-create",
              providerId: "provider",
              modelId: "model",
            },
            plan: planInput("inactive-new"),
          }),
        /当前会话已发生变化.*重试/,
      );
      assert.deepEqual(storeA.loadSession(subject.id), subjectBefore);
      assert.deepEqual(
        storeA.listSessions().map(({ id }) => id),
        [subject.id],
      );

      storeB.setActiveSessionId(undefined);
      const materialized = storeA.plans.create({
        session: {
          kind: "new",
          title: "allowed-new",
          providerId: "provider",
          modelId: "model",
        },
        plan: planInput("active-new"),
      });
      assert.ok(materialized.materializedSession);

      storeB.setActiveSessionId(subject.id);
      const other = createSession(storeB, "other");
      const otherBefore = storeB.loadSession(other.id);
      assert.throws(
        () =>
          storeA.plans.create({
            session: {
              kind: "existing",
              id: subject.id,
              expectedRevision: subject.revision,
              expectedCurrentPlan: null,
            },
            plan: planInput("inactive-existing"),
          }),
        /当前会话已发生变化.*重试/,
      );
      assert.equal(storeA.plans.loadForSession(subject.id), undefined);
      assert.deepEqual(storeB.loadSession(other.id), otherBefore);

      storeB.setActiveSessionId(subject.id);
      const created = storeA.plans.create({
        session: {
          kind: "existing",
          id: subject.id,
          expectedRevision: subject.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput("active-existing"),
      });
      assert.equal(created.plan.sessionId, subject.id);
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("save rechecks active session after a synchronous wrapper switch", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const subject = createSession(storeA, "subject");
      const plan = storeA.plans.create({
        session: {
          kind: "existing",
          id: subject.id,
          expectedRevision: subject.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput("switch-save"),
      }).plan;
      const other = createSession(storeB, "other");
      const otherBefore = storeB.loadSession(other.id);
      const candidate = applyPlanAction(
        plan,
        { type: "start_step", stepId: "inspect" },
        LATER,
      );
      storeB.setActiveSessionId(subject.id);

      const saveAfterSwitch = () => {
        storeB.setActiveSessionId(other.id);
        return storeA.plans.save(candidate, plan.revision);
      };
      assert.throws(saveAfterSwitch, /当前会话已发生变化.*重试/);
      assert.deepEqual(storeA.plans.loadForSession(subject.id), plan);
      assert.deepEqual(storeB.loadSession(other.id), otherBefore);

      storeB.setActiveSessionId(subject.id);
      assert.deepEqual(
        storeA.plans.save(candidate, plan.revision),
        candidate,
      );
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("cancel rechecks active session and succeeds after active is restored", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const subject = createSession(storeA, "subject");
      const plan = storeA.plans.create({
        session: {
          kind: "existing",
          id: subject.id,
          expectedRevision: subject.revision,
          expectedCurrentPlan: null,
        },
        plan: planInput("switch-cancel"),
      }).plan;
      const other = createSession(storeB, "other");
      const otherBefore = storeB.loadSession(other.id);

      assert.throws(
        () => storeA.plans.cancel(subject.id, plan.revision, LATER),
        /当前会话已发生变化.*重试/,
      );
      assert.deepEqual(storeA.plans.loadForSession(subject.id), plan);
      assert.deepEqual(storeB.loadSession(other.id), otherBefore);

      storeB.setActiveSessionId(subject.id);
      const cancelled = storeA.plans.cancel(
        subject.id,
        plan.revision,
        LATER,
      );
      assert.equal(cancelled.status, "cancelled");
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});
