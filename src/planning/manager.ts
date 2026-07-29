import { randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  createSessionTitle,
  type CurrentSession,
  type SessionManager,
} from "../history/session-manager.js";
import {
  applyPlanAction,
  createTaskPlan,
  finishTaskPlan,
  restoreTaskPlan,
} from "./state.js";
import type { PlanningStore } from "./store.js";
import type {
  PlanUpdateAction,
  TaskPlan,
  TaskStepDraft,
} from "./types.js";

export interface PlanManager {
  getCurrentPlan(): TaskPlan | undefined;
  createPlan(
    input: {
      readonly goal: string;
      readonly steps: readonly TaskStepDraft[];
    },
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

export interface CreatePlanManagerOptions {
  readonly store: PlanningStore;
  readonly session: SessionManager;
  readonly idFactory?: () => string;
  readonly now?: () => string;
}

type PlainRecord = Record<string, unknown>;

const PLAN_CONFLICT = "计划冲突，请使用 /plan 重新查看。";
const NO_PLAN = "当前会话还没有任务计划。";
const REENTRANT_MUTATION =
  "计划状态正在更新，不能执行嵌套的计划操作。";
const ADOPTION_FAILURE =
  "计划已保存，但当前会话接管失败，请使用 /sessions 恢复。";

function unsafeInput(operation: string): never {
  throw new Error(`${operation}无法安全读取，必须是普通 JSON 数据。`);
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

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field}必须是字符串。`);
  }
  const length = Array.from(value.trim()).length;
  if (length < 1 || length > 1000) {
    throw new Error(`${field}长度必须在 1 到 1000 之间。`);
  }
  return value;
}

function positiveRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("计划 revision 必须是正整数。");
  }
  return value as number;
}

function snapshotCreateInput(input: unknown): {
  readonly goal: string;
  readonly steps: readonly TaskStepDraft[];
} {
  const snapshot = recordSnapshot(input, "创建计划参数", [
    "goal",
    "steps",
  ]);
  const validated = createTaskPlan({
    id: "validation-plan",
    sessionId: "validation-session",
    goal: snapshot.goal as string,
    steps: snapshot.steps as readonly TaskStepDraft[],
    now: "validation-time",
  });
  return {
    goal: validated.goal,
    steps: validated.steps.map((step) => ({
      id: step.id,
      title: step.title,
      successCriteria: step.successCriteria,
      dependsOn: [...step.dependsOn],
    })),
  };
}

function exactModel(
  current: CurrentSession,
  fallback: ReturnType<SessionManager["getModel"]>,
) {
  const model = current.model ?? fallback;
  if (
    model === undefined ||
    current.providerId === undefined ||
    current.modelId === undefined ||
    model.providerId !== current.providerId ||
    model.id !== current.modelId
  ) {
    throw new Error("当前会话模型无法精确解析，不能创建计划。");
  }
  return model;
}

function assertSameSession(
  expected: CurrentSession,
  actual: CurrentSession,
): void {
  if (
    actual.id !== expected.id ||
    actual.revision !== expected.revision ||
    actual.providerId !== expected.providerId ||
    actual.modelId !== expected.modelId
  ) {
    throw new Error(PLAN_CONFLICT);
  }
}

interface SessionBinding {
  readonly stateVersion: bigint;
  readonly current: CurrentSession;
}

function captureSessionBinding(session: SessionManager): SessionBinding {
  const stateVersion = session.getStateVersion();
  const current = session.getCurrent();
  if (session.getStateVersion() !== stateVersion) {
    throw new Error(PLAN_CONFLICT);
  }
  return { stateVersion, current };
}

function assertSessionBinding(
  session: SessionManager,
  binding: SessionBinding,
): void {
  if (session.getStateVersion() !== binding.stateVersion) {
    throw new Error(PLAN_CONFLICT);
  }
  assertSameSession(binding.current, session.getCurrent());
  if (session.getStateVersion() !== binding.stateVersion) {
    throw new Error(PLAN_CONFLICT);
  }
}

function matchesMaterializedSession(
  current: CurrentSession,
  materialized: {
    readonly id: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly revision: number;
  },
): boolean {
  return (
    current.id === materialized.id &&
    current.providerId === materialized.providerId &&
    current.modelId === materialized.modelId &&
    current.revision === materialized.revision &&
    current.model !== undefined &&
    current.model.providerId === materialized.providerId &&
    current.model.id === materialized.modelId &&
    current.turns.length === 0
  );
}

export function createPlanManager(
  options: CreatePlanManagerOptions,
): PlanManager {
  const { store, session } = options;
  const idFactory = options.idFactory ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());
  let mutationActive = false;

  function runMutation<T>(operation: () => T): T {
    if (mutationActive) throw new Error(REENTRANT_MUTATION);
    mutationActive = true;
    try {
      return operation();
    } finally {
      mutationActive = false;
    }
  }

  function getCurrentPlan(): TaskPlan | undefined {
    const current = session.getCurrent();
    if (current.id === undefined) return undefined;
    const loaded = store.loadForSession(current.id);
    const latest = session.getCurrent();
    assertSameSession(current, latest);
    if (loaded === undefined) return undefined;
    if (loaded.sessionId !== current.id) throw new Error(PLAN_CONFLICT);
    return restoreTaskPlan(loaded);
  }

  function loadBoundPlan(): {
    readonly current: CurrentSession;
    readonly plan: TaskPlan;
  } {
    const current = session.getCurrent();
    if (current.id === undefined) throw new Error(NO_PLAN);
    const loaded = store.loadForSession(current.id);
    assertSameSession(current, session.getCurrent());
    if (loaded === undefined) throw new Error(NO_PLAN);
    const plan = restoreTaskPlan(loaded);
    if (plan.sessionId !== current.id) throw new Error(PLAN_CONFLICT);
    return { current, plan };
  }

  function createPlan(
    input: {
      readonly goal: string;
      readonly steps: readonly TaskStepDraft[];
    },
    signal?: AbortSignal,
  ): TaskPlan {
    signal?.throwIfAborted();
    return runMutation(() => {
      const validated = snapshotCreateInput(input);
      const binding = captureSessionBinding(session);
      const planId = boundedText(idFactory(), "计划 ID");
      assertSessionBinding(session, binding);
      const timestamp = boundedText(now(), "now");
      assertSessionBinding(session, binding);
      const resolvedModel = session.getModel();
      assertSessionBinding(session, binding);
      const current = binding.current;
      const model = exactModel(current, resolvedModel);

      if (current.id === undefined) {
        const created = session.runWithCurrentGuard(
          binding.stateVersion,
          () =>
            store.create({
              session: {
                kind: "new",
                title: createSessionTitle(validated.goal),
                providerId: model.providerId,
                modelId: model.id,
              },
              plan: {
                id: planId,
                goal: validated.goal,
                steps: validated.steps,
                now: timestamp,
              },
            }),
        );
        const materialized = created.materializedSession;
        if (
          materialized === undefined ||
          created.plan.sessionId !== materialized.id ||
          materialized.providerId !== model.providerId ||
          materialized.modelId !== model.id
        ) {
          throw new Error(ADOPTION_FAILURE);
        }
        try {
          assertSessionBinding(session, binding);
        } catch {
          throw new Error(ADOPTION_FAILURE);
        }
        try {
          const adopted = session.adoptMaterializedSession(materialized.id);
          const actualStateVersion = session.getStateVersion();
          const actual = session.getCurrent();
          if (
            actualStateVersion !== binding.stateVersion + 1n ||
            session.getStateVersion() !== actualStateVersion ||
            !matchesMaterializedSession(actual, materialized) ||
            !matchesMaterializedSession(adopted, materialized)
          ) {
            throw new Error(ADOPTION_FAILURE);
          }
        } catch {
          throw new Error(ADOPTION_FAILURE);
        }
        return restoreTaskPlan(created.plan);
      }

      if (
        current.revision === undefined ||
        current.providerId === undefined ||
        current.modelId === undefined
      ) {
        throw new Error("当前会话数据不完整，不能创建计划。");
      }
      const currentPlan = store.loadForSession(current.id);
      assertSessionBinding(session, binding);
      if (
        currentPlan !== undefined &&
        currentPlan.sessionId !== current.id
      ) {
        throw new Error(PLAN_CONFLICT);
      }
      if (
        currentPlan?.status === "active" ||
        currentPlan?.status === "blocked"
      ) {
        throw new Error("当前会话已有进行中的任务计划。");
      }
      const created = session.runWithCurrentGuard(
        binding.stateVersion,
        () =>
          store.create({
            session: {
              kind: "existing",
              id: current.id!,
              expectedRevision: current.revision!,
              expectedCurrentPlan:
                currentPlan === undefined
                  ? null
                  : {
                      id: currentPlan.id,
                      revision: currentPlan.revision,
                    },
            },
            plan: {
              id: planId,
              goal: validated.goal,
              steps: validated.steps,
              now: timestamp,
            },
          }),
      );
      assertSessionBinding(session, binding);
      if (
        created.materializedSession !== undefined ||
        created.plan.sessionId !== current.id
      ) {
        throw new Error(PLAN_CONFLICT);
      }
      return restoreTaskPlan(created.plan);
    });
  }

  function updatePlan(
    planId: string,
    expectedRevision: number,
    action: PlanUpdateAction,
    signal?: AbortSignal,
  ): TaskPlan {
    signal?.throwIfAborted();
    return runMutation(() => {
      const checkedPlanId = exactIdentifier(planId, "计划 ID");
      const checkedRevision = positiveRevision(expectedRevision);
      const binding = captureSessionBinding(session);
      const { plan } = loadBoundPlan();
      assertSessionBinding(session, binding);
      if (
        plan.id !== checkedPlanId ||
        plan.revision !== checkedRevision
      ) {
        throw new Error(PLAN_CONFLICT);
      }
      const timestamp = boundedText(now(), "now");
      assertSessionBinding(session, binding);
      const next = applyPlanAction(
        plan,
        action,
        timestamp,
      );
      const saved = session.runWithCurrentGuard(
        binding.stateVersion,
        () => store.save(next, checkedRevision),
      );
      assertSessionBinding(session, binding);
      return restoreTaskPlan(saved);
    });
  }

  function finishPlan(
    planId: string,
    expectedRevision: number,
    summary: string,
    signal?: AbortSignal,
  ): TaskPlan {
    signal?.throwIfAborted();
    return runMutation(() => {
      const checkedPlanId = exactIdentifier(planId, "计划 ID");
      const checkedRevision = positiveRevision(expectedRevision);
      const checkedSummary = boundedText(summary, "summary");
      const binding = captureSessionBinding(session);
      const { plan } = loadBoundPlan();
      assertSessionBinding(session, binding);
      if (
        plan.id !== checkedPlanId ||
        plan.revision !== checkedRevision
      ) {
        throw new Error(PLAN_CONFLICT);
      }
      const timestamp = boundedText(now(), "now");
      assertSessionBinding(session, binding);
      const next = finishTaskPlan(
        plan,
        checkedSummary,
        timestamp,
      );
      const saved = session.runWithCurrentGuard(
        binding.stateVersion,
        () => store.save(next, checkedRevision),
      );
      assertSessionBinding(session, binding);
      return restoreTaskPlan(saved);
    });
  }

  function cancelCurrent(signal?: AbortSignal): TaskPlan | undefined {
    signal?.throwIfAborted();
    return runMutation(() => {
      const binding = captureSessionBinding(session);
      const current = binding.current;
      if (current.id === undefined) return undefined;
      const loaded = store.loadForSession(current.id);
      assertSessionBinding(session, binding);
      if (loaded === undefined) return undefined;
      const plan = restoreTaskPlan(loaded);
      if (plan.sessionId !== current.id) throw new Error(PLAN_CONFLICT);
      const timestamp = boundedText(now(), "now");
      assertSessionBinding(session, binding);
      const cancelled = session.runWithCurrentGuard(
        binding.stateVersion,
        () =>
          store.cancel(
            current.id!,
            plan.revision,
            timestamp,
          ),
      );
      assertSessionBinding(session, binding);
      return restoreTaskPlan(cancelled);
    });
  }

  return {
    getCurrentPlan,
    createPlan,
    updatePlan,
    finishPlan,
    cancelCurrent,
  };
}
