import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import type Database from "better-sqlite3";

import { createTaskPlan, restoreTaskPlan } from "./state.js";
import type { TaskPlan, TaskStepDraft } from "./types.js";

export type PlanSessionInput =
  | {
      readonly kind: "existing";
      readonly id: string;
      readonly expectedRevision: number;
      readonly expectedCurrentPlan:
        | null
        | {
            readonly id: string;
            readonly revision: number;
          };
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
  cancel(
    sessionId: string,
    expectedRevision: number,
    now: string,
  ): TaskPlan;
}

interface PlanningStoreOptions {
  readonly database: Database.Database;
  readonly assertOpen: () => void;
  readonly mutate: <T>(operation: () => T) => T;
}

interface PlanRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly goal: unknown;
  readonly status: unknown;
  readonly revision: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

interface StepRow {
  readonly id: unknown;
  readonly position: unknown;
  readonly title: unknown;
  readonly success_criteria: unknown;
  readonly status: unknown;
  readonly depends_on_json: unknown;
  readonly retry_count: unknown;
  readonly result: unknown;
  readonly block_reason: unknown;
}

type PlainRecord = Record<string, unknown>;

const PLAN_CONFLICT =
  "该计划已被其他 Coffee 进程修改，请使用 /plan 重新查看。";
const ABSENT = Symbol("absent");
const stableWriteErrors = new WeakSet<Error>();

function unsafeInput(operation: string): never {
  throw new Error(`${operation}无法安全读取。`);
}

function recordSnapshot(
  value: unknown,
  operation: string,
  required: readonly string[],
): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return unsafeInput(operation);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return unsafeInput(operation);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return unsafeInput(operation);
  }
  const allowed = new Set(required);
  const snapshot: PlainRecord = Object.create(null) as PlainRecord;
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      return unsafeInput(operation);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return unsafeInput(operation);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return unsafeInput(operation);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) return unsafeInput(operation);
  }
  return snapshot;
}

function ownOptional(
  value: object,
  key: string,
  operation: string,
): unknown | typeof ABSENT {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return unsafeInput(operation);
  }
  if (descriptor === undefined) return ABSENT;
  if (!Object.hasOwn(descriptor, "value")) return unsafeInput(operation);
  return descriptor.value;
}

function boundedText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field}必须是字符串。`);
  }
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 1000) {
    throw new Error(`${field}长度必须在 1 到 1000 之间。`);
  }
  return normalized;
}

function stableWriteError(message: string): Error {
  const error = new Error(message);
  stableWriteErrors.add(error);
  return error;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field}必须是正整数。`);
  }
  return value as number;
}

function storedString(value: unknown): string {
  if (typeof value !== "string") throw new Error("计划数据损坏。");
  return value;
}

function storedPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("计划数据损坏。");
  }
  return value as number;
}

function storedNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("计划数据损坏。");
  }
  return value as number;
}

function dependsOnFromJson(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("计划数据损坏。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("计划数据损坏。");
  }
  if (
    !Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Array.prototype ||
    Reflect.ownKeys(parsed).length !== parsed.length + 1
  ) {
    throw new Error("计划数据损坏。");
  }
  return parsed.map((dependency) => {
    if (typeof dependency !== "string") throw new Error("计划数据损坏。");
    return dependency;
  });
}

function readError(error: unknown): never {
  void error;
  throw new Error("计划数据损坏或读取失败。");
}

function writeError(operation: string, error: unknown): never {
  if (
    error instanceof Error &&
    (stableWriteErrors.has(error) ||
      error.message === "历史数据库已经关闭。")
  ) {
    throw error;
  }
  throw new Error(`${operation}失败：数据库拒绝写入。`);
}

function planFromRows(planRow: PlanRow, stepRows: readonly StepRow[]): TaskPlan {
  const steps = stepRows.map((row, index) => {
    if (row.position !== index + 1) throw new Error("计划数据损坏。");
    const result =
      row.result === null ? ABSENT : storedString(row.result);
    const blockReason =
      row.block_reason === null ? ABSENT : storedString(row.block_reason);
    return {
      id: storedString(row.id),
      title: storedString(row.title),
      successCriteria: storedString(row.success_criteria),
      status: storedString(row.status),
      dependsOn: dependsOnFromJson(row.depends_on_json),
      retryCount: storedNonNegativeInteger(row.retry_count),
      ...(result === ABSENT ? {} : { result }),
      ...(blockReason === ABSENT ? {} : { blockReason }),
    };
  });
  return restoreTaskPlan({
    id: storedString(planRow.id),
    sessionId: storedString(planRow.session_id),
    goal: storedString(planRow.goal),
    status: storedString(planRow.status),
    revision: storedPositiveInteger(planRow.revision),
    steps,
    createdAt: storedString(planRow.created_at),
    updatedAt: storedString(planRow.updated_at),
  });
}

export function createPlanningStore(
  options: PlanningStoreOptions,
): PlanningStore {
  const { database, assertOpen, mutate } = options;

  function assertActiveSession(expected: string | undefined): void {
    const row = database
      .prepare(
        "SELECT active_session_id FROM app_metadata WHERE singleton = 1",
      )
      .get() as { active_session_id: unknown } | undefined;
    if (row === undefined) {
      throw stableWriteError("计划数据损坏。");
    }
    const actual = row.active_session_id;
    if (
      (expected === undefined && actual !== null) ||
      (expected !== undefined && actual !== expected)
    ) {
      throw stableWriteError("当前会话已发生变化，请重试。");
    }
  }

  function loadInCurrentTransaction(
    sessionId: string,
  ): TaskPlan | undefined {
    const planRow = database
      .prepare(
        `SELECT id, session_id, goal, status, revision, created_at, updated_at
         FROM task_plans WHERE session_id = ?`,
      )
      .get(sessionId) as PlanRow | undefined;
    if (planRow === undefined) return undefined;
    const planId = storedString(planRow.id);
    const stepRows = database
      .prepare(
        `SELECT id, position, title, success_criteria, status,
                depends_on_json, retry_count, result, block_reason
         FROM task_steps WHERE plan_id = ? ORDER BY position`,
      )
      .all(planId) as StepRow[];
    const plan = planFromRows(planRow, stepRows);
    if (plan.sessionId !== sessionId) throw new Error("计划数据损坏。");
    return plan;
  }

  function loadForSession(sessionId: string): TaskPlan | undefined {
    assertOpen();
    const checkedSessionId = boundedText(sessionId, "会话 ID");
    try {
      return database.transaction(() =>
        loadInCurrentTransaction(checkedSessionId),
      )();
    } catch (error) {
      return readError(error);
    }
  }

  function create(input: Parameters<PlanningStore["create"]>[0]) {
    const outer = recordSnapshot(input, "创建计划参数", ["session", "plan"]);
    const sessionRecord =
      typeof outer.session === "object" && outer.session !== null
        ? outer.session
        : unsafeInput("创建计划参数");
    if (utilTypes.isProxy(sessionRecord)) {
      return unsafeInput("创建计划参数");
    }
    const kind = ownOptional(sessionRecord, "kind", "创建计划参数");
    let session: PlanSessionInput;
    if (kind === "existing") {
      const snapshot = recordSnapshot(
        sessionRecord,
        "创建计划参数",
        ["kind", "id", "expectedRevision", "expectedCurrentPlan"],
      );
      const expectedCurrentPlan =
        snapshot.expectedCurrentPlan === null
          ? null
          : (() => {
              const current = recordSnapshot(
                snapshot.expectedCurrentPlan,
                "创建计划参数",
                ["id", "revision"],
              );
              return {
                id: boundedText(current.id, "计划 ID"),
                revision: positiveInteger(current.revision, "计划 revision"),
              };
            })();
      session = {
        kind: "existing",
        id: boundedText(snapshot.id, "会话 ID"),
        expectedRevision: positiveInteger(
          snapshot.expectedRevision,
          "revision",
        ),
        expectedCurrentPlan,
      };
    } else if (kind === "new") {
      const snapshot = recordSnapshot(
        sessionRecord,
        "创建计划参数",
        ["kind", "title", "providerId", "modelId"],
      );
      session = {
        kind: "new",
        title: boundedText(snapshot.title, "会话标题"),
        providerId: boundedText(snapshot.providerId, "provider ID"),
        modelId: boundedText(snapshot.modelId, "model ID"),
      };
    } else {
      throw new Error("会话类型无效。");
    }
    const planRecord = recordSnapshot(
      outer.plan,
      "创建计划参数",
      ["id", "goal", "steps", "now"],
    );
    const sessionId =
      session.kind === "existing"
        ? session.id
        : randomUUID();
    const plan = createTaskPlan({
      id: planRecord.id as string,
      sessionId,
      goal: planRecord.goal as string,
      steps: planRecord.steps as readonly TaskStepDraft[],
      now: planRecord.now as string,
    });

    try {
      return mutate(() => {
        assertActiveSession(
          session.kind === "existing" ? session.id : undefined,
        );
        let materializedSession: MaterializedPlanSession | undefined;
        if (session.kind === "existing") {
          const row = database
            .prepare("SELECT revision FROM sessions WHERE id = ?")
            .get(session.id) as { revision: unknown } | undefined;
          if (
            row === undefined ||
            row.revision !== session.expectedRevision
          ) {
            throw stableWriteError(PLAN_CONFLICT);
          }
        } else {
          database
            .prepare(
              `INSERT INTO sessions(
                 id, title, provider_id, model_id, revision,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              sessionId,
              session.title,
              session.providerId,
              session.modelId,
              plan.createdAt,
              plan.updatedAt,
            );
          materializedSession = Object.freeze({
            id: sessionId,
            title: session.title,
            providerId: session.providerId,
            modelId: session.modelId,
            revision: 1,
          });
        }

        const current = database
          .prepare(
            "SELECT id, status, revision FROM task_plans WHERE session_id = ?",
          )
          .get(sessionId) as
          | { id: unknown; status: unknown; revision: unknown }
          | undefined;
        if (session.kind === "existing") {
          if (session.expectedCurrentPlan === null) {
            if (current !== undefined) {
              throw stableWriteError(PLAN_CONFLICT);
            }
          } else {
            if (
              current === undefined ||
              storedString(current.id) !== session.expectedCurrentPlan.id ||
              storedPositiveInteger(current.revision) !==
                session.expectedCurrentPlan.revision
            ) {
              throw stableWriteError(PLAN_CONFLICT);
            }
            if (current.status === "active" || current.status === "blocked") {
              throw stableWriteError("当前会话已有进行中的任务计划。");
            }
            if (
              current.status !== "completed" &&
              current.status !== "cancelled"
            ) {
              throw stableWriteError("计划数据损坏。");
            }
            database
              .prepare("DELETE FROM task_plans WHERE session_id = ?")
              .run(sessionId);
          }
        } else if (current !== undefined) {
          throw stableWriteError(PLAN_CONFLICT);
        }

        database
          .prepare(
            `INSERT INTO task_plans(
               id, session_id, goal, status, revision, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            plan.id,
            plan.sessionId,
            plan.goal,
            plan.status,
            plan.revision,
            plan.createdAt,
            plan.updatedAt,
          );
        insertSteps(plan);
        const active = database
          .prepare(
            "UPDATE app_metadata SET active_session_id = ? WHERE singleton = 1",
          )
          .run(sessionId);
        if (active.changes !== 1) {
          throw new Error("无法更新活动会话。");
        }
        return {
          plan: loadInCurrentTransaction(sessionId)!,
          ...(materializedSession === undefined
            ? {}
            : { materializedSession }),
        };
      });
    } catch (error) {
      return writeError("创建计划", error);
    }
  }

  function insertSteps(plan: TaskPlan): void {
    const insertStep = database.prepare(
        `INSERT INTO task_steps(
           plan_id, id, position, title, success_criteria, status,
           depends_on_json, retry_count, result, block_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index]!;
      insertStep.run(
        plan.id,
        step.id,
        index + 1,
        step.title,
        step.successCriteria,
        step.status,
        JSON.stringify(step.dependsOn),
        step.retryCount,
        step.result ?? null,
        step.blockReason ?? null,
      );
    }
  }

  function persistUpdate(
    plan: TaskPlan,
    expectedRevision: number,
  ): TaskPlan {
    assertActiveSession(plan.sessionId);
    const original = database
      .prepare(
        "SELECT session_id, created_at FROM task_plans " +
          "WHERE id = ? AND revision = ?",
      )
      .get(plan.id, expectedRevision) as
      | { session_id: unknown; created_at: unknown }
      | undefined;
    if (original === undefined) throw stableWriteError(PLAN_CONFLICT);
    if (
      original.session_id !== plan.sessionId ||
      original.created_at !== plan.createdAt
    ) {
      throw stableWriteError("计划的会话或创建时间不能修改。");
    }

    const updated = database
      .prepare(
        `UPDATE task_plans
         SET goal = ?, status = ?, revision = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(
        plan.goal,
        plan.status,
        plan.revision,
        plan.updatedAt,
        plan.id,
        expectedRevision,
      );
    if (updated.changes !== 1) throw stableWriteError(PLAN_CONFLICT);
    database
      .prepare("DELETE FROM task_steps WHERE plan_id = ?")
      .run(plan.id);
    insertSteps(plan);
    const loaded = loadInCurrentTransaction(plan.sessionId);
    if (loaded === undefined || loaded.id !== plan.id) {
      throw new Error("计划写入后无法读取。");
    }
    return loaded;
  }

  function save(
    plan: TaskPlan,
    expectedRevision: number,
  ): TaskPlan {
    const snapshot = restoreTaskPlan(plan);
    const expected = positiveInteger(expectedRevision, "revision");
    if (
      expected >= Number.MAX_SAFE_INTEGER ||
      snapshot.revision !== expected + 1
    ) {
      throw new Error("计划 revision 必须恰好增加 1。");
    }
    try {
      return mutate(() => persistUpdate(snapshot, expected));
    } catch (error) {
      return writeError("保存计划", error);
    }
  }

  function cancel(
    sessionId: string,
    expectedRevision: number,
    now: string,
  ): TaskPlan {
    const checkedSessionId = boundedText(sessionId, "会话 ID");
    const expected = positiveInteger(expectedRevision, "revision");
    const checkedNow = boundedText(now, "now");
    if (expected >= Number.MAX_SAFE_INTEGER) {
      throw new Error("计划 revision 无法继续增加。");
    }
    try {
      return mutate(() => {
        const current = loadInCurrentTransaction(checkedSessionId);
        if (current === undefined) {
          throw stableWriteError("当前会话还没有任务计划。");
        }
        if (current.status === "completed" || current.status === "cancelled") {
          throw stableWriteError("计划已进入终态，不能取消。");
        }
        if (current.revision !== expected) {
          throw stableWriteError(PLAN_CONFLICT);
        }
        const cancelled = restoreTaskPlan({
          ...current,
          status: "cancelled",
          revision: expected + 1,
          updatedAt: checkedNow,
          steps: current.steps.map((step) => {
            if (step.status !== "in_progress" && step.status !== "blocked") {
              return step;
            }
            return {
              id: step.id,
              title: step.title,
              successCriteria: step.successCriteria,
              dependsOn: step.dependsOn,
              status: "failed",
              retryCount: step.retryCount,
              result: "计划已由用户取消。",
            };
          }),
        });
        return persistUpdate(cancelled, expected);
      });
    } catch (error) {
      return writeError("取消计划", error);
    }
  }

  return { loadForSession, create, save, cancel };
}
