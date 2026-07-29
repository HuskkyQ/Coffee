import assert from "node:assert/strict";
import test from "node:test";

import {
  createSessionManager,
  type SessionManager,
} from "../src/history/session-manager.js";
import {
  createHistoryStore,
  type HistoryStore,
} from "../src/history/store.js";
import { CREDENTIALS, PROVIDERS } from "../src/models/catalog.js";
import { createModelRegistry } from "../src/models/registry.js";
import {
  createPlanManager,
  type PlanManager,
} from "../src/planning/manager.js";
import type { PlanningStore } from "../src/planning/store.js";
import type { TaskStepDraft } from "../src/planning/types.js";
import { withHistoryPath } from "./history-fixture.js";

const registry = createModelRegistry(CREDENTIALS, PROVIDERS);
const deepSeekModel = registry.getModel(
  "deepseek",
  "deepseek-v4-flash",
)!;
const openCodeModel = registry.getModel(
  "opencode-go",
  "kimi-k2.7-code",
)!;
const NOW = "2026-07-27T10:00:00.000Z";

const STEPS: readonly TaskStepDraft[] = [
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
];

function sessionFor(store: HistoryStore): SessionManager {
  return createSessionManager({
    store,
    getModel: (providerId, modelId) =>
      registry.getModel(providerId, modelId),
    defaultModel: deepSeekModel,
  });
}

function planFor(
  store: HistoryStore,
  session: SessionManager,
  options: {
    idFactory?: () => string;
    now?: () => string;
  } = {},
): PlanManager {
  return createPlanManager({
    store: store.plans,
    session,
    idFactory: options.idFactory ?? (() => "plan-1"),
    now: options.now ?? (() => NOW),
  });
}

function persistSession(session: SessionManager): void {
  session.commitTurn([
    { role: "user", content: "开始任务" },
    { role: "assistant", content: "收到", toolCalls: [] },
  ]);
}

test("lazy create atomically materializes and adopts exactly one zero-turn session", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      const manager = planFor(store, session);

      const plan = manager.createPlan({
        goal: "  完成计划管理器  ",
        steps: STEPS,
      });

      const current = session.getCurrent();
      assert.equal(store.listSessions().length, 1);
      assert.equal(current.id, plan.sessionId);
      assert.equal(current.title, "完成计划管理器");
      assert.equal(current.turns.length, 0);
      assert.equal(current.revision, 1);
      assert.equal(store.getActiveSessionId(), current.id);
      assert.deepEqual(store.plans.loadForSession(current.id!), plan);
      assert.deepEqual(manager.getCurrentPlan(), plan);
      assert.ok(Object.isFrozen(plan));
      assert.ok(Object.isFrozen(plan.steps));
      assert.notEqual(manager.getCurrentPlan(), plan);
      assert.notEqual(manager.getCurrentPlan()!.steps, plan.steps);
    } finally {
      store.close();
    }
  });
});

test("creates for an existing session without changing its revision and replaces only terminal plans", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const sessionRevision = session.getCurrent().revision;
      let id = 0;
      const manager = planFor(store, session, {
        idFactory: () => `plan-${++id}`,
      });

      const initial = manager.createPlan({
        goal: "已有会话计划",
        steps: STEPS,
      });
      assert.equal(session.getCurrent().revision, sessionRevision);
      assert.throws(
        () =>
          manager.createPlan({
            goal: "不能覆盖进行中计划",
            steps: STEPS,
          }),
        /已有进行中的任务计划/,
      );

      const cancelled = manager.cancelCurrent()!;
      assert.equal(cancelled.status, "cancelled");
      const replacement = manager.createPlan({
        goal: "终态后的新计划",
        steps: STEPS,
      });
      assert.notEqual(replacement.id, initial.id);
      assert.equal(replacement.revision, 1);
      assert.equal(replacement.sessionId, initial.sessionId);
      assert.equal(session.getCurrent().revision, sessionRevision);
      let blocked = manager.updatePlan(
        replacement.id,
        replacement.revision,
        { type: "start_step", stepId: "inspect" },
      );
      blocked = manager.updatePlan(blocked.id, blocked.revision, {
        type: "block_step",
        stepId: "inspect",
        reason: "等待外部条件",
      });
      assert.equal(manager.cancelCurrent()!.status, "cancelled");
    } finally {
      store.close();
    }
  });
});

test("uses getModel as the exact-model fallback for lazy creation", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const realSession = sessionFor(store);
      const sessionWithoutEmbeddedModel: SessionManager = {
        ...realSession,
        getCurrent() {
          const current = realSession.getCurrent();
          if (current.id !== undefined) return current;
          const { model: _model, ...withoutModel } = current;
          return withoutModel;
        },
      };
      const manager = planFor(store, sessionWithoutEmbeddedModel);

      const plan = manager.createPlan({
        goal: "使用模型回退",
        steps: STEPS,
      });

      assert.equal(plan.sessionId, realSession.getCurrent().id);
      assert.equal(realSession.getCurrent().model?.id, deepSeekModel.id);
    } finally {
      store.close();
    }
  });
});

test("delegates all seven update actions, finish, and cancel with exact revisions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const sessionRevision = session.getCurrent().revision;
      const manager = planFor(store, session);
      let plan = manager.createPlan({ goal: "完整状态流", steps: STEPS });

      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "start_step",
        stepId: "inspect",
      });
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "fail_step",
        stepId: "inspect",
        result: "首次失败",
      });
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "start_step",
        stepId: "inspect",
      });
      assert.equal(plan.steps[0]!.retryCount, 1);
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "block_step",
        stepId: "inspect",
        reason: "等待依赖",
      });
      assert.equal(plan.status, "blocked");
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "resume_step",
        stepId: "inspect",
      });
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "complete_step",
        stepId: "inspect",
        result: "检查完成",
      });
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "add_steps",
        steps: [
          {
            id: "document",
            title: "补充文档",
            successCriteria: "文档完成",
            dependsOn: ["inspect"],
          },
        ],
      });
      plan = manager.updatePlan(plan.id, plan.revision, {
        type: "replace_pending_steps",
        steps: [
          {
            id: "verify",
            title: "验证",
            successCriteria: "验证通过",
            dependsOn: ["inspect"],
          },
          {
            id: "release",
            title: "发布",
            successCriteria: "发布完成",
            dependsOn: ["verify"],
          },
        ],
      });
      assert.equal(
        plan.steps.find((step) => step.id === "implement")!.status,
        "superseded",
      );

      for (const stepId of ["verify", "release"]) {
        plan = manager.updatePlan(plan.id, plan.revision, {
          type: "start_step",
          stepId,
        });
        plan = manager.updatePlan(plan.id, plan.revision, {
          type: "complete_step",
          stepId,
          result: `${stepId} 完成`,
        });
      }
      plan = manager.finishPlan(
        plan.id,
        plan.revision,
        "所有目标已经完成",
      );
      assert.equal(plan.status, "completed");
      assert.deepEqual(store.plans.loadForSession(plan.sessionId), plan);
      assert.equal(session.getCurrent().revision, sessionRevision);
      assert.throws(
        () => manager.cancelCurrent(),
        /计划已进入终态，不能取消/,
      );
    } finally {
      store.close();
    }
  });
});

test("rejects stale revisions, wrong plan ids, illegal transitions, and missing current plans", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      assert.equal(planFor(store, session).cancelCurrent(), undefined);
      persistSession(session);
      const manager = planFor(store, session);
      const plan = manager.createPlan({ goal: "冲突测试", steps: STEPS });

      assert.throws(
        () =>
          manager.updatePlan("other-plan", plan.revision, {
            type: "start_step",
            stepId: "inspect",
          }),
        /计划冲突/,
      );
      assert.throws(
        () =>
          manager.updatePlan(plan.id, plan.revision + 1, {
            type: "start_step",
            stepId: "inspect",
          }),
        /计划冲突/,
      );
      assert.throws(
        () =>
          manager.updatePlan(plan.id, plan.revision, {
            type: "start_step",
            stepId: "implement",
          }),
        /依赖尚未解决/,
      );

      session.startNew(deepSeekModel);
      assert.equal(manager.getCurrentPlan(), undefined);
      assert.throws(
        () =>
          manager.updatePlan(plan.id, plan.revision, {
            type: "start_step",
            stepId: "inspect",
          }),
        /当前会话还没有任务计划/,
      );
      session.switchSession(plan.sessionId);
      assert.equal(manager.getCurrentPlan()?.id, plan.id);

      session.setModel(openCodeModel);
      assert.equal(manager.getCurrentPlan()?.id, plan.id);
      assert.equal(session.deleteCurrent(), true);
      assert.equal(manager.getCurrentPlan(), undefined);
      assert.equal(store.plans.loadForSession(plan.sessionId), undefined);
    } finally {
      store.close();
    }
  });
});

test("binds updates and cancellation after clock callbacks so session switches cannot affect the old session", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const firstSessionId = session.getCurrent().id!;
      const creator = planFor(store, session);
      const plan = creator.createPlan({
        goal: "第一个会话计划",
        steps: STEPS,
      });

      session.startNew(deepSeekModel);
      persistSession(session);
      const secondSessionId = session.getCurrent().id!;
      session.switchSession(firstSessionId);

      const switchingManager = planFor(store, session, {
        now: () => {
          session.switchSession(secondSessionId);
          return NOW;
        },
      });
      assert.throws(
        () =>
          switchingManager.updatePlan(plan.id, plan.revision, {
            type: "start_step",
            stepId: "inspect",
          }),
        /当前会话还没有任务计划|计划冲突/,
      );
      assert.equal(
        store.plans.loadForSession(firstSessionId)!.revision,
        plan.revision,
      );

      session.switchSession(firstSessionId);
      assert.throws(
        () => switchingManager.cancelCurrent(),
        /计划冲突/,
      );
      assert.equal(
        store.plans.loadForSession(firstSessionId)!.status,
        "active",
      );
    } finally {
      store.close();
    }
  });
});

test("checks every mutation abort signal before ids, clocks, or store access", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      let dependencyCalls = 0;
      const manager = planFor(store, session, {
        idFactory: () => {
          dependencyCalls += 1;
          return "never";
        },
        now: () => {
          dependencyCalls += 1;
          return NOW;
        },
      });
      const reason = new Error("CUSTOM_ABORT_REASON");
      const controller = new AbortController();
      controller.abort(reason);

      assert.throws(
        () =>
          manager.createPlan(
            { goal: "不会创建", steps: STEPS },
            controller.signal,
          ),
        (error) => error === reason,
      );
      assert.equal(dependencyCalls, 0);
      assert.equal(store.listSessions().length, 0);

      persistSession(session);
      const active = planFor(store, session).createPlan({
        goal: "已有计划",
        steps: STEPS,
      });
      for (const operation of [
        () =>
          manager.updatePlan(
            active.id,
            active.revision,
            { type: "start_step", stepId: "inspect" },
            controller.signal,
          ),
        () =>
          manager.finishPlan(
            active.id,
            active.revision,
            "完成",
            controller.signal,
          ),
        () => manager.cancelCurrent(controller.signal),
      ]) {
        assert.throws(operation, (error) => error === reason);
      }
      assert.equal(dependencyCalls, 0);
      assert.equal(manager.getCurrentPlan()!.revision, active.revision);
    } finally {
      store.close();
    }
  });
});

test("rejects nested mutations and hostile create/action inputs without writes", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      let manager: PlanManager;
      manager = planFor(store, session, {
        idFactory: () => {
          for (const operation of [
            () => manager.createPlan({ goal: "nested", steps: STEPS }),
            () =>
              manager.updatePlan("nested", 1, {
                type: "start_step",
                stepId: "inspect",
              }),
            () => manager.finishPlan("nested", 1, "nested"),
            () => manager.cancelCurrent(),
          ]) {
            assert.throws(
              operation,
              /计划状态正在更新，不能执行嵌套的计划操作/,
            );
          }
          return "reentrant-plan";
        },
      });
      const created = manager.createPlan({
        goal: "重入测试",
        steps: STEPS,
      });
      assert.equal(created.id, "reentrant-plan");

      session.startNew(deepSeekModel);
      const getterInput = Object.defineProperty({}, "goal", {
        enumerable: true,
        get() {
          throw new Error("SECRET_GETTER_EXECUTED");
        },
      });
      assert.throws(
        () =>
          manager.createPlan(
            getterInput as {
              goal: string;
              steps: readonly TaskStepDraft[];
            },
          ),
        /无法安全读取|普通 JSON/,
      );
      const sparse = new Array<TaskStepDraft>(2);
      sparse[0] = STEPS[0]!;
      assert.throws(
        () => manager.createPlan({ goal: "稀疏", steps: sparse }),
        /密集数组/,
      );
      assert.throws(
        () =>
          manager.createPlan(
            new Proxy(
              { goal: "代理", steps: STEPS },
              {},
            ),
          ),
        /Proxy|普通 JSON/,
      );
      assert.equal(store.listSessions().length, 1);

      session.switchSession(created.sessionId);
      const before = manager.getCurrentPlan()!;
      assert.throws(
        () =>
          manager.updatePlan(
            before.id,
            before.revision,
            Object.defineProperty({}, "type", {
              get() {
                throw new Error("SECRET_ACTION_GETTER");
              },
            }) as never,
          ),
        /无法安全读取|数据属性/,
      );
      assert.equal(manager.getCurrentPlan()!.revision, before.revision);
    } finally {
      store.close();
    }
  });
});

test("reports committed lazy creation honestly when session adoption fails", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const realSession = sessionFor(store);
      const failingSession: SessionManager = {
        ...realSession,
        adoptMaterializedSession() {
          throw new Error("injected adoption failure");
        },
      };
      const manager = planFor(store, failingSession);

      assert.throws(
        () =>
          manager.createPlan({
            goal: "持久化后接管失败",
            steps: STEPS,
          }),
        /计划已保存，但当前会话接管失败/,
      );
      assert.equal(store.listSessions().length, 1);
      const sessionId = store.getActiveSessionId()!;
      assert.equal(store.plans.loadForSession(sessionId)?.id, "plan-1");
      assert.equal(realSession.getCurrent().id, undefined);
      assert.equal(
        realSession.adoptMaterializedSession(sessionId).id,
        sessionId,
      );
    } finally {
      store.close();
    }
  });
});

test("rejects a getModel callback that changes the session before returning an old model", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const realSession = sessionFor(store);
      let createCalls = 0;
      const guardedStore: PlanningStore = {
        ...store.plans,
        create(input) {
          createCalls += 1;
          return store.plans.create(input);
        },
      };
      const switchingSession: SessionManager = {
        ...realSession,
        getModel() {
          const oldModel = realSession.getModel();
          realSession.startNew(openCodeModel);
          return oldModel;
        },
      };
      const manager = createPlanManager({
        store: guardedStore,
        session: switchingSession,
        idFactory: () => "get-model-race",
        now: () => NOW,
      });

      assert.throws(
        () => manager.createPlan({ goal: "模型竞态", steps: STEPS }),
        /计划冲突/,
      );
      assert.equal(createCalls, 0);
      assert.equal(store.listSessions().length, 0);
      assert.equal(realSession.getModel()?.id, openCodeModel.id);
    } finally {
      store.close();
    }
  });
});

test("guards lazy store creation against a synchronous startNew callback", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      let delegated = false;
      const switchingStore: PlanningStore = {
        ...store.plans,
        create(input) {
          session.startNew(openCodeModel);
          delegated = true;
          return store.plans.create(input);
        },
      };
      const manager = createPlanManager({
        store: switchingStore,
        session,
        idFactory: () => "guarded-lazy-create",
        now: () => NOW,
      });

      assert.throws(
        () => manager.createPlan({ goal: "受保护创建", steps: STEPS }),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.equal(delegated, false);
      assert.equal(store.listSessions().length, 0);
      assert.equal(store.getActiveSessionId(), undefined);
    } finally {
      store.close();
    }
  });
});

test("rejects an adopt implementation that adopts, starts new, and returns the stale adopted snapshot", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const realSession = sessionFor(store);
      const maliciousSession: SessionManager = {
        ...realSession,
        adoptMaterializedSession(sessionId) {
          const adopted =
            realSession.adoptMaterializedSession(sessionId);
          realSession.startNew(openCodeModel);
          return adopted;
        },
      };
      const manager = planFor(store, maliciousSession);

      assert.throws(
        () =>
          manager.createPlan({
            goal: "恶意接管回调",
            steps: STEPS,
          }),
        /计划已保存，但当前会话接管失败.*\/sessions/,
      );
      assert.equal(realSession.getCurrent().id, undefined);
      assert.equal(realSession.getModel()?.id, openCodeModel.id);
      assert.equal(realSession.getStateVersion(), 2n);
      assert.equal(store.listSessions().length, 1);
      const savedSessionId = store.listSessions()[0]!.id;
      assert.equal(
        store.plans.loadForSession(savedSessionId)?.id,
        "plan-1",
      );
    } finally {
      store.close();
    }
  });
});

test("guards existing create against a synchronous session switch inside store.create", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const targetSessionId = session.getCurrent().id!;
      session.startNew(deepSeekModel);
      persistSession(session);
      const otherSessionId = session.getCurrent().id!;
      session.switchSession(targetSessionId);

      let delegated = false;
      const switchingStore: PlanningStore = {
        ...store.plans,
        create(input) {
          session.switchSession(otherSessionId);
          delegated = true;
          return store.plans.create(input);
        },
      };
      const manager = createPlanManager({
        store: switchingStore,
        session,
        idFactory: () => "guarded-existing-create",
        now: () => NOW,
      });

      assert.throws(
        () =>
          manager.createPlan({
            goal: "已有会话受保护创建",
            steps: STEPS,
          }),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.equal(delegated, false);
      assert.equal(session.getCurrent().id, targetSessionId);
      assert.equal(
        store.plans.loadForSession(targetSessionId),
        undefined,
      );
    } finally {
      store.close();
    }
  });
});

test("guards update and finish against a synchronous session switch inside store.save", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const targetSessionId = session.getCurrent().id!;
      const baseManager = planFor(store, session);
      let plan = baseManager.createPlan({
        goal: "保存受保护",
        steps: STEPS,
      });

      session.startNew(deepSeekModel);
      persistSession(session);
      const otherSessionId = session.getCurrent().id!;
      session.switchSession(targetSessionId);

      let delegated = false;
      const switchingStore: PlanningStore = {
        ...store.plans,
        save(next, expectedRevision) {
          session.switchSession(otherSessionId);
          delegated = true;
          return store.plans.save(next, expectedRevision);
        },
      };
      const guardedManager = createPlanManager({
        store: switchingStore,
        session,
        now: () => NOW,
      });

      assert.throws(
        () =>
          guardedManager.updatePlan(plan.id, plan.revision, {
            type: "start_step",
            stepId: "inspect",
          }),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.equal(delegated, false);
      assert.equal(
        store.plans.loadForSession(targetSessionId)!.revision,
        plan.revision,
      );

      for (const stepId of ["inspect", "implement"]) {
        plan = baseManager.updatePlan(plan.id, plan.revision, {
          type: "start_step",
          stepId,
        });
        plan = baseManager.updatePlan(plan.id, plan.revision, {
          type: "complete_step",
          stepId,
          result: "完成",
        });
      }
      delegated = false;
      assert.throws(
        () =>
          guardedManager.finishPlan(
            plan.id,
            plan.revision,
            "完成全部步骤",
          ),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.equal(delegated, false);
      assert.equal(
        store.plans.loadForSession(targetSessionId)!.status,
        "active",
      );
    } finally {
      store.close();
    }
  });
});

test("guards cancellation against a synchronous session switch inside store.cancel", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = sessionFor(store);
      persistSession(session);
      const targetSessionId = session.getCurrent().id!;
      const baseManager = planFor(store, session);
      const plan = baseManager.createPlan({
        goal: "取消受保护",
        steps: STEPS,
      });

      session.startNew(deepSeekModel);
      persistSession(session);
      const otherSessionId = session.getCurrent().id!;
      session.switchSession(targetSessionId);

      let delegated = false;
      const switchingStore: PlanningStore = {
        ...store.plans,
        cancel(sessionId, expectedRevision, timestamp) {
          session.switchSession(otherSessionId);
          delegated = true;
          return store.plans.cancel(
            sessionId,
            expectedRevision,
            timestamp,
          );
        },
      };
      const manager = createPlanManager({
        store: switchingStore,
        session,
        now: () => NOW,
      });

      assert.throws(
        () => manager.cancelCurrent(),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.equal(delegated, false);
      assert.equal(
        store.plans.loadForSession(targetSessionId)?.revision,
        plan.revision,
      );
      assert.equal(
        store.plans.loadForSession(targetSessionId)?.status,
        "active",
      );
    } finally {
      store.close();
    }
  });
});
