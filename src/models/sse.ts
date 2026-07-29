function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) {
    return reader.read();
  }
  if (signal.aborted) {
    throw abortError(signal);
  }

  let handledAbort = false;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (handledAbort) {
        return;
      }
      handledAbort = true;
      reject(abortError(signal));
      try {
        void reader.cancel().catch(() => {});
      } catch {
        // Cancellation cleanup must not replace the AbortError.
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });

  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function* readSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) {
    throw abortError(signal);
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let hasData = false;

  function processLine(line: string): string | undefined {
    if (line === "") {
      if (!hasData) {
        return undefined;
      }
      const data = dataLines.join("\n");
      dataLines = [];
      hasData = false;
      return data;
    }
    if (line.startsWith(":")) {
      return undefined;
    }
    if (line.startsWith("data:")) {
      let data = line.slice(5);
      if (data.startsWith(" ")) {
        data = data.slice(1);
      }
      dataLines.push(data);
      hasData = true;
    }
    return undefined;
  }

  function* processCompleteLines(): Generator<string> {
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      const data = processLine(line);
      if (data !== undefined) {
        yield data;
      }
      newline = buffer.indexOf("\n");
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      const { done, value } = await readWithAbort(reader, signal);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      yield* processCompleteLines();
    }

    buffer += decoder.decode();
    yield* processCompleteLines();
    if (buffer !== "") {
      const data = processLine(buffer);
      if (data !== undefined) {
        yield data;
      }
    }
    const finalData = processLine("");
    if (finalData !== undefined) {
      yield finalData;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader cleanup must not replace the primary stream error.
    }
  }
}
