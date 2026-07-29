import assert from "node:assert/strict";
import test from "node:test";

import {
  CodeToolError,
  DEFAULT_TOOL_INTERACTION,
  executeCodeTool,
} from "../src/code-tools/types.js";

test("default interaction denies every operation without asking for secrets", async () => {
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.authorizeProtected({
      operation: "read",
      path: "dist/output.txt",
      reason: "ignored",
    }),
    false,
  );
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.confirmMutation({
      kind: "edit",
      path: "src/a.ts",
      patch: "patch",
      changedLines: 1,
    }),
    false,
  );
  assert.equal(
    await DEFAULT_TOOL_INTERACTION.requestSecret({
      path: ".env",
      key: "TOKEN",
    }),
    undefined,
  );
});

test("expected code-tool errors become structured failures", async () => {
  assert.deepEqual(
    await executeCodeTool(async () => {
      throw new CodeToolError("PATH_DENIED", "路径不可访问。");
    }),
    { ok: false, code: "PATH_DENIED", error: "路径不可访问。" },
  );
});

test("AbortError still escapes the code-tool boundary", async () => {
  const error = new DOMException("Aborted", "AbortError");
  await assert.rejects(
    executeCodeTool(async () => {
      throw error;
    }),
    (received) => received === error,
  );
});

test("a custom AbortSignal reason escapes the code-tool boundary", async () => {
  const controller = new AbortController();
  const reason = { kind: "custom-cancel" };

  await assert.rejects(
    executeCodeTool(async () => {
      controller.abort(reason);
      throw reason;
    }, controller.signal),
    (received) => received === reason,
  );
});

test("unexpected execution errors receive a stable code", async () => {
  assert.deepEqual(
    await executeCodeTool(async () => {
      throw new Error("disk failure");
    }),
    { ok: false, code: "EXECUTION_FAILED", error: "disk failure" },
  );
});

test("unstringifiable execution errors receive a safe message", async () => {
  const error = Object.create(null) as object;

  assert.deepEqual(
    await executeCodeTool(async () => {
      throw error;
    }),
    { ok: false, code: "EXECUTION_FAILED", error: "工具执行失败。" },
  );
});
