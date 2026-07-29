# Coffee Streaming Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream model output into the Coffee CLI with live Markdown redraw, concise reasoning progress, tool-safe segmentation, Ctrl+C rollback, and transparent fallback for models that do not support streaming.

**Architecture:** Replace the model gateway's complete-response contract with a typed async event stream. Let `Conversation` consume provider events, assemble authoritative messages, run tools, and expose only safe display events; let a dedicated terminal renderer own throttled Markdown redraw and cursor cleanup.

**Tech Stack:** Node.js 22, TypeScript 7, native `fetch`/`ReadableStream`/`TextDecoder`, `string-width`, `@inquirer/core`, Node test runner.

---

## Scope and repository note

Design source: `docs/superpowers/specs/2026-07-15-streaming-output-design.md`.

`/Users/sevan/ai-tasks/pi-agent/coffee` is not a Git repository. Per-task commit steps are intentionally omitted because `git commit` would fail. Every task ends with focused verification, and the final task runs the full suite, type-check, isolated CLI smoke, and residue checks.

## File map

Create:

- `src/models/sse.ts` — decode native `ReadableStream` chunks into complete SSE `data` payloads.
- `src/streaming-markdown-renderer.ts` — own throttled TTY redraw, transient statuses, segment finalization, and cursor cleanup.
- `test/sse.test.ts` — fragmented SSE and UTF-8 parser coverage.
- `test/streaming-markdown-renderer.test.ts` — deterministic TTY/non-TTY rendering coverage.
- `test/streaming-fetch.mjs` — deterministic CLI preload that emits SSE, tool deltas, fallback JSON, errors, and abortable streams.

Modify:

- `src/models/types.ts` — add model stream events and change `ModelGateway` to `stream()`.
- `src/models/openai-completions.ts` — request streaming, parse deltas, assemble replies, and perform guarded fallback.
- `src/agent.ts` — add conversation display events, `stream()`, transactional history, and `send()` compatibility collection.
- `src/cli.ts` — consume conversation events and coordinate renderer/activity output.
- `package.json`, `package-lock.json` — add direct `string-width` dependency.
- `test/openai-completions.test.ts` — adapter stream, tool assembly, fallback, error, and abort tests.
- `test/agent.test.ts` — conversation event order, tool rounds, history commit/rollback, and compatibility tests.
- `test/cli.test.ts` — streamed output, fallback, partial-error, and Ctrl+C black-box tests.
- `README.md` — document default streaming, fallback, concise reasoning statuses, and Ctrl+C semantics.

### Task 1: Introduce typed model stream events without breaking the current gateway

**Files:**

- Modify: `src/models/types.ts`
- Modify: `test/openai-completions.test.ts`
- Modify: `test/agent.test.ts`

- [ ] **Step 1: Add compile-time tests and stream helpers that express the new contract**

Add this helper near the top of `test/agent.test.ts` and use it for new gateway stubs:

```ts
import type {
  ModelReply,
  ModelStreamEvent,
} from "../src/models/types.js";

async function* modelStream(
  events: readonly ModelStreamEvent[],
): AsyncGenerator<ModelStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

function replyEvents(reply: ModelReply): readonly ModelStreamEvent[] {
  return [
    { type: "start" },
    ...(reply.content
      ? [{ type: "text_delta", delta: reply.content } as const]
      : []),
    { type: "done", reply },
  ];
}
```

Add a focused contract test:

```ts
test("represents a model response as typed stream events", async () => {
  const events = replyEvents({ content: "流式完成", toolCalls: [] });
  const received: string[] = [];

  for await (const event of modelStream(events)) {
    received.push(event.type);
  }

  assert.deepEqual(received, ["start", "text_delta", "done"]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="typed stream events" test/agent.test.ts
```

Expected: FAIL because `ModelStreamEvent` is not exported.

- [ ] **Step 3: Define the exact stream contracts**

In `src/models/types.ts`, add:

```ts
export type ModelStreamEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | {
      type: "reasoning_delta";
      field: ModelReasoningField;
      delta: string;
    }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "reasoning_details"; details: readonly unknown[] }
  | { type: "fallback" }
  | { type: "done"; reply: ModelReply };

```

Keep the current `ModelGateway.complete()` for this task so the repository remains green. Task 3 adds a transitional `stream()` method, and Task 5 removes the public `complete()` method after Agent has migrated.

- [ ] **Step 4: Update test gateway factories without changing production Agent behavior yet**

Use `modelStream()` only in the new contract test. Do not migrate existing Agent gateways before `Conversation.stream()` exists.

- [ ] **Step 5: Run the contract-focused tests**

Run:

```bash
node --import tsx --test test/agent.test.ts test/openai-completions.test.ts
npm run check
```

Expected: all existing Agent/adapter tests PASS and TypeScript exits 0.

### Task 2: Build a native, chunk-safe SSE decoder

**Files:**

- Create: `src/models/sse.ts`
- Create: `test/sse.test.ts`

- [ ] **Step 1: Write fragmented SSE tests**

Create `test/sse.test.ts` with a helper that produces a web stream:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { readSseData } from "../src/models/sse.js";

function bodyFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(chunks: readonly string[]): Promise<string[]> {
  const values: string[] = [];
  for await (const value of readSseData(bodyFrom(chunks))) values.push(value);
  return values;
}

test("decodes UTF-8 and SSE records split across arbitrary chunks", async () => {
  assert.deepEqual(
    await collect([
      "data: {\"text\":\"咖",
      "啡\"}\r\n\r\n: ping\r\ndata: [DO",
      "NE]\r\n\r\n",
    ]),
    ['{"text":"咖啡"}', "[DONE]"],
  );
});

test("joins multiple data lines and ignores comments", async () => {
  assert.deepEqual(
    await collect([": heartbeat\n", "data: first\ndata: second\n\n"]),
    ["first\nsecond"],
  );
});
```

Also test a final event at EOF, an empty data event, and a pre-aborted signal.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --import tsx --test test/sse.test.ts
```

Expected: FAIL because `src/models/sse.ts` does not exist.

- [ ] **Step 3: Implement `readSseData()`**

Create `src/models/sse.ts` with this public contract:

```ts
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string>;
```

Implementation rules:

```ts
const decoder = new TextDecoder();
const reader = body.getReader();
let buffer = "";

try {
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    // Normalize CRLF only after decoding, split on one blank SSE line,
    // collect every `data:` line with `\n`, and ignore `:` comments.
    // Preserve an incomplete record in `buffer` for the next read.

    if (done) break;
  }
} finally {
  reader.releaseLock();
}
```

Do not parse JSON here. This module only returns complete `data` payloads so provider validation remains in the adapter.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --import tsx --test test/sse.test.ts
npm run check
```

Expected: all SSE tests PASS and TypeScript exits 0.

### Task 3: Stream text and reasoning from the OpenAI-compatible adapter

**Files:**

- Modify: `src/models/openai-completions.ts`
- Modify: `test/openai-completions.test.ts`

- [ ] **Step 1: Add deterministic streaming response helpers**

In `test/openai-completions.test.ts`, add:

```ts
function sseResponse(payloads: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const payload of payloads) {
          const data = payload === "[DONE]" ? payload : JSON.stringify(payload);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

async function collectModelEvents(
  stream: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
```

Write a test with separate role, reasoning, Chinese text, usage-only, finish, and `[DONE]` chunks. Assert:

```ts
assert.deepEqual(events.map((event) => event.type), [
  "start",
  "reasoning_delta",
  "text_delta",
  "text_delta",
  "done",
]);
const done = events.at(-1);
assert.equal(done?.type, "done");
if (done?.type !== "done") throw new Error("缺少 done 事件");
assert.equal(done.reply.content, "你好");
assert.equal(done.reply.reasoning?.text, "先分析");
```

Assert the outgoing JSON contains `stream: true`, the selected model, replayed messages/tools, and no API Key.

- [ ] **Step 2: Run the focused adapter tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="streams text and reasoning" test/openai-completions.test.ts
```

Expected: FAIL because the adapter still calls `response.json()` and returns a Promise.

- [ ] **Step 3: Split request creation from response parsing**

Keep the existing safe status/error functions. Change the request body helper to:

```ts
function requestBody(
  request: ModelRequest,
  streaming: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: request.messages.map((message) =>
      mapMessage(message, request.model),
    ),
  };
  if (request.tools.length > 0) {
    body.tools = toOpenAICompatibleTools(request.tools);
    body.tool_choice = "auto";
  }
  if (request.model.disableThinking === true) {
    body.thinking = { type: "disabled" };
  }
  if (streaming) body.stream = true;
  return body;
}
```

Add an internal `fetchCompletion(request, streaming)` that preserves Authorization handling, AbortSignal propagation, serialization-before-fetch behavior, and safe network-error mapping. It returns the `Response` even when `response.ok` is false; the caller applies `statusError()` so Task 4 can narrowly inspect 400/422 responses before mapping them.

For the incremental migration, extend `ModelGateway` with both required methods in this task:

```ts
export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelReply>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

The existing `complete()` implementation stays green until Agent migrates in Task 5. It is removed from the public interface and adapter return value at the end of Task 5.

- [ ] **Step 4: Implement the streaming generator**

Change `createOpenAICompletionsGateway()` to return:

```ts
return {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const response = await fetchCompletion(request, true);
    if (!response.ok) throw statusError(request, response.status);
    if (
      !response.headers.get("content-type")?.includes("text/event-stream") ||
      response.body === null
    ) {
      throw invalidResponse(request);
    }
    yield { type: "start" };
    // Consume readSseData(response.body, request.signal).
    // Validate each chunk and append content/reasoning.
    // Require a finish_reason before emitting done.
    yield { type: "done", reply };
  },
};
```

Reuse the current `readReasoning()` semantics for stream deltas: validate every present reasoning field as a string, select the first non-empty field per chunk, accumulate only one signature, deep-clone details, and retain provider metadata in the final reply.

Map AbortError through the existing safe `请求已取消。` error without provider body/cause leakage.

- [ ] **Step 5: Add malformed and interrupted stream tests**

Cover:

- malformed JSON data;
- non-string `delta.content`;
- non-string reasoning fields;
- non-array `reasoning_details`;
- EOF before any `finish_reason`;
- empty/usage-only chunks;
- AbortSignal during `reader.read()`.

Each invalid response must reject with `ModelRequestError.code === "invalid_response"`; cancellation must preserve `name === "AbortError"` and must not expose the raw chunk or API Key.

- [ ] **Step 6: Run focused tests**

Run:

```bash
node --import tsx --test test/sse.test.ts test/openai-completions.test.ts
npm run check
```

Expected: all text/reasoning/invalid-stream tests PASS.

### Task 4: Assemble streamed tool calls and add guarded non-stream fallback

**Files:**

- Modify: `src/models/openai-completions.ts`
- Modify: `test/openai-completions.test.ts`

- [ ] **Step 1: Write tool-call assembly tests**

Stream two tool calls with interleaved indexes. Repeat or change an ID while keeping `index: 0`, and split the function name and JSON arguments across chunks.

Assert emitted deltas retain the stream index and the final reply contains exactly two calls in index order:

```ts
assert.deepEqual(done.reply.toolCalls, [
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
]);
```

Obtain `done` with the same guarded `events.at(-1)` check used in Task 3 before reading `done.reply`.

Add failures for missing final ID/name and invalid assembled JSON.

- [ ] **Step 2: Run the tool tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="streamed tool|tool index" test/openai-completions.test.ts
```

Expected: FAIL because tool deltas are not assembled.

- [ ] **Step 3: Add a stable-index tool accumulator**

Use an internal map:

```ts
interface PartialToolCall {
  index: number;
  id: string;
  name: string;
  argumentsJson: string;
}

const toolCallsByIndex = new Map<number, PartialToolCall>();
```

Create an entry from the first delta for an index. Keep the first non-empty ID, append name/argument fragments in arrival order, emit `tool_call_delta`, and sort by index during finalization. Validate final tool calls with the same strict rules used by complete JSON responses.

- [ ] **Step 4: Write the three fallback tests**

Test these exact cases:

1. A 200 `application/json` complete response: one fetch, events are `start`, `fallback`, one `text_delta`, `done`.
2. A 400 or 422 structured error whose message explicitly says streaming is unsupported: two fetches, second request omits `stream`, and no raw error/API Key appears.
3. An SSE stream emits any model delta and then fails: one fetch only; no fallback and no duplicate delta.

Use a narrow internal matcher equivalent to:

```ts
const streamUnsupported =
  /(?:stream|streaming).*(?:unsupported|not supported|不支持)|(?:unsupported|not supported|不支持).*(?:stream|streaming)/i;
```

Only inspect a bounded structured error string internally. Never include it in the public error.

- [ ] **Step 5: Implement fallback before the first model delta only**

Track `hasModelDelta` for text, reasoning, tool, or details events. A normal 200 JSON response is parsed without a second request. A matched 400/422 response retries once with `streaming: false`. Every other error uses current status mapping.

The fallback path must emit the same authoritative `done.reply` format as SSE and must not execute tools inside the adapter.

- [ ] **Step 6: Run the adapter suite**

Run:

```bash
node --import tsx --test test/openai-completions.test.ts test/model-registry.test.ts
npm run check
```

Expected: all adapter and DeepSeek/OpenCode reasoning replay tests PASS.

### Task 5: Add transactional Conversation streaming

**Files:**

- Modify: `src/agent.ts`
- Modify: `src/models/types.ts`
- Modify: `src/models/openai-completions.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/openai-completions.test.ts`

- [ ] **Step 1: Define and test the public Conversation events**

Add this contract in `src/agent.ts`:

```ts
export type ConversationEvent =
  | { type: "status"; text: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_activity"; event: ToolActivityEvent }
  | { type: "fallback"; text: string }
  | { type: "segment_end" }
  | { type: "done"; content: string };

export interface Conversation {
  stream(
    input: string,
    signal?: AbortSignal,
  ): AsyncIterable<ConversationEvent>;
  send(input: string, signal?: AbortSignal): Promise<string>;
  getModel(): ModelDefinition | undefined;
  setModel(model: ModelDefinition): void;
}
```

Keep `onToolActivity` temporarily during this task so the old CLI remains green while it still calls `send()`. `Conversation.stream()` must yield the new `tool_activity` event and may also call the compatibility callback. Task 7 removes the callback immediately after CLI migrates, leaving the stream event as the final single source.

Write an Agent test whose model yields reasoning, two text deltas, and done. Assert the Conversation yields one `正在分析问题…` status, two text deltas, and done; it must never yield the raw reasoning string.

- [ ] **Step 2: Run the event test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="concise reasoning|conversation events" test/agent.test.ts
```

Expected: FAIL because `Conversation.stream()` does not exist.

- [ ] **Step 3: Implement one streamed model round**

Inside `createConversation`, implement a generator that:

- pins model/key/signal before the first yield;
- forwards `text_delta` unchanged;
- converts the first reasoning delta in a round to one status event;
- converts fallback to the approved Chinese fallback event;
- collects only the final `done.reply` as authoritative;
- throws if the model stream ends without `done`.

Do not append partial deltas directly to global history.

- [ ] **Step 4: Add multi-round tool tests**

Create a stream sequence where round one emits text plus a fragmented tool call, the tool returns success, and round two emits final text. Assert this display order:

```ts
[
  "status",       // reasoning
  "text_delta",   // pre-tool text
  "segment_end",
  "status",       // preparing tool
  "tool_activity",// start
  "tool_activity",// success/error
  "status",       // organizing result
  "text_delta",
  "done",
]
```

Assert the second model request contains the fully assembled assistant tool call, tool result, reasoning replay, the same model/key, and the same AbortSignal.

- [ ] **Step 5: Implement transactional tool rounds**

Keep the existing five-round limit and current `turnStart` rollback boundary. Append a model assistant message only after its `done` event. Execute tools only after all tool arguments are finalized. Yield tool activity events; during this transitional task, also invoke `onToolActivity` only when the compatibility callback is configured. Task 7 removes that callback.

On final valid assistant text, append the final message, yield done, and retain the turn. On error/abort, `messages.splice(turnStart)` before rethrowing.

- [ ] **Step 6: Preserve `send()` as a collector**

Implement:

```ts
async function send(input: string, signal?: AbortSignal): Promise<string> {
  let finalContent: string | undefined;
  for await (const event of stream(input, signal)) {
    if (event.type === "done") finalContent = event.content;
  }
  if (finalContent === undefined) {
    throw new Error("模型流未返回最终正文。");
  }
  return finalContent;
}
```

Keep existing missing-model/key guidance, model-switch history preservation, tool limit, and reasoning isolation tests.

After Agent and adapter tests use `stream()`, remove `complete()` from `ModelGateway` and from the object returned by `createOpenAICompletionsGateway()`. Keep the non-streaming HTTP request as a private adapter helper used only by guarded fallback.

- [ ] **Step 7: Add rollback and abort tests**

Verify that partial text followed by a stream parse error, an unhandled tool AbortError, or direct model AbortError is visible in emitted events but absent from the next request history. A normal tool failure remains a serialized tool result, matching current behavior. Verify `send()` rejects for the exceptional cases and the next successful request starts from the prior committed history.

- [ ] **Step 8: Run Agent tests**

Run:

```bash
node --import tsx --test test/agent.test.ts test/tools.test.ts test/tool-registry.test.ts
npm run check
```

Expected: all Agent, tool, abort, history, and reasoning tests PASS.

### Task 6: Build the throttled streaming Markdown renderer

**Files:**

- Create: `src/streaming-markdown-renderer.ts`
- Create: `test/streaming-markdown-renderer.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install the direct display-width dependency**

Run:

```bash
npm install string-width
```

Expected: `package.json` and `package-lock.json` list `string-width` as a direct runtime dependency; no unrelated package upgrades.

- [ ] **Step 2: Write deterministic renderer tests**

Create a fake output and fake scheduler instead of using real sleeps:

```ts
interface PendingTimer {
  callback: () => void;
  cancelled: boolean;
}

const writes: string[] = [];
const timers: PendingTimer[] = [];
const renderer = createStreamingMarkdownRenderer({
  output: { write: (chunk) => writes.push(String(chunk)) },
  isTTY: true,
  useColor: true,
  columns: 10,
  schedule(callback) {
    const timer = { callback, cancelled: false };
    timers.push(timer);
    return timer;
  },
  cancel(timer) {
    (timer as PendingTimer).cancelled = true;
  },
});
```

Test:

- multiple deltas schedule one 40ms redraw;
- Markdown is re-rendered from the full current buffer;
- CJK and Emoji wrap at terminal width;
- the next frame moves to the prior frame start and clears it;
- `finishSegment()` flushes pending text once and writes a newline;
- `dispose({ preserve: true })` leaves the current text and restores the cursor;
- non-TTY appends plain text with no `\u001b[` control sequences;
- a status is transient and cleared before the first text frame.

- [ ] **Step 3: Run renderer tests and verify RED**

Run:

```bash
node --import tsx --test test/streaming-markdown-renderer.test.ts
```

Expected: FAIL because the renderer module does not exist.

- [ ] **Step 4: Implement the renderer boundary**

Export:

```ts
export interface StreamingMarkdownRenderer {
  showStatus(text: string): void;
  append(delta: string): void;
  finishSegment(): void;
  dispose(options?: { preserve?: boolean }): void;
}

export function createStreamingMarkdownRenderer(
  options: StreamingMarkdownRendererOptions,
): StreamingMarkdownRenderer;
```

Define the options explicitly:

```ts
interface StreamingMarkdownRendererOptions {
  output: { write(chunk: string): unknown };
  isTTY: boolean | undefined;
  useColor: boolean;
  columns: number | undefined;
  prefix: string;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}

interface TimerHandle {
  unref?: () => void;
}
```

Rules:

- `append()` adds raw Markdown and schedules at most one flush 40ms later.
- TTY flush calls existing `renderMarkdown(buffer, useColor)` and redraws the entire current segment.
- Use `string-width` on each rendered line and `columns` to calculate wrapped rows; count an empty line as one row.
- Move to the first prior visual row, clear down, then draw the new frame.
- Hide the cursor only while a live TTY segment/status exists; every terminal path restores it.
- `finishSegment()` flushes synchronously, writes one newline, clears segment state, and never rewrites that segment again.
- `finishSegment()` is a no-op when there is no text segment; if only a transient status exists, it clears that status without adding an empty answer line.
- Non-TTY writes each delta once and never re-renders earlier text.

- [ ] **Step 5: Run renderer and existing format/activity tests**

Run:

```bash
node --import tsx --test \
  test/streaming-markdown-renderer.test.ts \
  test/terminal-format.test.ts \
  test/activity-indicator.test.ts
npm run check
```

Expected: renderer, existing Markdown colors, and coffee animations all PASS.

### Task 7: Integrate streaming events into the CLI

**Files:**

- Create: `test/streaming-fetch.mjs`
- Modify: `src/cli.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Add a deterministic streaming fetch preload**

Create `test/streaming-fetch.mjs`. Select a scenario through `COFFEE_STREAM_TEST_SCENARIO` and replace `globalThis.fetch` with responses for:

- `text`: delayed SSE deltas `"**流"`, `"式**"`, finish, `[DONE]`;
- `tool`: first stream emits a fragmented calculator call, second stream emits final text;
- `fallback-json`: successful complete JSON despite `stream: true`;
- `partial-error`: one text delta then malformed SSE;
- `hang`: one text delta then wait until `init.signal` aborts and reject with `AbortError`.

Write `STREAM_STARTED` to stdout only in the `hang` test scenario so the parent knows the request is active. Never print request headers/body or API Keys.

- [ ] **Step 2: Write CLI black-box tests and verify RED**

Extend the isolated CLI harness so a test can choose `test/no-fetch.mjs`, `test/hanging-fetch.mjs`, or `test/streaming-fetch.mjs`.

Add tests for:

- non-TTY streamed output preserves raw Markdown delta order and contains no cursor-control ANSI;
- fallback prints the approved one-line notice and complete answer;
- a tool segment is finalized before the coffee animation output;
- partial-error leaves partial text visible, prints a safe error, and exits normally after `/exit`;
- SIGINT after `STREAM_STARTED` exits code 0, has no AbortError in stderr, and keeps the partial text.

Run:

```bash
node --import tsx --test --test-name-pattern="stream|fallback|partial" test/cli.test.ts
```

Expected: FAIL because CLI still calls `conversation.send()` and prints once.

- [ ] **Step 3: Create one renderer per active chat turn**

In the chat branch of `src/cli.ts`, replace the `conversation.send()` call with `for await (const event of conversation.stream(...))`.

At the same time, remove `onToolActivity` from `ConversationOptions` and from the `createConversation()` call. This is the point where `tool_activity` becomes the only progress channel, so no duplicate activity is emitted.

Update the former Agent callback assertions to consume `Conversation.stream()` and assert `tool_activity` events. Keep `send()` tests focused only on final returned text and history behavior.

Dispatch events as follows:

```ts
switch (event.type) {
  case "status":
  case "fallback":
    renderer.showStatus(event.text);
    break;
  case "text_delta":
    renderer.append(event.delta);
    break;
  case "segment_end":
    renderer.finishSegment();
    break;
  case "tool_activity":
    renderer.finishSegment();
    activity.handle(event.event);
    break;
  case "done":
    renderer.finishSegment();
    break;
}
```

Do not print `Coffee>` again after done. The renderer owns the assistant prefix and continuation indentation.

- [ ] **Step 4: Make every exit path preserve or finalize correctly**

Use `try/catch/finally` around one chat stream:

- normal completion: `finishSegment()` then dispose;
- provider/tool error: preserve and finalize current text, print safe error on a new line;
- AbortError/global signal: `dispose({ preserve: true })`, return 0, no error line;
- unexpected error before any text: clear transient status, restore cursor, print safe error.

Keep `/login`, `/logout`, `/model`, `/like`, typo blocking, and input dropdown outside the renderer lifecycle.

- [ ] **Step 5: Run CLI and integration tests**

Run:

```bash
node --import tsx --test \
  test/cli.test.ts \
  test/agent.test.ts \
  test/streaming-markdown-renderer.test.ts \
  test/activity-indicator.test.ts
npm run check
```

Expected: all stream, tool animation, Ctrl+C, command, and cursor cleanup tests PASS.

### Task 8: Documentation and final regression

**Files:**

- Modify: `README.md`
- Verify: all `src/**/*.ts`, `test/**/*.ts`, `package.json`, `package-lock.json`

- [ ] **Step 1: Update README without overstating provider verification**

Document:

- responses stream by default;
- interactive terminals redraw colored Markdown;
- non-TTY output is append-only plain text;
- concise progress text is not raw reasoning;
- tool calls split the answer into stable rendered segments;
- unsupported models fall back automatically before any delta;
- Ctrl+C preserves visible partial output but does not save an incomplete turn.

Keep the existing statement that provider tests use fake HTTP responses and real online compatibility has not been verified.

- [ ] **Step 2: Scan for old complete-response coupling and unsafe output**

Run:

```bash
rg -n "gateway\.complete|conversation\.send\(" src test
rg -n "reasoning_delta|reasoning_content|reasoning_details" src/cli.ts src/streaming-markdown-renderer.ts
rg -n "console\.(log|error).*api|Authorization.*console|JSON\.stringify\(.*apiKey" src test
```

Expected:

- no production `gateway.complete` call;
- CLI/renderer contain no raw reasoning payload handling;
- no credential logging;
- `Conversation.send()` appears only as the intentional compatibility API/tests, not in CLI chat handling.

- [ ] **Step 3: Run the full verification suite**

Run:

```bash
npm test
npm run check
```

Expected: every test passes, zero failures, and `tsc --noEmit` exits 0.

- [ ] **Step 4: Run an isolated no-network smoke**

Use a temporary `HOME` and settings path, blank model environment variables, a fake Tavily key, and the streaming preload. Pipe one chat message and `/exit`; assert the final answer is present, exit code is 0, and no auth/settings file is created outside the temporary directory.

Example command shape:

```bash
tmp="$(mktemp -d)"
HOME="$tmp" \
COFFEE_SETTINGS_PATH="$tmp/coffee.settings.json" \
DEEPSEEK_API_KEY="test-model-key" \
OPENCODE_API_KEY="" \
ARK_API_KEY="" \
TAVILY_API_KEY="tvly-test" \
COFFEE_STREAM_TEST_SCENARIO="text" \
node --env-file=.env --import tsx --import ./test/streaming-fetch.mjs src/cli.ts
```

Input:

```text
你好
/exit
```

Expected: code 0, streamed final text visible, no real network, no real credential/config writes.

- [ ] **Step 5: Check process, cursor, and file residue**

Run:

```bash
find . -type d \( -name '*.lock' -o -name '*.stale*' \) -print
pgrep -f 'test/(streaming-fetch|persistence-worker)' || true
```

Expected: no lock/stale directories from tests and no worker/preload process remains.
