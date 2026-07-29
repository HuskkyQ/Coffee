import { types as utilTypes } from "node:util";

import type { PlanManager } from "./manager.js";
import type { PlanUpdateAction, TaskPlan, TaskStep, TaskStepDraft } from "./types.js";
import type { RegisteredTool } from "../tool-registry.js";

type PlainRecord = Record<string, unknown>;

const DRAFT_FIELDS = ["id", "title", "successCriteria", "dependsOn"] as const;
const UPDATE_BASE_FIELDS = ["planId", "expectedRevision", "action"] as const;
const UPDATE_FIELDS = [
  ...UPDATE_BASE_FIELDS,
  "stepId",
  "result",
  "reason",
  "steps",
] as const;
const ACTIONS = [
  "start_step",
  "complete_step",
  "fail_step",
  "block_step",
  "resume_step",
  "add_steps",
  "replace_pending_steps",
] as const;

type UpdateActionName = (typeof ACTIONS)[number];

function invalid(operation: string): never {
  throw new Error(`${operation}参数必须是普通 JSON 数据。`);
}

function recordSnapshot(
  value: unknown,
  operation: string,
  allowed: readonly string[],
  required: readonly string[],
): PlainRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    utilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return invalid(operation);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    return invalid(operation);
  }
  if (prototype !== Object.prototype && prototype !== null) return invalid(operation);

  const allowedFields = new Set(allowed);
  const snapshot: PlainRecord = Object.create(null) as PlainRecord;
  for (const key of keys) {
    if (typeof key !== "string" || !allowedFields.has(key)) return invalid(operation);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(operation);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalid(operation);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of required) {
    if (!Object.hasOwn(snapshot, key)) return invalid(operation);
  }
  return snapshot;
}

function denseArraySnapshot(value: unknown, operation: string): readonly unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) return invalid(operation);
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    return invalid(operation);
  }
  if (prototype !== Array.prototype) return invalid(operation);
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, "value") ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0
  ) return invalid(operation);
  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1 || !keys.includes("length")) return invalid(operation);

  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return invalid(operation);
    }
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
      return invalid(operation);
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field}必须是字符串。`);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > 1000) {
    throw new Error(`${field}长度必须在 1 到 1000 之间。`);
  }
  return normalized;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("expectedRevision 必须是正安全整数。");
  }
  return value as number;
}

function draftSteps(value: unknown, operation: string): readonly TaskStepDraft[] {
  return denseArraySnapshot(value, operation).map((item) => {
    const draft = recordSnapshot(item, operation, DRAFT_FIELDS, DRAFT_FIELDS);
    return {
      id: text(draft.id, "步骤 id"),
      title: text(draft.title, "步骤 title"),
      successCriteria: text(draft.successCriteria, "步骤 successCriteria"),
      dependsOn: denseArraySnapshot(draft.dependsOn, operation).map((dependency) =>
        text(dependency, "步骤 dependsOn"),
      ),
    };
  });
}

function exactFields(
  snapshot: PlainRecord,
  operation: string,
  expected: readonly string[],
): void {
  const keys = Object.keys(snapshot);
  if (keys.length !== expected.length) return invalid(operation);
  for (const key of expected) {
    if (!Object.hasOwn(snapshot, key)) return invalid(operation);
  }
}

function updateAction(snapshot: PlainRecord): PlanUpdateAction {
  const action = snapshot.action;
  if (typeof action !== "string" || !ACTIONS.includes(action as UpdateActionName)) {
    throw new Error("action 不支持。");
  }
  const stepAction = (type: "start_step" | "resume_step") => {
    exactFields(snapshot, "更新计划", [...UPDATE_BASE_FIELDS, "stepId"]);
    return { type, stepId: text(snapshot.stepId, "stepId") };
  };
  switch (action) {
    case "start_step":
    case "resume_step":
      return stepAction(action);
    case "complete_step":
    case "fail_step":
      exactFields(snapshot, "更新计划", [...UPDATE_BASE_FIELDS, "stepId", "result"]);
      return {
        type: action,
        stepId: text(snapshot.stepId, "stepId"),
        result: text(snapshot.result, "result"),
      };
    case "block_step":
      exactFields(snapshot, "更新计划", [...UPDATE_BASE_FIELDS, "stepId", "reason"]);
      return {
        type: "block_step",
        stepId: text(snapshot.stepId, "stepId"),
        reason: text(snapshot.reason, "reason"),
      };
    case "add_steps":
    case "replace_pending_steps":
      exactFields(snapshot, "更新计划", [...UPDATE_BASE_FIELDS, "steps"]);
      return { type: action, steps: draftSteps(snapshot.steps, "更新计划") };
  }
  throw new Error("action 不支持。");
}

function planSnapshot(value: unknown): TaskPlan {
  const snapshot = recordSnapshot(
    value,
    "计划返回",
    ["id", "sessionId", "goal", "status", "revision", "steps", "createdAt", "updatedAt"],
    ["id", "sessionId", "goal", "status", "revision", "steps", "createdAt", "updatedAt"],
  );
  const status = snapshot.status;
  if (status !== "active" && status !== "blocked" && status !== "completed" && status !== "cancelled") {
    throw new Error("计划返回无效。");
  }
  const steps = denseArraySnapshot(snapshot.steps, "计划返回").map((value) => stepSnapshot(value));
  return {
    id: text(snapshot.id, "计划返回"),
    sessionId: text(snapshot.sessionId, "计划返回"),
    goal: text(snapshot.goal, "计划返回"),
    status,
    revision: revision(snapshot.revision),
    steps,
    createdAt: text(snapshot.createdAt, "计划返回"),
    updatedAt: text(snapshot.updatedAt, "计划返回"),
  };
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("计划返回无效。");
  }
  return value as number;
}

function stepSnapshot(value: unknown): TaskStep {
  const snapshot = recordSnapshot(
    value,
    "计划返回",
    ["id", "title", "successCriteria", "dependsOn", "status", "retryCount", "result", "blockReason"],
    ["id", "title", "successCriteria", "dependsOn", "status", "retryCount"],
  );
  const status = snapshot.status;
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "blocked" &&
    status !== "completed" &&
    status !== "failed" &&
    status !== "superseded"
  ) {
    throw new Error("计划返回无效。");
  }
  return {
    id: text(snapshot.id, "计划返回"),
    title: text(snapshot.title, "计划返回"),
    successCriteria: text(snapshot.successCriteria, "计划返回"),
    dependsOn: denseArraySnapshot(snapshot.dependsOn, "计划返回").map((value) =>
      text(value, "计划返回"),
    ),
    status,
    retryCount: nonNegativeInteger(snapshot.retryCount),
    ...(Object.hasOwn(snapshot, "result")
      ? { result: text(snapshot.result, "计划返回") }
      : {}),
    ...(Object.hasOwn(snapshot, "blockReason")
      ? { blockReason: text(snapshot.blockReason, "计划返回") }
      : {}),
  };
}

const STEP_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    successCriteria: { type: "string" },
    dependsOn: { type: "array", items: { type: "string" } },
  },
  required: [...DRAFT_FIELDS],
  additionalProperties: false,
};

const STEPS_SCHEMA = { type: "array", items: STEP_SCHEMA };

export function createPlanningTools(manager: PlanManager): readonly RegisteredTool[] {
  return [
    {
      definition: {
        name: "create_plan",
        description: "复杂多步骤任务在写文件或执行 Shell 前先创建计划；简单问答无需调用。计划应包含 2 到 12 个可验证步骤。",
        inputSchema: {
          type: "object",
          properties: { goal: { type: "string", description: "任务总体目标。" }, steps: STEPS_SCHEMA },
          required: ["goal", "steps"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        const input = recordSnapshot(args, "创建计划", ["goal", "steps"], ["goal", "steps"]);
        exactFields(input, "创建计划", ["goal", "steps"]);
        const plan = manager.createPlan({
          goal: text(input.goal, "goal"),
          steps: draftSteps(input.steps, "创建计划"),
        }, signal);
        return { ok: true, plan: planSnapshot(plan) };
      },
    },
    {
      definition: {
        name: "update_plan",
        description: "每个步骤开始前调用 start_step；只有成功证据满足 successCriteria 才 complete_step；失败必须 fail_step、block_step 或重新规划。",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string" },
            expectedRevision: { type: "integer" },
            action: { type: "string", enum: [...ACTIONS] },
            stepId: { type: "string" },
            result: { type: "string" },
            reason: { type: "string" },
            steps: STEPS_SCHEMA,
          },
          required: [...UPDATE_BASE_FIELDS],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        const input = recordSnapshot(args, "更新计划", UPDATE_FIELDS, UPDATE_BASE_FIELDS);
        const action = updateAction(input);
        const plan = manager.updatePlan(
          text(input.planId, "planId"),
          revision(input.expectedRevision),
          action,
          signal,
        );
        return { ok: true, plan: planSnapshot(plan) };
      },
    },
    {
      definition: {
        name: "finish_plan",
        description: "仅在所有步骤都已在本地验证完成后调用，并用 summary 记录完成证据。",
        inputSchema: {
          type: "object",
          properties: {
            planId: { type: "string" },
            expectedRevision: { type: "integer" },
            summary: { type: "string" },
          },
          required: ["planId", "expectedRevision", "summary"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        const input = recordSnapshot(
          args,
          "完成计划",
          ["planId", "expectedRevision", "summary"],
          ["planId", "expectedRevision", "summary"],
        );
        exactFields(input, "完成计划", ["planId", "expectedRevision", "summary"]);
        const summary = text(input.summary, "summary");
        const plan = manager.finishPlan(
          text(input.planId, "planId"),
          revision(input.expectedRevision),
          summary,
          signal,
        );
        return { ok: true, plan: planSnapshot(plan), summary };
      },
    },
  ];
}
