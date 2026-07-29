import assert from "node:assert/strict";
import test from "node:test";

import {
  createShellOutputProcessor,
  truncateShellOutput,
} from "../src/shell/output.js";

test("preserves a UTF-8 character split across chunks", () => {
  const processor = createShellOutputProcessor();
  const coffee = Buffer.from("咖啡\n");

  processor.push("stdout", coffee.subarray(0, 2));
  processor.push("stdout", coffee.subarray(2, 4));
  processor.push("stdout", coffee.subarray(4));

  assert.deepEqual(processor.finish(), {
    output: "咖啡\n",
    truncated: false,
  });
});

test("does not invent a logical line when a split line ends in a later chunk", () => {
  const processor = createShellOutputProcessor();
  const remaining = Array.from(
    { length: 1_999 },
    (_, index) => `line-${index + 1}\n`,
  ).join("");

  processor.push("stdout", Buffer.from("line-0"));
  processor.push("stdout", Buffer.from(`\n${remaining}`));

  const result = processor.finish();
  assert.equal(result.truncated, false);
  assert.match(result.output, /^line-0\n/);
  assert.match(result.output, /line-1999\n$/);
});

test("removes OSC sequences split across chunks", () => {
  const processor = createShellOutputProcessor();

  processor.push("stderr", Buffer.from("before\u001b]0;bad"));
  processor.push("stderr", Buffer.from(" title\u001b"));
  processor.push("stderr", Buffer.from("\\after\n"));

  assert.equal(processor.finish().output, "beforeafter\n");
});

test("removes CSI sequences split across chunks", () => {
  const processor = createShellOutputProcessor();

  processor.push("stdout", Buffer.from("plain\u001b[38;5"));
  processor.push("stdout", Buffer.from(";196mred\u001b["));
  processor.push("stdout", Buffer.from("0m!\n"));

  assert.equal(processor.finish().output, "plainred!\n");
});

test("normalizes carriage-return redraws and drops unsafe controls", () => {
  const processor = createShellOutputProcessor();

  processor.push(
    "stdout",
    Buffer.from("10%\r20%\r100%\nkeep\tthis\u0000\u0008\u0085done\n"),
  );

  assert.equal(
    processor.finish().output,
    "10%\n20%\n100%\nkeep\tthisdone\n",
  );
});

test("keeps model head and tail with one line truncation marker", () => {
  const input = Array.from(
    { length: 2_100 },
    (_, index) => `line-${index}\n`,
  ).join("");

  const result = truncateShellOutput(input);

  assert.equal(result.truncated, true);
  assert.match(result.output, /^line-0\n/);
  assert.match(result.output, /line-999\n/);
  assert.doesNotMatch(result.output, /line-1000\n/);
  assert.doesNotMatch(result.output, /line-1099\n/);
  assert.match(result.output, /line-1100\n/);
  assert.match(result.output, /line-2099\n$/);
  assert.equal(result.output.match(/output truncated/g)?.length, 1);
});

test("caps each side at 25KB after line truncation with uneven output", () => {
  const largeHead = Array.from(
    { length: 1_000 },
    () => `${"h".repeat(38)}\n`,
  ).join("");
  const middle = Array.from({ length: 101 }, () => "middle\n").join("");
  const smallTail = Array.from({ length: 1_000 }, () => "t\n").join("");

  const result = truncateShellOutput(`${largeHead}${middle}${smallTail}`);
  const markerStart = result.output.indexOf("[output truncated");
  const markerEnd = result.output.indexOf("]", markerStart);
  const head = result.output.slice(0, markerStart);
  const tail = result.output.slice(markerEnd + 1).replace(/^\n/, "");

  assert.equal(result.truncated, true);
  assert.ok(markerStart >= 0);
  assert.ok(markerEnd > markerStart);
  assert.ok(Buffer.byteLength(head, "utf8") <= 25 * 1_024);
  assert.ok(Buffer.byteLength(tail, "utf8") <= 25 * 1_024);
  assert.equal(tail, smallTail);
});

test("keeps UTF-8-safe head and tail when the model byte cap is exceeded", () => {
  const input = `${"咖".repeat(12_000)}HEAD${"啡".repeat(12_000)}TAIL`;

  const result = truncateShellOutput(input);

  assert.equal(result.truncated, true);
  assert.match(result.output, /^咖/);
  assert.match(result.output, /TAIL$/);
  assert.doesNotMatch(result.output, /\uFFFD/);
  assert.equal(result.output.match(/output truncated/g)?.length, 1);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 52 * 1_024);
});

test("emits the terminal cap marker exactly once and keeps model output", () => {
  const visible: string[] = [];
  const processor = createShellOutputProcessor({
    terminalMaxBytes: 1_000,
    terminalMaxLines: 2,
    onVisibleChunk(chunk) {
      visible.push(chunk);
    },
  });

  processor.push("stdout", Buffer.from("one\ntwo\nthree\n"));
  processor.push("stderr", Buffer.from("four\nfive\n"));
  const result = processor.finish();

  assert.equal(visible.join("").match(/\[Shell output truncated\]/g)?.length, 1);
  assert.equal(visible.join(""), "one\ntwo\n[Shell output truncated]\n");
  assert.deepEqual(result, {
    output: "one\ntwo\nthree\nfour\nfive\n",
    truncated: false,
  });
});

test("applies the terminal byte cap at a UTF-8 boundary", () => {
  const visible: string[] = [];
  const processor = createShellOutputProcessor({
    terminalMaxBytes: 4,
    terminalMaxLines: 100,
    onVisibleChunk(chunk) {
      visible.push(chunk);
    },
  });

  processor.push("stdout", Buffer.from("咖啡"));
  processor.push("stdout", Buffer.from("more"));
  processor.finish();

  assert.equal(visible.join(""), "咖\n[Shell output truncated]\n");
  assert.doesNotMatch(visible.join(""), /\uFFFD/);
  assert.equal(visible.join("").match(/\[Shell output truncated\]/g)?.length, 1);
});

test("does not allow processor options to disable the terminal safety cap", () => {
  const visible: string[] = [];
  const processor = createShellOutputProcessor({
    terminalMaxBytes: Number.POSITIVE_INFINITY,
    terminalMaxLines: Number.POSITIVE_INFINITY,
    onVisibleChunk(chunk) {
      visible.push(chunk);
    },
  });

  processor.push("stdout", Buffer.alloc(201 * 1_024, 0x61));
  processor.finish();

  assert.equal(visible.join("").match(/\[Shell output truncated\]/g)?.length, 1);
});

test("isolates decoders and sanitizer state for interleaved streams", () => {
  const visible: string[] = [];
  const processor = createShellOutputProcessor({
    onVisibleChunk(chunk) {
      visible.push(chunk);
    },
  });
  const coffee = Buffer.from("咖啡");

  processor.push("stdout", coffee.subarray(0, 2));
  processor.push("stderr", Buffer.from("err\u001b]0;hidden"));
  processor.push("stdout", coffee.subarray(2));
  processor.push("stderr", Buffer.from(" title\u0007!\n"));

  const result = processor.finish();
  assert.equal(visible.join(""), "err咖啡!\n");
  assert.equal(result.output, "err咖啡!\n");
});

test("does not leak incomplete terminal sequences when finishing", () => {
  const processor = createShellOutputProcessor();

  processor.push("stdout", Buffer.from("ok\u001b[31"));
  processor.push("stderr", Buffer.from("error\u001b]unfinished"));

  assert.equal(processor.finish().output, "okerror");
});

test("bounds the accumulated model output in the processor", () => {
  const processor = createShellOutputProcessor();
  const head = "head-line\n";
  const middle = "m".repeat(80 * 1_024);
  const tail = "\ntail-line\n";

  processor.push("stdout", Buffer.from(head));
  processor.push("stdout", Buffer.from(middle));
  processor.push("stdout", Buffer.from(tail));
  const result = processor.finish();

  assert.equal(result.truncated, true);
  assert.match(result.output, /^head-line\n/);
  assert.match(result.output, /tail-line\n$/);
  assert.equal(result.output.match(/output truncated/g)?.length, 1);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 52 * 1_024);
});
