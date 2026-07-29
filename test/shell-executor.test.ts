import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildShellEnvironment,
  executeShellCommand,
  terminatePosixTree,
  terminateWindowsTree,
} from "../src/shell/executor.js";

const fixturePath = path.resolve("test/shell-process-fixture.mjs");

function quote(value: string): string {
  return JSON.stringify(value);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The executor already reaped the process.
  }
}

async function waitForTrace(tracePath: string): Promise<number[]> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    try {
      const trace = (await readFile(tracePath, "utf8")).trim();
      if (trace.length > 0) return trace.split(",").map(Number);
    } catch {
      // The fixture has not written its PID pair yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("process fixture did not write its PID trace");
}

async function waitForDead(pids: number[]): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (performance.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(
    pids.filter(isAlive),
    [],
    "executor left fixture processes alive",
  );
}

function fixtureCommand(tracePath: string): string {
  return `${quote(process.execPath)} ${quote(fixturePath)} ${quote(tracePath)}`;
}

async function killTreeAndReject(child: { pid?: number }): Promise<void> {
  if (child.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The fixture tree has already exited.
    }
  }
  throw new Error("forced termination rejection");
}

test("builds a minimal environment without application secrets", () => {
  const environment = buildShellEnvironment({
    PATH: "/test/bin",
    HOME: "/test/home",
    LANG: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    NO_COLOR: "1",
    DEEPSEEK_API_KEY: "deepseek-secret",
    TAVILY_API_KEY: "tavily-secret",
    UNRELATED: "drop-me",
  });

  assert.deepEqual(environment, {
    PATH: "/test/bin",
    HOME: "/test/home",
    LANG: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    NO_COLOR: "1",
    CI: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
  });
});

test("executes in the fixed cwd with a secret-free environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = [
    "console.log(process.cwd())",
    'console.log(process.env.DEEPSEEK_API_KEY ?? "missing")',
    'console.log(process.env.CI, process.env.PAGER, process.env.GIT_PAGER)',
  ].join(";");

  const result = await executeShellCommand({
    command: `${quote(process.execPath)} -e ${quote(script)}`,
    cwd: root,
    timeoutSeconds: 5,
    processEnv: { ...process.env, DEEPSEEK_API_KEY: "must-not-leak" },
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.code, undefined);
  assert.match(result.output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.output, /missing/);
  assert.match(result.output, /1 cat cat/);
  assert.doesNotMatch(result.output, /must-not-leak/);
});

test("returns a nonzero exit and merged output without throwing", async () => {
  const result = await executeShellCommand({
    command: "printf out; printf err >&2; exit 7",
    cwd: process.cwd(),
    timeoutSeconds: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.code, undefined);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.ok(Number.isInteger(result.durationMs));
  assert.ok(result.durationMs >= 0);
});

test("returns SPAWN_FAILED when the explicit Bash is missing", async () => {
  const result = await executeShellCommand({
    command: "pwd",
    cwd: process.cwd(),
    timeoutSeconds: 5,
    shellPath: "/definitely/missing/coffee-bash",
  });

  assert.deepEqual(
    {
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      code: result.code,
    },
    {
      ok: false,
      exitCode: null,
      timedOut: false,
      cancelled: false,
      code: "SPAWN_FAILED",
    },
  );
  assert.match(result.error ?? "", /Bash/);
});

test("returns SPAWN_FAILED when spawning in the cwd fails", async () => {
  const missingCwd = await mkdtemp(path.join(os.tmpdir(), "coffee-missing-cwd-"));
  await rm(missingCwd, { recursive: true, force: true });
  const result = await executeShellCommand({
    command: "pwd",
    cwd: missingCwd,
    timeoutSeconds: 5,
  });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, null);
  assert.equal(result.code, "SPAWN_FAILED");
  assert.match(result.error ?? "", /Bash/);
});

test("rejects when taskkill cannot be spawned", async () => {
  await assert.rejects(
    terminateWindowsTree(12_345, (_pid, onError) => {
      onError(new Error("spawn taskkill ENOENT"));
    }),
    /process tree cleanup failed.*ENOENT/i,
  );
});

test("rejects when taskkill exits nonzero", async () => {
  await assert.rejects(
    terminateWindowsTree(12_345, (_pid, _onError, onClose) => {
      onClose(1);
    }),
    /process tree cleanup failed.*code 1/i,
  );
});

test("rejects when a POSIX process group survives SIGKILL", async () => {
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(
    terminatePosixTree(12_345, {
      signalGroup(_pid, signal) {
        signals.push(signal);
      },
      async waitForExit() {
        return false;
      },
    }),
    /process tree cleanup failed.*SIGKILL/i,
  );
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("sends sanitized output increments in arrival order", async () => {
  const visible: string[] = [];
  const result = await executeShellCommand({
    command: "printf '\\033[31mred\\033[0m\\n'; sleep 0.05; printf '\\033]0;hidden\\007err\\n' >&2",
    cwd: process.cwd(),
    timeoutSeconds: 5,
    onOutput(chunk) {
      visible.push(chunk);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(visible.join(""), "red\nerr\n");
  assert.equal(result.output, "red\nerr\n");
  assert.doesNotMatch(visible.join(""), /\u001b|hidden/);
});

test("keeps collecting real process output after the display callback throws", async () => {
  let displayCalls = 0;
  const result = await executeShellCommand({
    command: "printf first; sleep 0.05; printf second",
    cwd: process.cwd(),
    timeoutSeconds: 5,
    onOutput() {
      displayCalls += 1;
      throw new Error("display failed");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "firstsecond");
  assert.equal(displayCalls, 1);
});

test(
  "preserves CANCELLED when process-tree cleanup rejects",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coffee-cleanup-cancel-"));
    const trace = path.join(root, "pids.txt");
    const controller = new AbortController();
    let pids: number[] = [];
    t.after(async () => {
      controller.abort();
      for (const pid of pids) killIfAlive(pid);
      await rm(root, { recursive: true, force: true });
    });

    const pending = executeShellCommand(
      {
        command: fixtureCommand(trace),
        cwd: process.cwd(),
        timeoutSeconds: 60,
        signal: controller.signal,
      },
      { terminateProcessTree: killTreeAndReject },
    );
    pids = await waitForTrace(trace);
    controller.abort();
    const result = await pending;

    assert.equal(result.code, "CANCELLED");
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? "", /process tree cleanup failed.*forced termination rejection/i);
    await waitForDead(pids);
    pids = [];
  },
);

test(
  "preserves TIMED_OUT when process-tree cleanup rejects",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coffee-cleanup-timeout-"));
    const trace = path.join(root, "pids.txt");
    let pids: number[] = [];
    t.after(async () => {
      for (const pid of pids) killIfAlive(pid);
      await rm(root, { recursive: true, force: true });
    });

    const result = await executeShellCommand(
      {
        command: fixtureCommand(trace),
        cwd: process.cwd(),
        timeoutSeconds: 0.4,
      },
      { terminateProcessTree: killTreeAndReject },
    );
    pids = await waitForTrace(trace);

    assert.equal(result.code, "TIMED_OUT");
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, null);
    assert.match(result.error ?? "", /process tree cleanup failed.*forced termination rejection/i);
    await waitForDead(pids);
    pids = [];
  },
);

test(
  "times out and terminates the whole process tree",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coffee-timeout-tree-"));
    const trace = path.join(root, "pids.txt");
    let pids: number[] = [];
    t.after(async () => {
      for (const pid of pids) killIfAlive(pid);
      await rm(root, { recursive: true, force: true });
    });

    const result = await executeShellCommand({
      command: fixtureCommand(trace),
      cwd: process.cwd(),
      timeoutSeconds: 0.4,
    });
    pids = await waitForTrace(trace);

    assert.equal(result.ok, false);
    assert.equal(result.code, "TIMED_OUT");
    assert.equal(result.timedOut, true);
    assert.equal(result.cancelled, false);
    assert.equal(result.exitCode, null);
    await waitForDead(pids);
    pids = [];
  },
);

test(
  "AbortSignal cancels the whole process tree",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "coffee-abort-tree-"));
    const trace = path.join(root, "pids.txt");
    const controller = new AbortController();
    let pids: number[] = [];
    t.after(async () => {
      controller.abort();
      for (const pid of pids) killIfAlive(pid);
      await rm(root, { recursive: true, force: true });
    });

    const pending = executeShellCommand({
      command: fixtureCommand(trace),
      cwd: process.cwd(),
      timeoutSeconds: 60,
      signal: controller.signal,
    });
    pids = await waitForTrace(trace);
    controller.abort();
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(result.code, "CANCELLED");
    assert.equal(result.timedOut, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.exitCode, null);
    await waitForDead(pids);
    pids = [];
  },
);

test("a pre-aborted signal does not execute the command", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-pre-abort-"));
  const marker = path.join(root, "ran.txt");
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();

  const result = await executeShellCommand({
    command: `touch ${quote(marker)}`,
    cwd: process.cwd(),
    timeoutSeconds: 5,
    signal: controller.signal,
  });

  assert.equal(result.code, "CANCELLED");
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, null);
  await assert.rejects(access(marker));
});
