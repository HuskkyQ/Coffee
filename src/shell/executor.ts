import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createShellOutputProcessor } from "./output.js";
import type { ShellExecutionResult } from "./types.js";

export interface ExecuteShellOptions {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  processEnv?: NodeJS.ProcessEnv;
  shellPath?: string;
}

const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const;

export function buildShellEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  return {
    ...environment,
    CI: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
  };
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveBash(
  shellPath: string | undefined,
  source: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (shellPath !== undefined) {
    return (await isExecutable(shellPath)) ? shellPath : undefined;
  }

  if (process.platform !== "win32" && (await isExecutable("/bin/bash"))) {
    return "/bin/bash";
  }

  const names = process.platform === "win32" ? ["bash.exe", "bash"] : ["bash", "bash.exe"];
  const directories = (source.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

function durationSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(pid: number, maximumMs: number): Promise<boolean> {
  const deadline = performance.now() + maximumMs;
  while (processGroupExists(pid)) {
    if (performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  return true;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch {
        // The direct process has already exited too.
      }
    }
  }
}

type TaskkillRunner = (
  pid: number,
  onError: (error: Error) => void,
  onClose: (exitCode: number | null) => void,
) => void;

function spawnTaskkill(
  pid: number,
  onError: (error: Error) => void,
  onClose: (exitCode: number | null) => void,
): void {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", onError);
  killer.once("close", onClose);
}

export async function terminateWindowsTree(
  pid: number,
  runTaskkill: TaskkillRunner = spawnTaskkill,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let completed = false;
    const fail = (detail: string): void => {
      if (completed) return;
      completed = true;
      reject(new Error(`Process tree cleanup failed: ${detail}`));
    };
    try {
      runTaskkill(
        pid,
        (error) => fail(error.message),
        (exitCode) => {
          if (completed) return;
          completed = true;
          if (exitCode === 0) resolve();
          else reject(
            new Error(
              `Process tree cleanup failed: taskkill exited with code ${String(exitCode)}`,
            ),
          );
        },
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });
}

interface PosixTerminationDependencies {
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  waitForExit(pid: number, maximumMs: number): Promise<boolean>;
}

export async function terminatePosixTree(
  pid: number,
  dependencies: Partial<PosixTerminationDependencies> = {},
): Promise<void> {
  const sendSignal = dependencies.signalGroup ?? signalProcessGroup;
  const waitForExit = dependencies.waitForExit ?? waitForProcessGroupExit;

  sendSignal(pid, "SIGTERM");
  if (await waitForExit(pid, 250)) return;
  sendSignal(pid, "SIGKILL");
  if (!(await waitForExit(pid, 250))) {
    throw new Error(
      "Process tree cleanup failed: process group survived SIGKILL",
    );
  }
}

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === "win32") {
    await terminateWindowsTree(pid);
    return;
  }

  await terminatePosixTree(pid);
}

async function waitBrieflyForClose(closePromise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 50);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureBeforeSpawn(
  command: string,
  startedAt: number,
  code: "SPAWN_FAILED" | "CANCELLED",
  error: string,
): ShellExecutionResult {
  return {
    ok: false,
    command,
    exitCode: null,
    durationMs: durationSince(startedAt),
    timedOut: false,
    cancelled: code === "CANCELLED",
    truncated: false,
    output: "",
    code,
    error,
  };
}

interface ShellExecutorDependencies {
  terminateProcessTree(child: ChildProcess): Promise<void>;
}

const DEFAULT_EXECUTOR_DEPENDENCIES: ShellExecutorDependencies = {
  terminateProcessTree,
};

function cleanupFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return /process tree cleanup failed/i.test(detail)
    ? detail
    : `Process tree cleanup failed: ${detail}`;
}

export async function executeShellCommand(
  options: ExecuteShellOptions,
  dependencies: ShellExecutorDependencies = DEFAULT_EXECUTOR_DEPENDENCIES,
): Promise<ShellExecutionResult> {
  const startedAt = performance.now();
  if (options.signal?.aborted) {
    return failureBeforeSpawn(
      options.command,
      startedAt,
      "CANCELLED",
      "Shell 命令已取消",
    );
  }

  const sourceEnvironment = options.processEnv ?? process.env;
  const shellPath = await resolveBash(options.shellPath, sourceEnvironment);
  if (shellPath === undefined) {
    return failureBeforeSpawn(
      options.command,
      startedAt,
      "SPAWN_FAILED",
      "无法启动 Bash：未找到可执行的 Bash",
    );
  }
  if (options.signal?.aborted) {
    return failureBeforeSpawn(
      options.command,
      startedAt,
      "CANCELLED",
      "Shell 命令已取消",
    );
  }

  let child: ChildProcess;
  try {
    child = spawn(shellPath, ["-c", options.command], {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      env: buildShellEnvironment(sourceEnvironment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return failureBeforeSpawn(
      options.command,
      startedAt,
      "SPAWN_FAILED",
      `无法启动 Bash：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let outputCallbackActive = options.onOutput !== undefined;
  const processor = createShellOutputProcessor({
    onVisibleChunk: options.onOutput === undefined
      ? undefined
      : (chunk) => {
          if (!outputCallbackActive) return;
          try {
            options.onOutput?.(chunk);
          } catch {
            outputCallbackActive = false;
          }
        },
  });
  child.stdout?.on("data", (chunk: Buffer) => processor.push("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => processor.push("stderr", chunk));

  return await new Promise<ShellExecutionResult>((resolve) => {
    type TerminationReason = "timeout" | "cancel";
    let settled = false;
    let terminationReason: TerminationReason | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let closeResolve: (() => void) | undefined;
    const closePromise = new Promise<void>((resolveClose) => {
      closeResolve = resolveClose;
    });

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (
      exitCode: number | null,
      code?: "SPAWN_FAILED" | "TIMED_OUT" | "CANCELLED",
      error?: string,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      const processed = processor.finish();
      resolve({
        ok: code === undefined && exitCode === 0,
        command: options.command,
        exitCode,
        durationMs: durationSince(startedAt),
        timedOut: code === "TIMED_OUT",
        cancelled: code === "CANCELLED",
        truncated: processed.truncated,
        output: processed.output,
        ...(code === undefined ? {} : { code }),
        ...(error === undefined ? {} : { error }),
      });
    };

    const terminate = (reason: TerminationReason): void => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      void (async () => {
        await dependencies.terminateProcessTree(child);
        await waitBrieflyForClose(closePromise);
        if (reason === "timeout") {
          finish(null, "TIMED_OUT", "Shell 命令执行超时");
        } else {
          finish(null, "CANCELLED", "Shell 命令已取消");
        }
      })().catch((error: unknown) => {
        finish(
          null,
          reason === "timeout" ? "TIMED_OUT" : "CANCELLED",
          cleanupFailureMessage(error),
        );
      });
    };

    const onAbort = (): void => terminate("cancel");

    child.once("error", (error) => {
      closeResolve?.();
      if (terminationReason === undefined) {
        finish(null, "SPAWN_FAILED", `无法启动 Bash：${error.message}`);
      }
    });
    child.once("close", (exitCode) => {
      closeResolve?.();
      if (terminationReason === undefined) finish(exitCode);
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    const timeoutMs = Number.isFinite(options.timeoutSeconds)
      ? Math.max(0, options.timeoutSeconds * 1_000)
      : 0;
    timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
    timeoutTimer.unref();
  });
}
