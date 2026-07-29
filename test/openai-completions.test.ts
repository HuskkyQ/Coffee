import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAICompletionsGateway,
  type FetchLike,
} from "../src/models/openai-completions.js";
import { PROVIDERS } from "../src/models/catalog.js";
import {
  ModelRequestError,
  type ModelDefinition,
  type ModelGateway,
  type ModelReply,
  type ModelRequest,
  type ModelStreamEvent,
} from "../src/models/types.js";
import type { ToolDefinition } from "../src/tool-registry.js";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

const model: ModelDefinition = {
  id: "test-model",
  name: "Test Model",
  providerId: "test-provider",
  credentialId: "deepseek",
  api: "openai-completions",
  baseUrl: "https://provider.example/v1/",
};

const openCodeGoModel: ModelDefinition = {
  ...model,
  providerId: "opencode-go",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        const data =
          typeof payload === "string" ? payload : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function cancellableSseResponse(
  payloads: readonly unknown[],
  onCancel: () => void,
  closeBody = false,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        const data =
          typeof payload === "string" ? payload : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      if (closeBody) {
        controller.close();
      }
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

function cancellableJsonResponse(
  bodyValue: unknown,
  onCancel: () => void,
  status = 200,
): Response {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
  Object.defineProperty(response, "json", {
    value: async () => bodyValue,
  });
  return response;
}

async function collectModelEvents(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const collected: ModelStreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

async function streamReply(
  gateway: ModelGateway,
  modelRequest: ModelRequest,
): Promise<ModelReply> {
  let reply: ModelReply | undefined;
  for await (const event of gateway.stream(modelRequest)) {
    if (event.type === "done") {
      reply = event.reply;
    }
  }
  assert.ok(reply, "model stream must yield done");
  return reply;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model,
    apiKey: "secret-key",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...overrides,
  };
}

test("exposes streaming as the only public model gateway operation", () => {
  const gateway = createOpenAICompletionsGateway(async () => sseResponse([]));

  assert.equal("complete" in gateway, false);
  assert.equal(typeof gateway.stream, "function");
});

async function captureBody(
  overrides: Partial<ModelRequest> = {},
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  const gateway = createOpenAICompletionsGateway(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });
  await streamReply(gateway, request(overrides));
  assert.ok(body);
  return body;
}

async function expectModelError(
  promise: Promise<unknown>,
  code: ModelRequestError["code"],
  status?: number,
): Promise<ModelRequestError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ModelRequestError);
  assert.equal(caught.code, code);
  assert.equal(caught.status, status);
  assert.match(caught.message, /test-provider/);
  assert.match(caught.message, /test-model/);
  return caught;
}

async function expectSafeAbort(promise: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.name, "AbortError");
  assert.equal(caught.message, "请求已取消。");
  assert.equal(caught.cause, undefined);
  return caught;
}

test("streams text and reasoning", async () => {
  let body: Record<string, unknown> | undefined;
  const tool: ToolDefinition = {
    name: "search",
    description: "Search",
    inputSchema: { type: "object", properties: {} },
  };
  const gateway = createOpenAICompletionsGateway(async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([
      { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      {
        choices: [
          {
            delta: { reasoning_content: "先思考" },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: { content: "你好，" }, finish_reason: null }] },
      { choices: [{ delta: { content: "世界" }, finish_reason: null }] },
      { choices: [], usage: { completion_tokens: 4 } },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  });

  const events = await collectModelEvents(
    gateway.stream(
      request({
        model: { ...model, disableThinking: true },
        tools: [tool],
      }),
    ),
  );

  assert.deepEqual(events, [
    { type: "start" },
    {
      type: "reasoning_delta",
      field: "reasoning_content",
      delta: "先思考",
    },
    { type: "text_delta", delta: "你好，" },
    { type: "text_delta", delta: "世界" },
    {
      type: "done",
      reply: {
        content: "你好，世界",
        toolCalls: [],
        reasoning: {
          providerId: "test-provider",
          field: "reasoning_content",
          text: "先思考",
        },
      },
    },
  ]);
  assert.ok(body);
  assert.equal(body.stream, true);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "search",
        description: "Search",
        parameters: tool.inputSchema,
      },
    },
  ]);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
});

test("sends streaming authorization and signal without leaking the key into JSON", async () => {
  const captured: CapturedRequest[] = [];
  const signal = new AbortController().signal;
  const gateway = createOpenAICompletionsGateway(async (input, init) => {
    captured.push({ url: String(input), init });
    return sseResponse([
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
  });

  await collectModelEvents(gateway.stream(request({ signal })));

  assert.equal(captured[0]?.url, "https://provider.example/v1/chat/completions");
  assert.equal(captured[0]?.init?.method, "POST");
  assert.equal(captured[0]?.init?.signal, signal);
  const headers = new Headers(captured[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-key");
  const body = JSON.parse(String(captured[0]?.init?.body));
  assert.equal(body.stream, true);
  assert.equal(JSON.stringify(body).includes("secret-key"), false);
});

test("throws streaming serialization errors before invoking fetch", async () => {
  const inputSchema: Record<string, unknown> = { type: "object" };
  inputSchema.self = inputSchema;
  let fetchCalled = false;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalled = true;
    return sseResponse([]);
  });

  await assert.rejects(
    collectModelEvents(
      gateway.stream(
        request({
          tools: [
            {
              name: "circular_tool",
              description: "Circular schema",
              inputSchema,
            },
          ],
        }),
      ),
    ),
    TypeError,
  );
  assert.equal(fetchCalled, false);
});

test("streams reasoning precedence and opaque details", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              reasoning_content: "",
              reasoning: "first",
              reasoning_text: "ignored",
              reasoning_details: [{ type: "opaque", value: 1 }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              reasoning_content: " later",
              reasoning_details: [{ type: "opaque", value: 2 }],
            },
            finish_reason: "stop",
          },
        ],
      },
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    { type: "reasoning_delta", field: "reasoning", delta: "first" },
    {
      type: "reasoning_details",
      details: [{ type: "opaque", value: 1 }],
    },
    {
      type: "reasoning_delta",
      field: "reasoning_content",
      delta: " later",
    },
    {
      type: "reasoning_details",
      details: [{ type: "opaque", value: 2 }],
    },
    {
      type: "done",
      reply: {
        content: undefined,
        toolCalls: [],
        reasoning: {
          providerId: "test-provider",
          field: "reasoning",
          text: "first later",
          details: [
            { type: "opaque", value: 1 },
            { type: "opaque", value: 2 },
          ],
        },
      },
    },
  ]);
});

test("isolates streamed reasoning details from the final reply", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              reasoning_details: [{ type: "opaque", nested: { value: 1 } }],
            },
            finish_reason: "stop",
          },
        ],
      },
      "[DONE]",
    ]),
  );
  const iterator = gateway.stream(request())[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "start" },
  });
  const detailsResult = await iterator.next();
  assert.equal(detailsResult.done, false);
  assert.equal(detailsResult.value?.type, "reasoning_details");
  if (detailsResult.value?.type !== "reasoning_details") {
    assert.fail("expected reasoning_details event");
  }
  const mutableDetails = detailsResult.value.details as Array<{
    nested: { value: number };
  }>;
  mutableDetails[0]!.nested.value = 99;

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: {
      type: "done",
      reply: {
        content: undefined,
        toolCalls: [],
        reasoning: {
          providerId: "test-provider",
          details: [{ type: "opaque", nested: { value: 1 } }],
        },
      },
    },
  });
});

test("preserves explicitly empty streamed reasoning details", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    sseResponse([
      {
        choices: [
          { delta: { reasoning_details: [] }, finish_reason: "stop" },
        ],
      },
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    { type: "reasoning_details", details: [] },
    {
      type: "done",
      reply: {
        content: undefined,
        toolCalls: [],
        reasoning: { providerId: "test-provider", details: [] },
      },
    },
  ]);
});

test("rejects malformed or invalid stream chunks without exposing them", async () => {
  const invalidPayloads: readonly unknown[] = [
    "malformed provider chunk contains secret-key",
    null,
    {},
    { choices: null },
    { choices: [null] },
    { choices: [{ delta: null, finish_reason: null }] },
    { choices: [{ delta: { content: 123 }, finish_reason: null }] },
    {
      choices: [
        {
          delta: { reasoning_content: "valid", reasoning: false },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { delta: { reasoning_details: {} }, finish_reason: null },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 123 }] },
    { choices: [{ delta: { tool_calls: {} }, finish_reason: null }] },
  ];

  for (const payload of invalidPayloads) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([payload, "[DONE]"]),
    );
    const error = await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("malformed provider chunk"), false);
    assert.equal(error.cause, undefined);
  }
});

test("rejects empty or whitespace-only streamed finish reasons without completing", async () => {
  for (const finishReason of ["", " \t\r\n "]) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([
        {
          choices: [{ delta: { content: "partial" }, finish_reason: null }],
        },
        { choices: [{ delta: {}, finish_reason: finishReason }] },
        "[DONE]",
      ]),
    );
    const eventTypes: ModelStreamEvent["type"][] = [];
    let caught: unknown;

    try {
      for await (const event of gateway.stream(request())) {
        eventTypes.push(event.type);
      }
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ModelRequestError);
    assert.equal(caught.code, "invalid_response");
    assert.equal(caught.message.includes("secret-key"), false);
    assert.equal(caught.message.includes("partial"), false);
    assert.equal(caught.cause, undefined);
    assert.deepEqual(eventTypes, ["start", "text_delta"]);
    assert.equal(eventTypes.includes("done"), false);
  }
});

test("rejects missing deltas and null streamed content", async () => {
  const invalidPayloads = [
    { choices: [{ finish_reason: "stop" }] },
    { choices: [{ delta: { content: null }, finish_reason: "stop" }] },
  ];

  for (const payload of invalidPayloads) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([payload, "[DONE]"]),
    );
    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
  }
});

test("strictly validates every streamed reasoning field type", async () => {
  for (const field of [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ] as const) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([
        {
          choices: [
            { delta: { [field]: { secret: "secret-key" } }, finish_reason: null },
          ],
        },
      ]),
    );

    const error = await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.cause, undefined);
  }
});

test("assembles interleaved streamed tool calls by stable tool index", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    sseResponse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: "call-second",
                  function: { name: "calcu", arguments: '{"expression":' },
                },
                {
                  index: 0,
                  id: "",
                  function: { name: "web_", arguments: '{"query":"上海' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-first",
                  function: { name: "search", arguments: '咖啡"}' },
                },
                {
                  index: 1,
                  id: "changed-id-must-not-win",
                  function: { name: "lator", arguments: '"2+2"}' },
                },
              ],
              reasoning_details: [{ type: "opaque", value: 1 }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      "[DONE]",
    ]),
  );

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    {
      type: "tool_call_delta",
      index: 1,
      id: "call-second",
      name: "calcu",
      argumentsDelta: '{"expression":',
    },
    {
      type: "tool_call_delta",
      index: 0,
      id: "",
      name: "web_",
      argumentsDelta: '{"query":"上海',
    },
    {
      type: "tool_call_delta",
      index: 0,
      id: "call-first",
      name: "search",
      argumentsDelta: '咖啡"}',
    },
    {
      type: "tool_call_delta",
      index: 1,
      id: "changed-id-must-not-win",
      name: "lator",
      argumentsDelta: '"2+2"}',
    },
    {
      type: "reasoning_details",
      details: [{ type: "opaque", value: 1 }],
    },
    {
      type: "done",
      reply: {
        content: undefined,
        toolCalls: [
          {
            id: "call-first",
            name: "web_search",
            argumentsJson: '{"query":"上海咖啡"}',
          },
          {
            id: "call-second",
            name: "calculator",
            argumentsJson: '{"expression":"2+2"}',
          },
        ],
        reasoning: {
          providerId: "test-provider",
          details: [{ type: "opaque", value: 1 }],
        },
      },
    },
  ]);
});

test("rejects incomplete or non-object streamed tool arguments", async () => {
  const invalidToolCalls = [
    { index: 0, function: { name: "search", arguments: "{}" } },
    { index: 0, id: "call-1", function: { arguments: "{}" } },
    {
      index: 0,
      id: "call-1",
      function: { name: "search", arguments: "not-json" },
    },
    {
      index: 0,
      id: "call-1",
      function: { name: "search", arguments: "[]" },
    },
    {
      index: 0,
      id: "call-1",
      function: { name: "search", arguments: "null" },
    },
    {
      index: 0,
      id: "call-1",
      function: { name: "search", arguments: '"scalar"' },
    },
  ];

  for (const toolCall of invalidToolCalls) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([
        {
          choices: [
            {
              delta: { tool_calls: [toolCall] },
              finish_reason: "tool_calls",
            },
          ],
        },
        "[DONE]",
      ]),
    );

    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
  }
});

test("rejects unsafe raw JSON tool indexes before number rounding can merge them", async () => {
  for (const rawIndex of ["9007199254740992", "9007199254740993"]) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse([
        `{"choices":[{"delta":{"tool_calls":[{"index":${rawIndex},"id":"call-1","function":{"name":"search","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
        "[DONE]",
      ]),
    );

    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
  }
});

test("requires a finish reason before EOF or DONE", async () => {
  for (const payloads of [
    [{ choices: [{ delta: { content: "partial" }, finish_reason: null }] }],
    [
      { choices: [{ delta: { content: "partial" }, finish_reason: null }] },
      "[DONE]",
    ],
  ] as const) {
    const gateway = createOpenAICompletionsGateway(async () =>
      sseResponse(payloads),
    );

    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
  }
});

test("rejects a missing stream body or wrong content type", async () => {
  const missingBody = new Response("", {
    headers: { "content-type": "text/event-stream" },
  });
  Object.defineProperty(missingBody, "body", { value: null });
  const responses = [missingBody, jsonResponse({ choices: [] })];

  for (const response of responses) {
    const gateway = createOpenAICompletionsGateway(async () => response);
    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "invalid_response",
    );
  }
});

test("accepts a case-insensitive event stream media type with parameters", async () => {
  const source = sseResponse([
    { choices: [{ delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const response = new Response(source.body, {
    headers: { "content-type": "Text/Event-Stream ; charset=utf-8" },
  });
  const gateway = createOpenAICompletionsGateway(async () => response);

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    {
      type: "done",
      reply: { content: undefined, toolCalls: [] },
    },
  ]);
});

test("preserves pending stream cancellation with a safe AbortError", async () => {
  const controller = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>(), {
    headers: { "content-type": "text/event-stream" },
  });
  const gateway = createOpenAICompletionsGateway(async () => response);

  const pending = collectModelEvents(
    gateway.stream(request({ signal: controller.signal })),
  );
  setImmediate(() =>
    controller.abort(abortError("stream abort contains secret-key")),
  );

  const error = await expectSafeAbort(pending);
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.message.includes("stream abort"), false);
});

test("cancels the response body when streaming stops after start", async () => {
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () =>
    cancellableSseResponse([], () => {
      cancelCalls += 1;
    }),
  );
  const iterator = gateway.stream(request())[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "start" },
  });
  assert.ok(iterator.return);
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.equal(cancelCalls, 1);
});

test("cancels the response body when streaming stops after a text delta", async () => {
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () =>
    cancellableSseResponse(
      [
        {
          choices: [
            { delta: { content: "partial" }, finish_reason: null },
          ],
        },
      ],
      () => {
        cancelCalls += 1;
      },
    ),
  );
  const iterator = gateway.stream(request())[Symbol.asyncIterator]();

  await iterator.next();
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "partial" },
  });
  assert.ok(iterator.return);
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.equal(cancelCalls, 1);
});

test("cleanup failures do not replace an early stream return", async () => {
  let cancelCalled = false;
  let releaseCalled = false;
  const response = cancellableSseResponse(
    [
      {
        choices: [
          { delta: { content: "partial" }, finish_reason: null },
        ],
      },
    ],
    () => {},
  );
  assert.ok(response.body);
  const body = response.body;
  const getReader = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", {
    value() {
      const reader = getReader();
      const releaseLock = reader.releaseLock.bind(reader);
      Object.defineProperty(reader, "releaseLock", {
        value() {
          releaseCalled = true;
          releaseLock();
          throw new Error("release cleanup contains secret-key");
        },
      });
      return reader;
    },
  });
  Object.defineProperty(body, "cancel", {
    value: async () => {
      cancelCalled = true;
      throw new Error("cancel cleanup contains secret-key");
    },
  });
  const gateway = createOpenAICompletionsGateway(async () => response);
  const iterator = gateway.stream(request())[Symbol.asyncIterator]();

  await iterator.next();
  await iterator.next();
  assert.ok(iterator.return);
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.equal(releaseCalled, true);
  assert.equal(cancelCalled, true);
});

test("cancels an open response body after DONE", async () => {
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () =>
    cancellableSseResponse(
      [
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ],
      () => {
        cancelCalls += 1;
      },
    ),
  );

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    {
      type: "done",
      reply: { content: undefined, toolCalls: [] },
    },
  ]);
  assert.equal(cancelCalls, 1);
});

test("does not invoke underlying cancel after natural stream EOF", async () => {
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () =>
    cancellableSseResponse(
      [{ choices: [{ delta: {}, finish_reason: "stop" }] }],
      () => {
        cancelCalls += 1;
      },
      true,
    ),
  );

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    {
      type: "done",
      reply: { content: undefined, toolCalls: [] },
    },
  ]);
  assert.equal(cancelCalls, 0);
});

test("uses a successful JSON response as a one-request stream fallback", async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = createOpenAICompletionsGateway(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "fallback answer",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "search", arguments: '{"q":"coffee"}' },
              },
            ],
          },
        },
      ],
    });
  });

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    { type: "fallback" },
    { type: "text_delta", delta: "fallback answer" },
    {
      type: "done",
      reply: {
        content: "fallback answer",
        toolCalls: [
          {
            id: "call-1",
            name: "search",
            argumentsJson: '{"q":"coffee"}',
          },
        ],
      },
    },
  ]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]?.stream, true);
});

test("cancels an open JSON fallback body when the consumer stops after start", async () => {
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () =>
    cancellableJsonResponse(
      {
        choices: [
          { message: { role: "assistant", content: "complete answer" } },
        ],
      },
      () => {
        cancelCalls += 1;
      },
    ),
  );
  const iterator = gateway.stream(request())[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "start" },
  });
  assert.ok(iterator.return);
  assert.deepEqual(await iterator.return(), { done: true, value: undefined });
  assert.equal(cancelCalls, 1);
});

test("cancels custom JSON bodies on both unsupported-stream retry requests", async () => {
  let fetchCalls = 0;
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return cancellableJsonResponse(
        { error: { message: "streaming is not supported" } },
        () => {
          cancelCalls += 1;
        },
        400,
      );
    }
    return cancellableJsonResponse(
      {
        choices: [
          { message: { role: "assistant", content: "complete answer" } },
        ],
      },
      () => {
        cancelCalls += 1;
      },
    );
  });

  await collectModelEvents(gateway.stream(request()));

  assert.equal(fetchCalls, 2);
  assert.equal(cancelCalls, 2);
});

test("cancels a failed non-stream retry response without a third request", async () => {
  let fetchCalls = 0;
  let cancelCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return cancellableJsonResponse(
        { error: { message: "streaming is not supported" } },
        () => {
          cancelCalls += 1;
        },
        422,
      );
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelCalls += 1;
        },
      }),
      { status: 500 },
    );
  });

  await expectModelError(
    collectModelEvents(gateway.stream(request())),
    "server",
    500,
  );
  assert.equal(fetchCalls, 2);
  assert.equal(cancelCalls, 2);
});

test("sanitizes ModelRequestError values thrown by complete-response JSON readers", async () => {
  const createResponse = () => {
    const response = jsonResponse({ choices: [] });
    Object.defineProperty(response, "json", {
      value: async () => {
        throw new ModelRequestError(
          "provider JSON error contains secret-key",
          "auth",
          401,
        );
      },
    });
    return response;
  };

  const completeGateway = createOpenAICompletionsGateway(async () =>
    createResponse(),
  );
  const completeError = await expectModelError(
    streamReply(completeGateway, request()),
    "invalid_response",
  );
  assert.equal(completeError.message.includes("secret-key"), false);
  assert.equal(completeError.message.includes("provider JSON error"), false);

  const streamGateway = createOpenAICompletionsGateway(async () =>
    createResponse(),
  );
  const streamError = await expectModelError(
    collectModelEvents(streamGateway.stream(request())),
    "invalid_response",
  );
  assert.equal(streamError.message.includes("secret-key"), false);
  assert.equal(streamError.message.includes("provider JSON error"), false);
});

test("retries one non-stream request for an explicit structured unsupported-stream error", async () => {
  for (const status of [400, 422]) {
    const bodies: Record<string, unknown>[] = [];
    let fetchCalls = 0;
    const gateway = createOpenAICompletionsGateway(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return jsonResponse(
          {
            error: {
              message: "Streaming is not supported by this endpoint: secret-key",
              code: "unsupported_parameter",
              param: "stream",
            },
          },
          status,
        );
      }
      return jsonResponse({
        choices: [
          { message: { role: "assistant", content: "complete answer" } },
        ],
      });
    });

    const events = await collectModelEvents(gateway.stream(request()));
    assert.deepEqual(events, [
      { type: "start" },
      { type: "fallback" },
      { type: "text_delta", delta: "complete answer" },
      {
        type: "done",
        reply: { content: "complete answer", toolCalls: [] },
      },
    ]);
    assert.equal(fetchCalls, 2);
    assert.equal(bodies[0]?.stream, true);
    assert.equal("stream" in bodies[1]!, false);
    assert.equal(JSON.stringify(events).includes("secret-key"), false);
    assert.equal(JSON.stringify(events).includes("not supported"), false);
  }
});

test("does not retry unrelated or unstructured 400 and 422 errors", async () => {
  const responses = [
    jsonResponse({ error: { message: "quota exhausted" } }, 400),
    jsonResponse({ message: "streaming is not supported" }, 422),
    jsonResponse({ error: "streaming is not supported" }, 400),
  ];

  for (const response of responses) {
    let fetchCalls = 0;
    const gateway = createOpenAICompletionsGateway(async () => {
      fetchCalls += 1;
      return response;
    });

    await expectModelError(
      collectModelEvents(gateway.stream(request())),
      "server",
      response.status,
    );
    assert.equal(fetchCalls, 1);
  }
});

test("does not mistake upstream_error for an unsupported-stream error", async () => {
  let fetchCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalls += 1;
    return jsonResponse(
      {
        error: {
          message: "unsupported request contains secret-key",
          code: "upstream_error",
        },
      },
      400,
    );
  });
  const events: ModelStreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of gateway.stream(request())) {
      events.push(event);
    }
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ModelRequestError);
  assert.equal(caught.code, "server");
  assert.equal(caught.status, 400);
  assert.equal(fetchCalls, 1);
  assert.equal(events.some((event) => event.type === "fallback"), false);
  assert.equal(caught.message.includes("secret-key"), false);
  assert.equal(caught.message.includes("upstream_error"), false);
});

test("does not combine separate stream and unsupported fields to trigger fallback", async () => {
  let fetchCalls = 0;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalls += 1;
    return jsonResponse(
      {
        error: {
          message: "stream request rejected for this model",
          code: "unsupported_model",
        },
      },
      400,
    );
  });
  const events: ModelStreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of gateway.stream(request())) {
      events.push(event);
    }
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ModelRequestError);
  assert.equal(caught.code, "server");
  assert.equal(caught.status, 400);
  assert.equal(fetchCalls, 1);
  assert.equal(events.some((event) => event.type === "fallback"), false);
  assert.equal(caught.message.includes("unsupported_model"), false);
});

test("accepts an exact unsupported-parameter code only with an exact stream param", async () => {
  const bodies: Record<string, unknown>[] = [];
  const gateway = createOpenAICompletionsGateway(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) {
      return jsonResponse(
        {
          error: {
            message: "request rejected",
            code: "unsupported_parameter",
            param: "stream",
          },
        },
        422,
      );
    }
    return jsonResponse({
      choices: [
        { message: { role: "assistant", content: "complete answer" } },
      ],
    });
  });

  assert.deepEqual(await collectModelEvents(gateway.stream(request())), [
    { type: "start" },
    { type: "fallback" },
    { type: "text_delta", delta: "complete answer" },
    {
      type: "done",
      reply: { content: "complete answer", toolCalls: [] },
    },
  ]);
  assert.equal(bodies.length, 2);
  assert.equal("stream" in bodies[1]!, false);
});

test("never retries after an SSE model delta followed by a stream failure", async () => {
  const cases = [
    { delta: { content: "partial" }, expectedType: "text_delta" },
    {
      delta: { reasoning_content: "thinking" },
      expectedType: "reasoning_delta",
    },
    {
      delta: {
        tool_calls: [
          {
            index: 0,
            id: "call-1",
            function: { name: "search", arguments: "{" },
          },
        ],
      },
      expectedType: "tool_call_delta",
    },
    {
      delta: { reasoning_details: [] },
      expectedType: "reasoning_details",
    },
  ];

  for (const { delta, expectedType } of cases) {
    let fetchCalls = 0;
    const gateway = createOpenAICompletionsGateway(async () => {
      fetchCalls += 1;
      return sseResponse([
        { choices: [{ delta, finish_reason: null }] },
        "provider failure contains secret-key",
      ]);
    });
    const events: ModelStreamEvent[] = [];
    let caught: unknown;
    try {
      for await (const event of gateway.stream(request())) {
        events.push(event);
      }
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof ModelRequestError);
    assert.equal(caught.code, "invalid_response");
    assert.equal(fetchCalls, 1);
    assert.deepEqual(
      events.map((event) => event.type),
      ["start", expectedType],
    );
    assert.equal(events.some((event) => event.type === "fallback"), false);
    assert.equal(JSON.stringify(events).includes("secret-key"), false);
    assert.equal(caught.message.includes("secret-key"), false);
  }
});

test("maps stream HTTP and network failures without exposing provider data", async () => {
  const statusCases = [
    { status: 401, code: "auth" },
    { status: 404, code: "model" },
    { status: 429, code: "rate_limit" },
    { status: 500, code: "server" },
  ] as const;
  for (const item of statusCases) {
    const gateway = createOpenAICompletionsGateway(async () =>
      new Response("provider raw body contains secret-key", {
        status: item.status,
      }),
    );
    const error = await expectModelError(
      collectModelEvents(gateway.stream(request())),
      item.code,
      item.status,
    );
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("provider raw body"), false);
  }

  const gateway = createOpenAICompletionsGateway(async () => {
    throw new Error("network cause contains secret-key");
  });
  const error = await expectModelError(
    collectModelEvents(gateway.stream(request())),
    "network",
  );
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.message.includes("network cause"), false);
  assert.equal(error.cause, undefined);
});

test("cancels initial HTTP and MIME failure bodies without replacing their errors", async () => {
  const cases = [
    {
      response: (onCancel: () => void) =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              onCancel();
              throw new Error("500 cleanup contains secret-key");
            },
          }),
          { status: 500 },
        ),
      code: "server" as const,
      status: 500,
    },
    {
      response: (onCancel: () => void) =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              onCancel();
              throw new Error("MIME cleanup contains secret-key");
            },
          }),
          { status: 200, headers: { "content-type": "text/plain" } },
        ),
      code: "invalid_response" as const,
      status: undefined,
    },
  ];

  for (const item of cases) {
    let cancelCalls = 0;
    const gateway = createOpenAICompletionsGateway(async () =>
      item.response(() => {
        cancelCalls += 1;
      }),
    );

    const error = await expectModelError(
      collectModelEvents(gateway.stream(request())),
      item.code,
      item.status,
    );
    assert.equal(cancelCalls, 1);
    assert.equal(error.message.includes("cleanup"), false);
    assert.equal(error.message.includes("secret-key"), false);
  }
});

test("sends a streaming Chat Completions request with the selected model", async () => {
  const captured: CapturedRequest[] = [];
  const signal = new AbortController().signal;
  const gateway = createOpenAICompletionsGateway(async (input, init) => {
    captured.push({ url: String(input), init });
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });

  await streamReply(
    gateway,
    {
      model,
      apiKey: "secret-key",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      signal,
    },
  );

  assert.equal(captured[0]?.url, "https://provider.example/v1/chat/completions");
  assert.equal(captured[0]?.init?.method, "POST");
  assert.equal(captured[0]?.init?.signal, signal);
  const headers = new Headers(captured[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer secret-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(captured[0]?.init?.body));
  assert.equal(body.model, "test-model");
  assert.equal(body.stream, true);
});

test("maps every neutral message role to Chat Completions messages", async () => {
  const body = await captureBody({
    messages: [
      { role: "system", content: "system prompt" },
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: "calling tools",
        toolCalls: [
          { id: "call-1", name: "search", argumentsJson: '{"q":"coffee"}' },
        ],
      },
      { role: "assistant", content: "plain answer", toolCalls: [] },
      { role: "tool", toolCallId: "call-1", content: '{"ok":true}' },
    ],
  });

  assert.deepEqual(body.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: "calling tools",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: '{"q":"coffee"}' },
        },
      ],
    },
    { role: "assistant", content: "plain answer" },
    { role: "tool", tool_call_id: "call-1", content: '{"ok":true}' },
  ]);
});

test("maps neutral tools without leaking internal fields", async () => {
  const tool = {
    name: "dangerous_tool",
    description: "Does a thing",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    riskLevel: "write",
  } as ToolDefinition & { riskLevel: string };

  const body = await captureBody({ tools: [tool] });

  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: {
        name: "dangerous_tool",
        description: "Does a thing",
        parameters: tool.inputSchema,
      },
    },
  ]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(JSON.stringify(body).includes("riskLevel"), false);
});

test("omits tools and tool_choice for an empty tool list", async () => {
  const body = await captureBody({ tools: [] });

  assert.equal("tools" in body, false);
  assert.equal("tool_choice" in body, false);
});

test("disables thinking only when the model requires it", async () => {
  const disabledBody = await captureBody({
    model: { ...model, disableThinking: true },
  });
  const enabledBody = await captureBody({
    model: { ...model, disableThinking: false },
  });
  const unspecifiedBody = await captureBody();

  assert.deepEqual(disabledBody.thinking, { type: "disabled" });
  assert.equal("thinking" in enabledBody, false);
  assert.equal("thinking" in unspecifiedBody, false);
});

test("returns assistant text and ignores valid extra response fields", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    jsonResponse({
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "Coffee reply",
            refusal: null,
            annotations: [],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  );

  assert.deepEqual(await streamReply(gateway, request()), {
    content: "Coffee reply",
    toolCalls: [],
  });
});

test("captures the first non-empty reasoning field and opaque details with provider metadata", async () => {
  const rawDetails = [
    { type: "reasoning.encrypted", id: "call-1", data: { token: "opaque" } },
  ];
  const rawBody = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "",
          reasoning: "first reasoning",
          reasoning_text: "later reasoning",
          reasoning_details: rawDetails,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: "{}" },
            },
          ],
        },
      },
    ],
  };
  const response = jsonResponse({});
  Object.defineProperty(response, "json", { value: async () => rawBody });
  const gateway = createOpenAICompletionsGateway(async () => response);

  const reply = await streamReply(gateway, request());
  assert.deepEqual(reply.reasoning, {
    providerId: "test-provider",
    field: "reasoning",
    text: "first reasoning",
    details: rawDetails,
  });

  rawDetails[0]!.data.token = "mutated";
  assert.deepEqual(reply.reasoning?.details, [
    { type: "reasoning.encrypted", id: "call-1", data: { token: "opaque" } },
  ]);
});

test("strictly validates reasoning response field types", async () => {
  const invalidMessages = [
    { reasoning_content: 123 },
    { reasoning: {} },
    { reasoning_text: false },
    { reasoning_details: {} },
  ];

  for (const invalid of invalidMessages) {
    const gateway = createOpenAICompletionsGateway(async () =>
      jsonResponse({
        choices: [
          { message: { role: "assistant", content: "ok", ...invalid } },
        ],
      }),
    );

    await expectModelError(streamReply(gateway, request()), "invalid_response");
  }
});

test("replays reasoning only to its source provider", async () => {
  const reasoning = {
    providerId: "test-provider",
    field: "reasoning_text" as const,
    text: "provider-private reasoning",
    details: [{ type: "reasoning.encrypted", data: "opaque" }],
  };
  const assistant = {
    role: "assistant" as const,
    content: "",
    toolCalls: [
      { id: "call-1", name: "search", argumentsJson: "{}" },
    ],
    reasoning,
  };

  const sameProviderBody = await captureBody({ messages: [assistant] });
  assert.deepEqual(sameProviderBody.messages, [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "search", arguments: "{}" },
        },
      ],
      reasoning_text: "provider-private reasoning",
      reasoning_details: reasoning.details,
    },
  ]);

  const otherProviderBody = await captureBody({
    model: { ...model, providerId: "other-provider" },
    messages: [assistant],
  });
  assert.equal(JSON.stringify(otherProviderBody).includes("reasoning"), false);
  assert.equal(JSON.stringify(otherProviderBody).includes("opaque"), false);
});

test("normalizes OpenCode Go reasoning replay to reasoning_content", async () => {
  const body = await captureBody({
    model: openCodeGoModel,
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [],
        reasoning: {
          providerId: "opencode-go",
          field: "reasoning",
          text: "think",
        },
      },
    ],
  });

  assert.deepEqual(body.messages, [
    { role: "assistant", content: "", reasoning_content: "think" },
  ]);
});

test("injects empty reasoning_content for every built-in DeepSeek V4 replay", async () => {
  const models = PROVIDERS.flatMap((provider) => provider.models).filter(
    (candidate) => candidate.id.startsWith("deepseek-v4"),
  );
  assert.equal(models.length, 9);

  for (const deepSeekV4Model of models) {
    assert.equal(
      deepSeekV4Model.requiresReasoningContentOnAssistantMessages,
      true,
    );
    const body = await captureBody({
      model: deepSeekV4Model,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "search", argumentsJson: "{}" },
          ],
        },
      ],
    });

    assert.deepEqual(
      (body.messages as Array<Record<string, unknown>>)[0]?.reasoning_content,
      "",
    );
    assert.deepEqual(body.thinking, { type: "disabled" });
  }
});

test("maps multiple assistant tool calls", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "search", arguments: '{"q":"one"}' },
              },
              {
                id: "call-2",
                type: "function",
                function: { name: "calculate", arguments: '{"x":2}' },
              },
            ],
          },
        },
      ],
    }),
  );

  assert.deepEqual(await streamReply(gateway, request()), {
    content: undefined,
    toolCalls: [
      { id: "call-1", name: "search", argumentsJson: '{"q":"one"}' },
      { id: "call-2", name: "calculate", argumentsJson: '{"x":2}' },
    ],
  });
});

test("accepts null or empty assistant content without tool calls", async () => {
  for (const content of [null, ""] as const) {
    const gateway = createOpenAICompletionsGateway(async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content } }] }),
    );

    assert.deepEqual(await streamReply(gateway, request()), {
      content: undefined,
      toolCalls: [],
    });
  }
});

test("rejects invalid assistant content", async () => {
  for (const content of [123, false, [], {}]) {
    const gateway = createOpenAICompletionsGateway(async () =>
      jsonResponse({ choices: [{ message: { role: "assistant", content } }] }),
    );

    await expectModelError(streamReply(gateway, request()), "invalid_response");
  }
});

test("rejects a non-array tool_calls field", async () => {
  for (const toolCalls of [null, {}, "call"] as const) {
    const gateway = createOpenAICompletionsGateway(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: toolCalls,
            },
          },
        ],
      }),
    );

    await expectModelError(streamReply(gateway, request()), "invalid_response");
  }
});

test("strictly validates every tool call", async () => {
  const invalidToolCalls = [
    { id: "", type: "function", function: { name: "search", arguments: "{}" } },
    { id: "call", type: "other", function: { name: "search", arguments: "{}" } },
    { id: "call", type: "function", function: { name: "", arguments: "{}" } },
    { id: "call", type: "function", function: { name: "search", arguments: {} } },
    { id: "call", type: "function", function: null },
  ];

  for (const toolCall of invalidToolCalls) {
    const gateway = createOpenAICompletionsGateway(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [toolCall],
            },
          },
        ],
      }),
    );

    await expectModelError(streamReply(gateway, request()), "invalid_response");
  }
});

test("rejects invalid JSON and invalid choices on successful responses", async () => {
  const responses = [
    new Response("not-json", { status: 200 }),
    jsonResponse({}),
    jsonResponse({ choices: [] }),
    jsonResponse({ choices: [{ message: null }] }),
    jsonResponse({ choices: [{ message: {} }] }),
    jsonResponse({ choices: [{ message: { role: "user", content: "wrong" } }] }),
    jsonResponse({ choices: [{ message: { role: "assistant" } }] }),
  ];

  for (const response of responses) {
    const gateway = createOpenAICompletionsGateway(async () => response);

    await expectModelError(streamReply(gateway, request()), "invalid_response");
  }
});

test("maps non-success statuses without exposing secrets or provider bodies", async () => {
  const cases = [
    { status: 401, code: "auth", message: /\/login/ },
    { status: 403, code: "auth", message: /\/login/ },
    { status: 404, code: "model", message: /套餐/ },
    { status: 429, code: "rate_limit", message: /额度|频率/ },
    { status: 500, code: "server", message: /服务异常.*500/ },
  ] as const;

  for (const item of cases) {
    const gateway = createOpenAICompletionsGateway(async () =>
      new Response("provider raw message includes secret-key", {
        status: item.status,
      }),
    );

    const error = await expectModelError(
      streamReply(gateway, request()),
      item.code,
      item.status,
    );
    assert.match(error.message, item.message);
    assert.equal(error.message.includes("secret-key"), false);
    assert.equal(error.message.includes("provider raw message"), false);
  }
});

test("maps fetch failures to network errors without exposing the cause message", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("socket failed while sending secret-key");
  };
  const gateway = createOpenAICompletionsGateway(fetchImpl);

  const error = await expectModelError(streamReply(gateway, request()), "network");
  assert.equal(error.message.includes("socket failed"), false);
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.cause, undefined);
});

test("safely replaces a ModelRequestError thrown by fetch", async () => {
  const original = new ModelRequestError(
    "provider failure contains secret-key",
    "auth",
    401,
  );
  const gateway = createOpenAICompletionsGateway(async () => {
    throw original;
  });

  const error = await expectModelError(streamReply(gateway, request()), "network");
  assert.notEqual(error, original);
  assert.equal(error.message.includes("provider failure"), false);
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.cause, undefined);
});

test("preserves fetch cancellation with a safe AbortError", async () => {
  const gateway = createOpenAICompletionsGateway(async () => {
    throw abortError("fetch abort contains secret-key");
  });

  const error = await expectSafeAbort(streamReply(gateway, request()));
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.message.includes("fetch abort"), false);
});

test("preserves response JSON cancellation with a safe AbortError", async () => {
  const response = jsonResponse({ choices: [] });
  Object.defineProperty(response, "json", {
    value: async () => {
      throw abortError("parse abort contains secret-key");
    },
  });
  const gateway = createOpenAICompletionsGateway(async () => response);

  const error = await expectSafeAbort(streamReply(gateway, request()));
  assert.equal(error.message.includes("secret-key"), false);
  assert.equal(error.message.includes("parse abort"), false);
});

test("throws request serialization errors before invoking fetch", async () => {
  const inputSchema: Record<string, unknown> = { type: "object" };
  inputSchema.self = inputSchema;
  let fetchCalled = false;
  const gateway = createOpenAICompletionsGateway(async () => {
    fetchCalled = true;
    return jsonResponse({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  });

  await assert.rejects(
    streamReply(
      gateway,
      request({
        tools: [
          {
            name: "circular_tool",
            description: "Circular schema",
            inputSchema,
          },
        ],
      }),
    ),
    TypeError,
  );
  assert.equal(fetchCalled, false);
});
