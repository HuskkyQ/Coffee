import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";

import type { RegisteredTool } from "../tool-registry.js";
import { prepareEdit, prepareNewFile, type ExactEdit } from "./edit-diff.js";
import {
  atomicCreate,
  atomicReplace,
  captureMutationPathGuard,
  hashFile,
  type ExpectedFileIdentity,
  withMutationQueue,
} from "./mutation.js";
import { assertSafeTextContent, readTextFile } from "./text-files.js";
import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  EDIT_MAX_FILE_BYTES,
  EDIT_MAX_REPLACEMENTS,
  executeCodeTool,
  type ToolInteraction,
  WRITE_MAX_FILE_BYTES,
} from "./types.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePolicy,
} from "./workspace-policy.js";

interface MutationToolOptions {
  policy: WorkspacePolicy;
  interaction?: ToolInteraction;
}

interface FileSnapshot {
  content: string;
  hash: string;
  mode: number;
  identity: ExpectedFileIdentity;
}

function conflict(message: string): CodeToolError {
  return new CodeToolError("EDIT_CONFLICT", message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainArguments(
  args: unknown,
  toolName: string,
): asserts args is Record<string, unknown> {
  if (!isPlainRecord(args)) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      `${toolName} 参数必须是普通对象。`,
    );
  }
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

async function authorize(
  target: ResolvedWorkspacePath,
  interaction: ToolInteraction,
  signal?: AbortSignal,
): Promise<void> {
  if (target.kind === "env") {
    throw new CodeToolError("PATH_DENIED", ".env 文件只能通过 set_env 修改。");
  }
  if (target.kind !== "protected") return;
  const allowed = await interaction.authorizeProtected({
    operation: "write",
    path: target.relativePath,
    reason: target.protectedReason ?? "受保护路径",
  }, signal);
  signal?.throwIfAborted();
  if (!allowed) {
    throw new CodeToolError("USER_REJECTED", "用户未授权修改受保护路径。");
  }
}

function parseEdits(value: unknown): ExactEdit[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > EDIT_MAX_REPLACEMENTS
  ) {
    throw new CodeToolError("INVALID_ARGUMENT", "edits 必须包含 1 到 20 项。");
  }
  return value.map((item, index) => {
    if (!isPlainRecord(item)) {
      throw new CodeToolError(
        "INVALID_ARGUMENT",
        `edits[${index}] 必须包含 oldText 和 newText。`,
      );
    }
    const record = item;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      !Object.hasOwn(record, "oldText") ||
      !Object.hasOwn(record, "newText") ||
      typeof record.oldText !== "string" ||
      typeof record.newText !== "string"
    ) {
      throw new CodeToolError(
        "INVALID_ARGUMENT",
        `edits[${index}] 只能包含字符串 oldText 和 newText。`,
      );
    }
    return { oldText: record.oldText, newText: record.newText };
  });
}

async function snapshotFile(absolutePath: string): Promise<FileSnapshot> {
  const file = await readTextFile(absolutePath, EDIT_MAX_FILE_BYTES);
  const before = await lstat(absolutePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw conflict("目标不再是原普通文件，未写入。");
  }
  const hash = await hashFile(absolutePath);
  const after = await lstat(absolutePath, { bigint: true });
  const bytesHash = createHash("sha256").update(file.bytes).digest("hex");
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    bytesHash !== hash
  ) {
    throw conflict("文件在读取期间发生变化，未写入。");
  }
  return {
    content: file.bom + file.text,
    hash,
    mode: file.mode,
    identity: { dev: Number(after.dev), ino: Number(after.ino) },
  };
}

function sameIdentity(
  left: ExpectedFileIdentity,
  right: ExpectedFileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertEditTarget(
  policy: WorkspacePolicy,
  requestedPath: string,
  expected: ResolvedWorkspacePath,
  snapshot: FileSnapshot,
): Promise<ResolvedWorkspacePath> {
  let current: ResolvedWorkspacePath;
  let latest: FileSnapshot;
  try {
    current = await policy.resolve(requestedPath, "write");
    if (
      !current.exists ||
      current.absolutePath !== expected.absolutePath ||
      current.kind !== expected.kind
    ) {
      throw conflict("文件在确认期间发生变化，未写入。");
    }
    latest = await snapshotFile(current.absolutePath);
  } catch (error) {
    if (error instanceof CodeToolError && error.code === "EDIT_CONFLICT") {
      throw error;
    }
    throw conflict("文件在确认期间发生变化，未写入。");
  }
  if (
    latest.hash !== snapshot.hash ||
    latest.mode !== snapshot.mode ||
    !sameIdentity(latest.identity, snapshot.identity)
  ) {
    throw conflict("文件在确认期间发生变化，未写入。");
  }
  return current;
}

function assertSamePendingTarget(
  current: ResolvedWorkspacePath,
  initial: ResolvedWorkspacePath,
): void {
  if (
    current.exists ||
    current.absolutePath !== initial.absolutePath ||
    current.kind !== initial.kind
  ) {
    throw conflict("目标路径在确认期间发生变化，未写入。");
  }
}

async function resolveConfirmedWriteTarget(
  policy: WorkspacePolicy,
  requestedPath: string,
): Promise<ResolvedWorkspacePath> {
  try {
    return await policy.resolve(requestedPath, "write");
  } catch {
    throw conflict("目标路径在确认期间发生变化，未写入。");
  }
}

export function createMutationTools({
  policy,
  interaction = DEFAULT_TOOL_INTERACTION,
}: MutationToolOptions): RegisteredTool[] {
  return [
    {
      definition: {
        name: "edit",
        description: "按 edits[] 精确协议修改一个已有文本文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            edits: {
              type: "array",
              minItems: 1,
              maxItems: EDIT_MAX_REPLACEMENTS,
              items: {
                type: "object",
                properties: {
                  oldText: { type: "string" },
                  newText: { type: "string" },
                },
                required: ["oldText", "newText"],
                additionalProperties: false,
              },
            },
          },
          required: ["path", "edits"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          assertPlainArguments(args, "edit");
          assertKnownArguments(args, ["path", "edits"], "edit");
          if (
            !Object.hasOwn(args, "path") ||
            !Object.hasOwn(args, "edits") ||
            typeof args.path !== "string" ||
            args.path.trim() === ""
          ) {
            throw new CodeToolError("INVALID_ARGUMENT", "edit 缺少 path。");
          }
          const requestedPath = args.path;
          const edits = parseEdits(args.edits);
          const initial = await policy.resolve(requestedPath, "write");
          await authorize(initial, interaction, signal);
          if (!initial.exists) {
            throw new CodeToolError("NOT_FOUND", "edit 目标不存在。");
          }

          return await withMutationQueue(initial.absolutePath, async () => {
            signal?.throwIfAborted();
            const queued = await policy.resolve(requestedPath, "write");
            if (
              !queued.exists ||
              queued.absolutePath !== initial.absolutePath ||
              queued.kind !== initial.kind
            ) {
              throw conflict("edit 目标在等待期间发生变化，未写入。");
            }
            const before = await snapshotFile(queued.absolutePath);
            const prepared = prepareEdit(
              queued.relativePath,
              before.content,
              edits,
            );
            assertSafeTextContent(prepared.content);
            const approved = await interaction.confirmMutation({
              kind: "edit",
              path: queued.relativePath,
              patch: prepared.patch,
              changedLines: prepared.changedLines,
            }, signal);
            signal?.throwIfAborted();
            if (!approved) {
              throw new CodeToolError("USER_REJECTED", "用户拒绝了本次修改。");
            }
            const current = await assertEditTarget(
              policy,
              requestedPath,
              queued,
              before,
            );
            signal?.throwIfAborted();
            await atomicReplace(
              current.absolutePath,
              prepared.content,
              before.mode,
              { expectedIdentity: before.identity, signal },
            );
            return {
              ok: true,
              path: current.relativePath,
              changes: edits.length,
              firstChangedLine: prepared.firstChangedLine,
            };
          });
        }, signal);
      },
    },
    {
      definition: {
        name: "write",
        description: "创建新的 UTF-8 文本文件，不能覆盖已有文件。",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", minLength: 1 },
            content: { type: "string", maxLength: WRITE_MAX_FILE_BYTES },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      riskLevel: "write",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          assertPlainArguments(args, "write");
          assertKnownArguments(args, ["path", "content"], "write");
          if (
            !Object.hasOwn(args, "path") ||
            !Object.hasOwn(args, "content") ||
            typeof args.path !== "string" ||
            args.path.trim() === "" ||
            typeof args.content !== "string"
          ) {
            throw new CodeToolError("INVALID_ARGUMENT", "write 需要 path 和 content。");
          }
          const requestedPath = args.path;
          const content = args.content;
          if (Buffer.byteLength(content, "utf8") > WRITE_MAX_FILE_BYTES) {
            throw new CodeToolError("LIMIT_EXCEEDED", "新文件不能超过 1MB。");
          }
          assertSafeTextContent(content);
          const initial = await policy.resolve(requestedPath, "write");
          await authorize(initial, interaction, signal);
          if (initial.exists) {
            throw conflict("目标文件已经存在，不能覆盖。");
          }

          return await withMutationQueue(initial.absolutePath, async () => {
            signal?.throwIfAborted();
            const queued = await policy.resolve(requestedPath, "write");
            assertSamePendingTarget(queued, initial);
            const workspaceGuard = await captureMutationPathGuard(
              queued.absolutePath,
              policy.root,
            );
            const prepared = prepareNewFile(queued.relativePath, content);
            const approved = await interaction.confirmMutation({
              kind: "write",
              path: queued.relativePath,
              patch: prepared.patch,
              changedLines: prepared.changedLines,
            }, signal);
            signal?.throwIfAborted();
            if (!approved) {
              throw new CodeToolError("USER_REJECTED", "用户拒绝了新建文件。");
            }
            const current = await resolveConfirmedWriteTarget(
              policy,
              requestedPath,
            );
            assertSamePendingTarget(current, queued);
            signal?.throwIfAborted();
            await atomicCreate(current.absolutePath, content, {
              signal,
              workspaceGuard,
            });
            return { ok: true, path: current.relativePath, created: true };
          });
        }, signal);
      },
    },
  ];
}
