import type { Dir } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import path from "node:path";

import type { RegisteredTool } from "../tool-registry.js";
import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  executeCodeTool,
  LS_MAX_ENTRIES,
  OUTPUT_MAX_BYTES,
  READ_MAX_FILE_BYTES,
  READ_MAX_LINES,
  type ToolInteraction,
} from "./types.js";
import { inspectEnvFile, readTextFile } from "./text-files.js";
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
      `${name} 必须是 ${minimum} 到 ${maximum} 的整数。`,
    );
  }
  return result;
}

function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function assertKnownArguments(
  args: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
): void {
  const allowedNames = new Set(allowed);
  const unknown = Object.keys(args).find((name) => !allowedNames.has(name));
  if (unknown !== undefined) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      `${toolName} 不支持参数: ${unknown}`,
    );
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function visibleChild(
  policy: WorkspacePolicy,
  relativePath: string,
  authorizedProtectedRoot?: ResolvedWorkspacePath,
): Promise<ResolvedWorkspacePath | undefined> {
  try {
    const child = await policy.resolve(relativePath, "read");
    if (child.kind === "allowed") return child;
    if (child.kind !== "protected" || authorizedProtectedRoot === undefined) {
      return undefined;
    }

    const [realAuthorizedRoot, realChild] = await Promise.all([
      realpath(authorizedProtectedRoot.absolutePath),
      realpath(child.absolutePath),
    ]);
    return isInside(realAuthorizedRoot, realChild) ? child : undefined;
  } catch (error) {
    if (error instanceof CodeToolError && error.code === "PATH_DENIED") {
      return undefined;
    }
    throw error;
  }
}

async function authorizeProtected(
  target: ResolvedWorkspacePath,
  interaction: ToolInteraction,
  signal: AbortSignal | undefined,
  rejectedMessage: string,
): Promise<void> {
  if (target.kind !== "protected") return;
  const authorized = await interaction.authorizeProtected(
    {
      operation: "read",
      path: target.relativePath,
      reason: target.protectedReason ?? "受保护路径",
    },
    signal,
  );
  signal?.throwIfAborted();
  if (!authorized) {
    throw new CodeToolError("USER_REJECTED", rejectedMessage);
  }
}

function isUnsafeDirectoryOpenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ELOOP" ||
      error.code === "EMLINK" ||
      error.code === "ENOTDIR")
  );
}

async function openDirectory(absolutePath: string): Promise<Dir> {
  try {
    return await opendir(absolutePath);
  } catch (error) {
    if (isUnsafeDirectoryOpenError(error)) {
      throw new CodeToolError("PATH_DENIED", "目标不是可安全列出的目录。");
    }
    throw error;
  }
}

async function assertProtectedTargetUnchanged(
  policy: WorkspacePolicy,
  target: ResolvedWorkspacePath,
): Promise<void> {
  if (target.kind !== "protected") return;
  let current: ResolvedWorkspacePath;
  try {
    current = await policy.resolve(target.relativePath, "read");
  } catch (error) {
    if (error instanceof CodeToolError && error.code === "PATH_DENIED") {
      throw new CodeToolError("PATH_DENIED", "授权期间目录目标已发生变化。");
    }
    throw error;
  }
  if (current.absolutePath !== target.absolutePath) {
    throw new CodeToolError("PATH_DENIED", "授权期间目录目标已发生变化。");
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
          assertKnownArguments(args, ["path", "limit"], "ls");
          if (args.path !== undefined && typeof args.path !== "string") {
            throw new CodeToolError("INVALID_ARGUMENT", "ls 的 path 必须是字符串。");
          }
          const limit = integer(
            args.limit,
            LS_MAX_ENTRIES,
            1,
            LS_MAX_ENTRIES,
            "limit",
          );
          const target = await policy.resolve(args.path ?? ".", "read");
          signal?.throwIfAborted();
          if (!target.exists) {
            throw new CodeToolError("NOT_FOUND", "目录不存在。");
          }
          if (target.kind === "env") {
            throw new CodeToolError("PATH_DENIED", ".env 不是可列出的目录。");
          }
          const directory = await openDirectory(target.absolutePath);
          try {
            await authorizeProtected(
              target,
              interaction,
              signal,
              "用户未授权列出目录。",
            );
            await assertProtectedTargetUnchanged(policy, target);

            const directoryEntries = [];
            for (
              let entry = await directory.read();
              entry !== null;
              entry = await directory.read()
            ) {
              directoryEntries.push(entry);
            }
            directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

            const entries: string[] = [];
            let truncated = false;
            for (const entry of directoryEntries) {
              signal?.throwIfAborted();
              const child = await visibleChild(
                policy,
                target.relativePath === "."
                  ? entry.name
                  : `${target.relativePath}/${entry.name}`,
                target.kind === "protected" ? target : undefined,
              );
              if (!child) continue;

              const display = child.relativePath + (entry.isDirectory() ? "/" : "");
              const nextByteLength = Buffer.byteLength(
                entries.length === 0 ? display : `${entries.join("\n")}\n${display}`,
              );
              if (entries.length >= limit || nextByteLength > OUTPUT_MAX_BYTES) {
                truncated = true;
                break;
              }
              entries.push(display);
            }
            return { ok: true, path: target.relativePath, entries, truncated };
          } finally {
            await directory.close();
          }
        }, signal);
      },
    },
    {
      definition: {
        name: "read",
        description: "按行读取工作区内的 UTF-8 文本文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
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
          assertKnownArguments(args, ["path", "offset", "limit"], "read");
          if (typeof args.path !== "string" || args.path.trim() === "") {
            throw new CodeToolError("INVALID_ARGUMENT", "read 缺少 path。");
          }
          const offset = integer(
            args.offset,
            1,
            1,
            Number.MAX_SAFE_INTEGER,
            "offset",
          );
          const limit = integer(
            args.limit,
            READ_MAX_LINES,
            1,
            READ_MAX_LINES,
            "limit",
          );
          const target = await policy.resolve(args.path, "read");
          signal?.throwIfAborted();
          if (!target.exists) {
            throw new CodeToolError("NOT_FOUND", "文件不存在。");
          }
          if (target.kind === "env") {
            return await inspectEnvFile(target.absolutePath, target.relativePath);
          }
          const file = await readTextFile(
            target.absolutePath,
            READ_MAX_FILE_BYTES,
            target.kind === "protected"
              ? async () => await authorizeProtected(
                target,
                interaction,
                signal,
                "用户未授权读取。",
              )
              : undefined,
          );
          const lines = textLines(file.text);
          const selected = lines.slice(offset - 1, offset - 1 + limit);
          const rendered: string[] = [];
          for (let index = 0; index < selected.length; index += 1) {
            signal?.throwIfAborted();
            const line = `${offset + index}: ${selected[index]}`;
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
            consumed < selected.length || offset - 1 + consumed < lines.length;
          return {
            ok: true,
            path: target.relativePath,
            content: rendered.join("\n"),
            truncated,
            ...(truncated ? { nextOffset: offset + consumed } : {}),
          };
        }, signal);
      },
    },
  ];
}
