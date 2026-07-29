# Coffee Safe Code Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Add Pi-style read/search/edit/write tools to Coffee while enforcing workspace containment, local Diff approval, and secret-safe dotenv updates.

**Architecture:** A shared WorkspacePolicy classifies every requested path before focused read, search, mutation, or dotenv modules touch the filesystem. Mutating tools prepare a complete candidate, pause the CLI activity renderer, ask a local ToolInteraction for approval, revalidate the target hash, and only then write. Existing model adapters continue to receive provider-neutral tool definitions and JSON results.

**Tech Stack:** TypeScript 7, Node.js 22 native filesystem/process APIs, ripgrep with shell disabled, diff 8.0.4, node:test, existing @inquirer/core input and ANSI rendering.

---

## Scope and repository note

The approved design is:

- [Design spec](../specs/2026-07-17-coffee-code-tools-design.md)
- Six Pi-style tools: ls, find, grep, read, edit, write
- One Coffee-only tool: set_env
- No bash, delete, rename, automatic test execution, or full-screen TUI

The current Coffee directory is not a Git repository. Do not initialize Git as part of this plan. Each task therefore ends with a verification checkpoint instead of a commit. If the user later places Coffee in a repository, commit each green task separately.

## File map

**Create:**

- src/code-tools/types.ts — shared limits, errors, ToolInteraction contracts, and structured failure conversion.
- src/code-tools/workspace-policy.ts — canonical path resolution and denied/protected/env classification.
- src/code-tools/text-files.ts — UTF-8/BOM/line-ending inspection, truncation, and sensitive-file detection.
- src/code-tools/read-tools.ts — ls and read definitions and execution.
- src/code-tools/search-tools.ts — controlled ripgrep runner plus find and grep definitions.
- src/code-tools/edit-diff.ts — exact multi-edit application, overlap checks, unified patch generation, and preview limits.
- src/code-tools/mutation.ts — hashes, per-path queues, atomic replacement, and exclusive new-file creation.
- src/code-tools/mutation-tools.ts — edit/write preparation, approval, conflict detection, serialization, and safe persistence.
- src/code-tools/env-tool.ts — dotenv structure inspection and set_env mutation.
- src/code-tools/index.ts — builds the seven code tool registrations from one dependency bundle.
- src/tool-interaction.ts — inline colored Diff, protected-path confirmation, and hidden secret prompt.
- test/code-tool-types.test.ts
- test/workspace-policy.test.ts
- test/text-file-tools.test.ts
- test/search-tools.test.ts
- test/edit-diff.test.ts
- test/mutation-tools.test.ts
- test/env-tool.test.ts
- test/tool-interaction.test.ts

**Modify:**

- package.json and package-lock.json — add diff 8.0.4.
- src/activity-indicator.ts — pause an active animation while retaining completion state.
- src/chat-input.ts — expose whether input is interactive.
- src/tools.ts — append code tools to the existing provider-neutral registry.
- src/agent.ts — accept ToolInteraction, expose workspace tools, and update the system prompt.
- src/cli.ts — construct local interaction callbacks and pass them into Conversation.
- src/terminal-format.ts — export small color helpers used by Diff rendering.
- README.md — document workspace limits and the approval flow.
- Existing tests named in later tasks — assert integration and regression behavior.

### Task 1: Add the shared code-tool contract

**Files:**

- Create: src/code-tools/types.ts
- Create: test/code-tool-types.test.ts
- Modify: package.json
- Modify: package-lock.json

- [ ] **Step 1: Write the failing contract test**

Create test/code-tool-types.test.ts:

~~~typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  executeCodeTool,
} from "../src/code-tools/types.js";

test("default interaction denies every operation without asking for secrets", async () => {
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.authorizeProtected({
      operation: "read",
      path: "dist/output.txt",
      reason: "ignored",
    }),
    false,
  );
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.confirmMutation({
      kind: "edit",
      path: "src/a.ts",
      patch: "patch",
      changedLines: 1,
    }),
    false,
  );
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.requestSecret({
      path: ".env",
      key: "TOKEN",
    }),
    undefined,
  );
});

test("expected code-tool errors become structured failures", async () => {
  assert.deepEqual(
    await executeCodeTool(async () => {
      throw new CodeToolError("PATH_DENIED", "路径不可访问。");
    }),
    { ok: false, code: "PATH_DENIED", error: "路径不可访问。" },
  );
});

test("AbortError still escapes the code-tool boundary", async () => {
  const error = new DOMException("Aborted", "AbortError");
  await assert.rejects(
    executeCodeTool(async () => {
      throw error;
    }),
    (received) => received === error,
  );
});

test("unexpected execution errors receive a stable code", async () => {
  assert.deepEqual(
    await executeCodeTool(async () => {
      throw new Error("disk failure");
    }),
    { ok: false, code: "EXECUTION_FAILED", error: "disk failure" },
  );
});
~~~

- [ ] **Step 2: Run the test and verify the missing module failure**

Run:

~~~bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
node --import tsx --test test/code-tool-types.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND for src/code-tools/types.js.

- [ ] **Step 3: Install the exact Diff dependency**

Run:

~~~bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm install diff@8.0.4
~~~

Expected: package.json and package-lock.json record diff 8.0.4 and npm exits 0.

- [ ] **Step 4: Create the shared types and error boundary**

Create src/code-tools/types.ts:

~~~typescript
export const READ_MAX_LINES = 2_000;
export const OUTPUT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_LINE_LENGTH = 500;
export const FIND_MAX_RESULTS = 1_000;
export const LS_MAX_ENTRIES = 500;
export const EDIT_MAX_REPLACEMENTS = 20;
export const EDIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const WRITE_MAX_FILE_BYTES = 1024 * 1024;
export const DIFF_MAX_LINES = 200;
export const DIFF_MAX_BYTES = 50 * 1024;

export type CodeToolErrorCode =
  | "INVALID_ARGUMENT"
  | "PATH_DENIED"
  | "PATH_PROTECTED"
  | "USER_REJECTED"
  | "NOT_FOUND"
  | "NOT_TEXT"
  | "LIMIT_EXCEEDED"
  | "EDIT_NOT_FOUND"
  | "EDIT_NOT_UNIQUE"
  | "EDIT_OVERLAP"
  | "EDIT_NO_CHANGE"
  | "EDIT_CONFLICT"
  | "RG_UNAVAILABLE"
  | "EXECUTION_FAILED";

export class CodeToolError extends Error {
  constructor(
    readonly code: CodeToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeToolError";
  }
}

export interface ProtectedAccessRequest {
  operation: "read" | "write";
  path: string;
  reason: string;
}

export interface MutationPreview {
  kind: "edit" | "write" | "set_env";
  path: string;
  patch: string;
  changedLines: number;
}

export interface SecretRequest {
  path: string;
  key: string;
}

export interface ToolInteraction {
  authorizeProtected(
    request: ProtectedAccessRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  confirmMutation(
    preview: MutationPreview,
    signal?: AbortSignal,
  ): Promise<boolean>;
  requestSecret(
    request: SecretRequest,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

export const DEFAULT_TOOL_INTERACTION: ToolInteraction = {
  async authorizeProtected() {
    return false;
  },
  async confirmMutation() {
    return false;
  },
  async requestSecret() {
    return undefined;
  },
};

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export async function executeCodeTool(
  operation: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    return await operation();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof CodeToolError) {
      return { ok: false, code: error.code, error: error.message };
    }
    return {
      ok: false,
      code: "EXECUTION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
~~~

- [ ] **Step 5: Run the focused test and type check**

Run:

~~~bash
node --import tsx --test test/code-tool-types.test.ts
npm run check
~~~

Expected: the focused test passes and TypeScript exits 0.

### Task 2: Enforce one workspace policy for every path

**Files:**

- Create: src/code-tools/workspace-policy.ts
- Create: test/workspace-policy.test.ts

- [ ] **Step 1: Write path-classification tests**

Create test/workspace-policy.test.ts with temporary directories covering allowed, protected, env, denied, and symlink paths:

~~~typescript
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

test("classifies workspace paths and blocks escapes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-policy-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coffee-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  await symlink(outside, path.join(root, "escape"));

  const policy = createWorkspacePolicy(root, {
    isIgnored: async (relativePath) => relativePath === "ignored.txt",
  });

  assert.equal((await policy.resolve("src/a.ts", "read")).kind, "allowed");
  assert.equal((await policy.resolve(".env", "read")).kind, "env");
  assert.equal(
    (await policy.resolve("node_modules", "read")).kind,
    "protected",
  );
  assert.equal(
    (await policy.resolve("ignored.txt", "write")).kind,
    "protected",
  );
  await assert.rejects(policy.resolve("../outside", "read"), /工作区之外/);
  await assert.rejects(policy.resolve(".git/config", "read"), /\.git/);
  await assert.rejects(policy.resolve("escape/file.txt", "read"), /符号链接/);
});

test("write paths reject symlink components and validate a real parent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-policy-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "real"));
  await symlink(path.join(root, "real"), path.join(root, "linked"));
  const policy = createWorkspacePolicy(root);

  const target = await policy.resolve("real/new/deep/file.ts", "write");
  assert.equal(target.exists, false);
  assert.equal(target.relativePath, "real/new/deep/file.ts");
  await assert.rejects(
    policy.resolve("linked/file.ts", "write"),
    /符号链接/,
  );
});
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run:

~~~bash
node --import tsx --test test/workspace-policy.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement canonical resolution and classification**

Create src/code-tools/workspace-policy.ts. Use path.relative for containment; never use string prefix matching:

~~~typescript
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CodeToolError } from "./types.js";

const execFileAsync = promisify(execFile);
const PROTECTED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  "cache",
  "generated",
]);

export type WorkspacePathKind = "allowed" | "protected" | "env";
export type WorkspaceOperation = "read" | "write";

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  kind: WorkspacePathKind;
  protectedReason?: string;
}

export interface WorkspacePolicy {
  root: string;
  resolve(
    requestedPath: string,
    operation: WorkspaceOperation,
  ): Promise<ResolvedWorkspacePath>;
}

interface PolicyOptions {
  isIgnored?: (relativePath: string) => Promise<boolean>;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative));
}

function relativePosix(root: string, candidate: string): string {
  const value = path.relative(root, candidate).split(path.sep).join("/");
  return value || ".";
}

function isEnvPath(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.startsWith(".env"));
}

async function defaultIsIgnored(
  root: string,
  relativePath: string,
): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["check-ignore", "--no-index", "--quiet", "--", relativePath],
      { cwd: root },
    );
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertNoSymlinkBetween(
  root: string,
  candidate: string,
): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new CodeToolError(
          "PATH_DENIED",
          "变更路径不能包含符号链接。",
        );
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }
  }
}

export function createWorkspacePolicy(
  workspaceRoot: string,
  options: PolicyOptions = {},
): WorkspacePolicy {
  const root = path.resolve(workspaceRoot);
  const isIgnored = options.isIgnored ??
    ((relativePath) => defaultIsIgnored(root, relativePath));

  return {
    root,
    async resolve(requestedPath, operation) {
      if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
        throw new CodeToolError("INVALID_ARGUMENT", "path 必须是非空字符串。");
      }
      const candidate = path.resolve(root, requestedPath);
      if (!isInside(root, candidate)) {
        throw new CodeToolError("PATH_DENIED", "路径位于工作区之外。");
      }
      const relativePath = relativePosix(root, candidate);
      const segments = relativePath.split("/");
      if (segments.includes(".git")) {
        throw new CodeToolError("PATH_DENIED", "禁止访问 .git 目录。");
      }

      const existing = await nearestExistingPath(candidate);
      const realExisting = await realpath(existing);
      if (!isInside(root, realExisting)) {
        throw new CodeToolError(
          "PATH_DENIED",
          "路径通过符号链接逃逸到工作区之外。",
        );
      }
      if (operation === "write") {
        await assertNoSymlinkBetween(root, candidate);
      }

      let exists = true;
      try {
        await lstat(candidate);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          exists = false;
        } else {
          throw error;
        }
      }

      if (isEnvPath(relativePath)) {
        return { absolutePath: candidate, relativePath, exists, kind: "env" };
      }
      const protectedSegment = segments.find((segment) =>
        PROTECTED_SEGMENTS.has(segment)
      );
      const protectedReason = protectedSegment
        ? "受保护目录 " + protectedSegment
        : path.basename(candidate) === ".gitignore"
          ? "忽略规则文件"
          : await isIgnored(relativePath)
            ? "仓库忽略规则"
            : undefined;
      return {
        absolutePath: candidate,
        relativePath,
        exists,
        kind: protectedReason ? "protected" : "allowed",
        ...(protectedReason === undefined ? {} : { protectedReason }),
      };
    },
  };
}
~~~

- [ ] **Step 4: Run focused tests and type check**

Run:

~~~bash
node --import tsx --test test/workspace-policy.test.ts
npm run check
~~~

Expected: all workspace-policy tests pass and TypeScript exits 0.

- [ ] **Step 5: Add regression cases for prefix collision and internal symlinks**

Append to test/workspace-policy.test.ts:

~~~typescript
test("does not confuse a sibling path prefix with workspace containment", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coffee-prefix-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const sibling = path.join(parent, "workspace-other");
  await mkdir(root);
  await mkdir(sibling);
  const policy = createWorkspacePolicy(root);

  await assert.rejects(policy.resolve(sibling, "read"), /工作区之外/);
});

test("allows a read symlink when its real target remains in the workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-inner-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "real.txt"), "safe\n");
  await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  const policy = createWorkspacePolicy(root);

  assert.equal((await policy.resolve("link.txt", "read")).kind, "allowed");
  await assert.rejects(policy.resolve("link.txt", "write"), /符号链接/);
});
~~~

Run:

~~~bash
node --import tsx --test test/workspace-policy.test.ts
~~~

Expected: both regressions pass.

### Task 3: Add text inspection, ls, and read

**Files:**

- Create: src/code-tools/text-files.ts
- Create: src/code-tools/read-tools.ts
- Create: test/text-file-tools.test.ts

- [ ] **Step 1: Write failing tests for text safety and truncation**

Create test/text-file-tools.test.ts:

~~~typescript
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReadTools } from "../src/code-tools/read-tools.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

function byName(tools: ReturnType<typeof createReadTools>, name: string) {
  const tool = tools.find((value) => value.definition.name === name);
  assert.ok(tool);
  return tool;
}

test("read returns numbered UTF-8 lines and a continuation offset", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  assert.deepEqual(
    await byName(tools, "read").execute(
      { path: "src/a.ts", offset: 2, limit: 1 },
    ),
    {
      ok: true,
      path: "src/a.ts",
      content: "2: two",
      truncated: true,
      nextOffset: 3,
    },
  );
});

test("read blocks binary and private-key content without echoing it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-sensitive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(
    path.join(root, "key.pem"),
    "-----BEGIN PRIVATE KEY-----\nsecret\n",
  );
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  const binary = await byName(tools, "read").execute({ path: "binary.bin" });
  const key = await byName(tools, "read").execute({ path: "key.pem" });
  assert.equal(binary.ok, false);
  assert.equal(key.ok, false);
  assert.doesNotMatch(JSON.stringify(key), /secret/);
});

test("ls hides protected entries and sorts visible entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "z.ts"), "");
  await writeFile(path.join(root, "a.ts"), "");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  const result = await byName(tools, "ls").execute({});
  assert.deepEqual(result.entries, ["a.ts", "z.ts"]);
});

test("ls can list one explicitly authorized protected subtree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-protected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  const tools = createReadTools({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async confirmMutation() { return false; },
      async requestSecret() { return undefined; },
    },
  });

  const result = await byName(tools, "ls").execute({ path: "node_modules" });

  assert.deepEqual(result.entries, ["node_modules/pkg/"]);
});

test("read reports dotenv structure without returning values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, ".env"),
    "TOKEN=secret\nEMPTY=\nTOKEN=second\ninvalid line\n",
  );
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  const result = await byName(tools, "read").execute({ path: ".env" });
  assert.deepEqual(result, {
    ok: true,
    path: ".env",
    env: {
      keys: ["TOKEN", "EMPTY"],
      emptyKeys: ["EMPTY"],
      duplicates: [{ key: "TOKEN", lines: [1, 3] }],
      invalidLines: [4],
    },
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|second/);
});
~~~

- [ ] **Step 2: Run the test and verify it fails**

Run:

~~~bash
node --import tsx --test test/text-file-tools.test.ts
~~~

Expected: FAIL because read-tools.js does not exist.

- [ ] **Step 3: Implement text-file primitives**

Create src/code-tools/text-files.ts with:

~~~typescript
import { lstat, readFile } from "node:fs/promises";

import { CodeToolError } from "./types.js";

const PRIVATE_KEY_MARKER =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface TextFile {
  bytes: Buffer;
  bom: string;
  text: string;
  lineEnding: "\n" | "\r\n";
  mode: number;
}

export function assertSafeTextContent(text: string): void {
  if (text.includes("\u0000")) {
    throw new CodeToolError("NOT_TEXT", "目标不是可处理的文本内容。");
  }
  if (PRIVATE_KEY_MARKER.test(text)) {
    throw new CodeToolError("PATH_DENIED", "已阻止敏感私钥内容。");
  }
}

export async function readTextFile(
  absolutePath: string,
  maximumBytes?: number,
): Promise<TextFile> {
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    throw new CodeToolError("PATH_DENIED", "目标不是普通文件。");
  }
  if (maximumBytes !== undefined && stats.size > maximumBytes) {
    throw new CodeToolError("LIMIT_EXCEEDED", "文件超过允许的大小。");
  }
  const bytes = await readFile(absolutePath);
  if (bytes.includes(0)) {
    throw new CodeToolError("NOT_TEXT", "目标不是可读取的文本文件。");
  }
  let decoded: string;
  try {
    decoded = decoder.decode(bytes);
  } catch {
    throw new CodeToolError("NOT_TEXT", "目标不是有效的 UTF-8 文本。");
  }
  assertSafeTextContent(decoded);
  const bom = decoded.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? decoded.slice(1) : decoded;
  return {
    bytes,
    bom,
    text,
    lineEnding: text.includes("\r\n") ? "\r\n" : "\n",
    mode: stats.mode & 0o777,
  };
}

export interface EnvEntry {
  key: string;
  lineIndex: number;
  empty: boolean;
}

export interface ParsedEnvStructure {
  entries: EnvEntry[];
  invalidLines: number[];
  duplicateKeys: string[];
}

export function parseEnvStructure(text: string): ParsedEnvStructure {
  const entries: EnvEntry[] = [];
  const invalidLines: number[] = [];
  const occurrences = new Map<string, number[]>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  lines.forEach((line, index) => {
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/,
    );
    if (!match) {
      invalidLines.push(index + 1);
      return;
    }
    const key = match[1]!;
    const value = match[2]!.trim();
    const found = occurrences.get(key) ?? [];
    found.push(index + 1);
    occurrences.set(key, found);
    entries.push({
      key,
      lineIndex: index,
      empty: value === "" || value === "\"\"" || value === "''",
    });
  });

  return {
    entries,
    invalidLines,
    duplicateKeys: [...occurrences]
      .filter(([, linesForKey]) => linesForKey.length > 1)
      .map(([key]) => key),
  };
}

export async function inspectEnvFile(
  absolutePath: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  const file = await readTextFile(absolutePath);
  const parsed = parseEnvStructure(file.text);
  const uniqueKeys = [...new Set(parsed.entries.map((entry) => entry.key))];
  const linesByKey = new Map<string, number[]>();
  for (const entry of parsed.entries) {
    linesByKey.set(
      entry.key,
      [...(linesByKey.get(entry.key) ?? []), entry.lineIndex + 1],
    );
  }
  return {
    ok: true,
    path: relativePath,
    env: {
      keys: uniqueKeys,
      emptyKeys: [...new Set(
        parsed.entries.filter((entry) => entry.empty).map((entry) => entry.key),
      )],
      duplicates: [...linesByKey]
        .filter(([, lines]) => lines.length > 1)
        .map(([key, linesForKey]) => ({ key, lines: linesForKey })),
      invalidLines: parsed.invalidLines,
    },
  };
}

~~~

- [ ] **Step 4: Implement ls and read registrations**

Create src/code-tools/read-tools.ts. Keep schemas explicit and wrap handlers with executeCodeTool:

~~~typescript
import { readdir } from "node:fs/promises";

import type { RegisteredTool } from "../tool-registry.js";
import {
  CodeToolError,
  executeCodeTool,
  LS_MAX_ENTRIES,
  OUTPUT_MAX_BYTES,
  READ_MAX_LINES,
  type ToolInteraction,
  DEFAULT_TOOL_INTERACTION,
} from "./types.js";
import {
  inspectEnvFile,
  readTextFile,
} from "./text-files.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePolicy,
} from "./workspace-policy.js";

interface ReadToolOptions {
  policy: WorkspacePolicy;
  interaction?: ToolInteraction;
}

function integer(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      name + " 必须是 " + minimum + " 到 " + maximum + " 的整数。",
    );
  }
  return result;
}

async function visibleChild(
  policy: WorkspacePolicy,
  relativePath: string,
  authorizedProtectedRoot?: string,
): Promise<ResolvedWorkspacePath | undefined> {
  try {
    const child = await policy.resolve(relativePath, "read");
    if (child.kind === "allowed") return child;
    const insideAuthorized =
      authorizedProtectedRoot !== undefined &&
      (
        authorizedProtectedRoot === "." ||
        child.relativePath === authorizedProtectedRoot ||
        child.relativePath.startsWith(authorizedProtectedRoot + "/")
      );
    return child.kind === "protected" && insideAuthorized ? child : undefined;
  } catch (error) {
    if (error instanceof CodeToolError && error.code === "PATH_DENIED") {
      return undefined;
    }
    throw error;
  }
}

export function createReadTools({
  policy,
  interaction = DEFAULT_TOOL_INTERACTION,
}: ReadToolOptions): RegisteredTool[] {
  return [
    {
      definition: {
        name: "ls",
        description: "列出工作区目录的直接子项，默认隐藏受保护路径。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: LS_MAX_ENTRIES },
          },
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          const target = await policy.resolve(
            typeof args.path === "string" ? args.path : ".",
            "read",
          );
          if (target.kind === "env") {
            throw new CodeToolError("PATH_DENIED", ".env 不是可列出的目录。");
          }
          if (
            target.kind === "protected" &&
            !await interaction.authorizeProtected({
              operation: "read",
              path: target.relativePath,
              reason: target.protectedReason ?? "受保护路径",
            }, signal)
          ) {
            throw new CodeToolError("USER_REJECTED", "用户未授权列出目录。");
          }
          const authorizedProtectedRoot =
            target.kind === "protected" ? target.relativePath : undefined;
          const limit = integer(
            args.limit,
            LS_MAX_ENTRIES,
            1,
            LS_MAX_ENTRIES,
            "limit",
          );
          const entries: string[] = [];
          let truncated = false;
          const directoryEntries = await readdir(
            target.absolutePath,
            { withFileTypes: true },
          );
          directoryEntries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of directoryEntries) {
            const child = await visibleChild(
              policy,
              target.relativePath === "."
                ? entry.name
                : target.relativePath + "/" + entry.name,
              authorizedProtectedRoot,
            );
            if (!child) continue;
            const display = child.relativePath + (entry.isDirectory() ? "/" : "");
            const next = [...entries, display];
            if (
              next.length > limit ||
              Buffer.byteLength(next.join("\n")) > OUTPUT_MAX_BYTES
            ) {
              truncated = true;
              break;
            }
            entries.push(display);
          }
          return { ok: true, path: target.relativePath, entries, truncated };
        });
      },
    },
    {
      definition: {
        name: "read",
        description: "按行读取工作区内的 UTF-8 文本文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: READ_MAX_LINES },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          if (typeof args.path !== "string") {
            throw new CodeToolError("INVALID_ARGUMENT", "read 缺少 path。");
          }
          const target = await policy.resolve(args.path, "read");
          if (!target.exists) {
            throw new CodeToolError("NOT_FOUND", "文件不存在。");
          }
          if (target.kind === "env") {
            return await inspectEnvFile(
              target.absolutePath,
              target.relativePath,
            );
          }
          if (
            target.kind === "protected" &&
            !await interaction.authorizeProtected({
              operation: "read",
              path: target.relativePath,
              reason: target.protectedReason ?? "受保护路径",
            }, signal)
          ) {
            throw new CodeToolError("USER_REJECTED", "用户未授权读取。");
          }
          const file = await readTextFile(target.absolutePath);
          const offset = integer(args.offset, 1, 1, Number.MAX_SAFE_INTEGER, "offset");
          const limit = integer(args.limit, READ_MAX_LINES, 1, READ_MAX_LINES, "limit");
          const lines = file.text.replace(/\r\n/g, "\n").split("\n");
          const selected = lines.slice(offset - 1, offset - 1 + limit);
          const rendered: string[] = [];
          for (let index = 0; index < selected.length; index += 1) {
            const line = String(offset + index) + ": " + selected[index];
            const candidate = [...rendered, line].join("\n");
            if (Buffer.byteLength(candidate) > OUTPUT_MAX_BYTES) {
              if (rendered.length === 0) {
                throw new CodeToolError(
                  "LIMIT_EXCEEDED",
                  "单行内容超过 50KB，无法安全返回整行。",
                );
              }
              break;
            }
            rendered.push(line);
          }
          const consumed = rendered.length;
          const truncated =
            consumed < selected.length ||
            offset - 1 + consumed < lines.length;
          return {
            ok: true,
            path: target.relativePath,
            content: rendered.join("\n"),
            truncated,
            ...(truncated ? { nextOffset: offset + consumed } : {}),
          };
        });
      },
    },
  ];
}
~~~

- [ ] **Step 5: Run focused tests and type check**

Run:

~~~bash
node --import tsx --test test/text-file-tools.test.ts
npm run check
~~~

Expected: text safety, read pagination, and ls filtering tests pass.

### Task 4: Add controlled find and grep

**Files:**

- Create: src/code-tools/search-tools.ts
- Create: test/search-tools.test.ts

- [ ] **Step 1: Write tests around an injected ripgrep runner**

Create test/search-tools.test.ts:

~~~typescript
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSearchTools } from "../src/code-tools/search-tools.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

test("find terminates options and filters protected results", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-find-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let received: readonly string[] = [];
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root),
    runRg: async (args) => {
      received = args;
      return {
        lines: ["src/a.ts", "node_modules/pkg/a.ts"],
        truncated: false,
      };
    },
  });
  const find = tools.find((tool) => tool.definition.name === "find")!;

  const result = await find.execute({ pattern: "-danger", path: "." });

  assert.ok(received.includes("--"));
  assert.deepEqual(result, {
    ok: true,
    path: ".",
    files: ["src/a.ts"],
    truncated: false,
  });
});

test("grep parses rg JSON without allowing model-controlled flags", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-grep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let received: readonly string[] = [];
  const match = JSON.stringify({
    type: "match",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: "const value = 1;\n" },
      line_number: 7,
    },
  });
  const context = JSON.stringify({
    type: "context",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: "before\n" },
      line_number: 6,
    },
  });
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root),
    runRg: async (args) => {
      received = args;
      return { lines: [context, match], truncated: false };
    },
  });
  const grep = tools.find((tool) => tool.definition.name === "grep")!;

  const result = await grep.execute({
    pattern: "--hidden",
    literal: true,
    path: ".",
  });

  assert.equal(received[received.indexOf("--") + 1], "--hidden");
  assert.deepEqual(result.matches, [
    {
      path: "src/a.ts",
      line: 6,
      text: "before",
      kind: "context",
    },
    {
      path: "src/a.ts",
      line: 7,
      text: "const value = 1;",
      kind: "match",
    },
  ]);
});

test("find returns results inside one explicitly authorized protected path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-find-protected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async confirmMutation() { return false; },
      async requestSecret() { return undefined; },
    },
    runRg: async () => ({ lines: ["a.js"], truncated: false }),
  });
  const find = tools.find((tool) => tool.definition.name === "find")!;

  const result = await find.execute({ pattern: "*.js", path: "dist" });

  assert.deepEqual(result.files, ["dist/a.js"]);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
node --import tsx --test test/search-tools.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement a streaming rg runner**

The default runner must spawn only rg, keep shell disabled, stop buffering at 50KB, and honor AbortSignal:

~~~typescript
import { spawn } from "node:child_process";

import { CodeToolError, OUTPUT_MAX_BYTES } from "./types.js";

export type RgRunner = (
  args: readonly string[],
  cwd: string,
  maximumLines: number,
  signal?: AbortSignal,
) => Promise<{ lines: string[]; truncated: boolean }>;

export const runRipgrep: RgRunner = async (args, cwd, maximumLines, signal) =>
  await new Promise<{ lines: string[]; truncated: boolean }>((resolve, reject) => {
    const child = spawn("rg", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pending = "";
    let bytes = 0;
    let lineLimitReached = false;
    const lines: string[] = [];
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      signal?.removeEventListener("abort", abort);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new CodeToolError("RG_UNAVAILABLE", "系统未安装 rg。"));
      } else {
        reject(error);
      }
    });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > OUTPUT_MAX_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        lines.push(line);
        if (lines.length === maximumLines) {
          lineLimitReached = true;
          child.kill("SIGTERM");
          break;
        }
      }
    });
    child.once("close", (code, closeSignal) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
      } else if (bytes > OUTPUT_MAX_BYTES || lineLimitReached) {
        resolve({ lines, truncated: true });
      } else if (code === 0 || code === 1) {
        if (pending) lines.push(pending);
        resolve({ lines, truncated: false });
      } else {
        reject(
          new CodeToolError(
            "EXECUTION_FAILED",
            "rg 执行失败：" + String(closeSignal ?? code),
          ),
        );
      }
    });
  });
~~~

- [ ] **Step 4: Implement find and grep registrations**

In the same src/code-tools/search-tools.ts file, add createSearchTools. The exact argument construction is:

~~~typescript
import { stat } from "node:fs/promises";
import path from "node:path";

import type { RegisteredTool } from "../tool-registry.js";
import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  executeCodeTool,
  FIND_MAX_RESULTS,
  GREP_MAX_LINE_LENGTH,
  GREP_MAX_MATCHES,
  type ToolInteraction,
} from "./types.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePolicy,
} from "./workspace-policy.js";

interface SearchToolOptions {
  policy: WorkspacePolicy;
  runRg?: RgRunner;
  interaction?: ToolInteraction;
}

function positiveLimit(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < 1 ||
    result > maximum
  ) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      "limit 必须是 1 到 " + maximum + " 的整数。",
    );
  }
  return result as number;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CodeToolError("INVALID_ARGUMENT", name + " 必须是非空字符串。");
  }
  return value;
}

async function visibleResult(
  policy: WorkspacePolicy,
  relativePath: string,
  authorizedProtectedRoot?: string,
): Promise<ResolvedWorkspacePath | undefined> {
  try {
    const candidate = await policy.resolve(relativePath, "read");
    if (candidate.kind === "allowed") return candidate;
    const insideAuthorized =
      authorizedProtectedRoot !== undefined &&
      (
        authorizedProtectedRoot === "." ||
        candidate.relativePath === authorizedProtectedRoot ||
        candidate.relativePath.startsWith(authorizedProtectedRoot + "/")
      );
    return candidate.kind === "protected" && insideAuthorized
      ? candidate
      : undefined;
  } catch (error) {
    if (error instanceof CodeToolError && error.code === "PATH_DENIED") {
      return undefined;
    }
    throw error;
  }
}

async function authorizeSearchTarget(
  target: ResolvedWorkspacePath,
  interaction: ToolInteraction,
  signal?: AbortSignal,
): Promise<void> {
  if (target.kind === "env") {
    throw new CodeToolError("PATH_DENIED", "搜索不会读取 .env 内容。");
  }
  if (
    target.kind === "protected" &&
    !await interaction.authorizeProtected({
      operation: "read",
      path: target.relativePath,
      reason: target.protectedReason ?? "受保护路径",
    }, signal)
  ) {
    throw new CodeToolError("USER_REJECTED", "用户未授权搜索受保护路径。");
  }
}

export function createSearchTools({
  policy,
  runRg = runRipgrep,
  interaction = DEFAULT_TOOL_INTERACTION,
}: SearchToolOptions): RegisteredTool[] {
  return [
    {
      definition: {
        name: "find",
        description: "按 glob 查找工作区文件，默认隐藏受保护路径。",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: FIND_MAX_RESULTS },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          const pattern = requiredString(args.pattern, "pattern");
          const target = await policy.resolve(
            typeof args.path === "string" ? args.path : ".",
            "read",
          );
          await authorizeSearchTarget(target, interaction, signal);
          const authorizedProtectedRoot =
            target.kind === "protected" ? target.relativePath : undefined;
          if (!target.exists) {
            throw new CodeToolError("NOT_FOUND", "find 搜索目录不存在。");
          }
          if (!(await stat(target.absolutePath)).isDirectory()) {
            throw new CodeToolError(
              "INVALID_ARGUMENT",
              "find 的 path 必须是目录。",
            );
          }
          const limit = positiveLimit(args.limit, FIND_MAX_RESULTS, FIND_MAX_RESULTS);
          const rgOutput = await runRg(
            ["--files", "--hidden", "--glob", pattern, "--", "."],
            target.absolutePath,
            limit,
            signal,
          );
          const files: string[] = [];
          for (const item of rgOutput.lines) {
            const relativeToTarget = item.replace(/^\.\//, "");
            const candidate = await visibleResult(
              policy,
              path.posix.join(target.relativePath, relativeToTarget),
              authorizedProtectedRoot,
            );
            if (candidate) files.push(candidate.relativePath);
            if (files.length === limit) break;
          }
          return {
            ok: true,
            path: target.relativePath,
            files,
            truncated: rgOutput.truncated || files.length === limit,
          };
        });
      },
    },
    {
      definition: {
        name: "grep",
        description: "使用正则或普通字符串搜索工作区文本。",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
            glob: { type: "string" },
            ignoreCase: { type: "boolean" },
            literal: { type: "boolean" },
            context: { type: "integer", minimum: 0, maximum: 10 },
            limit: { type: "integer", minimum: 1, maximum: GREP_MAX_MATCHES },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          const pattern = requiredString(args.pattern, "pattern");
          const target = await policy.resolve(
            typeof args.path === "string" ? args.path : ".",
            "read",
          );
          await authorizeSearchTarget(target, interaction, signal);
          const authorizedProtectedRoot =
            target.kind === "protected" ? target.relativePath : undefined;
          if (!target.exists) {
            throw new CodeToolError("NOT_FOUND", "grep 搜索路径不存在。");
          }
          const limit = positiveLimit(args.limit, GREP_MAX_MATCHES, GREP_MAX_MATCHES);
          const context = args.context === undefined ? 0 : args.context;
          if (
            typeof context !== "number" ||
            !Number.isInteger(context) ||
            context < 0 ||
            context > 10
          ) {
            throw new CodeToolError("INVALID_ARGUMENT", "context 必须是 0 到 10。");
          }
          const flags = ["--json", "--color", "never"];
          if (args.literal === true) flags.push("--fixed-strings");
          if (args.ignoreCase === true) flags.push("--ignore-case");
          if (typeof args.glob === "string") flags.push("--glob", args.glob);
          if (context > 0) flags.push("--context", String(context));
          const rgOutput = await runRg(
            [...flags, "--", pattern, target.relativePath],
            policy.root,
            limit * (2 * context + 1) + 10,
            signal,
          );
          const matches: Array<{
            path: string;
            line: number;
            text: string;
            kind: "match" | "context";
          }> = [];
          let matchCount = 0;
          for (const line of rgOutput.lines) {
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }
            if (event?.type !== "match" && event?.type !== "context") continue;
            const candidate = await visibleResult(
              policy,
              event.data.path.text,
              authorizedProtectedRoot,
            );
            if (!candidate) continue;
            const text = String(event.data.lines.text)
              .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g, "")
              .trimEnd()
              .slice(0, GREP_MAX_LINE_LENGTH);
            matches.push({
              path: candidate.relativePath,
              line: event.data.line_number,
              text,
              kind: event.type,
            });
            if (event.type === "match") matchCount += 1;
            if (matchCount === limit) break;
          }
          return {
            ok: true,
            matches,
            truncated: rgOutput.truncated || matchCount === limit,
          };
        });
      },
    },
  ];
}
~~~

- [ ] **Step 5: Add cancellation and missing-rg tests**

Append to test/search-tools.test.ts:

~~~typescript
import { runRipgrep } from "../src/code-tools/search-tools.js";

test("reports a missing rg executable without invoking a shell", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-no-rg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      runRipgrep(["--version"], root, 10),
      /系统未安装 rg/,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

test("propagates AbortError from a cancelled search", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-abort-rg-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root),
    runRg: async (_args, _cwd, _maximumLines, signal) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const find = tools.find((tool) => tool.definition.name === "find")!;
  const pending = find.execute({ pattern: "*.ts" }, controller.signal);
  controller.abort();

  await assert.rejects(pending, (error) => {
    assert.equal((error as Error).name, "AbortError");
    return true;
  });
});
~~~

Run the focused suite and expect PASS. The test process invokes rg directly through spawn with shell disabled; it never invokes a shell.

- [ ] **Step 6: Run focused tests and type check**

Run:

~~~bash
node --import tsx --test test/search-tools.test.ts
npm run check
~~~

Expected: argument-boundary, filtering, parsing, cancellation, and missing-rg tests pass.

### Task 5: Implement Pi-style exact edit preparation

**Files:**

- Create: src/code-tools/edit-diff.ts
- Create: test/edit-diff.test.ts

- [ ] **Step 1: Write pure edit tests**

Create test/edit-diff.test.ts:

~~~typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareEdit,
  prepareNewFile,
} from "../src/code-tools/edit-diff.js";

test("applies multiple exact edits against the same original text", () => {
  const result = prepareEdit(
    "src/a.ts",
    "\uFEFFconst a = 1;\r\nconst b = 2;\r\n",
    [
      { oldText: "const a = 1;", newText: "const a = 3;" },
      { oldText: "const b = 2;", newText: "" },
    ],
  );
  assert.equal(result.content, "\uFEFFconst a = 3;\r\n\r\n");
  assert.equal(result.firstChangedLine, 1);
  assert.match(result.patch, /^--- /m);
  assert.match(result.patch, /^\+const a = 3;/m);
});

test("rejects missing, duplicate, overlapping, and no-op edits", () => {
  assert.throws(
    () => prepareEdit("a.ts", "x", [{ oldText: "y", newText: "z" }]),
    /精确文本/,
  );
  assert.throws(
    () => prepareEdit("a.ts", "x x", [{ oldText: "x", newText: "z" }]),
    /出现 2 次/,
  );
  assert.throws(
    () => prepareEdit("a.ts", "abcdef", [
      { oldText: "abcd", newText: "x" },
      { oldText: "cdef", newText: "y" },
    ]),
    /重叠/,
  );
  assert.throws(
    () => prepareEdit("a.ts", "x", [{ oldText: "x", newText: "x" }]),
    /没有产生变化/,
  );
  assert.throws(
    () => prepareEdit("a.ts", "x", [{ oldText: "x", newText: "" }]),
    /不能清空整个文件/,
  );
});

test("rejects a patch larger than the confirmation limit", () => {
  const content = Array.from({ length: 201 }, (_, i) => "line " + i).join("\n");
  assert.throws(() => prepareNewFile("large.txt", content), /Diff 超过/);
});

test("sanitizes terminal controls only in the preview", () => {
  const result = prepareNewFile("escape.txt", "safe\u001b[31mred");
  assert.equal(result.content, "safe\u001b[31mred");
  assert.doesNotMatch(result.patch, /\u001b/);
});

test("represents creation of an empty file in the confirmation preview", () => {
  const result = prepareNewFile("empty.txt", "");
  assert.equal(result.content, "");
  assert.match(result.patch, /new empty file/);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
node --import tsx --test test/edit-diff.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement exact replacement and unified patches**

Create src/code-tools/edit-diff.ts:

~~~typescript
import { createTwoFilesPatch } from "diff";

import {
  CodeToolError,
  DIFF_MAX_BYTES,
  DIFF_MAX_LINES,
  EDIT_MAX_REPLACEMENTS,
} from "./types.js";

export interface ExactEdit {
  oldText: string;
  newText: string;
}

export interface PreparedMutation {
  content: string;
  patch: string;
  changedLines: number;
  firstChangedLine?: number;
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function occurrences(content: string, needle: string): number[] {
  const result: number[] = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const index = content.indexOf(needle, from);
    if (index === -1) break;
    result.push(index);
    from = index + Math.max(needle.length, 1);
  }
  return result;
}

function sanitizePreview(text: string): string {
  return text.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g,
    "",
  );
}

function sanitizePath(path: string): string {
  return sanitizePreview(JSON.stringify(path).slice(1, -1));
}

function finalize(
  path: string,
  oldContent: string,
  newContent: string,
  content: string,
): PreparedMutation {
  const displayPath = sanitizePath(path);
  const patch = sanitizePreview(
    createTwoFilesPatch(displayPath, displayPath, oldContent, newContent, "", "", {
      context: 4,
    }),
  );
  const patchLines = patch.split("\n");
  const changedLines = patchLines.filter(
    (line) =>
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
  ).length;
  if (
    patchLines.length > DIFF_MAX_LINES ||
    Buffer.byteLength(patch) > DIFF_MAX_BYTES
  ) {
    throw new CodeToolError(
      "LIMIT_EXCEEDED",
      "Diff 超过 200 行或 50KB，请拆分修改。",
    );
  }
  const firstHunk = patch.match(/^@@ -\d+(?:,\d+)? \+(\d+)/m);
  return {
    content,
    patch,
    changedLines,
    ...(firstHunk ? { firstChangedLine: Number(firstHunk[1]) } : {}),
  };
}

export function prepareEdit(
  path: string,
  original: string,
  edits: readonly ExactEdit[],
): PreparedMutation {
  if (edits.length < 1 || edits.length > EDIT_MAX_REPLACEMENTS) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      "edits 必须包含 1 到 20 项。",
    );
  }
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const withoutBom = bom ? original.slice(1) : original;
  const ending = withoutBom.includes("\r\n") ? "\r\n" : "\n";
  const base = normalize(withoutBom);
  const matched = edits.map((edit, index) => {
    const oldText = normalize(edit.oldText);
    const newText = normalize(edit.newText);
    if (oldText.length === 0) {
      throw new CodeToolError(
        "INVALID_ARGUMENT",
        "edits[" + index + "].oldText 不能为空。",
      );
    }
    const matches = occurrences(base, oldText);
    if (matches.length === 0) {
      throw new CodeToolError(
        "EDIT_NOT_FOUND",
        "edits[" + index + "] 的精确文本不存在。",
      );
    }
    if (matches.length !== 1) {
      throw new CodeToolError(
        "EDIT_NOT_UNIQUE",
        "edits[" + index + "] 的精确文本出现 " + matches.length + " 次。",
      );
    }
    return {
      index,
      start: matches[0]!,
      end: matches[0]! + oldText.length,
      newText,
    };
  }).sort((a, b) => a.start - b.start);

  for (let index = 1; index < matched.length; index += 1) {
    if (matched[index - 1]!.end > matched[index]!.start) {
      throw new CodeToolError("EDIT_OVERLAP", "edits 中存在重叠区域。");
    }
  }
  let next = base;
  for (const edit of [...matched].reverse()) {
    next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end);
  }
  if (next === base) {
    throw new CodeToolError("EDIT_NO_CHANGE", "修改没有产生变化。");
  }
  if (base.length > 0 && next.length === 0) {
    throw new CodeToolError(
      "PATH_DENIED",
      "edit 不能清空整个文件。",
    );
  }
  const restored = bom + (ending === "\r\n" ? next.replace(/\n/g, "\r\n") : next);
  return finalize(path, base, next, restored);
}

export function prepareNewFile(
  path: string,
  content: string,
): PreparedMutation {
  if (content.length === 0) {
    return {
      content,
      patch:
        "--- /dev/null\n+++ " + sanitizePath(path) +
        "\n@@ new empty file @@\n",
      changedLines: 0,
    };
  }
  return finalize(path, "", normalize(content), content);
}
~~~

- [ ] **Step 4: Run edit-diff tests and type check**

Run:

~~~bash
node --import tsx --test test/edit-diff.test.ts
npm run check
~~~

Expected: exact matching, BOM/CRLF preservation, overlap checks, limits, and preview sanitization pass.

### Task 6: Add transactional edit and write tools

**Files:**

- Create: src/code-tools/mutation.ts
- Create: src/code-tools/mutation-tools.ts
- Create: test/mutation-tools.test.ts

- [ ] **Step 1: Write approval, conflict, and atomic-write tests**

Create test/mutation-tools.test.ts:

~~~typescript
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMutationTools } from "../src/code-tools/mutation-tools.js";
import type { ToolInteraction } from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

function interaction(allow: boolean): ToolInteraction {
  return {
    async authorizeProtected() { return allow; },
    async confirmMutation() { return allow; },
    async requestSecret() { return undefined; },
  };
}

test("edit writes only after approval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "const n = 1;\n");

  const denied = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: interaction(false),
  }).find((tool) => tool.definition.name === "edit")!;
  assert.equal((await denied.execute({
    path: "a.ts",
    edits: [{ oldText: "1", newText: "2" }],
  })).code, "USER_REJECTED");
  assert.equal(await readFile(target, "utf8"), "const n = 1;\n");

  const allowed = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: interaction(true),
  }).find((tool) => tool.definition.name === "edit")!;
  assert.equal((await allowed.execute({
    path: "a.ts",
    edits: [{ oldText: "1", newText: "2" }],
  })).ok, true);
  assert.equal(await readFile(target, "utf8"), "const n = 2;\n");
});

test("write creates parents but never overwrites an existing file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-write-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: interaction(true),
  }).find((tool) => tool.definition.name === "write")!;

  assert.equal((await write.execute({
    path: "src/new/a.ts",
    content: "export {};\n",
  })).ok, true);
  assert.equal(
    await readFile(path.join(root, "src/new/a.ts"), "utf8"),
    "export {};\n",
  );
  assert.equal((await write.execute({
    path: "src/new/a.ts",
    content: "overwrite",
  })).code, "EDIT_CONFLICT");
  assert.equal((await write.execute({
    path: "key.pem",
    content: "-----BEGIN PRIVATE KEY-----\nsecret\n",
  })).code, "PATH_DENIED");
  await assert.rejects(readFile(path.join(root, "key.pem"), "utf8"), /ENOENT/);
});

test("edit detects a file changed after preview", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "old\n");
  const changingInteraction: ToolInteraction = {
    async authorizeProtected() { return true; },
    async confirmMutation() {
      await writeFile(target, "external\n");
      return true;
    },
    async requestSecret() { return undefined; },
  };
  const edit = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: changingInteraction,
  }).find((tool) => tool.definition.name === "edit")!;

  assert.equal((await edit.execute({
    path: "a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  })).code, "EDIT_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "external\n");
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
node --import tsx --test test/mutation-tools.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement hashing, per-path queues, and atomic persistence**

Create src/code-tools/mutation.ts:

~~~typescript
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { CodeToolError } from "./types.js";

const queues = new Map<string, Promise<void>>();

export async function hashFile(absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function withMutationQueue<T>(
  absolutePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(absolutePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  queues.set(absolutePath, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(absolutePath) === tail) queues.delete(absolutePath);
  }
}

function tempPath(target: string): string {
  return path.join(
    path.dirname(target),
    "." + path.basename(target) + ".coffee-" + randomUUID() + ".tmp",
  );
}

export async function atomicReplace(
  target: string,
  content: string,
  mode: number,
): Promise<void> {
  const temporary = tempPath(target);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createMissingDirectories(directory: string): Promise<string[]> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      await stat(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
  for (const item of [...missing].reverse()) await mkdir(item);
  return missing;
}

export async function atomicCreate(
  target: string,
  content: string,
): Promise<void> {
  const createdDirectories = await createMissingDirectories(path.dirname(target));
  const temporary = tempPath(target);
  let linked = false;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await link(temporary, target);
    linked = true;
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CodeToolError(
        "EDIT_CONFLICT",
        "目标文件已经存在，未覆盖。",
      );
    }
    throw error;
  } finally {
    if (!linked) await rm(temporary, { force: true });
    if (!linked) {
      for (const directory of createdDirectories) {
        try {
          await rm(directory);
        } catch {
          break;
        }
      }
    }
  }
}
~~~

- [ ] **Step 4: Implement edit and write registrations**

Create src/code-tools/mutation-tools.ts:

~~~typescript
import type { RegisteredTool } from "../tool-registry.js";
import { prepareEdit, prepareNewFile, type ExactEdit } from "./edit-diff.js";
import {
  atomicCreate,
  atomicReplace,
  hashFile,
  withMutationQueue,
} from "./mutation.js";
import { assertSafeTextContent, readTextFile } from "./text-files.js";
import {
  CodeToolError,
  EDIT_MAX_FILE_BYTES,
  executeCodeTool,
  type ToolInteraction,
  WRITE_MAX_FILE_BYTES,
} from "./types.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePolicy,
} from "./workspace-policy.js";

interface MutationToolOptions {
  policy: WorkspacePolicy;
  interaction: ToolInteraction;
}

async function authorize(
  target: ResolvedWorkspacePath,
  interaction: ToolInteraction,
  signal?: AbortSignal,
): Promise<void> {
  if (target.kind === "env") {
    throw new CodeToolError(
      "PATH_DENIED",
      ".env 文件只能通过 set_env 修改。",
    );
  }
  if (
    target.kind === "protected" &&
    !await interaction.authorizeProtected({
      operation: "write",
      path: target.relativePath,
      reason: target.protectedReason ?? "受保护路径",
    }, signal)
  ) {
    throw new CodeToolError("USER_REJECTED", "用户未授权修改受保护路径。");
  }
}

function parseEdits(value: unknown): ExactEdit[] {
  if (!Array.isArray(value)) {
    throw new CodeToolError("INVALID_ARGUMENT", "edit 缺少 edits 数组。");
  }
  return value.map((item, index) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as any).oldText !== "string" ||
      typeof (item as any).newText !== "string"
    ) {
      throw new CodeToolError(
        "INVALID_ARGUMENT",
        "edits[" + index + "] 必须包含 oldText 和 newText。",
      );
    }
    return {
      oldText: (item as any).oldText,
      newText: (item as any).newText,
    };
  });
}

export function createMutationTools({
  policy,
  interaction,
}: MutationToolOptions): RegisteredTool[] {
  return [
    {
      definition: {
        name: "edit",
        description: "按 Pi 的 edits[] 精确协议修改一个已有文本文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              items: {
                type: "object",
                properties: {
                  oldText: { type: "string" },
                  newText: { type: "string" },
                },
                required: ["oldText", "newText"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "edits"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          if (typeof args.path !== "string") {
            throw new CodeToolError("INVALID_ARGUMENT", "edit 缺少 path。");
          }
          const edits = parseEdits(args.edits);
          const initial = await policy.resolve(args.path, "write");
          await authorize(initial, interaction, signal);
          if (!initial.exists) {
            throw new CodeToolError("NOT_FOUND", "edit 目标不存在。");
          }
          return await withMutationQueue(initial.absolutePath, async () => {
            const file = await readTextFile(
              initial.absolutePath,
              EDIT_MAX_FILE_BYTES,
            );
            const beforeHash = await hashFile(initial.absolutePath);
            const prepared = prepareEdit(
              initial.relativePath,
              file.bom + file.text,
              edits,
            );
            assertSafeTextContent(prepared.content);
            if (!await interaction.confirmMutation({
              kind: "edit",
              path: initial.relativePath,
              patch: prepared.patch,
              changedLines: prepared.changedLines,
            }, signal)) {
              throw new CodeToolError("USER_REJECTED", "用户拒绝了本次修改。");
            }
            signal?.throwIfAborted();
            const current = await policy.resolve(args.path as string, "write");
            if (
              !current.exists ||
              current.absolutePath !== initial.absolutePath ||
              await hashFile(current.absolutePath) !== beforeHash
            ) {
              throw new CodeToolError(
                "EDIT_CONFLICT",
                "文件在确认期间发生变化，未写入。",
              );
            }
            const currentFile = await readTextFile(
              current.absolutePath,
              EDIT_MAX_FILE_BYTES,
            );
            if (currentFile.mode !== file.mode) {
              throw new CodeToolError(
                "EDIT_CONFLICT",
                "文件权限在确认期间发生变化，未写入。",
              );
            }
            await atomicReplace(current.absolutePath, prepared.content, file.mode);
            return {
              ok: true,
              path: current.relativePath,
              changes: edits.length,
              firstChangedLine: prepared.firstChangedLine,
            };
          });
        });
      },
    },
    {
      definition: {
        name: "write",
        description: "创建新的 UTF-8 文本文件，不能覆盖已有文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string", maxLength: WRITE_MAX_FILE_BYTES },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          if (typeof args.path !== "string" || typeof args.content !== "string") {
            throw new CodeToolError(
              "INVALID_ARGUMENT",
              "write 需要 path 和 content。",
            );
          }
          if (Buffer.byteLength(args.content) > WRITE_MAX_FILE_BYTES) {
            throw new CodeToolError("LIMIT_EXCEEDED", "新文件不能超过 1MB。");
          }
          assertSafeTextContent(args.content);
          const initial = await policy.resolve(args.path, "write");
          await authorize(initial, interaction, signal);
          if (initial.exists) {
            throw new CodeToolError(
              "EDIT_CONFLICT",
              "目标文件已经存在，不能覆盖。",
            );
          }
          return await withMutationQueue(initial.absolutePath, async () => {
            const prepared = prepareNewFile(initial.relativePath, args.content as string);
            if (!await interaction.confirmMutation({
              kind: "write",
              path: initial.relativePath,
              patch: prepared.patch,
              changedLines: prepared.changedLines,
            }, signal)) {
              throw new CodeToolError("USER_REJECTED", "用户拒绝了新建文件。");
            }
            signal?.throwIfAborted();
            const current = await policy.resolve(args.path as string, "write");
            if (current.exists || current.absolutePath !== initial.absolutePath) {
              throw new CodeToolError(
                "EDIT_CONFLICT",
                "目标路径在确认期间发生变化，未写入。",
              );
            }
            await atomicCreate(current.absolutePath, args.content as string);
            return { ok: true, path: current.relativePath, created: true };
          });
        });
      },
    },
  ];
}
~~~

- [ ] **Step 5: Add mode, temp cleanup, protected double-confirmation, and abort tests**

Extend the fs/promises import in test/mutation-tools.test.ts with chmod, mkdir, readdir, and stat. Import atomicReplace from mutation.ts, then append:

~~~typescript
import { atomicReplace } from "../src/code-tools/mutation.js";

test("edit preserves mode bits", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "script.ts");
  await writeFile(target, "old\n");
  await chmod(target, 0o755);
  const edit = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: interaction(true),
  }).find((tool) => tool.definition.name === "edit")!;

  await edit.execute({
    path: "script.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });

  assert.equal((await stat(target)).mode & 0o777, 0o755);
});

test("atomic replacement cleans its temp file when rename fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-temp-clean-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directoryTarget = path.join(root, "existing-directory");
  await mkdir(directoryTarget);

  await assert.rejects(
    atomicReplace(directoryTarget, "content", 0o644),
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".coffee-")),
    [],
  );
});

test("protected writes authorize access before asking for Diff approval", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-protected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "a.ts"), "old\n");
  const calls: string[] = [];
  const guarded: ToolInteraction = {
    async authorizeProtected() {
      calls.push("access");
      return true;
    },
    async confirmMutation() {
      calls.push("diff");
      return true;
    },
    async requestSecret() { return undefined; },
  };
  const edit = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: guarded,
  }).find((tool) => tool.definition.name === "edit")!;

  await edit.execute({
    path: "dist/a.ts",
    edits: [{ oldText: "old", newText: "new" }],
  });

  assert.deepEqual(calls, ["access", "diff"]);
});

test("AbortSignal prevents persistence after confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-abort-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "a.ts");
  await writeFile(target, "old\n");
  const controller = new AbortController();
  const edit = createMutationTools({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async confirmMutation() {
        controller.abort();
        return true;
      },
      async requestSecret() { return undefined; },
    },
  }).find((tool) => tool.definition.name === "edit")!;

  await assert.rejects(
    edit.execute({
      path: "a.ts",
      edits: [{ oldText: "old", newText: "new" }],
    }, controller.signal),
    (error) => (error as Error).name === "AbortError",
  );
  assert.equal(await readFile(target, "utf8"), "old\n");
});
~~~

Run the focused suite after each case; each new case must fail before its implementation adjustment and pass afterward.

- [ ] **Step 6: Run focused tests and type check**

Run:

~~~bash
node --import tsx --test test/mutation-tools.test.ts
npm run check
~~~

Expected: approval, rejection, conflict, atomic write, rollback, mode, and AbortSignal tests pass.

### Task 7: Add secret-safe dotenv updates

**Files:**

- Create: src/code-tools/env-tool.ts
- Create: test/env-tool.test.ts
- Modify: src/code-tools/text-files.ts
- Modify: src/code-tools/read-tools.ts

- [ ] **Step 1: Write tests proving values never enter tool data**

Create test/env-tool.test.ts:

~~~typescript
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEnvTool } from "../src/code-tools/env-tool.js";
import type { MutationPreview, ToolInteraction } from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

test("set_env writes a local secret but returns and previews only masked data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-set-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "TOKEN=old-secret\nKEEP=yes\n");
  const secret = "new-super-secret";
  let preview: MutationPreview | undefined;
  const interaction: ToolInteraction = {
    async authorizeProtected() { return true; },
    async requestSecret() { return secret; },
    async confirmMutation(value) {
      preview = value;
      return true;
    },
  };
  const tool = createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction,
  });

  const result = await tool.execute({ path: ".env", key: "TOKEN" });

  assert.deepEqual(result, {
    ok: true,
    path: ".env",
    key: "TOKEN",
    set: true,
  });
  assert.doesNotMatch(JSON.stringify(result), /new-super-secret/);
  assert.doesNotMatch(preview?.patch ?? "", /old-secret|new-super-secret/);
  assert.match(preview?.patch ?? "", /<hidden/);
  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "TOKEN=new-super-secret\nKEEP=yes\n",
  );
});

test("set_env rejects duplicate or invalid dotenv structure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-set-env-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "TOKEN=a\nTOKEN=b\n");
  let asked = false;
  const tool = createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async confirmMutation() { return true; },
      async requestSecret() {
        asked = true;
        return "value";
      },
    },
  });

  assert.equal((await tool.execute({ path: ".env", key: "TOKEN" })).ok, false);
  assert.equal(asked, false);
});
~~~

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

~~~bash
node --import tsx --test test/env-tool.test.ts
~~~

Expected: FAIL with ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Add reusable dotenv parsing without retaining values in results**

Reuse parseEnvStructure from src/code-tools/text-files.ts so read and set_env share one parser. In src/code-tools/env-tool.ts add only the value encoder and masked preview builder:

~~~typescript
function encodeEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function maskedPatch(
  path: string,
  key: string,
  existed: boolean,
): string {
  const header = "--- " + path + "\n+++ " + path + "\n@@ dotenv @@\n";
  return existed
    ? header + "-" + key + "=<hidden current>\n+" + key + "=<hidden new>\n"
    : header + "+" + key + "=<hidden>\n";
}
~~~

- [ ] **Step 4: Implement the complete set_env registration**

Add the following imports and exported factory around the parser:

~~~typescript
import type { RegisteredTool } from "../tool-registry.js";
import { atomicCreate, atomicReplace, hashFile, withMutationQueue } from "./mutation.js";
import { parseEnvStructure, readTextFile } from "./text-files.js";
import {
  CodeToolError,
  executeCodeTool,
  type ToolInteraction,
} from "./types.js";
import type { WorkspacePolicy } from "./workspace-policy.js";

interface EnvToolOptions {
  policy: WorkspacePolicy;
  interaction: ToolInteraction;
}

export function createEnvTool({
  policy,
  interaction,
}: EnvToolOptions): RegisteredTool {
  return {
    definition: {
      name: "set_env",
      description:
        "在本地隐藏输入并设置工作区 .env* 变量；模型不能提供或看到变量值。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          key: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        },
        required: ["path", "key"],
        additionalProperties: false,
      },
    },
    riskLevel: "write",
    async execute(args, signal) {
      return await executeCodeTool(async () => {
        if (
          typeof args.path !== "string" ||
          typeof args.key !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.key)
        ) {
          throw new CodeToolError(
            "INVALID_ARGUMENT",
            "set_env 需要合法的 path 和 key。",
          );
        }
        const initial = await policy.resolve(args.path, "write");
        if (initial.kind !== "env") {
          throw new CodeToolError(
            "PATH_DENIED",
            "set_env 只能修改 .env* 文件。",
          );
        }
        return await withMutationQueue(initial.absolutePath, async () => {
          const existed = initial.exists;
          const file = existed
            ? await readTextFile(initial.absolutePath, 1024 * 1024)
            : {
                text: "",
                bom: "",
                lineEnding: "\n" as const,
                mode: 0o644,
              };
          const beforeHash = existed
            ? await hashFile(initial.absolutePath)
            : undefined;
          const parsed = parseEnvStructure(file.text);
          if (parsed.invalidLines.length > 0 || parsed.duplicateKeys.length > 0) {
            throw new CodeToolError(
              "INVALID_ARGUMENT",
              ".env 存在重复变量或语法问题，未自动修改。",
            );
          }
          const value = await interaction.requestSecret({
            path: initial.relativePath,
            key: args.key,
          }, signal);
          signal?.throwIfAborted();
          if (value === undefined) {
            throw new CodeToolError("USER_REJECTED", "用户取消了变量输入。");
          }
          if (value.length === 0) {
            throw new CodeToolError("INVALID_ARGUMENT", "变量值不能为空。");
          }
          const lines = file.text.replace(/\r\n/g, "\n").split("\n");
          const entry = parsed.entries.find((item) => item.key === args.key);
          const assignment = args.key + "=" + encodeEnvValue(value);
          if (entry) {
            lines[entry.lineIndex] = assignment;
          } else {
            if (lines.at(-1) === "") lines.pop();
            lines.push(assignment, "");
          }
          const normalized = lines.join("\n");
          const content = file.bom +
            (file.lineEnding === "\r\n"
              ? normalized.replace(/\n/g, "\r\n")
              : normalized);
          const patch = maskedPatch(initial.relativePath, args.key, entry !== undefined);
          if (!await interaction.confirmMutation({
            kind: "set_env",
            path: initial.relativePath,
            patch,
            changedLines: entry ? 2 : 1,
          }, signal)) {
            throw new CodeToolError("USER_REJECTED", "用户拒绝了变量修改。");
          }
          signal?.throwIfAborted();
          const current = await policy.resolve(args.path as string, "write");
          const currentFile = existed && current.exists
            ? await readTextFile(current.absolutePath, 1024 * 1024)
            : undefined;
          if (
            current.absolutePath !== initial.absolutePath ||
            current.kind !== "env" ||
            current.exists !== existed ||
            (existed && currentFile?.mode !== file.mode) ||
            (existed && await hashFile(current.absolutePath) !== beforeHash)
          ) {
            throw new CodeToolError(
              "EDIT_CONFLICT",
              ".env 在确认期间发生变化，未写入。",
            );
          }
          if (existed) {
            await atomicReplace(current.absolutePath, content, file.mode);
          } else {
            await atomicCreate(current.absolutePath, content);
          }
          return {
            ok: true,
            path: current.relativePath,
            key: args.key,
            set: true,
          };
        });
      });
    },
  };
}
~~~

- [ ] **Step 5: Add create-new-env, cancellation, CRLF/BOM, and history-shape tests**

Append to test/env-tool.test.ts:

~~~typescript
test("new dotenv call history contains only path, key, and masked result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-new-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "history-must-not-see-this";
  const args = { path: ".env.local", key: "API_KEY" };
  const tool = createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async requestSecret() { return secret; },
      async confirmMutation() { return true; },
    },
  });
  const result = await tool.execute(args);
  const persistedShape = { argumentsJson: JSON.stringify(args), result };

  assert.doesNotMatch(JSON.stringify(persistedShape), /history-must-not-see-this/);
  assert.equal(
    await readFile(path.join(root, ".env.local"), "utf8"),
    "API_KEY=history-must-not-see-this\n",
  );
  assert.deepEqual(Object.keys(tool.definition.inputSchema), [
    "type",
    "properties",
    "required",
    "additionalProperties",
  ]);
});

test("set_env preserves BOM and CRLF", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-crlf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "\uFEFFTOKEN=old\r\nKEEP=yes\r\n");
  const tool = createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async requestSecret() { return "new"; },
      async confirmMutation() { return true; },
    },
  });

  await tool.execute({ path: ".env", key: "TOKEN" });

  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "\uFEFFTOKEN=new\r\nKEEP=yes\r\n",
  );
});

test("cancelling secret input does not create a dotenv file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return true; },
      async requestSecret() { return undefined; },
      async confirmMutation() { throw new Error("must not confirm"); },
    },
  });

  const result = await tool.execute({ path: ".env", key: "TOKEN" });

  assert.equal(result.code, "USER_REJECTED");
  await assert.rejects(readFile(path.join(root, ".env"), "utf8"), /ENOENT/);
});
~~~

Run each new test once before the implementation adjustment and expect FAIL, then run again and expect PASS.

- [ ] **Step 6: Run focused tests and type check**

Run:

~~~bash
node --import tsx --test test/env-tool.test.ts test/text-file-tools.test.ts
npm run check
~~~

Expected: dotenv read diagnostics, hidden update, conflict, cancellation, encoding, BOM/CRLF, and non-leakage tests pass.

### Task 8: Build the inline TUI confirmation flow

**Files:**

- Create: src/tool-interaction.ts
- Create: test/tool-interaction.test.ts
- Modify: src/activity-indicator.ts
- Modify: test/activity-indicator.test.ts
- Modify: src/chat-input.ts
- Modify: test/chat-input.test.ts
- Modify: src/terminal-format.ts
- Modify: test/terminal-format.test.ts

- [ ] **Step 1: Write an activity pause test**

Append to test/activity-indicator.test.ts:

~~~typescript
test("pause clears animation but preserves the eventual completion", () => {
  let written = "";
  let stopped = 0;
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: true,
    useColor: true,
    getAnimation: () => "americano",
    now: sequenceClock(0, 900),
    startTimer() { return { unref() {} }; },
    stopTimer() { stopped += 1; },
  });

  renderer.handle({ name: "edit", phase: "start" });
  renderer.pause();
  const afterPause = written;
  renderer.handle({ name: "edit", phase: "success" });

  assert.equal(stopped, 1);
  assert.match(afterPause, /\u001b\[\?25h/);
  assert.match(written, /✓ 工具执行已经完成 · 0\.9s/);
});
~~~

- [ ] **Step 2: Extend ActivityRenderer with pause**

In src/activity-indicator.ts:

~~~typescript
export interface ActivityRenderer {
  handle(event: ToolActivityEvent): void;
  pause(): void;
  dispose(): void;
}
~~~

Keep a paused activity after clearing its dynamic block:

~~~typescript
let active: ActiveActivity | undefined;
let paused: ActiveActivity | undefined;

function pauseActive(): void {
  if (!active) return;
  const activity = active;
  active = undefined;
  if (activity.timer) stopTimer(activity.timer);
  activity.timer = undefined;
  if (activity.animated) {
    clearBlock(activity);
    output.write(ANSI.showCursor);
  }
  paused = activity;
}

function finishActive(succeeded: boolean): void {
  const activity = active ?? paused;
  active = undefined;
  paused = undefined;
  if (!activity) return;
  if (activity.timer) stopTimer(activity.timer);
  if (activity.animated && activity.timer) {
    clearBlock(activity);
    output.write(ANSI.showCursor);
  }
  const seconds = Math.max(0, now() - activity.startedAt) / 1000;
  const marker = succeeded ? "✓" : "✗";
  const colorCode = succeeded ? ANSI.green : ANSI.red;
  output.write(
    paint(
      marker + " " + getCompletionText(activity.name, succeeded) +
        " · " + seconds.toFixed(1) + "s",
      colorCode,
      useColor,
    ) + "\n",
  );
}
~~~

Add this discard helper and replace the returned object:

~~~typescript
function discardCurrent(): void {
  const activity = active;
  active = undefined;
  paused = undefined;
  if (!activity) return;
  if (activity.timer) stopTimer(activity.timer);
  if (activity.animated) {
    clearBlock(activity);
    output.write(ANSI.showCursor);
  }
}

return {
  handle(event) {
    if (event.phase === "start") {
      discardCurrent();
      const animation = getAnimation();
      const activity: ActiveActivity = {
        name: event.name,
        startedAt: now(),
        animation,
        frames: getAnimationFrames(animation, event.name),
        frameIndex: 0,
        animated: shouldAnimate,
      };
      active = activity;
      if (!shouldAnimate) {
        output.write(
          getDrinkName(animation) + getActionText(event.name) + "\n",
        );
        return;
      }
      output.write(ANSI.hideCursor);
      drawFrame(activity, false);
      activity.timer = startTimer(() => {
        if (active !== activity) return;
        activity.frameIndex =
          (activity.frameIndex + 1) % activity.frames.length;
        drawFrame(activity, true);
      }, FRAME_INTERVAL_MS);
      activity.timer.unref?.();
      return;
    }
    finishActive(event.phase === "success");
  },
  pause() {
    pauseActive();
  },
  dispose() {
    discardCurrent();
  },
};
~~~

Delete the superseded stopActive helper and old returned object. Re-run activity tests and expect PASS.

- [ ] **Step 3: Expose interactivity from InputController**

Modify src/chat-input.ts:

~~~typescript
export interface InputController {
  readonly isInteractive: boolean;
  ask(message: string, suggestions?: boolean): Promise<string | undefined>;
  askSecret(message: string): Promise<string | undefined>;
  close(): void;
}
~~~

Return isInteractive: isTTY from createInputController. Add to test/chat-input.test.ts:

~~~typescript
test("reports whether both streams are interactive", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const nonInteractive = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    useColor: false,
  });
  assert.equal(nonInteractive.isInteractive, false);
  nonInteractive.close();

  const ttyInput = new PassThrough();
  const ttyOutput = new PassThrough();
  (ttyInput as PassThrough & { isTTY: boolean }).isTTY = true;
  (ttyOutput as PassThrough & { isTTY: boolean }).isTTY = true;
  const interactive = createInputController({
    input: ttyInput,
    output: ttyOutput,
    signal: new AbortController().signal,
    useColor: false,
  });
  assert.equal(interactive.isInteractive, true);
  interactive.close();
});
~~~

- [ ] **Step 4: Add Diff color helpers**

Export from src/terminal-format.ts:

~~~typescript
import stringWidth from "string-width";

export function sanitizeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g,
    "",
  );
}

export function sanitizeTerminalLabel(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function wrapTerminalLine(
  line: string,
  columns: number | undefined,
): string[] {
  const width = Math.max(1, columns ?? 100);
  const result: string[] = [];
  let current = "";
  for (const character of line) {
    if (current && stringWidth(current + character) > width) {
      result.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

export function styleDiffLine(line: string, color: boolean): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return paint(line, [ANSI.bold, ANSI.cyanBright], color);
  }
  if (line.startsWith("+")) {
    return paint(line, [ANSI.greenBright], color);
  }
  if (line.startsWith("-")) {
    return paint(line, [ANSI.redBright], color);
  }
  return paint(line, [], color);
}
~~~

Append to test/terminal-format.test.ts:

~~~typescript
test("styles diff lines and wraps raw text before color is applied", () => {
  assert.match(styleDiffLine("+added", true), /\u001b\[92m/);
  assert.match(styleDiffLine("-removed", true), /\u001b\[91m/);
  assert.match(styleDiffLine("@@ hunk @@", true), /\u001b\[96m/);
  assert.doesNotMatch(styleDiffLine("+added", false), /\u001b/);
  assert.deepEqual(wrapTerminalLine("abcdefgh", 4), ["abcd", "efgh"]);
  assert.equal(sanitizeTerminalText("safe\u001b[31m"), "safe[31m");
  assert.equal(sanitizeTerminalLabel("a\nb"), "a\\nb");
});
~~~

Add styleDiffLine, wrapTerminalLine, sanitizeTerminalText, and sanitizeTerminalLabel to that test file's import list.

- [ ] **Step 5: Write ToolInteraction tests**

Create test/tool-interaction.test.ts:

~~~typescript
import assert from "node:assert/strict";
import test from "node:test";

import { createToolInteraction } from "../src/tool-interaction.js";

test("renders an inline diff, pauses activity, and accepts only y", async () => {
  let output = "";
  let paused = 0;
  const answers = ["y"];
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask() { return answers.shift(); },
      async askSecret() { return "secret"; },
      close() {},
    },
    activity: {
      handle() {},
      pause() { paused += 1; },
      dispose() {},
    },
    output: { write(chunk: string) { output += chunk; } },
    useColor: false,
  });

  assert.equal(await interaction.confirmMutation({
    kind: "edit",
    path: "src/a.ts",
    patch: "--- a\n+++ a\n-x\n+y\n",
    changedLines: 2,
  }), true);
  assert.equal(paused, 1);
  assert.match(output, /Coffee 准备修改 src\/a\.ts/);
  assert.match(output, /-x\n\+y/);
});

test("non-interactive input denies writes and secrets", async () => {
  const interaction = createToolInteraction({
    input: {
      isInteractive: false,
      async ask() { throw new Error("must not ask"); },
      async askSecret() { throw new Error("must not ask"); },
      close() {},
    },
    activity: { handle() {}, pause() {}, dispose() {} },
    output: { write() {} },
    useColor: false,
  });

  assert.equal(await interaction.confirmMutation({
    kind: "write",
    path: "a.ts",
    patch: "patch",
    changedLines: 1,
  }), false);
  assert.equal(
    await interaction.requestSecret({ path: ".env", key: "TOKEN" }),
    undefined,
  );
});
~~~

- [ ] **Step 6: Implement the local interaction adapter**

Create src/tool-interaction.ts:

~~~typescript
import type { ActivityRenderer } from "./activity-indicator.js";
import type { InputController } from "./chat-input.js";
import {
  sanitizeTerminalLabel,
  sanitizeTerminalText,
  styleDiffLine,
  wrapTerminalLine,
} from "./terminal-format.js";
import type { ToolInteraction } from "./code-tools/types.js";

interface InteractionOutput {
  write(chunk: string): unknown;
  columns?: number;
}

export function createToolInteraction({
  input,
  activity,
  output,
  useColor,
}: {
  input: InputController;
  activity: ActivityRenderer;
  output: InteractionOutput;
  useColor: boolean;
}): ToolInteraction {
  async function confirm(
    message: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!input.isInteractive) return false;
    signal?.throwIfAborted();
    activity.pause();
    const answer = await input.ask(message + " [y/N] ", false);
    signal?.throwIfAborted();
    return answer?.trim().toLowerCase() === "y";
  }

  return {
    async authorizeProtected(request, signal) {
      const safePath = sanitizeTerminalLabel(request.path);
      const safeReason = sanitizeTerminalLabel(request.reason);
      return await confirm(
        "Coffee 想" +
          (request.operation === "read" ? "读取" : "修改") +
          "受保护路径：" + safePath +
          "\n原因：" + safeReason +
          "\n仅允许本次操作？",
        signal,
      );
    },
    async confirmMutation(preview, signal) {
      if (!input.isInteractive) return false;
      activity.pause();
      output.write(
        "\nCoffee 准备修改 " +
          sanitizeTerminalLabel(preview.path) +
          "\n\n",
      );
      const safePatch = sanitizeTerminalText(preview.patch);
      output.write(
        safePatch
          .split("\n")
          .flatMap((line) => wrapTerminalLine(line, output.columns))
          .map((line) => styleDiffLine(line, useColor))
          .join("\n") + "\n",
      );
      return await confirm("确认修改？", signal);
    },
    async requestSecret(request, signal) {
      if (!input.isInteractive) return undefined;
      signal?.throwIfAborted();
      activity.pause();
      const value = await input.askSecret(
        "请输入 " +
          sanitizeTerminalLabel(request.key) +
          "（" +
          sanitizeTerminalLabel(request.path) +
          "）: ",
      );
      signal?.throwIfAborted();
      return value;
    },
  };
}
~~~

- [ ] **Step 7: Add n, Enter, Escape, Ctrl+C, color, and control-character tests**

Append to test/tool-interaction.test.ts:

~~~typescript
for (const answer of ["n", "", "\u001b"]) {
  test("rejects non-y confirmation answer " + JSON.stringify(answer), async () => {
    const interaction = createToolInteraction({
      input: {
        isInteractive: true,
        async ask() { return answer; },
        async askSecret() { return undefined; },
        close() {},
      },
      activity: { handle() {}, pause() {}, dispose() {} },
      output: { write() {} },
      useColor: false,
    });
    assert.equal(await interaction.confirmMutation({
      kind: "edit",
      path: "a.ts",
      patch: "patch",
      changedLines: 1,
    }), false);
  });
}

test("aborted confirmation propagates AbortError", async () => {
  const controller = new AbortController();
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask() {
        controller.abort();
        return "y";
      },
      async askSecret() { return undefined; },
      close() {},
    },
    activity: { handle() {}, pause() {}, dispose() {} },
    output: { write() {} },
    useColor: false,
  });

  await assert.rejects(
    interaction.confirmMutation({
      kind: "edit",
      path: "a.ts",
      patch: "patch",
      changedLines: 1,
    }, controller.signal),
    (error) => (error as Error).name === "AbortError",
  );
});

test("sanitizes path and patch controls before writing to the terminal", async () => {
  let output = "";
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask() { return "n"; },
      async askSecret() { return undefined; },
      close() {},
    },
    activity: { handle() {}, pause() {}, dispose() {} },
    output: { write(chunk: string) { output += chunk; }, columns: 40 },
    useColor: false,
  });

  await interaction.confirmMutation({
    kind: "edit",
    path: "bad\u001b[31m.ts",
    patch: "--- a\n+++ a\n+\u001b[31mred\n",
    changedLines: 1,
  });

  assert.doesNotMatch(output, /\u001b/);
});
~~~

Run:

~~~bash
node --import tsx --test test/activity-indicator.test.ts test/chat-input.test.ts test/terminal-format.test.ts test/tool-interaction.test.ts
npm run check
~~~

Expected: all TUI, input, color, pause, cleanup, and cancellation tests pass.

### Task 9: Register code tools and wire them through Conversation and CLI

**Files:**

- Create: src/code-tools/index.ts
- Modify: src/tools.ts
- Modify: src/agent.ts
- Modify: src/cli.ts
- Modify: test/tools.test.ts
- Modify: test/agent.test.ts
- Modify: test/cli.test.ts

- [ ] **Step 1: Build one code-tool factory**

Create src/code-tools/index.ts:

~~~typescript
import type { RegisteredTool } from "../tool-registry.js";
import { createEnvTool } from "./env-tool.js";
import { createMutationTools } from "./mutation-tools.js";
import { createReadTools } from "./read-tools.js";
import { createSearchTools } from "./search-tools.js";
import {
  DEFAULT_TOOL_INTERACTION,
  type ToolInteraction,
} from "./types.js";
import { createWorkspacePolicy } from "./workspace-policy.js";

export function createCodeTools({
  workspaceRoot,
  interaction = DEFAULT_TOOL_INTERACTION,
}: {
  workspaceRoot: string;
  interaction?: ToolInteraction;
}): RegisteredTool[] {
  const policy = createWorkspacePolicy(workspaceRoot);
  return [
    ...createReadTools({ policy, interaction }),
    ...createSearchTools({ policy, interaction }),
    ...createMutationTools({ policy, interaction }),
    createEnvTool({ policy, interaction }),
  ];
}
~~~

- [ ] **Step 2: Write a registry integration test**

Append to test/tools.test.ts:

~~~typescript
test("registers provider-neutral code tools when a workspace is supplied", () => {
  const tools = createTools({
    tavilyApiKey: "tvly-test",
    workspaceRoot: process.cwd(),
  });
  const names = tools.definitions.map((definition) => definition.name);
  for (const name of ["ls", "find", "grep", "read", "edit", "write", "set_env"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(tools.getRiskLevel("read"), "read");
  assert.equal(tools.getRiskLevel("edit"), "write");
  assert.equal(tools.getRiskLevel("set_env"), "write");
});
~~~

Run the focused test and expect FAIL because createTools does not yet accept workspaceRoot.

- [ ] **Step 3: Extend the existing tool registry options**

Modify src/tools.ts:

~~~typescript
import { createCodeTools } from "./code-tools/index.js";
import type { ToolInteraction } from "./code-tools/types.js";

interface ToolOptions {
  tavilyApiKey: string;
  fetchImpl?: FetchLike;
  workspaceRoot?: string;
  toolInteraction?: ToolInteraction;
}
~~~

Replace the createTools signature with:

~~~typescript
export function createTools({
  tavilyApiKey,
  fetchImpl = fetch,
  workspaceRoot,
  toolInteraction,
}: ToolOptions): ToolRegistry {
~~~

At the end of createTools, before createToolRegistry:

~~~typescript
if (workspaceRoot) {
  registeredTools.push(
    ...createCodeTools({
      workspaceRoot,
      interaction: toolInteraction,
    }),
  );
}
return createToolRegistry(registeredTools);
~~~

Existing calls without workspaceRoot must preserve the old four-tool registry.

- [ ] **Step 4: Write Conversation tool-definition and prompt tests**

Extend conversationOptions test overrides with toolInteraction?: ToolInteraction and import that type. Replace the existing workspace-context test with:

~~~typescript
test("includes workspace code tools and accurate capability text", async () => {
  const gateway = createFakeGateway([reply("ok")]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      workspaceRoot: "/Users/test/shop-api",
    }),
  );

  await conversation.send("检查项目");

  const request = gateway.requests[0]!;
  const systemMessage = request.messages[0]!;
  const names = request.tools.map((tool) => tool.name);
  for (const name of ["ls", "find", "grep", "read", "edit", "write", "set_env"]) {
    assert.ok(names.includes(name), name);
  }
assert.match(systemMessage.content, /当前工作区/);
assert.match(systemMessage.content, /read、ls、find、grep、edit、write、set_env/);
assert.doesNotMatch(systemMessage.content, /当前版本没有本地文件工具/);
});
~~~

Extend the fs/promises, os, and path imports in test/agent.test.ts, then append the history leakage regression:

~~~typescript
test("set_env secret is absent from committed Conversation messages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "secret-only-in-local-file";
  const session = createFakeSession();
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-env",
        name: "set_env",
        argumentsJson: '{"path":".env","key":"TOKEN"}',
      }],
    }),
    reply("已经设置"),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    workspaceRoot: root,
    toolInteraction: {
      async authorizeProtected() { return true; },
      async requestSecret() { return secret; },
      async confirmMutation() { return true; },
    },
  }));

  assert.equal(await conversation.send("设置 TOKEN"), "已经设置");

  assert.doesNotMatch(JSON.stringify(session.commits), /secret-only-in-local-file/);
  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "TOKEN=secret-only-in-local-file\n",
  );
});
~~~

- [ ] **Step 5: Pass ToolInteraction through ConversationOptions**

Modify src/agent.ts:

~~~typescript
import type { ToolInteraction } from "./code-tools/types.js";

export interface ConversationOptions {
  initialModel?: ModelDefinition;
  gateway: ModelGateway;
  resolveApiKey(
    credentialId: CredentialId,
  ): Promise<string | undefined>;
  tavilyApiKey?: string;
  fetchImpl?: FetchLike;
  session?: ConversationSession;
  historyPreferences?: HistoryPreferences;
  workspaceRoot?: string;
  toolInteraction?: ToolInteraction;
}
~~~

Destructure toolInteraction and call:

~~~typescript
const tools = createTools({
  tavilyApiKey: normalizedTavilyApiKey,
  fetchImpl,
  workspaceRoot,
  toolInteraction,
});
~~~

Replace the old “没有本地文件工具” suffix with:

~~~typescript
return root
  ? SYSTEM_PROMPT + "\n\n运行环境：\n" +
      "- 当前工作区：" + JSON.stringify(root) + "\n" +
      "- 可用本地工具：read、ls、find、grep、edit、write、set_env。\n" +
      "- 修改前先读取文件；优先使用小范围 edit。\n" +
      "- 没有 bash、自动测试或构建能力，不要声称执行过这些操作。\n" +
      "- 工具失败或用户拒绝时必须如实说明。"
  : SYSTEM_PROMPT;
~~~

- [ ] **Step 6: Reorder CLI initialization and inject local interaction**

In src/cli.ts import createToolInteraction. Inside the existing try block, construct AbortController and InputController before Conversation:

~~~typescript
const abortController = new AbortController();
const inputController = createInputController({
  input,
  output,
  signal: abortController.signal,
  useColor,
});
cleanupInput = inputController;

const toolInteraction = createToolInteraction({
  input: inputController,
  activity: activityRenderer,
  output,
  useColor,
});

const conversation: Conversation = createConversation({
  gateway,
  resolveApiKey,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  session: sessionManager,
  historyPreferences: loadedHistoryPreferences.preferences,
  workspaceRoot,
  toolInteraction,
});
~~~

Keep the existing one-time SIGINT handler attached to the same AbortController. Delete only the superseded later InputController/AbortController construction; do not change unrelated command handling or cleanup order.

- [ ] **Step 7: Add CLI regression assertions**

Add these assertions to the existing slash-exit and SIGINT tests in test/cli.test.ts:

~~~typescript
assert.match(result.stdout, /Workspace: /);
assert.doesNotMatch(result.stderr, /AbortError|node:internal\/readline/);
~~~

The non-TTY write denial is covered directly in test/tool-interaction.test.ts, where an attempted prompt throws if called. The no-secret persistence path is covered in the new Conversation commit test from Step 4. Do not duplicate either behavior through a networked CLI fixture.

Run:

~~~bash
node --import tsx --test test/cli.test.ts
~~~

Expected: /exit and both idle/active SIGINT cases exit with code 0, no signal, and no readline stack.

- [ ] **Step 8: Run integration tests and type check**

Run:

~~~bash
node --import tsx --test test/tools.test.ts test/agent.test.ts test/cli.test.ts
npm run check
~~~

Expected: tool names, risk levels, prompt, CLI injection, non-TTY denial, SIGINT, and history integration tests pass.

### Task 10: Document and verify the complete feature

**Files:**

- Modify: README.md
- Verify: every source and test file listed above

- [ ] **Step 1: Document code tools and safety behavior**

Add a concise README section with:

~~~markdown
## 本地代码工具

在项目目录执行 coffee 后，Coffee 将当前 Git 仓库根目录作为工作区，并可使用：

- read / ls / find / grep：读取和搜索文本代码
- edit：使用 path + edits[] 精确修改已有文件
- write：只创建新文件，不覆盖
- set_env：在本地隐藏输入 .env* 变量值

edit、write 和 set_env 都会显示行内 Diff，并等待 y 确认。回车、n、Ctrl+C、非交互终端都会拒绝修改。Coffee 不提供 bash、删除或重命名工具，也不能访问工作区外、.git、私钥和二进制文件。
~~~

- [ ] **Step 2: Run every new focused suite together**

Run:

~~~bash
node --import tsx --test \
  test/code-tool-types.test.ts \
  test/workspace-policy.test.ts \
  test/text-file-tools.test.ts \
  test/search-tools.test.ts \
  test/edit-diff.test.ts \
  test/mutation-tools.test.ts \
  test/env-tool.test.ts \
  test/tool-interaction.test.ts
~~~

Expected: all new tests pass with zero failures.

- [ ] **Step 3: Run all affected existing suites**

Run:

~~~bash
node --import tsx --test \
  test/activity-indicator.test.ts \
  test/chat-input.test.ts \
  test/terminal-format.test.ts \
  test/tool-registry.test.ts \
  test/tools.test.ts \
  test/agent.test.ts \
  test/cli.test.ts \
  test/history-store.test.ts \
  test/history-sqlite.test.ts
~~~

Expected: all affected existing tests pass with zero failures.

- [ ] **Step 4: Run the complete project gates**

Run:

~~~bash
npm test
npm run check
~~~

Expected: the entire test suite passes and TypeScript reports no errors.

- [ ] **Step 5: Perform a manual TTY smoke test in a disposable workspace**

Run:

~~~bash
workspace="$(mktemp -d)"
cd "$workspace"
git init --quiet
printf 'export const value = 1;\n' > example.ts
coffee
~~~

In Coffee:

~~~text
请把 example.ts 中的 value 改成 2
~~~

Verify the colored inline Diff appears. First answer n and confirm the file stays unchanged. Ask again, answer y, and confirm the file changes to value = 2. Then ask Coffee to read ../outside.txt and confirm the tool reports a workspace denial. Exit with Ctrl+C and confirm there is no stack trace.

- [ ] **Step 6: Inspect the disposable workspace for leftovers**

Run:

~~~bash
find "$workspace" -name '*.coffee-*.tmp' -o -name '*.lock'
rm -rf "$workspace"
~~~

Expected: find prints nothing before cleanup.

## Completion checklist

- [ ] Tool definitions are provider-neutral and available through every configured model adapter.
- [ ] All path access flows through WorkspacePolicy.
- [ ] Protected paths require per-operation access approval.
- [ ] Every edit/write/set_env mutation shows a complete bounded Diff.
- [ ] Revalidation prevents approval-time races.
- [ ] Atomic persistence never overwrites a new-file target.
- [ ] Dotenv values never appear in arguments, results, terminal Diff, events, or SQLite history.
- [ ] Non-TTY and Ctrl+C paths cannot write.
- [ ] No bash/delete/rename/test-runner tools were added.
- [ ] npm test and npm run check pass.
