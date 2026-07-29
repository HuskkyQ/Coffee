import type { ModelDefinition } from "../models/types.js";
import type { HistoryStore } from "./store.js";
import type {
  PersistedMessage,
  SessionListItem,
  StoredSession,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export interface CurrentSession {
  readonly id?: string;
  readonly title?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly revision?: number;
  readonly model?: ModelDefinition;
  readonly turns: readonly StoredTurn[];
  readonly summary?: StoredSummary;
}

export type SynchronousOperation<T> = () =>
  T extends PromiseLike<unknown> ? never : T;

export interface SessionManager {
  getCurrent(): CurrentSession;
  getModel(): ModelDefinition | undefined;
  getStateVersion(): bigint;
  runWithCurrentGuard<T>(
    expectedStateVersion: bigint,
    operation: SynchronousOperation<T>,
  ): T;
  listSessions(): readonly SessionListItem[];
  adoptMaterializedSession(sessionId: string): CurrentSession;
  startNew(defaultModel: ModelDefinition | undefined): void;
  switchSession(sessionId: string): CurrentSession;
  deleteCurrent(): boolean;
  setModel(model: ModelDefinition): void;
  commitTurn(messages: readonly PersistedMessage[]): StoredTurn;
  saveSummary(throughTurnSequence: number, content: string): StoredSummary;
}

export interface CreateSessionManagerOptions {
  readonly store: HistoryStore;
  readonly getModel: (
    providerId: string,
    modelId: string,
  ) => ModelDefinition | undefined;
  readonly defaultModel?: ModelDefinition;
}

const NO_MODEL_MESSAGE =
  "尚未选择模型，请先使用 /login 登录，再使用 /model 选择模型。";
const UNSAFE_TURN_MESSAGE = "提交轮次参数无法安全读取。";
const REENTRANT_MUTATION_MESSAGE =
  "会话状态正在更新，不能执行嵌套的会话操作。";
const UNSAFE_ADOPTION_MESSAGE = "接管计划会话参数无法安全读取。";
const STATE_VERSION_CONFLICT_MESSAGE =
  "会话状态已变化，不能继续当前操作。";
const ASYNC_GUARD_MESSAGE =
  "Session 稳定性守卫只支持同步操作。";

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function cloneModel(
  model: ModelDefinition | undefined,
): ModelDefinition | undefined {
  return model === undefined ? undefined : immutableClone(model);
}

function blankSession(model: ModelDefinition | undefined): CurrentSession {
  return deepFreeze({
    ...(model === undefined
      ? {}
      : {
          providerId: model.providerId,
          modelId: model.id,
          model,
        }),
    turns: [] as StoredTurn[],
  });
}

function resolvedModel(
  stored: StoredSession,
  getModel: CreateSessionManagerOptions["getModel"],
): ModelDefinition | undefined {
  const model = cloneModel(getModel(stored.providerId, stored.modelId));
  if (
    model === undefined ||
    model.providerId !== stored.providerId ||
    model.id !== stored.modelId
  ) {
    return undefined;
  }
  return model;
}

function restoredSession(
  stored: StoredSession,
  getModel: CreateSessionManagerOptions["getModel"],
): CurrentSession {
  const model = resolvedModel(stored, getModel);
  return deepFreeze({
    id: stored.id,
    title: stored.title,
    providerId: stored.providerId,
    modelId: stored.modelId,
    revision: stored.revision,
    ...(model === undefined ? {} : { model }),
    turns: immutableClone(stored.turns),
    ...(stored.summary === undefined
      ? {}
      : { summary: immutableClone(stored.summary) }),
  });
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
  return descriptor.value;
}

function safePrototypeOf(value: object): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
}

function snapshotTurnMessages(messages: readonly PersistedMessage[]): {
  readonly messages: readonly PersistedMessage[];
  readonly firstUserContent: string;
} {
  let isArray: boolean;
  try {
    isArray = Array.isArray(messages);
  } catch {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
  if (!isArray || safePrototypeOf(messages) !== Array.prototype) {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
  const length = ownDataValue(messages, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 1) {
    throw new Error("提交轮次的首条消息必须是 user 消息。");
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    snapshot.push(ownDataValue(messages, String(index)));
  }

  const first = snapshot[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("提交轮次的首条消息必须是 user 消息。");
  }
  const firstPrototype = safePrototypeOf(first);
  if (firstPrototype !== Object.prototype && firstPrototype !== null) {
    throw new Error(UNSAFE_TURN_MESSAGE);
  }
  const role = ownDataValue(first, "role");
  if (role !== "user") {
    throw new Error("提交轮次的首条消息必须是 user 消息。");
  }
  const content = ownDataValue(first, "content");
  if (typeof content !== "string") {
    throw new Error("提交轮次的首条 user 消息内容必须是字符串。");
  }
  snapshot[0] = { role: "user", content };
  return {
    messages: snapshot as PersistedMessage[],
    firstUserContent: content,
  };
}

function snapshotMaterializedSessionId(sessionId: string): string {
  if (
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0 ||
    Array.from(sessionId).length > 1000
  ) {
    throw new Error(UNSAFE_ADOPTION_MESSAGE);
  }
  return sessionId;
}

function isThenable(value: unknown): boolean {
  if (
    (typeof value !== "object" || value === null) &&
    typeof value !== "function"
  ) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

export function createSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 40).join("") || "新会话";
}

export function createSessionManager(
  options: CreateSessionManagerOptions,
): SessionManager {
  const { store, getModel } = options;
  let globalDefault = cloneModel(options.defaultModel);
  let current = blankSession(globalDefault);
  let mutationActive = false;
  let stateVersion = 0n;

  const activeSessionId = store.getActiveSessionId();
  if (activeSessionId !== undefined) {
    const stored = store.loadSession(activeSessionId);
    if (stored === undefined) {
      store.setActiveSessionId(undefined);
    } else {
      current = restoredSession(stored, getModel);
    }
  }

  function getCurrent(): CurrentSession {
    return immutableClone(current);
  }

  function getCurrentModel(): ModelDefinition | undefined {
    return cloneModel(current.model);
  }

  function getStateVersion(): bigint {
    return stateVersion;
  }

  function listSessions(): readonly SessionListItem[] {
    return immutableClone(store.listSessions());
  }

  function runMutation<T>(
    operation: (
      base: CurrentSession,
      baseDefault: ModelDefinition | undefined,
    ) => T,
  ): T {
    if (mutationActive) throw new Error(REENTRANT_MUTATION_MESSAGE);
    mutationActive = true;
    const base = current;
    const baseDefault = globalDefault;
    try {
      return operation(base, baseDefault);
    } finally {
      mutationActive = false;
    }
  }

  function advanceStateVersion(): void {
    stateVersion += 1n;
  }

  function runWithCurrentGuard<T>(
    expectedStateVersion: bigint,
    operation: SynchronousOperation<T>,
  ): T {
    if (mutationActive) throw new Error(REENTRANT_MUTATION_MESSAGE);
    if (expectedStateVersion !== stateVersion) {
      throw new Error(STATE_VERSION_CONFLICT_MESSAGE);
    }
    mutationActive = true;
    try {
      const result = operation();
      if (isThenable(result)) throw new Error(ASYNC_GUARD_MESSAGE);
      return result;
    } finally {
      mutationActive = false;
    }
  }

  function startNew(defaultModel: ModelDefinition | undefined): void {
    runMutation(() => {
      const nextDefault = cloneModel(defaultModel);
      const next = blankSession(nextDefault);
      store.setActiveSessionId(undefined);
      advanceStateVersion();
      globalDefault = nextDefault;
      current = next;
    });
  }

  function adoptMaterializedSession(sessionId: string): CurrentSession {
    return runMutation((base) => {
      if (base.id !== undefined) {
        throw new Error("当前会话已经持久化，不能接管计划会话。");
      }
      const checkedSessionId = snapshotMaterializedSessionId(sessionId);
      const stored = store.loadSession(checkedSessionId);
      if (stored === undefined) {
        throw new Error("找不到要接管的会话。");
      }
      if (stored.turns.length !== 0) {
        throw new Error("计划会话必须是尚无对话轮次的新会话。");
      }
      const next = restoredSession(stored, getModel);
      if (next.model === undefined) {
        throw new Error("计划会话模型无法解析。");
      }
      if (store.getActiveSessionId() !== checkedSessionId) {
        throw new Error("活动会话元数据不匹配，无法接管计划会话。");
      }
      advanceStateVersion();
      current = next;
      return getCurrent();
    });
  }

  function switchSession(sessionId: string): CurrentSession {
    return runMutation(() => {
      const stored = store.loadSession(sessionId);
      if (stored === undefined) {
        throw new Error("找不到要切换的会话。");
      }
      const next = restoredSession(stored, getModel);
      store.setActiveSessionId(sessionId);
      advanceStateVersion();
      current = next;
      return getCurrent();
    });
  }

  function deleteCurrent(): boolean {
    return runMutation((base, baseDefault) => {
      if (base.id === undefined || base.revision === undefined) {
        return false;
      }
      store.deleteSession(base.id, base.revision);
      const next = blankSession(baseDefault);
      advanceStateVersion();
      current = next;
      return true;
    });
  }

  function setModel(model: ModelDefinition): void {
    runMutation((base) => {
      const nextModel = cloneModel(model)!;
      if (base.id === undefined) {
        const next = blankSession(nextModel);
        advanceStateVersion();
        globalDefault = nextModel;
        current = next;
        return;
      }

      const revision = store.updateSessionModel(
        base.id,
        base.revision!,
        nextModel.providerId,
        nextModel.id,
      );
      const next = deepFreeze({
        ...base,
        providerId: nextModel.providerId,
        modelId: nextModel.id,
        revision,
        model: nextModel,
      });
      advanceStateVersion();
      globalDefault = nextModel;
      current = next;
    });
  }

  function commitTurn(messages: readonly PersistedMessage[]): StoredTurn {
    return runMutation((base) => {
      const model = base.model;
      if (model === undefined) throw new Error(NO_MODEL_MESSAGE);

      const turnInput = snapshotTurnMessages(messages);
      const title =
        base.id === undefined
          ? createSessionTitle(turnInput.firstUserContent)
          : base.title!;
      const committed = store.commitTurn({
        ...(base.id === undefined
          ? {}
          : {
              sessionId: base.id,
              expectedRevision: base.revision,
            }),
        title,
        providerId: model.providerId,
        modelId: model.id,
        messages: turnInput.messages,
      });
      const turn = immutableClone(committed.turn);
      const next = deepFreeze({
        id: committed.id,
        title,
        providerId: model.providerId,
        modelId: model.id,
        revision: committed.revision,
        model,
        turns: [...base.turns, turn],
        ...(base.summary === undefined ? {} : { summary: base.summary }),
      });
      advanceStateVersion();
      current = next;
      return immutableClone(turn);
    });
  }

  function saveSummary(
    throughTurnSequence: number,
    content: string,
  ): StoredSummary {
    return runMutation((base) => {
      if (base.id === undefined || base.revision === undefined) {
        throw new Error("当前会话尚未持久化，无法保存摘要。");
      }
      const saved = store.saveSummary({
        sessionId: base.id,
        expectedRevision: base.revision,
        throughTurnSequence,
        content,
      });
      const summary = immutableClone(saved.summary);
      const next = deepFreeze({
        ...base,
        revision: saved.revision,
        summary,
      });
      advanceStateVersion();
      current = next;
      return immutableClone(summary);
    });
  }

  return {
    getCurrent,
    getModel: getCurrentModel,
    getStateVersion,
    runWithCurrentGuard,
    listSessions,
    adoptMaterializedSession,
    startNew,
    switchSession,
    deleteCurrent,
    setModel,
    commitTurn,
    saveSummary,
  };
}
