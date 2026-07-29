import type { ToolActivityEvent } from "./activity-indicator.js";
import type { ToolInteraction } from "./code-tools/types.js";
import type { ShellInteraction } from "./shell/types.js";
import {
  buildContext,
  planCompression,
  redactSummaryContent,
} from "./history/context.js";
import type { CurrentSession } from "./history/session-manager.js";
import { generateSummary } from "./history/summarizer.js";
import {
  DEFAULT_HISTORY_PREFERENCES,
  type HistoryPreferences,
  type PersistedMessage,
  type StoredSummary,
  type StoredTurn,
} from "./history/types.js";
import type {
  CredentialId,
  ModelDefinition,
  ModelGateway,
  ModelReply,
} from "./models/types.js";
import type { PlanManager } from "./planning/manager.js";
import { restoreTaskPlan } from "./planning/state.js";
import type { TaskPlan } from "./planning/types.js";
import { createTools, type FetchLike } from "./tools.js";

const DEFAULT_MAX_TOOL_ROUNDS = 5;
const PLANNING_ROUNDS_PER_STEP = 3;
const PLANNING_ROUND_OVERHEAD = 4;
const MAX_PLANNING_TOOL_ROUNDS =
  12 * PLANNING_ROUNDS_PER_STEP + PLANNING_ROUND_OVERHEAD;
const MAX_PLAN_RESULT_CONTEXT_CHARS = 500;
const MAX_PLAN_EVIDENCE_ENTRIES = 12;

const SYSTEM_PROMPT = `
  你是Coffee，一个简洁、耐心的中文 AI 助手。
  你擅长给用户推荐几家环境优雅，咖啡好喝，价格合理的咖啡店，例如：
  - 咖啡店的位置
  - 咖啡店的营业时间
  - 咖啡店的特色
  - 咖啡店的评价
  - 咖啡店的图片
  - 咖啡店的地址
  - 咖啡店的电话

  当然以上只是你的一个特长，你更会做其他别的事情，例如做个程序员，做一个计算机老师等。

  要求：
  - 默认使用中文回答
  - 回答清晰、直接
  - 不确定时明确说明
  - 不编造不存在的信息
`.trim();

const PLANNING_PROMPT = `
计划规则：
- 多文件、多个不同工具、修改后需测试或类型检查、明显步骤依赖、调研、比较、实现和验证的组合都属于复杂任务，必须先调用 create_plan，再写文件或执行 Shell。
- 简单问答、翻译、单次读取和单步计算不要创建计划。
- 已有 active 或 blocked 计划时，使用系统上下文中的准确计划 ID 和 revision 继续该计划，不要重复调用 create_plan。
- 每步执行前调用 update_plan 的 start_step。
- 同一批工具调用中，start_step 必须排在该步骤的普通执行工具之前。
- 只有 successCriteria 已满足，并且有真实工具成功或 Shell exitCode 为 0 的证据，才能调用 complete_step。
- 工具失败必须调用 fail_step、block_step 或 replace_pending_steps，不可跳过。
- 普通工具失败后，本批不能调用 complete_step 或 finish_plan，只能记录 fail_step、block_step 或安全地重规划。
- 关键歧义先调用 block_step，再向用户询问一个明确问题；下一轮收到用户回答后先调用 resume_step。
- 全部问题解决后调用 finish_plan。
- 不要暴露隐藏推理，只展示可验证的计划状态。
`.trim();

function createSystemPrompt(
  workspaceRoot: string | undefined,
  planningEnabled: boolean,
): string {
  const root = workspaceRoot?.trim();
  let prompt = SYSTEM_PROMPT;
  if (root) {
    prompt += "\n\n运行环境：\n" +
      "- 当前工作区：" + JSON.stringify(root) + "\n" +
      "- 可用本地工具：read、ls、find、grep、edit、write、set_env、shell。\n" +
      "- 修改前先读取文件；优先使用小范围 edit。\n" +
      "- shell 始终固定从当前工作区开始执行。\n" +
      "- 简单读取、测试和类型检查命令可能自动执行；其他命令需要用户确认。\n" +
      "- 只有 shell 的 exitCode 为 0 或工具明确成功时，才能宣称成功。\n" +
      "- 命令被禁止、用户拒绝或工具失败时必须如实说明。";
  }
  if (planningEnabled) {
    prompt += `\n\n${PLANNING_PROMPT}`;
  }
  return prompt;
}

export interface ConversationOptions {
  initialModel?: ModelDefinition;
  gateway: ModelGateway;
  resolveApiKey(
    credentialId: CredentialId,
  ): Promise<string | undefined>;
  tavilyApiKey?: string;
  fetchImpl?: FetchLike;
  session?: ConversationSession;
  historyPreferences?: HistoryPreferences;
  workspaceRoot?: string;
  toolInteraction?: ToolInteraction & ShellInteraction;
  planning?: PlanManager;
}

export interface ConversationSession {
  getCurrent(): CurrentSession;
  getModel(): ModelDefinition | undefined;
  setModel(model: ModelDefinition): void;
  commitTurn(messages: readonly PersistedMessage[]): StoredTurn;
  saveSummary(throughTurnSequence: number, content: string): StoredSummary;
}

export type ConversationEvent =
  | { type: "status"; text: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_activity"; event: ToolActivityEvent }
  | { type: "plan_activity"; plan: TaskPlan }
  | { type: "fallback"; text: string }
  | { type: "segment_end" }
  | { type: "done"; content: string };

export interface Conversation {
  stream(input: string, signal?: AbortSignal): AsyncIterable<ConversationEvent>;
  send(input: string, signal?: AbortSignal): Promise<string>;
  getModel(): ModelDefinition | undefined;
  setModel(model: ModelDefinition): void;
}

function createMemorySession(
  initialModel: ModelDefinition | undefined,
): ConversationSession {
  let model = initialModel === undefined
    ? undefined
    : structuredClone(initialModel);
  let turns: StoredTurn[] = [];
  let summary: StoredSummary | undefined;
  let revision = 0;

  return {
    getCurrent() {
      return structuredClone({
        ...(model === undefined ? {} : { model }),
        ...(turns.length === 0 ? {} : { revision }),
        turns,
        ...(summary === undefined ? {} : { summary }),
      });
    },

    getModel() {
      return model === undefined ? undefined : structuredClone(model);
    },

    setModel(nextModel) {
      model = structuredClone(nextModel);
    },

    commitTurn(messages) {
      revision += 1;
      const turn: StoredTurn = {
        id: `memory-turn-${revision}`,
        sequence: (turns.at(-1)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        messages: structuredClone(messages),
      };
      turns = [...turns, turn];
      return structuredClone(turn);
    },

    saveSummary(throughTurnSequence, content) {
      const sourceRevision = revision;
      revision += 1;
      const now = new Date().toISOString();
      summary = {
        throughTurnSequence,
        content,
        sourceRevision,
        createdAt: summary?.createdAt ?? now,
        updatedAt: now,
      };
      return structuredClone(summary);
    },
  };
}

function uncompressedTurns(current: CurrentSession): readonly StoredTurn[] {
  if (current.summary === undefined) return current.turns;
  return current.turns.filter(
    (turn) => turn.sequence > current.summary!.throughTurnSequence,
  );
}

interface SessionIdentityToken {
  readonly id?: string;
  readonly revision?: number;
}

interface ModelIdentityToken {
  readonly providerId: string;
  readonly modelId: string;
}

const SESSION_CHANGED_MESSAGE = "历史会话已在回答期间发生变化。";
const PLANNING_TOOL_NAMES = new Set([
  "create_plan",
  "update_plan",
  "finish_plan",
]);
const SAFE_ACTIONS_AFTER_TOOL_FAILURE = new Set([
  "start_step",
  "fail_step",
  "block_step",
  "replace_pending_steps",
]);

function boundedPlanContextText(value: string): string {
  const redacted = redactPlanContextText(value);
  const characters = Array.from(redacted);
  if (characters.length <= MAX_PLAN_RESULT_CONTEXT_CHARS) return redacted;
  return characters.slice(0, MAX_PLAN_RESULT_CONTEXT_CHARS).join("") +
    "…[已截断]";
}

function redactPlanContextText(value: string): string {
  const assignment =
    /(?:(["'`])(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|auth|password|passwd|credential)\1|\b(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|auth|password|passwd|credential)\b)(\s*[:=]\s*)/gi;
  let assignmentsRedacted = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    const sensitiveKey = (match[2] ?? match[3] ?? "").toLowerCase();
    const quote = value[valueStart];
    let valueEnd = valueStart;
    let replacement = "[REDACTED]";
    if (quote === '"' || quote === "'" || quote === "`") {
      valueEnd += 1;
      let closed = false;
      while (
        valueEnd < value.length &&
        value[valueEnd] !== "\r" &&
        value[valueEnd] !== "\n"
      ) {
        if (
          value[valueEnd] === "\\" &&
          valueEnd + 1 < value.length &&
          value[valueEnd + 1] !== "\r" &&
          value[valueEnd + 1] !== "\n"
        ) {
          valueEnd += 2;
        } else if (value[valueEnd] === quote) {
          valueEnd += 1;
          closed = true;
          break;
        } else {
          valueEnd += 1;
        }
      }
      replacement = closed
        ? `${quote}[REDACTED]${quote}`
        : "[REDACTED]";
    } else if (sensitiveKey === "authorization") {
      while (
        valueEnd < value.length &&
        value[valueEnd] !== "\r" &&
        value[valueEnd] !== "\n"
      ) {
        valueEnd += 1;
      }
      while (valueEnd < value.length) {
        let continuationStart: number;
        if (
          value[valueEnd] === "\r" &&
          value[valueEnd + 1] === "\n"
        ) {
          continuationStart = valueEnd + 2;
        } else if (
          value[valueEnd] === "\r" ||
          value[valueEnd] === "\n"
        ) {
          continuationStart = valueEnd + 1;
        } else {
          break;
        }
        if (
          value[continuationStart] !== " " &&
          value[continuationStart] !== "\t"
        ) {
          break;
        }
        valueEnd = continuationStart;
        while (
          valueEnd < value.length &&
          value[valueEnd] !== "\r" &&
          value[valueEnd] !== "\n"
        ) {
          valueEnd += 1;
        }
      }
    } else {
      while (
        valueEnd < value.length &&
        !/[\s,;"'`]/.test(value[valueEnd]!)
      ) {
        valueEnd += 1;
      }
    }
    assignmentsRedacted +=
      value.slice(cursor, match.index) + match[0] + replacement;
    cursor = valueEnd;
    assignment.lastIndex = valueEnd;
  }
  assignmentsRedacted += value.slice(cursor);
  const serialized = redactSummaryContent(
    JSON.stringify(assignmentsRedacted),
  );
  const parsed: unknown = JSON.parse(serialized);
  return typeof parsed === "string" ? parsed : "[REDACTED]";
}

function planRoundBudget(plan: TaskPlan): number {
  return Math.min(
    MAX_PLANNING_TOOL_ROUNDS,
    Math.max(
      DEFAULT_MAX_TOOL_ROUNDS,
      plan.steps.length * PLANNING_ROUNDS_PER_STEP +
        PLANNING_ROUND_OVERHEAD,
    ),
  );
}

function ongoingPlanSnapshot(
  planning: PlanManager | undefined,
  current: CurrentSession,
): TaskPlan | undefined {
  if (planning === undefined) return undefined;
  const loaded = planning.getCurrentPlan();
  if (loaded === undefined) return undefined;
  const plan = restoreTaskPlan(loaded);
  if (
    current.id === undefined ||
    plan.sessionId !== current.id
  ) {
    throw new Error(SESSION_CHANGED_MESSAGE);
  }
  return plan.status === "active" || plan.status === "blocked"
    ? plan
    : undefined;
}

function planSystemContext(plan: TaskPlan | undefined): string {
  if (plan === undefined) return "";
  const snapshot = {
    id: plan.id,
    sessionId: plan.sessionId,
    revision: plan.revision,
    goal: redactPlanContextText(plan.goal),
    status: plan.status,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: redactPlanContextText(step.title),
      successCriteria: redactPlanContextText(step.successCriteria),
      dependsOn: [...step.dependsOn],
      status: step.status,
      retryCount: step.retryCount,
      ...(step.result === undefined
        ? {}
        : { result: boundedPlanContextText(step.result) }),
      ...(step.blockReason === undefined
        ? {}
        : { blockReason: boundedPlanContextText(step.blockReason) }),
    })),
  };
  const serialized = redactSummaryContent(JSON.stringify(snapshot));
  return "\n\n当前持久计划（本地已验证）：\n" +
    serialized +
    "\n请按该计划的准确 ID、revision 和状态恢复；不要重复创建计划。";
}

interface PlanningUpdateDescriptor {
  readonly action: string;
  readonly planId?: string;
  readonly stepId?: string;
}

function planningUpdateDescriptor(toolCall: {
  readonly name: string;
  readonly argumentsJson: string;
}): PlanningUpdateDescriptor | undefined {
  if (toolCall.name !== "update_plan") return undefined;
  try {
    const parsed: unknown = JSON.parse(toolCall.argumentsJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const action = Object.getOwnPropertyDescriptor(parsed, "action");
      if (
        action === undefined ||
        !("value" in action) ||
        typeof action.value !== "string"
      ) {
        return undefined;
      }
      const planId = Object.getOwnPropertyDescriptor(parsed, "planId");
      const stepId = Object.getOwnPropertyDescriptor(parsed, "stepId");
      return {
        action: action.value,
        ...(planId !== undefined &&
            "value" in planId &&
            typeof planId.value === "string"
          ? { planId: planId.value }
          : {}),
        ...(stepId !== undefined &&
            "value" in stepId &&
            typeof stepId.value === "string"
          ? { stepId: stepId.value }
          : {}),
      };
    }
  } catch {
    // Invalid tool arguments are handled as a local protocol failure below.
  }
  return undefined;
}

function localToolFailure(error: string): string {
  return JSON.stringify({ ok: false, error });
}

function compactConsumedPlanningResults(
  messages: PersistedMessage[],
): void {
  const planningCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.toolCalls) {
      if (PLANNING_TOOL_NAMES.has(toolCall.name)) {
        planningCallIds.add(toolCall.id);
      }
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.role !== "tool" ||
      !planningCallIds.has(message.toolCallId)
    ) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(message.content);
    } catch {
      continue;
    }
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      (payload as Record<string, unknown>).ok !== true
    ) {
      continue;
    }
    const plan = (payload as Record<string, unknown>).plan;
    if (
      typeof plan !== "object" ||
      plan === null ||
      Array.isArray(plan)
    ) {
      continue;
    }
    const planRecord = plan as Record<string, unknown>;
    if (
      typeof planRecord.id !== "string" ||
      !Number.isSafeInteger(planRecord.revision) ||
      typeof planRecord.status !== "string"
    ) {
      continue;
    }
    messages[index] = {
      role: "tool",
      toolCallId: message.toolCallId,
      content: JSON.stringify({
        id: planRecord.id,
        revision: planRecord.revision,
        status: planRecord.status,
        compacted: true,
      }),
    };
  }
}

function canExecuteOrdinaryTool(plan: TaskPlan | undefined): boolean {
  return (
    plan?.status === "active" &&
    plan.steps.filter((step) => step.status === "in_progress").length === 1
  );
}

function hasSamePlanIdentity(
  left: TaskPlan | undefined,
  right: TaskPlan | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.revision === right.revision &&
    left.status === right.status
  );
}

function planEvidenceKey(planId: string, stepId: string): string {
  return `${planId}\u0000${stepId}`;
}

interface PlanStepBinding {
  readonly planId: string;
  readonly stepId: string;
}

function ordinaryPlanStepBinding(
  plan: TaskPlan | undefined,
): PlanStepBinding | undefined {
  if (plan?.status !== "active") return undefined;
  const inProgress = plan.steps.filter(
    (step) => step.status === "in_progress",
  );
  return inProgress.length === 1
    ? { planId: plan.id, stepId: inProgress[0]!.id }
    : undefined;
}

function bindingIsInProgress(
  binding: PlanStepBinding,
  plan: TaskPlan | undefined,
): boolean {
  return (
    plan?.status === "active" &&
    plan.id === binding.planId &&
    plan.steps.some(
      (step) =>
        step.id === binding.stepId && step.status === "in_progress",
    )
  );
}

function clearPlanEvidence(
  plan: TaskPlan | undefined,
  ...ledgers: Set<string>[]
): void {
  if (plan === undefined) {
    for (const ledger of ledgers) ledger.clear();
    return;
  }
  const prefix = `${plan.id}\u0000`;
  for (const ledger of ledgers) {
    for (const key of ledger) {
      if (key.startsWith(prefix)) ledger.delete(key);
    }
  }
}

function ordinaryEvidenceKey(plan: TaskPlan | undefined): string | undefined {
  const binding = ordinaryPlanStepBinding(plan);
  return binding === undefined
    ? undefined
    : planEvidenceKey(binding.planId, binding.stepId);
}

function hasPriorRoundCompletionEvidence(
  descriptor: PlanningUpdateDescriptor | undefined,
  plan: TaskPlan | undefined,
  evidence: ReadonlySet<string>,
): boolean {
  if (
    descriptor?.action !== "complete_step" ||
    descriptor.planId === undefined ||
    descriptor.stepId === undefined ||
    plan?.status !== "active" ||
    plan.id !== descriptor.planId
  ) {
    return false;
  }
  const inProgress = plan.steps.filter(
    (step) => step.status === "in_progress",
  );
  return (
    inProgress.length === 1 &&
    inProgress[0]!.id === descriptor.stepId &&
    evidence.has(planEvidenceKey(descriptor.planId, descriptor.stepId))
  );
}

function sessionIdentity(current: CurrentSession): SessionIdentityToken {
  return { id: current.id, revision: current.revision };
}

function hasSameSessionIdentity(
  current: CurrentSession,
  expected: SessionIdentityToken,
): boolean {
  return current.id === expected.id && current.revision === expected.revision;
}

export function createConversation({
  initialModel,
  gateway,
  resolveApiKey,
  tavilyApiKey,
  fetchImpl = fetch,
  session: providedSession,
  historyPreferences = DEFAULT_HISTORY_PREFERENCES,
  workspaceRoot,
  toolInteraction,
  planning,
}: ConversationOptions): Conversation {
  const normalizedTavilyApiKey = tavilyApiKey?.trim();
  if (!normalizedTavilyApiKey) {
    throw new Error("缺少 TAVILY_API_KEY，请编辑 .env 后重试。");
  }

  const session = providedSession ?? createMemorySession(initialModel);
  const systemPrompt = createSystemPrompt(workspaceRoot, planning !== undefined);
  let turnActive = false;
  const tools = createTools({
    tavilyApiKey: normalizedTavilyApiKey,
    fetchImpl,
    workspaceRoot,
    toolInteraction,
    planning,
  });

  function assertSessionIdentityUnchanged(
    expected: SessionIdentityToken,
  ): CurrentSession {
    const current = session.getCurrent();
    if (!hasSameSessionIdentity(current, expected)) {
      throw new Error(SESSION_CHANGED_MESSAGE);
    }
    return current;
  }

  function assertSessionUnchanged(
    expectedSession: SessionIdentityToken,
    expectedModel: ModelIdentityToken,
  ): CurrentSession {
    const current = assertSessionIdentityUnchanged(expectedSession);
    const currentModel = current.model ?? session.getModel();
    if (
      currentModel?.providerId !== expectedModel.providerId ||
      currentModel?.id !== expectedModel.modelId
    ) {
      throw new Error("会话模型已在回答期间发生变化。");
    }
    return current;
  }

  function refreshSessionAfterSummary(
    previous: SessionIdentityToken,
    expectedModel: ModelIdentityToken,
  ): SessionIdentityToken {
    const current = session.getCurrent();
    const currentModel = current.model ?? session.getModel();
    if (current.id !== previous.id) {
      throw new Error(SESSION_CHANGED_MESSAGE);
    }
    if (
      currentModel?.providerId !== expectedModel.providerId ||
      currentModel?.id !== expectedModel.modelId
    ) {
      throw new Error("会话模型已在回答期间发生变化。");
    }
    return sessionIdentity(current);
  }

  function refreshSessionAfterCreatePlan(
    previous: SessionIdentityToken,
    expectedModel: ModelIdentityToken,
    plan: TaskPlan,
  ): SessionIdentityToken {
    const current = session.getCurrent();
    if (previous.id !== undefined) {
      if (
        !hasSameSessionIdentity(current, previous) ||
        plan.sessionId !== previous.id
      ) {
        throw new Error(SESSION_CHANGED_MESSAGE);
      }
      assertSessionUnchanged(previous, expectedModel);
      return previous;
    }

    if (
      current.id === undefined ||
      current.id !== plan.sessionId ||
      current.revision !== 1 ||
      current.providerId !== expectedModel.providerId ||
      current.modelId !== expectedModel.modelId ||
      current.model?.providerId !== expectedModel.providerId ||
      current.model.id !== expectedModel.modelId ||
      current.turns.length !== 0
    ) {
      throw new Error(SESSION_CHANGED_MESSAGE);
    }
    return sessionIdentity(current);
  }

  function parseToolResultPayload(result: string): Record<string, unknown> {
    const payload: unknown = JSON.parse(result);
    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype
    ) {
      throw new Error("工具返回了无效结果。");
    }
    return payload as Record<string, unknown>;
  }

  function restoredPlanResult(
    payload: Record<string, unknown>,
  ): TaskPlan | undefined {
    if (payload.ok !== true) return undefined;
    try {
      return restoreTaskPlan(payload.plan);
    } catch {
      throw new Error("计划工具返回了无效结果。");
    }
  }

  async function* stream(
    input: string,
    signal?: AbortSignal,
  ): AsyncGenerator<ConversationEvent> {
    if (turnActive) {
      throw new Error("当前已有请求正在处理中，请等待完成或取消后重试。");
    }
    turnActive = true;

    try {
      signal?.throwIfAborted();
      const initialSession = session.getCurrent();
      let expectedSession = sessionIdentity(initialSession);
      const turnModel = session.getModel();
      if (!turnModel) {
        throw new Error("尚未选择模型，请先使用 /login 登录，再使用 /model 选择模型。");
      }
      const turnProviderId = turnModel.providerId;
      const turnModelId = turnModel.id;
      const expectedModel: ModelIdentityToken = {
        providerId: turnProviderId,
        modelId: turnModelId,
      };

      let resolvedApiKey: string | undefined;
      try {
        resolvedApiKey = await resolveApiKey(turnModel.credentialId);
      } catch (error) {
        assertSessionUnchanged(expectedSession, expectedModel);
        throw error;
      }
      assertSessionUnchanged(expectedSession, expectedModel);
      const apiKey = resolvedApiKey?.trim();
      if (!apiKey) {
        throw new Error("当前模型缺少登录凭证，请使用 /login 登录后重试。");
      }

      const currentTurnMessages: PersistedMessage[] = [
        { role: "user", content: input },
      ];
      const priorRoundEvidence = new Set<string>();
      let evidencePlan: TaskPlan | undefined;
      let unresolvedFailure: PlanStepBinding | undefined;
      let maxToolRounds = DEFAULT_MAX_TOOL_ROUNDS;
      {
        const compressionSnapshot = assertSessionUnchanged(
          expectedSession,
          expectedModel,
        );
        const compressionPlan = ongoingPlanSnapshot(
          planning,
          compressionSnapshot,
        );
        evidencePlan = compressionPlan;
        assertSessionUnchanged(expectedSession, expectedModel);
        if (compressionPlan !== undefined) {
          maxToolRounds = Math.max(
            maxToolRounds,
            planRoundBudget(compressionPlan),
          );
        }
        const compressionSystemPrompt =
          systemPrompt + planSystemContext(compressionPlan);
        const compression = planCompression({
          systemPrompt: compressionSystemPrompt,
          summary: compressionSnapshot.summary,
          turns: uncompressedTurns(compressionSnapshot),
          currentMessages: currentTurnMessages,
          preferences: historyPreferences,
        });
        if (compression.shouldCompress) {
          yield { type: "status", text: "正在整理较早的对话…" };
          assertSessionUnchanged(expectedSession, expectedModel);
          let generatedSummary: string | undefined;
          try {
            const candidateContent = await generateSummary({
              gateway,
              model: turnModel,
              apiKey,
              source: compression.source!,
              targetChars: historyPreferences.summaryTargetChars,
              signal,
            });
            signal?.throwIfAborted();
            assertSessionUnchanged(expectedSession, expectedModel);
            const throughTurnSequence = compression.throughTurnSequence!;
            const remainingTurns = compressionSnapshot.turns.filter(
              (turn) => turn.sequence > throughTurnSequence,
            );
            const candidateSummary: StoredSummary = {
              throughTurnSequence,
              content: candidateContent,
              sourceRevision: compressionSnapshot.revision ?? 0,
              createdAt: "",
              updatedAt: "",
            };
            const candidateContext = buildContext({
              systemPrompt: compressionSystemPrompt,
              summary: candidateSummary,
              turns: remainingTurns,
              currentMessages: currentTurnMessages,
              preferences: historyPreferences,
            });
            const includesAllRemainingTurns =
              candidateContext.includedTurnSequences.length ===
                remainingTurns.length &&
              candidateContext.includedTurnSequences.every(
                (sequence, index) => sequence === remainingTurns[index]!.sequence,
              );
            if (
              includesAllRemainingTurns &&
              candidateContext.cost <=
                historyPreferences.compressionThresholdChars
            ) {
              generatedSummary = candidateContent;
            }
          } catch (error) {
            if (
              signal?.aborted ||
              (error instanceof Error && error.name === "AbortError")
            ) {
              throw error;
            }
            assertSessionUnchanged(expectedSession, expectedModel);
          }
          if (generatedSummary !== undefined) {
            assertSessionUnchanged(expectedSession, expectedModel);
            session.saveSummary(
              compression.throughTurnSequence!,
              generatedSummary,
            );
            expectedSession = refreshSessionAfterSummary(
              expectedSession,
              expectedModel,
            );
          }
        }

        for (let round = 0; round < maxToolRounds; round += 1) {
          signal?.throwIfAborted();
          const current = assertSessionUnchanged(
            expectedSession,
            expectedModel,
          );
          let trustedPlan = ongoingPlanSnapshot(planning, current);
          if (!hasSamePlanIdentity(evidencePlan, trustedPlan)) {
            priorRoundEvidence.clear();
          }
          if (
            unresolvedFailure !== undefined &&
            !bindingIsInProgress(unresolvedFailure, trustedPlan)
          ) {
            unresolvedFailure = undefined;
          }
          evidencePlan = trustedPlan;
          assertSessionUnchanged(expectedSession, expectedModel);
          if (trustedPlan !== undefined) {
            maxToolRounds = Math.max(
              maxToolRounds,
              planRoundBudget(trustedPlan),
            );
          }
          const messages = buildContext({
            systemPrompt: systemPrompt + planSystemContext(trustedPlan),
            summary: current.summary,
            turns: uncompressedTurns(current),
            currentMessages: currentTurnMessages,
            preferences: historyPreferences,
          }).messages;
          let assistant: ModelReply | undefined;
          let reasoningStatusShown = false;
          let hasVisibleText = false;
          try {
            for await (const event of gateway.stream({
              model: turnModel,
              apiKey,
              messages,
              tools: tools.definitions,
              signal,
            })) {
              if (event.type === "reasoning_delta" && !reasoningStatusShown) {
                reasoningStatusShown = true;
                yield { type: "status", text: "正在分析问题…" };
              } else if (event.type === "text_delta") {
                hasVisibleText = true;
                yield event;
              } else if (event.type === "fallback") {
                yield {
                  type: "fallback",
                  text: "当前模型暂不支持流式输出，已切换为完整输出。",
                };
              } else if (event.type === "done") {
                assistant = event.reply;
              }
            }
          } catch (error) {
            assertSessionUnchanged(expectedSession, expectedModel);
            throw error;
          }
          signal?.throwIfAborted();
          assertSessionIdentityUnchanged(expectedSession);
          if (assistant === undefined) {
            assertSessionUnchanged(expectedSession, expectedModel);
            throw new Error("模型流未返回最终正文。");
          }

          const providerPlan = trustedPlan;
          const postProviderSession = assertSessionUnchanged(
            expectedSession,
            expectedModel,
          );
          const postProviderPlan = ongoingPlanSnapshot(
            planning,
            postProviderSession,
          );
          let planConflictInBatch = !hasSamePlanIdentity(
            providerPlan,
            postProviderPlan,
          );
          if (planConflictInBatch) {
            priorRoundEvidence.clear();
          }
          trustedPlan = postProviderPlan;
          if (
            unresolvedFailure !== undefined &&
            !bindingIsInProgress(unresolvedFailure, trustedPlan)
          ) {
            unresolvedFailure = undefined;
          }
          evidencePlan = postProviderPlan;
          assertSessionUnchanged(expectedSession, expectedModel);
          if (trustedPlan !== undefined) {
            maxToolRounds = Math.max(
              maxToolRounds,
              planRoundBudget(trustedPlan),
            );
          }
          compactConsumedPlanningResults(currentTurnMessages);
          const assistantMessage: PersistedMessage = {
            role: "assistant",
            content: assistant.content ?? "",
            toolCalls: structuredClone(assistant.toolCalls),
            ...(assistant.reasoning === undefined
              ? {}
              : { reasoning: structuredClone(assistant.reasoning) }),
          };
          currentTurnMessages.push(assistantMessage);

          if (assistant.toolCalls.length === 0) {
            if (!assistant.content || assistant.content.trim().length === 0) {
              throw new Error("模型提供商返回了无效的 assistant 文本。");
            }
            if (planConflictInBatch) {
              throw new Error(
                "持久计划已在本次 provider 请求期间发生变化，禁止提交基于旧计划的最终回答。",
              );
            }
            if (unresolvedFailure !== undefined) {
              throw new Error(
                "普通工具失败尚未通过匹配的 fail_step 或 block_step 记录，禁止结束本轮。",
              );
            }
            try {
              assertSessionUnchanged(expectedSession, expectedModel);
              session.commitTurn(currentTurnMessages);
            } catch (error) {
              throw new Error(
                `回答已生成，但历史保存失败，本轮未记录：${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            yield { type: "done", content: assistant.content };
            return;
          }

          if (hasVisibleText) {
            yield { type: "segment_end" };
          }
          const ordinaryToolIndexes = assistant.toolCalls
            .map((toolCall, index) =>
              PLANNING_TOOL_NAMES.has(toolCall.name) ? -1 : index
            )
            .filter((index) => index >= 0);
          const firstOrdinaryToolIndex = ordinaryToolIndexes[0];
          const planningGateRequired =
            trustedPlan !== undefined ||
            assistant.toolCalls.some((toolCall) =>
              PLANNING_TOOL_NAMES.has(toolCall.name)
            );
          let planningFailureInBatch = false;
          let ordinaryExecutionFailureInBatch = false;
          const pendingEvidence = new Set<string>();
          for (
            let toolIndex = 0;
            toolIndex < assistant.toolCalls.length;
            toolIndex += 1
          ) {
            const toolCall = assistant.toolCalls[toolIndex]!;
            const isPlanningTool = PLANNING_TOOL_NAMES.has(toolCall.name);
            if (toolIndex === firstOrdinaryToolIndex) {
              yield { type: "status", text: "正在准备调用工具…" };
            }
            if (!isPlanningTool) {
              const startEvent: ToolActivityEvent = {
                name: toolCall.name,
                phase: "start",
              };
              yield { type: "tool_activity", event: startEvent };
            }
            const preToolSession = assertSessionUnchanged(
              expectedSession,
              expectedModel,
            );
            const persistedPlan = ongoingPlanSnapshot(
              planning,
              preToolSession,
            );
            assertSessionUnchanged(expectedSession, expectedModel);
            if (!hasSamePlanIdentity(trustedPlan, persistedPlan)) {
              planConflictInBatch = true;
              priorRoundEvidence.clear();
              pendingEvidence.clear();
              trustedPlan = persistedPlan;
              evidencePlan = persistedPlan;
            }
            if (
              unresolvedFailure !== undefined &&
              !bindingIsInProgress(unresolvedFailure, trustedPlan)
            ) {
              unresolvedFailure = undefined;
            }

            let result: string;
            let executed = false;
            const updateDescriptor = planningUpdateDescriptor(toolCall);
            const bindingForCall = !isPlanningTool
              ? ordinaryPlanStepBinding(trustedPlan)
              : undefined;
            const evidenceKeyForCall = !isPlanningTool
              ? ordinaryEvidenceKey(trustedPlan)
              : undefined;
            if (
              planConflictInBatch
            ) {
              result = localToolFailure(
                "持久计划已在本批执行期间发生变化，后续工具调用已因计划冲突被阻止。",
              );
            } else if (
              isPlanningTool &&
              ordinaryExecutionFailureInBatch &&
              !SAFE_ACTIONS_AFTER_TOOL_FAILURE.has(
                updateDescriptor?.action ?? "",
              )
            ) {
              result = localToolFailure(
                "本批普通工具失败后，禁止 complete_step、finish_plan 或继续执行；请先调用 fail_step、block_step 或安全地重规划。",
              );
            } else if (
              !isPlanningTool &&
              ordinaryExecutionFailureInBatch
            ) {
              result = localToolFailure(
                "本批已有普通工具失败，后续普通工具调用已被阻止且未执行。",
              );
            } else if (
              unresolvedFailure !== undefined &&
              !isPlanningTool
            ) {
              result = localToolFailure(
                "上一轮普通工具失败尚未通过匹配的 fail_step 或 block_step 记录，新的普通工具调用已被阻止。",
              );
            } else if (
              unresolvedFailure !== undefined &&
              (
                toolCall.name === "finish_plan" ||
                updateDescriptor?.action === "complete_step"
              )
            ) {
              result = localToolFailure(
                "上一轮普通工具失败尚未通过匹配的 fail_step 或 block_step 记录，禁止 complete_step 或 finish_plan。",
              );
            } else if (
              isPlanningTool &&
              updateDescriptor?.action === "complete_step" &&
              !hasPriorRoundCompletionEvidence(
                updateDescriptor,
                trustedPlan,
                priorRoundEvidence,
              )
            ) {
              result = localToolFailure(
                "complete_step 需要同一 planId 和 stepId 在前一 provider 轮返回的真实普通工具成功证据。",
              );
            } else if (
              !isPlanningTool &&
              planningGateRequired &&
              (
                planningFailureInBatch ||
                !canExecuteOrdinaryTool(trustedPlan)
              )
            ) {
              result = localToolFailure(
                planningFailureInBatch
                  ? "计划调用失败，执行门禁已阻止本批后续普通工具。"
                  : "计划执行门禁要求先成功调用 start_step，并保持唯一 in_progress 步骤。",
              );
            } else {
              try {
                executed = true;
                result = await tools.execute(
                  toolCall.name,
                  toolCall.argumentsJson,
                  signal,
                );
              } catch (error) {
                assertSessionUnchanged(expectedSession, expectedModel);
                throw error;
              }
            }
            const resultPayload = parseToolResultPayload(result);
            const plan = isPlanningTool
              ? restoredPlanResult(resultPayload)
              : undefined;
            if (toolCall.name === "create_plan" && plan !== undefined) {
              expectedSession = refreshSessionAfterCreatePlan(
                expectedSession,
                expectedModel,
                plan,
              );
            } else {
              assertSessionUnchanged(expectedSession, expectedModel);
            }
            if (
              plan !== undefined &&
              plan.sessionId !== expectedSession.id
            ) {
              throw new Error("计划工具返回了无效结果。");
            }
            if (isPlanningTool) {
              if (plan === undefined) {
                planningFailureInBatch = true;
              } else {
                if (
                  toolCall.name === "create_plan" ||
                  toolCall.name === "finish_plan" ||
                  updateDescriptor?.action === "replace_pending_steps"
                ) {
                  priorRoundEvidence.clear();
                  pendingEvidence.clear();
                } else if (
                  updateDescriptor?.planId !== undefined &&
                  updateDescriptor.stepId !== undefined &&
                  [
                    "start_step",
                    "retry_step",
                    "resume_step",
                    "complete_step",
                    "fail_step",
                    "block_step",
                  ].includes(updateDescriptor.action)
                ) {
                  const invalidated = planEvidenceKey(
                    updateDescriptor.planId,
                    updateDescriptor.stepId,
                  );
                  priorRoundEvidence.delete(invalidated);
                  pendingEvidence.delete(invalidated);
                }
                trustedPlan =
                  plan.status === "active" || plan.status === "blocked"
                    ? plan
                    : undefined;
                if (
                  unresolvedFailure !== undefined &&
                  updateDescriptor?.planId === unresolvedFailure.planId &&
                  updateDescriptor.stepId === unresolvedFailure.stepId &&
                  (
                    updateDescriptor.action === "fail_step" ||
                    updateDescriptor.action === "block_step"
                  )
                ) {
                  unresolvedFailure = undefined;
                } else if (
                  unresolvedFailure !== undefined &&
                  !bindingIsInProgress(unresolvedFailure, trustedPlan)
                ) {
                  unresolvedFailure = undefined;
                }
                evidencePlan = trustedPlan;
                maxToolRounds = Math.max(
                  maxToolRounds,
                  planRoundBudget(plan),
                );
              }
            } else {
              if (
                executed &&
                resultPayload.ok === true &&
                evidenceKeyForCall !== undefined
              ) {
                pendingEvidence.add(evidenceKeyForCall);
              }
              if (resultPayload.ok !== true) {
                if (executed && bindingForCall !== undefined) {
                  unresolvedFailure = bindingForCall;
                }
                if (executed && evidenceKeyForCall !== undefined) {
                  priorRoundEvidence.delete(evidenceKeyForCall);
                  pendingEvidence.delete(evidenceKeyForCall);
                } else {
                  clearPlanEvidence(
                    trustedPlan,
                    priorRoundEvidence,
                    pendingEvidence,
                  );
                }
                ordinaryExecutionFailureInBatch = true;
              }
            }
            signal?.throwIfAborted();
            assertSessionUnchanged(expectedSession, expectedModel);
            if (isPlanningTool) {
              if (plan !== undefined) {
                yield { type: "plan_activity", plan };
              }
            } else {
              const endEvent: ToolActivityEvent = {
                name: toolCall.name,
                phase: resultPayload.ok === true ? "success" : "error",
              };
              yield { type: "tool_activity", event: endEvent };
            }
            currentTurnMessages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: result,
            });
          }
          if (
            !ordinaryExecutionFailureInBatch &&
            !planConflictInBatch
          ) {
            for (const key of pendingEvidence) {
              if (
                priorRoundEvidence.size >= MAX_PLAN_EVIDENCE_ENTRIES &&
                !priorRoundEvidence.has(key)
              ) {
                const oldest = priorRoundEvidence.values().next().value;
                if (typeof oldest === "string") {
                  priorRoundEvidence.delete(oldest);
                }
              }
              priorRoundEvidence.add(key);
            }
          }
          if (ordinaryToolIndexes.length > 0) {
            yield { type: "status", text: "正在整理工具结果…" };
          }
        }
        throw new Error(
          `工具调用超过 ${maxToolRounds} 轮，已停止本次请求。`,
        );
      }
    } finally {
      turnActive = false;
    }
  }

  async function send(input: string, signal?: AbortSignal): Promise<string> {
    let finalContent: string | undefined;
    for await (const event of stream(input, signal)) {
      if (event.type === "done") {
        finalContent = event.content;
      }
    }
    if (finalContent === undefined) {
      throw new Error("模型流未返回最终正文。");
    }
    return finalContent;
  }

  return {
    getModel() {
      return session.getModel();
    },

    setModel(model) {
      if (turnActive) {
        throw new Error("当前请求正在处理中，不能切换模型。");
      }
      session.setModel(model);
    },

    stream,
    send,
  };
}
