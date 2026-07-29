import assert from "node:assert/strict";
import fs from "node:fs";
import { stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createHistoryStore,
  type CommitTurnInput,
  type SaveSummaryInput,
} from "../src/history/store.js";
import { applyPlanAction } from "../src/planning/state.js";
import type { PersistedMessage } from "../src/history/types.js";
import { withHistoryPath } from "./history-fixture.js";

const COMPLETE_TURN: PersistedMessage[] = [
  { role: "user", content: "请计算 6*7" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-1",
        name: "calculator",
        argumentsJson: '{"expression":"6*7"}',
      },
    ],
    reasoning: {
      providerId: "deepseek",
      field: "reasoning_content",
      text: "需要计算",
      details: [{ step: 1 }],
    },
  },
  { role: "tool", toolCallId: "call-1", content: "42" },
  { role: "assistant", content: "答案是 42。", toolCalls: [] },
];

function createFirstTurn(
  store: ReturnType<typeof createHistoryStore>,
  title = "第一杯咖啡",
) {
  return store.commitTurn({
    title,
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messages: COMPLETE_TURN,
  });
}

async function expectCorruptedSession(
  corrupt: (
    database: Database.Database,
    sessionId: string,
    firstTurnId: string,
  ) => void,
): Promise<void> {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const first = createFirstTurn(store);
    store.close();

    const database = new Database(databasePath);
    try {
      corrupt(database, first.id, first.turn.id);
    } finally {
      database.close();
    }

    const reopened = createHistoryStore(databasePath);
    try {
      assert.throws(
        () => reopened.loadSession(first.id),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /历史数据损坏/);
          assert.doesNotMatch(
            error.message,
            /TOP_SECRET_CORRUPT_SEQUENCE_1942/,
          );
          return true;
        },
      );
    } finally {
      reopened.close();
    }
  });
}

test("creates and round-trips a complete first turn, then lists the session", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);

      assert.equal(first.revision, 1);
      assert.equal(first.turn.sequence, 1);
      assert.equal(store.getActiveSessionId(), first.id);

      const loaded = store.loadSession(first.id);
      assert.equal(loaded?.id, first.id);
      assert.equal(loaded?.title, "第一杯咖啡");
      assert.equal(loaded?.providerId, "deepseek");
      assert.equal(loaded?.modelId, "deepseek-v4-flash");
      assert.equal(loaded?.revision, 1);
      assert.deepEqual(loaded?.turns, [first.turn]);
      assert.deepEqual(loaded?.turns[0]?.messages, COMPLETE_TURN);
      assert.deepEqual(store.listSessions(), [
        {
          id: first.id,
          title: "第一杯咖啡",
          providerId: "deepseek",
          modelId: "deepseek-v4-flash",
          messageCount: 4,
          updatedAt: loaded?.updatedAt,
        },
      ]);
    } finally {
      store.close();
    }
  });
});

test("owns one planning store that closes with the shared history connection", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const session = createFirstTurn(store);
    const plan = store.plans.create({
      session: {
        kind: "existing",
        id: session.id,
        expectedRevision: session.revision,
        expectedCurrentPlan: null,
      },
      plan: {
        id: "close-plan",
        goal: "验证关闭行为",
        now: "2026-07-27T10:00:00.000Z",
        steps: [
          {
            id: "one",
            title: "第一步",
            successCriteria: "完成一",
            dependsOn: [],
          },
          {
            id: "two",
            title: "第二步",
            successCriteria: "完成二",
            dependsOn: ["one"],
          },
        ],
      },
    }).plan;
    const next = applyPlanAction(
      plan,
      { type: "start_step", stepId: "one" },
      "2026-07-27T10:01:00.000Z",
    );
    store.close();
    store.close();

    const operations = [
      () => store.plans.loadForSession(session.id),
      () =>
        store.plans.create({
          session: {
            kind: "existing" as const,
            id: session.id,
            expectedRevision: session.revision,
            expectedCurrentPlan: null,
          },
          plan: {
            id: "closed-plan",
            goal: "关闭后不能创建",
            now: "2026-07-27T10:02:00.000Z",
            steps: [
              {
                id: "a",
                title: "A",
                successCriteria: "A 完成",
                dependsOn: [],
              },
              {
                id: "b",
                title: "B",
                successCriteria: "B 完成",
                dependsOn: ["a"],
              },
            ],
          },
        }),
      () => store.plans.save(next, plan.revision),
      () => store.plans.cancel(session.id, plan.revision, "later"),
    ];
    for (const operation of operations) {
      assert.throws(operation, /历史数据库已经关闭/);
    }
  });
});

test("history and planning operations prepare statements on the same Database", async () => {
  await withHistoryPath(async (databasePath) => {
    const databasePrototype = Database.prototype as Database.Database & {
      prepare: Database.Database["prepare"];
    };
    const originalPrepare = databasePrototype.prepare;
    let historyConnection: unknown;
    let planningConnection: unknown;
    databasePrototype.prepare = function patchedPrepare(
      this: Database.Database,
      source: string,
    ) {
      if (source.includes("INSERT INTO turns")) historyConnection = this;
      if (source.includes("INSERT INTO task_plans")) planningConnection = this;
      return originalPrepare.call(this, source);
    } as Database.Database["prepare"];

    const store = createHistoryStore(databasePath);
    try {
      const session = createFirstTurn(store);
      store.plans.create({
        session: {
          kind: "existing",
          id: session.id,
          expectedRevision: session.revision,
          expectedCurrentPlan: null,
        },
        plan: {
          id: "same-connection-plan",
          goal: "验证共享连接",
          now: "2026-07-27T10:00:00.000Z",
          steps: [
            {
              id: "one",
              title: "第一步",
              successCriteria: "完成一",
              dependsOn: [],
            },
            {
              id: "two",
              title: "第二步",
              successCriteria: "完成二",
              dependsOn: ["one"],
            },
          ],
        },
      });
      assert.ok(historyConnection);
      assert.equal(planningConnection, historyConnection);
    } finally {
      databasePrototype.prepare = originalPrepare;
      store.close();
    }
  });
});

test("appends sequence two at revision two and orders session list by recency", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const older = createFirstTurn(store, "旧会话");
      await delay(5);
      const newer = createFirstTurn(store, "新会话");
      await delay(5);
      const second = store.commitTurn({
        sessionId: older.id,
        expectedRevision: older.revision,
        title: "旧会话标题不会被续写覆盖",
        providerId: "openai",
        modelId: "gpt-next",
        messages: [
          { role: "user", content: "继续" },
          { role: "assistant", content: "继续完成", toolCalls: [] },
        ],
      });

      assert.equal(second.revision, 2);
      assert.equal(second.turn.sequence, 2);
      assert.deepEqual(
        store.loadSession(older.id)?.turns.map((turn) => turn.sequence),
        [1, 2],
      );
      assert.deepEqual(
        store.listSessions().map((item) => ({
          id: item.id,
          title: item.title,
          modelId: item.modelId,
          messageCount: item.messageCount,
        })),
        [
          {
            id: older.id,
            title: "旧会话",
            modelId: "gpt-next",
            messageCount: 6,
          },
          {
            id: newer.id,
            title: "新会话",
            modelId: "deepseek-v4-flash",
            messageCount: 4,
          },
        ],
      );
    } finally {
      store.close();
    }
  });
});

test("loads session metadata, turns, and summary from one WAL snapshot", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    const probe = new Database(":memory:");
    const statementPrototype = Object.getPrototypeOf(
      probe.prepare("SELECT 1"),
    ) as {
      get: (this: { source: string }, ...params: unknown[]) => unknown;
    };
    probe.close();
    const originalGet = statementPrototype.get;
    try {
      const first = createFirstTurn(storeA);
      let injected = false;
      statementPrototype.get = function patchedGet(...params: unknown[]) {
        const result = originalGet.apply(this, params);
        if (
          !injected &&
          this.source.includes("FROM sessions WHERE id = ?")
        ) {
          injected = true;
          storeB.commitTurn({
            sessionId: first.id,
            expectedRevision: first.revision,
            title: "ignored",
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            messages: [{ role: "user", content: "并发写入" }],
          });
        }
        return result;
      };

      const duringWrite = storeA.loadSession(first.id);
      assert.equal(injected, true);
      assert.equal(duringWrite?.revision, 1);
      assert.equal(duringWrite?.turns.length, 1);

      statementPrototype.get = originalGet;
      const afterWrite = storeA.loadSession(first.id);
      assert.equal(afterWrite?.revision, 2);
      assert.equal(afterWrite?.turns.length, 2);
    } finally {
      statementPrototype.get = originalGet;
      storeB.close();
      storeA.close();
    }
  });
});

test("clears active session and lets the foreign key reject an unknown id", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);
      store.setActiveSessionId(undefined);
      assert.equal(store.getActiveSessionId(), undefined);

      assert.throws(
        () => store.setActiveSessionId("missing-session"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /无法设置活动会话/);
          assert.doesNotMatch(error.message, /missing-session/);
          assert.equal(
            (error.cause as { code?: unknown } | undefined)?.code,
            "SQLITE_CONSTRAINT_FOREIGNKEY",
          );
          return true;
        },
      );
      assert.equal(store.getActiveSessionId(), undefined);
      assert.deepEqual(store.listSessions().map(({ id }) => id), [first.id]);
    } finally {
      store.close();
    }
  });
});

test("rejects stale commit, model, summary, and delete without partial changes", async () => {
  await withHistoryPath(async (databasePath) => {
    const storeA = createHistoryStore(databasePath);
    const storeB = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(storeA);

      assert.equal(
        storeA.updateSessionModel(first.id, 1, "provider-a", "model-a"),
        2,
      );
      assert.throws(
        () =>
          storeB.commitTurn({
            sessionId: first.id,
            expectedRevision: 1,
            title: "ignored",
            providerId: "stale-provider",
            modelId: "stale-model",
            messages: [{ role: "user", content: "不应写入" }],
          }),
        /其他 Coffee 进程.*\/sessions.*重新打开/,
      );
      assert.equal(storeA.loadSession(first.id)?.turns.length, 1);

      assert.equal(
        storeA.updateSessionModel(first.id, 2, "provider-b", "model-b"),
        3,
      );
      assert.throws(
        () => storeB.updateSessionModel(first.id, 2, "stale", "stale"),
        /其他 Coffee 进程/,
      );
      assert.equal(storeA.loadSession(first.id)?.modelId, "model-b");

      assert.equal(
        storeA.updateSessionModel(first.id, 3, "provider-c", "model-c"),
        4,
      );
      assert.throws(
        () =>
          storeB.saveSummary({
            sessionId: first.id,
            expectedRevision: 3,
            throughTurnSequence: 1,
            content: "不应保存",
          }),
        /其他 Coffee 进程/,
      );
      assert.equal(storeA.loadSession(first.id)?.summary, undefined);

      assert.equal(
        storeA.updateSessionModel(first.id, 4, "provider-d", "model-d"),
        5,
      );
      assert.throws(
        () => storeB.deleteSession(first.id, 4),
        /其他 Coffee 进程/,
      );
      assert.equal(storeA.loadSession(first.id)?.revision, 5);
      assert.equal(storeA.getActiveSessionId(), first.id);
    } finally {
      storeB.close();
      storeA.close();
    }
  });
});

test("encodes reentrant messages before the optimistic write transaction", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);
      let triggered = false;
      let nestedRevision: number | undefined;
      const outerMessage = new Proxy<PersistedMessage>(
        { role: "user", content: "outer 不应提交" },
        {
          getOwnPropertyDescriptor(target, property) {
            if (!triggered && property === "role") {
              triggered = true;
              const currentRevision = store.loadSession(first.id)!.revision;
              nestedRevision = store.commitTurn({
                sessionId: first.id,
                expectedRevision: currentRevision,
                title: "ignored",
                providerId: "deepseek",
                modelId: "deepseek-v4-flash",
                messages: [{ role: "user", content: "nested 已提交" }],
              }).revision;
            }
            return Reflect.getOwnPropertyDescriptor(target, property);
          },
        },
      );

      assert.throws(
        () =>
          store.commitTurn({
            sessionId: first.id,
            expectedRevision: first.revision,
            title: "ignored",
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            messages: [outerMessage],
          }),
        /其他 Coffee 进程/,
      );

      assert.equal(triggered, true);
      assert.equal(nestedRevision, 2);
      const loaded = store.loadSession(first.id);
      assert.equal(loaded?.revision, 2);
      assert.equal(loaded?.turns.length, 2);
      assert.deepEqual(loaded?.turns[1]?.messages, [
        { role: "user", content: "nested 已提交" },
      ]);
      assert.equal(store.listSessions()[0]?.messageCount, 5);
      assert.equal(store.getActiveSessionId(), first.id);
    } finally {
      store.close();
    }
  });
});

test("rolls back an existing-session revision before an invalid message", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store, "目标会话");
      const active = createFirstTurn(store, "当前会话");
      const invalid = {
        role: "assistant",
        content: "TOP_SECRET_API_KEY_1942",
      } as unknown as PersistedMessage;

      assert.throws(
        () =>
          store.commitTurn({
            sessionId: first.id,
            expectedRevision: first.revision,
            title: "ignored",
            providerId: "changed-provider",
            modelId: "changed-model",
            messages: [invalid],
          }),
        (error: unknown) => {
          assert.match(String(error), /历史消息数据损坏/);
          assert.doesNotMatch(String(error), /TOP_SECRET_API_KEY_1942/);
          return true;
        },
      );

      const loaded = store.loadSession(first.id);
      assert.equal(loaded?.revision, 1);
      assert.equal(loaded?.providerId, "deepseek");
      assert.equal(loaded?.modelId, "deepseek-v4-flash");
      assert.equal(loaded?.turns.length, 1);
      assert.equal(store.getActiveSessionId(), active.id);
    } finally {
      store.close();
    }
  });
});

test("rejects sparse message arrays and rolls back new and existing sessions", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const sparseNew = new Array<PersistedMessage>(1);
      assert.throws(
        () =>
          store.commitTurn({
            title: "不能创建",
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            messages: sparseNew,
          }),
        /消息.*实际存在/,
      );
      assert.deepEqual(store.listSessions(), []);
      assert.equal(store.getActiveSessionId(), undefined);

      const first = createFirstTurn(store);
      const sessionBefore = store.loadSession(first.id);
      const listBefore = store.listSessions();
      const activeBefore = store.getActiveSessionId();
      const sparseExisting = new Array<PersistedMessage>(2);
      sparseExisting[0] = {
        role: "user",
        content: "TOP_SECRET_SPARSE_MESSAGE_1942",
      };

      assert.throws(
        () =>
          store.commitTurn({
            sessionId: first.id,
            expectedRevision: first.revision,
            title: "ignored",
            providerId: "changed-provider",
            modelId: "changed-model",
            messages: sparseExisting,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /消息.*实际存在/);
          assert.doesNotMatch(error.message, /TOP_SECRET_SPARSE_MESSAGE_1942/);
          return true;
        },
      );

      assert.deepEqual(store.loadSession(first.id), sessionBefore);
      assert.deepEqual(store.listSessions(), listBefore);
      assert.equal(store.getActiveSessionId(), activeBefore);
    } finally {
      store.close();
    }
  });
});

test("snapshots commit input without re-reading a dynamic messages Proxy", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const secret = "TOP_SECRET_MESSAGES_PROXY_1942";
    let lengthReads = 0;
    const messages = new Proxy<PersistedMessage[]>(
      [{ role: "user", content: "不能提交空 turn" }],
      {
        get(target, property, receiver) {
          if (property === "length") {
            lengthReads += 1;
            return lengthReads === 1 ? 1 : 0;
          }
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      },
    );

    try {
      assert.throws(
        () =>
          store.commitTurn({
            title: "动态输入",
            providerId: "deepseek",
            modelId: "deepseek-v4-flash",
            messages,
          }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /提交轮次参数.*安全/);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        },
      );
      assert.equal(lengthReads, 0);
      assert.deepEqual(store.listSessions(), []);
      assert.equal(store.getActiveSessionId(), undefined);
    } finally {
      store.close();
    }
  });
});

test("snapshots summary input without invoking a changing content getter", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);
      const before = store.loadSession(first.id);
      const secret = "TOP_SECRET_SUMMARY_GETTER_1942";
      let contentReads = 0;
      const input = Object.defineProperties(
        {},
        {
          sessionId: { enumerable: true, value: first.id },
          expectedRevision: { enumerable: true, value: first.revision },
          throughTurnSequence: { enumerable: true, value: 1 },
          content: {
            enumerable: true,
            get() {
              contentReads += 1;
              if (contentReads === 1) return "第一次读取";
              throw new Error(secret);
            },
          },
        },
      ) as SaveSummaryInput;

      assert.throws(
        () => store.saveSummary(input),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /保存摘要参数.*安全/);
          assert.doesNotMatch(error.message, new RegExp(secret));
          return true;
        },
      );
      assert.equal(contentReads, 0);
      assert.deepEqual(store.loadSession(first.id), before);
    } finally {
      store.close();
    }
  });
});

test("rejects accessor inputs despite an inherited descriptor value getter", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);
      const before = store.loadSession(first.id);
      const secret = "TOP_SECRET_DESCRIPTOR_VALUE_GETTER_1942";
      let prototypeValueReads = 0;
      let titleReads = 0;
      let contentReads = 0;
      const commitInput: CommitTurnInput = {
        get title() {
          titleReads += 1;
          return "不能读取";
        },
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "不能提交" }],
      };
      const summaryInput: SaveSummaryInput = {
        sessionId: first.id,
        expectedRevision: first.revision,
        throughTurnSequence: 1,
        get content() {
          contentReads += 1;
          return "不能读取";
        },
      };
      const previousValue = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "value",
      );
      let commitError: unknown;
      let summaryError: unknown;

      Object.defineProperty(Object.prototype, "value", {
        configurable: true,
        get() {
          prototypeValueReads += 1;
          throw new Error(secret);
        },
      });
      try {
        try {
          store.commitTurn(commitInput);
        } catch (error) {
          commitError = error;
        }
        try {
          store.saveSummary(summaryInput);
        } catch (error) {
          summaryError = error;
        }
      } finally {
        if (previousValue === undefined) {
          delete (Object.prototype as { value?: unknown }).value;
        } else {
          Object.defineProperty(Object.prototype, "value", previousValue);
        }
      }

      for (const [error, pattern] of [
        [commitError, /提交轮次参数.*安全/],
        [summaryError, /保存摘要参数.*安全/],
      ] as const) {
        assert.ok(error instanceof Error);
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, new RegExp(secret));
      }
      assert.equal(prototypeValueReads, 0);
      assert.equal(titleReads, 0);
      assert.equal(contentReads, 0);
      assert.deepEqual(store.loadSession(first.id), before);
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.getActiveSessionId(), first.id);
    } finally {
      store.close();
    }
  });
});

test("upserts summaries while preserving createdAt and recording source revision", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const first = createFirstTurn(store);
      const saved = store.saveSummary({
        sessionId: first.id,
        expectedRevision: 1,
        throughTurnSequence: 1,
        content: "第一版摘要",
      });
      assert.equal(saved.revision, 2);
      assert.deepEqual(store.loadSession(first.id)?.summary, saved.summary);
      assert.equal(saved.summary.sourceRevision, 1);

      await delay(5);
      const updated = store.saveSummary({
        sessionId: first.id,
        expectedRevision: 2,
        throughTurnSequence: 2,
        content: "第二版摘要",
      });
      assert.equal(updated.revision, 3);
      assert.equal(updated.summary.createdAt, saved.summary.createdAt);
      assert.notEqual(updated.summary.updatedAt, saved.summary.updatedAt);
      assert.deepEqual(updated.summary, {
        throughTurnSequence: 2,
        content: "第二版摘要",
        sourceRevision: 2,
        createdAt: saved.summary.createdAt,
        updatedAt: updated.summary.updatedAt,
      });
      assert.deepEqual(store.loadSession(first.id)?.summary, updated.summary);
    } finally {
      store.close();
    }
  });
});

test("deletes turns, messages, and summary by cascade and clears active", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const first = createFirstTurn(store);
    const summary = store.saveSummary({
      sessionId: first.id,
      expectedRevision: 1,
      throughTurnSequence: 1,
      content: "待级联删除",
    });
    store.deleteSession(first.id, summary.revision);
    assert.equal(store.loadSession(first.id), undefined);
    assert.equal(store.getActiveSessionId(), undefined);
    store.close();

    const database = new Database(databasePath, { readonly: true });
    try {
      for (const table of [
        "sessions",
        "turns",
        "messages",
        "session_summaries",
      ]) {
        assert.equal(
          database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(),
          0,
        );
      }
    } finally {
      database.close();
    }
  });
});

test("reports corrupted stored JSON safely without exposing persisted secrets", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const first = createFirstTurn(store);
    store.close();

    const database = new Database(databasePath);
    database
      .prepare(
        "UPDATE messages SET tool_calls_json = ? " +
          "WHERE turn_id = ? AND role = 'assistant' LIMIT 1",
      )
      .run("{TOP_SECRET_DATABASE_VALUE_1942", first.turn.id);
    database.close();

    const reopened = createHistoryStore(databasePath);
    try {
      assert.throws(
        () => reopened.loadSession(first.id),
        (error: unknown) => {
          assert.match(String(error), /历史消息数据损坏/);
          assert.doesNotMatch(String(error), /TOP_SECRET_DATABASE_VALUE_1942/);
          return true;
        },
      );
    } finally {
      reopened.close();
    }
  });
});

test("rejects a stored turn without messages", async () => {
  await expectCorruptedSession((database, sessionId) => {
    database
      .prepare(
        "INSERT INTO turns(id, session_id, sequence, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run("empty-turn", sessionId, 2, "now");
  });
});

test("rejects a gap in stored turn sequences", async () => {
  await expectCorruptedSession((database, sessionId) => {
    database
      .prepare(
        "INSERT INTO turns(id, session_id, sequence, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run("turn-gap", sessionId, 3, "now");
    database
      .prepare(
        "INSERT INTO messages(id, turn_id, sequence, role, content) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "turn-gap-message",
        "turn-gap",
        1,
        "user",
        "TOP_SECRET_CORRUPT_SEQUENCE_1942",
      );
  });
});

test("rejects a gap in stored message sequences", async () => {
  await expectCorruptedSession((database, sessionId) => {
    database
      .prepare(
        "INSERT INTO turns(id, session_id, sequence, created_at) " +
          "VALUES (?, ?, ?, ?)",
      )
      .run("message-gap-turn", sessionId, 2, "now");
    database
      .prepare(
        "INSERT INTO messages(id, turn_id, sequence, role, content) " +
          "VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "message-gap",
        "message-gap-turn",
        2,
        "user",
        "TOP_SECRET_CORRUPT_SEQUENCE_1942",
      );
  });
});

test("does not share nested message references with inputs, results, or later loads", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const input = structuredClone(COMPLETE_TURN) as PersistedMessage[];
      const first = store.commitTurn({
        title: "深克隆",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        messages: input,
      });
      const inputAssistant = input[1] as unknown as {
        toolCalls: Array<{ name: string }>;
        reasoning: { details: Array<{ step: number }> };
      };
      const resultAssistant = first.turn.messages[1] as unknown as {
        toolCalls: Array<{ name: string }>;
        reasoning: { details: Array<{ step: number }> };
      };
      inputAssistant.toolCalls[0]!.name = "changed-input";
      inputAssistant.reasoning.details[0]!.step = 2;
      resultAssistant.toolCalls[0]!.name = "changed-result";
      resultAssistant.reasoning.details[0]!.step = 3;

      const loaded = store.loadSession(first.id)!;
      assert.deepEqual(loaded.turns[0]?.messages, COMPLETE_TURN);
      const loadedAssistant = loaded.turns[0]!.messages[1] as unknown as {
        toolCalls: Array<{ name: string }>;
        reasoning: { details: Array<{ step: number }> };
      };
      loadedAssistant.toolCalls[0]!.name = "changed-load";
      loadedAssistant.reasoning.details[0]!.step = 4;
      assert.deepEqual(
        store.loadSession(first.id)?.turns[0]?.messages,
        COMPLETE_TURN,
      );
    } finally {
      store.close();
    }
  });
});

test("keeps SQLite main and sidecar files private and closes idempotently", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    createFirstTurn(store);

    for (const filePath of [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
    ]) {
      assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    }

    assert.doesNotThrow(() => store.close());
    assert.doesNotThrow(() => store.close());
  });
});

test("rolls back all writes when file permission tightening fails before commit", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    const originalChmodSync = fs.chmodSync;
    fs.chmodSync = ((filePath, mode) => {
      if (path.resolve(String(filePath)) === databasePath) {
        throw new Error("permission fixture failure");
      }
      originalChmodSync(filePath, mode);
    }) as typeof fs.chmodSync;
    syncBuiltinESMExports();

    try {
      assert.throws(() => createFirstTurn(store), /permission fixture failure/);
    } finally {
      fs.chmodSync = originalChmodSync;
      syncBuiltinESMExports();
    }

    try {
      assert.deepEqual(store.listSessions(), []);
      assert.equal(store.getActiveSessionId(), undefined);
    } finally {
      store.close();
    }
  });
});
