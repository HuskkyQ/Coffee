import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCoffeeEnvironment } from "../src/launcher.js";

test("loads .env from the supplied Coffee application root", async (t) => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "coffee app "));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const loadedPaths: string[] = [];

  loadCoffeeEnvironment(appRoot, (filePath) => {
    loadedPaths.push(filePath);
  });

  assert.deepEqual(loadedPaths, [path.join(appRoot, ".env")]);
});

test("ignores a missing application .env file", () => {
  assert.doesNotThrow(() =>
    loadCoffeeEnvironment("/missing/coffee", () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }),
  );
});

test("preserves non-ENOENT environment loading errors", () => {
  assert.throws(
    () =>
      loadCoffeeEnvironment("/broken/coffee", () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    /permission denied/,
  );
});
