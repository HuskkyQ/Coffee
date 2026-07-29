import type {
  ModelReasoning,
  ModelReasoningField,
  ModelToolCall,
} from "../models/types.js";
import type { PersistedMessage } from "./types.js";

export interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  reasoning_json: string | null;
}

const REASONING_FIELDS: readonly ModelReasoningField[] = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
];
const ABSENT = Symbol("absent");

interface OwnDataProperty {
  readonly value: unknown;
  readonly enumerable: boolean;
}

function corrupt(detail: string): never {
  throw new Error(`历史消息数据损坏：${detail}。`);
}

function isArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return corrupt("对象类型无法安全检查");
  }
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return corrupt("对象原型无法安全检查");
  }
}

function ownDataProperty(
  object: object,
  key: PropertyKey,
  detail: string,
): OwnDataProperty | undefined {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return corrupt(detail);
  }
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) return corrupt(detail);
  return { value: descriptor.value, enumerable: descriptor.enumerable ?? false };
}

function requiredOwnData(
  object: object,
  key: PropertyKey,
  detail: string,
): unknown {
  const property = ownDataProperty(object, key, detail);
  if (property === undefined) return corrupt(detail);
  return property.value;
}

function optionalOwnData(
  object: object,
  key: PropertyKey,
  detail: string,
): unknown | typeof ABSENT {
  const property = ownDataProperty(object, key, detail);
  return property === undefined ? ABSENT : property.value;
}

function ownKeys(object: object, detail: string): readonly PropertyKey[] {
  try {
    return Reflect.ownKeys(object);
  } catch {
    return corrupt(detail);
  }
}

function parseJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return corrupt(`${field} 不是有效 JSON`);
  }
}

function blockInheritedToJson(
  value: unknown,
  visited = new Set<object>(),
): void {
  if (typeof value !== "object" || value === null || visited.has(value)) return;
  visited.add(value);

  if (Object.getOwnPropertyDescriptor(value, "toJSON") === undefined) {
    Object.defineProperty(value, "toJSON", {
      configurable: true,
      enumerable: false,
      value: undefined,
      writable: true,
    });
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      "value" in descriptor &&
      descriptor.enumerable
    ) {
      blockInheritedToJson(descriptor.value, visited);
    }
  }
}

function stringifyJson(value: unknown, field: string): string {
  try {
    blockInheritedToJson(value);
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return corrupt(`${field} 无法编码为 JSON`);
    return encoded;
  } catch {
    return corrupt(`${field} 无法编码为 JSON`);
  }
}

function arrayElements(value: unknown, detail: string): unknown[] {
  if (!isArray(value)) return corrupt(detail);
  const length = requiredOwnData(value, "length", detail);
  if (!Number.isSafeInteger(length) || (length as number) < 0) {
    return corrupt(detail);
  }

  const elements: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    elements.push(requiredOwnData(value, String(index), detail));
  }
  return elements;
}

function normalizeToolCalls(value: unknown): ModelToolCall[] {
  const items = arrayElements(value, "tool_calls_json 结构无效");
  return items.map((item) => {
    if (!isPlainObject(item)) return corrupt("tool_calls_json 结构无效");
    const id = requiredOwnData(item, "id", "tool_calls_json 结构无效");
    const name = requiredOwnData(item, "name", "tool_calls_json 结构无效");
    const argumentsJson = requiredOwnData(
      item,
      "argumentsJson",
      "tool_calls_json 结构无效",
    );
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof argumentsJson !== "string"
    ) {
      return corrupt("tool_calls_json 结构无效");
    }
    return { id, name, argumentsJson };
  });
}

function parseToolCalls(text: string | null): ModelToolCall[] {
  if (text === null) return [];
  return normalizeToolCalls(parseJson(text, "tool_calls_json"));
}

function cloneJsonSafeValue(value: unknown, active: Set<object>): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return corrupt("reasoning details 不是安全 JSON");
    }
    return value;
  }
  if (typeof value !== "object") {
    return corrupt("reasoning details 不是安全 JSON");
  }

  if (active.has(value)) return corrupt("reasoning details 包含循环引用");
  active.add(value);
  try {
    if (isArray(value)) {
      const lengthProperty = ownDataProperty(
        value,
        "length",
        "reasoning details 无法安全读取",
      );
      if (
        lengthProperty === undefined ||
        lengthProperty.enumerable ||
        !Number.isSafeInteger(lengthProperty.value) ||
        (lengthProperty.value as number) < 0
      ) {
        return corrupt("reasoning details 数组结构无效");
      }
      const length = lengthProperty.value as number;
      const keys = ownKeys(value, "reasoning details 无法安全读取");
      if (keys.length !== length + 1 || keys.some((key) => typeof key === "symbol")) {
        return corrupt("reasoning details 数组结构无效");
      }

      const cloned: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const property = ownDataProperty(
          value,
          String(index),
          "reasoning details 无法安全读取",
        );
        if (property === undefined || !property.enumerable) {
          return corrupt("reasoning details 数组结构无效");
        }
        cloned.push(cloneJsonSafeValue(property.value, active));
      }
      return cloned;
    }

    if (!isPlainObject(value)) {
      return corrupt("reasoning details 不是安全 JSON");
    }
    const keys = ownKeys(value, "reasoning details 无法安全读取");
    if (keys.some((key) => typeof key === "symbol")) {
      return corrupt("reasoning details 不是安全 JSON");
    }

    const cloned: Record<string, unknown> = {};
    for (const key of keys as string[]) {
      const property = ownDataProperty(
        value,
        key,
        "reasoning details 无法安全读取",
      );
      if (property === undefined || !property.enumerable) {
        return corrupt("reasoning details 不是安全 JSON");
      }
      Object.defineProperty(cloned, key, {
        configurable: true,
        enumerable: true,
        value: cloneJsonSafeValue(property.value, active),
        writable: true,
      });
    }
    return cloned;
  } finally {
    active.delete(value);
  }
}

function cloneReasoningDetails(value: unknown): unknown[] {
  if (!isArray(value)) return corrupt("reasoning details 无效");
  return cloneJsonSafeValue(value, new Set()) as unknown[];
}

function normalizeReasoning(value: unknown): ModelReasoning {
  if (!isPlainObject(value)) return corrupt("reasoning_json 结构无效");
  const providerId = requiredOwnData(
    value,
    "providerId",
    "reasoning_json 结构无效",
  );
  if (typeof providerId !== "string" || providerId.length === 0) {
    return corrupt("reasoning_json 结构无效");
  }

  const field = optionalOwnData(value, "field", "reasoning field 无效");
  if (
    field !== ABSENT &&
    field !== undefined &&
    (typeof field !== "string" ||
      !REASONING_FIELDS.includes(field as ModelReasoningField))
  ) {
    return corrupt("reasoning field 无效");
  }
  const text = optionalOwnData(value, "text", "reasoning text 无效");
  if (text !== ABSENT && text !== undefined && typeof text !== "string") {
    return corrupt("reasoning text 无效");
  }
  const details = optionalOwnData(value, "details", "reasoning details 无效");

  const normalized: {
    providerId: string;
    field?: ModelReasoningField;
    text?: string;
    details?: unknown[];
  } = { providerId };
  if (field !== ABSENT && field !== undefined) {
    normalized.field = field as ModelReasoningField;
  }
  if (text !== ABSENT && text !== undefined) normalized.text = text as string;
  if (details !== ABSENT && details !== undefined) {
    normalized.details = cloneReasoningDetails(details);
  }
  return normalized;
}

function parseReasoning(text: string | null): ModelReasoning | undefined {
  if (text === null) return undefined;
  return normalizeReasoning(parseJson(text, "reasoning_json"));
}

interface MessageFields {
  readonly object: object;
  readonly role: string;
  readonly content: string;
}

function validateMessage(message: unknown): MessageFields {
  if (!isPlainObject(message)) return corrupt("待编码消息结构无效");
  const role = requiredOwnData(message, "role", "待编码消息结构无效");
  const content = requiredOwnData(message, "content", "待编码消息结构无效");
  if (typeof role !== "string" || typeof content !== "string") {
    return corrupt("待编码消息结构无效");
  }
  return { object: message, role, content };
}

function validateRow(row: unknown): MessageRow {
  if (!isPlainObject(row)) return corrupt("消息行字段类型无效");
  const role = requiredOwnData(row, "role", "消息行字段类型无效");
  const content = requiredOwnData(row, "content", "消息行字段类型无效");
  const toolCallId = requiredOwnData(
    row,
    "tool_call_id",
    "消息行字段类型无效",
  );
  const toolCallsJson = requiredOwnData(
    row,
    "tool_calls_json",
    "消息行字段类型无效",
  );
  const reasoningJson = requiredOwnData(
    row,
    "reasoning_json",
    "消息行字段类型无效",
  );
  if (
    typeof role !== "string" ||
    typeof content !== "string" ||
    (typeof toolCallId !== "string" && toolCallId !== null) ||
    (typeof toolCallsJson !== "string" && toolCallsJson !== null) ||
    (typeof reasoningJson !== "string" && reasoningJson !== null)
  ) {
    return corrupt("消息行字段类型无效");
  }
  return {
    role,
    content,
    tool_call_id: toolCallId,
    tool_calls_json: toolCallsJson,
    reasoning_json: reasoningJson,
  };
}

export function encodeMessage(message: PersistedMessage): MessageRow {
  const { object, role, content } = validateMessage(message);

  if (role === "user") {
    return {
      role,
      content,
      tool_call_id: null,
      tool_calls_json: null,
      reasoning_json: null,
    };
  }

  if (role === "tool") {
    const toolCallId = requiredOwnData(object, "toolCallId", "tool_call_id 无效");
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      return corrupt("tool_call_id 无效");
    }
    return {
      role,
      content,
      tool_call_id: toolCallId,
      tool_calls_json: null,
      reasoning_json: null,
    };
  }

  if (role === "assistant") {
    const toolCalls = normalizeToolCalls(
      requiredOwnData(object, "toolCalls", "tool_calls_json 结构无效"),
    );
    const reasoningValue = optionalOwnData(
      object,
      "reasoning",
      "reasoning_json 结构无效",
    );
    const reasoning =
      reasoningValue === ABSENT || reasoningValue === undefined
        ? undefined
        : normalizeReasoning(reasoningValue);
    return {
      role,
      content,
      tool_call_id: null,
      tool_calls_json: stringifyJson(toolCalls, "tool_calls_json"),
      reasoning_json:
        reasoning === undefined
          ? null
          : stringifyJson(reasoning, "reasoning_json"),
    };
  }

  return corrupt("未知消息 role");
}

export function decodeMessageRow(row: unknown): PersistedMessage {
  const normalized = validateRow(row);

  if (normalized.role === "user") {
    if (
      normalized.tool_call_id !== null ||
      normalized.tool_calls_json !== null ||
      normalized.reasoning_json !== null
    ) {
      return corrupt("user 字段无效");
    }
    return { role: "user", content: normalized.content };
  }

  if (normalized.role === "tool") {
    if (
      normalized.tool_call_id === null ||
      normalized.tool_call_id.length === 0 ||
      normalized.tool_calls_json !== null ||
      normalized.reasoning_json !== null
    ) {
      return corrupt("tool 字段无效");
    }
    return {
      role: "tool",
      toolCallId: normalized.tool_call_id,
      content: normalized.content,
    };
  }

  if (normalized.role === "assistant") {
    if (normalized.tool_call_id !== null) {
      return corrupt("assistant tool_call_id 无效");
    }
    const reasoning = parseReasoning(normalized.reasoning_json);
    return {
      role: "assistant",
      content: normalized.content,
      toolCalls: parseToolCalls(normalized.tool_calls_json),
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  return corrupt("未知消息 role");
}
