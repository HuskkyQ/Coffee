import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { CodeToolError } from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

async function expectDenied(
  operation: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof CodeToolError);
    assert.equal(error.code, "PATH_DENIED");
    assert.match(error.message, message);
    return true;
  });
}

test("classifies normal, environment, and protected workspace paths", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await mkdir(path.join(root, "node_modules"));

  const policy = createWorkspacePolicy(path.join(root, "."), {
    isIgnored: async () => false,
  });

  assert.equal(policy.root, path.resolve(root));
  assert.deepEqual(await policy.resolve("src/a.ts", "read"), {
    absolutePath: await realpath(path.join(root, "src", "a.ts")),
    relativePath: "src/a.ts",
    exists: true,
    kind: "allowed",
  });
  assert.equal((await policy.resolve(".env", "read")).kind, "env");
  assert.equal(
    (await policy.resolve("node_modules/.env.local", "read")).kind,
    "env",
  );
  assert.equal(
    (await policy.resolve("node_modules/package.json", "read")).kind,
    "protected",
  );
  assert.equal((await policy.resolve(".", "read")).relativePath, ".");
});

test("classifies custom ignored writes and .gitignore as protected", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");

  const policy = createWorkspacePolicy(root, {
    isIgnored: async (relativePath) => relativePath === "ignored.txt",
  });

  const ignored = await policy.resolve("ignored.txt", "write");
  assert.equal(ignored.kind, "protected");
  assert.match(ignored.protectedReason ?? "", /ignore/i);
  assert.equal((await policy.resolve(".gitignore", "read")).kind, "protected");
});

test("uses git check-ignore as the default ignore policy", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");

  const resolved = await createWorkspacePolicy(root).resolve(
    "ignored.txt",
    "read",
  );

  assert.equal(resolved.kind, "protected");
  assert.match(resolved.protectedReason ?? "", /ignore/i);
});

test("rejects invalid and logically escaping paths", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  for (const requestedPath of ["", "   ", undefined, null, 1]) {
    await assert.rejects(
      policy.resolve(requestedPath as string, "read"),
      (error) => {
        assert.ok(error instanceof CodeToolError);
        assert.equal(error.code, "INVALID_ARGUMENT");
        assert.equal(error.message, "path 必须是非空字符串。");
        return true;
      },
    );
  }
  await expectDenied(policy.resolve("../outside", "read"), /工作区之外/);
});

test("rejects .git at any depth", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  await expectDenied(policy.resolve(".git/config", "read"), /\.git/);
  await expectDenied(policy.resolve("nested/.git/config", "read"), /\.git/);
});

test("rejects reads whose symlink target escapes the workspace", async (t) => {
  const parent = await temporaryDirectory("coffee-policy-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "file.txt"), "outside\n");
  await symlink(outside, path.join(root, "escape"));

  await expectDenied(
    createWorkspacePolicy(root, { isIgnored: async () => false }).resolve(
      "escape/file.txt",
      "read",
    ),
    /符号链接/,
  );
});

test("allows new deep writes but rejects an existing symlink component", async (t) => {
  const parent = await temporaryDirectory("coffee-policy-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside");
  await mkdir(path.join(root, "real"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, path.join(root, "linked"));
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  assert.deepEqual(await policy.resolve("real/new/deep/file.ts", "write"), {
    absolutePath: path.join(
      await realpath(path.join(root, "real")),
      "new",
      "deep",
      "file.ts",
    ),
    relativePath: "real/new/deep/file.ts",
    exists: false,
    kind: "allowed",
  });
  await expectDenied(policy.resolve("linked/file.ts", "write"), /符号链接/);
});

test("does not confuse a sibling with a matching workspace prefix", async (t) => {
  const parent = await temporaryDirectory("coffee-policy-parent-");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const sibling = path.join(parent, "workspace-other");
  await mkdir(root);
  await mkdir(sibling);

  await expectDenied(
    createWorkspacePolicy(root, { isIgnored: async () => false }).resolve(
      path.join(sibling, "file.txt"),
      "read",
    ),
    /工作区之外/,
  );
});

test("read follows an internal symlink while write rejects the same path", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "real"));
  await writeFile(path.join(root, "real", "file.txt"), "inside\n");
  await symlink(path.join(root, "real"), path.join(root, "linked"));
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  const readPath = await policy.resolve("linked/file.txt", "read");
  assert.equal(readPath.exists, true);
  assert.equal(readPath.relativePath, "linked/file.txt");
  assert.equal(
    readPath.absolutePath,
    await realpath(path.join(root, "real", "file.txt")),
  );
  assert.equal(readPath.kind, "allowed");
  await expectDenied(policy.resolve("linked/file.txt", "write"), /符号链接/);
});

test("classifies internal symlink aliases by their effective targets", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await writeFile(path.join(root, ".git", "config"), "[core]\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  await symlink(path.join(root, ".env"), path.join(root, "public-env"));
  await symlink(path.join(root, ".git"), path.join(root, "public-git"));
  await symlink(
    path.join(root, "node_modules"),
    path.join(root, "public-deps"),
  );
  await symlink(
    path.join(root, "ignored.txt"),
    path.join(root, "public-ignored"),
  );
  const ignoredChecks: string[] = [];
  const policy = createWorkspacePolicy(root, {
    isIgnored: async (relativePath) => {
      ignoredChecks.push(relativePath);
      return relativePath === "ignored.txt";
    },
  });

  await t.test("environment target", async () => {
    assert.equal((await policy.resolve("public-env", "read")).kind, "env");
  });
  await t.test("git target", async () => {
    await expectDenied(policy.resolve("public-git/config", "read"), /\.git/);
  });
  await t.test("protected target with a missing suffix", async () => {
    assert.equal(
      (await policy.resolve("public-deps/missing/package.json", "read")).kind,
      "protected",
    );
  });
  await t.test("ignored target", async () => {
    assert.equal(
      (await policy.resolve("public-ignored", "read")).kind,
      "protected",
    );
    assert.deepEqual(
      ignoredChecks.slice(-2),
      ["public-ignored", "ignored.txt"],
    );
  });
});

test("matches security path segments with ASCII case normalization", async (t) => {
  const root = await temporaryDirectory("coffee-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".GIT"));
  await mkdir(path.join(root, "NODE_MODULES"));
  await writeFile(path.join(root, ".ENV"), "TOKEN=secret\n");
  await writeFile(path.join(root, ".GIT", "config"), "[core]\n");
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  await t.test("environment path", async () => {
    assert.equal((await policy.resolve(".ENV", "read")).kind, "env");
  });
  await t.test("git path", async () => {
    await expectDenied(policy.resolve(".GIT/config", "read"), /\.git/i);
  });
  await t.test("protected path", async () => {
    assert.equal(
      (await policy.resolve("NODE_MODULES/package.json", "read")).kind,
      "protected",
    );
  });
});
