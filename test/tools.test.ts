import assert from "node:assert/strict";
import test from "node:test";

import { createTools } from "../src/tools.js";
import type { PlanManager } from "../src/planning/manager.js";
import type { TaskPlan } from "../src/planning/types.js";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function planningManager(): PlanManager {
  const plan: TaskPlan = {
    id: "plan-1",
    sessionId: "session-1",
    goal: "测试",
    status: "active",
    revision: 1,
    steps: [],
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
  };
  return {
    getCurrentPlan: () => plan,
    createPlan: () => plan,
    updatePlan: () => plan,
    finishPlan: () => ({ ...plan, status: "completed" }),
    cancelCurrent: () => undefined,
  };
}

test("registers current tools with model-neutral risk levels", () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  assert.deepEqual(
    tools.definitions.map((definition) => definition.name),
    ["web_search", "web_fetch", "get_current_location", "calculator"],
  );
  assert.equal(tools.getRiskLevel("web_search"), "read");
  assert.equal(tools.getRiskLevel("web_fetch"), "read");
  assert.equal(tools.getRiskLevel("get_current_location"), "read");
  assert.equal(tools.getRiskLevel("calculator"), "compute");
  assert.equal(tools.getRiskLevel("missing"), undefined);
});

test("registers provider-neutral code tools when a workspace is supplied", () => {
  const tools = createTools({
    tavilyApiKey: "tvly-test",
    workspaceRoot: process.cwd(),
  });
  const names = tools.definitions.map((definition) => definition.name);
  for (const name of ["ls", "find", "grep", "read", "edit", "write", "set_env"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(tools.getRiskLevel("read"), "read");
  assert.equal(tools.getRiskLevel("edit"), "write");
  assert.equal(tools.getRiskLevel("set_env"), "write");
  assert.ok(names.includes("shell"));
  assert.equal(tools.getRiskLevel("shell"), "execute");
});

test("does not expose the shell tool without a workspace", () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  assert.equal(
    tools.definitions.some((definition) => definition.name === "shell"),
    false,
  );
  assert.equal(tools.getRiskLevel("shell"), undefined);
});

test("registers planning tools last without requiring a workspace or confirmation", async () => {
  const tools = createTools({
    tavilyApiKey: "tvly-test",
    planning: planningManager(),
    toolInteraction: {
      async authorizeProtected() {
        throw new Error("planning metadata must not ask for confirmation");
      },
      async confirmMutation() {
        throw new Error("planning metadata must not ask for confirmation");
      },
      async requestSecret() {
        throw new Error("planning metadata must not ask for confirmation");
      },
      async confirmShell() {
        throw new Error("planning metadata must not ask for confirmation");
      },
    },
  });

  assert.deepEqual(
    tools.definitions.slice(-3).map((definition) => definition.name),
    ["create_plan", "update_plan", "finish_plan"],
  );
  for (const name of ["create_plan", "update_plan", "finish_plan"]) {
    assert.equal(tools.getRiskLevel(name), "write");
  }
  assert.equal(tools.getRiskLevel("shell"), undefined);
  assert.deepEqual(JSON.parse(await tools.execute("create_plan", JSON.stringify({
    goal: "测试",
    steps: [
      { id: "one", title: "第一步", successCriteria: "完成", dependsOn: [] },
      { id: "two", title: "第二步", successCriteria: "完成", dependsOn: ["one"] },
    ],
  }))), { ok: true, plan: planningManager().getCurrentPlan() });
});

test("executes calculator expressions without making a network request", async () => {
  let requested = false;
  const tools = createTools({
    tavilyApiKey: "tvly-test",
    fetchImpl: async () => {
      requested = true;
      return jsonResponse({});
    },
  });

  const result = JSON.parse(
    await tools.execute("calculator", '{"expression":"(8 + 4) / 3"}'),
  );

  assert.deepEqual(result, {
    ok: true,
    expression: "(8 + 4) / 3",
    result: 4,
  });
  assert.equal(requested, false);
});

test("normalizes calculator validation errors as tool failures", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  const result = JSON.parse(
    await tools.execute("calculator", '{"expression":"sqrt(4)"}'),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /仅支持数字、括号/);
});

test("extracts one HTTPS page as Markdown through Tavily", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      results: [
        {
          url: "https://example.com/article",
          raw_content: "# Coffee\n\n正文",
        },
      ],
      failed_results: [],
    });
  };
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute(
      "web_fetch",
      '{"url":" https://example.com/article "}',
    ),
  );

  assert.equal(requests[0]?.url, "https://api.tavily.com/extract");
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer tvly-test");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    urls: "https://example.com/article",
    extract_depth: "basic",
    format: "markdown",
    include_images: false,
    timeout: 15,
  });
  assert.deepEqual(result, {
    ok: true,
    url: "https://example.com/article",
    content: "# Coffee\n\n正文",
    truncated: false,
  });
});

test("rejects unsafe web-fetch URLs without making a request", async () => {
  let requested = false;
  const fetchImpl: FetchLike = async () => {
    requested = true;
    return jsonResponse({});
  };
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });
  const invalidInputs: Array<{ input: string; error: RegExp }> = [
    { input: "{}", error: /缺少非空的 url 参数/ },
    { input: '{"url":""}', error: /缺少非空的 url 参数/ },
    { input: '{"url":"not a url"}', error: /不是有效地址/ },
    { input: '{"url":"http://example.com"}', error: /只允许 HTTPS/ },
    {
      input: '{"url":"https://user:secret@example.com"}',
      error: /不能包含用户名或密码/,
    },
    {
      input: JSON.stringify({
        url: `https://example.com/${"a".repeat(2049)}`,
      }),
      error: /不能超过 2048 个字符/,
    },
  ];

  for (const { input, error } of invalidInputs) {
    const result = JSON.parse(await tools.execute("web_fetch", input));
    assert.equal(result.ok, false);
    assert.match(result.error, error);
  }
  assert.equal(requested, false);
});

test("truncates extracted content after 20000 characters", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse({
      results: [
        {
          url: "https://example.com/long",
          raw_content: "x".repeat(20_001),
        },
      ],
    });
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute("web_fetch", '{"url":"https://example.com/long"}'),
  );

  assert.equal(result.ok, true);
  assert.equal(result.content.length, 20_000);
  assert.equal(result.truncated, true);
});

test("keeps exactly 20000 extracted characters without truncation", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse({
      results: [
        {
          url: "https://example.com/boundary",
          raw_content: "x".repeat(20_000),
        },
      ],
    });
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute(
      "web_fetch",
      '{"url":"https://example.com/boundary"}',
    ),
  );

  assert.equal(result.content.length, 20_000);
  assert.equal(result.truncated, false);
});

test("returns tool failures for Tavily extract errors", async () => {
  const responses = [
    {
      response: jsonResponse({ message: "rate limited" }, 429),
      error: /429/,
    },
    { response: jsonResponse([]), error: /无效数据/ },
    {
      response: jsonResponse({
        results: [],
        failed_results: [{ url: "https://example.com" }],
      }),
      error: /未返回网页内容/,
    },
    {
      response: jsonResponse({ results: [{ url: "https://example.com" }] }),
      error: /raw_content/,
    },
  ];

  for (const { response, error } of responses) {
    const tools = createTools({
      tavilyApiKey: "tvly-test",
      fetchImpl: async () => response,
    });
    const result = JSON.parse(
      await tools.execute("web_fetch", '{"url":"https://example.com"}'),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, error);
  }
});

test("searches Tavily and returns at most five normalized results", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      results: Array.from({ length: 6 }, (_, index) => ({
        title: `结果 ${index + 1}`,
        url: `https://example.com/${index + 1}`,
        content: `摘要 ${index + 1}`,
        score: 0.9,
        raw_content: "不应返回",
      })),
    });
  };
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute("web_search", '{"query":"上海咖啡"}'),
  );

  assert.equal(requests[0]?.url, "https://api.tavily.com/search");
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer tvly-test");
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    query: "上海咖啡",
    search_depth: "basic",
    max_results: 5,
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 5);
  assert.deepEqual(result.results[0], {
    title: "结果 1",
    url: "https://example.com/1",
    content: "摘要 1",
  });
});

test("gets an approximate current location without exposing the IP", async () => {
  const requests: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    requests.push(String(input));
    return jsonResponse({
      ip: "203.0.113.10",
      success: true,
      city: "Shanghai",
      region: "Shanghai",
      country: "China",
      latitude: 31.23,
      longitude: 121.47,
      timezone: { id: "Asia/Shanghai" },
    });
  };
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute("get_current_location", "{}"),
  );

  assert.match(requests[0] ?? "", /^https:\/\/ipwho\.is\//);
  assert.deepEqual(result, {
    ok: true,
    location: {
      city: "Shanghai",
      region: "Shanghai",
      country: "China",
      latitude: 31.23,
      longitude: 121.47,
      timezone: "Asia/Shanghai",
    },
  });
  assert.equal("ip" in result, false);
});

test("returns a tool error for invalid arguments without making a request", async () => {
  let requested = false;
  const fetchImpl: FetchLike = async () => {
    requested = true;
    return jsonResponse({});
  };
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(await tools.execute("web_search", "not-json"));

  assert.equal(result.ok, false);
  assert.match(result.error, /JSON/);
  assert.equal(requested, false);
});

test("returns a tool error when an external service fails", async () => {
  const fetchImpl: FetchLike = async () =>
    jsonResponse({ message: "rate limited" }, 429);
  const tools = createTools({ tavilyApiKey: "tvly-test", fetchImpl });

  const result = JSON.parse(
    await tools.execute("web_search", '{"query":"AI 新闻"}'),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /429/);
});

test("passes the abort signal to every network-backed tool", async () => {
  const cases = [
    {
      name: "web_search",
      argumentsJson: '{"query":"coffee"}',
      body: { results: [] },
    },
    {
      name: "web_fetch",
      argumentsJson: '{"url":"https://example.com"}',
      body: {
        results: [
          { url: "https://example.com", raw_content: "content" },
        ],
      },
    },
    {
      name: "get_current_location",
      argumentsJson: "{}",
      body: {
        success: true,
        city: "Shanghai",
        region: "Shanghai",
        country: "China",
        latitude: 31.23,
        longitude: 121.47,
        timezone: { id: "Asia/Shanghai" },
      },
    },
  ] as const;
  const signal = new AbortController().signal;

  for (const item of cases) {
    let receivedSignal: AbortSignal | null | undefined;
    const tools = createTools({
      tavilyApiKey: "tvly-test",
      fetchImpl: async (_input, init) => {
        receivedSignal = init?.signal;
        return jsonResponse(item.body);
      },
    });

    await tools.execute(item.name, item.argumentsJson, signal);

    assert.equal(receivedSignal, signal, item.name);
  }
});

test("cancels calculator execution before evaluating an expression", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    tools.execute(
      "calculator",
      '{"expression":"6*7"}',
      controller.signal,
    ),
    (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    },
  );
});
