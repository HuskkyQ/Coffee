function abortError() {
  return new DOMException("Aborted", "AbortError");
}

globalThis.fetch = async (_input, init) => {
  process.stdout.write("\nHANGING_FETCH_STARTED\n");
  const signal = init?.signal;
  if (signal?.aborted) {
    throw abortError();
  }

  await new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(abortError()), {
      once: true,
    });
  });
  throw new Error("unreachable");
};
