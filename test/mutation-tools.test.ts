import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMutationTools } from "../src/code-tools/mutation-tools.js";
import {
  atomicCreate,
  atomicReplace,
  captureMutationPathGuard,
  hashFile,
  withMutationQueue,
} from "../src/code-tools/mutation.js";
import type { ToolInteraction } from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

function interaction(allow: boolean): ToolInteraction {
  return {
    async authorizeProtected() { return allow; },
    async confirmMutation() { return allow; },
    async requestSecret() { return undefined; },
  };
}

function tool(
  root: string,
  name: "edit" | "write",
  toolInteraction: ToolInteraction = interaction(true),
) {
  return createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: toolInteraction,
  }).find((candidate) => candidate.definition.name === name)!;
}

test("edit writes only after Diff approval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "const n = 1;\n");

  const denied = await tool(root, "edit", interaction(false)).execute({
    path: "a.ts",
    edits: [{ oldText: "1", newText: "2" }],
  });
  assert.equal(denied.code, "USER_REJECTED");
  assert.equal(await readFile(target, "utf8"), "const n = 1;\n");

  const allowed = await tool(root, "edit").execute({
    path: "a.ts",
    edits: [{ oldText: "1", newText: "2" }],
  });
  assert.deepEqual(allowed, {
    ok: true,
    path: "a.ts",
    changes: 1,
    firstChangedLine: 1,
  });
  assert.equal(await readFile(target, "utf8"), "const n = 2;\n");
});

test("write creates missing parents, allows empty files, and never overwrites", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = tool(root, "write");

  assert.deepEqual(await write.execute({
    path: "src/new/a.ts",
    content: "export {};\n",
  }), { ok: true, path: "src/new/a.ts", created: true });
  assert.equal(
    await readFile(path.join(root, "src/new/a.ts"), "utf8"),
    "export {};\n",
  );
  assert.equal((await write.execute({
    path: "src/new/a.ts",
    content: "overwrite",
  })).code, "EDIT_CONFLICT");
  assert.equal(
    await readFile(path.join(root, "src/new/a.ts"), "utf8"),
    "export {};\n",
  );
  assert.equal((await write.execute({ path: "empty.txt", content: "" })).ok, true);
  assert.equal(await readFile(path.join(root, "empty.txt"), "utf8"), "");
});

test("write rejects private-key content without touching disk", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await tool(root, "write").execute({
    path: "nested/key.pem",
    content: "-----BEGIN PRIVATE KEY-----\nsecret\n",
  });

  assert.equal(result.code, "PATH_DENIED");
  await assert.rejects(lstat(path.join(root, "nested")), /ENOENT/);
});

test("edit detects external changes made while confirmation is pending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "old\n");

  const result = await tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      await writeFile(target, "external\n");
      return true;
    },
    async requestSecret() { return undefined; },
  }).execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });

  assert.equal(result.code, "EDIT_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "external\n");
});

test("mutation helpers hash bounded files, serialize one path, and release after errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.txt");
  await writeFile(target, "abc");
  assert.equal(
    await hashFile(target),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );

  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = withMutationQueue(target, async () => {
    events.push("first-start");
    await gate;
    events.push("first-end");
    throw new Error("expected");
  });
  const second = withMutationQueue(target, async () => {
    events.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await assert.rejects(first, /expected/);
  await second;
  await withMutationQueue(target, async () => events.push("third"));
  assert.deepEqual(events, ["first-start", "first-end", "second", "third"]);
});

test("edit preserves mode bits and protected access precedes Diff approval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "dist", "script.ts");
  await mkdir(path.dirname(target));
  await writeFile(target, "old\n");
  await chmod(target, 0o755);
  const calls: string[] = [];

  const result = await tool(root, "edit", {
    async authorizeProtected() {
      calls.push("access");
      return true;
    },
    async confirmMutation() {
      calls.push("diff");
      return true;
    },
    async requestSecret() { return undefined; },
  }).execute({
    path: "dist/script.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ["access", "diff"]);
  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test("protected rejection and env denial happen before Diff confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "a.ts"), "old\n");
  let confirmations = 0;
  const guarded: ToolInteraction = {
    async authorizeProtected() { return false; },
    async confirmMutation() {
      confirmations += 1;
      return true;
    },
    async requestSecret() { return undefined; },
  };

  assert.equal((await tool(root, "edit", guarded).execute({
    path: "dist/a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  })).code, "USER_REJECTED");
  assert.equal((await tool(root, "write", guarded).execute({
    path: ".env.local",
    content: "SAFE=value\n",
  })).code, "PATH_DENIED");
  assert.equal(confirmations, 0);
});

test("atomic replacement removes unpredictable temp files after rename failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-temp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directoryTarget = path.join(root, "existing-directory");
  await mkdir(directoryTarget);

  await assert.rejects(atomicReplace(directoryTarget, "content", 0o644));
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".coffee-")),
    [],
  );
});

test("custom AbortSignal reasons escape after edit and write confirmation without persistence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const editTarget = path.join(root, "a.ts");
  await writeFile(editTarget, "old\n");
  const editController = new AbortController();
  const editReason = { reason: "stop-edit" };
  const edit = tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      editController.abort(editReason);
      return true;
    },
    async requestSecret() { return undefined; },
  });
  await assert.rejects(
    edit.execute({
      path: "a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    }, editController.signal),
    (error) => error === editReason,
  );
  assert.equal(await readFile(editTarget, "utf8"), "old\n");

  const writeController = new AbortController();
  const writeReason = new Error("stop-write");
  const write = tool(root, "write", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      writeController.abort(writeReason);
      return true;
    },
    async requestSecret() { return undefined; },
  });
  await assert.rejects(
    write.execute({ path: "new.ts", content: "new\n" }, writeController.signal),
    (error) => error === writeReason,
  );
  await assert.rejects(lstat(path.join(root, "new.ts")), /ENOENT/);
});

test("different mutation paths do not block each other", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-parallel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondRan = false;
  const first = withMutationQueue(path.join(root, "a"), async () => await gate);
  const second = withMutationQueue(path.join(root, "b"), async () => {
    secondRan = true;
  });
  await second;
  assert.equal(secondRan, true);
  releaseFirst();
  await first;
});

test("concurrent edits to one path never overlap confirmation windows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-tool-queue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "old\n");
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let confirmations = 0;
  const edit = tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      confirmations += 1;
      if (confirmations === 1) {
        markEntered();
        await gate;
      }
      return true;
    },
    async requestSecret() { return undefined; },
  });
  const first = edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "first" }],
  });
  const second = edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "second" }],
  });
  await entered;
  assert.equal(confirmations, 1);
  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.ok === true).length, 1);
  assert.equal(
    results.filter((result) => result.code === "EDIT_NOT_FOUND").length,
    1,
  );
  assert.match(await readFile(path.join(root, "a.ts"), "utf8"), /^(first|second)\n$/);
});

test("atomicCreate rolls back only directories created by its failed call", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalidName = "invalid\0name";
  await assert.rejects(
    atomicCreate(path.join(root, "created", "nested", invalidName), "content"),
  );
  await assert.rejects(lstat(path.join(root, "created")), /ENOENT/);

  const existing = path.join(root, "existing");
  await mkdir(existing);
  await writeFile(path.join(existing, "keep.txt"), "keep");
  await assert.rejects(
    atomicCreate(path.join(existing, invalidName), "content"),
  );
  assert.equal(await readFile(path.join(existing, "keep.txt"), "utf8"), "keep");
});

test("atomicCreate reports an exclusive-publication conflict without overwriting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.txt");
  await writeFile(target, "existing");

  await assert.rejects(
    atomicCreate(target, "replacement"),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "EDIT_CONFLICT",
  );
  assert.equal(await readFile(target, "utf8"), "existing");
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".coffee-")),
    [],
  );
});

test("parent replacement with an escaping symlink during write confirmation cannot escape", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-parent-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coffee-parent-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const parent = path.join(root, "src");
  await mkdir(parent);
  const write = tool(root, "write", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      await rename(parent, path.join(root, "src-original"));
      await symlink(outside, parent);
      return true;
    },
    async requestSecret() { return undefined; },
  });

  const result = await write.execute({ path: "src/new.ts", content: "new\n" });
  assert.equal(result.code, "EDIT_CONFLICT");
  await assert.rejects(lstat(path.join(outside, "new.ts")), /ENOENT/);
});

test("file and parent identity replacement during edit confirmation produces conflict", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-inode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "src");
  const target = path.join(parent, "a.ts");
  await mkdir(parent);
  await writeFile(target, "old\n", { mode: 0o644 });
  const inodeResult = await tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      const replacement = path.join(parent, "replacement");
      await writeFile(replacement, "old\n", { mode: 0o644 });
      await rename(replacement, target);
      return true;
    },
    async requestSecret() { return undefined; },
  }).execute({
    path: "src/a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });
  assert.equal(inodeResult.code, "EDIT_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "old\n");

  const parentResult = await tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      await rename(parent, path.join(root, "src-original"));
      await symlink(path.join(root, "src-original"), parent);
      return true;
    },
    async requestSecret() { return undefined; },
  }).execute({
    path: "src/a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });
  assert.equal(parentResult.code, "EDIT_CONFLICT");
  assert.equal(await readFile(path.join(root, "src-original", "a.ts"), "utf8"), "old\n");
});

test("mode changes during confirmation produce conflict and preserve content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-mode-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "old\n", { mode: 0o644 });

  const result = await tool(root, "edit", {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      await chmod(target, 0o600);
      return true;
    },
    async requestSecret() { return undefined; },
  }).execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });

  assert.equal(result.code, "EDIT_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "old\n");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("runtime parsing rejects unknown keys and enforces UTF-8 byte limits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.ts"), "old\n");
  const edit = tool(root, "edit");
  const write = tool(root, "write");

  assert.equal((await edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
    surprise: true,
  })).code, "INVALID_ARGUMENT");
  assert.equal((await edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new", surprise: true }],
  })).code, "INVALID_ARGUMENT");
  assert.equal((await write.execute({
    path: "new.ts",
    content: "ok",
    surprise: true,
  })).code, "INVALID_ARGUMENT");
  assert.equal((await write.execute({
    path: "large.txt",
    content: "你".repeat(400_000),
  })).code, "LIMIT_EXCEEDED");
  await assert.rejects(lstat(path.join(root, "large.txt")), /ENOENT/);
});

test("hashFile refuses files above the edit bound", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-hash-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "large.txt");
  await writeFile(target, Buffer.alloc(2 * 1024 * 1024 + 1));

  await assert.rejects(
    hashFile(target),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "LIMIT_EXCEEDED",
  );
});

test("atomicCreate rejects a confirmed ancestor rebound outside the workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-guard-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coffee-guard-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const ancestor = path.join(root, "safe");
  const target = path.join(ancestor, "nested", "escaped.txt");
  await mkdir(ancestor);
  const guard = await captureMutationPathGuard(target, root);
  await rename(ancestor, path.join(root, "safe-original"));
  await symlink(outside, ancestor);

  await assert.rejects(
    atomicCreate(target, "escaped", { workspaceGuard: guard }),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "EDIT_CONFLICT",
  );
  await assert.rejects(lstat(path.join(outside, "nested")), /ENOENT/);
});

test("atomicCreate rejects a new escaping intermediate ancestor after confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-intermediate-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coffee-intermediate-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const confirmedAncestor = path.join(root, "safe");
  const target = path.join(confirmedAncestor, "introduced", "nested", "escaped.txt");
  await mkdir(confirmedAncestor);
  await mkdir(path.join(outside, "nested"));
  const guard = await captureMutationPathGuard(target, root);
  await symlink(outside, path.join(confirmedAncestor, "introduced"));

  await assert.rejects(
    atomicCreate(target, "escaped", { workspaceGuard: guard }),
    (error: unknown) =>
      typeof error === "object" && error !== null &&
      "code" in error && error.code === "EDIT_CONFLICT",
  );
  await assert.rejects(lstat(path.join(outside, "nested", "escaped.txt")), /ENOENT/);
});

test("edit conflicts when an allowed path becomes protected during confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-kind-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "old\n");
  let authorizations = 0;
  let confirmations = 0;
  let protectedNow = false;
  const policy = createWorkspacePolicy(root, {
    isIgnored: async (relativePath) =>
      protectedNow && relativePath === "a.ts",
  });
  const edit = createMutationTools({
    policy,
    interaction: {
    async authorizeProtected() {
      authorizations += 1;
      return true;
    },
    async confirmMutation() {
      confirmations += 1;
      if (confirmations === 1) {
        await writeFile(path.join(root, ".gitignore"), "a.ts\n");
        protectedNow = true;
      }
      return true;
    },
    async requestSecret() { return undefined; },
    },
  }).find((candidate) => candidate.definition.name === "edit")!;

  const first = await edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });
  assert.equal(first.code, "EDIT_CONFLICT");
  assert.equal(authorizations, 0);
  assert.equal(await readFile(target, "utf8"), "old\n");

  const retry = await edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });
  assert.equal(retry.ok, true);
  assert.equal(authorizations, 1);
  assert.equal(await readFile(target, "utf8"), "new\n");
});

test("atomic mutation abort reasons escape before commit without persistence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-atomic-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const replaceTarget = path.join(root, "replace.txt");
  await writeFile(replaceTarget, "original\n");
  const replaceController = new AbortController();
  const replaceReason = { reason: "replace-before-commit" };
  replaceController.abort(replaceReason);

  await assert.rejects(
    atomicReplace(replaceTarget, "replacement\n", 0o644, {
      signal: replaceController.signal,
    }),
    (error) => error === replaceReason,
  );
  assert.equal(await readFile(replaceTarget, "utf8"), "original\n");

  const createController = new AbortController();
  const createReason = new Error("create-before-commit");
  createController.abort(createReason);
  const createTarget = path.join(root, "new", "created.txt");
  await assert.rejects(
    atomicCreate(createTarget, "created\n", {
      signal: createController.signal,
    }),
    (error) => error === createReason,
  );
  await assert.rejects(lstat(path.join(root, "new")), /ENOENT/);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".coffee-")),
    [],
  );
});

test("mutation arguments reject inherited required fields and polluted prototypes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-prototype-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const editTarget = path.join(root, "a.ts");
  await writeFile(editTarget, "old\n");
  const prototype = Object.prototype as Record<string, unknown>;
  prototype.path = "polluted.ts";
  prototype.content = "polluted\n";
  prototype.edits = [{ oldText: "old", newText: "new" }];
  prototype.oldText = "old";
  prototype.newText = "new";
  try {
    const write = tool(root, "write");
    const edit = tool(root, "edit");
    assert.equal((await write.execute({})).code, "INVALID_ARGUMENT");
    assert.equal((await edit.execute({})).code, "INVALID_ARGUMENT");
    assert.equal((await edit.execute({
      path: "a.ts",
      edits: [{}],
    })).code, "INVALID_ARGUMENT");
    const inheritedWrite = Object.create({
      path: "inherited.ts",
      content: "inherited\n",
    }) as Record<string, unknown>;
    assert.equal((await write.execute(inheritedWrite)).code, "INVALID_ARGUMENT");
    await assert.rejects(lstat(path.join(root, "polluted.ts")), /ENOENT/);
    await assert.rejects(lstat(path.join(root, "inherited.ts")), /ENOENT/);
    assert.equal(await readFile(editTarget, "utf8"), "old\n");
  } finally {
    delete prototype.path;
    delete prototype.content;
    delete prototype.edits;
    delete prototype.oldText;
    delete prototype.newText;
  }
});

test("atomic publication persists exact modes and leaves no temporary names", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const created = path.join(root, "created.txt");
  const previousUmask = process.umask(0o077);
  try {
    await atomicCreate(created, "created\n");
  } finally {
    process.umask(previousUmask);
  }
  assert.equal(await readFile(created, "utf8"), "created\n");
  assert.equal((await stat(created)).mode & 0o777, 0o644);

  const replaced = path.join(root, "replaced.txt");
  await writeFile(replaced, "before\n");
  await atomicReplace(replaced, "after\n", 0o751);
  assert.equal(await readFile(replaced, "utf8"), "after\n");
  assert.equal((await stat(replaced)).mode & 0o777, 0o751);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".coffee-")),
    [],
  );
});
