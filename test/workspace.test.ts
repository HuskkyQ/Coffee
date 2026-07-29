import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveWorkspaceRoot } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test("resolves a Git subdirectory to the repository root", async (t) => {
  const repository = await temporaryDirectory("coffee workspace ");
  t.after(() => rm(repository, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  const nested = path.join(repository, "src", "feature");
  await mkdir(nested, { recursive: true });

  assert.equal(
    await resolveWorkspaceRoot(nested),
    await realpath(repository),
  );
});

test("uses the current real directory when Git discovery fails", async (t) => {
  const directory = await temporaryDirectory("coffee fallback ");
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(
    await resolveWorkspaceRoot(directory, async () => {
      throw new Error("git unavailable");
    }),
    await realpath(directory),
  );
});

test("normalizes a discovered workspace containing spaces", async (t) => {
  const directory = await temporaryDirectory("coffee spaced workspace ");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = path.join(directory, "nested folder");
  await mkdir(nested, { recursive: true });

  assert.equal(
    await resolveWorkspaceRoot(nested, async () => directory),
    await realpath(directory),
  );
});
