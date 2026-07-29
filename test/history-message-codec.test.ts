import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMessageRow,
  encodeMessage,
  type MessageRow,
} from "../src/history/message-codec.js";
import type { PersistedMessage } from "../src/history/types.js";

const EMPTY_ROW: MessageRow = {
  role: "user",
  content: "content",
  tool_call_id: null,
  tool_calls_json: null,
  reasoning_json: null,
};

function assertSafeCorruption(operation: () => unknown, secret?: string): void {
  assert.throws(
    operation,
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /历史消息数据损坏/);
      if (secret !== undefined) assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
}

function assertCorrupt(row: unknown, secret?: string): void {
  assertSafeCorruption(() => decodeMessageRow(row), secret);
}

function encodeUnknown(message: unknown): MessageRow {
  return encodeMessage(message as PersistedMessage);
}

function withObjectPrototypeProperties(
  properties: PropertyDescriptorMap,
  callback: () => void,
): void {
  const previous = new Map(
    Object.keys(properties).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key),
    ]),
  );
  Object.defineProperties(Object.prototype, properties);
  try {
    callback();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) {
        delete (Object.prototype as Record<string, unknown>)[key];
      }
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
}

test("round-trips a complete user, tool, and assistant turn", () => {
  const messages: PersistedMessage[] = [
    { role: "user", content: "计算" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "calculator",
          argumentsJson: '{"expression":"6*7"}',
        },
      ],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: "private",
        details: [{ type: "opaque", value: { step: 1 } }],
      },
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content: '{"ok":true,"result":42}',
    },
    { role: "assistant", content: "42", toolCalls: [] },
  ];

  assert.deepEqual(
    messages.map((message) => decodeMessageRow(encodeMessage(message))),
    messages,
  );
});

test("encodes only fields belonging to each message role", () => {
  assert.deepEqual(encodeMessage({ role: "user", content: "hello" }), {
    role: "user",
    content: "hello",
    tool_call_id: null,
    tool_calls_json: null,
    reasoning_json: null,
  });
  assert.deepEqual(
    encodeMessage({ role: "tool", toolCallId: " call-1 ", content: "result" }),
    {
      role: "tool",
      content: "result",
      tool_call_id: " call-1 ",
      tool_calls_json: null,
      reasoning_json: null,
    },
  );
  assert.deepEqual(
    encodeMessage({ role: "assistant", content: "done", toolCalls: [] }),
    {
      role: "assistant",
      content: "done",
      tool_call_id: null,
      tool_calls_json: "[]",
      reasoning_json: null,
    },
  );
});

test("does not share nested references across encode and decode", () => {
  const details = [{ nested: { value: 1 } }];
  const toolCalls = [
    { id: "call-1", name: "calculator", argumentsJson: '{"value":1}' },
  ];
  const source: PersistedMessage = {
    role: "assistant",
    content: "",
    toolCalls,
    reasoning: { providerId: "deepseek", details },
  };
  const row = encodeMessage(source);
  const decoded = decodeMessageRow(row);

  assert.equal(decoded.role, "assistant");
  assert.notStrictEqual(decoded.toolCalls, toolCalls);
  assert.notStrictEqual(decoded.reasoning, source.reasoning);
  assert.notStrictEqual(decoded.reasoning?.details, details);
  assert.notStrictEqual(
    (decoded.reasoning?.details?.[0] as { nested: object }).nested,
    details[0]!.nested,
  );

  toolCalls[0]!.name = "changed";
  details[0]!.nested.value = 2;
  assert.equal(decoded.toolCalls[0]!.name, "calculator");
  assert.deepEqual(decoded.reasoning?.details, [{ nested: { value: 1 } }]);
});

test("reports an uncloneable reasoning detail without leaking its contents", () => {
  const secret = "TOP_SECRET_REASONING_FUNCTION_1942";
  const uncloneable = {
    [secret]: function TOP_SECRET_REASONING_FUNCTION_1942() {
      return "TOP_SECRET_REASONING_FUNCTION_1942";
    },
  }[secret];

  assertSafeCorruption(
    () =>
      encodeMessage({
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: { providerId: "deepseek", details: [uncloneable] },
      }),
    secret,
  );
});

test("rejects inherited tool call fields after Object.prototype pollution", () => {
  withObjectPrototypeProperties(
    {
      id: { configurable: true, value: "inherited-id" },
      name: { configurable: true, value: "inherited-name" },
      argumentsJson: { configurable: true, value: "{}" },
    },
    () => {
      assertCorrupt({
        ...EMPTY_ROW,
        role: "assistant",
        tool_calls_json: "[{}]",
      });
    },
  );
});

test("rejects an inherited reasoning providerId", () => {
  withObjectPrototypeProperties(
    { providerId: { configurable: true, value: "deepseek" } },
    () => {
      assertCorrupt({
        ...EMPTY_ROW,
        role: "assistant",
        reasoning_json: "{}",
      });
    },
  );
});

test("does not execute an encodeMessage role getter", () => {
  const secret = "TOP_SECRET_MESSAGE_GETTER_1942";
  const message = Object.defineProperties(
    {},
    {
      role: {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      },
      content: { enumerable: true, value: "content" },
    },
  );

  assertSafeCorruption(
    () => encodeUnknown(message),
    secret,
  );
});

test("does not execute a tool call field getter", () => {
  const secret = "TOP_SECRET_TOOL_CALL_GETTER_1942";
  const toolCall = Object.defineProperties(
    {},
    {
      id: {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      },
      name: { enumerable: true, value: "calculator" },
      argumentsJson: { enumerable: true, value: "{}" },
    },
  );

  assertSafeCorruption(
    () =>
      encodeUnknown({
        role: "assistant",
        content: "",
        toolCalls: [toolCall],
      }),
    secret,
  );
});

test("does not execute a reasoning providerId getter", () => {
  const secret = "TOP_SECRET_REASONING_GETTER_1942";
  const reasoning = Object.defineProperty({}, "providerId", {
    enumerable: true,
    get() {
      throw new Error(secret);
    },
  });

  assertSafeCorruption(
    () =>
      encodeUnknown({
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning,
      }),
    secret,
  );
});

test("does not execute a row role getter", () => {
  const secret = "TOP_SECRET_ROW_GETTER_1942";
  const row = Object.defineProperties(
    {},
    {
      role: {
        enumerable: true,
        get() {
          throw new Error(secret);
        },
      },
      content: { enumerable: true, value: "content" },
      tool_call_id: { enumerable: true, value: null },
      tool_calls_json: { enumerable: true, value: null },
      reasoning_json: { enumerable: true, value: null },
    },
  );

  assertCorrupt(row, secret);
});

test("contains getPrototypeOf and property-descriptor Proxy traps", () => {
  const prototypeSecret = "TOP_SECRET_PROTOTYPE_TRAP_1942";
  const descriptorSecret = "TOP_SECRET_DESCRIPTOR_TRAP_1942";
  assertCorrupt(
    new Proxy(EMPTY_ROW, {
      getPrototypeOf() {
        throw new Error(prototypeSecret);
      },
    }),
    prototypeSecret,
  );
  assertCorrupt(
    new Proxy(EMPTY_ROW, {
      getOwnPropertyDescriptor() {
        throw new Error(descriptorSecret);
      },
    }),
    descriptorSecret,
  );
});

test("rejects reasoning details that JSON would silently rewrite", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  const sparse = new Array(1);
  const invalidDetails: unknown[][] = [
    [undefined],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    [-0],
    [1n],
    [Symbol("secret")],
    [new Map([["key", "value"]])],
    [new Set(["value"])],
    [new Date("2026-07-17T00:00:00.000Z")],
    [cyclic],
    sparse,
  ];

  for (const details of invalidDetails) {
    assertSafeCorruption(() =>
      encodeMessage({
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: { providerId: "deepseek", details },
      }),
    );
  }
});

test("rejects accessors and symbol keys inside reasoning details without executing them", () => {
  const secret = "TOP_SECRET_DETAIL_GETTER_1942";
  let getterCalls = 0;
  const accessorDetail = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error(secret);
    },
  });
  const symbolDetail = { value: 1 } as Record<PropertyKey, unknown>;
  symbolDetail[Symbol("hidden")] = 2;

  assertSafeCorruption(
    () =>
      encodeMessage({
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: { providerId: "deepseek", details: [accessorDetail] },
      }),
    secret,
  );
  assert.equal(getterCalls, 0);
  assertSafeCorruption(() =>
    encodeMessage({
      role: "assistant",
      content: "",
      toolCalls: [],
      reasoning: { providerId: "deepseek", details: [symbolDetail] },
    }),
  );
});

test("round-trips an own __proto__ reasoning detail without prototype pollution", () => {
  const detail = JSON.parse(
    '{"__proto__":{"polluted":true},"opaque":1}',
  ) as object;
  const decoded = decodeMessageRow(
    encodeMessage({
      role: "assistant",
      content: "",
      toolCalls: [],
      reasoning: { providerId: "deepseek", details: [detail] },
    }),
  );

  assert.equal(decoded.role, "assistant");
  const decodedDetail = decoded.reasoning?.details?.[0] as Record<
    string,
    unknown
  >;
  assert.equal(Object.getPrototypeOf(decodedDetail), Object.prototype);
  assert.equal(Object.hasOwn(decodedDetail, "__proto__"), true);
  assert.deepEqual(decodedDetail.__proto__, { polluted: true });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("does not execute inherited toJSON while preserving an own data key", () => {
  const objectToJson = Object.getOwnPropertyDescriptor(
    Object.prototype,
    "toJSON",
  );
  const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
  let objectCalls = 0;
  let arrayCalls = 0;
  Object.defineProperty(Object.prototype, "toJSON", {
    configurable: true,
    value() {
      objectCalls += 1;
      return { corrupted: "object" };
    },
  });
  Object.defineProperty(Array.prototype, "toJSON", {
    configurable: true,
    value() {
      arrayCalls += 1;
      return ["corrupted-array"];
    },
  });

  try {
    const row = encodeMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "calculator", argumentsJson: "{}" },
      ],
      reasoning: {
        providerId: "deepseek",
        details: [{ toJSON: "kept", opaque: 1 }],
      },
    });

    assert.equal(objectCalls, 0);
    assert.equal(arrayCalls, 0);
    assert.equal(
      row.tool_calls_json,
      '[{"id":"call-1","name":"calculator","argumentsJson":"{}"}]',
    );
    assert.equal(
      row.reasoning_json,
      '{"providerId":"deepseek","details":[{"toJSON":"kept","opaque":1}]}',
    );
  } finally {
    if (objectToJson === undefined) {
      Reflect.deleteProperty(Object.prototype, "toJSON");
    }
    else Object.defineProperty(Object.prototype, "toJSON", objectToJson);
    if (arrayToJson === undefined) {
      Reflect.deleteProperty(Array.prototype, "toJSON");
    }
    else Object.defineProperty(Array.prototype, "toJSON", arrayToJson);
  }
});

test("accepts null assistant JSON columns as empty optional data", () => {
  assert.deepEqual(
    decodeMessageRow({
      ...EMPTY_ROW,
      role: "assistant",
      tool_calls_json: null,
      reasoning_json: null,
    }),
    { role: "assistant", content: "content", toolCalls: [] },
  );
});

test("rejects malformed JSON without echoing its contents", () => {
  const secret = "TOP_SECRET_1942";
  assertCorrupt(
    {
      ...EMPTY_ROW,
      role: "assistant",
      tool_calls_json: `{${secret}`,
    },
    secret,
  );
  assertCorrupt(
    {
      ...EMPTY_ROW,
      role: "assistant",
      reasoning_json: `{${secret}`,
    },
    secret,
  );
});

test("rejects a non-array tool_calls_json value", () => {
  assertCorrupt({
    ...EMPTY_ROW,
    role: "assistant",
    tool_calls_json: '{"id":"call-1"}',
  });
});

test("rejects tool call entries that are not plain objects", () => {
  for (const toolCalls of ["[null]", "[[]]", '["call-1"]']) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "assistant",
      tool_calls_json: toolCalls,
    });
  }
});

test("rejects tool calls with missing fields", () => {
  for (const toolCall of [
    { name: "calculator", argumentsJson: "{}" },
    { id: "call-1", argumentsJson: "{}" },
    { id: "call-1", name: "calculator" },
  ]) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "assistant",
      tool_calls_json: JSON.stringify([toolCall]),
    });
  }
});

test("rejects tool calls with non-string fields", () => {
  for (const toolCall of [
    { id: 1, name: "calculator", argumentsJson: "{}" },
    { id: "call-1", name: null, argumentsJson: "{}" },
    { id: "call-1", name: "calculator", argumentsJson: {} },
  ]) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "assistant",
      tool_calls_json: JSON.stringify([toolCall]),
    });
  }
});

test("rebuilds tool calls without unrecognized properties", () => {
  const decoded = decodeMessageRow({
    ...EMPTY_ROW,
    role: "assistant",
    tool_calls_json:
      '[{"id":"call-1","name":"calculator","argumentsJson":"{}",' +
      '"secret":"do not propagate","__proto__":{"polluted":true}}]',
  });

  assert.equal(decoded.role, "assistant");
  assert.deepEqual(decoded.toolCalls, [
    { id: "call-1", name: "calculator", argumentsJson: "{}" },
  ]);
});

test("rejects reasoning that is not a plain object", () => {
  for (const reasoning of ["null", "[]", '"deepseek"']) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "assistant",
      reasoning_json: reasoning,
    });
  }
});

test("rejects empty or non-string reasoning providerId", () => {
  for (const reasoning of [{ providerId: "" }, { providerId: 42 }, {}]) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "assistant",
      reasoning_json: JSON.stringify(reasoning),
    });
  }
});

test("rejects unsupported reasoning fields", () => {
  assertCorrupt({
    ...EMPTY_ROW,
    role: "assistant",
    reasoning_json: JSON.stringify({ providerId: "deepseek", field: "chain" }),
  });
});

test("rejects non-string reasoning text", () => {
  assertCorrupt({
    ...EMPTY_ROW,
    role: "assistant",
    reasoning_json: JSON.stringify({ providerId: "deepseek", text: 42 }),
  });
});

test("rejects non-array reasoning details", () => {
  assertCorrupt({
    ...EMPTY_ROW,
    role: "assistant",
    reasoning_json: JSON.stringify({
      providerId: "deepseek",
      details: { step: 1 },
    }),
  });
});

test("rebuilds reasoning from allowed fields and deep-clones details", () => {
  const decoded = decodeMessageRow({
    ...EMPTY_ROW,
    role: "assistant",
    reasoning_json:
      '{"providerId":"deepseek","field":"reasoning_text",' +
      '"text":"private","details":[{"nested":{"value":1}}],' +
      '"extra":"discard me","__proto__":{"polluted":true}}',
  });

  assert.equal(decoded.role, "assistant");
  assert.deepEqual(decoded.reasoning, {
    providerId: "deepseek",
    field: "reasoning_text",
    text: "private",
    details: [{ nested: { value: 1 } }],
  });
  assert.equal(Object.hasOwn(decoded.reasoning!, "extra"), false);
  assert.equal(Object.hasOwn(decoded.reasoning!, "__proto__"), false);
});

test("rejects an unknown role without echoing it", () => {
  const secret = "TOP_SECRET_ROLE_1942";
  assertCorrupt({ ...EMPTY_ROW, role: secret }, secret);
});

test("rejects role-specific columns on user rows", () => {
  for (const polluted of [
    { tool_call_id: "call-1" },
    { tool_calls_json: "[]" },
    { reasoning_json: '{"providerId":"deepseek"}' },
  ]) {
    assertCorrupt({ ...EMPTY_ROW, ...polluted });
  }
});

test("rejects role-specific columns on tool rows", () => {
  for (const polluted of [
    { tool_calls_json: "[]" },
    { reasoning_json: '{"providerId":"deepseek"}' },
  ]) {
    assertCorrupt({
      ...EMPTY_ROW,
      role: "tool",
      tool_call_id: "call-1",
      ...polluted,
    });
  }
});

test("rejects a tool_call_id column on assistant rows", () => {
  assertCorrupt({
    ...EMPTY_ROW,
    role: "assistant",
    tool_call_id: "call-1",
    tool_calls_json: "[]",
  });
});

test("rejects null or empty tool call IDs and preserves valid IDs verbatim", () => {
  assertCorrupt({ ...EMPTY_ROW, role: "tool", tool_call_id: null });
  assertCorrupt({ ...EMPTY_ROW, role: "tool", tool_call_id: "" });
  assert.deepEqual(
    decodeMessageRow({ ...EMPTY_ROW, role: "tool", tool_call_id: " call-1 " }),
    { role: "tool", toolCallId: " call-1 ", content: "content" },
  );
});

test("rejects runtime role and content type corruption", () => {
  assertCorrupt({ ...EMPTY_ROW, role: 42 });
  assertCorrupt({ ...EMPTY_ROW, content: null });
});

test("rejects runtime nullable-column type corruption", () => {
  for (const corrupted of [
    { tool_call_id: 42 },
    { tool_calls_json: [] },
    { reasoning_json: { providerId: "deepseek" } },
  ]) {
    assertCorrupt({ ...EMPTY_ROW, ...corrupted });
  }
});
