# Coffee Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tavily web search and IP-based current-location tools to the Coffee CLI through DeepSeek Tool Calls.

**Architecture:** Keep the existing native-fetch application. A focused `src/tools.ts` module owns tool schemas, argument validation, HTTP calls, and normalized tool results; `src/agent.ts` owns the bounded DeepSeek tool-call loop; the CLI only supplies keys and displays tool status.

**Tech Stack:** TypeScript, Node.js 22 native fetch, DeepSeek Chat Completions, Tavily Search API, IPWho API, Node test runner.

---

The directory is not a Git repository, so worktree and commit steps are intentionally omitted.

### Task 1: Tool executor

**Files:**
- Create: `src/tools.ts`
- Create: `test/tools.test.ts`

- [ ] **Step 1: Write failing tests for search, location, and validation**

```ts
test("searches Tavily and returns at most five normalized results", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });
  const result = JSON.parse(await tools.execute("web_search", '{"query":"上海咖啡"}'));
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 5);
});

test("gets an approximate current location without exposing the IP", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });
  const result = JSON.parse(await tools.execute("get_current_location", "{}"));
  assert.deepEqual(result.location, {
    city: "Shanghai",
    region: "Shanghai",
    country: "China",
    latitude: 31.23,
    longitude: 121.47,
    timezone: "Asia/Shanghai",
  });
  assert.equal("ip" in result, false);
});

test("returns a tool error for invalid arguments", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });
  const result = JSON.parse(await tools.execute("web_search", "not-json"));
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run `npm test -- test/tools.test.ts` and verify the import fails because `src/tools.ts` does not exist**

- [ ] **Step 3: Implement the minimal tool module**

```ts
export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the public web for current information.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_location",
      description: "Get the user's approximate current city from the public IP.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
] as const;

type FetchLike = typeof fetch;

interface ToolOptions {
  tavilyApiKey: string;
  fetchImpl: FetchLike;
}

interface ToolSet {
  definitions: typeof TOOL_DEFINITIONS;
  execute(name: string, argumentsJson: string): Promise<string>;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("工具参数必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

function failure(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTools(options: ToolOptions): ToolSet {
  return {
    definitions: TOOL_DEFINITIONS,
    async execute(name, argumentsJson) {
      try {
        const args = parseObject(argumentsJson);
        if (name === "web_search") return await searchWeb(args, options);
        if (name === "get_current_location") return await getLocation(args, options);
        return failure(`未知工具: ${name}`);
      } catch (error) {
        return failure(getErrorMessage(error));
      }
    },
  };
}
```

`searchWeb` sends `{ query, search_depth: "basic", max_results: 5 }` to
`https://api.tavily.com/search` with the configured Bearer token and normalizes
only `title`, `url`, and `content`. `getLocation` sends `GET` to
`https://ipwho.is/?fields=success,message,country,region,city,latitude,longitude,timezone`
and normalizes the approved location fields. Both helpers reject non-2xx HTTP
responses and unsuccessful API payloads; `execute` converts those exceptions to
`{ ok: false, error }` JSON.

- [ ] **Step 4: Run `npm test -- test/tools.test.ts` and verify all tool tests pass**

### Task 2: DeepSeek tool-call loop

**Files:**
- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`

- [ ] **Step 1: Add a failing test for a complete tool round trip**

```ts
test("executes a DeepSeek tool call and returns the final response", async () => {
  const conversation = createConversation({
    apiKey: "test-key",
    tavilyApiKey: "tvly-test",
    fetchImpl,
  });
  const reply = await conversation.send("搜索今天的 AI 新闻");
  assert.equal(reply, "这是搜索后的回答");
  assert.equal(deepSeekBodies.length, 2);
  assert.equal(deepSeekBodies[0].tool_choice, "auto");
  assert.equal(deepSeekBodies[0].thinking.type, "disabled");
  assert.equal(deepSeekBodies[1].messages.at(-1).role, "tool");
});
```

- [ ] **Step 2: Run `npm test -- test/agent.test.ts` and verify it fails because the conversation does not execute tool calls**

- [ ] **Step 3: Implement the bounded agent loop**

```ts
for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
  const message = await requestDeepSeek(messages, tools.definitions);
  if (!message.tool_calls?.length) {
    const text = requireAssistantText(message.content);
    messages.push({ role: "assistant", content: text });
    return text;
  }

  messages.push({
    role: "assistant",
    content: typeof message.content === "string" ? message.content : "",
    tool_calls: message.tool_calls,
  });
  for (const call of message.tool_calls) {
    await onToolCall?.(call.function.name);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: await tools.execute(call.function.name, call.function.arguments),
    });
  }
}
throw new Error("工具调用超过 5 轮，已停止本次请求。");
```

- [ ] **Step 4: Add failing tests for callback notification and the maximum round limit**

```ts
test("notifies the CLI before executing a tool", async () => {
  const called: string[] = [];
  const conversation = createConversation({
    apiKey: "test-key",
    tavilyApiKey: "tvly-test",
    fetchImpl,
    onToolCall(name) { called.push(name); },
  });
  await conversation.send("我在哪里");
  assert.deepEqual(called, ["get_current_location"]);
});

test("stops after five consecutive tool-call rounds", async () => {
  const conversation = createConversation({
    apiKey: "test-key",
    tavilyApiKey: "tvly-test",
    fetchImpl,
  });
  await assert.rejects(
    conversation.send("一直调用定位"),
    /工具调用超过 5 轮/,
  );
});
```

- [ ] **Step 5: Use `const turnStart = messages.length` before adding the user message and `messages.splice(turnStart)` in `catch`, then run `npm test -- test/agent.test.ts`**

Expected: all agent tests pass, including the existing multi-turn and API-error tests.

### Task 3: CLI configuration and tool status

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/terminal-format.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/terminal-format.test.ts`

- [ ] **Step 1: Write failing tests for missing Tavily configuration and the tool style**

```ts
test("rejects a missing Tavily API key", () => {
  assert.throws(
    () => createConversation({ apiKey: "deepseek", tavilyApiKey: "" }),
    /TAVILY_API_KEY/,
  );
});

test("styles tool status separately", () => {
  assert.match(styleText("Tool> ", "tool", true), /\u001b\[93m/);
});
```

- [ ] **Step 2: Run the targeted tests and verify they fail for missing behavior**

- [ ] **Step 3: Pass `TAVILY_API_KEY` into the conversation and print tool status**

```ts
conversation = createConversation({
  apiKey: process.env.DEEPSEEK_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  onToolCall(name) {
    const activity = name === "web_search" ? "正在联网搜索…" : "正在获取近似位置…";
    console.log(`${styleText("Tool> ", "tool", useColor)}${activity}`);
  },
});
```

- [ ] **Step 4: Run `npm test -- test/cli.test.ts test/terminal-format.test.ts` and verify all targeted tests pass**

### Task 4: Documentation and final verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document `TAVILY_API_KEY`, both tools, approximate-location privacy, and mock-test behavior**

```dotenv
DEEPSEEK_API_KEY=你的_DeepSeek_API_Key
TAVILY_API_KEY=你的_Tavily_API_Key
```

Add these exact behavior notes: Coffee can call Tavily web search and IPWho
approximate location; IP location may be wrong when using VPN or proxies and is
sent to a third-party location service; tests use fake HTTP responses and consume
no DeepSeek or Tavily quota.

- [ ] **Step 2: Run `npm test`**

Expected: zero failed tests.

- [ ] **Step 3: Run `npm run check`**

Expected: TypeScript exits with status 0 and no diagnostics.

- [ ] **Step 4: Compare the implementation against the approved design**

Verify: only the two approved tools exist; native fetch remains; no LangChain/MCP/SDK dependency was added; tool errors remain recoverable; the loop is capped at five rounds; existing role prompt and exit behavior remain unchanged.
