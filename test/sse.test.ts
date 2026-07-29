import assert from "node:assert/strict";
import test from "node:test";

import { readSseData } from "../src/models/sse.js";

const encoder = new TextEncoder();

function bodyFrom(
  chunks: readonly (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<string[]> {
  const values: string[] = [];
  for await (const value of readSseData(body, signal)) {
    values.push(value);
  }
  return values;
}

test("decodes split UTF-8 bytes and SSE records across arbitrary chunks", async () => {
  const bytes = encoder.encode('data: {"text":"咖啡"}\n\ndata: 再见\n\n');
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));

  assert.deepEqual(await collect(bodyFrom(chunks)), ['{"text":"咖啡"}', "再见"]);
});

test("accepts LF, CRLF, and mixed line endings", async () => {
  const body = bodyFrom([
    "data: lf\n\n",
    "data: crlf\r\n\r\n",
    "data: mixed-one\r\ndata: mixed-two\n\r\n",
  ]);

  assert.deepEqual(await collect(body), [
    "lf",
    "crlf",
    "mixed-one\nmixed-two",
  ]);
});

test("ignores comments and non-data fields and joins data lines", async () => {
  const body = bodyFrom([
    ": keep-alive\n",
    "event: message\n",
    "id: 7\n",
    "retry: 1000\n",
    "data:first\n",
    "data: second\n\n",
  ]);

  assert.deepEqual(await collect(body), ["first\nsecond"]);
});

test("decodes multiple events from one chunk", async () => {
  assert.deepEqual(
    await collect(bodyFrom(["data: one\n\ndata: two\n\ndata: three\n\n"])),
    ["one", "two", "three"],
  );
});

test("emits the final event at EOF without a trailing blank line", async () => {
  assert.deepEqual(await collect(bodyFrom(["data: final"])), ["final"]);
});

test("emits an empty data event", async () => {
  assert.deepEqual(await collect(bodyFrom(["data:\n\n"])), [""]);
});

test("a pre-aborted signal rejects before reading the body", async () => {
  let readCalled = false;
  const body = {
    getReader() {
      return {
        read() {
          readCalled = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
        cancel() {
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(collect(body, controller.signal), {
    name: "AbortError",
  });
  assert.equal(readCalled, false);
});

test("aborting a pending read rejects and releases the reader", async () => {
  let markPullStarted!: () => void;
  const pullStarted = new Promise<void>((resolve) => {
    markPullStarted = resolve;
  });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      markPullStarted();
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled = true;
    },
  });
  const controller = new AbortController();
  const result = collect(body, controller.signal);

  await pullStarted;
  controller.abort();

  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test("cleanup failures do not replace AbortError from a pending read", async () => {
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let cancelCalled = false;
  let releaseCalled = false;
  const body = {
    getReader() {
      return {
        read(): Promise<ReadableStreamReadResult<Uint8Array>> {
          markReadStarted();
          return new Promise(() => {});
        },
        cancel() {
          cancelCalled = true;
          return Promise.reject(new Error("cancel cleanup failed"));
        },
        releaseLock() {
          releaseCalled = true;
          throw new Error("release cleanup failed");
        },
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
  const controller = new AbortController();
  const result = collect(body, controller.signal);

  await readStarted;
  controller.abort();

  await assert.rejects(result, { name: "AbortError" });
  assert.equal(cancelCalled, true);
  assert.equal(releaseCalled, true);
});
