import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRegistry,
  type RegisteredTool,
  type ToolRiskLevel,
} from "../src/tool-registry.js";

function makeTool(
  name: string,
  riskLevel: ToolRiskLevel,
  execute: RegisteredTool["execute"] = async (args) => ({
    ok: true,
    args,
  }),
): RegisteredTool {
  return {
    definition: {
      name,
      description: `${name} description`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    riskLevel,
    execute,
  };
}

test("preserves definition order and exposes local risk levels", () => {
  const registry = createToolRegistry([
    makeTool("reader", "read"),
    makeTool("calculator", "compute"),
    makeTool("python", "execute"),
    makeTool("sender", "write"),
  ]);

  assert.deepEqual(
    registry.definitions.map((definition) => definition.name),
    ["reader", "calculator", "python", "sender"],
  );
  assert.equal(registry.getRiskLevel("reader"), "read");
  assert.equal(registry.getRiskLevel("calculator"), "compute");
  assert.equal(registry.getRiskLevel("python"), "execute");
  assert.equal(registry.getRiskLevel("sender"), "write");
  assert.equal(registry.getRiskLevel("missing"), undefined);
});

test("parses arguments, executes a tool, and serializes its result", async () => {
  const registry = createToolRegistry([makeTool("reader", "read")]);

  const result = JSON.parse(
    await registry.execute("reader", '{"query":"coffee"}'),
  );

  assert.deepEqual(result, {
    ok: true,
    args: { query: "coffee" },
  });
});

test("normalizes invalid arguments, unknown tools, and handler errors", async () => {
  const registry = createToolRegistry([
    makeTool("broken", "read", async () => {
      throw new Error("外部服务失败");
    }),
  ]);

  assert.deepEqual(JSON.parse(await registry.execute("broken", "not-json")), {
    ok: false,
    error: "工具参数不是有效的 JSON。",
  });
  for (const argumentsJson of ["[]", "null", '"coffee"', "1"]) {
    assert.deepEqual(
      JSON.parse(await registry.execute("broken", argumentsJson)),
      {
        ok: false,
        error: "工具参数必须是 JSON 对象。",
      },
    );
  }
  assert.deepEqual(JSON.parse(await registry.execute("missing", "{}")), {
    ok: false,
    error: "未知工具: missing",
  });
  assert.deepEqual(JSON.parse(await registry.execute("broken", "{}")), {
    ok: false,
    error: "外部服务失败",
  });
});

test("passes the abort signal to a tool handler", async () => {
  let receivedSignal: AbortSignal | undefined;
  const registry = createToolRegistry([
    makeTool(
      "reader",
      "read",
      async (_args, signal) => {
        receivedSignal = signal;
        return { ok: true };
      },
    ),
  ]);
  const signal = new AbortController().signal;

  await registry.execute("reader", "{}", signal);

  assert.equal(receivedSignal, signal);
});

test("rethrows AbortError instead of normalizing it as a tool failure", async () => {
  const abortError = new DOMException("Aborted", "AbortError");
  const registry = createToolRegistry([
    makeTool("reader", "read", async () => {
      throw abortError;
    }),
  ]);

  await assert.rejects(registry.execute("reader", "{}"), (error) => {
    assert.equal(error, abortError);
    return true;
  });
});

test("rethrows a handler's custom AbortSignal reason", async () => {
  const controller = new AbortController();
  const reason = { kind: "custom-cancel" };
  const registry = createToolRegistry([
    makeTool("reader", "read", async () => {
      controller.abort(reason);
      throw reason;
    }),
  ]);

  await assert.rejects(
    registry.execute("reader", "{}", controller.signal),
    (error) => error === reason,
  );
});

test("rejects duplicate tool names when creating the registry", () => {
  assert.throws(
    () =>
      createToolRegistry([
        makeTool("reader", "read"),
        makeTool("reader", "write"),
      ]),
    /重复的工具名称: reader/,
  );
});
