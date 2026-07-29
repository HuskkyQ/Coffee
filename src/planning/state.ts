import { types as utilTypes } from "node:util";

import type {
  CreateTaskPlanInput,
  PlanUpdateAction,
  TaskPlan,
  TaskPlanStatus,
  TaskStep,
  TaskStepDraft,
  TaskStepStatus,
} from "./types.js";

const STEP_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const MAX_RETRIES = 3;
const MAX_STEPS = 12;

const planStatuses = new Set<TaskPlanStatus>([
  "active",
  "blocked",
  "completed",
  "cancelled",
]);
const stepStatuses = new Set<TaskStepStatus>([
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "superseded",
]);
const terminalPlanStatuses = new Set<TaskPlanStatus>([
  "completed",
  "cancelled",
]);
const resolvedDependencyStatuses = new Set<TaskStepStatus>([
  "completed",
  "superseded",
]);
const unresolvedStatuses = new Set<TaskStepStatus>([
  "pending",
  "in_progress",
  "blocked",
  "failed",
]);
const dependencyConstrainedStatuses = new Set<TaskStepStatus>([
  "in_progress",
  "blocked",
  "completed",
  "failed",
]);

type PlainRecord = Record<string, unknown>;

function codePoints(value: string): number {
  return Array.from(value).length;
}

function boundedText(
  value: unknown,
  field: string,
  min: number,
  max: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field}必须是字符串。`);
  }
  const normalized = value.trim();
  const length = codePoints(normalized);
  if (length < min || length > max) {
    throw new Error(`${field}长度必须在 ${min} 到 ${max} 之间。`);
  }
  return normalized;
}

function safeText(value: unknown, field: string): string {
  return boundedText(value, field, 1, 1000);
}

function rejectProxy(value: unknown, field: string): void {
  let isProxy: boolean;
  try {
    isProxy = utilTypes.isProxy(value);
  } catch {
    throw new Error(`${field}无法安全读取，必须是普通 JSON 数据。`);
  }
  if (isProxy) {
    throw new Error(`${field}必须是普通 JSON 数据，不能是 Proxy 代理对象。`);
  }
}

function readPlainRecord(value: unknown, field: string): PlainRecord {
  rejectProxy(value, field);
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new Error(`${field}无法安全读取，必须是普通 JSON 对象。`);
  }
  if (typeof value !== "object" || value === null || isArray) {
    throw new Error(`${field}必须是普通 JSON 对象。`);
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new Error(`${field}无法安全读取，必须是普通 JSON 对象。`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${field}原型无效，必须是普通 JSON 对象。`);
  }

  const snapshot: PlainRecord = Object.create(null) as PlainRecord;
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new Error(`${field}包含额外字段。`);
    }
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error(`${field}无法安全读取，必须是普通 JSON 对象。`);
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${field}无法安全读取，必须使用数据属性。`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function exactFields(
  value: PlainRecord,
  required: readonly string[],
  optional: readonly string[] = [],
  field = "对象",
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field}包含额外字段。`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${field}缺少 ${key}。`);
    }
  }
}

function readDenseArray(value: unknown, field: string): unknown[] {
  rejectProxy(value, field);
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new Error(`${field}无法安全读取，必须是普通密集数组。`);
  }
  if (!isArray) {
    throw new Error(`${field}必须是普通密集数组。`);
  }
  const array = value as unknown[];

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(array);
    keys = Reflect.ownKeys(array);
    lengthDescriptor = Object.getOwnPropertyDescriptor(array, "length");
  } catch {
    throw new Error(`${field}无法安全读取，必须是普通密集数组。`);
  }
  if (prototype !== Array.prototype) {
    throw new Error(`${field}原型无效，必须是普通密集数组。`);
  }
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error(`${field}必须是普通密集数组。`);
  }

  const length = lengthDescriptor.value as number;
  if (keys.length !== length + 1) {
    throw new Error(`${field}必须是普通密集数组，且不能包含额外字段。`);
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(array, key);
    } catch {
      throw new Error(`${field}无法安全读取，必须是普通密集数组。`);
    }
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`${field}必须是普通密集数组。`);
    }
    result.push(descriptor.value);
  }
  for (const key of keys) {
    if (
      key !== "length" &&
      (typeof key !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
        Number(key) >= length)
    ) {
      throw new Error(`${field}必须是普通密集数组，且不能包含额外字段。`);
    }
  }
  return result;
}

function parseStepId(value: unknown, field = "stepId"): string {
  if (typeof value !== "string" || !STEP_ID.test(value)) {
    throw new Error(`${field}格式无效。`);
  }
  return value;
}

function parseDraft(value: unknown, field: string): TaskStepDraft {
  const record = readPlainRecord(value, field);
  exactFields(
    record,
    ["id", "title", "successCriteria", "dependsOn"],
    [],
    field,
  );
  const dependsOn = readDenseArray(
    record.dependsOn,
    `${field}.dependsOn`,
  ).map((dependency) => {
    if (typeof dependency !== "string") {
      throw new Error("步骤依赖 ID 必须是字符串。");
    }
    return dependency;
  });
  if (dependsOn.length > MAX_STEPS) {
    throw new Error("步骤依赖不能超过 12 个。");
  }
  if (new Set(dependsOn).size !== dependsOn.length) {
    throw new Error("步骤依赖不能重复。");
  }
  return {
    id: parseStepId(record.id, "步骤 ID"),
    title: boundedText(record.title, "title", 1, 120),
    successCriteria: boundedText(
      record.successCriteria,
      "successCriteria",
      1,
      300,
    ),
    dependsOn,
  };
}

function parseDrafts(value: unknown, field = "steps"): TaskStepDraft[] {
  return readDenseArray(value, field).map((draft, index) =>
    parseDraft(draft, `${field}[${index}]`),
  );
}

function parseSafeInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${field}必须是 ${min} 到 ${max} 的安全整数。`);
  }
  return value;
}

function parsePlanStatus(value: unknown): TaskPlanStatus {
  if (typeof value !== "string" || !planStatuses.has(value as TaskPlanStatus)) {
    throw new Error("计划状态无效。");
  }
  return value as TaskPlanStatus;
}

function parseStepStatus(value: unknown): TaskStepStatus {
  if (typeof value !== "string" || !stepStatuses.has(value as TaskStepStatus)) {
    throw new Error("步骤状态无效。");
  }
  return value as TaskStepStatus;
}

function parseRestoredStep(value: unknown, index: number): TaskStep {
  const field = `steps[${index}]`;
  const record = readPlainRecord(value, field);
  exactFields(
    record,
    [
      "id",
      "title",
      "successCriteria",
      "dependsOn",
      "status",
      "retryCount",
    ],
    ["result", "blockReason"],
    field,
  );
  const draft = parseDraft(
    {
      id: record.id,
      title: record.title,
      successCriteria: record.successCriteria,
      dependsOn: record.dependsOn,
    },
    field,
  );
  const status = parseStepStatus(record.status);
  const retryCount = parseSafeInteger(
    record.retryCount,
    "retryCount",
    0,
    MAX_RETRIES,
  );
  const result = Object.hasOwn(record, "result")
    ? boundedText(record.result, "result", 1, 1000)
    : undefined;
  const blockReason = Object.hasOwn(record, "blockReason")
    ? boundedText(record.blockReason, "blockReason", 1, 1000)
    : undefined;

  if ((status === "completed" || status === "failed") && result === undefined) {
    throw new Error("completed 或 failed 步骤必须包含 result。");
  }
  if (status === "pending" && result !== undefined) {
    throw new Error("pending 步骤不能包含 result。");
  }
  if (status === "blocked" && blockReason === undefined) {
    throw new Error("blocked 步骤必须包含 blockReason。");
  }
  if (status !== "blocked" && blockReason !== undefined) {
    throw new Error("非 blocked 步骤不能包含 blockReason。");
  }

  return {
    ...draft,
    status,
    retryCount,
    ...(result === undefined ? {} : { result }),
    ...(blockReason === undefined ? {} : { blockReason }),
  };
}

function validateGraph(steps: readonly TaskStepDraft[]): void {
  if (steps.length < 2 || steps.length > MAX_STEPS) {
    throw new Error("计划必须包含 2 到 12 个步骤。");
  }
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) {
    throw new Error("步骤 ID 不能重复。");
  }
  for (const step of steps) {
    if (!STEP_ID.test(step.id)) {
      throw new Error("步骤 ID 格式无效。");
    }
    if (step.dependsOn.length > MAX_STEPS) {
      throw new Error("步骤依赖不能超过 12 个。");
    }
    const dependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (dependencies.has(dependency)) {
        throw new Error("步骤依赖不能重复。");
      }
      dependencies.add(dependency);
      if (!ids.has(dependency)) {
        throw new Error("步骤包含未知依赖。");
      }
      if (dependency === step.id) {
        throw new Error("步骤不能依赖自身。");
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  function visit(id: string): void {
    if (visiting.has(id)) {
      throw new Error("步骤依赖存在循环。");
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependsOn) {
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) {
    visit(id);
  }
}

function validatePlanState(plan: TaskPlan): void {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  for (const step of plan.steps) {
    if (!dependencyConstrainedStatuses.has(step.status)) continue;
    if (
      step.dependsOn.some(
        (dependency) =>
          !resolvedDependencyStatuses.has(byId.get(dependency)!.status),
      )
    ) {
      throw new Error("已启动或已结束步骤的依赖尚未解决。");
    }
  }

  const inProgress = plan.steps.filter(
    (step) => step.status === "in_progress",
  ).length;
  const blocked = plan.steps.filter((step) => step.status === "blocked").length;
  if (inProgress > 1) {
    throw new Error("计划最多只能有一个 in_progress 步骤。");
  }

  if (plan.status === "active" && blocked !== 0) {
    throw new Error("active 计划不能包含 blocked 步骤。");
  }
  if (plan.status === "blocked" && (blocked !== 1 || inProgress !== 0)) {
    throw new Error("blocked 计划必须有且只能有一个 blocked 步骤。");
  }
  if (plan.status === "completed") {
    if (plan.steps.some((step) => unresolvedStatuses.has(step.status))) {
      throw new Error("completed 计划不能包含尚未解决的步骤。");
    }
    if (!plan.steps.some((step) => step.status === "completed")) {
      throw new Error("completed 计划必须至少有一个 completed 步骤。");
    }
  }
  if (
    plan.status === "cancelled" &&
    plan.steps.some(
      (step) => step.status === "in_progress" || step.status === "blocked",
    )
  ) {
    throw new Error("cancelled 计划不能包含 in_progress 或 blocked 步骤。");
  }
}

function cloneStep(step: TaskStep): TaskStep {
  return {
    id: step.id,
    title: step.title,
    successCriteria: step.successCriteria,
    dependsOn: [...step.dependsOn],
    status: step.status,
    retryCount: step.retryCount,
    ...(step.result === undefined ? {} : { result: step.result }),
    ...(step.blockReason === undefined
      ? {}
      : { blockReason: step.blockReason }),
  };
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      freeze(descriptor.value);
    }
  }
  return Object.freeze(value);
}

function frozenPlan(plan: TaskPlan): TaskPlan {
  const detached: TaskPlan = {
    id: plan.id,
    sessionId: plan.sessionId,
    goal: plan.goal,
    status: plan.status,
    revision: plan.revision,
    steps: plan.steps.map(cloneStep),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
  return freeze(detached);
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("计划 revision 无法继续增加。");
  }
  return revision + 1;
}

function commit(
  plan: TaskPlan,
  status: TaskPlanStatus,
  steps: readonly TaskStep[],
  now: string,
): TaskPlan {
  const next: TaskPlan = {
    ...plan,
    status,
    revision: nextRevision(plan.revision),
    steps,
    updatedAt: safeText(now, "now"),
  };
  validateGraph(next.steps);
  validatePlanState(next);
  return frozenPlan(next);
}

function stepAt(plan: TaskPlan, stepId: string): number {
  const index = plan.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    throw new Error("未找到指定步骤。");
  }
  return index;
}

function updateStep(
  steps: readonly TaskStep[],
  index: number,
  replacement: TaskStep,
): TaskStep[] {
  return steps.map((step, current) =>
    current === index ? replacement : cloneStep(step),
  );
}

function parseAction(value: unknown): PlanUpdateAction {
  const record = readPlainRecord(value, "action");
  if (!Object.hasOwn(record, "type") || typeof record.type !== "string") {
    throw new Error("action 缺少有效 type。");
  }
  switch (record.type) {
    case "start_step":
    case "resume_step":
      exactFields(record, ["type", "stepId"], [], "action");
      return {
        type: record.type,
        stepId: parseStepId(record.stepId),
      };
    case "complete_step":
    case "fail_step":
      exactFields(record, ["type", "stepId", "result"], [], "action");
      return {
        type: record.type,
        stepId: parseStepId(record.stepId),
        result: boundedText(record.result, "result", 1, 1000),
      };
    case "block_step":
      exactFields(record, ["type", "stepId", "reason"], [], "action");
      return {
        type: "block_step",
        stepId: parseStepId(record.stepId),
        reason: boundedText(record.reason, "reason", 1, 1000),
      };
    case "add_steps": {
      exactFields(record, ["type", "steps"], [], "action");
      const steps = parseDrafts(record.steps, "action.steps");
      if (steps.length < 1) {
        throw new Error("add_steps 至少需要 1 个步骤。");
      }
      return { type: "add_steps", steps };
    }
    case "replace_pending_steps": {
      exactFields(record, ["type", "steps"], [], "action");
      const steps = parseDrafts(record.steps, "action.steps");
      if (steps.length < 2) {
        throw new Error("replace_pending_steps 至少需要 2 个步骤。");
      }
      return { type: "replace_pending_steps", steps };
    }
    default:
      throw new Error("action type 无效。");
  }
}

export function createTaskPlan(input: CreateTaskPlanInput): TaskPlan {
  const record = readPlainRecord(input, "创建计划参数");
  exactFields(
    record,
    ["id", "sessionId", "goal", "steps", "now"],
    [],
    "创建计划参数",
  );
  const drafts = parseDrafts(record.steps);
  validateGraph(drafts);
  const timestamp = safeText(record.now, "now");
  return frozenPlan({
    id: safeText(record.id, "id"),
    sessionId: safeText(record.sessionId, "sessionId"),
    goal: boundedText(record.goal, "goal", 1, 1000),
    status: "active",
    revision: 1,
    steps: drafts.map((draft) => ({
      ...draft,
      dependsOn: [...draft.dependsOn],
      status: "pending",
      retryCount: 0,
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function restoreTaskPlan(input: unknown): TaskPlan {
  const record = readPlainRecord(input, "计划");
  exactFields(
    record,
    [
      "id",
      "sessionId",
      "goal",
      "status",
      "revision",
      "steps",
      "createdAt",
      "updatedAt",
    ],
    [],
    "计划",
  );
  const rawSteps = readDenseArray(record.steps, "steps");
  const restored: TaskPlan = {
    id: safeText(record.id, "id"),
    sessionId: safeText(record.sessionId, "sessionId"),
    goal: boundedText(record.goal, "goal", 1, 1000),
    status: parsePlanStatus(record.status),
    revision: parseSafeInteger(
      record.revision,
      "revision",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    steps: rawSteps.map(parseRestoredStep),
    createdAt: safeText(record.createdAt, "createdAt"),
    updatedAt: safeText(record.updatedAt, "updatedAt"),
  };
  validateGraph(restored.steps);
  validatePlanState(restored);
  return frozenPlan(restored);
}

export function applyPlanAction(
  plan: TaskPlan,
  action: PlanUpdateAction,
  now: string,
): TaskPlan {
  const current = restoreTaskPlan(plan);
  const parsed = parseAction(action);
  if (terminalPlanStatuses.has(current.status)) {
    throw new Error("计划已进入终态，不能继续更新。");
  }
  if (
    current.status === "blocked" &&
    parsed.type !== "resume_step" &&
    parsed.type !== "replace_pending_steps"
  ) {
    throw new Error("计划处于 blocked 状态，只能恢复或重规划。");
  }

  switch (parsed.type) {
    case "start_step": {
      if (current.status !== "active") {
        throw new Error("只有 active 计划可以开始步骤。");
      }
      if (current.steps.some((step) => step.status === "in_progress")) {
        throw new Error("计划已有正在进行的步骤。");
      }
      const index = stepAt(current, parsed.stepId);
      const step = current.steps[index]!;
      if (step.status !== "pending" && step.status !== "failed") {
        throw new Error("步骤当前状态不能开始。");
      }
      if (
        step.dependsOn.some((dependency) => {
          const dependencyStep = current.steps.find(
            (candidate) => candidate.id === dependency,
          )!;
          return !resolvedDependencyStatuses.has(dependencyStep.status);
        })
      ) {
        throw new Error("步骤依赖尚未解决。");
      }
      if (step.status === "failed" && step.retryCount >= MAX_RETRIES) {
        throw new Error("步骤重试次数已达到上限。");
      }
      return commit(
        current,
        "active",
        updateStep(current.steps, index, {
          ...cloneStep(step),
          status: "in_progress",
          retryCount:
            step.status === "failed" ? step.retryCount + 1 : step.retryCount,
        }),
        now,
      );
    }
    case "complete_step":
    case "fail_step": {
      if (current.status !== "active") {
        throw new Error("只有 active 计划可以结束进行中的步骤。");
      }
      const index = stepAt(current, parsed.stepId);
      const step = current.steps[index]!;
      if (step.status !== "in_progress") {
        throw new Error("只有 in_progress 进行中步骤可以结束。");
      }
      return commit(
        current,
        "active",
        updateStep(current.steps, index, {
          ...cloneStep(step),
          status: parsed.type === "complete_step" ? "completed" : "failed",
          result: parsed.result,
        }),
        now,
      );
    }
    case "block_step": {
      if (current.status !== "active") {
        throw new Error("只有 active 计划可以阻塞步骤。");
      }
      const index = stepAt(current, parsed.stepId);
      const step = current.steps[index]!;
      if (step.status !== "in_progress") {
        throw new Error("只有 in_progress 进行中步骤可以阻塞。");
      }
      return commit(
        current,
        "blocked",
        updateStep(current.steps, index, {
          ...cloneStep(step),
          status: "blocked",
          blockReason: parsed.reason,
        }),
        now,
      );
    }
    case "resume_step": {
      if (current.status !== "blocked") {
        throw new Error("只有 blocked 计划可以恢复步骤。");
      }
      const index = stepAt(current, parsed.stepId);
      const step = current.steps[index]!;
      if (step.status !== "blocked") {
        throw new Error("只有 blocked 步骤可以恢复。");
      }
      const resumed = cloneStep(step);
      delete (resumed as { blockReason?: string }).blockReason;
      return commit(
        current,
        "active",
        updateStep(current.steps, index, {
          ...resumed,
          status: "in_progress",
        }),
        now,
      );
    }
    case "add_steps": {
      if (current.status !== "active") {
        throw new Error("只有 active 计划可以增加步骤。");
      }
      const added: TaskStep[] = parsed.steps.map((draft) => ({
        ...draft,
        dependsOn: [...draft.dependsOn],
        status: "pending",
        retryCount: 0,
      }));
      return commit(
        current,
        "active",
        [...current.steps.map(cloneStep), ...added],
        now,
      );
    }
    case "replace_pending_steps": {
      const replaced = current.steps.map((step): TaskStep => {
        if (step.status !== "pending" && step.status !== "failed") {
          return cloneStep(step);
        }
        return {
          ...cloneStep(step),
          status: "superseded",
        };
      });
      const added: TaskStep[] = parsed.steps.map((draft) => ({
        ...draft,
        dependsOn: [...draft.dependsOn],
        status: "pending",
        retryCount: 0,
      }));
      return commit(
        current,
        current.status,
        [...replaced, ...added],
        now,
      );
    }
  }
}

export function finishTaskPlan(
  plan: TaskPlan,
  summary: string,
  now: string,
): TaskPlan {
  const current = restoreTaskPlan(plan);
  boundedText(summary, "summary", 1, 1000);
  if (current.status !== "active") {
    throw new Error("只有 active 计划可以完成。");
  }
  if (current.steps.some((step) => unresolvedStatuses.has(step.status))) {
    throw new Error("计划仍有尚未解决的步骤。");
  }
  if (!current.steps.some((step) => step.status === "completed")) {
    throw new Error("计划必须至少有一个 completed 步骤。");
  }
  return commit(current, "completed", current.steps, now);
}
