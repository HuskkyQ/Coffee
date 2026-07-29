import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import type { RegisteredTool } from "../tool-registry.js";
import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  executeCodeTool,
  FIND_MAX_RESULTS,
  GREP_MAX_LINE_LENGTH,
  GREP_MAX_MATCHES,
  OUTPUT_MAX_BYTES,
  type ToolInteraction,
} from "./types.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePolicy,
} from "./workspace-policy.js";

export interface RgResult {
  lines: string[];
  truncated: boolean;
}

export type RgRunner = (
  args: string[],
  cwd: string,
  maximumLines: number,
  signal?: AbortSignal,
) => Promise<RgResult>;

interface SearchToolOptions {
  policy: WorkspacePolicy;
  runRg?: RgRunner;
  interaction?: ToolInteraction;
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

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CodeToolError("INVALID_ARGUMENT", `${name} 必须是非空字符串。`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new CodeToolError("INVALID_ARGUMENT", `${name} 必须是布尔值。`);
  }
  return value as boolean | undefined;
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function logicalChild(target: ResolvedWorkspacePath, result: string): string {
  const normalized = result.replace(/^\.\//, "");
  return target.relativePath === "."
    ? normalized
    : `${target.relativePath}/${normalized}`;
}

async function authorizeTarget(
  target: ResolvedWorkspacePath,
  interaction: ToolInteraction,
  signal: AbortSignal | undefined,
): Promise<ResolvedWorkspacePath | undefined> {
  if (target.kind !== "protected") return undefined;
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
    throw new CodeToolError("USER_REJECTED", "用户未授权搜索受保护路径。");
  }
  return target;
}

async function resolveTarget(
  policy: WorkspacePolicy,
  requestedPath: string,
  findDirectory: boolean,
): Promise<ResolvedWorkspacePath> {
  const target = await policy.resolve(requestedPath, "read");
  if (!target.exists) {
    throw new CodeToolError("NOT_FOUND", "搜索目标不存在。");
  }
  if (target.kind === "env") {
    throw new CodeToolError("PATH_DENIED", "禁止搜索环境变量文件。");
  }
  if (findDirectory && !(await lstat(target.absolutePath)).isDirectory()) {
    throw new CodeToolError("INVALID_ARGUMENT", "find 的 path 必须是目录。");
  }
  return target;
}

async function visibleResult(
  policy: WorkspacePolicy,
  target: ResolvedWorkspacePath,
  resultPath: string,
  authorizedProtectedRoot: ResolvedWorkspacePath | undefined,
): Promise<ResolvedWorkspacePath | undefined> {
  try {
    const result = await policy.resolve(resultPath, "read");
    if (!result.exists) return undefined;
    if (!isInside(target.absolutePath, result.absolutePath)) return undefined;
    if (result.kind === "allowed") return result;
    if (
      result.kind === "protected" &&
      authorizedProtectedRoot !== undefined &&
      isInside(authorizedProtectedRoot.absolutePath, result.absolutePath)
    ) {
      return result;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeGrepText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .slice(0, GREP_MAX_LINE_LENGTH);
}

function fitsOutputBudget(value: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= OUTPUT_MAX_BYTES;
}

function grepEnvelopeByteLength(resultPath: string): number {
  return (
    Buffer.byteLength('{"ok":true,"path":') +
    Buffer.byteLength(JSON.stringify(resultPath)) +
    Buffer.byteLength(',"matches":[],"truncated":false}')
  );
}

function parseGrepEvent(line: string): {
  path: string;
  line: number;
  text: string;
  kind: "match" | "context";
} | undefined {
  try {
    const event: unknown = JSON.parse(line);
    if (!isRecord(event) || !isRecord(event.data)) return undefined;
    if (event.type !== "match" && event.type !== "context") return undefined;
    const data = event.data;
    if (!isRecord(data.path) || !isRecord(data.lines)) return undefined;
    const eventPath = data.path.text;
    const text = data.lines.text;
    const lineNumber = data.line_number;
    if (
      typeof eventPath !== "string" || eventPath.trim() === "" ||
      typeof text !== "string" ||
      typeof lineNumber !== "number" ||
      !Number.isInteger(lineNumber) ||
      lineNumber < 1
    ) {
      return undefined;
    }
    return {
      path: eventPath,
      line: lineNumber,
      text: sanitizeGrepText(text),
      kind: event.type,
    };
  } catch {
    return undefined;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export const runRipgrep: RgRunner = async (
  args,
  cwd,
  maximumLines,
  signal,
) => {
  if (!Number.isInteger(maximumLines) || maximumLines <= 0) {
    throw new CodeToolError(
      "INVALID_ARGUMENT",
      "maximumLines 必须是正整数。",
    );
  }
  signal?.throwIfAborted();

  return await new Promise<RgResult>((resolve, reject) => {
    const child = spawn("rg", [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    const lines: string[] = [];
    let pending = "";
    let bytesRead = 0;
    let truncated = false;
    let byteTruncated = false;
    let settled = false;
    let abortedReason: unknown;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ lines, truncated });
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stopForLimit = (bytes: boolean) => {
      if (truncated) return;
      truncated = true;
      byteTruncated = bytes;
      child.kill();
    };
    const consumeText = (text: string) => {
      pending += text;
      while (!truncated) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        if (lines.length >= maximumLines) {
          pending = "";
          stopForLimit(false);
          break;
        }
        const line = pending.slice(0, newline);
        lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
        pending = pending.slice(newline + 1);
        if (lines.length >= maximumLines) {
          stopForLimit(false);
        }
      }
    };
    function onAbort() {
      abortedReason = signal?.reason;
      child.kill();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated || abortedReason !== undefined) return;
      const remaining = OUTPUT_MAX_BYTES - bytesRead;
      if (remaining <= 0) {
        stopForLimit(true);
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      bytesRead += accepted.length;
      consumeText(decoder.write(accepted));
      if (bytesRead >= OUTPUT_MAX_BYTES) stopForLimit(true);
    });
    child.stderr.resume();
    child.once("error", (error) => {
      if (abortedReason !== undefined) {
        rejectOnce(abortedReason);
      } else if (hasErrorCode(error, "ENOENT")) {
        rejectOnce(
          new CodeToolError("RG_UNAVAILABLE", "系统未安装 rg，无法执行搜索。"),
        );
      } else {
        rejectOnce(new CodeToolError("EXECUTION_FAILED", "rg 执行失败。"));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      if (abortedReason !== undefined) {
        rejectOnce(abortedReason);
        return;
      }
      if (!byteTruncated) consumeText(decoder.end());
      if (pending !== "") {
        if (lines.length < maximumLines) {
          lines.push(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
        } else {
          truncated = true;
        }
        pending = "";
      }
      if (truncated || code === 0 || code === 1) {
        resolveOnce();
      } else {
        rejectOnce(new CodeToolError("EXECUTION_FAILED", "rg 执行失败。"));
      }
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
};

export function createSearchTools({
  policy,
  runRg = runRipgrep,
  interaction = DEFAULT_TOOL_INTERACTION,
}: SearchToolOptions): RegisteredTool[] {
  return [
    {
      definition: {
        name: "find",
        description: "在工作区中按 glob 查找文件。",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            limit: { type: "integer", minimum: 1, maximum: FIND_MAX_RESULTS },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          assertKnownArguments(args, ["pattern", "path", "limit"], "find");
          const pattern = requiredString(args.pattern, "pattern");
          const requestedPath = optionalString(args.path, "path") ?? ".";
          const limit = integer(
            args.limit,
            FIND_MAX_RESULTS,
            1,
            FIND_MAX_RESULTS,
            "limit",
          );
          const target = await resolveTarget(policy, requestedPath, true);
          signal?.throwIfAborted();
          const authorizedRoot = await authorizeTarget(
            target,
            interaction,
            signal,
          );
          const result = await runRg(
            ["--files", "--hidden", "--glob", pattern, "--", "."],
            target.absolutePath,
            limit,
            signal,
          );
          signal?.throwIfAborted();
          const files: string[] = [];
          let outputTruncated = false;
          for (const line of result.lines) {
            signal?.throwIfAborted();
            const logicalPath = logicalChild(target, line);
            const visible = await visibleResult(
              policy,
              target,
              logicalPath,
              authorizedRoot,
            );
            signal?.throwIfAborted();
            if (!visible) continue;
            if (files.length >= limit) {
              outputTruncated = true;
              break;
            }
            const candidateFiles = [...files, visible.relativePath];
            if (!fitsOutputBudget({
              ok: true,
              path: target.relativePath,
              files: candidateFiles,
              truncated: false,
            })) {
              outputTruncated = true;
              break;
            }
            files.push(visible.relativePath);
          }
          return {
            ok: true,
            path: target.relativePath,
            files,
            truncated: result.truncated || outputTruncated,
          };
        }, signal);
      },
    },
    {
      definition: {
        name: "grep",
        description: "在工作区文本中搜索匹配行。",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", minLength: 1 },
            path: { type: "string", minLength: 1 },
            glob: { type: "string", minLength: 1 },
            ignoreCase: { type: "boolean" },
            literal: { type: "boolean" },
            context: { type: "integer", minimum: 0, maximum: 10 },
            limit: { type: "integer", minimum: 1, maximum: GREP_MAX_MATCHES },
          },
          required: ["pattern"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        return await executeCodeTool(async () => {
          signal?.throwIfAborted();
          assertKnownArguments(
            args,
            [
              "pattern",
              "path",
              "glob",
              "ignoreCase",
              "literal",
              "context",
              "limit",
            ],
            "grep",
          );
          const pattern = requiredString(args.pattern, "pattern");
          const requestedPath = optionalString(args.path, "path") ?? ".";
          const glob = optionalString(args.glob, "glob");
          const literal = optionalBoolean(args.literal, "literal");
          const ignoreCase = optionalBoolean(args.ignoreCase, "ignoreCase");
          const context = integer(args.context, 0, 0, 10, "context");
          const limit = integer(
            args.limit,
            GREP_MAX_MATCHES,
            1,
            GREP_MAX_MATCHES,
            "limit",
          );
          const target = await resolveTarget(policy, requestedPath, false);
          signal?.throwIfAborted();
          const authorizedRoot = await authorizeTarget(
            target,
            interaction,
            signal,
          );
          const rgArgs = ["--json", "--color", "never"];
          if (literal === true) rgArgs.push("--fixed-strings");
          if (ignoreCase === true) rgArgs.push("--ignore-case");
          if (glob !== undefined) rgArgs.push("--glob", glob);
          if (args.context !== undefined) {
            rgArgs.push("--context", String(context));
          }
          rgArgs.push("--", pattern, target.relativePath);
          const result = await runRg(
            rgArgs,
            policy.root,
            limit * (context * 2 + 3) + 1,
            signal,
          );
          signal?.throwIfAborted();
          const matches: Array<{
            path: string;
            line: number;
            text: string;
            kind: "match" | "context";
          }> = [];
          const visibilityByPath = new Map<
            string,
            Promise<ResolvedWorkspacePath | undefined>
          >();
          let matchCount = 0;
          let outputBytes = grepEnvelopeByteLength(target.relativePath);
          let outputTruncated = false;
          for (const line of result.lines) {
            signal?.throwIfAborted();
            const event = parseGrepEvent(line);
            if (!event) continue;
            if (event.kind === "match" && matchCount >= limit) {
              outputTruncated = true;
              break;
            }
            let visibility = visibilityByPath.get(event.path);
            if (visibility === undefined) {
              visibility = visibleResult(
                policy,
                target,
                event.path,
                authorizedRoot,
              );
              visibilityByPath.set(event.path, visibility);
            }
            signal?.throwIfAborted();
            const visible = await visibility;
            signal?.throwIfAborted();
            if (!visible) continue;
            const candidate = { ...event, path: visible.relativePath };
            const candidateBytes = Buffer.byteLength(JSON.stringify(candidate)) +
              (matches.length === 0 ? 0 : 1);
            if (outputBytes + candidateBytes > OUTPUT_MAX_BYTES) {
              outputTruncated = true;
              break;
            }
            outputBytes += candidateBytes;
            matches.push(candidate);
            if (event.kind === "match") matchCount += 1;
          }
          return {
            ok: true,
            path: target.relativePath,
            matches,
            truncated: result.truncated || outputTruncated,
          };
        }, signal);
      },
    },
  ];
}
