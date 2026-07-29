import { sanitizeTerminalText } from "./terminal-format.js";
import {
  paintTheme,
  type TerminalStyleContext,
} from "./theme.js";

const CLEAR_LINE = "\r\u001b[2K";
const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const FRAME_INTERVAL_MS = 140;
const FRAMES = ["◐", "◓", "◑", "◒"] as const;

export interface TimerHandle {
  unref?: () => void;
}

export type TimerStart = (
  callback: () => void,
  delay: number,
) => TimerHandle;

export type TimerStop = (timer: TimerHandle) => void;

export interface LineStatusRenderer {
  show(text: string): void;
  clear(): void;
  complete(text: string, role: "success" | "error"): void;
  setStyleContext(styles: TerminalStyleContext): void;
  dispose(): void;
}

interface LineStatusOptions {
  readonly output: { write(chunk: string): unknown };
  readonly isTTY: boolean | undefined;
  readonly styles: TerminalStyleContext;
  readonly now?: () => number;
  readonly startTimer?: TimerStart;
  readonly stopTimer?: TimerStop;
}

function safeStatusText(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/\n/gu, " ")
    .trim();
}

export function createLineStatus({
  output,
  isTTY,
  styles,
  startTimer = (callback, delay) => setInterval(callback, delay),
  stopTimer = (timer) => clearInterval(timer as NodeJS.Timeout),
}: LineStatusOptions): LineStatusRenderer {
  const interactive = isTTY === true;
  let currentStyles = styles;
  let currentText: string | undefined;
  let currentFrame = 0;
  let currentTimer: TimerHandle | undefined;
  let lastPlainLine: string | undefined;
  let cursorHidden = false;
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

  function recoverCursor(): void {
    if (!cursorHidden) return;
    cursorHidden = false;
    try {
      output.write(SHOW_CURSOR);
    } catch {
      // Cursor restoration is best effort after a writer failure.
    }
  }

  function fail(): void {
    if (failed) {
      recoverCursor();
      return;
    }
    failed = true;
    stopCurrentTimer();
    currentText = undefined;
    recoverCursor();
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

  function draw(): void {
    if (currentText === undefined || failed || disposed) return;
    const frame = paintTheme(
      FRAMES[currentFrame]!,
      "primary",
      currentStyles,
    );
    const message = paintTheme(currentText, "muted", currentStyles);
    write(`${CLEAR_LINE}${frame} ${message}`);
  }

  function startAnimation(): void {
    let timer: TimerHandle;
    try {
      timer = startTimer(() => {
        if (failed || disposed || currentText === undefined) return;
        currentFrame = (currentFrame + 1) % FRAMES.length;
        draw();
      }, FRAME_INTERVAL_MS);
    } catch {
      fail();
      return;
    }
    if (failed || disposed || currentText === undefined) {
      try {
        stopTimer(timer);
      } catch {
        failed = true;
      }
      return;
    }
    currentTimer = timer;
    timer.unref?.();
  }

  function writePlain(text: string): void {
    if (text === "" || text === lastPlainLine) return;
    if (write(`${text}\n`)) {
      lastPlainLine = text;
    }
  }

  function clearCurrent(): void {
    const hadVisibleStatus = currentText !== undefined || cursorHidden;
    stopCurrentTimer();
    currentText = undefined;
    if (!interactive || failed || !hadVisibleStatus) return;
    if (!write(CLEAR_LINE)) return;
    recoverCursor();
  }

  return {
    show(text) {
      if (failed || disposed) return;
      const safeText = safeStatusText(text);
      if (!interactive) {
        writePlain(safeText);
        return;
      }
      if (safeText === "") {
        clearCurrent();
        return;
      }

      stopCurrentTimer();
      if (failed) return;
      currentText = safeText;
      currentFrame = 0;
      if (!cursorHidden) {
        if (!write(HIDE_CURSOR)) return;
        cursorHidden = true;
      }
      draw();
      if (!failed) {
        startAnimation();
      }
    },

    clear() {
      if (failed || disposed) return;
      clearCurrent();
    },

    complete(text, role) {
      if (failed || disposed) return;
      const safeText = safeStatusText(text);
      if (!interactive) {
        writePlain(safeText);
        return;
      }
      clearCurrent();
      if (failed || safeText === "") return;
      write(`${paintTheme(safeText, role, currentStyles)}\n`);
    },

    setStyleContext(nextStyles) {
      if (failed || disposed) return;
      currentStyles = nextStyles;
    },

    dispose() {
      if (disposed) return;
      if (!failed) {
        clearCurrent();
      } else {
        recoverCursor();
      }
      disposed = true;
    },
  };
}
