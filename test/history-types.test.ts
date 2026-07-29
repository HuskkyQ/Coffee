import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clonePersistedMessages,
  DEFAULT_HISTORY_PREFERENCES,
  toModelMessages,
  type HistoryPreferences,
  type PersistedMessage,
  type SessionListItem,
  type StoredSession,
  type StoredSummary,
  type StoredTurn,
} from "../src/history/types.js";
import type { ModelMessage } from "../src/models/types.js";

function makeMessages(): readonly PersistedMessage[] {
  return [
    { role: "user", content: "推荐一家咖啡店" },
    {
      role: "assistant",
      content: "我先查一下。",
      toolCalls: [
        {
          id: "call-1",
          name: "web_search",
          argumentsJson: '{"query":"coffee"}',
        },
      ],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: "需要搜索",
        details: [{ step: 1 }],
      },
    },
    { role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
  ];
}

test("limits Node to versions supported by better-sqlite3", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { engines?: { node?: string } };

  assert.equal(packageJson.engines?.node, ">=22.19.0 <27");
});

test("persisted messages use the user, assistant, and tool runtime shapes", () => {
  assert.deepEqual(makeMessages(), [
    { role: "user", content: "推荐一家咖啡店" },
    {
      role: "assistant",
      content: "我先查一下。",
      toolCalls: [
        {
          id: "call-1",
          name: "web_search",
          argumentsJson: '{"query":"coffee"}',
        },
      ],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: "需要搜索",
        details: [{ step: 1 }],
      },
    },
    { role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
  ]);
});

test("clonePersistedMessages deep-clones nested message data", () => {
  const source = makeMessages();
  const cloned = clonePersistedMessages(source);
  const sourceAssistant = source[1];
  const clonedAssistant = cloned[1];

  assert.deepEqual(cloned, source);
  assert.notStrictEqual(cloned, source);
  assert.equal(sourceAssistant?.role, "assistant");
  assert.equal(clonedAssistant?.role, "assistant");
  assert.notStrictEqual(clonedAssistant.toolCalls, sourceAssistant.toolCalls);
  assert.notStrictEqual(clonedAssistant.reasoning, sourceAssistant.reasoning);
  assert.notStrictEqual(
    clonedAssistant.reasoning?.details,
    sourceAssistant.reasoning?.details,
  );

  const mutableAssistant = clonedAssistant as unknown as {
    content: string;
    toolCalls: Array<{ name: string }>;
    reasoning?: { text?: string; details?: Array<{ step: number }> };
  };
  mutableAssistant.content = "已修改";
  mutableAssistant.toolCalls[0]!.name = "changed_tool";
  mutableAssistant.reasoning!.text = "已修改推理";
  mutableAssistant.reasoning!.details![0]!.step = 2;

  const clonedTool = cloned[2];
  assert.equal(clonedTool?.role, "tool");
  (clonedTool as { content: string }).content = '{"ok":false}';

  assert.equal(sourceAssistant.content, "我先查一下。");
  assert.equal(sourceAssistant.toolCalls[0]!.name, "web_search");
  assert.equal(sourceAssistant.reasoning?.text, "需要搜索");
  assert.deepEqual(sourceAssistant.reasoning?.details, [{ step: 1 }]);
  assert.equal(source[2]?.content, '{"ok":true}');
});

test("default history preferences expose frozen budget values", () => {
  assert.deepEqual(DEFAULT_HISTORY_PREFERENCES, {
    compressionThresholdChars: 30_000,
    maxContextChars: 40_000,
    summaryTargetChars: 5_000,
  });
  assert.equal(Object.isFrozen(DEFAULT_HISTORY_PREFERENCES), true);
});

test("toModelMessages returns ModelMessage values without shared references", () => {
  const source = makeMessages();
  const modelMessages: ModelMessage[] = toModelMessages(source);
  const sourceAssistant = source[1];
  const modelAssistant = modelMessages[1];

  assert.deepEqual(modelMessages, source);
  assert.notStrictEqual(modelMessages, source);
  assert.equal(sourceAssistant?.role, "assistant");
  assert.equal(modelAssistant?.role, "assistant");
  assert.notStrictEqual(modelAssistant.toolCalls, sourceAssistant.toolCalls);
  assert.notStrictEqual(modelAssistant.reasoning, sourceAssistant.reasoning);
  assert.notStrictEqual(
    modelAssistant.reasoning?.details,
    sourceAssistant.reasoning?.details,
  );

  modelAssistant.content = "已修改";
  modelAssistant.toolCalls[0]!.name = "changed_tool";
  const mutableReasoning = modelAssistant.reasoning as {
    text?: string;
    details?: Array<{ step: number }>;
  };
  mutableReasoning.text = "已修改推理";
  mutableReasoning.details![0]!.step = 2;

  const modelTool = modelMessages[2];
  assert.equal(modelTool?.role, "tool");
  modelTool.content = '{"ok":false}';

  assert.equal(sourceAssistant.content, "我先查一下。");
  assert.equal(sourceAssistant.toolCalls[0]!.name, "web_search");
  assert.equal(sourceAssistant.reasoning?.text, "需要搜索");
  assert.deepEqual(sourceAssistant.reasoning?.details, [{ step: 1 }]);
  assert.equal(source[2]?.content, '{"ok":true}');
});

if (false) {
  // @ts-expect-error Persisted history never contains system messages.
  const systemMessage: PersistedMessage = { role: "system", content: "system" };

  const arbitraryRole: string = "user";
  const arbitraryMessage: PersistedMessage = {
    // @ts-expect-error Persisted message roles are a closed union.
    role: arbitraryRole,
    content: "content",
  };

  // @ts-expect-error Assistant history must include toolCalls.
  const assistantWithoutToolCalls: PersistedMessage = {
    role: "assistant",
    content: "content",
  };

  // @ts-expect-error Tool history must identify its tool call.
  const toolWithoutToolCallId: PersistedMessage = {
    role: "tool",
    content: "content",
  };

  const turn: StoredTurn = {
    id: "turn-1",
    sequence: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    messages: [],
  };
  // @ts-expect-error Stored turn fields are readonly.
  turn.sequence = 2;
  // @ts-expect-error Stored turn messages are readonly.
  turn.messages.push({ role: "user", content: "content" });

  const summary: StoredSummary = {
    throughTurnSequence: 1,
    content: "summary",
    sourceRevision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  // @ts-expect-error Stored summary fields are readonly.
  summary.content = "changed";

  const session: StoredSession = {
    id: "session-1",
    title: "Session",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    revision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    turns: [turn],
    summary,
  };
  // @ts-expect-error Stored session fields are readonly.
  session.title = "Changed";
  // @ts-expect-error Stored session turns are readonly.
  session.turns.push(turn);

  const listItem: SessionListItem = {
    id: "session-1",
    title: "Session",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messageCount: 3,
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  // @ts-expect-error Session list item fields are readonly.
  listItem.messageCount = 4;

  const preferences: HistoryPreferences = DEFAULT_HISTORY_PREFERENCES;
  // @ts-expect-error History preference fields are readonly.
  preferences.maxContextChars = 1;

  void [
    systemMessage,
    arbitraryMessage,
    assistantWithoutToolCalls,
    toolWithoutToolCallId,
  ];
}
