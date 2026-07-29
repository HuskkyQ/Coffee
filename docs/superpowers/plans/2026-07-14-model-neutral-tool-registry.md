# Model-Neutral Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Coffee's hard-coded DeepSeek-shaped tool dispatch with a model-neutral registry that preserves all current tool behavior and exposes local risk metadata.

**Architecture:** A pure registry owns name lookup, JSON argument parsing, error normalization, execution, and risk lookup. Tool definitions use a normalized internal shape; a separate OpenAI-compatible adapter converts them for the current DeepSeek request. Existing Tavily and IPWho handlers remain in `tools.ts` and are registered as read-only tools.

**Tech Stack:** TypeScript, Node.js native `fetch`, JSON Schema objects, Node test runner.

---

This directory is not a Git repository, so worktree and commit steps are intentionally omitted.

### Task 1: Model-neutral registry

**Files:**
- Create: `src/tool-registry.ts`
- Create: `test/tool-registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Create `test/tool-registry.test.ts`:

```ts
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
  assert.deepEqual(JSON.parse(await registry.execute("broken", "[]")), {
    ok: false,
    error: "工具参数必须是 JSON 对象。",
  });
  assert.deepEqual(JSON.parse(await registry.execute("missing", "{}")), {
    ok: false,
    error: "未知工具: missing",
  });
  assert.deepEqual(JSON.parse(await registry.execute("broken", "{}")), {
    ok: false,
    error: "外部服务失败",
  });
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
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
node --import tsx --test test/tool-registry.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/tool-registry.js`.

- [ ] **Step 3: Implement the registry**

Create `src/tool-registry.ts`:

```ts
export type ToolRiskLevel = "read" | "compute" | "execute" | "write";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  riskLevel: ToolRiskLevel;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolRegistry {
  definitions: readonly ToolDefinition[];
  execute(name: string, argumentsJson: string): Promise<string>;
  getRiskLevel(name: string): ToolRiskLevel | undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string): string {
  return JSON.stringify({ ok: false, error });
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    throw new Error("工具参数不是有效的 JSON。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("工具参数必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

export function createToolRegistry(
  tools: readonly RegisteredTool[],
): ToolRegistry {
  const toolsByName = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    const name = tool.definition.name;
    if (toolsByName.has(name)) {
      throw new Error(`重复的工具名称: ${name}`);
    }
    toolsByName.set(name, tool);
  }

  return {
    definitions: tools.map((tool) => tool.definition),
    getRiskLevel(name) {
      return toolsByName.get(name)?.riskLevel;
    },
    async execute(name, argumentsJson) {
      const tool = toolsByName.get(name);
      if (!tool) {
        return failure(`未知工具: ${name}`);
      }
      try {
        const args = parseArguments(argumentsJson);
        return JSON.stringify(await tool.execute(args));
      } catch (error) {
        return failure(getErrorMessage(error));
      }
    },
  };
}
```

- [ ] **Step 4: Run registry tests and type checking**

Run:

```bash
node --import tsx --test test/tool-registry.test.ts
npm run check
```

Expected: four registry tests pass and TypeScript exits 0.

### Task 2: OpenAI-compatible definition adapter

**Files:**
- Create: `src/model-adapters/openai-compatible-tools.ts`
- Create: `test/openai-compatible-tools.test.ts`

- [ ] **Step 1: Write the failing adapter test**

Create `test/openai-compatible-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { toOpenAICompatibleTools } from "../src/model-adapters/openai-compatible-tools.js";

test("converts neutral definitions without leaking local metadata", () => {
  const result = toOpenAICompatibleTools([
    {
      name: "web_search",
      description: "搜索网页",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ]);

  assert.deepEqual(result, [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "搜索网页",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal(JSON.stringify(result).includes("riskLevel"), false);
});
```

- [ ] **Step 2: Run the adapter test and verify the red state**

Run:

```bash
node --import tsx --test test/openai-compatible-tools.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the adapter module.

- [ ] **Step 3: Implement the adapter**

Create `src/model-adapters/openai-compatible-tools.ts`:

```ts
import type { ToolDefinition } from "../tool-registry.js";

export interface OpenAICompatibleTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toOpenAICompatibleTools(
  definitions: readonly ToolDefinition[],
): OpenAICompatibleTool[] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
}
```

- [ ] **Step 4: Run adapter tests and type checking**

Run:

```bash
node --import tsx --test test/openai-compatible-tools.test.ts
npm run check
```

Expected: the adapter test passes and TypeScript exits 0.

### Task 3: Register current tools and adapt the DeepSeek request

**Files:**
- Modify: `src/tools.ts:15-53,55-70,93-197`
- Modify: `src/agent.ts:5-6,183-200`
- Modify: `test/tools.test.ts`
- Modify: `test/agent.test.ts:181-190`

- [ ] **Step 1: Add failing integration assertions**

Add to `test/tools.test.ts`:

```ts
test("registers current tools as model-neutral read tools", () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  assert.deepEqual(
    tools.definitions.map((definition) => definition.name),
    ["web_search", "get_current_location"],
  );
  assert.equal(tools.getRiskLevel("web_search"), "read");
  assert.equal(tools.getRiskLevel("get_current_location"), "read");
  assert.equal(tools.getRiskLevel("missing"), undefined);
});
```

In the existing Agent web-search test, add after `firstBody` is created:

```ts
assert.deepEqual(firstBody.tools[0], {
  type: "function",
  function: {
    name: "web_search",
    description:
      "联网搜索最新或需要事实核查的信息，返回网页标题、链接和摘要。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要搜索的完整关键词或问题。",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
});
assert.equal(JSON.stringify(firstBody.tools).includes("riskLevel"), false);
```

- [ ] **Step 2: Run focused integration tests and verify the red state**

Run:

```bash
node --import tsx --test test/tools.test.ts test/agent.test.ts
```

Expected: the new tools test fails because current definitions do not expose neutral `name` fields or `getRiskLevel`; existing tests remain otherwise green.

- [ ] **Step 3: Convert tool handlers to return objects**

In `src/tools.ts`, import the registry:

```ts
import {
  createToolRegistry,
  type RegisteredTool,
  type ToolRegistry,
} from "./tool-registry.js";
```

Remove `ToolSet`, `TOOL_DEFINITIONS`, `parseArguments`, `failure`, and the local `getErrorMessage`. Change handler return types and final returns:

```ts
async function searchWeb(
  args: Record<string, unknown>,
  tavilyApiKey: string,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    throw new Error("web_search 缺少非空的 query 参数。");
  }

  const response = await fetchImpl(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tavilyApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 5,
    }),
  });
  if (!response.ok) {
    throw new Error(`Tavily API 请求失败 (${response.status})。`);
  }

  const payload = readRecord(await response.json());
  const sourceResults = Array.isArray(payload.results) ? payload.results : [];
  const results = sourceResults.slice(0, 5).map((value) => {
    const result = readRecord(value);
    return {
      title: readString(result.title, "title"),
      url: readString(result.url, "url"),
      content: readString(result.content, "content"),
    };
  });

  return { ok: true, query, results };
}

async function getCurrentLocation(
  args: Record<string, unknown>,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  if (Object.keys(args).length > 0) {
    throw new Error("get_current_location 不接受参数。");
  }

  const response = await fetchImpl(IPWHO_LOCATION_URL);
  if (!response.ok) {
    throw new Error(`IPWho API 请求失败 (${response.status})。`);
  }

  const payload = readRecord(await response.json());
  if (payload.success !== true) {
    const message =
      typeof payload.message === "string" ? `: ${payload.message}` : "";
    throw new Error(`IPWho API 定位失败${message}`);
  }
  const timezone = readRecord(payload.timezone);

  return {
    ok: true,
    location: {
      city: readString(payload.city, "city"),
      region: readString(payload.region, "region"),
      country: readString(payload.country, "country"),
      latitude: readNumber(payload.latitude, "latitude"),
      longitude: readNumber(payload.longitude, "longitude"),
      timezone: readString(timezone.id, "timezone.id"),
    },
  };
}
```

- [ ] **Step 4: Replace hard-coded dispatch with registered tools**

Replace `createTools()` in `src/tools.ts` with:

```ts
export function createTools({
  tavilyApiKey,
  fetchImpl = fetch,
}: ToolOptions): ToolRegistry {
  const normalizedTavilyApiKey = tavilyApiKey.trim();
  const registeredTools: RegisteredTool[] = [
    {
      definition: {
        name: "web_search",
        description:
          "联网搜索最新或需要事实核查的信息，返回网页标题、链接和摘要。",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要搜索的完整关键词或问题。",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args) {
        if (!normalizedTavilyApiKey) {
          throw new Error("缺少 TAVILY_API_KEY。");
        }
        return await searchWeb(args, normalizedTavilyApiKey, fetchImpl);
      },
    },
    {
      definition: {
        name: "get_current_location",
        description:
          "根据当前公网 IP 获取用户所在的近似城市。结果可能受 VPN 或代理影响。",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args) {
        return await getCurrentLocation(args, fetchImpl);
      },
    },
  ];

  return createToolRegistry(registeredTools);
}
```

- [ ] **Step 5: Adapt neutral definitions before sending them to DeepSeek**

Add to `src/agent.ts`:

```ts
import { toOpenAICompatibleTools } from "./model-adapters/openai-compatible-tools.js";
```

After creating tools, convert the definitions once:

```ts
const tools = createTools({
  tavilyApiKey: normalizedTavilyApiKey,
  fetchImpl,
});
const modelTools = toOpenAICompatibleTools(tools.definitions);
```

In the DeepSeek request body replace:

```ts
tools: tools.definitions,
```

with:

```ts
tools: modelTools,
```

- [ ] **Step 6: Run focused integration tests**

Run:

```bash
node --import tsx --test \
  test/tool-registry.test.ts \
  test/openai-compatible-tools.test.ts \
  test/tools.test.ts \
  test/agent.test.ts
```

Expected: all registry, adapter, tools, and Agent tests pass.

- [ ] **Step 7: Run complete verification**

Run:

```bash
npm test
npm run check
npm ls --depth=0
```

Expected: zero failed tests, TypeScript exits 0, and no dependency is added.

- [ ] **Step 8: Check scope and compatibility**

Confirm from source and fresh test output that:

- Only two tools are registered and both have `riskLevel: "read"`.
- DeepSeek still receives the same OpenAI-compatible tool JSON and order.
- `riskLevel` never appears in the model request.
- Current success/failure tool JSON remains flat and unchanged.
- Tool activities and the five-round limit remain unchanged.
- No WebFetch, calculator, HITL enforcement, model selector, or new dependency was added.
