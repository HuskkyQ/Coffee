import stringWidth from "string-width";

import { restoreTaskPlan } from "./state.js";
import { sanitizeTerminalText } from "../terminal-format.js";
import { paintTheme } from "../theme.js";
import type { TerminalStyleContext, ThemeRole } from "../theme.js";
import type { TaskPlan, TaskPlanStatus, TaskStep } from "./types.js";

export type PlanCommand =
  | { type: "show" }
  | { type: "cancel" }
  | { type: "invalid" };

const planStatusLabels: Readonly<Record<TaskPlanStatus, string>> = {
  active: "进行中",
  blocked: "已阻塞",
  completed: "已完成",
  cancelled: "已取消",
};

const CLEAR_LINE = "\r\u001b[2K";
const FRAME_INTERVAL_MS = 140;
const FRAMES = ["◐", "◓", "◑", "◒"] as const;

interface TimerHandle {
  unref?: () => void;
}

export interface PlanProgressRenderer {
  handle(plan: TaskPlan): void;
  pause(): void;
  setStyleContext(styles: TerminalStyleContext): void;
  dispose(): void;
}

interface PlanProgressOptions {
  readonly output: { write(chunk: string): unknown };
  readonly isTTY: boolean | undefined;
  readonly styles: TerminalStyleContext;
  readonly getColumns?: () => number | undefined;
  readonly now?: () => number;
  readonly startTimer?: (
    callback: () => void,
    delay: number,
  ) => TimerHandle;
  readonly stopTimer?: (timer: TimerHandle) => void;
}

function safeDisplay(value: string, fallback: string): string {
  const sanitized = sanitizeTerminalText(
    value
      .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu, "")
      .replace(
        /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/gu,
        "",
      ),
  )
    .replace(/\n/gu, "\\n")
    .replace(/\t/gu, "\\t");
  return sanitized || fallback;
}

function stepMarker(step: TaskStep): string {
  switch (step.status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "◐";
    case "pending":
      return "○";
    case "blocked":
      return "Ⅱ";
    case "failed":
      return "✗";
    case "superseded":
      return "↷";
  }
}

function stepRole(step: TaskStep): ThemeRole {
  switch (step.status) {
    case "completed":
      return "success";
    case "in_progress":
      return "primary";
    case "superseded":
      return "muted";
    case "blocked":
    case "failed":
      return "error";
    case "pending":
      return "muted";
  }
}

function renderStep(
  step: TaskStep,
  position: number,
  styles: TerminalStyleContext,
): string[] {
  const lines = [
    paintTheme(
      `${stepMarker(step)} ${position}. ${safeDisplay(step.title, "未命名步骤")}`,
      stepRole(step),
      styles,
    ),
  ];

  if ((step.status === "completed" || step.status === "failed") && step.result !== undefined) {
    lines.push(
      paintTheme(`   结果：${safeDisplay(step.result, "未提供")}`, "muted", styles),
    );
  }
  if (step.status === "blocked" && step.blockReason !== undefined) {
    lines.push(
      paintTheme(
        `   阻塞原因：${safeDisplay(step.blockReason, "未提供")}`,
        "muted",
        styles,
      ),
    );
  }
  return lines;
}

export function parsePlanCommand(input: string): PlanCommand {
  if (typeof input !== "string") return { type: "invalid" };
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(input)) {
    return { type: "invalid" };
  }
  const trimmed = input.replace(/^ +| +$/gu, "");
  if (trimmed === "/plan") return { type: "show" };
  if (/^\/plan +cancel$/u.test(trimmed)) return { type: "cancel" };
  return { type: "invalid" };
}

export function renderPlan(
  plan: TaskPlan | undefined,
  styles: TerminalStyleContext,
): string {
  if (plan === undefined) return "当前会话还没有任务计划。";

  const snapshot = restoreTaskPlan(plan);
  const resolved = snapshot.steps.filter(
    (step) => step.status === "completed" || step.status === "superseded",
  ).length;
  const header = paintTheme(
    `计划：${safeDisplay(snapshot.goal, "未命名任务")}`,
    "accent",
    styles,
    { bold: true },
  );
  const statusRole: ThemeRole =
    snapshot.status === "completed"
      ? "success"
      : snapshot.status === "blocked"
      ? "error"
      : snapshot.status === "cancelled"
      ? "muted"
      : "primary";
  const status = paintTheme(
    `状态：${planStatusLabels[snapshot.status]} · ${resolved}/${snapshot.steps.length}`,
    statusRole,
    styles,
  );
  const steps = snapshot.steps.flatMap((step, index) =>
    renderStep(step, index + 1, styles),
  );
  return [header, status, "", ...steps].join("\n");
}

function progressLine(
  plan: TaskPlan,
  step: TaskStep,
  position: number,
  frame: string,
  elapsedSeconds: number,
  columns: number | undefined,
): string {
  const resolved = plan.steps.filter(
    (candidate) =>
      candidate.status === "completed" || candidate.status === "superseded",
  ).length;
  const percent = Math.round((resolved / plan.steps.length) * 100);
  const filled = Math.round((resolved / plan.steps.length) * 10);
  const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
  const positionText = `${position}/${plan.steps.length}`;
  const title = safeDisplay(step.title, "未命名步骤");
  const elapsed = `${elapsedSeconds.toFixed(1)}s`;
  const full =
    `${positionText} [${bar}] ${percent}% ${frame} ${title} · ${elapsed}`;
  if (
    columns === undefined ||
    !Number.isFinite(columns) ||
    columns <= 1
  ) {
    return full;
  }
  const width = Math.max(1, Math.floor(columns) - 1);
  if (stringWidth(full) <= width) return full;
  return truncateDisplayWidth(
    `${positionText} ${percent}% ${frame} ${title} · ${elapsed}`,
    width,
  );
}

function truncateDisplayWidth(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  if (width <= 1) return "…".slice(0, width);
  let result = "";
  for (const character of value) {
    if (stringWidth(`${result}${character}…`) > width) break;
    result += character;
  }
  return `${result}…`;
}

function transitionLine(
  step: TaskStep,
  position: number,
  total: number,
  elapsedSeconds: number | undefined,
): string | undefined {
  const title = safeDisplay(step.title, "未命名步骤");
  const elapsed = elapsedSeconds === undefined
    ? ""
    : ` · ${elapsedSeconds.toFixed(1)}s`;
  switch (step.status) {
    case "completed":
      return `✓ ${position}/${total} ${title}${elapsed}`;
    case "superseded":
      return `↷ ${position}/${total} ${title}`;
    case "failed":
      return `✗ ${position}/${total} ${title}${
        step.result === undefined ? "" : ` · ${safeDisplay(step.result, "未提供")}`
      }`;
    case "blocked":
      return `Ⅱ ${position}/${total} ${title}${
        step.blockReason === undefined
          ? ""
          : ` · ${safeDisplay(step.blockReason, "未提供")}`
      }`;
    case "in_progress":
    case "pending":
      return undefined;
  }
}

function transitionRole(step: TaskStep): ThemeRole {
  switch (step.status) {
    case "completed":
      return "success";
    case "failed":
    case "blocked":
      return "error";
    case "superseded":
    case "pending":
      return "muted";
    case "in_progress":
      return "primary";
  }
}

function creationLine(
  plan: TaskPlan,
  columns: number | undefined,
): string {
  const full = `已创建计划：0/${plan.steps.length} · ${
    safeDisplay(plan.goal, "未命名任务")
  }`;
  if (!Number.isFinite(columns) || columns === undefined || columns <= 1) {
    return full;
  }
  return truncateDisplayWidth(full, Math.max(1, Math.floor(columns) - 1));
}

export function createPlanProgressRenderer({
  output,
  isTTY,
  styles,
  getColumns = () => undefined,
  now = Date.now,
  startTimer = (callback, delay) => setInterval(callback, delay),
  stopTimer = (timer) => clearInterval(timer as NodeJS.Timeout),
}: PlanProgressOptions): PlanProgressRenderer {
  const shouldAnimate = isTTY === true;
  let currentStyles = styles;
  const announcedPlanIds = new Set<string>();
  const statuses = new Map<string, TaskStep["status"]>();
  const startedAt = new Map<string, number>();
  let currentPlanId: string | undefined;
  let currentRevision: number | undefined;
  let currentStatus: TaskPlanStatus | undefined;
  let currentDynamicStepId: string | undefined;
  let currentTimer: TimerHandle | undefined;
  let currentFrame = 0;
  let failed = false;
  let disposed = false;

  function stopCurrentTimer(): void {
    const timer = currentTimer;
    currentTimer = undefined;
    if (timer === undefined) return;
    try {
      stopTimer(timer);
    } catch {
      failed = true;
    }
  }

  function fail(): void {
    failed = true;
    stopCurrentTimer();
    currentDynamicStepId = undefined;
  }

  function write(chunk: string): boolean {
    if (failed || disposed) return false;
    try {
      output.write(chunk);
      return true;
    } catch {
      fail();
      return false;
    }
  }

  function clearDynamicLine(): void {
    stopCurrentTimer();
    const hadDynamicLine = currentDynamicStepId !== undefined;
    currentDynamicStepId = undefined;
    if (hadDynamicLine && shouldAnimate) {
      write(CLEAR_LINE);
    }
  }

  function elapsedFor(stepId: string): number | undefined {
    const start = startedAt.get(stepId);
    return start === undefined ? undefined : Math.max(0, now() - start) / 1000;
  }

  function drawCurrent(
    plan: TaskPlan,
    step: TaskStep,
    position: number,
  ): void {
    const start = startedAt.get(step.id) ?? now();
    startedAt.set(step.id, start);
    const text = progressLine(
      plan,
      step,
      position,
      FRAMES[currentFrame]!,
      Math.max(0, now() - start) / 1000,
      getColumns(),
    );
    const styled = paintTheme(text, "primary", currentStyles);
    write(`${CLEAR_LINE}${styled}`);
  }

  function beginDynamic(
    plan: TaskPlan,
    step: TaskStep,
    position: number,
  ): void {
    try {
      currentDynamicStepId = step.id;
      currentFrame = 0;
      drawCurrent(plan, step, position);
      if (failed) return;
      const timer = startTimer(() => {
        try {
          if (
            failed ||
            disposed ||
            currentDynamicStepId !== step.id
          ) {
            return;
          }
          currentFrame = (currentFrame + 1) % FRAMES.length;
          drawCurrent(plan, step, position);
        } catch {
          fail();
        }
      }, FRAME_INTERVAL_MS);
      if (failed || disposed) {
        try {
          stopTimer(timer);
        } catch {
          failed = true;
        }
        return;
      }
      currentTimer = timer;
      timer.unref?.();
    } catch {
      fail();
    }
  }

  function emitLine(line: string, role?: ThemeRole): void {
    write(`${role === undefined ? line : paintTheme(line, role, currentStyles)}\n`);
  }

  return {
    handle(plan) {
      if (failed || disposed) return;
      try {
        const snapshot = restoreTaskPlan(plan);
        if (
          snapshot.id === currentPlanId &&
          snapshot.revision === currentRevision
        ) {
          return;
        }

        if (
          !announcedPlanIds.has(snapshot.id) &&
          snapshot.steps.every((step) => step.status === "pending")
        ) {
          const line = creationLine(
            snapshot,
            shouldAnimate ? getColumns() : undefined,
          );
          emitLine(line, "primary");
          if (failed) return;
          announcedPlanIds.add(snapshot.id);
        }

        clearDynamicLine();
        if (failed) return;
        if (snapshot.id !== currentPlanId) {
          statuses.clear();
          startedAt.clear();
          currentStatus = undefined;
        }

        let currentBecameActive = false;
        const nextCurrent = snapshot.status === "active"
          ? snapshot.steps.find((step) => step.status === "in_progress")
          : undefined;
        for (const [index, step] of snapshot.steps.entries()) {
          const previous = statuses.get(step.id);
          if (previous === step.status) continue;
          if (step.status === "in_progress" && !startedAt.has(step.id)) {
            startedAt.set(step.id, now());
          }
          if (step.status === "in_progress") {
            currentBecameActive = true;
          }
          const line = transitionLine(
            step,
            index + 1,
            snapshot.steps.length,
            elapsedFor(step.id),
          );
          if (line !== undefined) emitLine(line, transitionRole(step));
          statuses.set(step.id, step.status);
          if (failed) return;
        }

        if (
          snapshot.status === "completed" &&
          currentStatus !== "completed"
        ) {
          emitLine("✓ 当前计划已完成。", "success");
        } else if (
          snapshot.status === "cancelled" &&
          currentStatus !== "cancelled"
        ) {
          emitLine("当前计划已取消。", "muted");
        }
        if (failed) return;

        currentPlanId = snapshot.id;
        currentRevision = snapshot.revision;
        currentStatus = snapshot.status;
        if (nextCurrent !== undefined) {
          const position = snapshot.steps.findIndex(
            (step) => step.id === nextCurrent.id,
          ) + 1;
          if (shouldAnimate) {
            beginDynamic(snapshot, nextCurrent, position);
          } else if (currentBecameActive) {
            emitLine(
              `◐ ${position}/${snapshot.steps.length} ${
                safeDisplay(nextCurrent.title, "未命名步骤")
              }`,
              "primary",
            );
          }
        }
      } catch {
        fail();
      }
    },
    pause() {
      if (failed || disposed) return;
      clearDynamicLine();
    },
    setStyleContext(nextStyles) {
      currentStyles = nextStyles;
    },
    dispose() {
      if (disposed) return;
      clearDynamicLine();
      disposed = true;
    },
  };
}
