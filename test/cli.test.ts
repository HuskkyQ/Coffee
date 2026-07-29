import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import Database from "better-sqlite3";
import stringWidth from "string-width";

import { createHistoryStore } from "../src/history/store.js";
import {
  applyPlanAction,
  finishTaskPlan,
} from "../src/planning/state.js";
import type {
  TaskPlan,
  TaskPlanStatus,
  TaskStepDraft,
} from "../src/planning/types.js";

const execFileAsync = promisify(execFile);
const MAIN_INPUT_BORDER = "─".repeat(10);

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface CliSandbox {
  cleanupMarkerPath: string;
  environmentPath: string;
  home: string;
  historyPath: string;
  requestsPath: string;
  settingsPath: string;
}

interface SpawnCliOptions {
  executable?: string;
  interruptAgainWhenOutput?: string;
  interruptWhenOutput?: string;
  preload?: string;
  preloads?: readonly string[];
  streamScenario?: string;
  timeoutMs?: number;
}

interface SpawnPtyCliOptions {
  answerText?: string;
  confirmationAnswer?: "y" | "n";
  interruptWhenOutput?: string;
  scriptedInput?: string;
  streamScenario: string;
  timeoutMs?: number;
}

const MODEL_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "ARK_API_KEY",
] as const;

const stripAnsi = (value: string): string =>
  value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");

interface PtyScriptInvocation {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

const PTY_COMMAND =
  'stty cols 80 rows 24; if [ -n "$COFFEE_TEST_PTY_PID_PATH" ]; then ' +
  'printf "%s\\n" "$$" > "$COFFEE_TEST_PTY_PID_PATH"; fi; ' +
  'exec "$COFFEE_TEST_NODE" --import tsx --import ' +
  './test/streaming-fetch.mjs src/cli.ts "$COFFEE_TEST_PTY_MARKER"';

function buildPtyScriptInvocation(
  platform: string,
  scriptPath: string,
): PtyScriptInvocation | undefined {
  if (platform === "darwin") {
    return {
      command: "/bin/sh",
      args: [
        "-c",
        'cat | "$COFFEE_TEST_SCRIPT_PATH" -q /dev/null /bin/sh -c "$COFFEE_TEST_PTY_COMMAND"',
      ],
      environment: {
        COFFEE_TEST_SCRIPT_PATH: scriptPath,
        COFFEE_TEST_PTY_COMMAND: PTY_COMMAND,
      },
    };
  }
  if (platform === "linux") {
    return {
      command: "/bin/sh",
      args: [
        "-c",
        'cat | "$COFFEE_TEST_SCRIPT_PATH" -q -c "$COFFEE_TEST_PTY_COMMAND" /dev/null',
      ],
      environment: {
        COFFEE_TEST_SCRIPT_PATH: scriptPath,
        COFFEE_TEST_PTY_COMMAND: PTY_COMMAND,
      },
    };
  }
  return undefined;
}

const SCRIPT_PATH = "/usr/bin/script";
// Windows has no stable native PTY fixture here; executor abort/tree tests cover it.
const SHELL_PTY_SKIP: false | string = process.platform === "win32"
  ? "Windows 无原生稳定 PTY；由 executor 的真实取消与进程树测试覆盖"
  : process.platform !== "darwin" && process.platform !== "linux"
  ? `平台 ${process.platform} 未配置原生 PTY fixture`
  : !existsSync(SCRIPT_PATH)
  ? `缺少 ${SCRIPT_PATH}，无法运行原生 PTY fixture`
  : false;

test("builds fixed BSD and util-linux script invocations without shell interpolation", () => {
  const darwin = buildPtyScriptInvocation("darwin", "/usr/bin/script");
  assert.equal(darwin?.command, "/bin/sh");
  assert.equal(darwin?.args[0], "-c");
  assert.match(darwin?.args[1] ?? "", /script_PATH" -q \/dev\/null/i);
  assert.equal(darwin?.args[1]?.includes("/usr/bin/script"), false);
  assert.equal(darwin?.environment.COFFEE_TEST_SCRIPT_PATH, "/usr/bin/script");
  assert.match(
    darwin?.environment.COFFEE_TEST_PTY_COMMAND ?? "",
    /exec "\$COFFEE_TEST_NODE"/,
  );
  assert.match(
    darwin?.environment.COFFEE_TEST_PTY_COMMAND ?? "",
    /src\/cli\.ts "\$COFFEE_TEST_PTY_MARKER"/,
  );

  const linux = buildPtyScriptInvocation("linux", "/usr/bin/script");
  assert.equal(linux?.command, "/bin/sh");
  assert.equal(linux?.args[0], "-c");
  assert.match(linux?.args[1] ?? "", /script_PATH" -q -c/i);
  assert.equal(linux?.args[1]?.includes("/usr/bin/script"), false);
  assert.equal(linux?.environment.COFFEE_TEST_SCRIPT_PATH, "/usr/bin/script");
  assert.match(
    linux?.environment.COFFEE_TEST_PTY_COMMAND ?? "",
    /exec "\$COFFEE_TEST_NODE"/,
  );

  assert.equal(buildPtyScriptInvocation("win32", "script"), undefined);
  assert.equal(
    isExpectedShellFixtureCommand(
      'node -e fs.writeFileSync("/tmp/unique-shell.pid")',
      "/tmp/unique-shell.pid",
    ),
    true,
  );
  assert.equal(
    isExpectedShellFixtureCommand("node unrelated.js", "/tmp/unique-shell.pid"),
    false,
  );
});

function spawnCli(
  sandbox: CliSandbox,
  environment: NodeJS.ProcessEnv,
  input: string,
  options: SpawnCliOptions = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of MODEL_ENV_KEYS) {
      delete env[key];
    }
    delete env.TAVILY_API_KEY;
    delete env.COFFEE_SETTINGS_PATH;
    delete env.COFFEE_HISTORY_PATH;
    delete env.COFFEE_TEST_REQUESTS_PATH;
    delete env.COFFEE_TEST_INTERRUPT_TRACE_PATH;
    delete env.COFFEE_TEST_DELAY_ABORT_ERROR;
    delete env.COFFEE_TEST_HANG_DELAY_MS;
    delete env.COFFEE_TEST_PTY_TRACE_PATH;
    delete env.COFFEE_TEST_TTY_LIKE_OUTPUT;
    delete env.COFFEE_STREAM_TEST_SCENARIO;
    delete env.COFFEE_TEST_STREAM_SCENARIO;
    Object.assign(env, environment);
    delete env.COFFEE_TEST_STREAM_SCENARIO;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    env.HOME = sandbox.home;
    env.USERPROFILE = sandbox.home;
    env.COFFEE_SETTINGS_PATH = sandbox.settingsPath;
    env.COFFEE_HISTORY_PATH = sandbox.historyPath;
    if (options.streamScenario) {
      env.COFFEE_STREAM_TEST_SCENARIO = options.streamScenario;
    }

    const preloads = options.preloads ?? [
      options.preload ?? "./test/no-fetch.mjs",
    ];
    const child = spawn(options.executable ?? process.execPath, [
      "--import",
      "tsx",
      ...preloads.flatMap((preload) => ["--import", preload]),
      "src/cli.ts",
    ], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeoutMs = options.timeoutMs ?? 10_000;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    let interruptedAgain = false;
    const cleanup = (kill: boolean) => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (kill) {
        child.kill("SIGKILL");
      }
    };
    const resolveOnce = (result: CliResult) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(false);
      resolve(result);
    };
    const rejectOnce = (error: Error, kill: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(kill);
      reject(error);
    };
    timeout = setTimeout(() => {
      rejectOnce(
        new Error(`Coffee CLI 测试进程超过 ${timeoutMs}ms`),
        true,
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (
        options.interruptWhenOutput &&
        !interrupted &&
        stdout.includes(options.interruptWhenOutput)
      ) {
        interrupted = true;
        child.kill("SIGINT");
      }
      if (
        options.interruptAgainWhenOutput &&
        !interruptedAgain &&
        stdout.includes(options.interruptAgainWhenOutput)
      ) {
        interruptedAgain = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.on("error", (error) => {
      rejectOnce(error, true);
    });
    child.on("error", (error) => {
      rejectOnce(error, true);
    });
    child.on("close", (code, signal) => {
      resolveOnce({ code, signal, stdout, stderr });
    });
    if (options.interruptWhenOutput) {
      child.stdin.write(input);
    } else {
      child.stdin.end(input);
    }
  });
}

function throwingInterruptWritePreload(newlineToThrow: number): string {
  const source = `
    const originalWrite = process.stdout.write.bind(process.stdout);
    let armed = false;
    let interruptNewlines = 0;
    process.stdout.write = (chunk, ...args) => {
      const text = String(chunk);
      const result = originalWrite(chunk, ...args);
      if (text.includes("STREAM_STARTED")) armed = true;
      if (armed && text === "\\n") {
        interruptNewlines += 1;
        if (interruptNewlines === ${newlineToThrow}) {
          throw new Error("injected interrupt write failure");
        }
      }
      return result;
    };
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function throwingActivityClearPreload(): string {
  const source = `
    const originalWrite = process.stdout.write.bind(process.stdout);
    let armed = false;
    let thrown = false;
    process.stdout.write = (chunk, ...args) => {
      const text = String(chunk);
      const result = originalWrite(chunk, ...args);
      if (text.includes("WEB_TOOL_STARTED")) armed = true;
      if (armed && !thrown && text === "\\u001b[8A") {
        thrown = true;
        throw new Error("injected activity dispose failure");
      }
      return result;
    };
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function processIsAlive(pid: number): boolean {
  if (process.platform !== "win32") {
    try {
      const state = execFileSync(
        "/bin/ps",
        ["-p", String(pid), "-o", "stat="],
        { encoding: "utf8", timeout: 1_000 },
      ).trim();
      if (state === "" || state.startsWith("Z")) {
        return false;
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 1
      ) {
        return false;
      }
      throw error;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

function isExpectedShellFixtureCommand(
  command: string,
  uniquePidPath: string,
): boolean {
  return command.includes(uniquePidPath);
}

function processHasPtyMarker(pid: number, marker: string): boolean {
  try {
    const identity = execFileSync(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      { encoding: "utf8", timeout: 1_000 },
    );
    return identity.includes(marker);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 1
    ) {
      return false;
    }
    throw error;
  }
}

interface PtySignalTargetDependencies {
  hasMarker: (pid: number, marker: string) => boolean;
  isAlive: (pid: number) => boolean;
  signalGroup: (pid: number, signal: NodeJS.Signals) => void;
}

function signalPtyTarget(
  pid: number | undefined,
  signal: NodeJS.Signals,
  marker: string | undefined,
  isActiveOwnedChild: boolean,
  dependencies: PtySignalTargetDependencies,
): void {
  if (pid === undefined) {
    return;
  }
  if (isActiveOwnedChild) {
    dependencies.signalGroup(pid, signal);
    return;
  }
  if (marker === undefined) {
    return;
  }
  if (!dependencies.isAlive(pid)) {
    return;
  }
  if (!dependencies.hasMarker(pid, marker)) {
    if (!dependencies.isAlive(pid)) {
      return;
    }
    throw new Error(
      `拒绝向身份不匹配的 PTY PID ${pid} 发送 ${signal}`,
    );
  }
  dependencies.signalGroup(pid, signal);
}

test("signals an active owned PTY without trusting an unverified external PID", () => {
  const signalled: number[] = [];
  let markerChecks = 0;
  const dependencies: PtySignalTargetDependencies = {
    hasMarker: () => {
      markerChecks += 1;
      return false;
    },
    isAlive: () => true,
    signalGroup: (pid) => {
      signalled.push(pid);
    },
  };

  signalPtyTarget(101, "SIGTERM", "coffee-pty-marker", true, dependencies);
  assert.deepEqual(signalled, [101]);
  assert.equal(markerChecks, 0);

  assert.throws(
    () => signalPtyTarget(202, "SIGTERM", "coffee-pty-marker", false, dependencies),
    /拒绝向身份不匹配的 PTY PID 202 发送 SIGTERM/,
  );
  assert.deepEqual(signalled, [101]);
  assert.equal(markerChecks, 1);
});

async function readProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "/bin/ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 1_000 },
    );
    return stdout.trim() || undefined;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === 1 || error.code === "ESRCH")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return !processIsAlive(pid);
}

function spawnPtyCli(
  sandbox: CliSandbox,
  environment: NodeJS.ProcessEnv,
  options: SpawnPtyCliOptions,
): Promise<CliResult> {
  const invocation = buildPtyScriptInvocation(process.platform, SCRIPT_PATH);
  if (invocation === undefined) {
    return Promise.reject(new Error(`平台 ${process.platform} 不支持 PTY fixture`));
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of MODEL_ENV_KEYS) {
      delete env[key];
    }
    delete env.TAVILY_API_KEY;
    delete env.COFFEE_TEST_REQUESTS_PATH;
    delete env.COFFEE_TEST_SHELL_MARKER_NAME;
    delete env.COFFEE_TEST_SHELL_PID_PATH;
    Object.assign(env, environment);
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
    env.HOME = sandbox.home;
    env.USERPROFILE = sandbox.home;
    env.COFFEE_SETTINGS_PATH = sandbox.settingsPath;
    env.COFFEE_HISTORY_PATH = sandbox.historyPath;
    env.COFFEE_STREAM_TEST_SCENARIO = options.streamScenario;
    env.COFFEE_TEST_NODE = process.execPath;
    env.COFFEE_TEST_PTY_PID_PATH ??= path.join(
      sandbox.home,
      "pty-child.pid",
    );
    env.COFFEE_TEST_PTY_MARKER = `coffee-pty-${path.basename(sandbox.home)}`;
    env.NO_COLOR = "1";
    env.TERM = "xterm-256color";

    const child = spawn(
      invocation.command,
      [...invocation.args, env.COFFEE_TEST_PTY_MARKER],
      {
        cwd: process.cwd(),
        detached: true,
        env: { ...env, ...invocation.environment },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const timeoutMs = options.timeoutMs ?? 5_000;
    let timeout: NodeJS.Timeout | undefined;
    let settled = false;
    let pendingError: Error | undefined;
    let stdout = "";
    let stderr = "";
    let promptAnswered = false;
    let confirmationAnswered = false;
    let exitSent = false;
    let interrupted = false;
    const writeScriptedInput = (scriptedInput: string) => {
      const tokens =
        scriptedInput.match(/\u001b\[[A-D]|\u001b|[\s\S]/gu) ?? [];
      const writeNext = (index: number) => {
        const token = tokens[index];
        if (token === undefined) {
          if (options.scriptedInput !== undefined) {
            child.stdin.end();
          }
          return;
        }
        child.stdin.write(token);
        const delay = token === "\u001b"
          ? 600
          : token === "\r"
          ? 100
          : 4;
        setTimeout(() => writeNext(index + 1), delay);
      };
      writeNext(0);
    };
    const clearHarnessTimeout = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
    };
    const readPtyChildPid = (): number | undefined => {
      const pidPath = env.COFFEE_TEST_PTY_PID_PATH;
      if (!pidPath || !existsSync(pidPath)) {
        return undefined;
      }
      const pid = Number(readFileSync(pidPath, "utf8").trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    };
    const signalProcessGroup = (
      pid: number | undefined,
      signal: NodeJS.Signals,
    ) => {
      if (pid === undefined) {
        return;
      }
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error)) {
          throw error;
        }
        if (error.code === "ESRCH") {
          return;
        }
        if (error.code === "EPERM") {
          try {
            process.kill(pid, signal);
            return;
          } catch (fallbackError) {
            if (
              typeof fallbackError === "object" &&
              fallbackError !== null &&
              "code" in fallbackError &&
              fallbackError.code === "ESRCH"
            ) {
              return;
            }
            throw fallbackError;
          }
        }
        throw error;
      }
    };
    const signalProcessTree = (signal: NodeJS.Signals) => {
      const marker = env.COFFEE_TEST_PTY_MARKER;
      const dependencies: PtySignalTargetDependencies = {
        hasMarker: processHasPtyMarker,
        isAlive: processIsAlive,
        signalGroup: signalProcessGroup,
      };
      const childIsActive =
        child.exitCode === null && child.signalCode === null;
      if (childIsActive) {
        signalPtyTarget(
          child.pid,
          signal,
          marker,
          true,
          dependencies,
        );
      }
      const ptyChildPid = readPtyChildPid();
      if (ptyChildPid !== child.pid) {
        signalPtyTarget(
          ptyChildPid,
          signal,
          marker,
          false,
          dependencies,
        );
      }
    };
    const waitForPtyChildExit = async (): Promise<void> => {
      const ptyChildPid = readPtyChildPid();
      if (ptyChildPid === undefined) {
        return;
      }
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (!processIsAlive(ptyChildPid)) {
          return;
        }
        if (attempt === 10) {
          signalProcessTree("SIGKILL");
        }
        await new Promise<void>((resolveDelay) => {
          setTimeout(resolveDelay, 10);
        });
      }
      throw new Error(`PTY 子进程 ${ptyChildPid} 未能终止`);
    };
    const failAfterClose = (error: Error) => {
      if (settled || pendingError) {
        return;
      }
      pendingError = error;
      clearHarnessTimeout();
      child.stdin.destroy();
      try {
        signalProcessTree("SIGTERM");
      } catch (cleanupError) {
        pendingError =
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError));
      }
    };
    timeout = setTimeout(() => {
      failAfterClose(
        new Error(
          `Coffee PTY 测试进程超过 ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (!promptAnswered && stdout.includes(MAIN_INPUT_BORDER)) {
        promptAnswered = true;
        writeScriptedInput(options.scriptedInput ?? "你好\r");
      }
      if (
        options.confirmationAnswer &&
        !confirmationAnswered &&
        stdout.includes("仅允许本次执行？")
      ) {
        confirmationAnswered = true;
        child.stdin.write(options.confirmationAnswer + "\r");
      }
      if (
        options.interruptWhenOutput &&
        !interrupted &&
        stdout.includes(options.interruptWhenOutput)
      ) {
        interrupted = true;
        child.stdin.end("\u0003");
      }
      if (
        options.answerText &&
        !exitSent &&
        stdout.includes(options.answerText) &&
        stdout.indexOf(
          MAIN_INPUT_BORDER,
          stdout.indexOf(options.answerText),
        ) >= 0
      ) {
        exitSent = true;
        child.stdin.end("/exit\r");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      failAfterClose(error);
    });
    child.stdin.on("error", (error) => {
      failAfterClose(error);
    });
    child.on("close", async (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearHarnessTimeout();
      try {
        await waitForPtyChildExit();
        if (pendingError) {
          reject(pendingError);
        } else {
          resolve({ code, signal, stdout, stderr });
        }
      } catch (cleanupError) {
        reject(cleanupError);
      }
    });
  });
}

async function withCliSandbox(
  run: (paths: CliSandbox) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "coffee-home-"));
  const cleanupMarkerPath = path.join(home, "cleanup.log");
  const environmentPath = path.join(home, "environment.json");
  const historyPath = path.join(home, ".coffee", "history.sqlite");
  const requestsPath = path.join(home, "requests.jsonl");
  const settingsPath = path.join(home, "coffee.settings.json");

  try {
    await run({
      cleanupMarkerPath,
      environmentPath,
      home,
      historyPath,
      requestsPath,
      settingsPath,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function snapshotFile(filePath: string): Promise<
  | { exists: false }
  | { exists: true; bytes: Buffer; mode: number; size: number }
> {
  if (!(await exists(filePath))) {
    return { exists: false };
  }
  const [bytes, metadata] = await Promise.all([
    readFile(filePath),
    stat(filePath),
  ]);
  return {
    exists: true,
    bytes,
    mode: metadata.mode,
    size: metadata.size,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const CLI_PLAN_STEPS: readonly TaskStepDraft[] = [
  {
    id: "inspect",
    title: "检查输入",
    successCriteria: "输入已经检查",
    dependsOn: [],
  },
  {
    id: "verify",
    title: "验证结果",
    successCriteria: "结果已经验证",
    dependsOn: ["inspect"],
  },
];

function seedPlan(
  databasePath: string,
  status: TaskPlanStatus,
  goal = `${status} 计划`,
): string {
  const store = createHistoryStore(databasePath);
  try {
    const session = store.commitTurn({
      title: goal,
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "开始任务" },
        { role: "assistant", content: "收到", toolCalls: [] },
      ],
    });
    let plan = store.plans.create({
      session: {
        kind: "existing",
        id: session.id,
        expectedRevision: session.revision,
        expectedCurrentPlan: null,
      },
      plan: {
        id: `plan-${status}`,
        goal,
        steps: CLI_PLAN_STEPS,
        now: "2026-07-27T08:00:00.000Z",
      },
    }).plan;
    const save = (next: TaskPlan): void => {
      plan = store.plans.save(next, plan.revision);
    };
    if (status === "active" || status === "blocked" || status === "completed") {
      save(applyPlanAction(plan, {
        type: "start_step",
        stepId: "inspect",
      }, "2026-07-27T08:00:01.000Z"));
    }
    if (status === "blocked") {
      save(applyPlanAction(plan, {
        type: "block_step",
        stepId: "inspect",
        reason: "等待用户选择",
      }, "2026-07-27T08:00:02.000Z"));
    } else if (status === "completed") {
      save(applyPlanAction(plan, {
        type: "complete_step",
        stepId: "inspect",
        result: "检查完成",
      }, "2026-07-27T08:00:02.000Z"));
      save(applyPlanAction(plan, {
        type: "start_step",
        stepId: "verify",
      }, "2026-07-27T08:00:03.000Z"));
      save(applyPlanAction(plan, {
        type: "complete_step",
        stepId: "verify",
        result: "验证完成",
      }, "2026-07-27T08:00:04.000Z"));
      save(finishTaskPlan(
        plan,
        "任务完成",
        "2026-07-27T08:00:05.000Z",
      ));
    } else if (status === "cancelled") {
      plan = store.plans.cancel(
        session.id,
        plan.revision,
        "2026-07-27T08:00:02.000Z",
      );
    }
    assert.equal(plan.status, status);
    return session.id;
  } finally {
    store.close();
  }
}

async function readCapturedRequests(
  requestsPath: string,
): Promise<
  Array<{
    model: string;
    messages: Array<{ role: string; content: string }>;
  }>
> {
  const text = await readFile(requestsPath, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function readHistoryCounts(databasePath: string): {
  sessions: number;
  turns: number;
  messages: number;
  summaries: number;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const count = (table: string): number =>
      database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
    return {
      sessions: count("sessions"),
      turns: count("turns"),
      messages: count("messages"),
      summaries: count("session_summaries"),
    };
  } finally {
    database.close();
  }
}

async function runCli(
  environment: NodeJS.ProcessEnv,
  input: string,
  interruptWhenReady = false,
): Promise<CliResult> {
  let result: CliResult | undefined;
  await withCliSandbox(async (sandbox) => {
    result = await spawnCli(
      sandbox,
      environment,
      input,
      interruptWhenReady ? { interruptWhenOutput: "Workspace: " } : undefined,
    );
  });
  return result!;
}

test("starts without a model API key so the user can login", async () => {
  const result = await runCli({ TAVILY_API_KEY: "tvly-test" }, "/exit\n");

  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /DEEPSEEK_API_KEY/);
});

test("always opens history inside the CLI sandbox, never the developer home", async () => {
  const realHistoryPath = path.join(os.homedir(), ".coffee", "history.sqlite");
  const before = await snapshotFile(realHistoryPath);

  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/exit\n",
    );

    assert.equal(result.code, 0);
    assert.equal(await exists(sandbox.historyPath), true);
  });
  assert.deepEqual(await snapshotFile(realHistoryPath), before);
});

test("still closes history when an earlier cleanup step throws", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_CLEANUP_MARKER: sandbox.cleanupMarkerPath,
        TAVILY_API_KEY: "tvly-test",
      },
      "/exit\n",
      { preload: "./test/cleanup-failure.mjs" },
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /injected input cleanup failure/);
    assert.deepEqual(
      (await readFile(sandbox.cleanupMarkerPath, "utf8")).trim().split("\n"),
      ["input", "database"],
    );
  });
});

test("sets both platform home variables to the sandbox and removes fallbacks", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_ENVIRONMENT_PATH: sandbox.environmentPath,
        HOME: "/must/not/be/used/home",
        HOMEDRIVE: "Z:",
        HOMEPATH: "\\must\\not\\be\\used",
        USERPROFILE: "Z:\\must\\not\\be\\used",
        TAVILY_API_KEY: "tvly-test",
      },
      "/exit\n",
      { preload: "./test/environment-capture.mjs" },
    );

    assert.equal(result.code, 0);
    assert.deepEqual(
      JSON.parse(await readFile(sandbox.environmentPath, "utf8")),
      {
        HOME: sandbox.home,
        USERPROFILE: sandbox.home,
      },
    );
  });
});

test("honors an isolated settings path from the environment", async () => {
  await withCliSandbox(async (sandbox) => {
    const { settingsPath } = sandbox;
    await writeFile(settingsPath, "{ invalid json\n");
    const result = await spawnCli(
      sandbox,
      {
        HOME: "/must/not/be/used",
        COFFEE_SETTINGS_PATH: "/must/not/be/used/settings.json",
        TAVILY_API_KEY: "tvly-test",
      },
      "/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /coffee\.settings\.json 不是有效的 JSON/);
  });
});

test("exits with a clear message when the Tavily API key is missing", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      { DEEPSEEK_API_KEY: "test-key" },
      "",
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /TAVILY_API_KEY/);
    assert.match(result.stderr, /\.env/);
    const reopened = createHistoryStore(sandbox.historyPath);
    reopened.close();
  });
});

test("starts the CLI and exits on slash-exit without calling the API", async () => {
  const result = await runCli(
    { DEEPSEEK_API_KEY: "test-key", TAVILY_API_KEY: "tvly-test" },
    "/exit\n",
  );

  assert.equal(result.code, 0);
  assert.match(
    result.stdout,
    /Coffee CLI 已启动，输入 \/exit 或按 Ctrl\+C 退出。/,
  );
  assert.doesNotMatch(result.stdout, /You>/);
  assert.match(result.stdout, /Ctrl\+C/);
  assert.match(result.stdout, /Workspace: /);
  assert.doesNotMatch(result.stderr, /AbortError|node:internal\/readline/);
  assert.equal(result.stderr, "");
});

test("exits cleanly when it receives SIGINT", async () => {
  const result = await runCli(
    { DEEPSEEK_API_KEY: "test-key", TAVILY_API_KEY: "tvly-test" },
    "",
    true,
  );

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Workspace: /);
  assert.doesNotMatch(result.stderr, /AbortError|node:internal\/readline/);
  assert.equal(result.stderr, "");
});

test("cancels an active model request on SIGINT and exits cleanly", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n",
      {
        interruptWhenOutput: "HANGING_FETCH_STARTED",
        preload: "./test/hanging-fetch.mjs",
        timeoutMs: 3_000,
      },
    );

    assert.match(result.stdout, /HANGING_FETCH_STARTED/);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.match(result.stdout, /Workspace: /);
    assert.doesNotMatch(result.stderr, /AbortError|node:internal\/readline/);
    assert.equal(result.stderr, "");
    const reopened = createHistoryStore(sandbox.historyPath);
    try {
      assert.equal(reopened.listSessions().length, 0);
    } finally {
      reopened.close();
    }
  });
});

test("streams raw Markdown deltas in order without cursor ANSI in non-TTY output", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
        COFFEE_STREAM_TEST_SCENARIO: "text",
        COFFEE_TEST_STREAM_SCENARIO: "partial-error",
      },
      "你好\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /\* \*\*晨光\*\*\n/);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  });
});

test("prints stable streamed lines exactly once in non-TTY output", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "fake-deepseek-key",
        TAVILY_API_KEY: "fake-tavily-key",
      },
      "介绍一下项目\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "stable-lines",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    for (const phrase of [
      "当前项目是 Coffee",
      "从项目结构来看",
      "这是一个 CLI",
    ]) {
      assert.equal(result.stdout.split(phrase).length - 1, 1, phrase);
    }
  });
});

test("shows a model connection status before the delayed first response", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "delayed-first-text",
      },
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    const status = result.stdout.indexOf("正在连接 DeepSeek V4 Flash…");
    const answer = result.stdout.indexOf("延迟回答");
    assert.ok(status >= 0);
    assert.ok(answer > status);
    assert.equal(result.stdout.match(/延迟回答/gu)?.length, 1);
  });
});

test("disables cursor rendering when stdin is piped into a TTY-like output", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_TTY_LIKE_OUTPUT: "1",
        DEEPSEEK_API_KEY: "fake-deepseek-key",
        NO_COLOR: "1",
        TAVILY_API_KEY: "fake-tavily-key",
        TERM: "xterm-256color",
      },
      "请慢慢回答\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "slow-text",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.equal(result.stdout.split("稳定正文").length - 1, 1);
  });
});

test("removes stream abort listeners after every completed response", async () => {
  const script = `
    import { getEventListeners } from "node:events";
    const controller = new AbortController();
    for (let index = 0; index < 12; index += 1) {
      const response = await fetch("https://example.test", {
        signal: controller.signal,
      });
      await response.text();
    }
    process.stdout.write(String(getEventListeners(controller.signal, "abort").length));
  `;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./test/streaming-fetch.mjs",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COFFEE_STREAM_TEST_SCENARIO: "text",
      },
      timeout: 3_000,
    },
  );

  assert.equal(stdout, "0");
  assert.doesNotMatch(stderr, /MaxListenersExceededWarning/);
});

test("shows a fallback notice before the complete fallback answer", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "fallback-json",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const notice = result.stdout.indexOf("当前模型暂不支持流式输出");
    const answer = result.stdout.indexOf("完整输出答案");
    assert.ok(notice >= 0);
    assert.ok(answer > notice);
  });
});

test("finishes the streamed tool segment before one activity animation", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "计算\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "tool",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const segment = result.stdout.indexOf("先算一下：\n");
    const activity = result.stdout.indexOf("正在研磨数字…");
    assert.ok(segment >= 0);
    assert.ok(activity > segment);
    assert.equal(result.stdout.match(/正在研磨数字…/g)?.length, 1);
    assert.equal(result.stdout.match(/计算结果已经出炉/g)?.length, 1);
    assert.match(result.stdout, /结果是 \*\*42\*\*。\n/);
  });
});

test("executes an automatic shell command once and continues to the final answer", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_REQUESTS_PATH: sandbox.requestsPath,
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "检查目录\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "shell-auto",
      },
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.match(/\$ pwd/g)?.length, 1);
    assert.match(result.stdout, /Shell 自动执行完成。/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /AbortError|node:internal\/readline|interface:\d+/,
    );
    const requests = await readCapturedRequests(sandbox.requestsPath);
    assert.equal(requests.length, 2);
    const toolMessage = requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    assert.ok(toolMessage);
    assert.equal(JSON.parse(toolMessage.content).exitCode, 0);
  });
});

test("fixture protocol validation rejects misleading tool results that substring checks accepted", async () => {
  const fixtureUrl = pathToFileURL(
    path.join(process.cwd(), "test", "streaming-fetch.mjs"),
  ).href;
  const script = `
    import assert from "node:assert/strict";
    const { validateToolProtocol } = await import(${JSON.stringify(fixtureUrl)});
    assert.equal(typeof validateToolProtocol, "function");
    const expected = {
      id: "call-shell-confirm",
      name: "shell",
      argumentsJson: '{"command":"touch marker"}',
    };
    const assistant = {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: expected.id,
        type: "function",
        function: { name: expected.name, arguments: expected.argumentsJson },
      }],
    };
    const valid = [
      { role: "system", content: "prompt" },
      { role: "user", content: "run" },
      assistant,
      {
        role: "tool",
        tool_call_id: expected.id,
        content: '{"ok":false,"code":"USER_REJECTED"}',
      },
    ];
    assert.equal(validateToolProtocol(valid, expected).code, "USER_REJECTED");

    const misleading = [
      { role: "system", content: "prompt" },
      { role: "user", content: "run" },
      assistant,
      {
        role: "tool",
        tool_call_id: "wrong-call",
        content: '{"ok":false,"code":"WRONG"}',
      },
      {
        role: "tool",
        tool_call_id: expected.id,
        content: '{"ok":false,"code":"USER_REJECTED"}',
      },
    ];
    assert.throws(
      () => validateToolProtocol(misleading, expected),
      /工具协议/,
    );

    const wrongArguments = structuredClone(valid);
    wrongArguments[2].tool_calls[0].function.arguments = '{"command":"pwd"}';
    assert.throws(
      () => validateToolProtocol(wrongArguments, expected),
      /工具协议/,
    );

    const laterTool = [...valid, {
      role: "tool",
      tool_call_id: "later-call",
      content: '{"ok":true}',
    }];
    assert.throws(
      () => validateToolProtocol(laterTool, expected),
      /工具协议/,
    );

    const extraToolCall = structuredClone(valid);
    extraToolCall[2].tool_calls.push({
      id: "call-calculator",
      type: "function",
      function: { name: "calculator", arguments: '{"expression":"1+1"}' },
    });
    assert.throws(
      () => validateToolProtocol(extraToolCall, expected),
      /工具协议/,
    );

    const trailingAssistant = [...valid, {
      role: "assistant",
      content: "尾随消息",
      tool_calls: [],
    }];
    assert.throws(
      () => validateToolProtocol(trailingAssistant, expected),
      /工具协议/,
    );

    const missingType = structuredClone(valid);
    delete missingType[2].tool_calls[0].type;
    assert.throws(
      () => validateToolProtocol(missingType, expected),
      /工具协议/,
    );

    const wrongType = structuredClone(valid);
    wrongType[2].tool_calls[0].type = "custom";
    assert.throws(
      () => validateToolProtocol(wrongType, expected),
      /工具协议/,
    );
    process.stdout.write("validated");
  `;

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      env: { ...process.env, COFFEE_STREAM_TEST_SCENARIO: "" },
      timeout: 3_000,
    },
  );

  assert.equal(stdout, "validated");
  assert.equal(stderr, "");
});

test(
  "shows shell confirmation and returns USER_REJECTED without side effects",
  {
    skip: SHELL_PTY_SKIP,
  },
  async (t) => {
    await withCliSandbox(async (sandbox) => {
      const markerName = `coffee-shell-rejected-${process.pid}-${Date.now()}.marker`;
      const markerPath = path.join(process.cwd(), markerName);
      t.after(() => rm(markerPath, { force: true }));
      const result = await spawnPtyCli(
        sandbox,
        {
          COFFEE_TEST_REQUESTS_PATH: sandbox.requestsPath,
          COFFEE_TEST_SHELL_MARKER_NAME: markerName,
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        {
          answerText: "命令未执行",
          confirmationAnswer: "n",
          streamScenario: "shell-confirm",
          timeoutMs: 5_000,
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.signal, null);
      assert.match(result.stdout, new RegExp(`touch ${markerName}`));
      assert.match(result.stdout, /原因：命令不在严格自动执行列表中/);
      assert.match(result.stdout, /命令未执行/);
      assert.equal(await exists(markerPath), false);
      const requests = await readCapturedRequests(sandbox.requestsPath);
      assert.equal(requests.length, 2);
      assert.match(JSON.stringify(requests[1]), /USER_REJECTED/);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /AbortError|node:internal\/readline|interface:\d+/,
      );
    });
  },
);

test(
  "SIGINT cancels a hanging shell process and leaves no child behind",
  {
    skip: SHELL_PTY_SKIP,
  },
  async (t) => {
    await withCliSandbox(async (sandbox) => {
      const pidPath = path.join(sandbox.home, "shell-child.pid");
      let shellPid: number | undefined;
      t.after(async () => {
        if (shellPid !== undefined && processIsAlive(shellPid)) {
          const command = await readProcessCommand(shellPid);
          if (command === undefined && !processIsAlive(shellPid)) {
            shellPid = undefined;
          } else if (
            command === undefined ||
            !isExpectedShellFixtureCommand(command, pidPath)
          ) {
            throw new Error(
              `拒绝清理身份不匹配的 PID ${shellPid}: ${command ?? "unknown"}`,
            );
          }
        }
        if (shellPid !== undefined && processIsAlive(shellPid)) {
          process.kill(shellPid, "SIGKILL");
          if (await waitForProcessExit(shellPid, 1_000)) {
            shellPid = undefined;
          }
        }
        await rm(pidPath, { force: true });
      });

      const result = await spawnPtyCli(
        sandbox,
        {
          COFFEE_TEST_SHELL_PID_PATH: pidPath,
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        {
          confirmationAnswer: "y",
          interruptWhenOutput: "SHELL_STARTED",
          streamScenario: "shell-hang",
          timeoutMs: 5_000,
        },
      );

      shellPid = Number((await readFile(pidPath, "utf8")).trim());
      assert.equal(Number.isSafeInteger(shellPid) && shellPid > 0, true);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.match(/SHELL_STARTED/g)?.length, 1);
      assert.equal(await waitForProcessExit(shellPid, 1_000), true);
      shellPid = undefined;
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /AbortError|node:internal\/readline|interface:\d+/,
      );
    });
  },
);

test(
  "SIGINT clears an active ordinary tool animation before its final newline",
  async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnCli(
        sandbox,
        {
          COFFEE_TEST_TTY_LIKE_OUTPUT: "1",
          DEEPSEEK_API_KEY: "test-key",
          NO_COLOR: undefined,
          TAVILY_API_KEY: "tvly-test",
        },
        "你好\n",
        {
          interruptWhenOutput: "WEB_TOOL_STARTED",
          preload: "./test/streaming-fetch.mjs",
          streamScenario: "web-tool-hang",
          timeoutMs: 5_000,
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      const toolStarted = result.stdout.indexOf("WEB_TOOL_STARTED");
      const toolLineEnd = result.stdout.indexOf("\n", toolStarted);
      const activityClear = result.stdout.indexOf("\r\u001b[2K", toolLineEnd);
      const interruptNewline = result.stdout.indexOf("\n", toolLineEnd + 1);
      assert.ok(activityClear > toolLineEnd);
      assert.ok(
        activityClear < interruptNewline,
        "普通工具动画必须在 SIGINT 换行前清除",
      );
      assert.ok(
        result.stdout.indexOf("\u001b[?25h", activityClear) > activityClear,
      );
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /AbortError|node:internal\/readline|interface:\d+/,
      );
    });
  },
);

test("SIGINT still aborts and closes history when activity disposal throws", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_TTY_LIKE_OUTPUT: "1",
        DEEPSEEK_API_KEY: "test-key",
        NO_COLOR: undefined,
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n",
      {
        interruptWhenOutput: "WEB_TOOL_STARTED",
        preloads: [
          "./test/streaming-fetch.mjs",
          throwingActivityClearPreload(),
        ],
        streamScenario: "web-tool-hang",
      },
    );

    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /injected activity dispose failure|AbortError|node:internal\/readline/u,
    );
    const reopened = createHistoryStore(sandbox.historyPath);
    reopened.close();
  });
});

test("keeps a partial stream visible and reports a safe error on the next line", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "partial-error",
      },
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /已经显示的部分\n/);
    assert.match(result.stderr, /Error: .*无效响应/);
    assert.doesNotMatch(result.stdout + result.stderr, /test-key/);
  });
});

test("preserves streamed text and exits cleanly when SIGINT aborts a hanging stream", async () => {
  await withCliSandbox(async (sandbox) => {
    const interruptTracePath = path.join(sandbox.home, "interrupt-trace.log");
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_INTERRUPT_TRACE_PATH: interruptTracePath,
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n",
      {
        interruptWhenOutput: "STREAM_STARTED",
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "hang",
        timeoutMs: 3_000,
      },
    );

    assert.match(result.stdout, /中断前可见/);
    assert.equal(result.stdout.split("中断前可见").length - 1, 1);
    assert.match(result.stdout, /STREAM_STARTED/);
    assert.doesNotMatch(result.stdout, /\u001b\[[0-9;]*A/);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.doesNotMatch(result.stderr, /AbortError|Aborted/);
    assert.equal(result.stderr, "");
    assert.deepEqual(
      (await readFile(interruptTracePath, "utf8")).trim().split("\n"),
      ["newline", "newline", "abort"],
    );
  });
});

test("exits cleanly after two rapid SIGINT signals during a hanging stream", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_DELAY_ABORT_ERROR: "1",
        DEEPSEEK_API_KEY: "test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n",
      {
        interruptAgainWhenOutput: "ABORT_OBSERVED",
        interruptWhenOutput: "STREAM_STARTED",
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "hang",
        timeoutMs: 3_000,
      },
    );

    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.split("中断前可见").length - 1, 1);
    assert.doesNotMatch(result.stdout, /\u001b\[[0-9;]*A/);
    assert.doesNotMatch(result.stderr, /AbortError|Aborted/);
    assert.equal(result.stderr, "");
    const reopened = createHistoryStore(sandbox.historyPath);
    reopened.close();
  });
});

for (const [name, newlineToThrow] of [
  ["renderer preserve disposal", 1],
  ["interrupt newline", 2],
] as const) {
  test(`still aborts and exits cleanly when ${name} throws`, async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnCli(
        sandbox,
        {
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        "你好\n",
        {
          interruptWhenOutput: "STREAM_STARTED",
          preloads: [
            "./test/streaming-fetch.mjs",
            throwingInterruptWritePreload(newlineToThrow),
          ],
          streamScenario: "hang",
          timeoutMs: 3_000,
        },
      );

      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      assert.equal(result.stdout.split("中断前可见").length - 1, 1);
      assert.doesNotMatch(result.stderr, /AbortError|injected interrupt/);
      assert.equal(result.stderr, "");
      const reopened = createHistoryStore(sandbox.historyPath);
      reopened.close();
    });
  });
}

test(
  "renders a preview and reacts to dynamic width inside a real PTY",
  {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/script"),
  },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnPtyCli(
        sandbox,
        {
          COFFEE_TEST_PTY_TRACE_PATH: sandbox.environmentPath,
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        {
          answerText: "def",
          streamScenario: "pty-preview",
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      const coffee = result.stdout.indexOf("abc");
      const streamStart = result.stdout.lastIndexOf("\u001b[?25l", coffee);
      const streamEnd = result.stdout.indexOf(MAIN_INPUT_BORDER, coffee);
      assert.ok(streamStart >= 0);
      assert.ok(streamEnd > coffee);
      const streamOutput = result.stdout.slice(streamStart, streamEnd);
      assert.match(streamOutput, /abcdef/);
      assert.equal(streamOutput.split("abcdef").length - 1, 1);
      assert.doesNotMatch(streamOutput, /\u001b\[[0-9;]*A/);
      assert.ok(
        streamOutput.lastIndexOf("\u001b[?25h") >
          streamOutput.lastIndexOf("\u001b[?25l"),
      );
      assert.deepEqual(
        (await readFile(sandbox.environmentPath, "utf8")).trim().split("\n"),
        ["tty=true;columns=80", "columns=10"],
      );
    });
  },
);

test(
  "restores the cursor when SIGINT interrupts a preview inside a real PTY",
  {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/script"),
  },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnPtyCli(
        sandbox,
        {
          COFFEE_TEST_HANG_DELAY_MS: "1",
          COFFEE_TEST_PTY_TRACE_PATH: sandbox.environmentPath,
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        {
          interruptWhenOutput: "STREAM_STARTED",
          streamScenario: "hang",
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.split("中断前可见").length - 1, 1);
      assert.doesNotMatch(result.stdout, /AbortError|Aborted/);
      const streamStart = result.stdout.indexOf("\u001b[?25l");
      assert.ok(streamStart >= 0);
      assert.doesNotMatch(
        result.stdout.slice(streamStart),
        /\u001b\[[0-9;]*A/,
      );
      assert.ok(
        result.stdout.lastIndexOf("\u001b[?25h") >
          result.stdout.lastIndexOf("\u001b[?25l"),
      );
      assert.equal(
        (await readFile(sandbox.environmentPath, "utf8")).trim(),
        "tty=true;columns=80",
      );
    });
  },
);

test(
  "kills the PTY child process when the harness times out",
  {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/script"),
  },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const pidPath = path.join(sandbox.home, "pty-child.pid");
      let ptyChildPid: number | undefined;
      try {
        await assert.rejects(
          spawnPtyCli(
            sandbox,
            {
              COFFEE_TEST_PTY_PID_PATH: pidPath,
              DEEPSEEK_API_KEY: "test-key",
              TAVILY_API_KEY: "tvly-test",
            },
            {
              streamScenario: "hang",
              timeoutMs: 800,
            },
          ),
          /Coffee PTY 测试进程超过 800ms/,
        );
        ptyChildPid = Number((await readFile(pidPath, "utf8")).trim());
        assert.equal(Number.isSafeInteger(ptyChildPid), true);
        assert.equal(processIsAlive(ptyChildPid), false);
      } finally {
        if (ptyChildPid !== undefined && processIsAlive(ptyChildPid)) {
          process.kill(ptyChildPid, "SIGKILL");
        }
      }
    });
  },
);

test("keeps a hanging stream active until the CLI harness times out", async () => {
  await withCliSandbox(async (sandbox) => {
    await assert.rejects(
      spawnCli(
        sandbox,
        {
          DEEPSEEK_API_KEY: "test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        "你好\n",
        {
          preload: "./test/streaming-fetch.mjs",
          streamScenario: "hang",
          timeoutMs: 2_000,
        },
      ),
      /Coffee CLI 测试进程超过 2000ms/,
    );
  });
});

test("rejects a CLI spawn error without waiting for the harness timeout", async () => {
  await withCliSandbox(async (sandbox) => {
    const startedAt = Date.now();
    await assert.rejects(
      spawnCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        "/exit\n",
        {
          executable: path.join(sandbox.home, "missing-node"),
          timeoutMs: 2_000,
        },
      ),
      /ENOENT/,
    );
    assert.ok(Date.now() - startedAt < 1_000);
  });
});

test(
  "switches theme with arrows and persists it without a model request",
  { skip: SHELL_PTY_SKIP },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnPtyCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        {
          streamScenario: "pty-preview",
          scriptedInput: "/theme\r\u001b[B\r/exit\r",
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(stripAnsi(result.stdout), /已切换为 周末海岸/u);
      assert.equal(
        JSON.parse(await readFile(sandbox.settingsPath, "utf8"))
          ["coffee-preferences"].theme,
        "coast",
      );
      assert.equal(existsSync(sandbox.requestsPath), false);
    });
  },
);

test(
  "escape keeps the current theme unchanged",
  { skip: SHELL_PTY_SKIP },
  async () => {
    await withCliSandbox(async (sandbox) => {
      await writeFile(
        sandbox.settingsPath,
        `${JSON.stringify({ "coffee-preferences": { theme: "coast" } })}\n`,
      );
      const result = await spawnPtyCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        {
          streamScenario: "pty-preview",
          scriptedInput: "/theme\r\u001b[B\u001b/theme\r\u001b/exit\r",
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.doesNotMatch(stripAnsi(result.stdout), /已切换为/u);
      assert.equal(
        JSON.parse(await readFile(sandbox.settingsPath, "utf8"))
          ["coffee-preferences"].theme,
        "coast",
      );
      assert.match(stripAnsi(result.stdout), /周末海岸.*当前/u);
    });
  },
);

test(
  "a failed theme save keeps the runtime theme unchanged",
  { skip: SHELL_PTY_SKIP },
  async () => {
    await withCliSandbox(async (sandbox) => {
      await writeFile(sandbox.settingsPath, "{ invalid json\n");
      const result = await spawnPtyCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        {
          streamScenario: "pty-preview",
          scriptedInput: "/theme\r\u001b[B\r/theme\r\u001b/exit\r",
        },
      );

      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(
        result.stdout + result.stderr,
        /coffee\.settings\.json 不是有效的 JSON/u,
      );
      assert.doesNotMatch(stripAnsi(result.stdout), /已切换为/u);
      assert.match(stripAnsi(result.stdout), /奶油拿铁.*当前/u);
      assert.equal(await readFile(sandbox.settingsPath, "utf8"), "{ invalid json\n");
    });
  },
);

test("warns and falls back when the saved theme is invalid", async () => {
  await withCliSandbox(async (sandbox) => {
    await writeFile(
      sandbox.settingsPath,
      `${JSON.stringify({ "coffee-preferences": { theme: "neon" } })}\n`,
    );
    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /coffee-preferences\.theme/u);
    assert.match(result.stdout, /Coffee/u);
    assert.equal(existsSync(sandbox.requestsPath), false);
  });
});

test(
  "restores a persisted theme after restart",
  { skip: SHELL_PTY_SKIP },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const first = await spawnPtyCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        {
          streamScenario: "pty-preview",
          scriptedInput: "/theme\r\u001b[B\r/exit\r",
        },
      );
      assert.equal(first.code, 0, first.stdout + first.stderr);

      const restarted = await spawnPtyCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        {
          streamScenario: "pty-preview",
          scriptedInput: "/theme\r\u001b/exit\r",
        },
      );

      assert.equal(restarted.code, 0, restarted.stdout + restarted.stderr);
      assert.match(stripAnsi(restarted.stdout), /周末海岸.*当前/u);
      assert.doesNotMatch(stripAnsi(restarted.stdout), /已切换为/u);
    });
  },
);

test("treats the retired like command as unknown without using the network", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/like\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /未知命令：\/like/u);
    assert.doesNotMatch(result.stdout + result.stderr, /是否改用/u);
    assert.equal(existsSync(sandbox.requestsPath), false);
  });
});

test("suggests a misspelled theme command without using the network", async () => {
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    "/theem\nn\n/exit\n",
  );
  const output = result.stdout + result.stderr;

  assert.equal(result.code, 0);
  assert.match(output, /未找到命令：\/theem/);
  assert.match(output, /是否改用 \/theme/);
  assert.doesNotMatch(result.stderr, /意外的网络请求/);
});

test("sanitizes terminal controls from a command suggestion", async () => {
  const payload =
    "\u001b]52;c;DANGEROUS_SUGGESTION\u0007\u001b[2J\u0007";
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    `/theem ${payload}\nn\n/exit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /未找到命令：\/theem/);
  assert.match(result.stdout, /是否改用 \/theme/);
  for (const output of [result.stdout, result.stderr]) {
    assert.equal(output.includes("\u001b"), false);
    assert.equal(output.includes("\u0007"), false);
    assert.doesNotMatch(output, /DANGEROUS_SUGGESTION|\[2J|]52;/);
  }
});

test("blocks an unknown slash command and lists local commands", async () => {
  const result = await runCli(
    { DEEPSEEK_API_KEY: "test-key", TAVILY_API_KEY: "tvly-test" },
    "/coffee\n/exit\n",
  );
  const output = result.stdout + result.stderr;

  assert.equal(result.code, 0);
  assert.match(output, /未知命令：\/coffee/);
  assert.match(output, /\/theme\s+切换终端主题/);
  assert.doesNotMatch(output, /\/like/u);
  assert.match(output, /\/exit\s+退出 Coffee/);
  assert.doesNotMatch(result.stderr, /意外的网络请求/);
});

test("sanitizes terminal controls from an unknown command and keeps help", async () => {
  const payload =
    "\u001b]52;c;DANGEROUS_UNKNOWN\u0007\u001b[2J\u0007";
  const result = await runCli(
    { DEEPSEEK_API_KEY: "test-key", TAVILY_API_KEY: "tvly-test" },
    `/coffee${payload}\n/exit\n`,
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /未知命令：\/coffee/);
  assert.match(result.stderr, /\/theme\s+切换终端主题/);
  assert.doesNotMatch(result.stderr, /\/like/u);
  assert.match(result.stderr, /\/exit\s+退出 Coffee/);
  for (const output of [result.stdout, result.stderr]) {
    assert.equal(output.includes("\u001b"), false);
    assert.equal(output.includes("\u0007"), false);
    assert.doesNotMatch(output, /DANGEROUS_UNKNOWN|\[2J|]52;/);
  }
});

test("logs into OpenCode without echoing the key and exposes Go and Zen", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home } = sandbox;
    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/login\n2\nopencode-secret\n/model\n1\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /DeepSeek/);
    assert.match(result.stdout, /OpenCode/);
    assert.match(result.stdout, /方舟 Agent Plan/);
    assert.match(result.stdout, /OpenCode.*凭证已保存/);
    assert.match(result.stdout, /OpenCode Go/);
    assert.match(result.stdout, /OpenCode Zen/);
    assert.doesNotMatch(result.stdout + result.stderr, /opencode-secret/);
    assert.deepEqual(
      JSON.parse(
        await readFile(path.join(home, ".coffee", "auth.json"), "utf8"),
      ),
      {
        version: 1,
        credentials: {
          opencode: { type: "api_key", key: "opencode-secret" },
        },
      },
    );
  });
});

test("login saves credentials without selecting a model", async () => {
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    "/login\n2\nopencode-secret\n你好\n/exit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /尚未选择模型.*\/model/);
  assert.doesNotMatch(result.stderr, /意外的网络请求/);
  assert.doesNotMatch(result.stdout + result.stderr, /opencode-secret/);
});

test("updates a saved login without echoing old, environment, or new keys", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home } = sandbox;
    const authDirectory = path.join(home, ".coffee");
    const authPath = path.join(authDirectory, "auth.json");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        credentials: {
          deepseek: { type: "api_key", key: "saved-old-secret" },
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "environment-secret",
        TAVILY_API_KEY: "tvly-test",
      },
      "/login\n1\n2\nsaved-new-secret\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /DeepSeek.*凭证已保存/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /saved-old-secret|environment-secret|saved-new-secret/,
    );
    assert.equal(
      JSON.parse(await readFile(authPath, "utf8")).credentials.deepseek.key,
      "saved-new-secret",
    );
  });
});

test("persists a selected model and keeps unrelated settings", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home, settingsPath } = sandbox;
    await writeFile(
      settingsPath,
      `${JSON.stringify({ "coffee-preferences": { animation: "latte" } }, null, 2)}\n`,
    );
    const authDirectory = path.join(home, ".coffee");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      path.join(authDirectory, "auth.json"),
      `${JSON.stringify(
        {
          version: 1,
          credentials: {
            opencode: { type: "api_key", key: "opencode-secret" },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/model\n1\n6\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /OpenCode Go.*Kimi K2\.7 Code/);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      "coffee-preferences": { animation: "latte" },
      "model-preferences": {
        provider: "opencode-go",
        model: "kimi-k2.7-code",
      },
    });
  });
});

test("does not change the active model when saving its preference fails", async () => {
  await withCliSandbox(async (sandbox) => {
    const { settingsPath } = sandbox;
    await writeFile(settingsPath, "{ invalid json\n");

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "deepseek-key",
        OPENCODE_API_KEY: "opencode-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "/model\n2\n1\n/model\n1\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /coffee\.settings\.json 不是有效的 JSON/);
    assert.doesNotMatch(result.stdout, /OpenCode Go\s+当前/);
  });
});

test("logout removes the saved key but reports environment fallback", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home } = sandbox;
    const authDirectory = path.join(home, ".coffee");
    const authPath = path.join(authDirectory, "auth.json");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        credentials: {
          deepseek: { type: "api_key", key: "saved-key" },
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "env-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "/logout\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\.env 中的凭证仍然生效/);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      version: 1,
      credentials: {},
    });
  });
});

test("logout keeps the selected model and blocks its next turn locally", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home, settingsPath } = sandbox;
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        "model-preferences": {
          provider: "opencode-go",
          model: "deepseek-v4-flash",
        },
      })}\n`,
    );
    const authDirectory = path.join(home, ".coffee");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      path.join(authDirectory, "auth.json"),
      `${JSON.stringify({
        version: 1,
        credentials: {
          opencode: { type: "api_key", key: "opencode-secret" },
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/logout\n1\n你好\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /当前模型缺少登录凭证/);
    assert.doesNotMatch(result.stderr, /尚未选择模型|意外的网络请求/);
  });
});

test("does not offer an environment-only credential for logout", async () => {
  const result = await runCli(
    { DEEPSEEK_API_KEY: "env-key", TAVILY_API_KEY: "tvly-test" },
    "/logout\n/exit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /没有保存在 ~\/\.coffee\/auth\.json 中的凭证/);
  assert.doesNotMatch(result.stdout, /选择退出的平台/);
});

test("blocks chat locally when no provider is logged in", async () => {
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    "你好\n/exit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stderr, /先使用 \/login.*\/model/);
  assert.doesNotMatch(result.stderr, /意外的网络请求/);
});

test("warns without silently falling back when a saved model preference is invalid", async () => {
  await withCliSandbox(async (sandbox) => {
    const { settingsPath } = sandbox;
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        "model-preferences": {
          provider: "opencode-go",
          model: "missing-model",
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "deepseek-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "/model\n1\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /保存的模型偏好.*无效|找不到保存的模型/);
    assert.doesNotMatch(result.stderr, /已回退到可用模型/);
    assert.doesNotMatch(result.stdout, /DeepSeek\s+当前/);
    assert.doesNotMatch(result.stdout, /DeepSeek V4 Flash\s+当前/);
    assert.match(result.stdout, /已切换模型：DeepSeek \/ DeepSeek V4 Flash/);
  });
});

test("keeps a valid saved model preference even when another credential is available", async () => {
  await withCliSandbox(async (sandbox) => {
    const { settingsPath } = sandbox;
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        "model-preferences": {
          provider: "opencode-go",
          model: "deepseek-v4-flash",
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "deepseek-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "你好\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stderr, /当前模型缺少登录凭证/);
    assert.doesNotMatch(result.stderr, /尚未选择模型|意外的网络请求/);
  });
});

test("uses the first model from the first credential-backed provider as fallback", async () => {
  const result = await runCli(
    { OPENCODE_API_KEY: "opencode-key", TAVILY_API_KEY: "tvly-test" },
    "/model\n1\n1\n/exit\n",
  );

  assert.equal(result.code, 0);
  assert.match(result.stdout, /OpenCode Go\s+当前/);
  assert.match(result.stdout, /DeepSeek V4 Flash\s+当前/);
  assert.match(result.stdout, /OpenCode Zen/);
});

test("prefers a credential-backed saved model over the DeepSeek default", async () => {
  await withCliSandbox(async (sandbox) => {
    const { home, settingsPath } = sandbox;
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        "model-preferences": {
          provider: "opencode-zen",
          model: "big-pickle",
        },
      })}\n`,
    );
    const authDirectory = path.join(home, ".coffee");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      path.join(authDirectory, "auth.json"),
      `${JSON.stringify({
        version: 1,
        credentials: {
          opencode: { type: "api_key", key: "file-opencode-1234" },
        },
      })}\n`,
    );

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "deepseek-env-key",
        OPENCODE_API_KEY: "env-opencode-5678",
        TAVILY_API_KEY: "tvly-test",
      },
      "/login\n2\n1\n/model\n3\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /fil••••••1234/);
    assert.doesNotMatch(result.stdout, /env••••••5678/);
    assert.match(result.stdout, /OpenCode Zen\s+当前/);
    assert.match(result.stdout, /big-pickle\s+当前/);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /file-opencode-1234|deepseek-env-key|env-opencode-5678/,
    );
  });
});

test("persists one complete successful turn without storing the API key", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "history-secret-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "第一杯咖啡\n/exit\n",
      { preload: "./test/streaming-fetch.mjs", streamScenario: "text" },
    );

    assert.equal(result.code, 0);
    const store = createHistoryStore(sandbox.historyPath);
    try {
      const sessions = store.listSessions();
      assert.equal(sessions.length, 1);
      const restored = store.loadSession(sessions[0]!.id);
      assert.deepEqual(restored?.turns[0]?.messages, [
        { role: "user", content: "第一杯咖啡" },
        {
          role: "assistant",
          content: "* **晨光**",
          toolCalls: [],
        },
      ]);
    } finally {
      store.close();
    }
    assert.equal(
      (await readFile(sandbox.historyPath)).includes("history-secret-key"),
      false,
    );
  });
});

test("keeps streamed text and all history counts when saving the final reply fails", async () => {
  await withCliSandbox(async (sandbox) => {
    const store = createHistoryStore(sandbox.historyPath);
    try {
      store.commitTurn({
        title: "已有会话",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "已有问题" },
          { role: "assistant", content: "已有回答", toolCalls: [] },
        ],
      });
    } finally {
      store.close();
    }
    const before = readHistoryCounts(sandbox.historyPath);
    const database = new Database(sandbox.historyPath);
    try {
      database.exec(`
        CREATE TRIGGER fail_cli_turn_commit
        BEFORE INSERT ON turns
        BEGIN
          SELECT RAISE(ABORT, 'injected CLI save failure');
        END
      `);
    } finally {
      database.close();
    }

    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "cli-save-secret",
        TAVILY_API_KEY: "tvly-test",
      },
      "保存失败的一轮\n/exit\n",
      { preload: "./test/streaming-fetch.mjs", streamScenario: "text" },
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\* \*\*晨光\*\*\n/);
    assert.match(
      result.stderr,
      /回答已生成，但历史保存失败，本轮未记录.*injected CLI save failure/,
    );
    assert.doesNotMatch(result.stdout + result.stderr, /cli-save-secret/);
    assert.deepEqual(readHistoryCounts(sandbox.historyPath), before);
  });
});

test("restores the active session and sends its old turn on restart", async () => {
  await withCliSandbox(async (sandbox) => {
    const environment = {
      COFFEE_TEST_REQUESTS_PATH: sandbox.requestsPath,
      DEEPSEEK_API_KEY: "test-key",
      TAVILY_API_KEY: "tvly-test",
    };
    const options = {
      preload: "./test/streaming-fetch.mjs",
      streamScenario: "text",
    } as const;

    const first = await spawnCli(
      sandbox,
      environment,
      "记住第一杯\n/exit\n",
      options,
    );
    assert.equal(first.code, 0);
    const second = await spawnCli(
      sandbox,
      environment,
      "继续第二杯\n/exit\n",
      options,
    );

    assert.equal(second.code, 0);
    assert.match(
      second.stdout,
      /已恢复会话：记住第一杯（deepseek\/deepseek-v4-flash）/,
    );
    const requests = await readCapturedRequests(sandbox.requestsPath);
    assert.deepEqual(requests[1]?.messages.slice(1), [
      { role: "user", content: "记住第一杯" },
      {
        role: "assistant",
        content: "* **晨光**",
        reasoning_content: "",
      },
      { role: "user", content: "继续第二杯" },
    ]);
  });
});

test("new stays lazy, clears active restoration, and adds no empty session", async () => {
  await withCliSandbox(async (sandbox) => {
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      TAVILY_API_KEY: "tvly-test",
    };
    const turnOptions = {
      preload: "./test/streaming-fetch.mjs",
      streamScenario: "text",
    } as const;
    await spawnCli(sandbox, environment, "旧会话\n/exit\n", turnOptions);

    const cleared = await spawnCli(sandbox, environment, "/new\n/exit\n");
    assert.equal(cleared.code, 0);
    assert.match(cleared.stdout, /已开始新会话/);
    const store = createHistoryStore(sandbox.historyPath);
    try {
      assert.equal(store.listSessions().length, 1);
      assert.equal(store.getActiveSessionId(), undefined);
    } finally {
      store.close();
    }

    const restarted = await spawnCli(sandbox, environment, "/exit\n");
    assert.equal(restarted.code, 0);
    assert.doesNotMatch(restarted.stdout, /已恢复会话/);
  });
});

test("sessions choice switches history and model before the next request", async () => {
  await withCliSandbox(async (sandbox) => {
    const environment = {
      COFFEE_TEST_REQUESTS_PATH: sandbox.requestsPath,
      DEEPSEEK_API_KEY: "deepseek-key",
      OPENCODE_API_KEY: "opencode-key",
      TAVILY_API_KEY: "tvly-test",
    };
    const options = {
      preload: "./test/streaming-fetch.mjs",
      streamScenario: "text",
    } as const;
    const created = await spawnCli(
      sandbox,
      environment,
      "深度会话\n/new\n/model\n2\n6\n开放会话\n/exit\n",
      options,
    );
    assert.equal(created.code, 0);

    const store = createHistoryStore(sandbox.historyPath);
    let firstListed: ReturnType<typeof store.listSessions>[number];
    try {
      assert.equal(store.listSessions().length, 2);
      firstListed = store.listSessions()[0]!;
    } finally {
      store.close();
    }

    const switched = await spawnCli(
      sandbox,
      environment,
      "/new\n/sessions\n1\n继续这个会话\n/exit\n",
      options,
    );
    assert.equal(switched.code, 0);
    assert.match(
      switched.stdout,
      new RegExp(`已切换会话：${firstListed.title}`),
    );
    const requests = await readCapturedRequests(sandbox.requestsPath);
    const last = requests.at(-1)!;
    assert.equal(last.model, firstListed.modelId);
    assert.ok(
      last.messages.some(
        (message) =>
          message.role === "user" && message.content === firstListed.title,
      ),
    );
  });
});

test("delete defaults to no, then y cascades the current session", async () => {
  await withCliSandbox(async (sandbox) => {
    const environment = {
      DEEPSEEK_API_KEY: "test-key",
      TAVILY_API_KEY: "tvly-test",
    };
    await spawnCli(sandbox, environment, "待删除\n/exit\n", {
      preload: "./test/streaming-fetch.mjs",
      streamScenario: "text",
    });

    const kept = await spawnCli(sandbox, environment, "/delete\n\n/exit\n");
    assert.equal(kept.code, 0);
    let database = new Database(sandbox.historyPath, { readonly: true });
    try {
      assert.equal(
        (
          database
            .prepare("SELECT count(*) AS count FROM sessions")
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      database.close();
    }

    const deleted = await spawnCli(sandbox, environment, "/delete\ny\n/exit\n");
    assert.equal(deleted.code, 0);
    assert.match(deleted.stdout, /当前会话已删除/);
    database = new Database(sandbox.historyPath, { readonly: true });
    try {
      for (const table of ["sessions", "turns", "messages"]) {
        assert.equal(
          (
            database
              .prepare(`SELECT count(*) AS count FROM ${table}`)
              .get() as { count: number }
          ).count,
          0,
          table,
        );
      }
    } finally {
      database.close();
    }
  });
});

test("restores a session without credentials and blocks locally without fetch", async () => {
  await withCliSandbox(async (sandbox) => {
    await spawnCli(
      sandbox,
      { DEEPSEEK_API_KEY: "test-key", TAVILY_API_KEY: "tvly-test" },
      "需要登录的会话\n/exit\n",
      { preload: "./test/streaming-fetch.mjs", streamScenario: "text" },
    );

    const restored = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "继续\n/exit\n",
    );
    assert.equal(restored.code, 0);
    assert.match(restored.stdout, /已恢复会话/);
    assert.match(restored.stderr, /\/login.*\/model|\/login/);
    assert.doesNotMatch(restored.stderr, /意外的网络请求/);
  });
});

test("reports the absolute corrupt history path and leaves its bytes unchanged", async () => {
  await withCliSandbox(async (sandbox) => {
    const corrupt = Buffer.from("not a sqlite database\u0000keep me");
    await mkdir(path.dirname(sandbox.historyPath), { recursive: true });
    await writeFile(sandbox.historyPath, corrupt);

    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/exit\n",
    );

    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      new RegExp(
        sandbox.historyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      ),
    );
    assert.deepEqual(await readFile(sandbox.historyPath), corrupt);
  });
});

test("sanitizes restored SQLite metadata at every CLI rendering boundary", async () => {
  await withCliSandbox(async (sandbox) => {
    const store = createHistoryStore(sandbox.historyPath);
    let normalSessionId = "";
    let unsafeSessionId = "";
    try {
      normalSessionId = store.commitTurn({
        title: "正常中文",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        messages: [
          { role: "user", content: "正常中文" },
          { role: "assistant", content: "正常回答", toolCalls: [] },
        ],
      }).id;
      unsafeSessionId = store.commitTurn({
        title: "\u001b]52;c;DANGEROUS_TITLE\u0007\u001b[2J\u0007",
        providerId: "deep\u0007seek",
        modelId: "model\u001b[2J-id",
        messages: [
          { role: "user", content: "恶意元数据" },
          { role: "assistant", content: "历史正文", toolCalls: [] },
        ],
      }).id;
    } finally {
      store.close();
    }
    const database = new Database(sandbox.historyPath);
    try {
      database
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run("2026-07-27T08:00:00.000Z", normalSessionId);
      database
        .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
        .run("2026-07-27T08:00:01.000Z", unsafeSessionId);
    } finally {
      database.close();
    }

    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/sessions\n1\n/delete\n\n/exit\n",
    );
    const combined = result.stdout + result.stderr;

    assert.equal(result.code, 0);
    assert.match(result.stdout, /已恢复会话：新会话（deep seek\/model -id）/);
    assert.match(result.stdout, /已切换会话：新会话/);
    assert.match(result.stdout, /确定删除“新会话”及其全部历史吗/);
    assert.match(result.stdout, /正常中文/);
    assert.equal(combined.includes("\u001b"), false);
    assert.equal(combined.includes("\u0007"), false);
    assert.doesNotMatch(combined, /DANGEROUS_TITLE|\[2J|]52;/);
  });
});

test("sanitizes a blocked history path before printing its error", async () => {
  await withCliSandbox(async (sandbox) => {
    const blockerPath = path.join(sandbox.home, "blocker");
    const unsafeHistoryPath = path.join(
      blockerPath,
      "history-safe\u001b]52;c;DANGEROUS_PATH\u0007\u001b[2J-broken.sqlite",
    );
    const blocker = Buffer.from("ordinary blocking file\u0000keep me");
    await writeFile(blockerPath, blocker);

    const result = await spawnCli(
      { ...sandbox, historyPath: unsafeHistoryPath },
      { TAVILY_API_KEY: "tvly-test" },
      "/exit\n",
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /history-safe/);
    assert.match(result.stderr, /-broken\.sqlite/);
    assert.equal(result.stderr.includes("\u001b"), false);
    assert.equal(result.stderr.includes("\u0007"), false);
    assert.doesNotMatch(result.stderr, /DANGEROUS_PATH|\[2J|]52;/);
    assert.deepEqual(await readFile(blockerPath), blocker);
  });
});

test("handles local plan show and the no-plan cancel case without model access", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/plan\n/plan cancel\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.equal(
      (result.stdout.match(/当前会话还没有任务计划。/gu) ?? []).length,
      2,
    );
    assert.doesNotMatch(result.stderr, /\/like/);
  });
});

for (const status of ["active", "blocked"] as const) {
  test(`shows and cancels a ${status} plan locally`, async () => {
    await withCliSandbox(async (sandbox) => {
      seedPlan(sandbox.historyPath, status);
      const result = await spawnCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        "/plan\n/plan cancel\n/plan\n/exit\n",
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, new RegExp(`计划：${status} 计划`, "u"));
      assert.match(result.stdout, /✓ 当前计划已取消。/u);
      assert.match(result.stdout, /状态：已取消/u);
      const store = createHistoryStore(sandbox.historyPath);
      try {
        assert.equal(
          store.plans.loadForSession(store.getActiveSessionId()!)?.status,
          "cancelled",
        );
      } finally {
        store.close();
      }
    });
  });
}

for (const [status, message] of [
  ["completed", "当前计划已经完成，无法取消。"],
  ["cancelled", "当前计划已经取消。"],
] as const) {
  test(`keeps a ${status} plan unchanged when cancellation is unavailable`, async () => {
    await withCliSandbox(async (sandbox) => {
      seedPlan(sandbox.historyPath, status);
      const result = await spawnCli(
        sandbox,
        { TAVILY_API_KEY: "tvly-test" },
        "/plan cancel\n/plan\n/exit\n",
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, new RegExp(message, "u"));
      assert.match(
        result.stdout,
        new RegExp(`状态：${status === "completed" ? "已完成" : "已取消"}`, "u"),
      );
      const store = createHistoryStore(sandbox.historyPath);
      try {
        assert.equal(
          store.plans.loadForSession(store.getActiveSessionId()!)?.status,
          status,
        );
      } finally {
        store.close();
      }
    });
  });
}

test("keeps plans aligned through new, sessions, model, and delete lifecycle commands", async () => {
  await withCliSandbox(async (sandbox) => {
    seedPlan(sandbox.historyPath, "active", "生命周期计划");
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "deepseek-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      [
        "/plan",
        "/new",
        "/plan",
        "/sessions",
        "1",
        "/plan",
        "/model",
        "1",
        "1",
        "/plan",
        "/delete",
        "y",
        "/plan",
        "/exit",
        "",
      ].join("\n"),
    );

    assert.equal(result.code, 0);
    assert.equal(
      (result.stdout.match(/计划：生命周期计划/gu) ?? []).length,
      3,
    );
    assert.equal(
      (result.stdout.match(/当前会话还没有任务计划。/gu) ?? []).length,
      2,
    );
    assert.match(result.stdout, /已切换模型/u);
    const database = new Database(sandbox.historyPath, { readonly: true });
    try {
      assert.equal(
        database.prepare("SELECT count(*) FROM task_plans").pluck().get(),
        0,
      );
      assert.equal(
        database.prepare("SELECT count(*) FROM task_steps").pluck().get(),
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("replaces a completed plan in the same Session and cascades the replacement on delete", async () => {
  await withCliSandbox(async (sandbox) => {
    const sessionId = seedPlan(
      sandbox.historyPath,
      "completed",
      "已完成的旧计划",
    );
    const oldPlanId = "plan-completed";

    const completed = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "planning-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "执行新的复杂任务\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "planning",
      },
    );

    assert.equal(completed.code, 0);
    assert.doesNotMatch(completed.stderr, /readline|uncaught|ERR_/iu);
    const replaced = new Database(sandbox.historyPath, { readonly: true });
    try {
      const current = replaced
        .prepare(
          "SELECT id, session_id FROM task_plans WHERE session_id = ?",
        )
        .get(sessionId) as
        | { id: string; session_id: string }
        | undefined;
      assert.ok(current);
      assert.notEqual(current.id, oldPlanId);
      assert.equal(current.session_id, sessionId);
      assert.equal(
        replaced
          .prepare("SELECT count(*) FROM task_steps WHERE plan_id = ?")
          .pluck()
          .get(oldPlanId),
        0,
      );
      assert.equal(
        replaced
          .prepare("SELECT count(*) FROM task_steps WHERE plan_id = ?")
          .pluck()
          .get(current.id),
        2,
      );
    } finally {
      replaced.close();
    }

    const deleted = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/delete\ny\n/exit\n",
    );

    assert.equal(deleted.code, 0);
    assert.match(deleted.stdout, /会话已删除/u);
    assert.doesNotMatch(deleted.stderr, /readline|uncaught|ERR_/iu);
    const database = new Database(sandbox.historyPath, { readonly: true });
    try {
      assert.equal(
        database.prepare("SELECT count(*) FROM sessions").pluck().get(),
        0,
      );
      assert.equal(
        database.prepare("SELECT count(*) FROM task_plans").pluck().get(),
        0,
      );
      assert.equal(
        database.prepare("SELECT count(*) FROM task_steps").pluck().get(),
        0,
      );
    } finally {
      database.close();
    }
  });
});

test("runs the deterministic planning scenario without duplicate non-TTY progress", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "planning-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "执行复杂任务\n/plan\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "planning",
      },
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /◐ 1\/2 检查输入/u);
    assert.match(result.stdout, /✓ 1\/2 检查输入/u);
    assert.match(result.stdout, /状态：已完成 · 2\/2/u);
    assert.equal(
      (result.stdout.match(/两步计划已完成。/gu) ?? []).length,
      1,
    );
    assert.doesNotMatch(result.stdout, /\u001b\[/u);
    assert.doesNotMatch(result.stdout, /工具执行已经完成.*create_plan/u);
  });
});

test("persists one blocked planning question without duplicate progress copy", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "planning-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "执行有歧义的任务\n/plan\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "planning-blocked",
      },
    );

    assert.equal(result.code, 0);
    assert.equal(
      (result.stdout.match(/◐ 1\/2 检查输入/gu) ?? []).length,
      1,
    );
    assert.equal(
      (result.stdout.match(/Ⅱ 1\/2 检查输入 · 需要用户选择目标文件/gu) ?? [])
        .length,
      1,
    );
    assert.equal(
      (result.stdout.match(/请选择目标文件：A 还是 B？/gu) ?? []).length,
      1,
    );
    assert.match(result.stdout, /状态：已阻塞 · 0\/2/u);
    assert.match(result.stdout, /阻塞原因：需要用户选择目标文件/u);
    assert.doesNotMatch(result.stdout, /\u001b\[/u);
    const store = createHistoryStore(sandbox.historyPath);
    try {
      const sessionId = store.getActiveSessionId();
      assert.ok(sessionId);
      assert.equal(store.plans.loadForSession(sessionId)?.status, "blocked");
    } finally {
      store.close();
    }
  });
});

test(
  "uses one compact plan line independent of the old coffee preference",
  { skip: SHELL_PTY_SKIP },
  async () => {
    for (const [animation, icon] of [
      ["americano", "☕"],
      ["latte", "♡"],
    ] as const) {
      await withCliSandbox(async (sandbox) => {
        await writeFile(
          sandbox.settingsPath,
          `${JSON.stringify({
            "coffee-preferences": { animation },
          })}\n`,
          "utf8",
        );
        const result = await spawnPtyCli(
          sandbox,
          {
            DEEPSEEK_API_KEY: "planning-test-key",
            TAVILY_API_KEY: "tvly-test",
          },
          {
            streamScenario: "planning",
            answerText: "两步计划已完成。",
          },
        );

        assert.equal(result.code, 0);
        assert.match(result.stdout, /1\/2 \[░░░░░░░░░░\] 0% ◐/u);
        assert.doesNotMatch(result.stdout, new RegExp(icon, "u"));
        assert.match(result.stdout, /\r\u001b\[2K/u);
        assert.doesNotMatch(result.stdout, /\u001b\[8A/u);
        assert.doesNotMatch(result.stderr, /readline|ERR_/iu);
      });
    }
  },
);

test(
  "keeps long planning progress within the real PTY width",
  { skip: SHELL_PTY_SKIP },
  async () => {
    await withCliSandbox(async (sandbox) => {
      const result = await spawnPtyCli(
        sandbox,
        {
          DEEPSEEK_API_KEY: "planning-test-key",
          TAVILY_API_KEY: "tvly-test",
        },
        {
          streamScenario: "planning-long",
          answerText: "两步计划已完成。",
        },
      );

      assert.equal(result.code, 0);
      const dynamicLines = Array.from(
        result.stdout.matchAll(/\r\u001b\[2K([^\r\n]*)/gu),
        (match) => (match[1] ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, ""),
      ).filter((line) => /[◐◓◑◒]/u.test(line) && line.includes("%"));
      assert.ok(dynamicLines.length >= 2);
      assert.ok(
        dynamicLines.every((line) => stringWidth(line) <= 79),
        dynamicLines.join("\n"),
      );
    });
  },
);

test("SIGINT preserves a zero-turn plan and restart can show it", async () => {
  await withCliSandbox(async (sandbox) => {
    const interrupted = await spawnCli(
      sandbox,
      {
        DEEPSEEK_API_KEY: "planning-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "创建并等待\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "planning-hang",
        interruptWhenOutput: "检查输入",
      },
    );

    assert.equal(interrupted.code, 0);
    assert.doesNotMatch(interrupted.stderr, /readline|AbortError|ERR_/iu);
    assert.equal(interrupted.stdout.endsWith("\u001b[2K"), false);
    const store = createHistoryStore(sandbox.historyPath);
    try {
      const sessionId = store.getActiveSessionId();
      assert.ok(sessionId);
      assert.equal(store.loadSession(sessionId)?.turns.length, 0);
      assert.equal(store.plans.loadForSession(sessionId)?.status, "active");
    } finally {
      store.close();
    }

    const restarted = await spawnCli(
      sandbox,
      { TAVILY_API_KEY: "tvly-test" },
      "/plan\n/exit\n",
    );
    assert.equal(restarted.code, 0);
    assert.match(restarted.stdout, /计划：完成两步确定性验证/u);
    assert.match(restarted.stdout, /状态：进行中/u);
  });
});

test("a plan progress output failure does not change persisted completion", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnCli(
      sandbox,
      {
        COFFEE_TEST_THROW_PLAN_OUTPUT: "1",
        DEEPSEEK_API_KEY: "planning-test-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "执行复杂任务\n/plan\n/exit\n",
      {
        preload: "./test/streaming-fetch.mjs",
        streamScenario: "planning",
      },
    );

    assert.equal(result.code, 0);
    const store = createHistoryStore(sandbox.historyPath);
    try {
      const sessionId = store.getActiveSessionId();
      assert.ok(sessionId);
      assert.equal(store.plans.loadForSession(sessionId)?.status, "completed");
    } finally {
      store.close();
    }
  });
});
