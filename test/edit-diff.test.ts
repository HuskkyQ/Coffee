import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFilesPatch } from "diff";

import {
  CodeToolError,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  EDIT_MAX_REPLACEMENTS,
} from "../src/code-tools/types.js";
import {
  prepareEdit,
  prepareNewFile,
} from "../src/code-tools/edit-diff.js";

function assertCode(
  operation: () => unknown,
  code: CodeToolError["code"],
): CodeToolError {
  let received: unknown;
  try {
    operation();
  } catch (error) {
    received = error;
  }
  assert.ok(received instanceof CodeToolError);
  assert.equal(received.code, code);
  return received;
}

function physicalLineCount(value: string): number {
  if (value.length === 0) return 0;
  const splitCount = value.split("\n").length;
  return value.endsWith("\n") ? splitCount - 1 : splitCount;
}

function plainNewFilePatch(path: string, content: string): string {
  return createTwoFilesPatch(path, path, "", content, "", "", { context: 4 })
    .replace(/\t/g, "");
}

test("applies multiple exact edits against one original and preserves BOM and CRLF", () => {
  const result = prepareEdit(
    "src/a.ts",
    "\uFEFFconst a = 1;\r\nconst b = 2;\r\n",
    [
      { oldText: "const a = 1;", newText: "const a = 3;" },
      { oldText: "const b = 2;", newText: "" },
    ],
  );

  assert.equal(result.content, "\uFEFFconst a = 3;\r\n\r\n");
  assert.equal(result.firstChangedLine, 1);
  assert.equal(result.changedLines, 4);
  assert.match(result.patch, /^--- src\/a\.ts$/m);
  assert.match(result.patch, /^\+\+\+ src\/a\.ts$/m);
  assert.match(result.patch, /^\+const a = 3;$/m);
  assert.doesNotMatch(result.patch, /\r|\uFEFF/);
});

test("returns structured errors for invalid, ambiguous, overlapping, no-op, and clearing edits", () => {
  assertCode(
    () => prepareEdit("a.ts", "x", []),
    "INVALID_ARGUMENT",
  );
  assertCode(
    () => prepareEdit("a.ts", "x", [{ oldText: "", newText: "z" }]),
    "INVALID_ARGUMENT",
  );
  assertCode(
    () => prepareEdit("a.ts", "x", [{ oldText: "y", newText: "z" }]),
    "EDIT_NOT_FOUND",
  );
  assertCode(
    () => prepareEdit("a.ts", "x x", [{ oldText: "x", newText: "z" }]),
    "EDIT_NOT_UNIQUE",
  );
  assertCode(
    () => prepareEdit("a.ts", "abcdef", [
      { oldText: "abcd", newText: "x" },
      { oldText: "cdef", newText: "y" },
    ]),
    "EDIT_OVERLAP",
  );
  assertCode(
    () => prepareEdit("a.ts", "x", [{ oldText: "x", newText: "x" }]),
    "EDIT_NO_CHANGE",
  );
  assertCode(
    () => prepareEdit("a.ts", "x", [{ oldText: "x", newText: "" }]),
    "PATH_DENIED",
  );
});

test("rejects a complete preview above the diff line limit", () => {
  const content = Array.from({ length: 201 }, (_, index) => `line ${index}`)
    .join("\n");

  assertCode(
    () => prepareNewFile("large.txt", content),
    "LIMIT_EXCEEDED",
  );
});

test("sanitizes terminal controls and an untrusted path only in the preview", () => {
  const content = "safe\u001b[31mred\u001b[0m\u0000\u007f";
  const result = prepareNewFile(
    "evil\n--- forged\u202E\u001b]0;title\u0007.txt",
    content,
  );

  assert.equal(result.content, content);
  assert.doesNotMatch(result.patch, /\u001b|\u0000|\u0007|\u007f|\u202e/iu);
  assert.doesNotMatch(result.patch, /^--- forged/m);
  assert.doesNotMatch(result.patch, /\[31m|\]0;title/);
});

test("represents creation of an empty file in the confirmation preview", () => {
  const result = prepareNewFile("empty.txt", "");

  assert.equal(result.content, "");
  assert.equal(result.changedLines, 0);
  assert.equal(result.firstChangedLine, undefined);
  assert.match(result.patch, /^--- \/dev\/null$/m);
  assert.match(result.patch, /^\+\+\+ empty\.txt$/m);
  assert.match(result.patch, /new empty file/);
});

test("accepts 20 edits and rejects more than 20", () => {
  const original = Array.from(
    { length: EDIT_MAX_REPLACEMENTS },
    (_, index) => `item[${index}]`,
  ).join(" ");
  const edits = Array.from(
    { length: EDIT_MAX_REPLACEMENTS },
    (_, index) => ({ oldText: `item[${index}]`, newText: `done[${index}]` }),
  );

  assert.equal(
    prepareEdit("items.txt", original, edits).content,
    original.replaceAll("item[", "done["),
  );
  assertCode(
    () => prepareEdit("items.txt", original, [
      ...edits,
      { oldText: "absent", newText: "extra" },
    ]),
    "INVALID_ARGUMENT",
  );
});

test("rejects a no-op item even when another item would change", () => {
  assertCode(
    () => prepareEdit("a.txt", "x y", [
      { oldText: "x", newText: "x" },
      { oldText: "y", newText: "z" },
    ]),
    "EDIT_NO_CHANGE",
  );
  assertCode(
    () => prepareEdit("a.txt", "x\r\n", [
      { oldText: "x\n", newText: "x\r" },
    ]),
    "EDIT_NO_CHANGE",
  );
});

test("rejects edits whose combined result is a no-op", () => {
  assertCode(
    () => prepareEdit("a.txt", "ab", [
      { oldText: "a", newText: "" },
      { oldText: "b", newText: "ab" },
    ]),
    "EDIT_NO_CHANGE",
  );
});

test("normalizes every newline style for matching and restores the dominant style", () => {
  const result = prepareEdit(
    "mixed.txt",
    "alpha\rbeta\rgamma\n",
    [{ oldText: "alpha\r\nbeta", newText: "A\nB" }],
  );

  assert.equal(result.content, "A\rB\rgamma\r");
  assert.doesNotMatch(result.patch, /\r/);
});

test("locates every edit in the original rather than in earlier replacements", () => {
  assertCode(
    () => prepareEdit("a.txt", "a", [
      { oldText: "a", newText: "b" },
      { oldText: "b", newText: "c" },
    ]),
    "EDIT_NOT_FOUND",
  );
});

test("uses non-overlapping occurrence search and detects Unicode overlaps", () => {
  assert.equal(
    prepareEdit("a.txt", "aaa", [{ oldText: "aa", newText: "X" }]).content,
    "Xa",
  );
  assertCode(
    () => prepareEdit("emoji.txt", "😀abc", [
      { oldText: "😀a", newText: "left" },
      { oldText: "abc", newText: "right" },
    ]),
    "EDIT_OVERLAP",
  );
});

test("counts header-like changed content and reads firstChangedLine from the first hunk", () => {
  const headerLike = prepareEdit(
    "a.txt",
    "--- old\ncontext\n",
    [{ oldText: "--- old", newText: "+++ new" }],
  );
  assert.equal(headerLike.changedLines, 2);

  const lines = Array.from({ length: 30 }, (_, index) => `line-${index + 1}`);
  const twoHunks = prepareEdit("lines.txt", `${lines.join("\n")}\n`, [
    { oldText: "line-10", newText: "changed-10" },
    { oldText: "line-25", newText: "changed-25" },
  ]);
  const firstHunk = twoHunks.patch.match(
    /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/m,
  );
  assert.ok(firstHunk);
  assert.equal(twoHunks.firstChangedLine, Number(firstHunk[1]));
  assert.equal(twoHunks.firstChangedLine, 6);
});

test("allows exactly 200 preview lines and rejects 201 without truncation", () => {
  let exactContent: string | undefined;
  for (let count = 1; count <= DIFF_MAX_LINES; count += 1) {
    const candidate = `${Array.from({ length: count }, () => "x").join("\n")}\n`;
    if (physicalLineCount(plainNewFilePatch("lines.txt", candidate)) === DIFF_MAX_LINES) {
      exactContent = candidate;
      break;
    }
  }
  assert.ok(exactContent);

  const exact = prepareNewFile("lines.txt", exactContent);
  assert.equal(physicalLineCount(exact.patch), DIFF_MAX_LINES);
  assert.equal(exact.changedLines, exactContent.split("\n").length - 1);
  const overContent = `${exactContent}x\n`;
  assert.equal(
    physicalLineCount(plainNewFilePatch("lines.txt", overContent)),
    DIFF_MAX_LINES + 1,
  );
  assertCode(
    () => prepareNewFile("lines.txt", overContent),
    "LIMIT_EXCEEDED",
  );
});

test("allows exactly 50KB of preview bytes and rejects the next byte", () => {
  const oneBytePatch = plainNewFilePatch("bytes.txt", "x");
  const overhead = Buffer.byteLength(oneBytePatch) - 1;
  const exactContent = "x".repeat(DIFF_MAX_BYTES - overhead);
  assert.equal(
    Buffer.byteLength(plainNewFilePatch("bytes.txt", exactContent)),
    DIFF_MAX_BYTES,
  );

  const exact = prepareNewFile("bytes.txt", exactContent);
  assert.equal(Buffer.byteLength(exact.patch), DIFF_MAX_BYTES);
  assert.ok(
    exact.patch.includes(
      `+${exactContent}\n\\ No newline at end of file\n`,
    ),
  );
  assertCode(
    () => prepareNewFile("bytes.txt", `${exactContent}x`),
    "LIMIT_EXCEEDED",
  );
});

test("sanitizes complete and malformed terminal sequences while preserving actual edit content", () => {
  const controlContent =
    "x\u001b]0;bad\u001b[31mstill\u0007y\u009b32mz\u0008\u007f";
  const result = prepareEdit(
    "control.txt",
    "plain",
    [{ oldText: "plain", newText: controlContent }],
  );

  assert.equal(result.content, controlContent);
  assert.doesNotMatch(result.patch, /bad|still|\[31m|32m/);
  assert.doesNotMatch(result.patch, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
});

test("keeps path injection escaped and enforces preview limits for empty files", () => {
  const safe = prepareNewFile("a\n+++ forged\u202E.txt", "");
  assert.match(safe.patch, /a\\n\+\+\+ forged\.txt/);
  assert.doesNotMatch(safe.patch, /^\+\+\+ forged/m);

  assertCode(
    () => prepareNewFile("p".repeat(DIFF_MAX_BYTES), ""),
    "LIMIT_EXCEEDED",
  );
});

test("preserves non-empty new-file content and only normalizes its patch", () => {
  const content = "\uFEFFone\r\ntwo\r\n";
  const result = prepareNewFile("new.txt", content);

  assert.equal(result.content, content);
  assert.doesNotMatch(result.patch, /\r/);
  assert.match(result.patch, /^\+\uFEFFone$/m);
  assert.equal(result.firstChangedLine, 1);
  assert.equal(result.changedLines, 2);
});

test("edit errors identify only the item and never echo oldText secrets", () => {
  const secret = `SECRET_TOKEN_${"x".repeat(4_000)}`;
  const error = assertCode(
    () => prepareEdit("secret.txt", "public", [
      { oldText: secret, newText: "replacement" },
    ]),
    "EDIT_NOT_FOUND",
  );

  assert.doesNotMatch(error.message, /SECRET_TOKEN/);
  assert.ok(error.message.length < 100);
});

test("rejects a high-difference preview before Myers diff can block the CLI", () => {
  const lineCount = 10_000;
  const oldText = Array.from(
    { length: lineCount },
    (_, index) => `old-${index}`,
  ).join("\n");
  const newText = Array.from(
    { length: lineCount },
    (_, index) => `new-${index}`,
  ).join("\n");
  const startedAt = performance.now();

  const error = assertCode(
    () => prepareEdit("stress.txt", oldText, [{ oldText, newText }]),
    "LIMIT_EXCEEDED",
  );

  assert.ok(performance.now() - startedAt < 5_000);
  assert.doesNotMatch(error.message, /old-0|new-0/);
});
