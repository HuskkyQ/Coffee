import assert from "node:assert/strict";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createSessionManager,
  createSessionTitle,
} from "../src/history/session-manager.js";
import {
  createHistoryStore,
  type HistoryStore,
} from "../src/history/store.js";
import type { PersistedMessage } from "../src/history/types.js";
import { CREDENTIALS, PROVIDERS } from "../src/models/catalog.js";
import { createModelRegistry } from "../src/models/registry.js";
import type { ModelDefinition } from "../src/models/types.js";
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

type MutableModelDefinition = {
  -readonly [Key in keyof ModelDefinition]: ModelDefinition[Key];
};

const FIRST_TURN: PersistedMessage[] = [
  { role: "user", content: "第一杯咖啡" },
  { role: "assistant", content: "已经准备好。", toolCalls: [] },
];

function managerFor(
  store: HistoryStore,
  defaultModel: ModelDefinition | undefined = deepSeekModel,
) {
  return createSessionManager({
    store,
    getModel: (providerId, modelId) =>
      registry.getModel(providerId, modelId),
    defaultModel,
  });
}

function createStoredSession(
  store: HistoryStore,
  options: {
    title?: string;
    providerId?: string;
    modelId?: string;
  } = {},
) {
  return store.commitTurn({
    title: options.title ?? "已保存会话",
    providerId: options.providerId ?? deepSeekModel.providerId,
    modelId: options.modelId ?? deepSeekModel.id,
    messages: FIRST_TURN,
  });
}

function mutableModel(
  providerId: string,
  id: string,
  name = id,
): MutableModelDefinition {
  return {
    id,
    name,
    providerId,
    credentialId: "deepseek",
    api: "openai-completions",
    baseUrl: `https://${providerId}.example.com`,
  };
}

test("normalizes whitespace, uses a fallback, and truncates by Unicode code point", () => {
  assert.equal(createSessionTitle("  第一行\n\t第二行  "), "第一行 第二行");
  assert.equal(createSessionTitle(" \n\t "), "新会话");
  assert.equal(createSessionTitle("😀".repeat(41)), "😀".repeat(40));
  assert.equal(Array.from(createSessionTitle("😀".repeat(41))).length, 40);
});

test("keeps blank sessions lazy across repeated new calls and materializes the first turn", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      assert.deepEqual(manager.getCurrent(), {
        providerId: deepSeekModel.providerId,
        modelId: deepSeekModel.id,
        model: deepSeekModel,
        turns: [],
      });

      manager.startNew(openCodeModel);
      manager.startNew(openCodeModel);
      assert.equal(store.getActiveSessionId(), undefined);
      assert.equal(store.listSessions().length, 0);

      const turn = manager.commitTurn([
        { role: "user", content: "  第一行\n第二行  " },
        { role: "assistant", content: "完成", toolCalls: [] },
      ]);
      const current = manager.getCurrent();

      assert.equal(turn.sequence, 1);
      assert.equal(current.title, "第一行 第二行");
      assert.equal(current.providerId, openCodeModel.providerId);
      assert.equal(current.modelId, openCodeModel.id);
      assert.equal(current.revision, 1);
      assert.equal(current.turns.length, 1);
      assert.equal(store.getActiveSessionId(), current.id);
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.loadSession(current.id!)?.title, "第一行 第二行");
    } finally {
      store.close();
    }
  });
});

test("restores the active model, turns, summary, and revision on restart", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      manager.startNew(openCodeModel);
      manager.commitTurn(FIRST_TURN);
      const summary = manager.saveSummary(1, "用户想准备咖啡。");

      const restored = managerFor(store);
      const current = restored.getCurrent();
      assert.equal(restored.getModel()?.id, openCodeModel.id);
      assert.equal(current.providerId, openCodeModel.providerId);
      assert.equal(current.modelId, openCodeModel.id);
      assert.equal(current.revision, 2);
      assert.deepEqual(current.turns, manager.getCurrent().turns);
      assert.deepEqual(current.summary, summary);
    } finally {
      store.close();
    }
  });
});

test("preserves unknown stored model ids without silently using the default", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const stored = createStoredSession(store, {
        providerId: "removed-provider",
        modelId: "removed-model",
      });
      const manager = managerFor(store);

      assert.equal(manager.getCurrent().id, stored.id);
      assert.equal(manager.getCurrent().providerId, "removed-provider");
      assert.equal(manager.getCurrent().modelId, "removed-model");
      assert.equal(manager.getCurrent().model, undefined);
      assert.equal(manager.getModel(), undefined);
      assert.throws(
        () => manager.commitTurn(FIRST_TURN),
        /尚未选择模型，请先使用 \/login 登录，再使用 \/model 选择模型/,
      );
      assert.equal(store.loadSession(stored.id)?.revision, 1);
    } finally {
      store.close();
    }
  });
});

test("refuses a resolver result whose provider or model identity does not match storage", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const stored = createStoredSession(store);
      const manager = createSessionManager({
        store,
        getModel: () => openCodeModel,
        defaultModel: openCodeModel,
      });

      assert.equal(manager.getCurrent().id, stored.id);
      assert.equal(manager.getCurrent().providerId, deepSeekModel.providerId);
      assert.equal(manager.getCurrent().modelId, deepSeekModel.id);
      assert.equal(manager.getCurrent().model, undefined);
      assert.equal(manager.getModel(), undefined);
    } finally {
      store.close();
    }
  });
});

test("isolates constructor, startNew, and setModel from later input model mutations", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const initial = mutableModel("mutable-initial", "initial", "Initial");
      const manager = createSessionManager({
        store,
        getModel: () => undefined,
        defaultModel: initial,
      });
      initial.id = "polluted-initial";
      initial.providerId = "polluted-initial-provider";
      initial.name = "Polluted initial";
      assert.equal(manager.getModel()?.id, "initial");
      assert.equal(manager.getCurrent().providerId, "mutable-initial");
      assert.equal(manager.getModel()?.name, "Initial");

      const next = mutableModel("mutable-next", "next", "Next");
      manager.startNew(next);
      next.id = "polluted-next";
      next.providerId = "polluted-next-provider";
      next.baseUrl = "https://polluted.example.com";
      assert.equal(manager.getModel()?.id, "next");
      assert.equal(manager.getCurrent().providerId, "mutable-next");
      assert.equal(
        manager.getModel()?.baseUrl,
        "https://mutable-next.example.com",
      );

      manager.commitTurn(FIRST_TURN);
      const selected = mutableModel(
        "mutable-selected",
        "selected",
        "Selected",
      );
      manager.setModel(selected);
      selected.id = "polluted-selected";
      selected.providerId = "polluted-selected-provider";
      selected.name = "Polluted selected";
      assert.equal(manager.getModel()?.id, "selected");
      assert.equal(manager.getCurrent().providerId, "mutable-selected");
      assert.equal(manager.getModel()?.name, "Selected");
      assert.equal(
        store.loadSession(manager.getCurrent().id!)?.modelId,
        "selected",
      );
    } finally {
      store.close();
    }
  });
});

test("setModel stays lazy when blank, persists with revision when real, and feeds delete default", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      manager.setModel(openCodeModel);
      assert.equal(store.listSessions().length, 0);
      assert.equal(manager.getModel()?.id, openCodeModel.id);

      manager.commitTurn(FIRST_TURN);
      assert.equal(manager.getCurrent().revision, 1);
      manager.setModel(deepSeekModel);
      assert.equal(manager.getCurrent().revision, 2);
      assert.equal(store.loadSession(manager.getCurrent().id!)?.modelId, deepSeekModel.id);

      manager.setModel(openCodeModel);
      assert.equal(manager.getCurrent().revision, 3);
      assert.equal(manager.deleteCurrent(), true);
      assert.equal(manager.getCurrent().id, undefined);
      assert.equal(manager.getModel()?.id, openCodeModel.id);
      assert.equal(manager.getCurrent().providerId, openCodeModel.providerId);
      assert.equal(store.listSessions().length, 0);
    } finally {
      store.close();
    }
  });
});

test("startNew adopts the supplied global default after clearing active metadata", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      manager.commitTurn(FIRST_TURN);
      assert.ok(store.getActiveSessionId());

      manager.startNew(openCodeModel);
      assert.equal(store.getActiveSessionId(), undefined);
      assert.equal(manager.getCurrent().id, undefined);
      assert.equal(manager.getModel()?.id, openCodeModel.id);

      manager.commitTurn([
        { role: "user", content: "第二个会话" },
        { role: "assistant", content: "完成", toolCalls: [] },
      ]);
      manager.deleteCurrent();
      assert.equal(manager.getModel()?.id, openCodeModel.id);
      assert.equal(store.listSessions().length, 1);
    } finally {
      store.close();
    }
  });
});

test("adopts an atomically materialized zero-turn planning session without sharing state", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      const created = store.plans.create({
        session: {
          kind: "new",
          title: "规划会话",
          providerId: openCodeModel.providerId,
          modelId: openCodeModel.id,
        },
        plan: {
          id: "plan-adopt",
          goal: "完成受控接管",
          now: "2026-07-27T10:00:00.000Z",
          steps: [
            {
              id: "inspect",
              title: "检查",
              successCriteria: "检查完成",
              dependsOn: [],
            },
            {
              id: "adopt",
              title: "接管",
              successCriteria: "接管完成",
              dependsOn: ["inspect"],
            },
          ],
        },
      });
      const sessionId = created.materializedSession!.id;
      assert.equal(manager.getStateVersion(), 0n);

      const adopted = manager.adoptMaterializedSession(sessionId);

      assert.deepEqual(adopted, {
        id: sessionId,
        title: "规划会话",
        providerId: openCodeModel.providerId,
        modelId: openCodeModel.id,
        revision: 1,
        model: openCodeModel,
        turns: [],
      });
      assert.ok(Object.isFrozen(adopted));
      assert.ok(Object.isFrozen(adopted.model));
      assert.notEqual(adopted, manager.getCurrent());
      assert.notEqual(adopted.model, manager.getCurrent().model);
      assert.throws(() => {
        (adopted as { title: string }).title = "篡改";
      });
      assert.equal(manager.getCurrent().title, "规划会话");
      assert.equal(manager.getStateVersion(), 1n);

      manager.deleteCurrent();
      assert.equal(manager.getModel()?.id, deepSeekModel.id);
      assert.equal(manager.getStateVersion(), 2n);
    } finally {
      store.close();
    }
  });
});

test("guards the exact session state version and blocks nested session mutations", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      const before = manager.getCurrent();
      const stored = createStoredSession(store);
      assert.equal(manager.getStateVersion(), 0n);

      let called = false;
      assert.throws(
        () =>
          manager.runWithCurrentGuard(1n, () => {
            called = true;
          }),
        /会话状态已变化/,
      );
      assert.equal(called, false);
      assert.equal(manager.getStateVersion(), 0n);

      assert.throws(
        () =>
          manager.runWithCurrentGuard(0n, () => {
            manager.switchSession(stored.id);
          }),
        /会话状态正在更新，不能执行嵌套的会话操作/,
      );
      assert.deepEqual(manager.getCurrent(), before);
      assert.equal(manager.getStateVersion(), 0n);

      assert.throws(
        () =>
          manager.runWithCurrentGuard(0n, () => {
            throw new Error("guard failure");
          }),
        /guard failure/,
      );
      assert.equal(
        manager.runWithCurrentGuard(0n, () => "released"),
        "released",
      );
      assert.equal(manager.getStateVersion(), 0n);
    } finally {
      store.close();
    }
  });
});

test("increments the session state version only after successful state changes", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      assert.equal(manager.getStateVersion(), 0n);

      manager.startNew(openCodeModel);
      assert.equal(manager.getStateVersion(), 1n);
      assert.equal(manager.deleteCurrent(), false);
      assert.equal(manager.getStateVersion(), 1n);
      assert.throws(
        () => manager.switchSession("missing"),
        /找不到要切换的会话/,
      );
      assert.equal(manager.getStateVersion(), 1n);

      manager.commitTurn(FIRST_TURN);
      assert.equal(manager.getStateVersion(), 2n);
      manager.saveSummary(1, "已完成首轮。");
      assert.equal(manager.getStateVersion(), 3n);
      const sessionId = manager.getCurrent().id!;
      manager.setModel(deepSeekModel);
      assert.equal(manager.getStateVersion(), 4n);
      manager.switchSession(sessionId);
      assert.equal(manager.getStateVersion(), 5n);
      assert.equal(manager.deleteCurrent(), true);
      assert.equal(manager.getStateVersion(), 6n);
    } finally {
      store.close();
    }
  });
});

test("rejects thenable and async session guard callbacks and releases the lock", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      const before = manager.getCurrent();
      const thenable = {
        then() {
          return undefined;
        },
      };

      assert.throws(
        () =>
          manager.runWithCurrentGuard(
            0n,
            (() => thenable) as never,
          ),
        /Session 稳定性守卫只支持同步操作/,
      );
      assert.throws(
        () =>
          manager.runWithCurrentGuard(
            0n,
            // @ts-expect-error Session guards reject async callbacks.
            async () => "async",
          ),
        /Session 稳定性守卫只支持同步操作/,
      );
      assert.deepEqual(manager.getCurrent(), before);
      assert.equal(manager.getStateVersion(), 0n);
      assert.equal(
        manager.runWithCurrentGuard(0n, () => "released"),
        "released",
      );
    } finally {
      store.close();
    }
  });
});

test("rejects invalid materialized session adoption without changing the current session", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      const before = manager.getCurrent();

      assert.throws(
        () => manager.adoptMaterializedSession("missing"),
        /找不到要接管的会话/,
      );
      assert.throws(
        () => manager.adoptMaterializedSession("   "),
        /接管计划会话参数无法安全读取/,
      );
      assert.throws(
        () =>
          manager.adoptMaterializedSession(
            new Proxy(new String("hidden"), {}) as unknown as string,
          ),
        /接管计划会话参数无法安全读取/,
      );
      assert.deepEqual(manager.getCurrent(), before);

      const persisted = createStoredSession(store);
      manager.startNew(deepSeekModel);
      assert.throws(
        () => manager.adoptMaterializedSession(persisted.id),
        /必须是尚无对话轮次的新会话/,
      );
      assert.equal(manager.getCurrent().id, undefined);

      const unknown = store.plans.create({
        session: {
          kind: "new",
          title: "未知模型",
          providerId: "removed-provider",
          modelId: "removed-model",
        },
        plan: {
          id: "unknown-model-plan",
          goal: "测试未知模型",
          now: "2026-07-27T10:00:00.000Z",
          steps: [
            {
              id: "one",
              title: "第一步",
              successCriteria: "完成第一步",
              dependsOn: [],
            },
            {
              id: "two",
              title: "第二步",
              successCriteria: "完成第二步",
              dependsOn: ["one"],
            },
          ],
        },
      });
      assert.throws(
        () =>
          manager.adoptMaterializedSession(
            unknown.materializedSession!.id,
          ),
        /会话模型无法解析/,
      );
      assert.equal(manager.getCurrent().id, undefined);

      store.setActiveSessionId(undefined);
      const valid = store.plans.create({
        session: {
          kind: "new",
          title: "元数据不匹配",
          providerId: deepSeekModel.providerId,
          modelId: deepSeekModel.id,
        },
        plan: {
          id: "metadata-plan",
          goal: "测试活动元数据",
          now: "2026-07-27T10:00:00.000Z",
          steps: [
            {
              id: "one",
              title: "第一步",
              successCriteria: "完成第一步",
              dependsOn: [],
            },
            {
              id: "two",
              title: "第二步",
              successCriteria: "完成第二步",
              dependsOn: ["one"],
            },
          ],
        },
      });
      store.setActiveSessionId(undefined);
      assert.throws(
        () =>
          manager.adoptMaterializedSession(valid.materializedSession!.id),
        /活动会话元数据不匹配/,
      );
      assert.deepEqual(manager.getCurrent(), before);
    } finally {
      store.close();
    }
  });
});

test("rejects adoption over a persisted current session and nested adoption", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const persisted = createStoredSession(store);
      const manager = managerFor(store);
      const before = manager.getCurrent();
      assert.throws(
        () => manager.adoptMaterializedSession(persisted.id),
        /当前会话已经持久化，不能接管计划会话/,
      );
      assert.deepEqual(manager.getCurrent(), before);
    } finally {
      store.close();
    }
  });

  await withHistoryPath(async (databasePath) => {
    const baseStore = createHistoryStore(databasePath);
    try {
      let manager: ReturnType<typeof managerFor>;
      let nested = false;
      const store: HistoryStore = {
        ...baseStore,
        loadSession(sessionId) {
          if (!nested) {
            nested = true;
            assert.throws(
              () => manager.adoptMaterializedSession(sessionId),
              /会话状态正在更新，不能执行嵌套的会话操作/,
            );
          }
          return baseStore.loadSession(sessionId);
        },
      };
      manager = managerFor(store);
      const created = baseStore.plans.create({
        session: {
          kind: "new",
          title: "重入会话",
          providerId: deepSeekModel.providerId,
          modelId: deepSeekModel.id,
        },
        plan: {
          id: "reentrant-plan",
          goal: "测试重入",
          now: "2026-07-27T10:00:00.000Z",
          steps: [
            {
              id: "one",
              title: "第一步",
              successCriteria: "完成第一步",
              dependsOn: [],
            },
            {
              id: "two",
              title: "第二步",
              successCriteria: "完成第二步",
              dependsOn: ["one"],
            },
          ],
        },
      });

      assert.equal(
        manager.adoptMaterializedSession(
          created.materializedSession!.id,
        ).id,
        created.materializedSession!.id,
      );
    } finally {
      baseStore.close();
    }
  });
});

test("lists safe snapshots, switches active sessions, and rejects a missing session in Chinese", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createStoredSession(store, { title: "第一个" });
      const second = createStoredSession(store, {
        title: "第二个",
        providerId: openCodeModel.providerId,
        modelId: openCodeModel.id,
      });
      const manager = managerFor(store);
      assert.equal(manager.getCurrent().id, second.id);

      const listed = manager.listSessions();
      assert.equal(listed.length, 2);
      assert.throws(() => {
        (listed as unknown as { title: string }[])[0]!.title = "外部篡改";
      });
      assert.notEqual(manager.listSessions()[0]?.title, "外部篡改");

      const switched = manager.switchSession(first.id);
      assert.equal(switched.id, first.id);
      assert.equal(store.getActiveSessionId(), first.id);
      assert.equal(manager.getModel()?.id, deepSeekModel.id);

      const before = manager.getCurrent();
      assert.throws(
        () => manager.switchSession("missing-session"),
        /找不到要切换的会话/,
      );
      assert.deepEqual(manager.getCurrent(), before);
      assert.equal(store.getActiveSessionId(), first.id);
    } finally {
      store.close();
    }
  });
});

test("deleteCurrent is a no-op for blank and cascades a persisted session", async () => {
  await withHistoryPath(async (databasePath) => {
    const realStore = createHistoryStore(databasePath);
    let deleteCalls = 0;
    const store: HistoryStore = {
      ...realStore,
      deleteSession(sessionId, expectedRevision) {
        deleteCalls += 1;
        realStore.deleteSession(sessionId, expectedRevision);
      },
    };
    try {
      const manager = managerFor(store);
      assert.equal(manager.deleteCurrent(), false);
      assert.equal(deleteCalls, 0);

      manager.commitTurn(FIRST_TURN);
      const id = manager.getCurrent().id!;
      assert.equal(manager.deleteCurrent(), true);
      assert.equal(deleteCalls, 1);
      assert.equal(realStore.loadSession(id), undefined);
      assert.equal(realStore.getActiveSessionId(), undefined);
      assert.equal(manager.getCurrent().turns.length, 0);
    } finally {
      realStore.close();
    }
  });
});

test("clears a dangling active id and starts blank with the default", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const stored = createStoredSession(store);
    store.close();

    const database = new Database(databasePath);
    try {
      database.pragma("foreign_keys = OFF");
      database.prepare("DELETE FROM sessions WHERE id = ?").run(stored.id);
    } finally {
      database.close();
    }

    const reopened = createHistoryStore(databasePath);
    try {
      assert.equal(reopened.getActiveSessionId(), stored.id);
      const manager = managerFor(reopened);
      assert.equal(reopened.getActiveSessionId(), undefined);
      assert.equal(manager.getCurrent().id, undefined);
      assert.equal(manager.getModel()?.id, deepSeekModel.id);
    } finally {
      reopened.close();
    }
  });
});

test("saveSummary requires persistence and updates only summary and revision", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      assert.throws(
        () => manager.saveSummary(1, "不会保存"),
        /尚未持久化.*无法保存摘要/,
      );

      manager.commitTurn(FIRST_TURN);
      const turnsBefore = manager.getCurrent().turns;
      const summary = manager.saveSummary(1, "保留重要决定");
      assert.equal(summary.content, "保留重要决定");
      assert.equal(manager.getCurrent().revision, 2);
      assert.deepEqual(manager.getCurrent().turns, turnsBefore);
      assert.deepEqual(manager.getCurrent().summary, summary);
    } finally {
      store.close();
    }
  });
});

test("returns deep, immutable snapshots that cannot pollute session or model state", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      manager.commitTurn(FIRST_TURN);
      const first = manager.getCurrent();
      const second = manager.getCurrent();

      assert.notEqual(first, second);
      assert.notEqual(first.turns, second.turns);
      assert.notEqual(first.turns[0]?.messages, second.turns[0]?.messages);
      assert.notEqual(first.model, manager.getModel());
      assert.throws(() => {
        (first.turns as unknown[]).push({});
      });
      assert.throws(() => {
        (first.turns[0]!.messages[0] as { content: string }).content = "污染";
      });
      assert.throws(() => {
        (first.model as { name: string }).name = "污染模型";
      });

      assert.equal(
        manager.getCurrent().turns[0]?.messages[0]?.content,
        "第一杯咖啡",
      );
      assert.equal(manager.getModel()?.name, deepSeekModel.name);
    } finally {
      store.close();
    }
  });
});

test("rejects a non-user first message and never invokes dynamic title getters", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      assert.throws(
        () =>
          manager.commitTurn([
            { role: "assistant", content: "先回答", toolCalls: [] },
          ]),
        /首条消息必须是 user 消息/,
      );

      let getterCalls = 0;
      const dynamicMessage = {
        role: "user",
        get content() {
          getterCalls += 1;
          throw new Error("TOP_SECRET_DYNAMIC_TITLE");
        },
      };
      assert.throws(
        () =>
          manager.commitTurn(
            [dynamicMessage] as unknown as readonly PersistedMessage[],
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /提交轮次.*安全读取/);
          assert.doesNotMatch(error.message, /TOP_SECRET_DYNAMIC_TITLE/);
          return true;
        },
      );
      assert.equal(getterCalls, 0);

      const proxyMessages = new Proxy([FIRST_TURN[0]!], {
        getOwnPropertyDescriptor() {
          throw new Error("TOP_SECRET_PROXY_TITLE");
        },
      });
      assert.throws(
        () => manager.commitTurn(proxyMessages),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /提交轮次.*安全读取/);
          assert.doesNotMatch(error.message, /TOP_SECRET_PROXY_TITLE/);
          return true;
        },
      );
      assert.equal(store.listSessions().length, 0);
    } finally {
      store.close();
    }
  });
});

test("snapshots a dynamic messages array once so title and persisted content agree", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      const first = { role: "user" as const, content: "稳定标题" };
      const changed = { role: "user" as const, content: "二次读取泄漏" };
      const input = [first] as PersistedMessage[];
      let firstReads = 0;
      const dynamic = new Proxy(input, {
        getOwnPropertyDescriptor(target, key) {
          if (key === "0") {
            firstReads += 1;
            return {
              configurable: true,
              enumerable: true,
              value: firstReads === 1 ? first : changed,
              writable: true,
            };
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });

      manager.commitTurn(dynamic);
      const current = manager.getCurrent();
      assert.equal(firstReads, 1);
      assert.equal(current.title, "稳定标题");
      assert.equal(current.turns[0]?.messages[0]?.content, "稳定标题");
      assert.equal(
        store.loadSession(current.id!)?.turns[0]?.messages[0]?.content,
        "稳定标题",
      );
    } finally {
      store.close();
    }
  });
});

test("rejects a reentrant mutation during a real store commit without splitting state", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const manager = managerFor(store);
      manager.commitTurn(FIRST_TURN);
      const baseCurrent = manager.getCurrent();
      const baseStored = store.loadSession(baseCurrent.id!);
      const baseActive = store.getActiveSessionId();
      let reentrantError: unknown;
      const reentrantAssistant = new Proxy(
        { role: "assistant" as const, content: "不会提交", toolCalls: [] },
        {
          getPrototypeOf(target) {
            try {
              manager.startNew(openCodeModel);
            } catch (error) {
              reentrantError = error;
              throw error;
            }
            return Reflect.getPrototypeOf(target);
          },
        },
      );

      assert.throws(() =>
        manager.commitTurn([
          { role: "user", content: "触发重入" },
          reentrantAssistant,
        ]),
      );
      assert.ok(reentrantError instanceof Error);
      assert.match(reentrantError.message, /会话状态正在更新.*嵌套/);
      assert.deepEqual(manager.getCurrent(), baseCurrent);
      assert.deepEqual(store.loadSession(baseCurrent.id!), baseStored);
      assert.equal(store.getActiveSessionId(), baseActive);
    } finally {
      store.close();
    }
  });
});

test("guards every mutation entry against synchronous nested calls", async () => {
  await withHistoryPath(async (databasePath) => {
    const realStore = createHistoryStore(databasePath);
    createStoredSession(realStore);
    let nested: (() => unknown) | undefined;
    const store: HistoryStore = {
      ...realStore,
      setActiveSessionId(sessionId) {
        if (nested !== undefined) return nested() as void;
        realStore.setActiveSessionId(sessionId);
      },
    };
    try {
      const manager = managerFor(store);
      const base = manager.getCurrent();
      const baseActive = realStore.getActiveSessionId();
      const mutations: readonly [string, () => unknown][] = [
        ["startNew", () => manager.startNew(openCodeModel)],
        ["switchSession", () => manager.switchSession(base.id!)],
        ["deleteCurrent", () => manager.deleteCurrent()],
        ["setModel", () => manager.setModel(openCodeModel)],
        ["commitTurn", () => manager.commitTurn(FIRST_TURN)],
        ["saveSummary", () => manager.saveSummary(1, "nested")],
      ];

      for (const [name, mutation] of mutations) {
        nested = mutation;
        assert.throws(
          () => manager.startNew(deepSeekModel),
          (error: unknown) => {
            assert.ok(error instanceof Error, name);
            assert.match(error.message, /会话状态正在更新.*嵌套/, name);
            return true;
          },
        );
        assert.deepEqual(manager.getCurrent(), base, name);
        assert.equal(realStore.getActiveSessionId(), baseActive, name);
      }
      nested = undefined;

      manager.startNew(openCodeModel);
      assert.equal(manager.getModel()?.id, openCodeModel.id);
    } finally {
      realStore.close();
    }
  });
});

for (const operation of ["commit", "model", "summary", "delete"] as const) {
  test(`keeps the in-memory snapshot unchanged after a stale ${operation} conflict`, async () => {
    await withHistoryPath(async (databasePath) => {
      const storeA = createHistoryStore(databasePath);
      const storeB = createHistoryStore(databasePath);
      try {
        createStoredSession(storeA);
        const winner = managerFor(storeA);
        const stale = managerFor(storeB);
        const before = stale.getCurrent();

        if (operation === "commit") {
          winner.commitTurn(FIRST_TURN);
          assert.throws(() => stale.commitTurn(FIRST_TURN), /其他 Coffee 进程/);
        } else if (operation === "model") {
          winner.setModel(openCodeModel);
          assert.throws(() => stale.setModel(openCodeModel), /其他 Coffee 进程/);
        } else if (operation === "summary") {
          winner.saveSummary(1, "winner");
          assert.throws(() => stale.saveSummary(1, "stale"), /其他 Coffee 进程/);
        } else {
          winner.setModel(openCodeModel);
          assert.throws(() => stale.deleteCurrent(), /其他 Coffee 进程/);
        }

        assert.deepEqual(stale.getCurrent(), before);
        assert.ok(storeA.loadSession(before.id!));
      } finally {
        storeB.close();
        storeA.close();
      }
    });
  });
}

test("does not partially switch when model resolution or active persistence fails", async () => {
  await withHistoryPath(async (databasePath) => {
    const realStore = createHistoryStore(databasePath);
    const first = createStoredSession(realStore, { title: "原会话" });
    const second = createStoredSession(realStore, {
      title: "目标会话",
      providerId: openCodeModel.providerId,
      modelId: openCodeModel.id,
    });
    realStore.setActiveSessionId(first.id);
    try {
      let failResolve = true;
      const resolvingManager = createSessionManager({
        store: realStore,
        getModel(providerId, modelId) {
          if (failResolve && modelId === openCodeModel.id) {
            throw new Error("resolver failed");
          }
          return registry.getModel(providerId, modelId);
        },
        defaultModel: deepSeekModel,
      });
      const beforeResolve = resolvingManager.getCurrent();
      assert.throws(
        () => resolvingManager.switchSession(second.id),
        /resolver failed/,
      );
      assert.deepEqual(resolvingManager.getCurrent(), beforeResolve);
      assert.equal(realStore.getActiveSessionId(), first.id);
      failResolve = false;

      let failSetActive = true;
      const failingStore: HistoryStore = {
        ...realStore,
        setActiveSessionId(sessionId) {
          if (failSetActive) throw new Error("active write failed");
          realStore.setActiveSessionId(sessionId);
        },
      };
      const manager = managerFor(failingStore);
      const beforeStore = manager.getCurrent();
      assert.throws(() => manager.switchSession(second.id), /active write failed/);
      assert.deepEqual(manager.getCurrent(), beforeStore);
      assert.equal(realStore.getActiveSessionId(), first.id);
      assert.throws(() => manager.startNew(openCodeModel), /active write failed/);
      assert.deepEqual(manager.getCurrent(), beforeStore);
      failSetActive = false;
    } finally {
      realStore.close();
    }
  });
});

test("does not update state or global default when store mutations fail", async () => {
  await withHistoryPath(async (databasePath) => {
    const realStore = createHistoryStore(databasePath);
    const stored = createStoredSession(realStore);
    let failedOperation: "commit" | "model" | "summary" | "delete" | undefined;
    const failingStore: HistoryStore = {
      ...realStore,
      commitTurn(input) {
        if (failedOperation === "commit") throw new Error("commit failed");
        return realStore.commitTurn(input);
      },
      updateSessionModel(...args) {
        if (failedOperation === "model") throw new Error("model failed");
        return realStore.updateSessionModel(...args);
      },
      saveSummary(input) {
        if (failedOperation === "summary") throw new Error("summary failed");
        return realStore.saveSummary(input);
      },
      deleteSession(...args) {
        if (failedOperation === "delete") throw new Error("delete failed");
        realStore.deleteSession(...args);
      },
    };
    try {
      const manager = managerFor(failingStore);
      for (const operation of ["commit", "model", "summary", "delete"] as const) {
        failedOperation = operation;
        const before = manager.getCurrent();
        if (operation === "commit") {
          assert.throws(() => manager.commitTurn(FIRST_TURN), /commit failed/);
        } else if (operation === "model") {
          assert.throws(() => manager.setModel(openCodeModel), /model failed/);
        } else if (operation === "summary") {
          assert.throws(() => manager.saveSummary(1, "summary"), /summary failed/);
        } else {
          assert.throws(() => manager.deleteCurrent(), /delete failed/);
        }
        assert.deepEqual(manager.getCurrent(), before);
        assert.equal(realStore.loadSession(stored.id)?.revision, 1);
      }

      failedOperation = undefined;
      manager.deleteCurrent();
      assert.equal(manager.getModel()?.id, deepSeekModel.id);
    } finally {
      realStore.close();
    }
  });
});
