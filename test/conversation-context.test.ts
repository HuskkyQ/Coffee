import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  SUMMARY_PREFIX,
  buildContext,
  createSummarySource,
  planCompression,
  redactSummaryContent,
  stableCharacterCost,
  type BuildContextInput,
} from "../src/history/context.js";
import type {
  HistoryPreferences,
  PersistedMessage,
  StoredSummary,
  StoredTurn,
} from "../src/history/types.js";
import type { ModelMessage } from "../src/models/types.js";

const LARGE_PREFERENCES: HistoryPreferences = {
  compressionThresholdChars: 2,
  maxContextChars: 20_000,
  summaryTargetChars: 1,
};

function turn(
  sequence: number,
  messages: readonly PersistedMessage[],
): StoredTurn {
  return {
    id: `turn-${sequence}`,
    sequence,
    createdAt: "2026-07-17T00:00:00.000Z",
    messages,
  };
}

function chatTurn(sequence: number, content: string): StoredTurn {
  return turn(sequence, [
    { role: "user", content },
    { role: "assistant", content: `reply-${content}`, toolCalls: [] },
  ]);
}

function summary(content: string, throughTurnSequence = 0): StoredSummary {
  return {
    throughTurnSequence,
    content,
    sourceRevision: 1,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
}

function contextMessages(
  systemPrompt: string,
  previousSummary: StoredSummary | undefined,
  turns: readonly StoredTurn[],
  currentMessages: readonly PersistedMessage[],
): ModelMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...(previousSummary
      ? [
          {
            role: "system" as const,
            content: `${SUMMARY_PREFIX}${previousSummary.content}`,
          },
        ]
      : []),
    ...turns.flatMap((item) => item.messages),
    ...currentMessages,
  ];
}

function assertSafeError(operation: () => unknown, secret: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /上下文数据无法安全处理/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
}

function assertContextSafeError(operation: () => unknown, secret?: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /上下文数据无法安全处理/);
    if (secret !== undefined) {
      assert.doesNotMatch(error.message, new RegExp(secret));
    }
    return true;
  });
}

test("stableCharacterCost is deterministic and does not mutate its input", () => {
  const input = {
    second: { nested: [2, 3] },
    first: 1,
  };
  const before = structuredClone(input);

  assert.equal(
    stableCharacterCost(input),
    stableCharacterCost({ first: 1, second: { nested: [2, 3] } }),
  );
  assert.deepEqual(input, before);
});

test("stableCharacterCost counts an assistant tool call id", () => {
  const short: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "1", name: "tool", argumentsJson: "{}" }],
  };
  const long: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "call-id-is-longer", name: "tool", argumentsJson: "{}" }],
  };

  assert.ok(stableCharacterCost(long) > stableCharacterCost(short));
});

test("stableCharacterCost counts an assistant tool call name", () => {
  const short: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "call-1", name: "x", argumentsJson: "{}" }],
  };
  const long: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "call-1", name: "calculator", argumentsJson: "{}" }],
  };

  assert.ok(stableCharacterCost(long) > stableCharacterCost(short));
});

test("stableCharacterCost counts assistant tool call arguments", () => {
  const short: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [{ id: "call-1", name: "tool", argumentsJson: "{}" }],
  };
  const long: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [
      { id: "call-1", name: "tool", argumentsJson: '{"query":"coffee"}' },
    ],
  };

  assert.ok(stableCharacterCost(long) > stableCharacterCost(short));
});

test("stableCharacterCost counts tool result content", () => {
  const short: PersistedMessage = {
    role: "tool",
    toolCallId: "call-1",
    content: "x",
  };
  const long: PersistedMessage = {
    role: "tool",
    toolCallId: "call-1",
    content: '{"result":"forty-two"}',
  };

  assert.ok(stableCharacterCost(long) > stableCharacterCost(short));
});

test("stableCharacterCost counts reasoning text", () => {
  const withoutText: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [],
    reasoning: { providerId: "deepseek" },
  };
  const withText: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [],
    reasoning: { providerId: "deepseek", text: "private reasoning" },
  };

  assert.ok(stableCharacterCost(withText) > stableCharacterCost(withoutText));
});

test("stableCharacterCost counts opaque reasoning details", () => {
  const withoutDetails: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [],
    reasoning: { providerId: "deepseek" },
  };
  const withDetails: PersistedMessage = {
    role: "assistant",
    content: "answer",
    toolCalls: [],
    reasoning: {
      providerId: "deepseek",
      details: [{ type: "opaque", value: { step: 1 } }],
    },
  };

  assert.ok(stableCharacterCost(withDetails) > stableCharacterCost(withoutDetails));
});

test("stableCharacterCost never executes inherited toJSON or own getters", () => {
  let calls = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() {
      calls += 1;
      throw new Error("INHERITED_TO_JSON_SECRET");
    },
  });
  try {
    assert.equal(stableCharacterCost({ value: "safe" }) > 0, true);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", previous);
  }

  const getterSecret = "OWN_GETTER_SECRET_4187";
  const value = Object.defineProperty({}, "content", {
    enumerable: true,
    get() {
      throw new Error(getterSecret);
    },
  });
  assertSafeError(() => stableCharacterCost(value), getterSecret);
});

test("stableCharacterCost reports unserializable and proxy data safely", () => {
  const functionSecret = "FUNCTION_SECRET_4187";
  assertSafeError(
    () => stableCharacterCost({ value: () => functionSecret }),
    functionSecret,
  );

  const proxySecret = "PROXY_SECRET_4187";
  const proxy = new Proxy({}, {
    ownKeys() {
      throw new Error(proxySecret);
    },
  });
  assertSafeError(() => stableCharacterCost(proxy), proxySecret);
});

test("buildContext orders system, summary, history, and current messages", () => {
  const previousSummary = summary("older facts", 99);
  const historical = chatTurn(1, "history");
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];

  const built = buildContext({
    systemPrompt: "system",
    summary: previousSummary,
    turns: [historical],
    currentMessages: current,
    preferences: LARGE_PREFERENCES,
  });

  assert.deepEqual(built.messages, contextMessages(
    "system",
    previousSummary,
    [historical],
    current,
  ));
  assert.equal(built.messages[1]?.content, `${SUMMARY_PREFIX}older facts`);
  assert.deepEqual(built.includedTurnSequences, [1]);
  assert.equal(built.cost, stableCharacterCost(built.messages));
});

test("buildContext selects the newest contiguous complete turns at the exact cap", () => {
  const oldest = chatTurn(1, "old-".repeat(30));
  const middle = chatTurn(2, "middle-".repeat(8));
  const newest = chatTurn(3, "newest-".repeat(8));
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];
  const expected = contextMessages("system", undefined, [middle, newest], current);

  const built = buildContext({
    systemPrompt: "system",
    turns: [oldest, middle, newest],
    currentMessages: current,
    preferences: {
      ...LARGE_PREFERENCES,
      maxContextChars: stableCharacterCost(expected),
    },
  });

  assert.deepEqual(built.includedTurnSequences, [2, 3]);
  assert.deepEqual(built.messages, expected);
  assert.equal(built.cost, stableCharacterCost(expected));
});

test("buildContext stops at the first non-fitting turn instead of filling a gap", () => {
  const oldest = chatTurn(1, "tiny");
  const middle = chatTurn(2, "middle-".repeat(50));
  const newest = chatTurn(3, "newest");
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];
  const newestOnly = contextMessages("system", undefined, [newest], current);

  const built = buildContext({
    systemPrompt: "system",
    turns: [oldest, middle, newest],
    currentMessages: current,
    preferences: {
      ...LARGE_PREFERENCES,
      maxContextChars: stableCharacterCost(newestOnly) + 10,
    },
  });

  assert.deepEqual(built.includedTurnSequences, [3]);
  assert.equal(JSON.stringify(built.messages).includes("tiny"), false);
});

test("buildContext includes or excludes a tool turn as one unit", () => {
  const toolTurn = turn(1, [
    { role: "user", content: "calculate" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "calculator", argumentsJson: '{"value":42}' },
      ],
    },
    { role: "tool", toolCallId: "call-1", content: '{"result":42}' },
    { role: "assistant", content: "42", toolCalls: [] },
  ]);
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];
  const mandatory = contextMessages("system", undefined, [], current);
  const complete = contextMessages("system", undefined, [toolTurn], current);

  const excluded = buildContext({
    systemPrompt: "system",
    turns: [toolTurn],
    currentMessages: current,
    preferences: {
      ...LARGE_PREFERENCES,
      maxContextChars: stableCharacterCost(mandatory),
    },
  });
  const included = buildContext({
    systemPrompt: "system",
    turns: [toolTurn],
    currentMessages: current,
    preferences: {
      ...LARGE_PREFERENCES,
      maxContextChars: stableCharacterCost(complete),
    },
  });

  assert.deepEqual(excluded.includedTurnSequences, []);
  assert.deepEqual(excluded.messages, mandatory);
  assert.deepEqual(included.includedTurnSequences, [1]);
  assert.deepEqual(included.messages, complete);
});

test("buildContext does not filter caller-provided turns by summary coverage", () => {
  const historical = chatTurn(2, "caller-kept");
  const built = buildContext({
    systemPrompt: "system",
    summary: summary("old", 10),
    turns: [historical],
    currentMessages: [{ role: "user", content: "current" }],
    preferences: LARGE_PREFERENCES,
  });

  assert.deepEqual(built.includedTurnSequences, [2]);
  assert.equal(JSON.stringify(built.messages).includes("caller-kept"), true);
});

test("buildContext returns deep clones without sharing nested data", () => {
  const details = [{ private: { step: 1 } }];
  const toolCalls = [
    { id: "call-1", name: "calculator", argumentsJson: '{"value":1}' },
  ];
  const historical = turn(1, [
    { role: "user", content: "history" },
    {
      role: "assistant",
      content: "answer",
      toolCalls,
      reasoning: { providerId: "deepseek", details },
    },
  ]);
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];

  const built = buildContext({
    systemPrompt: "system",
    turns: [historical],
    currentMessages: current,
    preferences: LARGE_PREFERENCES,
  });
  const assistant = built.messages[2];
  assert.equal(assistant?.role, "assistant");
  assert.notStrictEqual(assistant.toolCalls, toolCalls);
  assert.notStrictEqual(assistant.reasoning?.details, details);

  (assistant.toolCalls as unknown as Array<{ name: string }>)[0]!.name = "changed";
  ((assistant.reasoning!.details as Array<{ private: { step: number } }>)[0]!)
    .private.step = 2;
  (built.messages[3] as { content: string }).content = "changed-current";

  assert.equal(toolCalls[0]!.name, "calculator");
  assert.deepEqual(details, [{ private: { step: 1 } }]);
  assert.equal(current[0]!.content, "current");
});

test("buildContext rejects mandatory messages above the hard cap without leaking them", () => {
  const secret = "MANDATORY_SECRET_4187";
  const mandatory = contextMessages("system", undefined, [], [
    { role: "user", content: secret },
  ]);
  assert.throws(
    () => buildContext({
      systemPrompt: "system",
      turns: [],
      currentMessages: [{ role: "user", content: secret }],
      preferences: {
        ...LARGE_PREFERENCES,
        maxContextChars: stableCharacterCost(mandatory) - 1,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /当前回合超过上下文上限/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test("buildContext enforces strict runtime history preference ordering", () => {
  const invalidPreferences: Array<readonly [string, HistoryPreferences]> = [
    ["zero summary target", {
      summaryTargetChars: 0,
      compressionThresholdChars: 100,
      maxContextChars: 1_000,
    }],
    ["summary target equals threshold", {
      summaryTargetChars: 100,
      compressionThresholdChars: 100,
      maxContextChars: 1_000,
    }],
    ["summary target exceeds threshold", {
      summaryTargetChars: 101,
      compressionThresholdChars: 100,
      maxContextChars: 1_000,
    }],
    ["threshold equals maximum", {
      summaryTargetChars: 10,
      compressionThresholdChars: 1_000,
      maxContextChars: 1_000,
    }],
    ["threshold exceeds maximum", {
      summaryTargetChars: 10,
      compressionThresholdChars: 1_001,
      maxContextChars: 1_000,
    }],
    ["fractional target", {
      summaryTargetChars: 10.5,
      compressionThresholdChars: 100,
      maxContextChars: 1_000,
    }],
  ];

  for (const [label, preferences] of invalidPreferences) {
    assertContextSafeError(
      () => buildContext({
        systemPrompt: "system",
        turns: [],
        currentMessages: [{ role: "user", content: "current" }],
        preferences,
      }),
    );
    assert.ok(label.length > 0);
  }
});

test("buildContext safely rejects invalid persisted message runtime shapes", () => {
  const base: BuildContextInput = {
    systemPrompt: "system",
    turns: [],
    currentMessages: [{ role: "user", content: "current" }],
    preferences: LARGE_PREFERENCES,
  };
  const cases: Array<readonly [string, unknown]> = [
    ["system role", { role: "system", content: "SYSTEM_ROLE_SECRET" }],
    ["assistant without tool calls", {
      role: "assistant",
      content: "MISSING_TOOL_CALLS_SECRET",
    }],
  ];

  for (const [, message] of cases) {
    assertContextSafeError(
      () => buildContext({
        ...base,
        currentMessages: [message] as readonly PersistedMessage[],
      }),
      String((message as { content: string }).content),
    );
  }

  const nonStringSecret = "NON_STRING_CONTENT_SECRET";
  assertContextSafeError(
    () => buildContext({
      ...base,
      turns: [turn(1, [
        {
          role: "user",
          content: { value: nonStringSecret },
        } as unknown as PersistedMessage,
      ])],
    }),
    nonStringSecret,
  );
});

test("buildContext rejects message getters and polluted prototypes without executing them", () => {
  let getterCalls = 0;
  const getterSecret = "MESSAGE_GETTER_SECRET_4187";
  const getterMessage = Object.defineProperties({}, {
    role: {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error(getterSecret);
      },
    },
    content: { enumerable: true, value: "content" },
  });
  assertContextSafeError(
    () => buildContext({
      systemPrompt: "system",
      turns: [],
      currentMessages: [getterMessage] as unknown as readonly PersistedMessage[],
      preferences: LARGE_PREFERENCES,
    }),
    getterSecret,
  );
  assert.equal(getterCalls, 0);

  let inheritedCalls = 0;
  const polluted = Object.create(Object.defineProperty({}, "role", {
    get() {
      inheritedCalls += 1;
      return "user";
    },
  })) as { content: string };
  polluted.content = "content";
  assertContextSafeError(() => buildContext({
    systemPrompt: "system",
    turns: [],
    currentMessages: [polluted] as unknown as readonly PersistedMessage[],
    preferences: LARGE_PREFERENCES,
  }));
  assert.equal(inheritedCalls, 0);
});

test("planCompression starts at the exact threshold and selects oldest turns until enough", () => {
  const turns = [
    chatTurn(1, "first-".repeat(20)),
    chatTurn(2, "second-".repeat(20)),
    chatTurn(3, "third-".repeat(20)),
  ];
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];
  const target = 5;
  const afterFirst = contextMessages(
    "system",
    summary("x".repeat(target)),
    turns.slice(1),
    current,
  );
  const afterSecond = contextMessages(
    "system",
    summary("x".repeat(target)),
    turns.slice(2),
    current,
  );
  const firstCost = stableCharacterCost(afterFirst);
  const secondCost = stableCharacterCost(afterSecond);
  const before = structuredClone(turns);
  assert.ok(firstCost > secondCost);

  const plan = planCompression({
    systemPrompt: "system",
    turns,
    currentMessages: current,
    preferences: {
      compressionThresholdChars: firstCost - 1,
      maxContextChars: 20_000,
      summaryTargetChars: target,
    },
  });

  assert.deepEqual(plan.shouldCompress, true);
  assert.equal(plan.throughTurnSequence, 2);
  assert.ok(plan.source?.includes("first-"));
  assert.ok(plan.source?.includes("second-"));
  assert.equal(plan.source?.includes("third-"), false);
  assert.deepEqual(turns, before);

  const exactFullCost = stableCharacterCost(
    contextMessages("system", undefined, [turns[0]!], current),
  );
  const exactPlan = planCompression({
    systemPrompt: "system",
    turns: [turns[0]!],
    currentMessages: current,
    preferences: {
      compressionThresholdChars: exactFullCost,
      maxContextChars: 20_000,
      summaryTargetChars: target,
    },
  });
  assert.equal(exactPlan.shouldCompress, true);
  assert.equal(exactPlan.throughTurnSequence, 1);
});

test("planCompression includes the existing summary in its source", () => {
  const oldSummary = summary("previous decision", 4);
  const historical = chatTurn(5, "new material ".repeat(10));
  const current: PersistedMessage[] = [{ role: "user", content: "current" }];
  const projected = contextMessages(
    "system",
    summary("x"),
    [],
    current,
  );

  const plan = planCompression({
    systemPrompt: "system",
    summary: oldSummary,
    turns: [historical],
    currentMessages: current,
    preferences: {
      compressionThresholdChars: stableCharacterCost(projected),
      maxContextChars: 20_000,
      summaryTargetChars: 1,
    },
  });

  assert.equal(plan.shouldCompress, true);
  assert.equal(plan.throughTurnSequence, 5);
  assert.ok(plan.source?.includes("previous decision"));
  assert.ok(plan.source?.includes("new material"));
});

test("planCompression returns false when there is no turn or all turns cannot meet the threshold", () => {
  const current: PersistedMessage[] = [
    { role: "user", content: "current-".repeat(30) },
  ];
  const noTurns = planCompression({
    systemPrompt: "system",
    turns: [],
    currentMessages: current,
    preferences: {
      compressionThresholdChars: 20,
      maxContextChars: 20_000,
      summaryTargetChars: 5,
    },
  });
  assert.deepEqual(noTurns, { shouldCompress: false });

  const historical = chatTurn(1, "history");
  const before = structuredClone([historical]);
  const cannotFit = planCompression({
    systemPrompt: "system",
    turns: [historical],
    currentMessages: current,
    preferences: {
      compressionThresholdChars: 20,
      maxContextChars: 20_000,
      summaryTargetChars: 5,
    },
  });
  assert.deepEqual(cannotFit, { shouldCompress: false });
  assert.deepEqual([historical], before);
});

test("createSummarySource redacts all visible channels and excludes reasoning", () => {
  const reasoningOnlySecret = "REASONING_ONLY_SECRET_4187";
  const oldSummary = summary(
    "Previous Bearer old-summary-token and sk-oldsummary",
  );
  const historical = turn(1, [
    {
      role: "user",
      content: '{"profile":{"api_key":"sk-user-secret"},"note":"keep-user"}',
    },
    {
      role: "assistant",
      content: "assistant-visible Bearer assistant-token",
      toolCalls: [
        {
          id: "call-1",
          name: "fetch_data",
          argumentsJson:
            '{"Authorization":"Bearer args-token","nested":{"token":"tvly-args"},"query":"keep-args"}',
        },
        {
          id: "call-2",
          name: "invalid_args",
          argumentsJson: "not-json tvly-invalid-args",
        },
      ],
      reasoning: {
        providerId: "deepseek",
        text: reasoningOnlySecret,
        details: [{ opaque: reasoningOnlySecret }],
      },
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content:
        '{"result":"keep-tool","credentials":{"clientSecret":"sk-tool-secret"}}',
    },
    {
      role: "tool",
      toolCallId: "call-2",
      content: "invalid result tvly-tool-secret Bearer tool-token",
    },
  ]);

  const source = createSummarySource(oldSummary, [historical]);

  for (const visible of [
    "Previous",
    "keep-user",
    "assistant-visible",
    "fetch_data",
    "keep-args",
    "invalid_args",
    "keep-tool",
  ]) {
    assert.ok(source.includes(visible), `missing visible text: ${visible}`);
  }
  for (const secret of [
    "old-summary-token",
    "sk-oldsummary",
    "sk-user-secret",
    "assistant-token",
    "args-token",
    "tvly-args",
    "tvly-invalid-args",
    "sk-tool-secret",
    "tvly-tool-secret",
    "tool-token",
    reasoningOnlySecret,
    "opaque",
  ]) {
    assert.equal(source.includes(secret), false, `leaked secret: ${secret}`);
  }
  assert.ok(source.includes("[REDACTED]"));
});

test("createSummarySource redacts an auth key without treating author as auth", () => {
  const source = createSummarySource(undefined, [
    turn(1, [
      {
        role: "user",
        content: '{"auth":"plain-credential","author":"keep-author"}',
      },
    ]),
  ]);

  assert.equal(source.includes("plain-credential"), false);
  assert.ok(source.includes('"auth":"[REDACTED]"'));
  assert.ok(source.includes('"author":"keep-author"'));
});

test("redactSummaryContent removes recursive JSON secrets and plain credential patterns without mutation", () => {
  const input = JSON.stringify({
    note:
      "keep ordinary facts Bearer bearer-summary-secret sk-summary-secret tvly-summary-secret",
    nested: {
      token: "token-summary-secret",
      api_key: "api-key-summary-secret",
      auth: "auth-summary-secret",
      secret: "generic-summary-secret",
      preference: "keep preference",
    },
  });
  const before = input;

  const redacted = redactSummaryContent(input);

  assert.equal(input, before);
  assert.match(redacted, /keep ordinary facts/);
  assert.match(redacted, /keep preference/);
  assert.match(redacted, /\[REDACTED\]/);
  for (const secret of [
    "bearer-summary-secret",
    "sk-summary-secret",
    "tvly-summary-secret",
    "token-summary-secret",
    "api-key-summary-secret",
    "auth-summary-secret",
    "generic-summary-secret",
  ]) {
    assert.equal(redacted.includes(secret), false, `leaked secret: ${secret}`);
  }
});

test("redactSummaryContent never falls back to raw text after parsing deep valid JSON", () => {
  const secret = "sk-deep-summary-output-secret-4187";
  const depth = 8_000;
  const input = `${'{"nested":'.repeat(depth)}{"token":"${secret}"}${"}".repeat(depth)}`;

  assertSafeError(() => redactSummaryContent(input), secret);
});

test("createSummarySource never falls back to raw text after parsing deep valid JSON", () => {
  const secret = "sk-deep-json-secret-4187";
  const depth = 8_000;
  const content = `${'{"nested":'.repeat(depth)}{"token":"${secret}"}${"}".repeat(depth)}`;

  assertSafeError(
    () => createSummarySource(undefined, [
      turn(1, [{ role: "user", content }]),
    ]),
    secret,
  );
});

test("createSummarySource ignores toJSON and __proto__ pollution without mutation", () => {
  let calls = 0;
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    get() {
      calls += 1;
      throw new Error("TO_JSON_POLLUTION_SECRET");
    },
  });
  try {
    const sourceMessages: PersistedMessage[] = [
      {
        role: "user",
        content:
          '{"__proto__":{"token":"sk-prototype-secret"},"safe":"kept"}',
      },
    ];
    const historical = turn(1, sourceMessages);
    const before = structuredClone(historical);

    const source = createSummarySource(undefined, [historical]);

    assert.equal(calls, 0);
    assert.ok(source.includes("kept"));
    assert.equal(source.includes("sk-prototype-secret"), false);
    assert.deepEqual(historical, before);
    assert.equal(Object.hasOwn(Object.prototype, "token"), false);
  } finally {
    if (previous === undefined) delete (Object.prototype as { toJSON?: unknown }).toJSON;
    else Object.defineProperty(Object.prototype, "toJSON", previous);
  }
});

test("context selection and compression planning scale linearly over many turns", () => {
  const turns = Array.from({ length: 2_000 }, (_, index) =>
    chatTurn(index + 1, `history-${index}`));
  const input: BuildContextInput = {
    systemPrompt: "system",
    turns,
    currentMessages: [{ role: "user", content: "c".repeat(500) }],
    preferences: {
      summaryTargetChars: 1,
      compressionThresholdChars: 100,
      maxContextChars: 5_000_000,
    },
  };

  const startedAt = performance.now();
  const built = buildContext(input);
  const compression = planCompression(input);
  const elapsed = performance.now() - startedAt;

  assert.equal(built.includedTurnSequences.length, turns.length);
  assert.deepEqual(compression, { shouldCompress: false });
  assert.ok(elapsed < 3_000, `large context operations took ${elapsed}ms`);
});
