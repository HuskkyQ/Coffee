type StreamName = "stdout" | "stderr";
type EscapeState = "text" | "escape" | "csi" | "osc" | "osc_escape";

export interface ShellOutputProcessor {
  push(stream: StreamName, chunk: Buffer): void;
  finish(): { output: string; truncated: boolean };
}

export interface ShellOutputProcessorOptions {
  onVisibleChunk?: (chunk: string) => void;
  terminalMaxBytes?: number;
  terminalMaxLines?: number;
}

const MODEL_MAX_BYTES = 50 * 1_024;
const MODEL_MAX_LINES = 2_000;
const MODEL_SIDE_MAX_BYTES = 25 * 1_024;
const MODEL_SIDE_MAX_LINES = 1_000;
const TERMINAL_MAX_BYTES = 200 * 1_024;
const TERMINAL_MAX_LINES = 2_000;
const TERMINAL_TRUNCATION_MARKER = "[Shell output truncated]";

interface TruncatedOutput {
  output: string;
  truncated: boolean;
}

class TerminalSanitizer {
  private state: EscapeState = "text";

  push(input: string): string {
    let output = "";

    for (const character of input) {
      const codePoint = character.codePointAt(0) ?? 0;

      if (this.state === "text") {
        if (character === "\u001b") {
          this.state = "escape";
        } else if (character === "\u009b") {
          this.state = "csi";
        } else if (character === "\u009d") {
          this.state = "osc";
        } else if (character === "\r") {
          output += "\n";
        } else if (character === "\n" || character === "\t") {
          output += character;
        } else if (
          codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          !(codePoint >= 0x80 && codePoint <= 0x9f)
        ) {
          output += character;
        }
        continue;
      }

      if (this.state === "escape") {
        if (character === "[") this.state = "csi";
        else if (character === "]") this.state = "osc";
        else if (character !== "\u001b") this.state = "text";
        continue;
      }

      if (this.state === "csi") {
        if (codePoint >= 0x40 && codePoint <= 0x7e) {
          this.state = "text";
        } else if (character === "\u001b") {
          this.state = "escape";
        }
        continue;
      }

      if (this.state === "osc") {
        if (character === "\u0007" || character === "\u009c") {
          this.state = "text";
        } else if (character === "\u001b") {
          this.state = "osc_escape";
        }
        continue;
      }

      if (character === "\\" || character === "\u009c") {
        this.state = "text";
      } else if (character !== "\u001b") {
        this.state = "osc";
      }
    }

    return output;
  }
}

function utf8Prefix(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input);
  if (bytes.length <= maxBytes) return input;

  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Suffix(input: string, maxBytes: number): string {
  const bytes = Buffer.from(input);
  if (bytes.length <= maxBytes) return input;

  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function appendUtf8Prefix(current: string, input: string, maxBytes: number): string {
  const remaining = maxBytes - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + utf8Prefix(input, remaining);
}

function appendUtf8Suffix(current: string, input: string, maxBytes: number): string {
  const inputSuffix = utf8Suffix(input, maxBytes);
  return utf8Suffix(current + inputSuffix, maxBytes);
}

function joinWithMarker(
  head: string,
  tail: string,
  omittedLines: number,
  omittedBytes: number,
): string {
  const marker = `[output truncated: omitted ${omittedLines} lines and ${omittedBytes} bytes]`;
  const before = head.length > 0 && !head.endsWith("\n") ? "\n" : "";
  const after = tail.length > 0 ? "\n" : "";
  return `${head}${before}${marker}${after}${tail}`;
}

class BoundedModelOutput {
  private totalBytes = 0;
  private completedLines = 0;
  private hasPendingLine = false;
  private globalHead = "";
  private globalTail = "";
  private lineHead = "";
  private pendingLine = "";
  private tailLines: string[] = [];
  private tailBytes = 0;
  private smallFull: string | undefined = "";

  push(input: string): void {
    if (input.length === 0) return;

    const inputBytes = Buffer.byteLength(input, "utf8");
    this.totalBytes += inputBytes;
    this.globalHead = appendUtf8Prefix(
      this.globalHead,
      input,
      MODEL_MAX_BYTES,
    );
    this.globalTail = appendUtf8Suffix(
      this.globalTail,
      input,
      MODEL_MAX_BYTES,
    );

    if (
      this.smallFull !== undefined &&
      Buffer.byteLength(this.smallFull, "utf8") + inputBytes <= MODEL_MAX_BYTES
    ) {
      this.smallFull += input;
    } else {
      this.smallFull = undefined;
    }

    let start = 0;
    for (let index = input.indexOf("\n"); index !== -1; index = input.indexOf("\n", start)) {
      const part = input.slice(start, index + 1);
      this.captureLinePart(part);
      this.finishLine();
      start = index + 1;
    }
    if (start < input.length) {
      this.captureLinePart(input.slice(start));
      this.hasPendingLine = true;
    }
  }

  finish(): TruncatedOutput {
    if (this.hasPendingLine) {
      this.finishLine();
      this.hasPendingLine = false;
    }

    const totalLines = this.completedLines;
    if (
      totalLines <= MODEL_MAX_LINES &&
      this.totalBytes <= MODEL_MAX_BYTES &&
      this.smallFull !== undefined
    ) {
      return { output: this.smallFull, truncated: false };
    }

    const lineTruncated = totalLines > MODEL_MAX_LINES;
    let head = lineTruncated ? this.lineHead : this.globalHead;
    let tail = lineTruncated ? this.tailLines.join("") : this.globalTail;
    head = utf8Prefix(head, MODEL_SIDE_MAX_BYTES);
    tail = utf8Suffix(tail, MODEL_SIDE_MAX_BYTES);
    if (
      !head.endsWith("\n") &&
      Buffer.byteLength(head, "utf8") === MODEL_SIDE_MAX_BYTES
    ) {
      head = utf8Prefix(head, MODEL_SIDE_MAX_BYTES - 1);
    }

    const keptBytes =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
    return {
      output: joinWithMarker(
        head,
        tail,
        Math.max(0, totalLines - MODEL_MAX_LINES),
        Math.max(0, this.totalBytes - keptBytes),
      ),
      truncated: true,
    };
  }

  private captureLinePart(part: string): void {
    if (this.completedLines < MODEL_SIDE_MAX_LINES) {
      this.lineHead = appendUtf8Prefix(
        this.lineHead,
        part,
        MODEL_MAX_BYTES,
      );
    }
    this.pendingLine = appendUtf8Suffix(
      this.pendingLine,
      part,
      MODEL_MAX_BYTES,
    );
  }

  private finishLine(): void {
    this.completedLines += 1;
    this.tailLines.push(this.pendingLine);
    this.tailBytes += Buffer.byteLength(this.pendingLine, "utf8");
    this.pendingLine = "";
    this.hasPendingLine = false;

    while (this.tailLines.length > MODEL_SIDE_MAX_LINES) {
      const removed = this.tailLines.shift() ?? "";
      this.tailBytes -= Buffer.byteLength(removed, "utf8");
    }

    while (this.tailBytes > MODEL_MAX_BYTES && this.tailLines.length > 0) {
      const excess = this.tailBytes - MODEL_MAX_BYTES;
      const first = this.tailLines[0] ?? "";
      const firstBytes = Buffer.byteLength(first, "utf8");
      if (firstBytes <= excess) {
        this.tailLines.shift();
        this.tailBytes -= firstBytes;
        continue;
      }

      const trimmed = utf8Suffix(first, firstBytes - excess);
      this.tailLines[0] = trimmed;
      this.tailBytes -= firstBytes - Buffer.byteLength(trimmed, "utf8");
    }
  }
}

class TerminalOutputLimit {
  private bytes = 0;
  private lines = 0;
  private stopped = false;
  private emittedAny = false;
  private endsWithNewline = false;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
    private readonly onVisibleChunk: ((chunk: string) => void) | undefined,
  ) {}

  push(input: string): void {
    if (input.length === 0 || this.onVisibleChunk === undefined || this.stopped) {
      return;
    }

    let visible = "";
    for (const character of input) {
      const bytes = Buffer.byteLength(character, "utf8");
      const lines = character === "\n" ? 1 : 0;
      if (
        this.lines >= this.maxLines ||
        this.bytes + bytes > this.maxBytes ||
        this.lines + lines > this.maxLines
      ) {
        if (visible.length > 0) this.emit(visible);
        this.emitMarker();
        return;
      }
      visible += character;
      this.bytes += bytes;
      this.lines += lines;
    }
    if (visible.length > 0) this.emit(visible);
  }

  private emit(chunk: string): void {
    this.onVisibleChunk?.(chunk);
    this.emittedAny = true;
    this.endsWithNewline = chunk.endsWith("\n");
  }

  private emitMarker(): void {
    if (this.stopped) return;
    const prefix = this.emittedAny && !this.endsWithNewline ? "\n" : "";
    this.onVisibleChunk?.(`${prefix}${TERMINAL_TRUNCATION_MARKER}\n`);
    this.stopped = true;
  }
}

function terminalLimit(value: number | undefined, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

export function createShellOutputProcessor(
  options: ShellOutputProcessorOptions = {},
): ShellOutputProcessor {
  const decoders: Record<StreamName, TextDecoder> = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
  };
  const sanitizers: Record<StreamName, TerminalSanitizer> = {
    stdout: new TerminalSanitizer(),
    stderr: new TerminalSanitizer(),
  };
  const modelOutput = new BoundedModelOutput();
  const terminalOutput = new TerminalOutputLimit(
    terminalLimit(options.terminalMaxBytes, TERMINAL_MAX_BYTES),
    terminalLimit(options.terminalMaxLines, TERMINAL_MAX_LINES),
    options.onVisibleChunk,
  );

  const processText = (stream: StreamName, input: string): void => {
    const safe = sanitizers[stream].push(input);
    modelOutput.push(safe);
    terminalOutput.push(safe);
  };

  return {
    push(stream, chunk) {
      processText(stream, decoders[stream].decode(chunk, { stream: true }));
    },
    finish() {
      processText("stdout", decoders.stdout.decode());
      processText("stderr", decoders.stderr.decode());
      return modelOutput.finish();
    },
  };
}

export function truncateShellOutput(input: string): TruncatedOutput {
  const output = new BoundedModelOutput();
  output.push(input);
  return output.finish();
}
