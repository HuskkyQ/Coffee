import assert from "node:assert/strict";
import test from "node:test";

import {
  getSessionSelectionItems,
  parseDeleteConfirmation,
  parseSessionChoice,
  renderSessionsMenu,
} from "../src/session-commands.js";
import * as sessionCommands from "../src/session-commands.js";
import type { SessionListItem } from "../src/history/types.js";

const sessions: readonly SessionListItem[] = [
  {
    id: "s1",
    title: "第一杯咖啡",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messageCount: 4,
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
  {
    id: "s2",
    title: "第二杯咖啡",
    providerId: "opencode-go",
    modelId: "kimi-k2.7-code",
    messageCount: 2,
    updatedAt: "2026-07-16T09:30:00.000Z",
  },
];

test("builds sanitized session selection items with current status", () => {
  const items = getSessionSelectionItems(sessions, "s2");

  assert.strictEqual(items[0]?.value, sessions[0]);
  assert.equal(items[0]?.label, "第一杯咖啡");
  assert.match(
    items[0]?.description ?? "",
    /deepseek\/deepseek-v4-flash · 4 条消息 · 2026\/7\/16 16:00:00/u,
  );
  assert.equal(items[0]?.status, undefined);
  assert.equal(items[1]?.status, "当前");
});

test("exports one terminal sanitizer for every CLI rendering boundary", () => {
  const sanitizeTerminalText = Reflect.get(
    sessionCommands,
    "sanitizeTerminalText",
  );
  assert.equal(typeof sanitizeTerminalText, "function");
  assert.equal(
    sanitizeTerminalText(
      "  正常中文\t\u0007\u001b]52;c;DANGEROUS\u0007\u001b[2J  ",
    ),
    "正常中文",
  );
  assert.equal(sanitizeTerminalText("\u001b[2J\u0007"), "");
});

test("renders the fixed empty-state message", () => {
  assert.equal(renderSessionsMenu([]), "还没有已保存的会话。");
});

test("renders a deterministic session menu without changing its input", () => {
  const before = structuredClone(sessions);

  assert.equal(
    renderSessionsMenu(sessions, "s2"),
    [
      "选择会话（Esc 取消）：",
      "1.   第一杯咖啡  deepseek/deepseek-v4-flash  4 条消息  2026/7/16 16:00:00",
      "2. * 第二杯咖啡  opencode-go/kimi-k2.7-code  2 条消息  2026/7/16 17:30:00",
    ].join("\n"),
  );
  assert.deepEqual(sessions, before);
});

test("sanitizes terminal controls from every dynamic menu label", () => {
  const unsafeSessions: readonly SessionListItem[] = [
    {
      id: "unsafe",
      title:
        "  普通中文\t标题\n\u0007\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[2J  ",
      providerId: "deep\u0007 seek\u001b[2J",
      modelId: "model\tid\u001b]52;c;bW9kZWw=\u0007",
      messageCount: 1,
      updatedAt: "2026-07-16T08:00:00.000Z",
    },
    {
      id: "empty-title",
      title: "\u001b[2J\t\n\u0007",
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      messageCount: 0,
      updatedAt: "2026-07-16T09:30:00.000Z",
    },
  ];
  const before = structuredClone(unsafeSessions);

  const output = renderSessionsMenu(unsafeSessions, "unsafe");

  assert.match(output, /普通中文 标题/);
  assert.match(output, /deep seek\/model id/);
  assert.match(output, /2\.   新会话/);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u0007"), false);
  assert.equal(output.includes("\t"), false);
  assert.equal(output.includes("\r"), false);
  assert.equal(output.split("\n").length, 3);
  assert.deepEqual(unsafeSessions, before);
});

test("parses a trimmed decimal session number without changing its input", () => {
  const input = " 2 ";
  const before = structuredClone(sessions);

  assert.strictEqual(parseSessionChoice(input, sessions), sessions[1]);
  assert.equal(input, " 2 ");
  assert.deepEqual(sessions, before);
});

test("rejects empty, non-decimal, unsafe, and out-of-range session choices", () => {
  for (const input of [
    "",
    "   ",
    "0",
    "-1",
    "+1",
    "1.0",
    "1.5",
    "1e0",
    "Infinity",
    "NaN",
    "０１",
    "1a",
    "1 2",
    "9007199254740992",
    "999999999999999999999999999999999999",
  ]) {
    assert.equal(parseSessionChoice(input, sessions), undefined, input);
  }
  assert.equal(parseSessionChoice("3", sessions), undefined);
});

test("does not read an array index for an out-of-range choice", () => {
  const indexedReads: string[] = [];
  const guardedSessions = new Proxy(sessions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        indexedReads.push(property);
        throw new Error(`unexpected indexed read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.equal(parseSessionChoice("3", guardedSessions), undefined);
  assert.deepEqual(indexedReads, []);
});

test("returns undefined for sparse or accessor-backed entries", () => {
  const sparse = new Array<SessionListItem>(1);
  assert.equal(parseSessionChoice("1", sparse), undefined);

  Object.defineProperty(sparse, "0", {
    configurable: true,
    get() {
      throw new Error("unexpected getter call");
    },
  });
  assert.equal(parseSessionChoice("1", sparse), undefined);
});

test("delete confirmation is default-no and accepts only y or yes", () => {
  for (const input of ["y", "Y", " yes ", "\tYeS\n"]) {
    assert.equal(parseDeleteConfirmation(input), true, input);
  }
  for (const input of ["", "   ", "n", "no", "true", "1", "是", "yes!"]) {
    assert.equal(parseDeleteConfirmation(input), false, input);
  }
});
