import { fork } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_TIMEOUT_MS = 5_000;
const WORKER_STOP_TIMEOUT_MS = 1_000;
const PERSISTENCE_WORKER_PATH = fileURLToPath(
  new URL("./persistence-worker.ts", import.meta.url),
);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface PersistenceWorker {
  ready: Promise<void>;
  attempting: Promise<void>;
  started: Promise<void>;
  completion: Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
}

function createDeferred(): Deferred {
  let settled = false;
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);

  return {
    promise,
    resolve: () => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    },
    reject: (error) => {
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    },
  };
}

function withTimeout(
  promise: Promise<void>,
  label: string,
  onTimeout: () => void,
  timeoutMs = WORKER_TIMEOUT_MS,
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const bounded = Promise.race([
    promise,
    new Promise<void>((_resolve, reject) => {
      timeout = setTimeout(() => {
        onTimeout();
        reject(new Error(`${label} 超过 ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
  void bounded.catch(() => undefined);
  return bounded;
}

export async function holdPersistenceLock(
  targetPath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${targetPath}.lock`;
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      token: "test-holder",
    }),
    { mode: 0o600 },
  );

  let released = false;
  return async () => {
    if (!released) {
      released = true;
      await rm(lockPath, { recursive: true, force: true });
    }
  };
}

export function startPersistenceWorker(
  operation: string,
  targetPath: string,
): PersistenceWorker {
  const child = fork(PERSISTENCE_WORKER_PATH, [operation, targetPath], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const ready = createDeferred();
  const attempting = createDeferred();
  const started = createDeferred();
  const completion = createDeferred();
  const exited = createDeferred();
  const startSignal = createDeferred();
  let stderr = "";
  let receivedReady = false;
  let receivedAttempting = false;
  let receivedStarted = false;
  let receivedDone = false;

  function kill(): void {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  function rejectPending(error: Error): void {
    ready.reject(error);
    attempting.reject(error);
    started.reject(error);
    completion.reject(error);
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (message) => {
    if (typeof message !== "object" || message === null || !("type" in message)) {
      rejectPending(new Error("持久化 worker 返回了无效消息"));
      kill();
      return;
    }

    switch (message.type) {
      case "ready":
        receivedReady = true;
        ready.resolve();
        break;
      case "attempting":
        receivedAttempting = true;
        attempting.resolve();
        break;
      case "started":
        receivedStarted = true;
        started.resolve();
        break;
      case "done":
        receivedDone = true;
        break;
      default:
        rejectPending(new Error(`持久化 worker 返回未知消息：${String(message.type)}`));
        kill();
    }
  });
  child.once("error", (error) => {
    rejectPending(error);
    exited.resolve();
  });
  child.once("exit", (code, signal) => {
    const details = `code=${String(code)}, signal=${String(signal)}`;
    if (!receivedReady) {
      ready.reject(new Error(`持久化 worker 在 ready 前退出（${details}）：${stderr}`));
    }
    if (!receivedAttempting) {
      attempting.reject(
        new Error(`持久化 worker 在 attempting 前退出（${details}）：${stderr}`),
      );
    }
    if (!receivedStarted) {
      started.reject(
        new Error(`持久化 worker 在 started 前退出（${details}）：${stderr}`),
      );
    }
    if (code === 0 && receivedDone) {
      completion.resolve();
    } else {
      completion.reject(
        new Error(`持久化 worker 失败（${details}）：${stderr}`),
      );
    }
    exited.resolve();
  });

  const boundedReady = withTimeout(ready.promise, "等待 worker ready", kill);
  const boundedAttempting = startSignal.promise.then(() =>
    withTimeout(attempting.promise, "等待 worker attempting", kill),
  );
  const boundedStarted = startSignal.promise.then(() =>
    withTimeout(started.promise, "等待 worker started", kill),
  );
  const boundedCompletion = startSignal.promise.then(() =>
    withTimeout(completion.promise, "等待 worker 完成", kill),
  );
  void boundedAttempting.catch(() => undefined);
  void boundedStarted.catch(() => undefined);
  void boundedCompletion.catch(() => undefined);

  return {
    ready: boundedReady,
    attempting: boundedAttempting,
    started: boundedStarted,
    completion: boundedCompletion,
    start: () => {
      startSignal.resolve();
      if (!child.connected) {
        const error = new Error("持久化 worker 已断开，无法启动");
        attempting.reject(error);
        started.reject(error);
        completion.reject(error);
        return;
      }
      child.send("start", (error) => {
        if (error !== null) {
          attempting.reject(error);
          started.reject(error);
          completion.reject(error);
          kill();
        }
      });
    },
    stop: async () => {
      startSignal.resolve();
      rejectPending(new Error("持久化 worker 已停止"));
      if (child.connected) {
        try {
          child.disconnect();
        } catch {
          // The exit/error handlers below own the final worker state.
        }
      }
      kill();
      await withTimeout(
        exited.promise,
        "停止 worker",
        kill,
        WORKER_STOP_TIMEOUT_MS,
      ).catch(() => undefined);
    },
  };
}

export async function stopPersistenceWorkers(
  workers: readonly PersistenceWorker[],
): Promise<void> {
  await Promise.all(workers.map((worker) => worker.stop()));
}
