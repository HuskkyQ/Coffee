import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  decodeMessageRow,
  encodeMessage,
  type MessageRow,
} from "./message-codec.js";
import {
  DEFAULT_HISTORY_PATH,
  openHistoryDatabase,
  secureHistoryFiles,
} from "./sqlite.js";
import {
  createPlanningStore,
  type PlanningStore,
} from "../planning/store.js";
import type {
  PersistedMessage,
  SessionListItem,
  StoredSession,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export interface CommitTurnInput {
  readonly sessionId?: string;
  readonly expectedRevision?: number;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly PersistedMessage[];
}

export interface CommitTurnResult {
  readonly id: string;
  readonly revision: number;
  readonly turn: StoredTurn;
}

export interface SaveSummaryInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly throughTurnSequence: number;
  readonly content: string;
}

export interface HistoryStore {
  readonly plans: PlanningStore;
  getActiveSessionId(): string | undefined;
  setActiveSessionId(sessionId: string | undefined): void;
  loadSession(sessionId: string): StoredSession | undefined;
  listSessions(): readonly SessionListItem[];
  commitTurn(input: CommitTurnInput): CommitTurnResult;
  updateSessionModel(
    sessionId: string,
    expectedRevision: number,
    providerId: string,
    modelId: string,
  ): number;
  saveSummary(input: SaveSummaryInput): {
    revision: number;
    summary: StoredSummary;
  };
  deleteSession(sessionId: string, expectedRevision: number): void;
  close(): void;
}

interface SessionRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly provider_id: unknown;
  readonly model_id: unknown;
  readonly revision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface TurnMessageRow extends MessageRow {
  readonly turn_id: unknown;
  readonly turn_sequence: unknown;
  readonly turn_created_at: unknown;
  readonly message_id: unknown;
  readonly message_sequence: unknown;
}

interface SummaryRow {
  readonly through_turn_sequence: unknown;
  readonly content: unknown;
  readonly source_revision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface ListRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly provider_id: unknown;
  readonly model_id: unknown;
  readonly message_count: unknown;
  readonly updated_at: unknown;
}

interface CommitTurnSnapshot {
  readonly sessionId?: string;
  readonly expectedRevision?: number;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly unknown[];
}

interface SaveSummarySnapshot {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly throughTurnSequence: number;
  readonly content: string;
}

const CONFLICT_MESSAGE =
  "该会话已被其他 Coffee 进程修改，请使用 /sessions 重新打开。";
const ABSENT = Symbol("absent");

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field}必须是非空字符串。`);
  }
  return value;
}

function stringValue(value: unknown, detail: string): string {
  if (typeof value !== "string") throw new Error(`历史数据损坏：${detail}。`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field}必须是正整数。`);
  }
  return value as number;
}

function storedPositiveInteger(value: unknown, detail: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`历史数据损坏：${detail}。`);
  }
  return value as number;
}

function unsafeInput(operation: string): never {
  throw new Error(`${operation}无法安全读取。`);
}

function safePrototypeOf(
  value: object,
  operation: string,
): object | null {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return unsafeInput(operation);
  }
  return prototype;
}

function ownDataValue(
  value: object,
  key: PropertyKey,
  operation: string,
  required: boolean,
): unknown | typeof ABSENT {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return unsafeInput(operation);
  }
  if (descriptor === undefined) {
    if (required) return unsafeInput(operation);
    return ABSENT;
  }
  if (!Object.hasOwn(descriptor, "value")) return unsafeInput(operation);
  return descriptor.value;
}

function snapshotMessages(value: unknown): readonly unknown[] {
  const operation = "提交轮次参数";
  if (!Array.isArray(value)) return unsafeInput(operation);
  if (safePrototypeOf(value, operation) !== Array.prototype) {
    return unsafeInput(operation);
  }
  const length = ownDataValue(value, "length", operation, true);
  if (!Number.isSafeInteger(length) || (length as number) < 1) {
    throw new Error("提交轮次至少需要一条消息。");
  }

  const messages: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const message = ownDataValue(value, String(index), operation, false);
    if (message === ABSENT || message === undefined) {
      throw new Error(
        `第 ${index + 1} 条历史消息必须是实际存在的消息。`,
      );
    }
    messages.push(message);
  }
  return messages;
}

function snapshotCommitTurnInput(input: CommitTurnInput): CommitTurnSnapshot {
  const operation = "提交轮次参数";
  if (typeof input !== "object" || input === null) return unsafeInput(operation);
  const prototype = safePrototypeOf(input, operation);
  if (prototype !== Object.prototype && prototype !== null) {
    return unsafeInput(operation);
  }

  const sessionIdValue = ownDataValue(
    input,
    "sessionId",
    operation,
    false,
  );
  const expectedRevisionValue = ownDataValue(
    input,
    "expectedRevision",
    operation,
    false,
  );
  const titleValue = ownDataValue(input, "title", operation, true);
  const providerIdValue = ownDataValue(input, "providerId", operation, true);
  const modelIdValue = ownDataValue(input, "modelId", operation, true);
  const messagesValue = ownDataValue(input, "messages", operation, true);

  const sessionId =
    sessionIdValue === ABSENT || sessionIdValue === undefined
      ? undefined
      : nonEmptyString(sessionIdValue, "会话 ID");
  const expectedRevision =
    expectedRevisionValue === ABSENT || expectedRevisionValue === undefined
      ? undefined
      : positiveInteger(expectedRevisionValue, "revision");
  const title = nonEmptyString(titleValue, "会话标题");
  const providerId = nonEmptyString(providerIdValue, "provider ID");
  const modelId = nonEmptyString(modelIdValue, "model ID");
  const messages = snapshotMessages(messagesValue);

  if (sessionId === undefined && expectedRevision !== undefined) {
    throw new Error("新会话不能指定 revision。");
  }
  if (sessionId !== undefined && expectedRevision === undefined) {
    throw new Error("持久化会话缺少 revision。");
  }
  return {
    sessionId,
    expectedRevision,
    title,
    providerId,
    modelId,
    messages,
  };
}

function snapshotSaveSummaryInput(input: SaveSummaryInput): SaveSummarySnapshot {
  const operation = "保存摘要参数";
  if (typeof input !== "object" || input === null) return unsafeInput(operation);
  const prototype = safePrototypeOf(input, operation);
  if (prototype !== Object.prototype && prototype !== null) {
    return unsafeInput(operation);
  }

  const sessionIdValue = ownDataValue(input, "sessionId", operation, true);
  const expectedRevisionValue = ownDataValue(
    input,
    "expectedRevision",
    operation,
    true,
  );
  const throughTurnSequenceValue = ownDataValue(
    input,
    "throughTurnSequence",
    operation,
    true,
  );
  const contentValue = ownDataValue(input, "content", operation, true);

  if (typeof contentValue !== "string") {
    throw new Error("摘要内容必须是字符串。");
  }
  return {
    sessionId: nonEmptyString(sessionIdValue, "会话 ID"),
    expectedRevision: positiveInteger(expectedRevisionValue, "revision"),
    throughTurnSequence: positiveInteger(
      throughTurnSequenceValue,
      "摘要覆盖轮次",
    ),
    content: contentValue,
  };
}

function safeReadError(operation: string, error: unknown): never {
  if (
    error instanceof Error &&
    (error.message.startsWith("历史消息数据损坏：") ||
      error.message.startsWith("历史数据损坏："))
  ) {
    throw error;
  }
  throw new Error(`${operation}失败：历史数据无效或数据库无法读取。`, {
    cause: error,
  });
}

function summaryFromRow(row: SummaryRow): StoredSummary {
  return {
    throughTurnSequence: storedPositiveInteger(
      row.through_turn_sequence,
      "摘要覆盖轮次无效",
    ),
    content: stringValue(row.content, "摘要内容无效"),
    sourceRevision: storedPositiveInteger(
      row.source_revision,
      "摘要来源 revision 无效",
    ),
    createdAt: stringValue(row.created_at, "摘要创建时间无效"),
    updatedAt: stringValue(row.updated_at, "摘要更新时间无效"),
  };
}

export function createHistoryStore(
  databasePath = DEFAULT_HISTORY_PATH,
): HistoryStore {
  const absoluteDatabasePath = path.resolve(databasePath);
  const database = openHistoryDatabase(absoluteDatabasePath);
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error("历史数据库已经关闭。");
  }

  function mutate<T>(operation: () => T): T {
    assertOpen();
    return database.transaction(() => {
      const result = operation();
      secureHistoryFiles(absoluteDatabasePath);
      return result;
    })();
  }

  function getActiveSessionId(): string | undefined {
    assertOpen();
    try {
      const row = database
        .prepare(
          "SELECT active_session_id FROM app_metadata WHERE singleton = 1",
        )
        .get() as { active_session_id: unknown } | undefined;
      if (row === undefined) throw new Error("缺少 singleton metadata 行");
      if (row.active_session_id === null) return undefined;
      return nonEmptyString(row.active_session_id, "活动会话 ID");
    } catch (error) {
      return safeReadError("读取活动会话", error);
    }
  }

  function setActiveSessionId(sessionId: string | undefined): void {
    if (sessionId !== undefined) nonEmptyString(sessionId, "会话 ID");
    try {
      mutate(() => {
        const updated = database
          .prepare(
            "UPDATE app_metadata SET active_session_id = ? WHERE singleton = 1",
          )
          .run(sessionId ?? null);
        if (updated.changes !== 1) {
          throw new Error("缺少 singleton metadata 行。");
        }
      });
    } catch (error) {
      throw new Error(
        "无法设置活动会话：会话不存在，或数据库权限/约束拒绝更新。",
        { cause: error },
      );
    }
  }

  function loadSession(sessionId: string): StoredSession | undefined {
    assertOpen();
    nonEmptyString(sessionId, "会话 ID");
    try {
      return database.transaction(() => {
        const session = database
        .prepare(
          "SELECT id, title, provider_id, model_id, revision, " +
            "created_at, updated_at FROM sessions WHERE id = ?",
        )
        .get(sessionId) as SessionRow | undefined;
        if (session === undefined) return undefined;

        const turnRows = database
        .prepare(
          `SELECT
             t.id AS turn_id,
             t.sequence AS turn_sequence,
             t.created_at AS turn_created_at,
             m.id AS message_id,
             m.sequence AS message_sequence,
             m.role,
             m.content,
             m.tool_call_id,
             m.tool_calls_json,
             m.reasoning_json
           FROM turns t
           LEFT JOIN messages m ON m.turn_id = t.id
           WHERE t.session_id = ?
           ORDER BY t.sequence, m.sequence`,
        )
        .all(sessionId) as TurnMessageRow[];

        const turns: StoredTurn[] = [];
        let currentTurn:
          | {
            id: string;
            sequence: number;
            createdAt: string;
            messages: PersistedMessage[];
          }
          | undefined;

        for (const row of turnRows) {
          const turnId = nonEmptyString(row.turn_id, "历史 turn ID");
          const turnSequence = storedPositiveInteger(
            row.turn_sequence,
            "turn sequence 无效",
          );
          if (currentTurn?.id !== turnId) {
            if (currentTurn !== undefined && currentTurn.messages.length === 0) {
              throw new Error("历史数据损坏：turn 不能没有消息。");
            }
            if (turnSequence !== turns.length + 1) {
              throw new Error(
                "历史数据损坏：turn sequence 必须从 1 连续递增。",
              );
            }
            currentTurn = {
              id: turnId,
              sequence: turnSequence,
              createdAt: stringValue(
                row.turn_created_at,
                "turn 创建时间无效",
              ),
              messages: [],
            };
            turns.push(currentTurn);
          }
          if (row.message_id === null) continue;
          nonEmptyString(row.message_id, "历史 message ID");
          const messageSequence = storedPositiveInteger(
            row.message_sequence,
            "message sequence 无效",
          );
          if (messageSequence !== currentTurn.messages.length + 1) {
            throw new Error(
              "历史数据损坏：message sequence 必须从 1 连续递增。",
            );
          }
          currentTurn.messages.push(
            decodeMessageRow({
              role: row.role,
              content: row.content,
              tool_call_id: row.tool_call_id,
              tool_calls_json: row.tool_calls_json,
              reasoning_json: row.reasoning_json,
            }),
          );
        }
        if (currentTurn !== undefined && currentTurn.messages.length === 0) {
          throw new Error("历史数据损坏：turn 不能没有消息。");
        }

        const summaryRow = database
          .prepare(
            "SELECT through_turn_sequence, content, source_revision, " +
              "created_at, updated_at FROM session_summaries " +
              "WHERE session_id = ?",
          )
          .get(sessionId) as SummaryRow | undefined;

        return {
          id: nonEmptyString(session.id, "历史会话 ID"),
          title: nonEmptyString(session.title, "历史会话标题"),
          providerId: nonEmptyString(session.provider_id, "历史 provider ID"),
          modelId: nonEmptyString(session.model_id, "历史 model ID"),
          revision: storedPositiveInteger(
            session.revision,
            "session revision 无效",
          ),
          createdAt: stringValue(session.created_at, "会话创建时间无效"),
          updatedAt: stringValue(session.updated_at, "会话更新时间无效"),
          turns,
          ...(summaryRow === undefined
            ? {}
            : { summary: summaryFromRow(summaryRow) }),
        };
      })();
    } catch (error) {
      return safeReadError("读取历史会话", error);
    }
  }

  function listSessions(): readonly SessionListItem[] {
    assertOpen();
    try {
      const rows = database
        .prepare(
          `SELECT
             s.id,
             s.title,
             s.provider_id,
             s.model_id,
             s.updated_at,
             COUNT(m.id) AS message_count
           FROM sessions s
           LEFT JOIN turns t ON t.session_id = s.id
           LEFT JOIN messages m ON m.turn_id = t.id
           GROUP BY s.id
           ORDER BY s.updated_at DESC, s.id DESC`,
        )
        .all() as ListRow[];
      return rows.map((row) => {
        if (!Number.isSafeInteger(row.message_count) || (row.message_count as number) < 0) {
          throw new Error("历史数据损坏：会话消息数量无效。");
        }
        return {
          id: nonEmptyString(row.id, "历史会话 ID"),
          title: nonEmptyString(row.title, "历史会话标题"),
          providerId: nonEmptyString(row.provider_id, "历史 provider ID"),
          modelId: nonEmptyString(row.model_id, "历史 model ID"),
          messageCount: row.message_count as number,
          updatedAt: stringValue(row.updated_at, "会话更新时间无效"),
        };
      });
    } catch (error) {
      return safeReadError("列出历史会话", error);
    }
  }

  function commitTurn(input: CommitTurnInput): CommitTurnResult {
    const snapshot = snapshotCommitTurnInput(input);
    const messageRows: MessageRow[] = [];
    for (const message of snapshot.messages) {
      messageRows.push(encodeMessage(message as PersistedMessage));
    }

    let committedTurn: StoredTurn | undefined;
    const committed = mutate(() => {
      const now = new Date().toISOString();
      const sessionId = snapshot.sessionId ?? randomUUID();
      let revision: number;

      if (snapshot.sessionId === undefined) {
        database
          .prepare(
            `INSERT INTO sessions(
               id, title, provider_id, model_id, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            sessionId,
            snapshot.title,
            snapshot.providerId,
            snapshot.modelId,
            now,
            now,
          );
        revision = 1;
      } else {
        const expectedRevision = snapshot.expectedRevision!;
        const updated = database
          .prepare(
            `UPDATE sessions
             SET revision = revision + 1,
                 updated_at = ?, provider_id = ?, model_id = ?
             WHERE id = ? AND revision = ?`,
          )
          .run(
            now,
            snapshot.providerId,
            snapshot.modelId,
            snapshot.sessionId,
            expectedRevision,
          );
        if (updated.changes !== 1) throw new Error(CONFLICT_MESSAGE);
        revision = expectedRevision + 1;
      }

      const sequence = (
        database
          .prepare(
            "SELECT COALESCE(MAX(sequence), 0) + 1 AS value " +
              "FROM turns WHERE session_id = ?",
          )
          .get(sessionId) as { value: unknown }
      ).value;
      const checkedSequence = storedPositiveInteger(
        sequence,
        "下一个 turn sequence 无效",
      );
      const turnId = randomUUID();
      database
        .prepare(
          "INSERT INTO turns(id, session_id, sequence, created_at) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(turnId, sessionId, checkedSequence, now);

      const insertMessage = database.prepare(
        `INSERT INTO messages(
           id, turn_id, sequence, role, content,
           tool_call_id, tool_calls_json, reasoning_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const persistedMessages: PersistedMessage[] = [];
      for (let index = 0; index < messageRows.length; index += 1) {
        const row = messageRows[index]!;
        insertMessage.run(
          randomUUID(),
          turnId,
          index + 1,
          row.role,
          row.content,
          row.tool_call_id,
          row.tool_calls_json,
          row.reasoning_json,
        );
        persistedMessages.push(decodeMessageRow(row));
      }
      const activated = database
        .prepare(
          "UPDATE app_metadata SET active_session_id = ? WHERE singleton = 1",
        )
        .run(sessionId);
      if (activated.changes !== 1) {
        throw new Error("无法更新活动会话：缺少 singleton metadata 行。");
      }

      committedTurn = {
        id: turnId,
        sequence: checkedSequence,
        createdAt: now,
        messages: persistedMessages,
      };
      return { id: sessionId, revision };
    });

    if (committedTurn === undefined) {
      throw new Error("轮次事务未返回提交结果。");
    }
    return { ...committed, turn: committedTurn };
  }

  function updateSessionModel(
    sessionId: string,
    expectedRevision: number,
    providerId: string,
    modelId: string,
  ): number {
    nonEmptyString(sessionId, "会话 ID");
    positiveInteger(expectedRevision, "revision");
    nonEmptyString(providerId, "provider ID");
    nonEmptyString(modelId, "model ID");
    return mutate(() => {
      const updated = database
        .prepare(
          `UPDATE sessions
           SET provider_id = ?, model_id = ?, updated_at = ?,
               revision = revision + 1
           WHERE id = ? AND revision = ?`,
        )
        .run(
          providerId,
          modelId,
          new Date().toISOString(),
          sessionId,
          expectedRevision,
        );
      if (updated.changes !== 1) throw new Error(CONFLICT_MESSAGE);
      return expectedRevision + 1;
    });
  }

  function saveSummary(input: SaveSummaryInput): {
    revision: number;
    summary: StoredSummary;
  } {
    const snapshot = snapshotSaveSummaryInput(input);

    return mutate(() => {
      const now = new Date().toISOString();
      const updated = database
        .prepare(
          `UPDATE sessions
           SET revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(now, snapshot.sessionId, snapshot.expectedRevision);
      if (updated.changes !== 1) throw new Error(CONFLICT_MESSAGE);

      database
        .prepare(
          `INSERT INTO session_summaries(
             session_id, through_turn_sequence, content,
             source_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             through_turn_sequence = excluded.through_turn_sequence,
             content = excluded.content,
             source_revision = excluded.source_revision,
             updated_at = excluded.updated_at`,
        )
        .run(
          snapshot.sessionId,
          snapshot.throughTurnSequence,
          snapshot.content,
          snapshot.expectedRevision,
          now,
          now,
        );
      const summaryRow = database
        .prepare(
          "SELECT through_turn_sequence, content, source_revision, " +
            "created_at, updated_at FROM session_summaries " +
            "WHERE session_id = ?",
        )
        .get(snapshot.sessionId) as SummaryRow | undefined;
      if (summaryRow === undefined) {
        throw new Error("摘要写入后无法读取。");
      }
      return {
        revision: snapshot.expectedRevision + 1,
        summary: summaryFromRow(summaryRow),
      };
    });
  }

  function deleteSession(sessionId: string, expectedRevision: number): void {
    nonEmptyString(sessionId, "会话 ID");
    positiveInteger(expectedRevision, "revision");
    mutate(() => {
      const deleted = database
        .prepare("DELETE FROM sessions WHERE id = ? AND revision = ?")
        .run(sessionId, expectedRevision);
      if (deleted.changes !== 1) throw new Error(CONFLICT_MESSAGE);
    });
  }

  function close(): void {
    if (closed) return;
    database.close();
    closed = true;
  }

  const plans = createPlanningStore({ database, assertOpen, mutate });

  return {
    plans,
    getActiveSessionId,
    setActiveSessionId,
    loadSession,
    listSessions,
    commitTurn,
    updateSessionModel,
    saveSummary,
    deleteSession,
    close,
  };
}
