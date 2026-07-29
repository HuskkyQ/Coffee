import { createTwoFilesPatch } from "diff";

import {
  CodeToolError,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  EDIT_MAX_REPLACEMENTS,
} from "./types.js";

export interface ExactEdit {
  oldText: string;
  newText: string;
}

export interface PreparedMutation {
  content: string;
  patch: string;
  changedLines: number;
  firstChangedLine?: number;
}

interface MatchedEdit {
  start: number;
  end: number;
  newText: string;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function dominantLineEnding(text: string): "\r\n" | "\n" | "\r" {
  const counts = new Map<"\r\n" | "\n" | "\r", number>();
  const order: Array<"\r\n" | "\n" | "\r"> = [];
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as "\r\n" | "\n" | "\r";
    if (!counts.has(ending)) order.push(ending);
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  let selected = order[0] ?? "\n";
  for (const ending of order.slice(1)) {
    if ((counts.get(ending) ?? 0) > (counts.get(selected) ?? 0)) {
      selected = ending;
    }
  }
  return selected;
}

function occurrences(content: string, needle: string): number[] {
  const result: number[] = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const index = content.indexOf(needle, from);
    if (index === -1) break;
    result.push(index);
    from = index + needle.length;
  }
  return result;
}

function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\n]*?(?:\u0007|\u001b\\|(?=\n|$))/g, "")
    .replace(/\u009d[^\u0007\n]*?(?:\u0007|\u009c|(?=\n|$))/g, "")
    .replace(/\u001b[P^_X][^\n]*?(?:\u001b\\|(?=\n|$))/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function sanitizePath(path: string): string {
  return JSON.stringify(sanitizeTerminalText(path))
    .slice(1, -1)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function physicalLineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

function assertPreviewWithinLimits(patch: string): void {
  if (
    physicalLineCount(patch) > DIFF_MAX_LINES ||
    Buffer.byteLength(patch) > DIFF_MAX_BYTES
  ) {
    throw new CodeToolError(
      "LIMIT_EXCEEDED",
      "Diff 超过 200 行或 50KB，请拆分修改。",
    );
  }
}

function analyzePatch(patch: string): {
  changedLines: number;
  firstChangedLine?: number;
} {
  let changedLines = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (inHunk && (line.startsWith("+") || line.startsWith("-"))) {
      changedLines += 1;
    }
  }
  const firstHunk = patch.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m);
  return {
    changedLines,
    ...(firstHunk ? { firstChangedLine: Number(firstHunk[1]) } : {}),
  };
}

function finalize(
  path: string,
  oldContent: string,
  newContent: string,
  content: string,
): PreparedMutation {
  const displayPath = sanitizePath(path);
  const rawPatch = createTwoFilesPatch(
    displayPath,
    displayPath,
    oldContent,
    newContent,
    "",
    "",
    {
      context: 4,
      maxEditLength: DIFF_MAX_LINES,
      timeout: 1_000,
    },
  );
  if (rawPatch === undefined) {
    throw new CodeToolError(
      "LIMIT_EXCEEDED",
      "Diff 超过 200 行或 50KB，请拆分修改。",
    );
  }
  const patch = sanitizeTerminalText(rawPatch);
  assertPreviewWithinLimits(patch);
  return { content, patch, ...analyzePatch(patch) };
}

export function prepareEdit(
  path: string,
  original: string,
  edits: readonly ExactEdit[],
): PreparedMutation {
  if (edits.length < 1 || edits.length > EDIT_MAX_REPLACEMENTS) {
    throw new CodeToolError("INVALID_ARGUMENT", "edits 必须包含 1 到 20 项。");
  }

  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const originalWithoutBom = bom ? original.slice(1) : original;
  const lineEnding = dominantLineEnding(originalWithoutBom);
  const base = normalizeLineEndings(originalWithoutBom);
  const matched = edits.map((edit, index): MatchedEdit => {
    const oldText = normalizeLineEndings(edit.oldText);
    const newText = normalizeLineEndings(edit.newText);
    if (oldText.length === 0) {
      throw new CodeToolError(
        "INVALID_ARGUMENT",
        `edits[${index}].oldText 不能为空。`,
      );
    }
    if (oldText === newText) {
      throw new CodeToolError(
        "EDIT_NO_CHANGE",
        `edits[${index}] 没有产生变化。`,
      );
    }
    const matches = occurrences(base, oldText);
    if (matches.length === 0) {
      throw new CodeToolError(
        "EDIT_NOT_FOUND",
        `edits[${index}] 的精确文本不存在。`,
      );
    }
    if (matches.length !== 1) {
      throw new CodeToolError(
        "EDIT_NOT_UNIQUE",
        `edits[${index}] 的精确文本出现 ${matches.length} 次。`,
      );
    }
    const start = matches[0]!;
    return { start, end: start + oldText.length, newText };
  }).sort((left, right) => left.start - right.start);

  for (let index = 1; index < matched.length; index += 1) {
    if (matched[index - 1]!.end > matched[index]!.start) {
      throw new CodeToolError("EDIT_OVERLAP", "edits 中存在重叠区域。");
    }
  }

  let next = base;
  for (const edit of [...matched].reverse()) {
    next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
  }
  if (next === base) {
    throw new CodeToolError("EDIT_NO_CHANGE", "修改没有产生变化。");
  }
  if (base.length > 0 && next.length === 0) {
    throw new CodeToolError("PATH_DENIED", "edit 不能清空整个文件。");
  }

  const restored = bom + (
    lineEnding === "\n" ? next : next.replace(/\n/g, lineEnding)
  );
  return finalize(path, base, next, restored);
}

export function prepareNewFile(
  path: string,
  content: string,
): PreparedMutation {
  if (content.length === 0) {
    const patch = [
      "--- /dev/null",
      `+++ ${sanitizePath(path)}`,
      "@@ new empty file @@",
      "",
    ].join("\n");
    assertPreviewWithinLimits(patch);
    return { content, patch, changedLines: 0 };
  }
  return finalize(path, "", normalizeLineEndings(content), content);
}
