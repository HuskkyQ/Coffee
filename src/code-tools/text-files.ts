import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

import {
  CodeToolError,
  OUTPUT_MAX_BYTES,
  READ_MAX_FILE_BYTES,
} from "./types.js";

const PRIVATE_KEY_MARKER =
  /-----BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY(?: BLOCK)?-----/i;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export interface TextFile {
  bytes: Buffer;
  bom: string;
  text: string;
  lineEnding: "\n" | "\r\n";
  mode: number;
}

export function assertSafeTextContent(text: string): void {
  if (text.includes("\u0000")) {
    throw new CodeToolError("NOT_TEXT", "目标不是可处理的文本内容。");
  }
  if (PRIVATE_KEY_MARKER.test(text)) {
    throw new CodeToolError("PATH_DENIED", "已阻止敏感私钥内容。");
  }
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  const crlfCount = text.match(/\r\n/g)?.length ?? 0;
  const lfCount = (text.match(/\n/g)?.length ?? 0) - crlfCount;
  return crlfCount > lfCount ? "\r\n" : "\n";
}

async function readTextFileInternal(
  absolutePath: string,
  maximumBytes?: number,
  onOpened?: () => Promise<void>,
  allowPrivateKey = false,
): Promise<TextFile> {
  if (
    maximumBytes !== undefined &&
    (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
  ) {
    throw new CodeToolError("INVALID_ARGUMENT", "maximumBytes 必须是非负整数。");
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const nonBlocking = typeof fsConstants.O_NONBLOCK === "number"
    ? fsConstants.O_NONBLOCK
    : 0;
  let handle: FileHandle;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_RDONLY | noFollow | nonBlocking,
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    ) {
      throw new CodeToolError("PATH_DENIED", "目标路径不能是符号链接。");
    }
    throw error;
  }

  let stats;
  let bytes: Buffer;
  try {
    stats = await handle.stat();
    if (!stats.isFile()) {
      throw new CodeToolError("PATH_DENIED", "目标不是普通文件。");
    }
    if (maximumBytes !== undefined && stats.size > maximumBytes) {
      throw new CodeToolError("LIMIT_EXCEEDED", "文件超过允许的大小。");
    }
    await onOpened?.();
    bytes = maximumBytes === undefined
      ? await handle.readFile()
      : await readAtMost(handle, maximumBytes);
    if (maximumBytes !== undefined && bytes.length > maximumBytes) {
      throw new CodeToolError("LIMIT_EXCEEDED", "文件超过允许的大小。");
    }
  } finally {
    await handle.close();
  }

  if (bytes.includes(0)) {
    throw new CodeToolError("NOT_TEXT", "目标不是可读取的文本文件。");
  }

  let decoded: string;
  try {
    decoded = UTF8_DECODER.decode(bytes);
  } catch {
    throw new CodeToolError("NOT_TEXT", "目标不是有效的 UTF-8 文本。");
  }
  if (allowPrivateKey) {
    if (decoded.includes("\u0000")) {
      throw new CodeToolError("NOT_TEXT", "目标不是可处理的文本内容。");
    }
  } else {
    assertSafeTextContent(decoded);
  }

  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom === "" ? decoded : decoded.slice(1);
  return {
    bytes,
    bom,
    text,
    lineEnding: detectLineEnding(text),
    mode: stats.mode & 0o777,
  };
}

export async function readTextFile(
  absolutePath: string,
  maximumBytes?: number,
  onOpened?: () => Promise<void>,
): Promise<TextFile> {
  return await readTextFileInternal(absolutePath, maximumBytes, onOpened);
}

export async function readLocalEnvFile(
  absolutePath: string,
  maximumBytes: number,
): Promise<TextFile> {
  return await readTextFileInternal(
    absolutePath,
    maximumBytes,
    undefined,
    true,
  );
}

async function readAtMost(
  handle: FileHandle,
  maximumBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      total,
      buffer.length - total,
      total,
    );
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

export interface EnvEntry {
  key: string;
  lineIndex: number;
  endLineIndex?: number;
  empty: boolean;
}

export interface ParsedEnvStructure {
  entries: EnvEntry[];
  invalidLines: number[];
  duplicateKeys: string[];
}

function scanEnvValue(
  rawValue: string,
): { valid: boolean; empty: boolean; complete: boolean } {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") {
    const commentIndex = value.indexOf("#");
    const beforeComment = commentIndex === -1
      ? value
      : value.slice(0, commentIndex);
    return { valid: true, empty: beforeComment.trim() === "", complete: true };
  }

  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === quote) {
      const trailing = value.slice(index + 1).trimStart();
      return {
        valid: trailing === "" || trailing.startsWith("#"),
        empty: index === 1,
        complete: true,
      };
    }
  }
  return { valid: false, empty: false, complete: false };
}

export function parseEnvStructure(text: string): ParsedEnvStructure {
  const entries: EnvEntry[] = [];
  const invalidLines: number[] = [];
  const occurrences = new Map<string, number[]>();

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/,
    );
    if (!match) {
      invalidLines.push(lineIndex + 1);
      continue;
    }

    const key = match[1]!;
    let rawValue = match[2]!;
    const quote = rawValue.trimStart()[0];
    let endLineIndex = lineIndex;
    if (quote === "\"" || quote === "'" || quote === "`") {
      while (!scanEnvValue(rawValue).complete && endLineIndex + 1 < lines.length) {
        endLineIndex += 1;
        rawValue += `\n${lines[endLineIndex]}`;
      }
    }
    const value = scanEnvValue(rawValue);
    if (!value.valid) {
      invalidLines.push(lineIndex + 1);
      lineIndex = endLineIndex;
      continue;
    }
    entries.push({
      key,
      lineIndex,
      ...(endLineIndex === lineIndex ? {} : { endLineIndex }),
      empty: value.empty,
    });
    occurrences.set(key, [...(occurrences.get(key) ?? []), lineIndex + 1]);
    lineIndex = endLineIndex;
  }

  return {
    entries,
    invalidLines,
    duplicateKeys: [...occurrences]
      .filter(([, lines]) => lines.length > 1)
      .map(([key]) => key),
  };
}

export async function inspectEnvFile(
  absolutePath: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const file = await readTextFile(absolutePath, READ_MAX_FILE_BYTES);
  const parsed = parseEnvStructure(file.text);
  const linesByKey = new Map<string, number[]>();
  for (const entry of parsed.entries) {
    linesByKey.set(
      entry.key,
      [...(linesByKey.get(entry.key) ?? []), entry.lineIndex + 1],
    );
  }

  const result = {
    ok: true,
    path: relativePath,
    env: {
      keys: [...new Set(parsed.entries.map((entry) => entry.key))],
      emptyKeys: [...new Set(
        parsed.entries.filter((entry) => entry.empty).map((entry) => entry.key),
      )],
      duplicates: [...linesByKey]
        .filter(([, lines]) => lines.length > 1)
        .map(([key, lines]) => ({ key, lines })),
      invalidLines: parsed.invalidLines,
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_MAX_BYTES) {
    throw new CodeToolError(
      "LIMIT_EXCEEDED",
      ".env 结构摘要超过 50KB，无法安全返回。",
    );
  }
  return result;
}
