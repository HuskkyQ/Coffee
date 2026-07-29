import type { ModelMessage } from "../models/types.js";
import { decodeMessageRow, encodeMessage } from "./message-codec.js";
import type {
  HistoryPreferences,
  PersistedMessage,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export const SUMMARY_PREFIX = "以下是较早对话的滚动摘要，仅作为上下文：\n";

const SAFE_DATA_ERROR = "上下文数据无法安全处理。";
const SENSITIVE_KEY =
  /api[_-]?key|authorization|token|secret|(?:^|[_-])auth(?:$|[_-])/i;

class UnsafeContextDataError extends Error {}

class ContextLimitError extends Error {}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unsafe(): never {
  throw new UnsafeContextDataError(SAFE_DATA_ERROR);
}

function safely<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ContextLimitError) throw error;
    throw new Error(SAFE_DATA_ERROR);
  }
}

function ownKeys(value: object): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return unsafe();
  }
}

function ownProperty(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return unsafe();
  }
}

function prototypeOf(value: object): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return unsafe();
  }
}

function stableSerialize(value: unknown): string {
  const active = new Set<object>();

  function visit(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string") return JSON.stringify(item);
    if (typeof item === "boolean") return item ? "true" : "false";
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return unsafe();
      return Object.is(item, -0) ? "0" : String(item);
    }
    if (typeof item !== "object") return unsafe();
    if (active.has(item)) return unsafe();

    active.add(item);
    try {
      if (Array.isArray(item)) {
        const lengthProperty = ownProperty(item, "length");
        if (
          lengthProperty === undefined ||
          !("value" in lengthProperty) ||
          !Number.isSafeInteger(lengthProperty.value) ||
          lengthProperty.value < 0
        ) {
          return unsafe();
        }

        const values: string[] = [];
        for (let index = 0; index < lengthProperty.value; index += 1) {
          const property = ownProperty(item, String(index));
          if (
            property === undefined ||
            !("value" in property) ||
            !property.enumerable
          ) {
            return unsafe();
          }
          values.push(visit(property.value));
        }

        for (const key of ownKeys(item)) {
          if (typeof key !== "string") return unsafe();
          if (key === "length" || /^(0|[1-9]\d*)$/.test(key)) continue;
          const property = ownProperty(item, key);
          if (property?.enumerable) return unsafe();
        }
        return `[${values.join(",")}]`;
      }

      const prototype = prototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return unsafe();

      const entries: Array<readonly [string, unknown]> = [];
      for (const key of ownKeys(item)) {
        if (typeof key !== "string") return unsafe();
        const property = ownProperty(item, key);
        if (property === undefined || !property.enumerable) continue;
        if (!("value" in property)) return unsafe();
        entries.push([key, property.value]);
      }
      entries.sort(([left], [right]) => compareStrings(left, right));
      return `{${entries
        .map(([key, entryValue]) => `${JSON.stringify(key)}:${visit(entryValue)}`)
        .join(",")}}`;
    } finally {
      active.delete(item);
    }
  }

  return visit(value);
}

export function stableCharacterCost(value: unknown): number {
  return safely(() => stableSerialize(value).length);
}

function requiredOwnData(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return unsafe();
  const property = ownProperty(value, key);
  if (property === undefined || !("value" in property)) return unsafe();
  return property.value;
}

function optionalOwnData(value: unknown, key: PropertyKey): unknown {
  if (typeof value !== "object" || value === null) return unsafe();
  const property = ownProperty(value, key);
  if (property === undefined) return undefined;
  if (!("value" in property)) return unsafe();
  return property.value;
}

function denseArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) return unsafe();
  const length = requiredOwnData(value, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 0) return unsafe();

  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    result.push(requiredOwnData(value, String(index)));
  }
  return result;
}

function summaryMessage(summary: StoredSummary | undefined): ModelMessage[] {
  if (summary === undefined) return [];
  if (typeof summary.content !== "string") return unsafe();
  return [
    { role: "system", content: `${SUMMARY_PREFIX}${summary.content}` },
  ];
}

function normalizePersistedMessages(value: unknown): PersistedMessage[] {
  return denseArray(value).map((message) =>
    decodeMessageRow(encodeMessage(message as PersistedMessage)));
}

function normalizeSummary(value: unknown): StoredSummary {
  const throughTurnSequence = requiredOwnData(value, "throughTurnSequence");
  const content = requiredOwnData(value, "content");
  const sourceRevision = requiredOwnData(value, "sourceRevision");
  const createdAt = requiredOwnData(value, "createdAt");
  const updatedAt = requiredOwnData(value, "updatedAt");
  if (
    !Number.isSafeInteger(throughTurnSequence) ||
    typeof content !== "string" ||
    !Number.isSafeInteger(sourceRevision) ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return unsafe();
  }
  return {
    throughTurnSequence: throughTurnSequence as number,
    content,
    sourceRevision: sourceRevision as number,
    createdAt,
    updatedAt,
  };
}

function normalizeTurns(value: unknown): StoredTurn[] {
  return denseArray(value).map((item) => {
    const id = requiredOwnData(item, "id");
    const sequence = requiredOwnData(item, "sequence");
    const createdAt = requiredOwnData(item, "createdAt");
    const messages = requiredOwnData(item, "messages");
    if (
      typeof id !== "string" ||
      !Number.isSafeInteger(sequence) ||
      typeof createdAt !== "string"
    ) {
      return unsafe();
    }
    return {
      id,
      sequence: sequence as number,
      createdAt,
      messages: normalizePersistedMessages(messages),
    };
  });
}

function normalizePreferences(value: unknown): HistoryPreferences {
  const summaryTargetChars = requiredOwnData(value, "summaryTargetChars");
  const compressionThresholdChars = requiredOwnData(
    value,
    "compressionThresholdChars",
  );
  const maxContextChars = requiredOwnData(value, "maxContextChars");
  if (
    !Number.isSafeInteger(summaryTargetChars) ||
    !Number.isSafeInteger(compressionThresholdChars) ||
    !Number.isSafeInteger(maxContextChars) ||
    (summaryTargetChars as number) <= 0 ||
    (summaryTargetChars as number) >= (compressionThresholdChars as number) ||
    (compressionThresholdChars as number) >= (maxContextChars as number)
  ) {
    return unsafe();
  }
  return {
    summaryTargetChars: summaryTargetChars as number,
    compressionThresholdChars: compressionThresholdChars as number,
    maxContextChars: maxContextChars as number,
  };
}

export interface BuildContextInput {
  readonly systemPrompt: string;
  readonly summary?: StoredSummary;
  readonly turns: readonly StoredTurn[];
  readonly currentMessages: readonly PersistedMessage[];
  readonly preferences: HistoryPreferences;
}

export interface BuiltContext {
  readonly messages: readonly ModelMessage[];
  readonly includedTurnSequences: readonly number[];
  readonly cost: number;
}

interface NormalizedBuildInput {
  readonly systemPrompt: string;
  readonly summary?: StoredSummary;
  readonly turns: readonly StoredTurn[];
  readonly currentMessages: readonly PersistedMessage[];
  readonly preferences: HistoryPreferences;
}

function normalizeBuildInput(input: BuildContextInput): NormalizedBuildInput {
  const systemPrompt = requiredOwnData(input, "systemPrompt");
  const summary = optionalOwnData(input, "summary");
  const turns = requiredOwnData(input, "turns");
  const currentMessages = requiredOwnData(input, "currentMessages");
  const preferences = requiredOwnData(input, "preferences");
  if (typeof systemPrompt !== "string") return unsafe();

  const normalized = {
    systemPrompt,
    summary: summary === undefined
      ? undefined
      : normalizeSummary(summary),
    turns: normalizeTurns(turns),
    currentMessages: normalizePersistedMessages(currentMessages),
    preferences: normalizePreferences(preferences),
  };
  return normalized;
}

function assembleMessages(
  input: NormalizedBuildInput,
  turns: readonly StoredTurn[],
  replacementSummary?: StoredSummary,
): ModelMessage[] {
  const effectiveSummary = replacementSummary ?? input.summary;
  return [
    { role: "system", content: input.systemPrompt },
    ...summaryMessage(effectiveSummary),
    ...turns.flatMap((turn) => turn.messages),
    ...input.currentMessages,
  ];
}

function serializedArrayCost(itemCosts: readonly number[]): number {
  return 2 + itemCosts.reduce((total, cost) => total + cost, 0) +
    Math.max(0, itemCosts.length - 1);
}

function baseContextCost(
  input: NormalizedBuildInput,
  summary: StoredSummary | undefined,
): number {
  const messages = [
    { role: "system" as const, content: input.systemPrompt },
    ...summaryMessage(summary),
    ...input.currentMessages,
  ];
  return serializedArrayCost(
    messages.map((message) => stableSerialize(message).length),
  );
}

function turnMessageContribution(turn: StoredTurn): number {
  return turn.messages.reduce(
    (total, message) => total + stableSerialize(message).length + 1,
    0,
  );
}

export function buildContext(input: BuildContextInput): BuiltContext {
  return safely(() => {
    const normalized = normalizeBuildInput(input);
    const mandatoryCost = baseContextCost(normalized, normalized.summary);
    if (mandatoryCost > normalized.preferences.maxContextChars) {
      throw new ContextLimitError("当前回合超过上下文上限。");
    }

    const turnCosts = normalized.turns.map(turnMessageContribution);
    let selectedStart = normalized.turns.length;
    let cost = mandatoryCost;
    for (let index = normalized.turns.length - 1; index >= 0; index -= 1) {
      const candidateCost = cost + turnCosts[index]!;
      if (candidateCost > normalized.preferences.maxContextChars) break;
      selectedStart = index;
      cost = candidateCost;
    }

    const selected = normalized.turns.slice(selectedStart);
    const messages = assembleMessages(normalized, selected);
    return {
      messages,
      includedTurnSequences: selected.map((turn) => turn.sequence),
      cost,
    };
  });
}

export interface CompressionPlan {
  readonly shouldCompress: boolean;
  readonly throughTurnSequence?: number;
  readonly source?: string;
}

function targetSummary(targetChars: number): StoredSummary {
  return {
    throughTurnSequence: 0,
    content: "x".repeat(targetChars),
    sourceRevision: 0,
    createdAt: "",
    updatedAt: "",
  };
}

export function planCompression(input: BuildContextInput): CompressionPlan {
  return safely(() => {
    const normalized = normalizeBuildInput(input);
    const turnCosts = normalized.turns.map(turnMessageContribution);
    let remainingTurnCost = turnCosts.reduce(
      (total, cost) => total + cost,
      0,
    );
    const fullCost =
      baseContextCost(normalized, normalized.summary) + remainingTurnCost;
    if (
      fullCost < normalized.preferences.compressionThresholdChars ||
      normalized.turns.length === 0
    ) {
      return { shouldCompress: false };
    }

    const placeholder = targetSummary(normalized.preferences.summaryTargetChars);
    const compressedBaseCost = baseContextCost(normalized, placeholder);
    for (let count = 1; count <= normalized.turns.length; count += 1) {
      remainingTurnCost -= turnCosts[count - 1]!;
      const projectedCost = compressedBaseCost + remainingTurnCost;
      if (projectedCost <= normalized.preferences.compressionThresholdChars) {
        const selected = normalized.turns.slice(0, count);
        return {
          shouldCompress: true,
          throughTurnSequence: selected[selected.length - 1]!.sequence,
          source: createSummarySource(normalized.summary, selected),
        };
      }
    }

    return { shouldCompress: false };
  });
}

function redactPlainText(text: string): string {
  return text
    .replace(/\bBearer\s+[^\s,;"']+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/\btvly-[A-Za-z0-9._-]+/gi, "[REDACTED]");
}

function redactJsonValue(value: unknown): unknown {
  if (typeof value === "string") return redactPlainText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (typeof value !== "object") return unsafe();

  const redacted = Object.create(null) as Record<string, unknown>;
  const keys = Object.keys(value).sort(compareStrings);
  for (const key of keys) {
    Object.defineProperty(redacted, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactJsonValue((value as Record<string, unknown>)[key]),
    });
  }
  return redacted;
}

function redactText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return redactPlainText(text);
  }
  return stableSerialize(redactJsonValue(parsed));
}

export function redactSummaryContent(text: string): string {
  return safely(() => {
    if (typeof text !== "string") return unsafe();
    return redactText(text);
  });
}

function sourceMessageLines(message: unknown): string[] {
  const role = requiredOwnData(message, "role");
  const content = requiredOwnData(message, "content");
  if (typeof role !== "string" || typeof content !== "string") return unsafe();

  if (role === "user") return [`用户：${redactText(content)}`];
  if (role === "tool") return [`工具结果：${redactText(content)}`];
  if (role !== "assistant") return unsafe();

  const lines = [`助手：${redactText(content)}`];
  const toolCalls = denseArray(requiredOwnData(message, "toolCalls"));
  for (const toolCall of toolCalls) {
    const name = requiredOwnData(toolCall, "name");
    const argumentsJson = requiredOwnData(toolCall, "argumentsJson");
    if (typeof name !== "string" || typeof argumentsJson !== "string") {
      return unsafe();
    }
    lines.push(
      `助手工具调用：${redactText(name)}`,
      `参数：${redactText(argumentsJson)}`,
    );
  }
  return lines;
}

export function createSummarySource(
  previousSummary: StoredSummary | undefined,
  turns: readonly StoredTurn[],
): string {
  return safely(() => {
    const parts: string[] = [];
    if (previousSummary !== undefined) {
      const content = requiredOwnData(previousSummary, "content");
      if (typeof content !== "string") return unsafe();
      parts.push(`已有摘要：\n${redactText(content)}`);
    }

    for (const [index, item] of denseArray(turns).entries()) {
      const messages = denseArray(requiredOwnData(item, "messages"));
      const lines = [`轮次 ${index + 1}：`];
      for (const message of messages) lines.push(...sourceMessageLines(message));
      parts.push(lines.join("\n"));
    }
    return parts.join("\n\n");
  });
}
