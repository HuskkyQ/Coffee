import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExecuteShellOptions } from "../src/shell/executor.js";
import { createShellTool } from "../src/shell/tool.js";
import type {
  ShellExecutionResult,
  ShellInteraction,
} from "../src/shell/types.js";

const workspaceRoot = process.cwd();

function successfulResult(command: string): ShellExecutionResult {
  return {
    ok: true,
    command,
    exitCode: 0,
    durationMs: 12,
    timedOut: false,
    cancelled: false,
    truncated: false,
    output: "ok\n",
  };
}

test("defines the model-neutral shell tool schema and execute risk", () => {
  const tool = createShellTool({ workspaceRoot });

  assert.deepEqual(tool.definition, {
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
  });
  assert.equal(tool.riskLevel, "execute");
});

test("runs auto-approved commands without confirmation and shows the command", async () => {
  let confirmations = 0;
  const displays: Array<{ command: string; displayCommand: boolean }> = [];
  const output: string[] = [];
  const executions: ExecuteShellOptions[] = [];
  const interaction: ShellInteraction = {
    async confirmShell() {
      confirmations += 1;
      return true;
    },
    beginShell(request) {
      displays.push(request);
    },
    writeShellOutput(chunk) {
      output.push(chunk);
    },
  };
  const execute = async (options: ExecuteShellOptions) => {
    executions.push(options);
    options.onOutput?.("checking\n");
    return successfulResult(options.command);
  };
  const tool = createShellTool({ workspaceRoot, interaction, execute });

  const result = await tool.execute({ command: "npm test", timeout: 30 });

  assert.equal(confirmations, 0);
  assert.deepEqual(displays, [{ command: "npm test", displayCommand: true }]);
  assert.deepEqual(output, ["checking\n"]);
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.command, "npm test");
  assert.equal(executions[0]?.cwd, workspaceRoot);
  assert.equal(executions[0]?.timeoutSeconds, 30);
  assert.equal(result.ok, true);
});

test("runs a confirmed command once and does not display it twice", async () => {
  const confirmations: Array<{ command: string; reason: string }> = [];
  const displays: Array<{ command: string; displayCommand: boolean }> = [];
  let executionCount = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell(request) {
        confirmations.push(request);
        return true;
      },
      beginShell(request) {
        displays.push(request);
      },
    },
    async execute(options) {
      executionCount += 1;
      return successfulResult(options.command);
    },
  });

  const result = await tool.execute({ command: "node script.js" });

  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0]?.command, "node script.js");
  assert.ok(confirmations[0]?.reason.length);
  assert.deepEqual(displays, [
    { command: "node script.js", displayCommand: false },
  ]);
  assert.equal(executionCount, 1);
  assert.equal(result.ok, true);
});

test("returns USER_REJECTED when confirmation is declined", async () => {
  let executions = 0;
  let begins = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        return false;
      },
      beginShell() {
        begins += 1;
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  const result = await tool.execute({ command: "node script.js" });

  assert.deepEqual(result, {
    ok: false,
    command: "node script.js",
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    output: "",
    code: "USER_REJECTED",
    error: "用户拒绝执行 Shell 命令。",
  });
  assert.equal(begins, 0);
  assert.equal(executions, 0);
});

test("defaults missing confirmation handling to rejection", async () => {
  let executions = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {},
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  const result = await tool.execute({ command: "node script.js" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "USER_REJECTED");
  assert.equal(executions, 0);
});

test("returns a complete USER_REJECTED result when confirmation fails", async () => {
  let executions = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        throw new Error("prompt unavailable");
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  const result = await tool.execute({ command: "node script.js" });

  assert.deepEqual(result, {
    ok: false,
    command: "node script.js",
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    output: "",
    code: "USER_REJECTED",
    error: "用户拒绝执行 Shell 命令。",
  });
  assert.equal(executions, 0);
});

test("preserves AbortError thrown by confirmation", async () => {
  const abortError = new DOMException("Aborted", "AbortError");
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        throw abortError;
      },
    },
  });

  await assert.rejects(
    tool.execute({ command: "node script.js" }),
    (error: unknown) => error === abortError,
  );
});

test("checks cancellation before asking for confirmation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before prompt");
  controller.abort(reason);
  let confirmations = 0;
  let executions = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        confirmations += 1;
        return true;
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  await assert.rejects(
    tool.execute({ command: "node script.js" }, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(confirmations, 0);
  assert.equal(executions, 0);
});

test("preserves cancellation when confirmation resolves false after abort", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled during prompt");
  let executions = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        controller.abort(reason);
        return false;
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  await assert.rejects(
    tool.execute({ command: "node script.js" }, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(executions, 0);
});

test("preserves the signal reason when confirmation aborts and then throws", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled while prompt failed");
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        controller.abort(reason);
        throw new Error("prompt cleanup failed");
      },
    },
  });

  await assert.rejects(
    tool.execute({ command: "node script.js" }, controller.signal),
    (error: unknown) => error === reason,
  );
});

test("keeps the creation-time absolute workspace after process.chdir", async () => {
  const originalCwd = process.cwd();
  const otherCwd = await mkdtemp(path.join(os.tmpdir(), "coffee-shell-cwd-"));
  let received: ExecuteShellOptions | undefined;
  const tool = createShellTool({
    workspaceRoot: ".",
    async execute(options) {
      received = options;
      return successfulResult(options.command);
    },
  });

  try {
    process.chdir(otherCwd);
    const target = path.join(originalCwd, "package.json");
    const result = await tool.execute({
      command: `rg name ${JSON.stringify(target)}`,
    });

    assert.equal(result.ok, true);
    assert.equal(received?.cwd, originalCwd);
  } finally {
    process.chdir(originalCwd);
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("denies dangerous commands without asking or executing", async () => {
  let confirmations = 0;
  let executions = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        confirmations += 1;
        return true;
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  const result = await tool.execute({ command: "sudo ls" });

  assert.equal(result.ok, false);
  assert.equal(result.command, "sudo ls");
  assert.equal(result.code, "COMMAND_DENIED");
  assert.equal(typeof result.error, "string");
  assert.match(result.error as string, /禁止|拒绝/);
  assert.equal(confirmations, 0);
  assert.equal(executions, 0);
});

test("returns a complete INVALID_ARGUMENT shell result", async () => {
  const tool = createShellTool({ workspaceRoot });

  const result = await tool.execute({ command: "", extra: true });

  assert.deepEqual(result, {
    ok: false,
    command: "",
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled: false,
    truncated: false,
    output: "",
    code: "INVALID_ARGUMENT",
    error: "shell 参数包含额外字段。",
  });
});

test("checks cancellation after confirmation and before execution", async () => {
  const controller = new AbortController();
  let executions = 0;
  let begins = 0;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      async confirmShell() {
        controller.abort();
        return true;
      },
      beginShell() {
        begins += 1;
      },
    },
    async execute(options) {
      executions += 1;
      return successfulResult(options.command);
    },
  });

  await assert.rejects(
    tool.execute({ command: "node script.js" }, controller.signal),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    },
  );
  assert.equal(begins, 0);
  assert.equal(executions, 0);
});

test("passes timeout, signal, output, and display metadata to execution", async () => {
  const controller = new AbortController();
  const output: string[] = [];
  const displays: Array<{ command: string; displayCommand: boolean }> = [];
  let received: ExecuteShellOptions | undefined;
  const tool = createShellTool({
    workspaceRoot,
    interaction: {
      beginShell(request) {
        displays.push(request);
      },
      writeShellOutput(chunk) {
        output.push(chunk);
      },
    },
    async execute(options) {
      received = options;
      options.onOutput?.("one");
      options.onOutput?.("two");
      return successfulResult(options.command);
    },
  });

  await tool.execute(
    { command: "npm run check", timeout: 7.5 },
    controller.signal,
  );

  assert.equal(received?.cwd, workspaceRoot);
  assert.equal(received?.timeoutSeconds, 7.5);
  assert.equal(received?.signal, controller.signal);
  assert.deepEqual(output, ["one", "two"]);
  assert.deepEqual(displays, [
    { command: "npm run check", displayCommand: true },
  ]);
});
