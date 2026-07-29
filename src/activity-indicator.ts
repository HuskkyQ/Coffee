import {
  createLineStatus,
  type TimerStart,
  type TimerStop,
} from "./line-status.js";
import type { TerminalStyleContext } from "./theme.js";

export type ToolActivityPhase = "start" | "success" | "error";

export interface ToolActivityEvent {
  name: string;
  phase: ToolActivityPhase;
}

interface ActivityOptions {
  readonly output: { write(chunk: string): unknown };
  readonly isTTY: boolean | undefined;
  readonly styles: TerminalStyleContext;
  readonly now?: () => number;
  readonly startTimer?: TimerStart;
  readonly stopTimer?: TimerStop;
}

export interface ActivityRenderer {
  handle(event: ToolActivityEvent): void;
  pause(): void;
  setStyleContext(styles: TerminalStyleContext): void;
  dispose(): void;
}

interface ActiveActivity {
  readonly name: string;
  readonly startedAt: number;
}

function getActionText(toolName: string): string {
  if (toolName === "shell") {
    return "正在运行命令…";
  }
  if (toolName === "web_search") {
    return "正在翻找网页…";
  }
  if (toolName === "web_fetch") {
    return "正在细读网页…";
  }
  if (toolName === "calculator") {
    return "正在研磨数字…";
  }
  if (toolName === "get_current_location") {
    return "正在感知你的位置…";
  }
  return "正在处理工具…";
}

function getCompletionText(
  toolName: string,
  succeeded: boolean,
): string {
  if (toolName === "shell") {
    return succeeded ? "命令执行已经完成" : "命令执行暂时失败";
  }
  if (toolName === "web_search") {
    return succeeded ? "网络信息已经带回" : "联网搜索暂时失败";
  }
  if (toolName === "web_fetch") {
    return succeeded ? "网页正文已经读完" : "网页读取暂时失败";
  }
  if (toolName === "calculator") {
    return succeeded ? "计算结果已经出炉" : "这次计算没有成功";
  }
  if (toolName === "get_current_location") {
    return succeeded ? "大致位置已经确认" : "近似定位暂时失败";
  }
  return succeeded ? "工具执行已经完成" : "工具执行暂时失败";
}

export function createActivityRenderer({
  output,
  isTTY,
  styles,
  now = Date.now,
  startTimer,
  stopTimer,
}: ActivityOptions): ActivityRenderer {
  const lineStatus = createLineStatus({
    output,
    isTTY,
    styles,
    startTimer,
    stopTimer,
  });
  let active: ActiveActivity | undefined;
  let paused: ActiveActivity | undefined;
  let disposed = false;

  function discardCurrent(): void {
    active = undefined;
    paused = undefined;
    lineStatus.clear();
  }

  function finishCurrent(succeeded: boolean): void {
    const activity = active ?? paused;
    active = undefined;
    paused = undefined;
    if (activity === undefined) return;

    const seconds = Math.max(0, now() - activity.startedAt) / 1000;
    const marker = succeeded ? "✓" : "✗";
    lineStatus.complete(
      `${marker} ${getCompletionText(activity.name, succeeded)} · ${
        seconds.toFixed(1)
      }s`,
      succeeded ? "success" : "error",
    );
  }

  return {
    handle(event) {
      if (disposed) return;
      if (event.phase === "start") {
        discardCurrent();
        const activity = {
          name: event.name,
          startedAt: now(),
        } satisfies ActiveActivity;
        active = activity;
        lineStatus.show(getActionText(event.name));
        return;
      }
      finishCurrent(event.phase === "success");
    },

    pause() {
      if (disposed || active === undefined) return;
      paused = active;
      active = undefined;
      lineStatus.clear();
    },

    setStyleContext(nextStyles) {
      if (disposed) return;
      lineStatus.setStyleContext(nextStyles);
    },

    dispose() {
      if (disposed) return;
      active = undefined;
      paused = undefined;
      lineStatus.dispose();
      disposed = true;
    },
  };
}
