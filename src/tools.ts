import {
  createToolRegistry,
  type RegisteredTool,
  type ToolRegistry,
} from "./tool-registry.js";
import { calculateExpression } from "./calculator.js";
import { createCodeTools } from "./code-tools/index.js";
import type { ToolInteraction } from "./code-tools/types.js";
import { createShellTool } from "./shell/tool.js";
import type { ShellInteraction } from "./shell/types.js";
import { createPlanningTools } from "./planning/tools.js";
import type { PlanManager } from "./planning/manager.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
const MAX_WEB_FETCH_URL_LENGTH = 2_048;
const MAX_WEB_FETCH_CONTENT_LENGTH = 20_000;
const IPWHO_LOCATION_URL =
  "https://ipwho.is/?fields=success,message,country,region,city,latitude,longitude,timezone";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface ToolOptions {
  tavilyApiKey: string;
  fetchImpl?: FetchLike;
  workspaceRoot?: string;
  toolInteraction?: ToolInteraction & ShellInteraction;
  planning?: PlanManager;
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("外部服务返回了无效数据。");
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`外部服务缺少 ${field}。`);
  }
  return value;
}

function readNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`外部服务缺少 ${field}。`);
  }
  return value;
}

async function searchWeb(
  args: Record<string, unknown>,
  tavilyApiKey: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
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
    signal,
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

function normalizeWebFetchUrl(args: Record<string, unknown>): string {
  const rawUrl = typeof args.url === "string" ? args.url.trim() : "";
  if (!rawUrl) {
    throw new Error("web_fetch 缺少非空的 url 参数。");
  }
  if (rawUrl.length > MAX_WEB_FETCH_URL_LENGTH) {
    throw new Error("web_fetch 的 url 不能超过 2048 个字符。");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch 的 url 不是有效地址。");
  }
  if (url.protocol !== "https:") {
    throw new Error("web_fetch 只允许 HTTPS URL。");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch 的 URL 不能包含用户名或密码。");
  }
  return url.toString();
}

async function fetchWebPage(
  args: Record<string, unknown>,
  tavilyApiKey: string,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const url = normalizeWebFetchUrl(args);
  const response = await fetchImpl(TAVILY_EXTRACT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tavilyApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      urls: url,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
      timeout: 15,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Tavily Extract API 请求失败 (${response.status})。`);
  }

  const payload = readRecord(await response.json());
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (results.length === 0) {
    throw new Error("Tavily Extract 未返回网页内容。");
  }
  const first = readRecord(results[0]);
  const resultUrl = readString(first.url, "url");
  const rawContent = readString(first.raw_content, "raw_content");

  return {
    ok: true,
    url: resultUrl,
    content: rawContent.slice(0, MAX_WEB_FETCH_CONTENT_LENGTH),
    truncated: rawContent.length > MAX_WEB_FETCH_CONTENT_LENGTH,
  };
}

async function getCurrentLocation(
  args: Record<string, unknown>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (Object.keys(args).length > 0) {
    throw new Error("get_current_location 不接受参数。");
  }

  const response = await fetchImpl(IPWHO_LOCATION_URL, { signal });
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

export function createTools({
  tavilyApiKey,
  fetchImpl = fetch,
  workspaceRoot,
  toolInteraction,
  planning,
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
      async execute(args, signal) {
        if (!normalizedTavilyApiKey) {
          throw new Error("缺少 TAVILY_API_KEY。");
        }
        return await searchWeb(
          args,
          normalizedTavilyApiKey,
          fetchImpl,
          signal,
        );
      },
    },
    {
      definition: {
        name: "web_fetch",
        description: "读取指定 HTTPS 网页的正文内容，返回清洗后的 Markdown。",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "要读取的完整 HTTPS 网页地址。",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
      riskLevel: "read",
      async execute(args, signal) {
        if (!normalizedTavilyApiKey) {
          throw new Error("缺少 TAVILY_API_KEY。");
        }
        return await fetchWebPage(
          args,
          normalizedTavilyApiKey,
          fetchImpl,
          signal,
        );
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
      async execute(args, signal) {
        return await getCurrentLocation(args, fetchImpl, signal);
      },
    },
    {
      definition: {
        name: "calculator",
        description:
          "精确计算基础算术表达式，支持加减乘除、取余、小数、正负号和括号。",
        inputSchema: {
          type: "object",
          properties: {
            expression: {
              type: "string",
              description: "要计算的基础算术表达式，例如 (128 * 37) / 2。",
            },
          },
          required: ["expression"],
          additionalProperties: false,
        },
      },
      riskLevel: "compute",
      async execute(args) {
        return calculateExpression(args);
      },
    },
  ];

  if (workspaceRoot) {
    registeredTools.push(...createCodeTools({
      workspaceRoot,
      interaction: toolInteraction,
    }));
    registeredTools.push(createShellTool({
      workspaceRoot,
      interaction: toolInteraction,
    }));
  }

  if (planning) {
    registeredTools.push(...createPlanningTools(planning));
  }

  return createToolRegistry(registeredTools);
}
