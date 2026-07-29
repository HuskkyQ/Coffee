import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSearchTools,
  runRipgrep,
  type RgRunner,
} from "../src/code-tools/search-tools.js";
import {
  FIND_MAX_RESULTS,
  GREP_MAX_LINE_LENGTH,
  GREP_MAX_MATCHES,
  OUTPUT_MAX_BYTES,
  type ToolInteraction,
} from "../src/code-tools/types.js";
import {
  createWorkspacePolicy,
  type WorkspacePolicy,
} from "../src/code-tools/workspace-policy.js";

function byName(
  tools: ReturnType<typeof createSearchTools>,
  name: "find" | "grep",
) {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool);
  return tool;
}

async function temporaryWorkspace(
  t: test.TestContext,
  prefix: string,
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function interaction(
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

async function withFakeRg<T>(
  t: test.TestContext,
  source: string,
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await temporaryWorkspace(t, "coffee-fake-rg-");
  const executable = path.join(directory, "rg");
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined
    ? directory
    : `${directory}${path.delimiter}${previousPath}`;
  try {
    return await run(directory);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delayResultResolution(
  base: WorkspacePolicy,
  resultPath: string,
): {
  policy: WorkspacePolicy;
  started: Promise<void>;
  release(): void;
} {
  let markStarted!: () => void;
  let release!: () => void;
  let delayed = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    policy: {
      root: base.root,
      async resolve(requestedPath, operation) {
        if (!delayed && requestedPath === resultPath) {
          delayed = true;
          markStarted();
          await gate;
        }
        return await base.resolve(requestedPath, operation);
      },
    },
    started,
    release,
  };
}

test("find uses an option terminator and filters every rg result through policy", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-find-");
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export {};\n");
  await writeFile(path.join(root, "node_modules", "pkg", "a.ts"), "");
  const calls: Parameters<RgRunner>[] = [];
  const runRg: RgRunner = async (...args) => {
    calls.push(args);
    return {
      lines: ["src/a.ts", "node_modules/pkg/a.ts"],
      truncated: false,
    };
  };
  const find = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg,
  }), "find");

  const result = await find.execute({ pattern: "-danger" });

  assert.deepEqual(calls[0]?.[0], [
    "--files",
    "--hidden",
    "--glob",
    "-danger",
    "--",
    ".",
  ]);
  assert.equal(calls[0]?.[1], await realpath(root));
  assert.deepEqual(result, {
    ok: true,
    path: ".",
    files: ["src/a.ts"],
    truncated: false,
  });
});

test("grep keeps a flag-like literal pattern after -- and parses match/context events", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "before\n--hidden\n");
  const calls: Parameters<RgRunner>[] = [];
  const runRg: RgRunner = async (...args) => {
    calls.push(args);
    return {
      lines: [
        JSON.stringify({
          type: "context",
          data: {
            path: { text: "src/a.ts" },
            lines: { text: "before\n" },
            line_number: 1,
          },
        }),
        JSON.stringify({
          type: "match",
          data: {
            path: { text: "src/a.ts" },
            lines: { text: "--hidden\n" },
            line_number: 2,
          },
        }),
      ],
      truncated: false,
    };
  };
  const grep = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg,
  }), "grep");

  const result = await grep.execute({
    pattern: "--hidden",
    literal: true,
    context: 1,
  });

  const args = calls[0]?.[0] ?? [];
  const terminator = args.lastIndexOf("--");
  assert.deepEqual(args.slice(0, 4), [
    "--json",
    "--color",
    "never",
    "--fixed-strings",
  ]);
  assert.deepEqual(args.slice(terminator), ["--", "--hidden", "."]);
  assert.deepEqual(result, {
    ok: true,
    path: ".",
    matches: [
      { path: "src/a.ts", line: 1, text: "before", kind: "context" },
      { path: "src/a.ts", line: 2, text: "--hidden", kind: "match" },
    ],
    truncated: false,
  });
});

test("find authorization is contained to the selected protected target", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-find-protected-");
  await mkdir(path.join(root, "dist"));
  await mkdir(path.join(root, "build"));
  await writeFile(path.join(root, "dist", "a.js"), "");
  await writeFile(path.join(root, "build", "b.js"), "");
  const requests: string[] = [];
  const runRg: RgRunner = async () => ({
    lines: ["a.js", "../build/b.js"],
    truncated: false,
  });
  const find = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg,
    interaction: interaction(async (request) => {
      requests.push(request.path);
      return request.path === "dist";
    }),
  }), "find");

  const result = await find.execute({ pattern: "*.js", path: "dist" });

  assert.deepEqual(requests, ["dist"]);
  assert.deepEqual(result, {
    ok: true,
    path: "dist",
    files: ["dist/a.js"],
    truncated: false,
  });
});

test("search registrations have exact read-only schemas", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-search-schema-");
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => ({ lines: [], truncated: false }),
  });

  assert.deepEqual(tools.map((tool) => tool.definition.name), ["find", "grep"]);
  for (const tool of tools) {
    assert.equal(tool.riskLevel, "read");
    assert.equal(tool.definition.inputSchema.type, "object");
    assert.equal(tool.definition.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.definition.inputSchema.required, ["pattern"]);
  }
  assert.deepEqual(
    Object.keys((byName(tools, "find").definition.inputSchema as {
      properties: Record<string, unknown>;
    }).properties),
    ["pattern", "path", "limit"],
  );
  assert.deepEqual(
    Object.keys((byName(tools, "grep").definition.inputSchema as {
      properties: Record<string, unknown>;
    }).properties),
    ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
  );
});

test("search runtime rejects unknown, blank, and mistyped arguments", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-search-args-");
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => ({ lines: [], truncated: false }),
  });
  const invalidCases = [
    ["find", {}],
    ["find", { pattern: "   " }],
    ["find", { pattern: 1 }],
    ["find", { pattern: "*", path: false }],
    ["find", { pattern: "*", limit: 0 }],
    ["find", { pattern: "*", limit: FIND_MAX_RESULTS + 1 }],
    ["find", { pattern: "*", extra: true }],
    ["grep", { pattern: "x", literal: "true" }],
    ["grep", { pattern: "x", ignoreCase: 1 }],
    ["grep", { pattern: "x", glob: "   " }],
    ["grep", { pattern: "x", context: -1 }],
    ["grep", { pattern: "x", context: 11 }],
    ["grep", { pattern: "x", limit: GREP_MAX_MATCHES + 1 }],
    ["grep", { pattern: "x", unknown: true }],
  ] as const;

  for (const [name, args] of invalidCases) {
    const result = await byName(tools, name).execute(args);
    assert.equal(result.ok, false, `${name}: ${JSON.stringify(args)}`);
    assert.equal(result.code, "INVALID_ARGUMENT", `${name}: ${JSON.stringify(args)}`);
  }
});

test("search target checks deny env, missing, files for find, and unapproved protected paths", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-search-target-");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await writeFile(path.join(root, "file.txt"), "text\n");
  await mkdir(path.join(root, "dist"));
  const calls: string[] = [];
  const tools = createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => {
      calls.push("rg");
      return { lines: [], truncated: false };
    },
  });

  const cases = [
    ["find", { pattern: "*", path: ".env" }, "PATH_DENIED"],
    ["grep", { pattern: "x", path: ".env" }, "PATH_DENIED"],
    ["find", { pattern: "*", path: "missing" }, "NOT_FOUND"],
    ["grep", { pattern: "x", path: "missing" }, "NOT_FOUND"],
    ["find", { pattern: "*", path: "file.txt" }, "INVALID_ARGUMENT"],
    ["find", { pattern: "*", path: "dist" }, "USER_REJECTED"],
  ] as const;
  for (const [name, args, code] of cases) {
    const result = await byName(tools, name).execute(args);
    assert.equal(result.ok, false, `${name}: ${JSON.stringify(args)}`);
    assert.equal(result.code, code, `${name}: ${JSON.stringify(args)}`);
  }
  assert.deepEqual(calls, []);
});

test("grep composes optional flags before the pattern terminator", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-flags-");
  const calls: Parameters<RgRunner>[] = [];
  const grep = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async (...args) => {
      calls.push(args);
      return { lines: [], truncated: false };
    },
  }), "grep");

  await grep.execute({
    pattern: "needle",
    glob: "*.ts",
    ignoreCase: true,
    literal: true,
    context: 0,
    limit: 7,
  });

  assert.deepEqual(calls[0]?.[0], [
    "--json",
    "--color",
    "never",
    "--fixed-strings",
    "--ignore-case",
    "--glob",
    "*.ts",
    "--context",
    "0",
    "--",
    "needle",
    ".",
  ]);
  assert.equal(calls[0]?.[1], root);
});

test("search passes one signal to interaction and runner and preserves its custom reason", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-search-signal-");
  await mkdir(path.join(root, "dist"));
  const controller = new AbortController();
  const reason = { kind: "stop-search" };
  let interactionSignal: AbortSignal | undefined;
  let runnerSignal: AbortSignal | undefined;
  const find = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    interaction: interaction(async (_request, signal) => {
      interactionSignal = signal;
      return true;
    }),
    runRg: async (_args, _cwd, _maximumLines, signal) => {
      runnerSignal = signal;
      controller.abort(reason);
      throw reason;
    },
  }), "find");

  await assert.rejects(
    find.execute({ pattern: "*", path: "dist" }, controller.signal),
    (error) => error === reason,
  );
  assert.equal(interactionSignal, controller.signal);
  assert.equal(runnerSignal, controller.signal);
});

test("find observes cancellation while filtering a delayed result", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-find-filter-abort-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "");
  const delayed = delayResultResolution(
    createWorkspacePolicy(root, { isIgnored: async () => false }),
    "src/a.ts",
  );
  const find = byName(createSearchTools({
    policy: delayed.policy,
    runRg: async () => ({ lines: ["src/a.ts"], truncated: false }),
  }), "find");
  const controller = new AbortController();
  const reason = { kind: "cancel-find-filter" };

  const pending = find.execute({ pattern: "*.ts" }, controller.signal);
  await delayed.started;
  controller.abort(reason);
  delayed.release();

  await assert.rejects(pending, (error) => error === reason);
});

test("grep observes cancellation while filtering a delayed result", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-filter-abort-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "needle\n");
  const delayed = delayResultResolution(
    createWorkspacePolicy(root, { isIgnored: async () => false }),
    "src/a.ts",
  );
  const grep = byName(createSearchTools({
    policy: delayed.policy,
    runRg: async () => ({
      lines: [JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/a.ts" },
          lines: { text: "needle\n" },
          line_number: 1,
        },
      })],
      truncated: false,
    }),
  }), "grep");
  const controller = new AbortController();
  const reason = { kind: "cancel-grep-filter" };

  const pending = grep.execute({ pattern: "needle" }, controller.signal);
  await delayed.started;
  controller.abort(reason);
  delayed.release();

  await assert.rejects(pending, (error) => error === reason);
});

test("runRipgrep reports RG_UNAVAILABLE when PATH cannot resolve rg", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-rg-missing-");
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(runRipgrep([], root, 10), (error) => {
      assert.equal((error as { code?: unknown }).code, "RG_UNAVAILABLE");
      assert.match((error as Error).message, /系统未安装 rg/);
      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("runRipgrep passes arguments without a shell and accepts exit codes 0 and 1", async (t) => {
  await withFakeRg(t, `
    process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
    process.exitCode = process.argv.includes("exit-one") ? 1 : 0;
  `, async (directory) => {
    const injectedPath = path.join(directory, "injected");
    const args = ["--", `$(touch ${injectedPath})`];
    const success = await runRipgrep(args, directory, 10);
    const noMatch = await runRipgrep(["exit-one"], directory, 10);

    assert.deepEqual(JSON.parse(success.lines[0] ?? "null"), args);
    assert.deepEqual(noMatch.lines, ['["exit-one"]']);
    await assert.rejects(realpath(injectedPath), { code: "ENOENT" });
  });
});

test("runRipgrep rejects other exits without returning stderr", async (t) => {
  await withFakeRg(t, `
    process.stderr.write("sensitive stderr");
    process.exitCode = 2;
  `, async (directory) => {
    await assert.rejects(runRipgrep([], directory, 10), (error) => {
      assert.equal((error as { code?: unknown }).code, "EXECUTION_FAILED");
      assert.doesNotMatch((error as Error).message, /sensitive/);
      return true;
    });
  });
});

test("runRipgrep preserves split UTF-8 characters and a final unterminated line", async (t) => {
  await withFakeRg(t, `
    process.stdout.write(Buffer.from([0xe4]));
    setTimeout(() => {
      process.stdout.write(Buffer.from([0xbd, 0xa0, 0x0a]));
      process.stdout.write("tail");
    }, 20);
  `, async (directory) => {
    const result = await runRipgrep([], directory, 10);
    assert.deepEqual(result, {
      lines: ["你", "tail"],
      truncated: false,
    });
  });
});

test("runRipgrep kills and truncates at the line and byte budgets", async (t) => {
  await withFakeRg(t, `
    const mode = process.argv[2];
    if (mode === "lines") {
      process.stdout.write("one\\ntwo\\nthree\\nfour\\n");
    } else {
      process.stdout.write(Buffer.alloc(${OUTPUT_MAX_BYTES + 10_000}, 120));
    }
    setInterval(() => {}, 1_000);
  `, async (directory) => {
    const lineLimited = await runRipgrep(["lines"], directory, 2);
    const byteLimited = await runRipgrep(["bytes"], directory, 10);

    assert.deepEqual(lineLimited, {
      lines: ["one", "two"],
      truncated: true,
    });
    assert.equal(byteLimited.truncated, true);
    assert.ok(
      Buffer.byteLength(byteLimited.lines.join("\n")) <= OUTPUT_MAX_BYTES,
    );
  });
});

test("runRipgrep stops when output reaches exactly maximumLines", async (t) => {
  await withFakeRg(t, `
    process.stdout.write("one\\ntwo\\n");
    setInterval(() => {}, 1_000);
  `, async (directory) => {
    const controller = new AbortController();
    const timeoutError = new Error("rg did not stop at the exact line limit");
    const timeout = setTimeout(() => controller.abort(timeoutError), 1_000);
    try {
      assert.deepEqual(
        await runRipgrep([], directory, 2, controller.signal),
        { lines: ["one", "two"], truncated: true },
      );
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort(new Error("test cleanup"));
    }
  });
});

test("runRipgrep stops when output reaches exactly OUTPUT_MAX_BYTES", async (t) => {
  await withFakeRg(t, `
    process.stdout.write(Buffer.alloc(${OUTPUT_MAX_BYTES}, 120));
    setInterval(() => {}, 1_000);
  `, async (directory) => {
    const controller = new AbortController();
    const timeoutError = new Error("rg did not stop at the exact byte limit");
    const timeout = setTimeout(() => controller.abort(timeoutError), 1_000);
    try {
      const result = await runRipgrep([], directory, 2, controller.signal);
      assert.equal(result.truncated, true);
      assert.equal(result.lines.length, 1);
      assert.equal(Buffer.byteLength(result.lines[0] ?? ""), OUTPUT_MAX_BYTES);
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted) controller.abort(new Error("test cleanup"));
    }
  });
});

test("runRipgrep rejects a non-positive maximumLines before spawning", async (t) => {
  await withFakeRg(t, `process.exitCode = 0;`, async (directory) => {
    for (const maximumLines of [0, -1]) {
      await assert.rejects(runRipgrep([], directory, maximumLines), (error) => {
        assert.equal((error as { code?: unknown }).code, "INVALID_ARGUMENT");
        return true;
      });
    }
  });
});

test("runRipgrep cancellation preserves reason, terminates child, and cleans listeners", async (t) => {
  await withFakeRg(t, `
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[2], String(process.pid));
    setInterval(() => {}, 1_000);
  `, async (directory) => {
    const pidPath = path.join(directory, "pid");
    const controller = new AbortController();
    const reason = { kind: "cancel-rg" };
    const pending = runRipgrep([pidPath], directory, 10, controller.signal);
    await waitUntil(async () => {
      try {
        await realpath(pidPath);
        return true;
      } catch {
        return false;
      }
    });
    const pid = Number(await import("node:fs/promises").then(({ readFile }) =>
      readFile(pidPath, "utf8")
    ));

    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    await waitUntil(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await assert.rejects(
      runRipgrep([], directory, 10, alreadyAborted.signal),
      (error) => error === alreadyAborted.signal.reason &&
        (error as Error).name === "AbortError",
    );
  });
});

test("grep ignores malformed events and filters unsafe result paths", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-security-");
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".git"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "src", "a.ts"), "safe\n");
  await writeFile(path.join(root, ".env"), "TOKEN=secret\n");
  await writeFile(path.join(root, ".git", "config"), "secret\n");
  await writeFile(path.join(root, "node_modules", "a.js"), "secret\n");
  const event = (
    eventPath: unknown,
    lineNumber: unknown,
    text: unknown,
    type: unknown = "match",
  ) => JSON.stringify({
    type,
    data: {
      path: { text: eventPath },
      lines: { text },
      line_number: lineNumber,
    },
  });
  const runRg: RgRunner = async () => ({
    lines: [
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "match", data: null }),
      event(1, 1, "wrong path"),
      event("src/a.ts", "1", "wrong line"),
      event("src/a.ts", 0, "zero line"),
      event("src/a.ts", 1.5, "fractional line"),
      event("src/a.ts", 1, 1),
      event("src/a.ts", 1, "ignored type", "begin"),
      event(".env", 1, "secret"),
      event(".git/config", 1, "secret"),
      event("node_modules/a.js", 1, "secret"),
      event("../outside.txt", 1, "outside"),
      event(
        "src/a.ts",
        1,
        `\u0000safe\t${"x".repeat(GREP_MAX_LINE_LENGTH + 100)}\n`,
      ),
    ],
    truncated: false,
  });
  const grep = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg,
  }), "grep");

  const result = await grep.execute({ pattern: "safe" });

  assert.equal(result.ok, true);
  assert.equal((result.matches as unknown[]).length, 1);
  assert.deepEqual((result.matches as Array<Record<string, unknown>>)[0], {
    path: "src/a.ts",
    line: 1,
    text: `safe${"x".repeat(GREP_MAX_LINE_LENGTH - 4)}`,
    kind: "match",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|outside|wrong|zero|fractional/);
});

test("grep counts only matches toward limit while retaining context", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-matches-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "text\n");
  const line = (kind: "match" | "context", lineNumber: number) =>
    JSON.stringify({
      type: kind,
      data: {
        path: { text: "src/a.ts" },
        lines: { text: `${kind}-${lineNumber}\n` },
        line_number: lineNumber,
      },
    });
  const grep = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => ({
      lines: [
        line("context", 1),
        line("match", 2),
        line("context", 3),
        line("match", 4),
        line("context", 5),
        line("match", 6),
      ],
      truncated: false,
    }),
  }), "grep");

  const result = await grep.execute({ pattern: "match", context: 1, limit: 2 });

  assert.deepEqual(
    (result.matches as Array<{ kind: string; line: number }>).map(
      ({ kind, line: lineNumber }) => [kind, lineNumber],
    ),
    [
      ["context", 1],
      ["match", 2],
      ["context", 3],
      ["match", 4],
      ["context", 5],
    ],
  );
  assert.equal(result.truncated, true);
});

test("grep resolves one repeated result path only once", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-visibility-cache-");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "text\n");
  const base = createWorkspacePolicy(root, { isIgnored: async () => false });
  const resolveCounts = new Map<string, number>();
  const policy: WorkspacePolicy = {
    root: base.root,
    async resolve(requestedPath, operation) {
      resolveCounts.set(requestedPath, (resolveCounts.get(requestedPath) ?? 0) + 1);
      return await base.resolve(requestedPath, operation);
    },
  };
  const lines = Array.from({ length: 80 }, (_, index) => JSON.stringify({
    type: index % 2 === 0 ? "match" : "context",
    data: {
      path: { text: "src/a.ts" },
      lines: { text: `line-${index + 1}\n` },
      line_number: index + 1,
    },
  }));
  const grep = byName(createSearchTools({
    policy,
    runRg: async () => ({ lines, truncated: false }),
  }), "grep");

  const result = await grep.execute({ pattern: "line" });

  assert.equal(result.ok, true);
  assert.equal((result.matches as unknown[]).length, 80);
  assert.equal(resolveCounts.get("."), 1);
  assert.equal(resolveCounts.get("src/a.ts"), 1);
});

test(
  "grep budgets a large event stream without serializing the accumulated array",
  { timeout: 1_000 },
  async (t) => {
    const root = await temporaryWorkspace(t, "coffee-grep-incremental-");
    await writeFile(path.join(root, "a"), "x\n");
    const lines = Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
      type: index === 0 ? "match" : "context",
      data: {
        path: { text: "a" },
        lines: { text: "" },
        line_number: index + 1,
      },
    }));
    const grep = byName(createSearchTools({
      policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
      runRg: async () => ({ lines, truncated: false }),
    }), "grep");
    const originalStringify = JSON.stringify;
    let accumulatedArraySerializations = 0;
    JSON.stringify = ((...args: unknown[]) => {
      const value = args[0];
      if (
        typeof value === "object" &&
        value !== null &&
        "matches" in value &&
        Array.isArray((value as { matches?: unknown }).matches)
      ) {
        accumulatedArraySerializations += 1;
      }
      return Reflect.apply(originalStringify, JSON, args);
    }) as typeof JSON.stringify;

    let result: Record<string, unknown>;
    try {
      result = await grep.execute({ pattern: "x", context: 10, limit: 1 });
    } finally {
      JSON.stringify = originalStringify;
    }

    assert.equal(accumulatedArraySerializations, 0);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(originalStringify(result)) <= OUTPUT_MAX_BYTES);
  },
);

test("grep total structured output stays within the shared byte budget", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-grep-output-");
  await writeFile(path.join(root, "a.ts"), "text\n");
  const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({
    type: index === 0 ? "match" : "context",
    data: {
      path: { text: "a.ts" },
      lines: { text: `${"界".repeat(GREP_MAX_LINE_LENGTH)}\n` },
      line_number: index + 1,
    },
  }));
  const grep = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => ({ lines, truncated: false }),
  }), "grep");

  const result = await grep.execute({ pattern: "界", context: 10, limit: 1 });

  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= OUTPUT_MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.equal(
    (result.matches as Array<{ kind: string }>).filter(({ kind }) => kind === "match").length,
    1,
  );
});

test("find enforces its requested result limit and preserves rg order", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-find-limit-");
  const names = ["c.ts", "a.ts", "b.ts"];
  for (const name of names) await writeFile(path.join(root, name), "");
  let maximumLines: number | undefined;
  const find = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async (_args, _cwd, receivedMaximumLines) => {
      maximumLines = receivedMaximumLines;
      return { lines: names.map((name) => `./${name}`), truncated: false };
    },
  }), "find");

  const result = await find.execute({ pattern: "*.ts", limit: 2 });

  assert.equal(maximumLines, 2);
  assert.deepEqual(result.files, ["c.ts", "a.ts"]);
  assert.equal(result.truncated, true);
});

test("find caps long ordered results at 50KB and FIND_MAX_RESULTS", async (t) => {
  const root = await temporaryWorkspace(t, "coffee-find-output-");
  const names = Array.from(
    { length: 700 },
    (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(80)}.ts`,
  );
  for (const name of names) await writeFile(path.join(root, name), "");
  const find = byName(createSearchTools({
    policy: createWorkspacePolicy(root, { isIgnored: async () => false }),
    runRg: async () => ({ lines: names, truncated: false }),
  }), "find");

  const result = await find.execute({ pattern: "*.ts" });

  assert.ok((result.files as string[]).length <= FIND_MAX_RESULTS);
  assert.ok((result.files as string[]).length < names.length);
  assert.deepEqual(
    result.files,
    names.slice(0, (result.files as string[]).length),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= OUTPUT_MAX_BYTES);
  assert.equal(result.truncated, true);
});
