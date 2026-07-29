import stringWidth from "string-width";

import { renderMarkdown } from "./terminal-format.js";
import type { TerminalStyleContext } from "./theme.js";

const ANSI = {
  hideCursor: "\u001b[?25l",
  showCursor: "\u001b[?25h",
  clearLine: "\u001b[2K",
} as const;

const FLUSH_DELAY_MS = 40;
const SAFE_TAB = "    ";

type PlainSanitizerState =
  | "text"
  | "cr"
  | "escape"
  | "csi"
  | "osc"
  | "osc_escape"
  | "control_string"
  | "control_string_escape";

function createPlainTerminalSanitizer(): {
  push(input: string): string;
  finish(): string;
  reset(): void;
} {
  let state: PlainSanitizerState = "text";
  let pendingHighSurrogate = "";

  function push(input: string): string {
    let output = "";
    let source = `${pendingHighSurrogate}${input}`;
    pendingHighSurrogate = "";
    const finalCodeUnit = source.charCodeAt(source.length - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
      pendingHighSurrogate = source.slice(-1);
      source = source.slice(0, -1);
    }

    for (const character of source) {
      let current: string | undefined = character;
      while (current !== undefined) {
        if (state === "cr") {
          state = "text";
          output += "\n";
          if (current === "\n") {
            current = undefined;
            continue;
          }
        }

        const code = current.codePointAt(0) ?? 0;

        if (state === "csi") {
          if (current === "\u001b") {
            state = "escape";
          } else if (code >= 0x40 && code <= 0x7e) {
            state = "text";
          }
          current = undefined;
          continue;
        }

        if (state === "osc" || state === "control_string") {
          if (current === "\u001b") {
            state = state === "osc" ? "osc_escape" : "control_string_escape";
          } else if (
            code === 0x9c ||
            (state === "osc" && code === 0x07)
          ) {
            state = "text";
          }
          current = undefined;
          continue;
        }

        if (state === "osc_escape" || state === "control_string_escape") {
          if (current === "\\" || code === 0x9c) {
            state = "text";
          } else if (current !== "\u001b") {
            if (state === "osc_escape" && code === 0x07) {
              state = "text";
            } else {
              state = state === "osc_escape" ? "osc" : "control_string";
            }
          }
          current = undefined;
          continue;
        }

        if (state === "escape") {
          if (current === "[") {
            state = "csi";
          } else if (current === "]") {
            state = "osc";
          } else if (current === "P" || current === "X" || current === "^" || current === "_") {
            state = "control_string";
          } else if (current === "\u001b" || (code >= 0x20 && code <= 0x2f)) {
            // Keep waiting for the final byte of this escape sequence.
          } else {
            state = "text";
          }
          current = undefined;
          continue;
        }

        if (current === "\r") {
          state = "cr";
        } else if (current === "\n") {
          output += current;
        } else if (current === "\t") {
          output += SAFE_TAB;
        } else if (current === "\u001b") {
          state = "escape";
        } else if (code === 0x9b) {
          state = "csi";
        } else if (code === 0x9d) {
          state = "osc";
        } else if (
          code === 0x90 ||
          code === 0x98 ||
          code === 0x9e ||
          code === 0x9f
        ) {
          state = "control_string";
        } else if (
          code <= 0x1f ||
          (code >= 0x7f && code <= 0x9f)
        ) {
          // Drop terminal controls that are not safe printable content.
        } else if (
          character.length === 1 &&
          code >= 0xd800 &&
          code <= 0xdfff
        ) {
          output += "\ufffd";
        } else {
          output += current;
        }
        current = undefined;
      }
    }

    return output;
  }

  return {
    push,
    finish() {
      const output = `${state === "cr" ? "\n" : ""}${
        pendingHighSurrogate.length > 0 ? "\ufffd" : ""
      }`;
      state = "text";
      pendingHighSurrogate = "";
      return output;
    },
    reset() {
      state = "text";
      pendingHighSurrogate = "";
    },
  };
}

export interface TimerHandle {
  unref?: () => void;
}

export interface StreamingMarkdownRendererOptions {
  output: { write(chunk: string): unknown; columns?: number };
  isTTY: boolean | undefined;
  styles: TerminalStyleContext;
  term: string | undefined;
  prefix: string;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}

export interface StreamingMarkdownRenderer {
  showStatus(text: string): void;
  append(delta: string): void;
  finishSegment(finalContent?: string): void;
  dispose(options?: { preserve?: boolean }): void;
}

interface PendingFlush {
  active: boolean;
  handle?: TimerHandle;
}

type RendererAction = () => void;

export function createStreamingMarkdownRenderer({
  output,
  isTTY,
  styles,
  term,
  prefix,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer as NodeJS.Timeout),
}: StreamingMarkdownRendererOptions): StreamingMarkdownRenderer {
  const canPreview = isTTY === true && term !== "dumb";
  const continuation = " ".repeat(stringWidth(prefix));

  let currentLine = "";
  let segmentSource = "";
  let lineIndex = 0;
  let segmentStarted = false;
  let previewVisible = false;
  let previewSource: string | undefined;
  let previewWidth: number | undefined;
  let safeSegment = !canPreview || liveColumns() === undefined;
  let safePrefixWritten = false;
  let statusVisible = false;
  let dirty = false;
  let disposed = false;
  let cursorHidden = false;
  let pendingFlush: PendingFlush | undefined;
  let statusVersion = 0;
  const actionQueue: RendererAction[] = [];
  const postOutputActions: RendererAction[] = [];
  const pendingOutput: string[] = [];
  let dispatching = false;
  let disposeMode: "preserve" | "discard" | undefined;
  let disposeOutputLineOpen = false;
  let renderer: StreamingMarkdownRenderer;
  const sanitizer = createPlainTerminalSanitizer();

  function enqueueOutput(chunk: string): void {
    pendingOutput.push(chunk);
  }

  function drainOutput(): void {
    while (pendingOutput.length > 0) {
      const chunk = pendingOutput[0];
      if (chunk === undefined) {
        return;
      }
      output.write(chunk);
      pendingOutput.shift();
    }
  }

  function dispatch(action: RendererAction): void {
    actionQueue.push(action);
    if (dispatching) {
      return;
    }
    dispatching = true;
    try {
      while (true) {
        drainOutput();
        if (postOutputActions.length > 0) {
          actionQueue.push(...postOutputActions.splice(0));
        }
        const nextAction = actionQueue.shift();
        if (nextAction !== undefined) {
          if (disposeMode === "preserve" && disposeOutputLineOpen) {
            actionQueue.unshift(nextAction);
            hideCursor();
            enqueueOutput("\n");
            disposeOutputLineOpen = false;
            continue;
          }
          nextAction();
          continue;
        }
        if (settleDisposal()) {
          continue;
        }
        break;
      }
    } finally {
      dispatching = false;
    }
  }

  function writePlain(chunk: string): void {
    enqueueOutput(chunk);
  }

  function hideCursor(): void {
    if (!cursorHidden) {
      cursorHidden = true;
      enqueueOutput(ANSI.hideCursor);
    }
  }

  function showCursor(): void {
    if (cursorHidden) {
      cursorHidden = false;
      enqueueOutput(ANSI.showCursor);
    }
  }

  function liveColumns(): number | undefined {
    const value = output.columns;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return undefined;
    }
    const rounded = Math.floor(value);
    return rounded >= 1 ? rounded : undefined;
  }

  function linePrefix(): string {
    if (lineIndex === 0) {
      return prefix;
    }
    return currentLine.length === 0 ? "" : continuation;
  }

  function renderedCurrentLine(): string {
    return `${linePrefix()}${renderMarkdown(currentLine, styles)}`;
  }

  function sanitizedStatus(text: string): string {
    const statusSanitizer = createPlainTerminalSanitizer();
    return `${statusSanitizer.push(text)}${statusSanitizer.finish()}`.replace(
      /\n/g,
      " ",
    );
  }

  function fitStatusToLine(text: string, columns: number): string {
    const available = Math.max(0, columns - stringWidth(prefix) - 1);
    let fitted = "";
    let width = 0;
    for (const character of text) {
      const characterWidth = stringWidth(character);
      if (width + characterWidth > available) {
        break;
      }
      fitted += character;
      width += characterWidth;
    }
    return fitted;
  }

  function statusPreviewIsUnsafe(columns: number | undefined): boolean {
    return (
      previewVisible &&
      statusVisible &&
      previewWidth !== undefined &&
      (columns === undefined || previewWidth >= columns)
    );
  }

  function commitStatusPreview(): void {
    previewVisible = false;
    previewSource = undefined;
    previewWidth = undefined;
    statusVisible = false;
    enqueueOutput("\n");
  }

  function clearPreview(): void {
    if (!previewVisible) {
      return;
    }
    previewVisible = false;
    previewSource = undefined;
    previewWidth = undefined;
    statusVisible = false;
    enqueueOutput(`\r${ANSI.clearLine}`);
  }

  function enterSafeSegment(): void {
    if (safeSegment) {
      return;
    }
    const displayedSource =
      previewVisible && !statusVisible ? previewSource : undefined;
    if (displayedSource === undefined) {
      clearPreview();
    }
    cancelPending();
    const frame =
      displayedSource === undefined
        ? `${linePrefix()}${currentLine}`
        : currentLine.slice(displayedSource.length);
    previewVisible = false;
    previewSource = undefined;
    previewWidth = undefined;
    statusVisible = false;
    safeSegment = true;
    safePrefixWritten = true;
    segmentStarted = true;
    dirty = false;
    enqueueOutput(frame);
    showCursor();
  }

  function flushPreview(): void {
    if (!dirty || currentLine.length === 0 || safeSegment) {
      return;
    }
    const columns = liveColumns();
    if (statusPreviewIsUnsafe(columns)) {
      commitStatusPreview();
    }
    const frame = renderedCurrentLine();
    const frameWidth = stringWidth(frame);
    if (
      columns === undefined ||
      (previewVisible &&
        previewWidth !== undefined &&
        previewWidth >= columns) ||
      frameWidth >= columns
    ) {
      enterSafeSegment();
      return;
    }
    const source = currentLine;
    dirty = false;
    clearPreview();
    hideCursor();
    previewVisible = true;
    previewSource = source;
    previewWidth = frameWidth;
    statusVisible = false;
    segmentStarted = true;
    enqueueOutput(frame);
  }

  function flushWithCursorRecovery(): void {
    flushPreview();
  }

  function cancelPending(): void {
    const pending = pendingFlush;
    if (!pending) {
      return;
    }
    pending.active = false;
    pendingFlush = undefined;
    if (pending.handle) {
      cancel(pending.handle);
    }
  }

  function scheduleFlush(): void {
    if (pendingFlush) {
      return;
    }
    const pending: PendingFlush = { active: true };
    pendingFlush = pending;
    pending.handle = schedule(() => {
      if (!pending.active || disposed) {
        return;
      }
      pending.active = false;
      if (pendingFlush === pending) {
        pendingFlush = undefined;
      }
      try {
        dispatch(flushWithCursorRecovery);
      } catch {
        dirty = currentLine.length > 0;
        try {
          dispatch(showCursor);
        } catch {
          // Leave rejected output at the queue head for the next public action.
        }
      }
    }, FLUSH_DELAY_MS);
    pending.handle.unref?.();
  }

  function commitLine(): void {
    cancelPending();
    const wasSafe = safeSegment;
    const hadPreview = previewVisible;
    const canCommitPreview =
      !wasSafe &&
      hadPreview &&
      !statusVisible &&
      previewSource === currentLine;
    const frame =
      wasSafe || canCommitPreview ? undefined : renderedCurrentLine();

    currentLine = "";
    lineIndex += 1;
    segmentStarted = true;
    dirty = false;
    previewVisible = false;
    previewSource = undefined;
    previewWidth = undefined;
    statusVisible = false;

    if (wasSafe) {
      writePlain("\n");
      return;
    }
    if (canCommitPreview) {
      enqueueOutput("\n");
      return;
    }
    if (hadPreview) {
      enqueueOutput(`\r${ANSI.clearLine}`);
    }
    enqueueOutput(`${frame ?? ""}\n`);
  }

  function acceptVisibleText(text: string): void {
    for (const character of text) {
      if (character === "\n") {
        commitLine();
        continue;
      }
      currentLine += character;
      segmentStarted = true;
      dirty = true;
      if (safeSegment) {
        const firstCharacter = !safePrefixWritten;
        safePrefixWritten = true;
        segmentStarted = true;
        dirty = false;
        writePlain(`${firstCharacter ? prefix : ""}${character}`);
      }
    }
    if (dirty) {
      scheduleFlush();
    }
  }

  function sanitizeCompleteText(text: string): string {
    const completeSanitizer = createPlainTerminalSanitizer();
    return `${completeSanitizer.push(text)}${completeSanitizer.finish()}`;
  }

  function acceptSanitizerTail(): void {
    const tail = sanitizer.finish();
    if (tail.length === 0) {
      return;
    }
    segmentSource += tail;
    acceptVisibleText(tail);
  }

  function resetSegment(): void {
    currentLine = "";
    segmentSource = "";
    lineIndex = 0;
    segmentStarted = false;
    previewVisible = false;
    previewSource = undefined;
    previewWidth = undefined;
    safeSegment = !canPreview || liveColumns() === undefined;
    safePrefixWritten = false;
    statusVisible = false;
    dirty = false;
  }

  function finalizeSegment(
    newline: boolean,
    restoreCursor = true,
  ): boolean {
    cancelPending();
    if (statusPreviewIsUnsafe(liveColumns())) {
      commitStatusPreview();
    }
    acceptSanitizerTail();
    cancelPending();
    if (currentLine.length > 0) {
      const wasSafe = safeSegment;
      const hadPreview = previewVisible;
      const canCommitPreview =
        !wasSafe &&
        hadPreview &&
        !statusVisible &&
        previewSource === currentLine;
      const frame =
        wasSafe || canCommitPreview ? undefined : renderedCurrentLine();
      resetSegment();
      if (wasSafe) {
        if (newline) {
          writePlain("\n");
        }
      } else if (canCommitPreview) {
        if (newline) {
          enqueueOutput("\n");
        }
      } else {
        if (hadPreview) {
          enqueueOutput(`\r${ANSI.clearLine}`);
        }
        enqueueOutput(`${frame ?? ""}${newline ? "\n" : ""}`);
      }
      if (restoreCursor) {
        showCursor();
      }
      return !newline;
    }
    if (statusVisible) {
      resetSegment();
      enqueueOutput(`\r${ANSI.clearLine}`);
    } else {
      resetSegment();
    }
    if (restoreCursor) {
      showCursor();
    }
    return false;
  }

  function hasPendingRendererState(): boolean {
    return segmentStarted || statusVisible || currentLine.length > 0 || dirty;
  }

  function settleDisposal(): boolean {
    if (disposeMode === undefined || disposed) {
      return false;
    }
    if (disposeMode === "discard") {
      if (hasPendingRendererState() || previewVisible) {
        cancelPending();
        clearPreview();
        sanitizer.reset();
        resetSegment();
        return true;
      }
    } else if (hasPendingRendererState()) {
      if (disposeOutputLineOpen) {
        enqueueOutput("\n");
        disposeOutputLineOpen = false;
      }
      disposeOutputLineOpen = finalizeSegment(false, false);
      return true;
    }
    if (cursorHidden) {
      showCursor();
      return true;
    }
    cancelPending();
    disposed = true;
    disposeMode = undefined;
    return false;
  }

  function finishNow(finalContent?: string): void {
    if (disposed) {
      return;
    }
    if (statusPreviewIsUnsafe(liveColumns())) {
      const expectedStatusVersion = statusVersion;
      commitStatusPreview();
      postOutputActions.push(() => {
        if (
          disposed ||
          segmentStarted ||
          statusVersion !== expectedStatusVersion
        ) {
          return;
        }
        finishNow(finalContent);
      });
      return;
    }
    acceptSanitizerTail();
    if (finalContent !== undefined) {
      const authoritativeFinal = sanitizeCompleteText(finalContent);
      if (authoritativeFinal.startsWith(segmentSource)) {
        const missingSuffix = authoritativeFinal.slice(segmentSource.length);
        segmentSource += missingSuffix;
        acceptVisibleText(missingSuffix);
      } else {
        finalizeSegment(true);
        postOutputActions.push(() => {
          if (disposed) {
            return;
          }
          if (hasPendingRendererState()) {
            finalizeSegment(true);
          }
          segmentSource = authoritativeFinal;
          acceptVisibleText(authoritativeFinal);
          finalizeSegment(true);
        });
        return;
      }
    }
    finalizeSegment(true);
  }

  renderer = {
    showStatus(text) {
      dispatch(() => {
        if (disposed || segmentStarted) {
          return;
        }
        statusVersion += 1;
        const safeText = sanitizedStatus(text);
        const columns = liveColumns();
        if (statusPreviewIsUnsafe(columns)) {
          const expectedStatusVersion = statusVersion;
          commitStatusPreview();
          postOutputActions.push(() => {
            if (
              disposed ||
              segmentStarted ||
              statusVersion !== expectedStatusVersion
            ) {
              return;
            }
            if (safeText.length === 0) {
              showCursor();
            } else {
              renderer.showStatus(text);
            }
          });
          return;
        }
        if (safeText.length === 0) {
          if (statusVisible) {
            clearPreview();
            showCursor();
          }
          return;
        }
        if (!canPreview || columns === undefined || stringWidth(prefix) >= columns) {
          if (statusVisible) {
            clearPreview();
            showCursor();
            if (disposed || segmentStarted) {
              return;
            }
          }
          writePlain(`${prefix}${safeText}\n`);
          return;
        }
        clearPreview();
        hideCursor();
        const statusFrame = `${prefix}${fitStatusToLine(safeText, columns)}`;
        previewVisible = true;
        previewSource = undefined;
        previewWidth = stringWidth(statusFrame);
        statusVisible = true;
        enqueueOutput(statusFrame);
      });
    },

    append(delta) {
      dispatch(() => {
        if (disposed || delta.length === 0) {
          return;
        }
        const visibleText = sanitizer.push(delta);
        segmentSource += visibleText;
        acceptVisibleText(visibleText);
      });
    },

    finishSegment(finalContent) {
      dispatch(() => finishNow(finalContent));
    },

    dispose(disposeOptions) {
      dispatch(() => {
        if (disposed || disposeMode !== undefined) {
          return;
        }
        disposeMode =
          disposeOptions?.preserve === true ? "preserve" : "discard";
        if (disposeMode === "preserve") {
          disposeOutputLineOpen = finalizeSegment(false, false);
          return;
        }
        cancelPending();
        if (canPreview) {
          clearPreview();
        }
        showCursor();
        sanitizer.reset();
        resetSegment();
      });
    },
  };
  return renderer;
}
