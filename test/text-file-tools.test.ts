import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createReadTools } from "../src/code-tools/read-tools.js";
import {
  assertSafeTextContent,
  parseEnvStructure,
  readTextFile,
} from "../src/code-tools/text-files.js";
import {
  LS_MAX_ENTRIES,
  OUTPUT_MAX_BYTES,
  READ_MAX_FILE_BYTES,
  READ_MAX_LINES,
  type ToolInteraction,
} from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

const execFileAsync = promisify(execFile);

function byName(tools: ReturnType<typeof createReadTools>, name: "ls" | "read") {
  const tool = tools.find((value) => value.definition.name === name);
  assert.ok(tool);
  return tool;
}

function allowProtected(
  authorizeProtected: ToolInteraction["authorizeProtected"],
): ToolInteraction {
  return {
    authorizeProtected,
    async confirmMutation() {
      return false;
    },
    async requestSecret() {
      return undefined;
    },
  };
}

test("read returns numbered UTF-8 lines and a continuation offset", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "one\ntwo\nthree\n");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  assert.deepEqual(
    await byName(tools, "read").execute({
      path: "src/a.ts",
      offset: 2,
      limit: 1,
    }),
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
  await writeFile(path.join(root, "nul.bin"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
  await writeFile(
    path.join(root, "key.pem"),
    "-----BEGIN PRIVATE KEY-----\ndo-not-echo-this-secret\n",
  );
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  for (const file of ["nul.bin", "invalid.bin", "key.pem"]) {
    const result = await read.execute({ path: file });
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /do-not-echo-this-secret/);
  }
});

test("read blocks encrypted, DSA, and PGP private-key markers case-insensitively", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-more-keys-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const markers = [
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN DSA PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "-----begin encrypted private key-----",
  ];
  for (const [index, marker] of markers.entries()) {
    await writeFile(
      path.join(root, `key-${index}.pem`),
      `${marker}\nprivate-body-${index}\n`,
    );
  }
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  for (const index of markers.keys()) {
    const result = await read.execute({ path: `key-${index}.pem` });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PATH_DENIED");
    assert.doesNotMatch(JSON.stringify(result), /private-body/);
  }
});

test("ls hides protected entries and sorts visible entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(os.tmpdir(), "coffee-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await writeFile(path.join(root, "z.ts"), "");
  await writeFile(path.join(root, "a.ts"), "");
  await symlink(outside, path.join(root, "escape"));
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  const result = await byName(tools, "ls").execute({});

  assert.deepEqual(result, {
    ok: true,
    path: ".",
    entries: ["a.ts", "z.ts"],
    truncated: false,
  });
});

test("ls can list only the explicitly authorized protected subtree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-protected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "dist", "private"), { recursive: true });
  const requests: string[] = [];
  const tools = createReadTools({
    policy: createWorkspacePolicy(root),
    interaction: allowProtected(async (request) => {
      requests.push(request.path);
      return request.path === "node_modules";
    }),
  });

  const rootResult = await byName(tools, "ls").execute({});
  const protectedResult = await byName(tools, "ls").execute({
    path: "node_modules",
  });

  assert.deepEqual(rootResult.entries, []);
  assert.deepEqual(protectedResult.entries, ["node_modules/pkg/"]);
  assert.deepEqual(requests, ["node_modules"]);
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

test("dotenv structure output cannot exceed the shared byte budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = Array.from(
    { length: 4_000 },
    (_, index) => `LONG_ENVIRONMENT_KEY_${String(index).padStart(4, "0")}=hidden`,
  );
  await writeFile(path.join(root, ".env"), `${lines.join("\n")}\n`);
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  const result = await read.execute({ path: ".env" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LIMIT_EXCEEDED");
  assert.doesNotMatch(JSON.stringify(result), /hidden/);
});

test("read-tool registrations use explicit read-only schemas", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  assert.deepEqual(tools.map((tool) => tool.definition.name), ["ls", "read"]);
  for (const tool of tools) {
    assert.equal(tool.riskLevel, "read");
    assert.equal(tool.definition.inputSchema.additionalProperties, false);
    assert.equal(tool.definition.inputSchema.type, "object");
  }
  assert.deepEqual(
    byName(tools, "read").definition.inputSchema.required,
    ["path"],
  );
  const readSchema = byName(tools, "read").definition.inputSchema as {
    properties: { path: Record<string, unknown> };
  };
  assert.equal(readSchema.properties.path.minLength, 1);
});

test("read and ls reject unknown arguments and blank read paths at runtime", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-unknown-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.txt"), "safe\n");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  for (const [name, args] of [
    ["read", { path: "a.txt", extra: true }],
    ["ls", { extra: true }],
    ["read", { path: "" }],
    ["read", { path: "   " }],
  ] as const) {
    const result = await byName(tools, name).execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
  }
});

test("text inspection preserves BOM, mode, and the predominant line ending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-text-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "mixed.txt");
  await writeFile(filePath, "\uFEFFone\r\ntwo\r\nthree\n", { mode: 0o640 });

  const file = await readTextFile(filePath);

  assert.equal(file.bom, "\uFEFF");
  assert.equal(file.text, "one\r\ntwo\r\nthree\n");
  assert.equal(file.lineEnding, "\r\n");
  assert.equal(file.mode, 0o640);
  assert.equal(file.bytes.equals(Buffer.from("\uFEFFone\r\ntwo\r\nthree\n")), true);
});

test("readTextFile enforces its byte limit before returning content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-text-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "large.txt");
  await writeFile(filePath, "four");

  await assert.rejects(readTextFile(filePath, 3), (error) => {
    assert.equal((error as { code?: unknown }).code, "LIMIT_EXCEEDED");
    return true;
  });
  assert.equal((await readTextFile(filePath, 4)).text, "four");
  const emptyPath = path.join(root, "empty.txt");
  await writeFile(emptyPath, "");
  assert.equal((await readTextFile(emptyPath, 0)).text, "");
});

test(
  "readTextFile rejects a FIFO without waiting for a writer",
  { skip: process.platform === "win32" ? "POSIX FIFO only" : false },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coffee-fifo-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fifoPath = path.join(root, "input.pipe");
    try {
      await execFileAsync("mkfifo", [fifoPath]);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        t.skip("mkfifo is unavailable");
        return;
      }
      throw error;
    }

    const moduleUrl = new URL(
      "../src/code-tools/text-files.ts",
      import.meta.url,
    ).href;
    const script = `
      import { readTextFile } from ${JSON.stringify(moduleUrl)};
      try {
        await readTextFile(${JSON.stringify(fifoPath)}, 1024);
        console.log(JSON.stringify({ ok: true }));
      } catch (error) {
        console.log(JSON.stringify({
          ok: false,
          code: error?.code,
          error: error?.message,
        }));
      }
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const completed = await new Promise<{
      code: number | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 750);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut });
      });
    });

    assert.equal(
      completed.timedOut,
      false,
      `FIFO read blocked waiting for a writer. stderr: ${stderr}`,
    );
    assert.equal(completed.code, 0, stderr);
    const result = JSON.parse(stdout.trim()) as Record<string, unknown>;
    assert.equal(result.ok, false);
    assert.equal(result.code, "PATH_DENIED");
    assert.match(String(result.error), /不是普通文件/);
  },
);

test("read and dotenv inspection reject files above the shared input cap", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-input-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oversized = Buffer.alloc(READ_MAX_FILE_BYTES + 1, 0x61);
  await writeFile(path.join(root, "large.txt"), oversized);
  await writeFile(path.join(root, ".env"), oversized);
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  for (const file of ["large.txt", ".env"]) {
    const result = await read.execute({ path: file });
    assert.equal(result.ok, false);
    assert.equal(result.code, "LIMIT_EXCEEDED");
    assert.match(String(result.error), /文件超过允许的大小/);
  }
});

test("private-key markers are all rejected without including file content", () => {
  for (const kind of ["", "RSA ", "EC ", "OPENSSH "]) {
    const secret = `-----BEGIN ${kind}PRIVATE KEY-----\nhidden-value`;
    assert.throws(() => assertSafeTextContent(secret), (error) => {
      assert.equal((error as { code?: unknown }).code, "PATH_DENIED");
      assert.doesNotMatch(String((error as Error).message), /hidden-value/);
      return true;
    });
  }
});

test("dotenv parsing accepts comments and export while reporting structure only", () => {
  assert.deepEqual(
    parseEnvStructure(
      "# comment\nexport TOKEN=value\nEMPTY=\"\"\nEMPTY_TWO=''\n9INVALID=x\n",
    ),
    {
      entries: [
        { key: "TOKEN", lineIndex: 1, empty: false },
        { key: "EMPTY", lineIndex: 2, empty: true },
        { key: "EMPTY_TWO", lineIndex: 3, empty: true },
      ],
      invalidLines: [5],
      duplicateKeys: [],
    },
  );
});

test("dotenv value scanning handles comments, quoted hashes, and malformed quotes", () => {
  const result = parseEnvStructure(
    "A= # comment\nB=\"\" # comment\n" +
      "D=\"contains # safely\" # comment\nE='closed' trailing\n" +
      "C=\"unterminated",
  );

  assert.deepEqual(result, {
    entries: [
      { key: "A", lineIndex: 0, empty: true },
      { key: "B", lineIndex: 1, empty: true },
      { key: "D", lineIndex: 2, empty: false },
    ],
    invalidLines: [4, 5],
    duplicateKeys: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /contains|unterminated|closed/);
});

test("read normalizes CRLF and validates offset and limit as bounded integers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.txt"), "one\r\ntwo\r\n");
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  assert.deepEqual(await read.execute({ path: "a.txt", limit: 2 }), {
    ok: true,
    path: "a.txt",
    content: "1: one\n2: two",
    truncated: false,
  });
  for (const args of [
    { path: "a.txt", offset: 1.5 },
    { path: "a.txt", offset: 0 },
    { path: "a.txt", limit: "1" },
    { path: "a.txt", limit: 0 },
    { path: "a.txt", limit: READ_MAX_LINES + 1 },
  ]) {
    const result = await read.execute(args);
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
  }
});

test("read does not invent a line at EOF and preserves a real trailing blank line", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-eof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "two.txt"), "one\ntwo\n");
  await writeFile(path.join(root, "blank.txt"), "one\n\n");
  await writeFile(path.join(root, "empty.txt"), "");
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  assert.deepEqual(await read.execute({ path: "two.txt", limit: 1 }), {
    ok: true,
    path: "two.txt",
    content: "1: one",
    truncated: true,
    nextOffset: 2,
  });
  assert.deepEqual(
    await read.execute({ path: "two.txt", offset: 2, limit: 1 }),
    {
      ok: true,
      path: "two.txt",
      content: "2: two",
      truncated: false,
    },
  );
  assert.deepEqual(await read.execute({ path: "blank.txt" }), {
    ok: true,
    path: "blank.txt",
    content: "1: one\n2: ",
    truncated: false,
  });
  assert.deepEqual(await read.execute({ path: "empty.txt" }), {
    ok: true,
    path: "empty.txt",
    content: "",
    truncated: false,
  });
});

test("read rejects a single line that cannot fit the output byte limit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "long.txt"), "x".repeat(OUTPUT_MAX_BYTES));
  const read = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "read",
  );

  const result = await read.execute({ path: "long.txt" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "LIMIT_EXCEEDED");
});

test("ls validates its limit and marks entry-count truncation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    await writeFile(path.join(root, name), "");
  }
  const ls = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "ls",
  );

  assert.deepEqual(await ls.execute({ limit: 2 }), {
    ok: true,
    path: ".",
    entries: ["a.ts", "b.ts"],
    truncated: true,
  });
  for (const limit of [0, 1.5, "2", LS_MAX_ENTRIES + 1]) {
    const result = await ls.execute({ limit });
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_ARGUMENT");
  }
});

test("ls never exceeds the output byte budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let index = 0; index < 300; index += 1) {
    const name = `${String(index).padStart(3, "0")}-${"x".repeat(190)}`;
    await writeFile(path.join(root, name), "");
  }
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });
  const ls = byName(createReadTools({ policy }), "ls");

  const result = await ls.execute({});

  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.ok(Array.isArray(result.entries));
  assert.ok(result.entries.length <= LS_MAX_ENTRIES);
  assert.ok(Buffer.byteLength(result.entries.join("\n")) <= OUTPUT_MAX_BYTES);
});

test("protected reads require authorization and pass through its signal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-protected-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "report.txt"), "safe\n");
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });
  const deniedRead = byName(createReadTools({ policy }), "read");

  assert.deepEqual(await deniedRead.execute({ path: "dist/report.txt" }), {
    ok: false,
    code: "USER_REJECTED",
    error: "用户未授权读取。",
  });

  const controller = new AbortController();
  const abortError = new DOMException("Aborted", "AbortError");
  const abortingRead = byName(
    createReadTools({
      policy,
      interaction: allowProtected(async (request, signal) => {
        assert.equal(request.path, "dist/report.txt");
        assert.equal(signal, controller.signal);
        throw abortError;
      }),
    }),
    "read",
  );
  await assert.rejects(
    abortingRead.execute({ path: "dist/report.txt" }, controller.signal),
    (error) => error === abortError,
  );
});

test("read and ls rethrow a custom cancellation reason from interaction", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-custom-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "report.txt"), "safe\n");
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });

  for (const name of ["read", "ls"] as const) {
    const controller = new AbortController();
    const reason = { tool: name, kind: "custom-cancel" };
    const tool = byName(
      createReadTools({
        policy,
        interaction: allowProtected(async (_request, signal) => {
          assert.equal(signal, controller.signal);
          controller.abort(reason);
          return true;
        }),
      }),
      name,
    );

    await assert.rejects(
      tool.execute(
        name === "read" ? { path: "dist/report.txt" } : { path: "dist" },
        controller.signal,
      ),
      (error) => error === reason,
    );
  }
});

test("an already-aborted signal escapes both handlers", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-aborted-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "a.txt"), "safe\n");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });
  const controller = new AbortController();
  controller.abort();

  for (const name of ["ls", "read"] as const) {
    await assert.rejects(
      byName(tools, name).execute(
        name === "read" ? { path: "a.txt" } : {},
        controller.signal,
      ),
      (error) => (error as Error).name === "AbortError",
    );
  }
});

test("missing paths and file-directory misuse fail safely", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-read-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "directory"));
  await writeFile(path.join(root, "file.txt"), "safe\n");
  const tools = createReadTools({ policy: createWorkspacePolicy(root) });

  assert.equal(
    (await byName(tools, "read").execute({ path: "missing.txt" })).code,
    "NOT_FOUND",
  );
  assert.equal(
    (await byName(tools, "ls").execute({ path: "missing" })).code,
    "NOT_FOUND",
  );
  assert.equal(
    (await byName(tools, "read").execute({ path: "directory" })).code,
    "PATH_DENIED",
  );
  assert.equal(
    (await byName(tools, "ls").execute({ path: "file.txt" })).code,
    "PATH_DENIED",
  );
});

test("environment directories cannot be listed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".env.d"));
  const ls = byName(
    createReadTools({ policy: createWorkspacePolicy(root) }),
    "ls",
  );

  const result = await ls.execute({ path: ".env.d" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATH_DENIED");
});

test("protected authorization does not expose another protected root via symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-protected-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await mkdir(path.join(root, "dist", "private"), { recursive: true });
  await symlink(
    path.join(root, "dist", "private"),
    path.join(root, "node_modules", "other-protected-root"),
  );
  const policy = createWorkspacePolicy(root, { isIgnored: async () => false });
  const tools = createReadTools({
    policy,
    interaction: allowProtected(async () => true),
  });

  const result = await byName(tools, "ls").execute({ path: "node_modules" });

  assert.deepEqual(result.entries, ["node_modules/pkg/"]);
});

test("read remains bound to a canonical target when an alias changes during authorization", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coffee-read-alias-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const outside = path.join(parent, "outside.txt");
  const alias = path.join(root, "report-link");
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist", "report.txt"), "verified-inside\n");
  await writeFile(outside, "outside-secret\n");
  await symlink(path.join(root, "dist", "report.txt"), alias);
  const read = byName(
    createReadTools({
      policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
      interaction: allowProtected(async () => {
        await rm(alias);
        await symlink(outside, alias);
        return true;
      }),
    }),
    "read",
  );

  const result = await read.execute({ path: "report-link" });

  assert.deepEqual(result, {
    ok: true,
    path: "report-link",
    content: "1: verified-inside",
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /outside-secret/);
});

test("read keeps the opened internal leaf when its path is replaced during authorization", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coffee-read-leaf-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const target = path.join(root, "dist", "report.txt");
  const outside = path.join(parent, "outside.txt");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "verified-inside\n");
  await writeFile(outside, "outside-secret\n");
  const read = byName(
    createReadTools({
      policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
      interaction: allowProtected(async () => {
        await rm(target);
        await symlink(outside, target);
        return true;
      }),
    }),
    "read",
  );

  const result = await read.execute({ path: "dist/report.txt" });

  assert.deepEqual(result, {
    ok: true,
    path: "dist/report.txt",
    content: "1: verified-inside",
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /outside-secret/);
});

test("read keeps the opened internal file when its canonical parent is replaced", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coffee-read-parent-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const dist = path.join(root, "dist");
  const movedDist = path.join(root, "dist-inside");
  const outside = path.join(parent, "outside");
  await mkdir(dist, { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(dist, "report.txt"), "verified-inside\n");
  await writeFile(path.join(outside, "report.txt"), "outside-secret\n");
  const read = byName(
    createReadTools({
      policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
      interaction: allowProtected(async () => {
        await rename(dist, movedDist);
        await symlink(outside, dist);
        return true;
      }),
    }),
    "read",
  );

  const result = await read.execute({ path: "dist/report.txt" });

  assert.deepEqual(result, {
    ok: true,
    path: "dist/report.txt",
    content: "1: verified-inside",
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /outside-secret/);
});

test("ls safely fails when its protected parent is replaced during authorization", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "coffee-ls-parent-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  const protectedDirectory = path.join(root, "node_modules");
  const movedDirectory = path.join(root, "node_modules-inside");
  const outside = path.join(parent, "outside");
  await mkdir(path.join(protectedDirectory, "pkg"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "outside-secret.txt"), "outside-secret\n");
  const ls = byName(
    createReadTools({
      policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
      interaction: allowProtected(async () => {
        await rename(protectedDirectory, movedDirectory);
        await symlink(outside, protectedDirectory);
        return true;
      }),
    }),
    "ls",
  );

  const result = await ls.execute({ path: "node_modules" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PATH_DENIED");
  assert.doesNotMatch(JSON.stringify(result), /outside-secret/);
});
