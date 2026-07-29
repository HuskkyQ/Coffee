import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const LOCK_RETRY_DELAY_MS = 25;
const LOCK_WAIT_TIMEOUT_MS = 2_000;

interface LockOwner {
  pid: number;
  createdAt: string;
  token: string;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    Number.isSafeInteger(value.pid) &&
    typeof value.pid === "number" &&
    value.pid > 0 &&
    "createdAt" in value &&
    typeof value.createdAt === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    value.token.length > 0
  );
}

async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  let text: string;
  try {
    text = await readFile(join(lockPath, "owner.json"), "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  try {
    const value: unknown = JSON.parse(text);
    return isLockOwner(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function releaseOwnedLock(
  lockPath: string,
  token: string,
): Promise<void> {
  const owner = await readLockOwner(lockPath);
  if (owner?.token === token) {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireFileLock(
  targetPath: string,
): Promise<() => Promise<void>> {
  const lockPath = `${targetPath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  await mkdir(dirname(targetPath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }

      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        throw new Error(
          `等待文件锁超时：${targetPath}。另一个 Coffee 进程可能正在更新此文件，请稍后重试；确认没有 Coffee 进程后手动删除锁目录：${lockPath}`,
        );
      }
      await delay(Math.min(LOCK_RETRY_DELAY_MS, remainingTime));
      continue;
    }

    try {
      await chmod(lockPath, 0o700);
      const owner: LockOwner = {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        token,
      };
      const ownerPath = join(lockPath, "owner.json");
      await writeFile(ownerPath, JSON.stringify(owner), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await chmod(ownerPath, 0o600);
      return () => releaseOwnedLock(lockPath, token);
    } catch (error) {
      await releaseOwnedLock(lockPath, token);
      throw error;
    }
  }
}

export async function withFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireFileLock(targetPath);
  try {
    return await operation();
  } finally {
    await release();
  }
}
