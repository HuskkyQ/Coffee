import path from "node:path";

import type { RegisteredTool } from "../tool-registry.js";
import {
  classifyShellCommand,
  parseShellRequest,
} from "./command-policy.js";
import {
  executeShellCommand,
  type ExecuteShellOptions,
} from "./executor.js";
import {
  DEFAULT_SHELL_INTERACTION,
  type ShellErrorCode,
  type ShellExecutionResult,
  type ShellInteraction,
} from "./types.js";

type ShellExecutor = (
  options: ExecuteShellOptions,
) => Promise<ShellExecutionResult>;

export interface CreateShellToolOptions {
  workspaceRoot: string;
  interaction?: ShellInteraction;
  execute?: ShellExecutor;
}

function failedResult(
  command: string,
  code: ShellErrorCode,
  error: string,
): ShellExecutionResult {
  return {
    ok: false,
    command,
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    output: "",
    code,
    error,
  };
}

function attemptedCommand(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  const descriptor = Object.getOwnPropertyDescriptor(args, "command");
  return descriptor !== undefined &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    ? descriptor.value.trim()
    : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function createShellTool({
  workspaceRoot,
  interaction = DEFAULT_SHELL_INTERACTION,
  execute = executeShellCommand,
}: CreateShellToolOptions): RegisteredTool {
  const absoluteWorkspaceRoot = path.resolve(workspaceRoot);

  return {
    definition: {
      name: "shell",
      description: "在当前工作区中执行 Shell 命令，可用于运行测试、检查和构建。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要在当前工作区执行的 Shell 命令。",
          },
          timeout: {
            type: "number",
            description: "可选的超时秒数，最大 300 秒。",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    riskLevel: "execute",
    async execute(args, signal) {
      let request;
      try {
        request = parseShellRequest(args);
      } catch (error) {
        return {
          ...failedResult(
            attemptedCommand(args),
            "INVALID_ARGUMENT",
            errorMessage(error),
          ),
        };
      }

      const decision = classifyShellCommand(
        request.command,
        absoluteWorkspaceRoot,
      );
      if (decision.kind === "deny") {
        return {
          ...failedResult(
            request.command,
            "COMMAND_DENIED",
            `Shell 命令已拒绝：${decision.reason}`,
          ),
        };
      }

      if (decision.kind === "confirm") {
        signal?.throwIfAborted();
        let approved: boolean;
        try {
          approved = await interaction.confirmShell?.(
            { command: request.command, reason: decision.reason },
            signal,
          ) ?? false;
        } catch (error) {
          signal?.throwIfAborted();
          if (isAbortError(error)) {
            throw error;
          }
          return {
            ...failedResult(
              request.command,
              "USER_REJECTED",
              "用户拒绝执行 Shell 命令。",
            ),
          };
        }
        signal?.throwIfAborted();
        if (!approved) {
          return {
            ...failedResult(
              request.command,
              "USER_REJECTED",
              "用户拒绝执行 Shell 命令。",
            ),
          };
        }
      }

      signal?.throwIfAborted();
      interaction.beginShell?.({
        command: request.command,
        displayCommand: decision.kind === "auto",
      });
      return {
        ...await execute({
          command: request.command,
          cwd: absoluteWorkspaceRoot,
          timeoutSeconds: request.timeoutSeconds,
          signal,
          onOutput(chunk) {
            interaction.writeShellOutput?.(chunk);
          },
        }),
      };
    },
  };
}
