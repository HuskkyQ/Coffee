import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CodeToolError } from "./types.js";

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

interface WorkspacePolicyOptions {
  isIgnored?: (relativePath: string) => Promise<boolean>;
}

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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function relativePosix(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

function pathSegments(relativePath: string): readonly string[] {
  return relativePath === "." ? [] : relativePath.split("/");
}

function isEnvPath(segments: readonly string[]): boolean {
  return segments.some((segment) => segment.toLowerCase().startsWith(".env"));
}

function hasGitSegment(relativePath: string): boolean {
  return pathSegments(relativePath).some(
    (segment) => segment.toLowerCase() === ".git",
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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

async function nearestExistingPath(
  root: string,
  candidate: string,
): Promise<{ existingPath: string; targetExists: boolean }> {
  let current = candidate;
  let targetExists = true;

  while (true) {
    try {
      await lstat(current);
      return { existingPath: current, targetExists };
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      targetExists = false;
      if (current === root) throw error;
      current = path.dirname(current);
    }
  }
}

async function assertNoSymlinkBetween(
  root: string,
  relativePath: string,
): Promise<void> {
  let current = root;
  for (const segment of pathSegments(relativePath)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new CodeToolError(
          "PATH_DENIED",
          "写入路径不能经过符号链接。",
        );
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function classifyPath(
  relativePaths: readonly string[],
  isIgnored: (relativePath: string) => Promise<boolean>,
): Promise<Pick<ResolvedWorkspacePath, "kind" | "protectedReason">> {
  const uniquePaths = [...new Set(relativePaths)];
  const segmentGroups = uniquePaths.map(pathSegments);
  if (segmentGroups.some(isEnvPath)) return { kind: "env" };

  const protectedSegment = segmentGroups
    .flat()
    .map((segment) => segment.toLowerCase())
    .find((segment) => PROTECTED_SEGMENTS.has(segment));
  if (protectedSegment !== undefined) {
    return {
      kind: "protected",
      protectedReason: `受保护目录: ${protectedSegment}`,
    };
  }
  if (segmentGroups.some((segments) =>
    segments.some((segment) => segment.toLowerCase() === ".gitignore")
  )) {
    return { kind: "protected", protectedReason: "受保护文件: .gitignore" };
  }
  for (const relativePath of uniquePaths) {
    if (await isIgnored(relativePath)) {
      return { kind: "protected", protectedReason: "路径被 ignore 规则忽略" };
    }
  }
  return { kind: "allowed" };
}

export function createWorkspacePolicy(
  workspaceRoot: string,
  options: WorkspacePolicyOptions = {},
): WorkspacePolicy {
  const root = path.resolve(workspaceRoot);
  const isIgnored = options.isIgnored ?? ((relativePath: string) =>
    defaultIsIgnored(root, relativePath));

  return {
    root,
    async resolve(requestedPath, operation) {
      if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
        throw new CodeToolError(
          "INVALID_ARGUMENT",
          "path 必须是非空字符串。",
        );
      }

      const absolutePath = path.resolve(root, requestedPath);
      if (!isInside(root, absolutePath)) {
        throw new CodeToolError("PATH_DENIED", "路径位于工作区之外。");
      }

      const relativePath = relativePosix(root, absolutePath);
      if (hasGitSegment(relativePath)) {
        throw new CodeToolError("PATH_DENIED", "禁止访问 .git 路径。");
      }

      const nearest = await nearestExistingPath(root, absolutePath);
      const [realRoot, realExistingPath] = await Promise.all([
        realpath(root),
        realpath(nearest.existingPath),
      ]);
      if (!isInside(realRoot, realExistingPath)) {
        throw new CodeToolError(
          "PATH_DENIED",
          "路径通过符号链接指向工作区之外。",
        );
      }

      const unresolvedSuffix = path.relative(
        nearest.existingPath,
        absolutePath,
      );
      const effectiveCandidate = path.resolve(
        realExistingPath,
        unresolvedSuffix,
      );
      if (!isInside(realRoot, effectiveCandidate)) {
        throw new CodeToolError(
          "PATH_DENIED",
          "路径通过符号链接指向工作区之外。",
        );
      }
      const canonicalRelativePath = relativePosix(realRoot, effectiveCandidate);
      if (hasGitSegment(canonicalRelativePath)) {
        throw new CodeToolError("PATH_DENIED", "禁止访问 .git 路径。");
      }

      if (operation === "write") {
        await assertNoSymlinkBetween(root, relativePath);
      }

      return {
        absolutePath: effectiveCandidate,
        relativePath,
        exists: nearest.targetExists,
        ...await classifyPath(
          [relativePath, canonicalRelativePath],
          isIgnored,
        ),
      };
    },
  };
}
