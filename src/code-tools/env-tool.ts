import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { parseEnv } from "node:util";

import type { RegisteredTool } from "../tool-registry.js";
import {
  atomicCreate,
  atomicReplace,
  captureMutationPathGuard,
  hashFile,
  withMutationQueue,
} from "./mutation.js";
import {
  parseEnvStructure,
  readLocalEnvFile,
} from "./text-files.js";
import {
  CodeToolError,
  DIFF_MAX_BYTES,
  executeCodeTool,
  type ToolInteraction,
  WRITE_MAX_FILE_BYTES,
} from "./types.js";
import type { WorkspacePolicy } from "./workspace-policy.js";

interface EnvToolOptions {
  policy: WorkspacePolicy;
  interaction: ToolInteraction;
}

interface EnvSnapshot {
  text: string;
  bom: string;
  lineEnding: "\n" | "\r\n";
  mode: number;
  hash: string;
  identity: { dev: number; ino: number };
}

function invalid(message: string): CodeToolError {
  return new CodeToolError("INVALID_ARGUMENT", message);
}

function assertPlainArguments(args: Record<string, unknown>): void {
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid("set_env 参数必须是普通对象。");
  }
  const allowed = new Set(["path", "key"]);
  const unknown = Object.keys(args).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw invalid(`set_env 不支持参数: ${unknown}`);
}

function encodeEnvValue(key: string, value: string): string {
  if (value.includes("\u0000") || value.includes("\r")) {
    throw invalid("变量值包含无法安全写入 dotenv 的字符。");
  }
  const candidates: string[] = [];
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) candidates.push(value);
  for (const quote of ["'", "\"", "`"]) {
    if (!value.includes(quote)) candidates.push(`${quote}${value}${quote}`);
  }
  for (const candidate of candidates) {
    try {
      if (parseEnv(`${key}=${candidate}`)[key] === value) return candidate;
    } catch {
      // Try the next dotenv quoting style.
    }
  }
  throw invalid("变量值无法无损写入 dotenv 文件。");
}

function safePreviewPath(value: string): string {
  return JSON.stringify(value)
    .slice(1, -1)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function maskedPatch(path: string, key: string, existed: boolean): string {
  const displayPath = safePreviewPath(path);
  const header = `--- ${displayPath}\n+++ ${displayPath}\n@@ dotenv @@\n`;
  const patch = existed
    ? `${header}-${key}=<hidden current>\n+${key}=<hidden new>\n`
    : `${header}+${key}=<hidden>\n`;
  if (Buffer.byteLength(patch) > DIFF_MAX_BYTES) {
    throw new CodeToolError("LIMIT_EXCEEDED", "Diff 超过 50KB，请缩短路径。");
  }
  return patch;
}

async function snapshotEnv(absolutePath: string): Promise<EnvSnapshot> {
  const file = await readLocalEnvFile(absolutePath, WRITE_MAX_FILE_BYTES);
  const before = await lstat(absolutePath, { bigint: true });
  const hash = await hashFile(absolutePath);
  const after = await lstat(absolutePath, { bigint: true });
  const bytesHash = createHash("sha256").update(file.bytes).digest("hex");
  if (
    !before.isFile() || before.isSymbolicLink() ||
    before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
    bytesHash !== hash
  ) {
    throw new CodeToolError("EDIT_CONFLICT", ".env 在读取期间发生变化，未写入。");
  }
  return {
    text: file.text,
    bom: file.bom,
    lineEnding: file.lineEnding,
    mode: file.mode,
    hash,
    identity: { dev: Number(after.dev), ino: Number(after.ino) },
  };
}

function buildContent(
  snapshot: Pick<EnvSnapshot, "text" | "bom" | "lineEnding">,
  key: string,
  value: string,
  lineIndex: number | undefined,
): string {
  const normalized = snapshot.text.replace(/\r\n/g, "\n");
  const lines = normalized === "" ? [] : normalized.split("\n");
  const encoded = encodeEnvValue(key, value);
  if (lineIndex !== undefined) {
    const entryEnd = parseEnvStructure(snapshot.text).entries.find(
      (entry) => entry.key === key && entry.lineIndex === lineIndex,
    )?.endLineIndex ?? lineIndex;
    const original = lines.slice(lineIndex, entryEnd + 1).join("\n");
    const match = original.match(
      new RegExp(`^([ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=[ \\t]*)([\\s\\S]*)$`),
    );
    if (!match) throw invalid(".env 目标变量结构已发生变化。");
    const rawValue = match[2]!;
    const trimmed = rawValue.trimStart();
    const quote = trimmed[0];
    let suffix = "";
    if (quote === "\"" || quote === "'" || quote === "`") {
      const closing = trimmed.indexOf(quote, 1);
      if (closing === -1) throw invalid(".env 目标变量结构无效。");
      suffix = trimmed.slice(closing + 1);
    } else {
      const comment = rawValue.indexOf("#");
      const beforeComment = comment === -1 ? rawValue : rawValue.slice(0, comment);
      suffix = rawValue.slice(beforeComment.trimEnd().length);
    }
    lines.splice(
      lineIndex,
      entryEnd - lineIndex + 1,
      ...`${match[1]}${encoded}${suffix}`.split("\n"),
    );
  } else {
    if (lines.at(-1) === "") lines.pop();
    lines.push(`${key}=${encoded}`, "");
  }
  const next = lines.join("\n");
  return snapshot.bom + (
    snapshot.lineEnding === "\r\n" ? next.replace(/\n/g, "\r\n") : next
  );
}

export function createEnvTool({
  policy,
  interaction,
}: EnvToolOptions): RegisteredTool {
  return {
    definition: {
      name: "set_env",
      description: "通过本地隐藏输入设置 .env* 变量，模型不会看到变量值。",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          key: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
        },
        required: ["path", "key"],
        additionalProperties: false,
      },
    },
    riskLevel: "write",
    async execute(args, signal) {
      return await executeCodeTool(async () => {
        signal?.throwIfAborted();
        assertPlainArguments(args);
        if (
          !Object.hasOwn(args, "path") || !Object.hasOwn(args, "key") ||
          typeof args.path !== "string" || args.path.trim() === "" ||
          typeof args.key !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.key)
        ) {
          throw invalid("set_env 需要合法的 path 和 key。");
        }
        const requestedPath = args.path;
        const key = args.key;
        const initial = await policy.resolve(requestedPath, "write");
        if (initial.kind !== "env") {
          throw new CodeToolError("PATH_DENIED", "set_env 只能修改 .env* 文件。");
        }

        return await withMutationQueue(initial.absolutePath, async () => {
          signal?.throwIfAborted();
          const queued = await policy.resolve(requestedPath, "write");
          if (
            queued.kind !== "env" || queued.exists !== initial.exists ||
            queued.absolutePath !== initial.absolutePath
          ) {
            throw new CodeToolError("EDIT_CONFLICT", ".env 在等待期间发生变化，未写入。");
          }
          const existed = queued.exists;
          const snapshot = existed
            ? await snapshotEnv(queued.absolutePath)
            : {
                text: "",
                bom: "",
                lineEnding: "\n" as const,
                mode: 0o644,
                hash: undefined,
                identity: undefined,
              };
          const parsed = parseEnvStructure(snapshot.text);
          if (parsed.invalidLines.length > 0 || parsed.duplicateKeys.length > 0) {
            throw invalid(".env 存在重复变量或语法问题，未自动修改。");
          }
          const entry = parsed.entries.find((item) => item.key === key);
          const displayPath = safePreviewPath(queued.relativePath);
          const workspaceGuard = await captureMutationPathGuard(
            queued.absolutePath,
            policy.root,
          );
          const value = await interaction.requestSecret({
            path: displayPath,
            key,
          }, signal);
          signal?.throwIfAborted();
          if (value === undefined) {
            throw new CodeToolError("USER_REJECTED", "用户取消了变量输入。");
          }
          if (value.length === 0) throw invalid("变量值不能为空。");
          if (Buffer.byteLength(value, "utf8") > WRITE_MAX_FILE_BYTES) {
            throw new CodeToolError("LIMIT_EXCEEDED", "变量值不能超过 1MB。");
          }
          const content = buildContent(snapshot, key, value, entry?.lineIndex);
          if (Buffer.byteLength(content) > WRITE_MAX_FILE_BYTES) {
            throw new CodeToolError("LIMIT_EXCEEDED", ".env 文件不能超过 1MB。");
          }
          const patch = maskedPatch(displayPath, key, entry !== undefined);
          const approved = await interaction.confirmMutation({
            kind: "set_env",
            path: displayPath,
            patch,
            changedLines: entry === undefined ? 1 : 2,
          }, signal);
          signal?.throwIfAborted();
          if (!approved) {
            throw new CodeToolError("USER_REJECTED", "用户拒绝了变量修改。");
          }
          const current = await policy.resolve(requestedPath, "write");
          if (
            current.kind !== "env" || current.exists !== existed ||
            current.absolutePath !== queued.absolutePath
          ) {
            throw new CodeToolError("EDIT_CONFLICT", ".env 在确认期间发生变化，未写入。");
          }
          if (existed) {
            const latest = await snapshotEnv(current.absolutePath);
            if (
              latest.hash !== snapshot.hash || latest.mode !== snapshot.mode ||
              latest.identity.dev !== snapshot.identity?.dev ||
              latest.identity.ino !== snapshot.identity?.ino
            ) {
              throw new CodeToolError("EDIT_CONFLICT", ".env 在确认期间发生变化，未写入。");
            }
            await atomicReplace(current.absolutePath, content, snapshot.mode, {
              expectedIdentity: snapshot.identity,
              signal,
              workspaceGuard,
            });
          } else {
            await atomicCreate(current.absolutePath, content, {
              signal,
              workspaceGuard,
            });
          }
          return { ok: true, path: safePreviewPath(current.relativePath), key, set: true };
        });
      }, signal);
    },
  };
}
