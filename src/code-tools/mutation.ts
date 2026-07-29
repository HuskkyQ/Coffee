import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  CodeToolError,
  EDIT_MAX_FILE_BYTES,
} from "./types.js";

const queues = new Map<string, Promise<void>>();

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function sameStat(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

export async function hashFile(absolutePath: string): Promise<string> {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0;
  const nonBlocking = typeof fsConstants.O_NONBLOCK === "number"
    ? fsConstants.O_NONBLOCK
    : 0;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle;
    try {
      handle = await open(
        absolutePath,
        fsConstants.O_RDONLY | noFollow | nonBlocking,
      );
    } catch (error) {
      if (hasErrorCode(error, "ELOOP") || hasErrorCode(error, "EMLINK")) {
        throw new CodeToolError("PATH_DENIED", "目标路径不能是符号链接。");
      }
      throw error;
    }

    try {
      const before = await handle.stat();
      if (!before.isFile()) {
        throw new CodeToolError("PATH_DENIED", "目标不是普通文件。");
      }
      if (before.size > EDIT_MAX_FILE_BYTES) {
        throw new CodeToolError("LIMIT_EXCEEDED", "文件超过允许的大小。");
      }
      const buffer = Buffer.allocUnsafe(EDIT_MAX_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > EDIT_MAX_FILE_BYTES) {
        throw new CodeToolError("LIMIT_EXCEEDED", "文件超过允许的大小。");
      }
      const after = await handle.stat();
      if (sameStat(before, after) && total === after.size) {
        return createHash("sha256")
          .update(buffer.subarray(0, total))
          .digest("hex");
      }
    } finally {
      await handle.close();
    }
  }
  throw new CodeToolError(
    "EDIT_CONFLICT",
    "文件在读取期间持续变化，未写入。",
  );
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
    `.${path.basename(target)}.coffee-${randomBytes(24).toString("hex")}.tmp`,
  );
}

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
  return process.platform === "win32" && (
    hasErrorCode(error, "EACCES") ||
    hasErrorCode(error, "EBADF") ||
    hasErrorCode(error, "EINVAL") ||
    hasErrorCode(error, "ENOTSUP") ||
    hasErrorCode(error, "EPERM")
  );
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
  } catch (error) {
    if (isUnsupportedWindowsDirectorySync(error)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedWindowsDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

async function writeDurableTemporary(
  temporary: string,
  content: string,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  const handle = await open(temporary, "wx", mode);
  try {
    signal?.throwIfAborted();
    await handle.writeFile(content, { encoding: "utf8" });
    signal?.throwIfAborted();
    await handle.chmod(mode);
    signal?.throwIfAborted();
    await handle.sync();
    signal?.throwIfAborted();
  } finally {
    await handle.close();
  }
  signal?.throwIfAborted();
}

async function cleanupTemporary(
  temporary: string,
  parent: string,
): Promise<void> {
  let cleanupError: unknown;
  try {
    await rm(temporary, { force: true });
  } catch (error) {
    cleanupError = error;
  }
  try {
    await syncDirectory(parent);
  } catch (error) {
    if (cleanupError === undefined) cleanupError = error;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

interface PathIdentity {
  dev: number;
  ino: number;
}

interface GuardedPathIdentity extends PathIdentity {
  path: string;
  realPath: string;
}

export interface MutationPathGuard {
  targetPath: string;
  workspaceRoot: GuardedPathIdentity;
  ancestor: GuardedPathIdentity;
}

export interface AtomicMutationOptions {
  expectedIdentity?: ExpectedFileIdentity;
  signal?: AbortSignal;
  workspaceGuard?: MutationPathGuard;
}

interface DirectoryIdentity extends PathIdentity {
  realPath: string;
}

function pathIdentity(stats: Awaited<ReturnType<typeof lstat>>): PathIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino) };
}

function sameIdentity(
  left: PathIdentity,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === Number(right.dev) && left.ino === Number(right.ino);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function guardedIdentity(item: string): Promise<GuardedPathIdentity> {
  const stats = await lstat(item);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CodeToolError("EDIT_CONFLICT", "写入路径祖先已发生变化，未写入。");
  }
  return {
    path: path.resolve(item),
    realPath: await realpath(item),
    ...pathIdentity(stats),
  };
}

async function nearestExistingAncestor(
  targetPath: string,
): Promise<GuardedPathIdentity> {
  let current = path.dirname(targetPath);
  while (true) {
    try {
      return await guardedIdentity(current);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

export async function captureMutationPathGuard(
  target: string,
  workspaceRoot: string,
): Promise<MutationPathGuard> {
  const targetPath = path.resolve(target);
  const rootPath = path.resolve(workspaceRoot);
  const rootIdentity = await guardedIdentity(rootPath);
  if (
    !isInside(rootPath, targetPath) &&
    !isInside(rootIdentity.realPath, targetPath)
  ) {
    throw new CodeToolError("EDIT_CONFLICT", "写入目标不在工作区内。");
  }
  const ancestor = await nearestExistingAncestor(targetPath);
  if (!isInside(rootIdentity.realPath, ancestor.realPath)) {
    throw new CodeToolError("EDIT_CONFLICT", "写入路径祖先逃逸工作区，未写入。");
  }
  return { targetPath, workspaceRoot: rootIdentity, ancestor };
}

async function assertGuardUnchanged(
  target: string,
  guard: MutationPathGuard,
  requireSameNearestAncestor = false,
): Promise<void> {
  if (path.resolve(target) !== guard.targetPath) {
    throw new CodeToolError("EDIT_CONFLICT", "写入目标已发生变化，未写入。");
  }
  for (const expected of [guard.workspaceRoot, guard.ancestor]) {
    const current = await guardedIdentity(expected.path);
    if (
      !sameIdentity(expected, await lstat(expected.path)) ||
      current.realPath !== expected.realPath
    ) {
      throw new CodeToolError("EDIT_CONFLICT", "写入路径祖先已发生变化，未写入。");
    }
  }
  if (!isInside(guard.workspaceRoot.realPath, guard.ancestor.realPath)) {
    throw new CodeToolError("EDIT_CONFLICT", "写入路径祖先逃逸工作区，未写入。");
  }
  if (requireSameNearestAncestor) {
    const nearest = await nearestExistingAncestor(guard.targetPath);
    if (
      nearest.path !== guard.ancestor.path ||
      nearest.realPath !== guard.ancestor.realPath ||
      !sameIdentity(guard.ancestor, await lstat(nearest.path))
    ) {
      throw new CodeToolError("EDIT_CONFLICT", "写入路径祖先已发生变化，未写入。");
    }
  }
}

async function stableRealDirectory(directory: string): Promise<DirectoryIdentity> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new CodeToolError("EDIT_CONFLICT", "目标父目录已发生变化，未写入。");
  }
  return { ...pathIdentity(stats), realPath: await realpath(directory) };
}

async function assertDirectoryUnchanged(
  directory: string,
  expected: DirectoryIdentity,
): Promise<void> {
  if (
    !sameIdentity(expected, await lstat(directory)) ||
    await realpath(directory) !== expected.realPath
  ) {
    throw new CodeToolError("EDIT_CONFLICT", "目标父目录已发生变化，未写入。");
  }
}

export interface ExpectedFileIdentity {
  dev: number;
  ino: number;
}

export async function atomicReplace(
  target: string,
  content: string,
  mode: number,
  options: AtomicMutationOptions = {},
): Promise<void> {
  const { expectedIdentity: expected, signal } = options;
  signal?.throwIfAborted();
  if (options.workspaceGuard !== undefined) {
    await assertGuardUnchanged(target, options.workspaceGuard, true);
    signal?.throwIfAborted();
  }
  const parent = path.dirname(target);
  const parentIdentity = await stableRealDirectory(parent);
  signal?.throwIfAborted();
  if (expected !== undefined) {
    const current = await lstat(target);
    signal?.throwIfAborted();
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameIdentity(expected, current)
    ) {
      throw new CodeToolError("EDIT_CONFLICT", "文件身份已发生变化，未写入。");
    }
  }

  const temporary = tempPath(target);
  try {
    await writeDurableTemporary(temporary, content, mode, signal);
    await assertDirectoryUnchanged(parent, parentIdentity);
    signal?.throwIfAborted();
    if (options.workspaceGuard !== undefined) {
      await assertGuardUnchanged(target, options.workspaceGuard, true);
      signal?.throwIfAborted();
    }
    if (expected !== undefined) {
      const current = await lstat(target);
      signal?.throwIfAborted();
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        !sameIdentity(expected, current)
      ) {
        throw new CodeToolError("EDIT_CONFLICT", "文件身份已发生变化，未写入。");
      }
    }
    signal?.throwIfAborted();
    await rename(temporary, target);
    await syncDirectory(parent);
  } finally {
    await cleanupTemporary(temporary, parent);
  }
}

interface CreatedDirectory extends GuardedPathIdentity {}

async function createMissingDirectories(
  directory: string,
  onProgress?: (created: readonly CreatedDirectory[]) => Promise<void>,
): Promise<CreatedDirectory[]> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      const stats = await lstat(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new CodeToolError(
          "EDIT_CONFLICT",
          "目标父路径不是安全目录，未写入。",
        );
      }
      break;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }

  const created: CreatedDirectory[] = [];
  try {
    for (const item of [...missing].reverse()) {
      try {
        await mkdir(item);
        created.push(await guardedIdentity(item));
        await onProgress?.(created);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        const stats = await lstat(item);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new CodeToolError(
            "EDIT_CONFLICT",
            "目标父路径在创建期间发生变化，未写入。",
          );
        }
        throw new CodeToolError(
          "EDIT_CONFLICT",
          "目标父路径在创建期间出现，未写入。",
        );
      }
    }
  } catch (error) {
    await rollbackDirectories(created);
    throw error;
  }
  return created;
}

async function assertCreatedDirectoriesUnchanged(
  directories: readonly CreatedDirectory[],
  workspaceGuard?: MutationPathGuard,
): Promise<void> {
  for (const expected of directories) {
    const current = await guardedIdentity(expected.path);
    if (
      !sameIdentity(expected, await lstat(expected.path)) ||
      current.realPath !== expected.realPath ||
      (workspaceGuard !== undefined &&
        !isInside(workspaceGuard.workspaceRoot.realPath, current.realPath))
    ) {
      throw new CodeToolError("EDIT_CONFLICT", "新建父目录已发生变化，未写入。");
    }
  }
}

async function rollbackDirectories(
  directories: readonly CreatedDirectory[],
): Promise<void> {
  for (const directory of [...directories].reverse()) {
    try {
      const current = await lstat(directory.path);
      if (!sameIdentity(directory, current)) break;
      await rmdir(directory.path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      break;
    }
  }
}

export async function atomicCreate(
  target: string,
  content: string,
  options: AtomicMutationOptions = {},
): Promise<void> {
  options.signal?.throwIfAborted();
  if (options.workspaceGuard !== undefined) {
    await assertGuardUnchanged(target, options.workspaceGuard, true);
    options.signal?.throwIfAborted();
  }
  const parent = path.dirname(target);
  let createdDirectories: CreatedDirectory[] = [];
  let temporary: string | undefined;
  let published = false;
  try {
    createdDirectories = await createMissingDirectories(
      parent,
      async (created) => {
        if (options.workspaceGuard !== undefined) {
          await assertGuardUnchanged(target, options.workspaceGuard);
        }
        await assertCreatedDirectoriesUnchanged(
          created,
          options.workspaceGuard,
        );
        options.signal?.throwIfAborted();
      },
    );
    options.signal?.throwIfAborted();
    const parentIdentity = await stableRealDirectory(parent);
    options.signal?.throwIfAborted();
    await assertCreatedDirectoriesUnchanged(
      createdDirectories,
      options.workspaceGuard,
    );
    options.signal?.throwIfAborted();
    if (options.workspaceGuard !== undefined) {
      await assertGuardUnchanged(target, options.workspaceGuard);
      options.signal?.throwIfAborted();
    }
    temporary = tempPath(target);
    await writeDurableTemporary(temporary, content, 0o644, options.signal);
    await assertDirectoryUnchanged(parent, parentIdentity);
    options.signal?.throwIfAborted();
    await assertCreatedDirectoriesUnchanged(
      createdDirectories,
      options.workspaceGuard,
    );
    options.signal?.throwIfAborted();
    if (options.workspaceGuard !== undefined) {
      await assertGuardUnchanged(target, options.workspaceGuard);
      options.signal?.throwIfAborted();
    }
    options.signal?.throwIfAborted();
    try {
      await link(temporary, target);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new CodeToolError("EDIT_CONFLICT", "目标文件已经存在，未覆盖。");
      }
      throw error;
    }
    published = true;
    await syncDirectory(parent);
    await unlink(temporary);
    await syncDirectory(parent);
  } finally {
    let cleanupError: unknown;
    if (temporary !== undefined) {
      try {
        await cleanupTemporary(temporary, parent);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (!published) await rollbackDirectories(createdDirectories);
    if (cleanupError !== undefined) throw cleanupError;
  }
}
