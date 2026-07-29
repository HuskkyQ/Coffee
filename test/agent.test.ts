import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  createConversation,
  type ConversationSession,
  type ConversationEvent,
} from "../src/agent.js";
import { SUMMARY_PREFIX } from "../src/history/context.js";
import { generateSummary } from "../src/history/summarizer.js";
import {
  createSessionManager,
  type CurrentSession,
} from "../src/history/session-manager.js";
import { createHistoryStore } from "../src/history/store.js";
import type {
  HistoryPreferences,
  PersistedMessage,
  StoredSummary,
  StoredTurn,
} from "../src/history/types.js";
import type {
  CredentialId,
  ModelDefinition,
  ModelGateway,
  ModelReply,
  ModelRequest,
  ModelStreamEvent,
} from "../src/models/types.js";
import {
  createPlanManager,
  type PlanManager,
} from "../src/planning/manager.js";
import type { TaskPlan } from "../src/planning/types.js";
import type { ToolInteraction } from "../src/code-tools/types.js";
import type { ShellInteraction } from "../src/shell/types.js";
import { withHistoryPath } from "./history-fixture.js";

type MutableModelDefinition = {
  -readonly [Key in keyof ModelDefinition]: ModelDefinition[Key];
};

type ReplyHandler = (request: ModelRequest) => ModelReply | Promise<ModelReply>;
type StreamHandler = (
  request: ModelRequest,
) =>
  | readonly ModelStreamEvent[]
  | AsyncIterable<ModelStreamEvent>
  | Promise<readonly ModelStreamEvent[] | AsyncIterable<ModelStreamEvent>>;

const deepSeekModel: ModelDefinition = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  providerId: "deepseek",
  credentialId: "deepseek",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
  disableThinking: true,
};

const openCodeModel: ModelDefinition = {
  id: "kimi-k2.6",
  name: "Kimi K2.6",
  providerId: "opencode-go",
  credentialId: "opencode",
  api: "openai-completions",
  baseUrl: "https://opencode.ai/zen/go/v1",
};

function createFakeGateway(
  handlers: ReplyHandler[] = [],
): ModelGateway & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      });
      const handler = handlers.shift();
      if (!handler) {
        throw new Error("fake gateway 没有下一条响应");
      }
      const reply = await handler(request);
      yield* modelStream(replyEvents(reply));
    },
  };
}

function createStreamingGateway(
  handlers: StreamHandler[],
): ModelGateway & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async *stream(request) {
      requests.push({
        ...request,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
      });
      const handler = handlers.shift();
      if (!handler) {
        throw new Error("fake gateway 没有下一条流响应");
      }
      yield* await handler(request);
    },
  };
}

function reply(content: string): ReplyHandler {
  return () => ({ content, toolCalls: [] });
}

async function* modelStream(
  events: readonly ModelStreamEvent[],
): AsyncGenerator<ModelStreamEvent> {
  yield* events;
}

function replyEvents(reply: ModelReply): readonly ModelStreamEvent[] {
  const events: ModelStreamEvent[] = [{ type: "start" }];
  if (reply.content) {
    events.push({ type: "text_delta", delta: reply.content });
  }
  events.push({ type: "done", reply });
  return events;
}

function createResolver(
  keys: Partial<Record<CredentialId, string | undefined>>,
  calls: CredentialId[] = [],
) {
  return async (credentialId: CredentialId): Promise<string | undefined> => {
    calls.push(credentialId);
    return keys[credentialId];
  };
}

function conversationOptions(
  gateway: ModelGateway,
  overrides: {
    initialModel?: ModelDefinition;
    resolveApiKey?: (credentialId: CredentialId) => Promise<string | undefined>;
    fetchImpl?: typeof fetch;
    session?: ConversationSession;
    historyPreferences?: HistoryPreferences;
    workspaceRoot?: string;
    toolInteraction?: ToolInteraction & ShellInteraction;
    planning?: PlanManager;
  } = {},
) {
  return {
    initialModel: deepSeekModel,
    gateway,
    resolveApiKey: createResolver({ deepseek: "deepseek-key" }),
    tavilyApiKey: "tvly-test",
    ...overrides,
  };
}

test("includes workspace tools and accurate execution guidance", async () => {
  const gateway = createFakeGateway([reply("ok")]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      workspaceRoot: "/Users/test/shop-api",
    }),
  );

  await conversation.send("检查项目");

  const request = gateway.requests[0]!;
  const systemMessage = request.messages[0]!;
  const names = request.tools.map((tool) => tool.name);
  for (const name of [
    "read",
    "ls",
    "find",
    "grep",
    "edit",
    "write",
    "set_env",
    "shell",
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(systemMessage.role, "system");
  assert.match(systemMessage.content, /\/Users\/test\/shop-api/);
  assert.match(systemMessage.content, /当前工作区/);
  assert.match(
    systemMessage.content,
    /read、ls、find、grep、edit、write、set_env、shell/,
  );
  assert.match(systemMessage.content, /修改前先读取.*小范围 edit/);
  assert.match(systemMessage.content, /shell.*固定.*当前工作区/);
  assert.match(systemMessage.content, /读取.*测试.*类型检查.*自动执行/s);
  assert.match(systemMessage.content, /其他.*确认/);
  assert.match(systemMessage.content, /exitCode.*0.*明确成功.*宣称成功/s);
  assert.match(systemMessage.content, /禁止.*拒绝.*失败.*如实说明/s);
  assert.doesNotMatch(systemMessage.content, /没有 bash|没有.*自动测试/);
  assert.doesNotMatch(systemMessage.content, /当前版本没有本地文件工具/);
});

test("runs an automatic shell command in the workspace and continues the tool loop", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-shell-pwd",
        name: "shell",
        argumentsJson: '{"command":"pwd"}',
      }],
    }),
    (request) => {
      const toolMessage = request.messages.findLast(
        (message) => message.role === "tool",
      );
      assert.ok(toolMessage && toolMessage.role === "tool");
      const result = JSON.parse(toolMessage.content) as {
        exitCode?: unknown;
        output?: unknown;
      };
      assert.equal(result.exitCode, 0);
      assert.equal(typeof result.output, "string");
      assert.match(String(result.output), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return { content: "工作区已确认", toolCalls: [] };
    },
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    workspaceRoot: root,
  }));

  assert.equal(await conversation.send("当前目录是什么？"), "工作区已确认");
  assert.equal(gateway.requests.length, 2);
  assert.ok(gateway.requests[0]?.tools.some((tool) => tool.name === "shell"));
});

test("returns COMMAND_DENIED to the model without requesting confirmation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let confirmationCalls = 0;
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-shell-denied",
        name: "shell",
        argumentsJson: '{"command":"sudo npm test"}',
      }],
    }),
    (request) => {
      const toolMessage = request.messages.findLast(
        (message) => message.role === "tool",
      );
      assert.ok(toolMessage && toolMessage.role === "tool");
      assert.match(toolMessage.content, /COMMAND_DENIED/);
      return { content: "命令已被安全策略拒绝", toolCalls: [] };
    },
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    workspaceRoot: root,
    toolInteraction: {
      async authorizeProtected() {
        return false;
      },
      async confirmMutation() {
        return false;
      },
      async requestSecret() {
        return undefined;
      },
      async confirmShell() {
        confirmationCalls += 1;
        return true;
      },
    },
  }));

  assert.equal(
    await conversation.send("用 sudo 跑测试"),
    "命令已被安全策略拒绝",
  );
  assert.equal(confirmationCalls, 0);
  assert.equal(gateway.requests.length, 2);
});

test("set_env secret is absent from committed Conversation messages", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "secret-only-in-local-file";
  const session = createFakeSession();
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-env",
        name: "set_env",
        argumentsJson: '{"path":".env","key":"TOKEN"}',
      }],
    }),
    reply("已经设置"),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    workspaceRoot: root,
    toolInteraction: {
      async authorizeProtected() { return true; },
      async requestSecret() { return secret; },
      async confirmMutation() { return true; },
    },
  }));

  assert.equal(await conversation.send("设置 TOKEN"), "已经设置");
  assert.doesNotMatch(JSON.stringify(session.commits), /secret-only-in-local-file/);
  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "TOKEN=secret-only-in-local-file\n",
  );
});

function storedTurn(
  sequence: number,
  messages: readonly PersistedMessage[],
): StoredTurn {
  return {
    id: `turn-${sequence}`,
    sequence,
    createdAt: "2026-07-17T00:00:00.000Z",
    messages: structuredClone(messages),
  };
}

function createFakeSession(options: {
  model?: ModelDefinition;
  turns?: readonly StoredTurn[];
  summary?: StoredSummary;
  onGetCurrent?: (call: number, current: CurrentSession) => CurrentSession;
  onCommit?: (messages: readonly PersistedMessage[]) => void;
  onSaveSummary?: (throughTurnSequence: number, content: string) => void;
} = {}): ConversationSession & {
  commits: PersistedMessage[][];
  savedSummaries: Array<{ throughTurnSequence: number; content: string }>;
  getCurrentCalls: number;
} {
  let model = options.model ?? deepSeekModel;
  let turns = structuredClone(options.turns ?? []);
  let summary = options.summary === undefined
    ? undefined
    : structuredClone(options.summary);
  let getCurrentCalls = 0;
  const commits: PersistedMessage[][] = [];
  const savedSummaries: Array<{
    throughTurnSequence: number;
    content: string;
  }> = [];

  const fake = {
    commits,
    savedSummaries,
    get getCurrentCalls() {
      return getCurrentCalls;
    },
    getCurrent(): CurrentSession {
      getCurrentCalls += 1;
      const current: CurrentSession = {
        model,
        turns: structuredClone(turns),
        ...(summary === undefined ? {} : { summary: structuredClone(summary) }),
      };
      return structuredClone(
        options.onGetCurrent?.(getCurrentCalls, current) ?? current,
      );
    },
    getModel() {
      return model;
    },
    setModel(next: ModelDefinition) {
      model = next;
    },
    commitTurn(messages: readonly PersistedMessage[]): StoredTurn {
      options.onCommit?.(messages);
      const snapshot = [...structuredClone(messages)];
      commits.push(snapshot);
      const turn = storedTurn(turns.length + 1, snapshot);
      turns = [...turns, turn];
      return structuredClone(turn);
    },
    saveSummary(throughTurnSequence: number, content: string): StoredSummary {
      options.onSaveSummary?.(throughTurnSequence, content);
      savedSummaries.push({ throughTurnSequence, content });
      const now = "2026-07-17T00:00:00.000Z";
      summary = {
        throughTurnSequence,
        content,
        sourceRevision: turns.length,
        createdAt: now,
        updatedAt: now,
      };
      return structuredClone(summary);
    },
  };
  return fake;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function collectConversationEvents(
  events: AsyncIterable<ConversationEvent>,
): Promise<ConversationEvent[]> {
  const collected: ConversationEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

interface HistoryCounts {
  readonly sessions: number;
  readonly turns: number;
  readonly messages: number;
  readonly summaries: number;
}

function readHistoryCounts(databasePath: string): HistoryCounts {
  const database = new Database(databasePath, { readonly: true });
  try {
    const count = (table: string): number =>
      database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
    return {
      sessions: count("sessions"),
      turns: count("turns"),
      messages: count("messages"),
      summaries: count("session_summaries"),
    };
  } finally {
    database.close();
  }
}

test("streams concise reasoning status and text without exposing raw reasoning", async () => {
  const rawReasoning = "private chain of thought";
  const gateway: ModelGateway = {
    async *stream() {
      yield { type: "start" };
      yield {
        type: "reasoning_delta",
        field: "reasoning_content",
        delta: rawReasoning,
      };
      yield {
        type: "reasoning_delta",
        field: "reasoning_content",
        delta: "more private reasoning",
      };
      yield { type: "text_delta", delta: "你好，" };
      yield { type: "text_delta", delta: "世界" };
      yield {
        type: "done",
        reply: {
          content: "你好，世界",
          toolCalls: [],
          reasoning: {
            providerId: "deepseek",
            field: "reasoning_content",
            text: `${rawReasoning}more private reasoning`,
          },
        },
      };
    },
  };
  const conversation = createConversation(conversationOptions(gateway));

  const events = await collectConversationEvents(conversation.stream("你好"));

  assert.deepEqual(events, [
    { type: "status", text: "正在分析问题…" },
    { type: "text_delta", delta: "你好，" },
    { type: "text_delta", delta: "世界" },
    { type: "done", content: "你好，世界" },
  ]);
  assert.equal(JSON.stringify(events).includes(rawReasoning), false);
});

test("streams tool rounds in display order and replays the authoritative assistant", async () => {
  const signal = new AbortController().signal;
  const toolReply: ModelReply = {
    content: "我先计算一下。",
    toolCalls: [
      {
        id: "call-calculator",
        name: "calculator",
        argumentsJson: '{"expression":"6*7"}',
      },
    ],
    reasoning: {
      providerId: "deepseek",
      field: "reasoning_content",
      text: "private reasoning",
      details: [{ type: "opaque", value: 1 }],
    },
  };
  const gateway = createStreamingGateway([
    () => [
      { type: "start" },
      {
        type: "reasoning_delta",
        field: "reasoning_content",
        delta: "private reasoning",
      },
      { type: "text_delta", delta: "我先计算一下。" },
      {
        type: "tool_call_delta",
        index: 0,
        id: "call-calculator",
        name: "calcu",
        argumentsDelta: '{"expression":',
      },
      {
        type: "tool_call_delta",
        index: 0,
        name: "lator",
        argumentsDelta: '"6*7"}',
      },
      { type: "done", reply: toolReply },
    ],
    () => [
      { type: "start" },
      { type: "text_delta", delta: "答案是 42。" },
      {
        type: "done",
        reply: { content: "答案是 42。", toolCalls: [] },
      },
    ],
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  const events = await collectConversationEvents(
    conversation.stream("计算 6*7", signal),
  );

  assert.deepEqual(events, [
    { type: "status", text: "正在分析问题…" },
    { type: "text_delta", delta: "我先计算一下。" },
    { type: "segment_end" },
    { type: "status", text: "正在准备调用工具…" },
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "start" },
    },
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "success" },
    },
    { type: "status", text: "正在整理工具结果…" },
    { type: "text_delta", delta: "答案是 42。" },
    { type: "done", content: "答案是 42。" },
  ]);
  assert.deepEqual(gateway.requests[0]?.model, deepSeekModel);
  assert.deepEqual(gateway.requests[1]?.model, deepSeekModel);
  assert.equal(gateway.requests[0]?.apiKey, "deepseek-key");
  assert.equal(gateway.requests[1]?.apiKey, "deepseek-key");
  assert.equal(gateway.requests[0]?.signal, signal);
  assert.equal(gateway.requests[1]?.signal, signal);
  assert.deepEqual(gateway.requests[1]?.messages.slice(-2), [
    {
      role: "assistant",
      content: "我先计算一下。",
      toolCalls: toolReply.toolCalls,
      reasoning: toolReply.reasoning,
    },
    {
      role: "tool",
      toolCallId: "call-calculator",
      content: JSON.stringify({ ok: true, expression: "6*7", result: 42 }),
    },
  ]);
});

test("keeps partial streamed text visible but rolls back a model parse error", async () => {
  const parseError = new Error("safe stream parse failure");
  const gateway = createStreamingGateway([
    () =>
      (async function* () {
        yield { type: "start" } as const;
        yield { type: "text_delta", delta: "已经显示" } as const;
        throw parseError;
      })(),
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway));
  const visible: ConversationEvent[] = [];

  await assert.rejects(
    async () => {
      for await (const event of conversation.stream("失败的一轮")) {
        visible.push(event);
      }
    },
    (error) => error === parseError,
  );
  assert.deepEqual(visible, [{ type: "text_delta", delta: "已经显示" }]);

  assert.equal(await conversation.send("重新开始"), "恢复成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("rolls back when the consumer returns after the first text delta", async () => {
  const gateway = createStreamingGateway([
    () => [
      { type: "start" },
      { type: "text_delta", delta: "只显示这一段" },
      {
        type: "done",
        reply: { content: "不应提交", toolCalls: [] },
      },
    ],
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway));
  const iterator = conversation.stream("放弃的一轮")[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "只显示这一段" },
  });
  await iterator.return?.();

  assert.equal(await conversation.send("重新开始"), "恢复成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("rejects overlapping turns without resolving a key or touching history", async () => {
  const resolveCalls: CredentialId[] = [];
  const gateway = createStreamingGateway([
    () => replyEvents({ content: "已提交", toolCalls: [] }),
    () => [
      { type: "start" },
      { type: "text_delta", delta: "暂停中的正文" },
      {
        type: "done",
        reply: { content: "不应提交", toolCalls: [] },
      },
    ],
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: createResolver({ deepseek: "key" }, resolveCalls),
    }),
  );
  assert.equal(await conversation.send("已完成的一轮"), "已提交");
  const activeIterator = conversation
    .stream("暂停的一轮")
    [Symbol.asyncIterator]();
  assert.deepEqual(await activeIterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "暂停中的正文" },
  });

  await assert.rejects(conversation.send("并发请求一"), /正在处理/);
  await assert.rejects(
    collectConversationEvents(conversation.stream("并发请求二")),
    /正在处理/,
  );
  assert.equal(gateway.requests.length, 2);
  assert.deepEqual(resolveCalls, ["deepseek", "deepseek"]);

  await activeIterator.return?.();
  assert.equal(await conversation.send("关闭后重试"), "恢复成功");
  assert.deepEqual(resolveCalls, ["deepseek", "deepseek", "deepseek"]);
  assert.deepEqual(gateway.requests[2]?.messages.slice(1), [
    { role: "user", content: "已完成的一轮" },
    { role: "assistant", content: "已提交", toolCalls: [] },
    { role: "user", content: "关闭后重试" },
  ]);
});

for (const stopAfter of ["segment_end", "tool_activity"] as const) {
  test(`rolls back when the consumer returns after ${stopAfter}`, async () => {
    const gateway = createStreamingGateway([
      () =>
        replyEvents({
          content: "先显示正文",
          toolCalls: [
            {
              id: "call-calculator",
              name: "calculator",
              argumentsJson: '{"expression":"6*7"}',
            },
          ],
        }),
      () => replyEvents({ content: "恢复成功", toolCalls: [] }),
    ]);
    const conversation = createConversation(conversationOptions(gateway));
    const iterator = conversation.stream("放弃工具轮")[Symbol.asyncIterator]();

    while (true) {
      const result = await iterator.next();
      assert.equal(result.done, false);
      if (result.value?.type === stopAfter) {
        break;
      }
    }
    await iterator.return?.();

    assert.equal(await conversation.send("重新开始"), "恢复成功");
    assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
      { role: "user", content: "重新开始" },
    ]);
  });
}

test("keeps a successful turn when the consumer returns after done", async () => {
  const gateway = createStreamingGateway([
    () => replyEvents({ content: "已经完成", toolCalls: [] }),
    () => replyEvents({ content: "继续完成", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway));
  const iterator = conversation.stream("第一轮")[Symbol.asyncIterator]();

  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "text_delta", delta: "已经完成" },
  });
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: "done", content: "已经完成" },
  });
  await iterator.return?.();

  assert.equal(await conversation.send("第二轮"), "继续完成");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "第一轮" },
    { role: "assistant", content: "已经完成", toolCalls: [] },
    { role: "user", content: "第二轮" },
  ]);
});

test("rolls back an unhandled tool AbortError", async () => {
  const abort = new Error("tool aborted");
  abort.name = "AbortError";
  const gateway = createStreamingGateway([
    () =>
      replyEvents({
        toolCalls: [
          {
            id: "call-search",
            name: "web_search",
            argumentsJson: '{"query":"coffee"}',
          },
        ],
      }),
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      fetchImpl: async () => {
        throw abort;
      },
    }),
  );

  await assert.rejects(conversation.send("搜索"), (error) => error === abort);
  assert.equal(await conversation.send("重新开始"), "恢复成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("rolls back a direct model AbortError", async () => {
  const abort = new Error("model aborted");
  abort.name = "AbortError";
  const gateway = createStreamingGateway([
    () =>
      (async function* () {
        throw abort;
        yield { type: "start" } as const;
      })(),
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  await assert.rejects(conversation.send("取消的一轮"), (error) => error === abort);
  assert.equal(await conversation.send("重新开始"), "恢复成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("send collects only the authoritative done content", async () => {
  const gateway = createStreamingGateway([
    () => [
      { type: "start" },
      { type: "text_delta", delta: "分段一" },
      { type: "text_delta", delta: "分段二" },
      {
        type: "done",
        reply: { content: "最终正文", toolCalls: [] },
      },
    ],
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  assert.equal(await conversation.send("你好"), "最终正文");
});

test("rejects a model stream that ends without done and rolls back", async () => {
  const gateway = createStreamingGateway([
    () => [{ type: "start" }, { type: "text_delta", delta: "不完整" }],
    () => replyEvents({ content: "恢复成功", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  await assert.rejects(
    conversation.send("不完整的一轮"),
    /模型流未返回最终正文/,
  );
  assert.equal(await conversation.send("重新开始"), "恢复成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("maps model fallback to the approved concise Chinese notice", async () => {
  const gateway = createStreamingGateway([
    () => [
      { type: "start" },
      { type: "fallback" },
      { type: "text_delta", delta: "完整回复" },
      {
        type: "done",
        reply: { content: "完整回复", toolCalls: [] },
      },
    ],
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  assert.deepEqual(await collectConversationEvents(conversation.stream("你好")), [
    {
      type: "fallback",
      text: "当前模型暂不支持流式输出，已切换为完整输出。",
    },
    { type: "text_delta", delta: "完整回复" },
    { type: "done", content: "完整回复" },
  ]);
});

test("represents a model response as typed stream events", async () => {
  const reply: ModelReply = { content: "你好", toolCalls: [] };
  const events: ModelStreamEvent[] = [];

  for await (const event of modelStream(replyEvents(reply))) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: "start" },
    { type: "text_delta", delta: "你好" },
    { type: "done", reply },
  ]);
});

test("omits text deltas for model replies without content", () => {
  const reply: ModelReply = { toolCalls: [] };

  assert.deepEqual(replyEvents(reply), [
    { type: "start" },
    { type: "done", reply },
  ]);
});

test("rejects a missing Tavily API key synchronously", () => {
  const gateway = createFakeGateway();

  assert.throws(
    () =>
      createConversation({
        initialModel: deepSeekModel,
        gateway,
        resolveApiKey: createResolver({ deepseek: "key" }),
        tavilyApiKey: "  ",
      }),
    /TAVILY_API_KEY/,
  );
});

test("blocks locally when no model is selected", async () => {
  const gateway = createFakeGateway();
  const resolveCalls: CredentialId[] = [];
  const conversation = createConversation(
    conversationOptions(gateway, {
      initialModel: undefined,
      resolveApiKey: createResolver({}, resolveCalls),
    }),
  );

  assert.equal(conversation.getModel(), undefined);
  await assert.rejects(conversation.send("你好"), /\/login.*\/model/);
  assert.equal(gateway.requests.length, 0);
  assert.deepEqual(resolveCalls, []);
});

test("blocks locally when the selected model has no resolved key", async () => {
  const gateway = createFakeGateway([reply("恢复成功")]);
  let key: string | undefined = "  ";
  const conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: async () => key,
    }),
  );

  await assert.rejects(conversation.send("不应进入历史"), /\/login/);
  assert.equal(gateway.requests.length, 0);

  key = "available-key";
  assert.equal(await conversation.send("现在可以了"), "恢复成功");
  assert.deepEqual(gateway.requests[0]?.messages.slice(1), [
    { role: "user", content: "现在可以了" },
  ]);
});

test("passes the selected model, resolved key, messages, and neutral tools", async () => {
  const gateway = createFakeGateway([reply("你好，我是 Coffee。")]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: createResolver({ deepseek: "  resolved-key  " }),
    }),
  );

  assert.equal(await conversation.send("你好"), "你好，我是 Coffee。");

  const request = gateway.requests[0];
  assert.deepEqual(request?.model, deepSeekModel);
  assert.equal(request?.apiKey, "resolved-key");
  assert.equal(request?.messages[0]?.role, "system");
  assert.match(request?.messages[0]?.content ?? "", /Coffee/);
  assert.deepEqual(request?.messages.slice(1), [
    { role: "user", content: "你好" },
  ]);
  assert.deepEqual(
    request?.tools.map((tool) => tool.name),
    ["web_search", "web_fetch", "get_current_location", "calculator"],
  );
  assert.equal(JSON.stringify(request?.tools).includes("riskLevel"), false);
});

test("includes prior user and assistant history on the next send", async () => {
  const gateway = createFakeGateway([reply("第一条回复"), reply("第二条回复")]);
  const conversation = createConversation(conversationOptions(gateway));

  await conversation.send("第一条问题");
  await conversation.send("第二条问题");

  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "第一条问题" },
    { role: "assistant", content: "第一条回复", toolCalls: [] },
    { role: "user", content: "第二条问题" },
  ]);
});

test("preserves provider reasoning through tool rounds and later history without displaying it", async () => {
  const toolReasoning = {
    providerId: "deepseek",
    field: "reasoning_content" as const,
    text: "private tool reasoning",
    details: [{ type: "reasoning.encrypted", data: { token: "opaque" } }],
  };
  const finalReasoning = {
    providerId: "deepseek",
    field: "reasoning_text" as const,
    text: "private final reasoning",
  };
  const toolReply: ModelReply = {
    toolCalls: [
      {
        id: "call-calculator",
        name: "calculator",
        argumentsJson: '{"expression":"6*7"}',
      },
    ],
    reasoning: toolReasoning,
  };
  const finalReply: ModelReply = {
    content: "工具完成",
    toolCalls: [],
    reasoning: finalReasoning,
  };
  const gateway = createFakeGateway([
    () => toolReply,
    () => finalReply,
    reply("后续完成"),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  assert.equal(await conversation.send("计算"), "工具完成");
  assert.deepEqual(gateway.requests[1]?.messages.at(-2), {
    role: "assistant",
    content: "",
    toolCalls: toolReply.toolCalls,
    reasoning: toolReasoning,
  });

  toolReasoning.details[0]!.data.token = "mutated";
  finalReasoning.text = "mutated";
  assert.equal(await conversation.send("继续"), "后续完成");
  assert.deepEqual(gateway.requests[2]?.messages.slice(-2), [
    {
      role: "assistant",
      content: "工具完成",
      toolCalls: [],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_text",
        text: "private final reasoning",
      },
    },
    { role: "user", content: "继续" },
  ]);
  assert.equal(
    JSON.stringify(gateway.requests[2]?.messages).includes("mutated"),
    false,
  );
});

test("setModel changes the next turn without clearing history", async () => {
  const gateway = createFakeGateway([reply("第一条回复"), reply("第二条回复")]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: createResolver({
        deepseek: "deepseek-key",
        opencode: "opencode-key",
      }),
    }),
  );

  await conversation.send("第一条问题");
  conversation.setModel(openCodeModel);

  assert.deepEqual(conversation.getModel(), openCodeModel);
  await conversation.send("第二条问题");

  assert.deepEqual(gateway.requests[1]?.model, openCodeModel);
  assert.equal(gateway.requests[1]?.apiKey, "opencode-key");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "第一条问题" },
    { role: "assistant", content: "第一条回复", toolCalls: [] },
    { role: "user", content: "第二条问题" },
  ]);
});

test("rejects active setModel and pins model and key for every tool round", async () => {
  const resolveCalls: CredentialId[] = [];
  let conversation: ReturnType<typeof createConversation>;
  const gateway = createFakeGateway([
    () => {
      assert.throws(
        () => conversation.setModel(openCodeModel),
        /请求.*处理中.*切换模型/,
      );
      return {
        content: "",
        toolCalls: [
          {
            id: "call-calculator",
            name: "calculator",
            argumentsJson: '{"expression":"6*7"}',
          },
        ],
      };
    },
    reply("第一轮完成"),
    reply("第二轮完成"),
  ]);
  conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: createResolver(
        { deepseek: "deepseek-key", opencode: "opencode-key" },
        resolveCalls,
      ),
    }),
  );

  assert.equal(await conversation.send("计算"), "第一轮完成");
  assert.deepEqual(gateway.requests[0]?.model, deepSeekModel);
  assert.deepEqual(gateway.requests[1]?.model, deepSeekModel);
  assert.equal(gateway.requests[0]?.apiKey, "deepseek-key");
  assert.equal(gateway.requests[1]?.apiKey, "deepseek-key");
  assert.deepEqual(resolveCalls, ["deepseek"]);

  conversation.setModel(openCodeModel);
  assert.equal(await conversation.send("再问一次"), "第二轮完成");
  assert.deepEqual(gateway.requests[2]?.model, openCodeModel);
  assert.equal(gateway.requests[2]?.apiKey, "opencode-key");
  assert.deepEqual(resolveCalls, ["deepseek", "opencode"]);
});

test("default memory session snapshots initial, set, and returned models", async () => {
  const initial = structuredClone(deepSeekModel) as MutableModelDefinition;
  const selected = structuredClone(openCodeModel) as MutableModelDefinition;
  const gateway = createFakeGateway([reply("第一轮"), reply("第二轮")]);
  const conversation = createConversation(conversationOptions(gateway, {
    initialModel: initial,
    resolveApiKey: createResolver({
      deepseek: "deepseek-key",
      opencode: "opencode-key",
    }),
  }));

  initial.id = "mutated-initial";
  const returnedInitial = conversation.getModel() as MutableModelDefinition;
  returnedInitial.providerId = "mutated-returned";
  assert.equal(await conversation.send("第一问"), "第一轮");
  assert.deepEqual(gateway.requests[0]?.model, deepSeekModel);

  conversation.setModel(selected);
  selected.id = "mutated-selected";
  const returnedSelected = conversation.getModel() as MutableModelDefinition;
  returnedSelected.name = "mutated-returned-selected";
  assert.equal(await conversation.send("第二问"), "第二轮");
  assert.deepEqual(gateway.requests[1]?.model, openCodeModel);
});

test("default memory session exposes persisted revisions and summaries use the pre-save revision", async () => {
  const originalStructuredClone = globalThis.structuredClone;
  const observedRevisions: number[] = [];
  const observedSourceRevisions: number[] = [];
  globalThis.structuredClone = function observingStructuredClone<T>(
    value: T,
    options?: StructuredSerializeOptions,
  ): T {
    const cloned = originalStructuredClone(value, options);
    if (typeof cloned === "object" && cloned !== null) {
      const record = cloned as Record<string, unknown>;
      if (Array.isArray(record.turns) && typeof record.revision === "number") {
        observedRevisions.push(record.revision);
      }
      if (
        typeof record.throughTurnSequence === "number" &&
        typeof record.sourceRevision === "number"
      ) {
        observedSourceRevisions.push(record.sourceRevision);
      }
    }
    return cloned;
  };

  try {
    const gateway = createFakeGateway([
      reply("reply".repeat(140)),
      reply("内存摘要"),
      reply("第二轮回答"),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      historyPreferences: {
        compressionThresholdChars: 1_800,
        maxContextChars: 3_000,
        summaryTargetChars: 100,
      },
    }));

    await conversation.send("first".repeat(140));
    await conversation.send("第二轮");
  } finally {
    globalThis.structuredClone = originalStructuredClone;
  }

  assert.deepEqual(observedSourceRevisions, [1]);
  assert.ok(observedRevisions.includes(1));
  assert.ok(observedRevisions.includes(2));
});

test("resolves the API key once per send, not once per tool round", async () => {
  const resolveCalls: CredentialId[] = [];
  const gateway = createFakeGateway([
    () => ({
      toolCalls: [
        {
          id: "call-1",
          name: "calculator",
          argumentsJson: '{"expression":"1+1"}',
        },
      ],
    }),
    reply("第一轮完成"),
    reply("第二轮完成"),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      resolveApiKey: createResolver({ deepseek: "key" }, resolveCalls),
    }),
  );

  await conversation.send("第一轮");
  await conversation.send("第二轮");

  assert.deepEqual(resolveCalls, ["deepseek", "deepseek"]);
});

test("passes one abort signal through every model and tool round", async () => {
  let toolSignal: AbortSignal | null | undefined;
  const gateway = createFakeGateway([
    () => ({
      toolCalls: [
        {
          id: "call-search",
          name: "web_search",
          argumentsJson: '{"query":"coffee"}',
        },
      ],
    }),
    reply("搜索完成"),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      fetchImpl: async (_input, init) => {
        toolSignal = init?.signal;
        return jsonResponse({ results: [] });
      },
    }),
  );
  const signal = new AbortController().signal;

  assert.equal(await conversation.send("搜索", signal), "搜索完成");

  assert.equal(gateway.requests[0]?.signal, signal);
  assert.equal(gateway.requests[1]?.signal, signal);
  assert.equal(toolSignal, signal);
});

test("rolls back a failed gateway turn before the next request", async () => {
  const gatewayError = new Error("provider unavailable");
  const gateway = createFakeGateway([
    () => {
      throw gatewayError;
    },
    reply("已恢复"),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  await assert.rejects(conversation.send("失败的一轮"), (error) => {
    assert.equal(error, gatewayError);
    return true;
  });
  await conversation.send("重新开始");

  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("rejects an empty assistant response and rolls back the turn", async () => {
  const gateway = createFakeGateway([
    () => ({ content: "   ", toolCalls: [] }),
    reply("有效回复"),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  await assert.rejects(
    conversation.send("无效的一轮"),
    /无效的 assistant 文本/,
  );
  await conversation.send("有效的一轮");

  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "有效的一轮" },
  ]);
});

test("replays neutral tool messages and reports success and error activity", async () => {
  const gateway = createFakeGateway([
    () => ({
      content: undefined,
      toolCalls: [
        {
          id: "call-success",
          name: "calculator",
          argumentsJson: '{"expression":"6*7"}',
        },
        {
          id: "call-error",
          name: "calculator",
          argumentsJson: '{"wrong":"field"}',
        },
      ],
    }),
    reply("工具处理完成"),
  ]);
  const conversation = createConversation(conversationOptions(gateway));

  const events = await collectConversationEvents(conversation.stream("计算"));
  assert.equal(events.at(-1)?.type, "done");

  assert.deepEqual(gateway.requests[1]?.messages.slice(-3), [
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-success",
          name: "calculator",
          argumentsJson: '{"expression":"6*7"}',
        },
        {
          id: "call-error",
          name: "calculator",
          argumentsJson: '{"wrong":"field"}',
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-success",
      content: JSON.stringify({ ok: true, expression: "6*7", result: 42 }),
    },
    {
      role: "tool",
      toolCallId: "call-error",
      content: JSON.stringify({
        ok: false,
        error: "calculator 缺少非空的 expression 参数。",
      }),
    },
  ]);
  assert.deepEqual(events.filter((event) => event.type === "tool_activity"), [
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "start" },
    },
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "success" },
    },
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "start" },
    },
    {
      type: "tool_activity",
      event: { name: "calculator", phase: "error" },
    },
  ]);
});

test("stops and rolls back after five consecutive tool-call rounds", async () => {
  let toolCalls = 0;
  const handlers: ReplyHandler[] = Array.from({ length: 5 }, () => () => {
    toolCalls += 1;
    return {
      toolCalls: [
        {
          id: `call-${toolCalls}`,
          name: "calculator",
          argumentsJson: '{"expression":"1+1"}',
        },
      ],
    };
  });
  handlers.push(reply("下一轮成功"));
  const gateway = createFakeGateway(handlers);
  const conversation = createConversation(conversationOptions(gateway));

  await assert.rejects(conversation.send("一直调用工具"), /工具调用超过 5 轮/);
  assert.equal(gateway.requests.length, 5);

  await conversation.send("重新开始");
  assert.deepEqual(gateway.requests[5]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
});

test("history restores complete turns before the current user message", async () => {
  const session = createFakeSession({
    turns: [
      storedTurn(1, [
        { role: "user", content: "已恢复的问题" },
        { role: "assistant", content: "旧回答", toolCalls: [] },
      ]),
    ],
  });
  const gateway = createFakeGateway([reply("继续回答")]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );

  assert.equal(await conversation.send("继续"), "继续回答");

  const request = gateway.requests[0];
  assert.equal(request?.messages[0]?.role, "system");
  assert.match(request?.messages[0]?.content ?? "", /Coffee/);
  assert.deepEqual(request?.messages.slice(1), [
    { role: "user", content: "已恢复的问题" },
    { role: "assistant", content: "旧回答", toolCalls: [] },
    { role: "user", content: "继续" },
  ]);
});

test("history commit failure leaves text visible, omits done, and does not pollute the next turn", async () => {
  let commitAttempts = 0;
  const session = createFakeSession({
    onCommit() {
      commitAttempts += 1;
      if (commitAttempts === 1) throw new Error("disk full");
    },
  });
  const gateway = createFakeGateway([reply("已经生成"), reply("下一轮成功")]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );
  const visible: ConversationEvent[] = [];

  await assert.rejects(
    async () => {
      for await (const event of conversation.stream("保存失败的一轮")) {
        visible.push(event);
      }
    },
    /回答已生成，但历史保存失败，本轮未记录：disk full/,
  );
  assert.deepEqual(visible, [{ type: "text_delta", delta: "已经生成" }]);

  assert.equal(await conversation.send("重新开始"), "下一轮成功");
  assert.deepEqual(gateway.requests[1]?.messages.slice(1), [
    { role: "user", content: "重新开始" },
  ]);
  assert.equal(session.commits.length, 1);
});

const COMPRESSION_PREFERENCES: HistoryPreferences = {
  compressionThresholdChars: 1_800,
  maxContextChars: 2_100,
  summaryTargetChars: 100,
};

function compressionTurns(prefix = "old"): StoredTurn[] {
  return [1, 2, 3].map((sequence) => storedTurn(sequence, [
    { role: "user", content: `${prefix}-${sequence}-`.repeat(80) },
    {
      role: "assistant",
      content: `${prefix}-reply-${sequence}-`.repeat(60),
      toolCalls: [],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: "SUMMARY_REASONING_SECRET",
      },
    },
  ]));
}

async function withRealHistorySession(
  turns: readonly StoredTurn[],
  run: (value: {
    databasePath: string;
    store: ReturnType<typeof createHistoryStore>;
    session: ReturnType<typeof createSessionManager>;
  }) => Promise<void>,
): Promise<void> {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSessionManager({
        store,
        defaultModel: deepSeekModel,
        getModel(providerId, modelId) {
          return providerId === deepSeekModel.providerId &&
              modelId === deepSeekModel.id
            ? deepSeekModel
            : undefined;
        },
      });
      for (const turn of turns) {
        session.commitTurn(turn.messages);
      }
      await run({ databasePath, store, session });
    } finally {
      store.close();
    }
  });
}

async function withRealSessionPair(
  run: (value: {
    store: ReturnType<typeof createHistoryStore>;
    session: ReturnType<typeof createSessionManager>;
    sessionAId: string;
    sessionBId: string;
    sessionABefore: NonNullable<ReturnType<ReturnType<
      typeof createHistoryStore
    >["loadSession"]>>;
    sessionBBefore: NonNullable<ReturnType<ReturnType<
      typeof createHistoryStore
    >["loadSession"]>>;
  }) => Promise<void>,
): Promise<void> {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSessionManager({
        store,
        defaultModel: deepSeekModel,
        getModel(providerId, modelId) {
          return providerId === deepSeekModel.providerId &&
              modelId === deepSeekModel.id
            ? deepSeekModel
            : undefined;
        },
      });
      for (const turn of compressionTurns("session-a")) {
        session.commitTurn(turn.messages);
      }
      const sessionAId = session.getCurrent().id!;

      session.startNew(deepSeekModel);
      for (const turn of compressionTurns("session-b")) {
        session.commitTurn(turn.messages);
      }
      const sessionBId = session.getCurrent().id!;
      session.switchSession(sessionAId);

      await run({
        store,
        session,
        sessionAId,
        sessionBId,
        sessionABefore: store.loadSession(sessionAId)!,
        sessionBBefore: store.loadSession(sessionBId)!,
      });
    } finally {
      store.close();
    }
  });
}

test("real SQLite stays unchanged when a provider throws after visible text", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const providerError = new Error("provider stream failed");
    const gateway = createStreamingGateway([
      () => (async function* () {
        yield { type: "start" } as const;
        yield { type: "text_delta", delta: "已经显示" } as const;
        throw providerError;
      })(),
    ]);
    const conversation = createConversation(
      conversationOptions(gateway, { session }),
    );
    const visible: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("失败的一轮")) {
        visible.push(event);
      }
    }, (error) => error === providerError);

    assert.deepEqual(visible, [{ type: "text_delta", delta: "已经显示" }]);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("real SQLite stays unchanged after five tool error rounds without a final reply", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const gateway = createFakeGateway(
      Array.from({ length: 5 }, (_, index) => () => ({
        toolCalls: [{
          id: `call-error-${index + 1}`,
          name: "calculator",
          argumentsJson: '{"wrong":"field"}',
        }],
      })),
    );
    const conversation = createConversation(
      conversationOptions(gateway, { session }),
    );

    await assert.rejects(
      conversation.send("持续返回工具错误"),
      /工具调用超过 5 轮/,
    );

    assert.equal(gateway.requests.length, 5);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("real SQLite stays unchanged when summary generation is aborted", async () => {
  await withRealHistorySession(
    compressionTurns(),
    async ({ databasePath, session }) => {
      const before = readHistoryCounts(databasePath);
      const controller = new AbortController();
      const gateway = createStreamingGateway([
        () => (async function* () {
          yield { type: "start" } as const;
          controller.abort();
          controller.signal.throwIfAborted();
        })(),
      ]);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        historyPreferences: COMPRESSION_PREFERENCES,
      }));

      await assert.rejects(
        conversation.send("新问题", controller.signal),
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );

      assert.equal(gateway.requests.length, 1);
      assert.deepEqual(readHistoryCounts(databasePath), before);
    },
  );
});

test("real SQLite stays unchanged when the main response is aborted after done", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const controller = new AbortController();
    const gateway = createStreamingGateway([
      () => (async function* () {
        const finalReply: ModelReply = { content: "已经显示", toolCalls: [] };
        yield { type: "start" } as const;
        yield { type: "text_delta", delta: "已经显示" } as const;
        yield { type: "done", reply: finalReply } as const;
        controller.abort();
      })(),
    ]);
    const conversation = createConversation(
      conversationOptions(gateway, { session }),
    );
    const visible: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream(
        "取消这一轮",
        controller.signal,
      )) {
        visible.push(event);
      }
    }, (error: unknown) => error instanceof Error && error.name === "AbortError");

    assert.deepEqual(visible, [{ type: "text_delta", delta: "已经显示" }]);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("real SQLite rolls back every table when commitTurn throws after the final reply", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const database = new Database(databasePath);
    try {
      database.exec(`
        CREATE TRIGGER fail_turn_commit
        BEFORE INSERT ON turns
        BEGIN
          SELECT RAISE(ABORT, 'injected commit failure');
        END
      `);
    } finally {
      database.close();
    }
    const gateway = createFakeGateway([reply("已经生成")]);
    const conversation = createConversation(
      conversationOptions(gateway, { session }),
    );
    const visible: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("保存失败")) {
        visible.push(event);
      }
    }, /回答已生成，但历史保存失败，本轮未记录.*injected commit failure/);

    assert.deepEqual(visible, [{ type: "text_delta", delta: "已经生成" }]);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("real SQLite writes no partial turn when a second store advances revision before commit", async () => {
  const existing = storedTurn(1, [
    { role: "user", content: "已有问题" },
    { role: "assistant", content: "已有回答", toolCalls: [] },
  ]);
  await withRealHistorySession(
    [existing],
    async ({ databasePath, store, session }) => {
      const before = readHistoryCounts(databasePath);
      const current = session.getCurrent();
      const secondStore = createHistoryStore(databasePath);
      try {
        const gateway = createFakeGateway([() => {
          secondStore.updateSessionModel(
            current.id!,
            current.revision!,
            deepSeekModel.providerId,
            deepSeekModel.id,
          );
          return { content: "并发后已生成", toolCalls: [] };
        }]);
        const conversation = createConversation(
          conversationOptions(gateway, { session }),
        );

        await assert.rejects(
          conversation.send("并发问题"),
          /回答已生成，但历史保存失败，本轮未记录.*其他 Coffee 进程/,
        );

        assert.equal(store.loadSession(current.id!)?.revision, 2);
        assert.deepEqual(readHistoryCounts(databasePath), before);
      } finally {
        secondStore.close();
      }
    },
  );
});

test("real SQLite writes no summary when a second store makes its revision stale", async () => {
  await withRealHistorySession(
    compressionTurns(),
    async ({ databasePath, store, session }) => {
      const before = readHistoryCounts(databasePath);
      const current = session.getCurrent();
      const secondStore = createHistoryStore(databasePath);
      try {
        const gateway = createFakeGateway([() => {
          secondStore.updateSessionModel(
            current.id!,
            current.revision!,
            deepSeekModel.providerId,
            deepSeekModel.id,
          );
          return { content: "不应保存的摘要", toolCalls: [] };
        }]);
        const conversation = createConversation(conversationOptions(gateway, {
          session,
          historyPreferences: COMPRESSION_PREFERENCES,
        }));

        await assert.rejects(conversation.send("新问题"), /其他 Coffee 进程/);

        assert.equal(gateway.requests.length, 1);
        assert.equal(store.loadSession(current.id!)?.summary, undefined);
        assert.deepEqual(readHistoryCounts(databasePath), before);
      } finally {
        secondStore.close();
      }
    },
  );
});

test("real SQLite stays unchanged when the current user message exceeds the hard cap", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const gateway = createFakeGateway();
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      historyPreferences: {
        compressionThresholdChars: 1_000,
        maxContextChars: 2_000,
        summaryTargetChars: 100,
      },
    }));

    await assert.rejects(
      conversation.send("超长用户消息".repeat(500)),
      /当前回合超过上下文上限/,
    );

    assert.equal(gateway.requests.length, 0);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("real SQLite stays unchanged when current tool output exceeds the hard cap", async () => {
  await withRealHistorySession([], async ({ databasePath, session }) => {
    const before = readHistoryCounts(databasePath);
    const gateway = createFakeGateway([() => ({
      toolCalls: [{
        id: "call-large-search",
        name: "web_search",
        argumentsJson: '{"query":"coffee"}',
      }],
    })]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      fetchImpl: async () => jsonResponse({
        results: [{
          title: "large result",
          url: "https://example.com/large",
          content: "x".repeat(5_000),
        }],
      }),
      historyPreferences: {
        compressionThresholdChars: 1_000,
        maxContextChars: 2_000,
        summaryTargetChars: 100,
      },
    }));

    await assert.rejects(
      conversation.send("搜索"),
      /当前回合超过上下文上限/,
    );

    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(readHistoryCounts(databasePath), before);
  });
});

test("successful rolling summary keeps raw turns and excludes reasoning, secrets, and API keys", async () => {
  const originalTurns = [1, 2, 3].map((sequence) => storedTurn(sequence, [
    {
      role: "user",
      content:
        `history-${sequence}-`.repeat(80) +
        (sequence === 1 ? " sk-test-secret" : ""),
    },
    {
      role: "assistant",
      content: `history-reply-${sequence}-`.repeat(60),
      toolCalls: [],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: sequence === 1 ? "private reasoning" : `reasoning-${sequence}`,
      },
    },
  ]));
  const summaryOutput = JSON.stringify({
    ordinary: "keep stored preference",
    note:
      "Bearer bearer-stored-secret sk-stored-secret tvly-stored-secret",
    nested: {
      token: "token-stored-secret",
      api_key: "api-key-stored-secret",
      auth: "auth-stored-secret",
      secret: "generic-stored-secret",
    },
  });

  await withRealHistorySession(
    originalTurns,
    async ({ databasePath, store, session }) => {
      const sessionId = session.getCurrent().id!;
      let duringMainRequestTurnCount = -1;
      let throughTurnSequence = -1;
      const gateway = createFakeGateway([
        reply(summaryOutput),
        () => {
          const duringMainRequest = store.loadSession(sessionId)!;
          duringMainRequestTurnCount = duringMainRequest.turns.length;
          throughTurnSequence =
            duringMainRequest.summary?.throughTurnSequence ?? -1;
          return { content: "最终回答", toolCalls: [] };
        },
      ]);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        resolveApiKey: createResolver({ deepseek: "api-key-value" }),
        historyPreferences: COMPRESSION_PREFERENCES,
      }));

      assert.equal(await conversation.send("新问题"), "最终回答");

      assert.equal(duringMainRequestTurnCount, originalTurns.length);
      assert.equal(throughTurnSequence, 3);
      const summaryRequest = gateway.requests[0];
      assert.equal(
        JSON.stringify(summaryRequest?.messages).includes("private reasoning"),
        false,
      );
      assert.equal(
        JSON.stringify(summaryRequest?.messages).includes("sk-test-secret"),
        false,
      );

      const stored = store.loadSession(sessionId)!;
      assert.equal(stored.turns.length, originalTurns.length + 1);
      assert.equal(stored.summary?.throughTurnSequence, 3);
      assert.match(stored.summary?.content ?? "", /keep stored preference/);
      assert.match(stored.summary?.content ?? "", /\[REDACTED\]/);
      for (const secret of [
        "bearer-stored-secret",
        "sk-stored-secret",
        "tvly-stored-secret",
        "token-stored-secret",
        "api-key-stored-secret",
        "auth-stored-secret",
        "generic-stored-secret",
      ]) {
        assert.equal(
          stored.summary?.content.includes(secret),
          false,
          `stored summary leaked secret: ${secret}`,
        );
      }
      assert.deepEqual(
        stored.turns.slice(0, originalTurns.length).map((turn) => turn.messages),
        originalTurns.map((turn) => turn.messages),
      );
      assert.equal(JSON.stringify(stored).includes("api-key-value"), false);
      assert.deepEqual(readHistoryCounts(databasePath), {
        sessions: 1,
        turns: 4,
        messages: 8,
        summaries: 1,
      });
    },
  );
});

test("generateSummary uses a hidden tool-free request and rejects invalid final replies", async () => {
  const signal = new AbortController().signal;
  const gateway = createFakeGateway([reply("  有效摘要  ")]);

  assert.equal(await generateSummary({
    gateway,
    model: deepSeekModel,
    apiKey: "summary-key",
    source: "source text",
    targetChars: 321,
    signal,
  }), "有效摘要");
  assert.deepEqual(gateway.requests[0]?.model, deepSeekModel);
  assert.equal(gateway.requests[0]?.apiKey, "summary-key");
  assert.equal(gateway.requests[0]?.signal, signal);
  assert.deepEqual(gateway.requests[0]?.tools, []);
  assert.match(gateway.requests[0]?.messages[0]?.content ?? "", /压缩较早的对话/);
  assert.match(gateway.requests[0]?.messages[1]?.content ?? "", /321.*source text/s);

  const toolGateway = createFakeGateway([() => ({
    content: "不应接受",
    toolCalls: [{
      id: "call-1",
      name: "calculator",
      argumentsJson: "{}",
    }],
  })]);
  await assert.rejects(generateSummary({
    gateway: toolGateway,
    model: deepSeekModel,
    apiKey: "key",
    source: "source",
    targetChars: 10,
  }), /工具调用/);

  const emptyGateway = createFakeGateway([() => ({
    content: "   ",
    toolCalls: [],
  })]);
  await assert.rejects(generateSummary({
    gateway: emptyGateway,
    model: deepSeekModel,
    apiKey: "key",
    source: "source",
    targetChars: 10,
  }), /有效正文/);
});

test("generateSummary redacts model-produced credentials while preserving ordinary facts", async () => {
  const summaryOutput = JSON.stringify({
    ordinary: "keep this preference",
    note:
      "Bearer bearer-output-secret sk-output-secret tvly-output-secret",
    nested: {
      token: "token-output-secret",
      api_key: "api-key-output-secret",
      auth: "auth-output-secret",
      secret: "generic-output-secret",
    },
  });
  const gateway = createFakeGateway([reply(summaryOutput)]);

  const generated = await generateSummary({
    gateway,
    model: deepSeekModel,
    apiKey: "key",
    source: "source",
    targetChars: 100,
  });

  assert.match(generated, /keep this preference/);
  assert.match(generated, /\[REDACTED\]/);
  for (const secret of [
    "bearer-output-secret",
    "sk-output-secret",
    "tvly-output-secret",
    "token-output-secret",
    "api-key-output-secret",
    "auth-output-secret",
    "generic-output-secret",
  ]) {
    assert.equal(generated.includes(secret), false, `leaked secret: ${secret}`);
  }
});

test("summary runs first, excludes reasoning, persists before the completed turn, and prefixes main context", async () => {
  const operations: string[] = [];
  const session = createFakeSession({
    turns: compressionTurns(),
    onSaveSummary() {
      operations.push("save");
    },
    onCommit() {
      operations.push("commit");
    },
  });
  const gateway = createFakeGateway([reply("较早对话摘要"), reply("最终回答")]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));

  const events = await collectConversationEvents(conversation.stream("新问题"));

  assert.deepEqual(events[0], {
    type: "status",
    text: "正在整理较早的对话…",
  });
  assert.deepEqual(gateway.requests[0]?.tools, []);
  assert.equal(
    JSON.stringify(gateway.requests[0]?.messages).includes(
      "SUMMARY_REASONING_SECRET",
    ),
    false,
  );
  assert.deepEqual(gateway.requests[0]?.model, deepSeekModel);
  assert.equal(gateway.requests[0]?.apiKey, "deepseek-key");
  assert.match(
    gateway.requests[1]?.messages[1]?.content ?? "",
    new RegExp(`^${SUMMARY_PREFIX}`),
  );
  assert.deepEqual(operations, ["save", "commit"]);
  assert.deepEqual(session.commits[0]?.slice(-2), [
    { role: "user", content: "新问题" },
    { role: "assistant", content: "最终回答", toolCalls: [] },
  ]);
});

test("summary model failure silently falls back to recent complete turns", async () => {
  const summaryError = new Error("summary provider failed");
  const turns = compressionTurns();
  const session = createFakeSession({ turns });
  const gateway = createFakeGateway([
    () => {
      throw summaryError;
    },
    reply("fallback answer"),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));

  const events = await collectConversationEvents(conversation.stream("新问题"));

  assert.equal(events.some((event) =>
    "text" in event && event.text.includes(summaryError.message)), false);
  assert.deepEqual(events.at(-1), { type: "done", content: "fallback answer" });
  const mainMessages = JSON.stringify(gateway.requests[1]?.messages);
  assert.equal(mainMessages.includes("old-1-"), false);
  assert.equal(mainMessages.includes("old-3-"), true);
  assert.equal(session.savedSummaries.length, 0);
});

test("deep malicious JSON summary is not saved and falls back to unsummarized history", async () => {
  const turns = [1, 2].map((sequence) => storedTurn(sequence, [
    { role: "user", content: `large-user-${sequence}-` + "u".repeat(100_000) },
    {
      role: "assistant",
      content: `large-assistant-${sequence}-` + "a".repeat(100_000),
      toolCalls: [],
    },
  ]));
  const secret = "sk-deep-generated-summary-secret-4187";
  const depth = 8_000;
  const maliciousSummary =
    `${'{"nested":'.repeat(depth)}{"token":"${secret}"}${"}".repeat(depth)}`;
  const session = createFakeSession({ turns });
  const gateway = createFakeGateway([
    reply(maliciousSummary),
    reply("fallback answer"),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: {
      summaryTargetChars: 100,
      compressionThresholdChars: 180_000,
      maxContextChars: 600_000,
    },
  }));

  assert.equal(await conversation.send("新问题"), "fallback answer");

  assert.equal(gateway.requests.length, 2);
  assert.equal(session.savedSummaries.length, 0);
  assert.equal(
    JSON.stringify(gateway.requests[1]?.messages).includes(secret),
    false,
  );
  assert.equal(
    JSON.stringify(gateway.requests[1]?.messages).includes("large-user-1"),
    true,
  );
});

test("over-escaped summary is not persisted and cannot poison later real-session requests", async () => {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSessionManager({
        store,
        defaultModel: deepSeekModel,
        getModel(providerId, modelId) {
          if (
            providerId === deepSeekModel.providerId &&
            modelId === deepSeekModel.id
          ) {
            return deepSeekModel;
          }
          if (
            providerId === openCodeModel.providerId &&
            modelId === openCodeModel.id
          ) {
            return openCodeModel;
          }
          return undefined;
        },
      });
      for (const turn of compressionTurns()) {
        session.commitTurn(turn.messages);
      }
      const escapedSummary = '"\n'.repeat(700);
      assert.ok(
        escapedSummary.length < COMPRESSION_PREFERENCES.compressionThresholdChars,
      );
      const gateway = createFakeGateway([
        reply(escapedSummary),
        reply("第一次回答"),
        reply(escapedSummary),
        reply("第二次回答"),
      ]);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        historyPreferences: COMPRESSION_PREFERENCES,
      }));

      assert.equal(await conversation.send("第一次问题"), "第一次回答");
      assert.equal(session.getCurrent().summary, undefined);
      assert.equal(await conversation.send("第二次问题"), "第二次回答");
      assert.equal(session.getCurrent().summary, undefined);

      assert.equal(gateway.requests.length, 4);
      assert.equal(
        JSON.stringify(gateway.requests[1]?.messages).includes(SUMMARY_PREFIX),
        false,
      );
      assert.equal(
        JSON.stringify(gateway.requests[3]?.messages).includes(escapedSummary),
        false,
      );
    } finally {
      store.close();
    }
  });
});

test("real session switch during summary generation cannot save or continue in another session", async () => {
  await withRealSessionPair(async ({
    store,
    session,
    sessionAId,
    sessionBId,
    sessionABefore,
    sessionBBefore,
  }) => {
    const gateway = createFakeGateway([
      () => {
        session.switchSession(sessionBId);
        return { content: "不应保存的摘要", toolCalls: [] };
      },
      reply("不应发送主请求"),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      historyPreferences: COMPRESSION_PREFERENCES,
    }));
    const events: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("A 的新问题")) {
        events.push(event);
      }
    }, /历史会话.*变化/);

    assert.deepEqual(events, [{
      type: "status",
      text: "正在整理较早的对话…",
    }]);
    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(store.loadSession(sessionAId), sessionABefore);
    assert.deepEqual(store.loadSession(sessionBId), sessionBBefore);
  });
});

test("real session switch while resolving credentials starts no provider request", async () => {
  await withRealSessionPair(async ({
    store,
    session,
    sessionAId,
    sessionBId,
    sessionABefore,
    sessionBBefore,
  }) => {
    const gateway = createFakeGateway();
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      resolveApiKey: async () => {
        session.switchSession(sessionBId);
        return "deepseek-key";
      },
    }));

    await assert.rejects(conversation.send("A 的问题"), /历史会话.*变化/);

    assert.equal(gateway.requests.length, 0);
    assert.deepEqual(store.loadSession(sessionAId), sessionABefore);
    assert.deepEqual(store.loadSession(sessionBId), sessionBBefore);
  });
});

test("summary abort starts no main request and writes no summary or turn", async () => {
  const abort = new Error("summary aborted");
  abort.name = "AbortError";
  const session = createFakeSession({ turns: compressionTurns() });
  const gateway = createFakeGateway([() => {
    throw abort;
  }]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));

  await assert.rejects(conversation.send("新问题"), (error) => error === abort);

  assert.equal(gateway.requests.length, 1);
  assert.equal(session.savedSummaries.length, 0);
  assert.equal(session.commits.length, 0);
});

test("summary abort after done is observed before summary persistence", async () => {
  const controller = new AbortController();
  const session = createFakeSession({ turns: compressionTurns() });
  const summaryReply: ModelReply = { content: "摘要", toolCalls: [] };
  const gateway = createStreamingGateway([
    () => (async function* () {
      yield { type: "start" } as const;
      yield { type: "done", reply: summaryReply } as const;
      controller.abort();
    })(),
    () => replyEvents({ content: "不应发送", toolCalls: [] }),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));
  const events: ConversationEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of conversation.stream("新问题", controller.signal)) {
      events.push(event);
    }
  }, (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.deepEqual(events, [{
    type: "status",
    text: "正在整理较早的对话…",
  }]);
  assert.equal(gateway.requests.length, 1);
  assert.equal(session.savedSummaries.length, 0);
  assert.equal(session.commits.length, 0);
});

test("abort after summary persistence starts no main provider round", async () => {
  const controller = new AbortController();
  const session = createFakeSession({
    turns: compressionTurns(),
    onSaveSummary() {
      controller.abort();
    },
  });
  const gateway = createFakeGateway([reply("摘要"), reply("不应发送")]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));

  await assert.rejects(
    conversation.send("新问题", controller.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  assert.equal(gateway.requests.length, 1);
  assert.equal(session.savedSummaries.length, 1);
  assert.equal(session.commits.length, 0);
});

test("summary persistence conflict propagates before the main request and turn commit", async () => {
  const conflict = new Error("stale revision");
  const session = createFakeSession({
    turns: compressionTurns(),
    onSaveSummary() {
      throw conflict;
    },
  });
  const gateway = createFakeGateway([reply("摘要")]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    historyPreferences: COMPRESSION_PREFERENCES,
  }));

  await assert.rejects(conversation.send("新问题"), (error) => error === conflict);
  assert.equal(gateway.requests.length, 1);
  assert.equal(session.commits.length, 0);
});

test("history context is rebuilt from a fresh session snapshot for every provider tool round", async () => {
  const initial = storedTurn(1, [
    { role: "user", content: "initial history" },
    { role: "assistant", content: "initial answer", toolCalls: [] },
  ]);
  const refreshed = storedTurn(2, [
    { role: "user", content: "fresh external history" },
    { role: "assistant", content: "fresh external answer", toolCalls: [] },
  ]);
  const session = createFakeSession({
    turns: [initial],
    onGetCurrent(call, current) {
      return call >= 8
        ? { ...current, turns: [initial, refreshed] }
        : current;
    },
  });
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "calculator",
        argumentsJson: '{"expression":"1+1"}',
      }],
    }),
    reply("完成"),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );

  assert.equal(await conversation.send("计算"), "完成");

  assert.ok(session.getCurrentCalls >= 8);
  assert.equal(
    JSON.stringify(gateway.requests[0]?.messages).includes("fresh external history"),
    false,
  );
  assert.equal(
    JSON.stringify(gateway.requests[1]?.messages).includes("fresh external history"),
    true,
  );
  assert.deepEqual(gateway.requests[1]?.messages.slice(-2), [
    {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "calculator",
        argumentsJson: '{"expression":"1+1"}',
      }],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ ok: true, expression: "1+1", result: 2 }),
    },
  ]);
});

test("abort between tool rounds starts no next provider request", async () => {
  const controller = new AbortController();
  const session = createFakeSession();
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "calculator",
        argumentsJson: '{"expression":"1+1"}',
      }],
    }),
    reply("不应发送"),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );

  await assert.rejects(async () => {
    for await (const event of conversation.stream("计算", controller.signal)) {
      if (
        event.type === "status" &&
        event.text === "正在整理工具结果…"
      ) {
        controller.abort();
      }
    }
  }, (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.equal(gateway.requests.length, 1);
  assert.equal(session.commits.length, 0);
});

test("abort after final provider done preserves visible text without commit or Conversation done", async () => {
  const controller = new AbortController();
  const session = createFakeSession();
  const finalReply: ModelReply = { content: "已经显示", toolCalls: [] };
  const gateway = createStreamingGateway([
    () => (async function* () {
      yield { type: "start" } as const;
      yield { type: "text_delta", delta: "已经显示" } as const;
      yield { type: "done", reply: finalReply } as const;
      controller.abort();
    })(),
  ]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );
  const events: ConversationEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of conversation.stream("问题", controller.signal)) {
      events.push(event);
    }
  }, (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.deepEqual(events, [{ type: "text_delta", delta: "已经显示" }]);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(session.commits.length, 0);
});

test("abort after tool-call provider done starts no tool execution or later round", async () => {
  const controller = new AbortController();
  const session = createFakeSession();
  let fetchCalls = 0;
  const toolReply: ModelReply = {
    content: "",
    toolCalls: [{
      id: "call-search",
      name: "web_search",
      argumentsJson: '{"query":"coffee"}',
    }],
  };
  const gateway = createStreamingGateway([
    () => (async function* () {
      yield { type: "start" } as const;
      yield { type: "done", reply: toolReply } as const;
      controller.abort();
    })(),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({ results: [] });
    },
  }));
  const events: ConversationEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of conversation.stream("搜索", controller.signal)) {
      events.push(event);
    }
  }, (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.deepEqual(events, []);
  assert.equal(fetchCalls, 0);
  assert.equal(gateway.requests.length, 1);
  assert.equal(session.commits.length, 0);
});

test("abort when tool execution returns records no result or continuation status", async () => {
  const controller = new AbortController();
  const session = createFakeSession();
  let fetchCalls = 0;
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{
        id: "call-search",
        name: "web_search",
        argumentsJson: '{"query":"coffee"}',
      }],
    }),
  ]);
  const conversation = createConversation(conversationOptions(gateway, {
    session,
    fetchImpl: async () => {
      fetchCalls += 1;
      controller.abort();
      return jsonResponse({ results: [] });
    },
  }));
  const events: ConversationEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of conversation.stream("搜索", controller.signal)) {
      events.push(event);
    }
  }, (error: unknown) => error instanceof Error && error.name === "AbortError");

  assert.equal(fetchCalls, 1);
  assert.deepEqual(events, [
    { type: "status", text: "正在准备调用工具…" },
    {
      type: "tool_activity",
      event: { name: "web_search", phase: "start" },
    },
  ]);
  assert.equal(gateway.requests.length, 1);
  assert.equal(session.commits.length, 0);
});

test("external session model change rejects commit and Conversation done", async () => {
  const session = createFakeSession();
  const gateway = createFakeGateway([() => {
    session.setModel(openCodeModel);
    return { content: "已经生成", toolCalls: [] };
  }]);
  const conversation = createConversation(
    conversationOptions(gateway, { session }),
  );
  const events: ConversationEvent[] = [];

  await assert.rejects(async () => {
    for await (const event of conversation.stream("问题")) {
      events.push(event);
    }
  }, /会话模型已在回答期间发生变化/);

  assert.deepEqual(events, [{ type: "text_delta", delta: "已经生成" }]);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.equal(session.commits.length, 0);
});

test("real session switch during the main provider cannot commit into another session", async () => {
  await withRealSessionPair(async ({
    store,
    session,
    sessionAId,
    sessionBId,
    sessionABefore,
    sessionBBefore,
  }) => {
    const gateway = createFakeGateway([() => {
      session.switchSession(sessionBId);
      return { content: "已经显示", toolCalls: [] };
    }]);
    const conversation = createConversation(
      conversationOptions(gateway, { session }),
    );
    const events: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("A 的问题")) {
        events.push(event);
      }
    }, /历史会话.*变化/);

    assert.deepEqual(events, [{ type: "text_delta", delta: "已经显示" }]);
    assert.equal(events.some((event) => event.type === "done"), false);
    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(store.loadSession(sessionAId), sessionABefore);
    assert.deepEqual(store.loadSession(sessionBId), sessionBBefore);
  });
});

const AGENT_PLAN_STEPS = [
  {
    id: "inspect",
    title: "检查项目",
    successCriteria: "Shell 成功返回工作区且 exitCode 为 0",
    dependsOn: [],
  },
  {
    id: "verify",
    title: "运行验证",
    successCriteria: "Shell 验证命令 exitCode 为 0",
    dependsOn: ["inspect"],
  },
] as const;

function planningToolCall(
  id: string,
  name: "create_plan" | "update_plan" | "finish_plan",
  args: Record<string, unknown>,
) {
  return {
    id,
    name,
    argumentsJson: JSON.stringify(args),
  };
}

function ordinaryToolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
) {
  return {
    id,
    name,
    argumentsJson: JSON.stringify(args),
  };
}

function currentRoundToolResults(request: ModelRequest): PersistedMessage[] {
  const userIndex = request.messages.findLastIndex(
    (message) => message.role === "user",
  );
  return request.messages.slice(userIndex + 1).filter(
    (message): message is Extract<PersistedMessage, { role: "tool" }> =>
      message.role === "tool",
  );
}

function parsedToolResult(
  request: ModelRequest,
  toolCallId: string,
): Record<string, unknown> {
  const message = currentRoundToolResults(request).find(
    (candidate) =>
      candidate.role === "tool" && candidate.toolCallId === toolCallId,
  );
  assert.ok(message && message.role === "tool", toolCallId);
  return JSON.parse(message.content) as Record<string, unknown>;
}

function progressSequence(events: readonly ConversationEvent[]): string[] {
  return events.flatMap((event) => {
    if (
      event.type === "status" &&
      (event.text === "正在准备调用工具…" ||
        event.text === "正在整理工具结果…")
    ) {
      return [`status:${event.text}`];
    }
    if (event.type === "tool_activity") {
      return [`tool:${event.event.name}:${event.event.phase}`];
    }
    if (event.type === "plan_activity") {
      return [`plan:${event.plan.revision}`];
    }
    return [];
  });
}

function deterministicPlanning(
  store: ReturnType<typeof createHistoryStore>,
  session: ReturnType<typeof createSessionManager>,
): PlanManager {
  let timestamp = 0;
  return createPlanManager({
    store: store.plans,
    session,
    idFactory: () => "agent-plan",
    now: () =>
      `2026-07-27T08:00:${String(timestamp++).padStart(2, "0")}.000Z`,
  });
}

async function withRealPlanningSession(
  run: (value: {
    databasePath: string;
    store: ReturnType<typeof createHistoryStore>;
    session: ReturnType<typeof createSessionManager>;
    planning: PlanManager;
  }) => Promise<void>,
): Promise<void> {
  await withHistoryPath(async (databasePath) => {
    const store = createHistoryStore(databasePath);
    try {
      const session = createSessionManager({
        store,
        defaultModel: deepSeekModel,
        getModel(providerId, modelId) {
          return providerId === deepSeekModel.providerId &&
              modelId === deepSeekModel.id
            ? deepSeekModel
            : undefined;
        },
      });
      await run({
        databasePath,
        store,
        session,
        planning: deterministicPlanning(store, session),
      });
    } finally {
      store.close();
    }
  });
}

function planSnapshot(
  sessionId: string,
  overrides: Partial<TaskPlan> = {},
): TaskPlan {
  return {
    id: "stub-plan",
    sessionId,
    goal: "完成任务",
    status: "active",
    revision: 1,
    steps: AGENT_PLAN_STEPS.map((step) => ({
      ...step,
      status: "pending" as const,
      retryCount: 0,
    })),
    createdAt: "2026-07-27T08:00:00.000Z",
    updatedAt: "2026-07-27T08:00:00.000Z",
    ...overrides,
  };
}

function stubPlanning(
  overrides: Partial<PlanManager> = {},
): PlanManager {
  const unavailable = (): never => {
    throw new Error("stub planning operation unavailable");
  };
  return {
    getCurrentPlan: () => undefined,
    createPlan: unavailable,
    updatePlan: unavailable,
    finishPlan: unavailable,
    cancelCurrent: () => undefined,
    ...overrides,
  };
}

const allowingToolInteraction: ToolInteraction & ShellInteraction = {
  async authorizeProtected() {
    return true;
  },
  async confirmMutation() {
    return true;
  },
  async requestSecret() {
    return undefined;
  },
  async confirmShell() {
    return true;
  },
};

test("planning adds the complete planning contract without changing the non-planning prompt or tools", async () => {
  const plainGateway = createFakeGateway([reply("普通回答")]);
  const plannedGateway = createFakeGateway([reply("计划回答")]);
  await createConversation(conversationOptions(plainGateway, {
    workspaceRoot: "/Users/test/project",
  })).send("普通问题");
  await createConversation(conversationOptions(plannedGateway, {
    workspaceRoot: "/Users/test/project",
    planning: stubPlanning(),
  })).send("复杂问题");

  const plain = plainGateway.requests[0]!;
  const planned = plannedGateway.requests[0]!;
  const plainPrompt = plain.messages[0]?.content ?? "";
  const plannedPrompt = planned.messages[0]?.content ?? "";
  assert.equal(
    plannedPrompt.startsWith(plainPrompt + "\n\n"),
    true,
  );
  assert.deepEqual(
    planned.tools.slice(0, plain.tools.length),
    plain.tools,
  );
  assert.deepEqual(
    plain.tools.map((tool) => tool.name),
    plain.tools.map((tool) => tool.name).filter(
      (name) => !["create_plan", "update_plan", "finish_plan"].includes(name),
    ),
  );
  assert.deepEqual(
    planned.tools.slice(-3).map((tool) => tool.name),
    ["create_plan", "update_plan", "finish_plan"],
  );
  assert.doesNotMatch(plainPrompt, /复杂任务.*create_plan/s);
  assert.match(
    plannedPrompt,
    /多文件、多个不同工具、修改后需测试或类型检查、明显步骤依赖、调研、比较、实现和验证的组合都属于复杂任务，必须先调用 create_plan，再写文件或执行 Shell。/,
  );
  assert.match(
    plannedPrompt,
    /简单问答、翻译、单次读取和单步计算不要创建计划。/,
  );
  assert.match(
    plannedPrompt,
    /每步执行前调用 update_plan 的 start_step。/,
  );
  assert.match(
    plannedPrompt,
    /已有 active 或 blocked 计划时.*计划 ID.*revision.*继续.*不要重复调用 create_plan/s,
  );
  assert.match(
    plannedPrompt,
    /同一批工具调用.*start_step.*普通执行工具之前/s,
  );
  assert.match(
    plannedPrompt,
    /只有 successCriteria 已满足，并且有真实工具成功或 Shell exitCode 为 0 的证据，才能调用 complete_step。/,
  );
  assert.match(
    plannedPrompt,
    /工具失败必须调用 fail_step、block_step 或 replace_pending_steps，不可跳过。/,
  );
  assert.match(
    plannedPrompt,
    /普通工具失败后.*不能.*complete_step.*finish_plan/s,
  );
  assert.match(
    plannedPrompt,
    /关键歧义先调用 block_step，再向用户询问一个明确问题；下一轮收到用户回答后先调用 resume_step。/,
  );
  assert.match(plannedPrompt, /全部问题解决后调用 finish_plan。/);
  assert.match(
    plannedPrompt,
    /不要暴露隐藏推理，只展示可验证的计划状态。/,
  );
  assert.match(plannedPrompt, /当前工作区/);
  assert.match(plannedPrompt, /read、ls、find、grep、edit、write、set_env、shell/);
});

test("planning prompt works without a workspace and simple answers create no plan or plan event", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    const gateway = createFakeGateway([reply("42")]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    const events = await collectConversationEvents(
      conversation.stream("把 6 乘以 7"),
    );

    assert.equal(gateway.requests[0]?.tools.some(
      (tool) => tool.name === "create_plan",
    ), true);
    assert.match(
      gateway.requests[0]?.messages[0]?.content ?? "",
      /复杂任务.*create_plan/s,
    );
    assert.equal(events.some((event) => event.type === "plan_activity"), false);
    assert.equal(planning.getCurrentPlan(), undefined);
    assert.equal(session.getCurrent().turns.length, 1);
  });
});

test("ordinary tool progress finishes only after a later planning call in the same reply", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "先计算再更新计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          ordinaryToolCall("calculate", "calculator", {
            expression: "6*7",
          }),
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "calculate").ok, false);
        assert.match(
          String(parsedToolResult(request, "calculate").error),
          /start_step/,
        );
        assert.equal(
          (parsedToolResult(request, "start").plan as TaskPlan).revision,
          2,
        );
        return { content: "继续执行", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    const events = await collectConversationEvents(
      conversation.stream("完成这个混合工具任务"),
    );

    assert.deepEqual(progressSequence(events), [
      "plan:1",
      "status:正在准备调用工具…",
      "tool:calculator:start",
      "tool:calculator:error",
      "plan:2",
      "status:正在整理工具结果…",
    ]);
  });
});

test("an ordinary tool after start_step executes inside a planning batch", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "开始后执行计算",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("calculate", "calculator", {
            expression: "6*7",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "calculate").result, 42);
        return { content: "已在步骤开始后执行", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(
      await conversation.send("按计划计算"),
      "已在步骤开始后执行",
    );
  });
});

test("complete_step without prior-round ordinary success evidence is rejected", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "无工具证据不得完成",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [planningToolCall("start", "update_plan", {
          planId: "agent-plan",
          expectedRevision: 1,
          action: "start_step",
          stepId: "inspect",
        })],
      }),
      () => ({
        content: "",
        toolCalls: [planningToolCall("forged-complete", "update_plan", {
          planId: "agent-plan",
          expectedRevision: 2,
          action: "complete_step",
          stepId: "inspect",
          result: "伪造成功",
        })],
      }),
      (request) => {
        const rejected = parsedToolResult(request, "forged-complete");
        assert.equal(rejected.ok, false);
        assert.match(String(rejected.error), /前一轮.*工具成功|成功证据/);
        return { content: "未接受伪造完成", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("直接完成"), "未接受伪造完成");
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.steps[0]?.status, "in_progress");
  });
});

test("complete_step cannot consume ordinary success from the same provider round", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "成功结果必须先返回模型",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("calculate", "calculator", {
            expression: "6*7",
          }),
          planningToolCall("same-round-complete", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "complete_step",
            stepId: "inspect",
            result: "同批成功不算前轮证据",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "calculate").ok, true);
        const rejected = parsedToolResult(request, "same-round-complete");
        assert.equal(rejected.ok, false);
        assert.match(String(rejected.error), /前一轮.*工具成功|成功证据/);
        return { content: "等待下一轮再完成", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("同轮完成"), "等待下一轮再完成");
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.steps[0]?.status, "in_progress");
  });
});

test("a later ordinary failure invalidates prior-round success evidence for the same step", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "后续失败必须使旧成功证据失效",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("success-evidence", "calculator", {
            expression: "6*7",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "success-evidence").ok, true);
        return {
          content: "",
          toolCalls: [ordinaryToolCall(
            "later-failure",
            "calculator",
            { wrong: "field" },
          )],
        };
      },
      (request) => {
        assert.equal(parsedToolResult(request, "later-failure").ok, false);
        return {
          content: "",
          toolCalls: [planningToolCall(
            "complete-after-failure",
            "update_plan",
            {
              planId: "agent-plan",
              expectedRevision: 2,
              action: "complete_step",
              stepId: "inspect",
              result: "不得使用旧成功证据",
            },
          )],
        };
      },
      (request) => {
        const rejected = parsedToolResult(request, "complete-after-failure");
        assert.equal(rejected.ok, false);
        assert.match(
          String(rejected.error),
          /前一轮.*工具成功|成功证据|fail_step.*block_step|禁止 complete_step/,
        );
        return { content: "旧证据已失效", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    await assert.rejects(
      conversation.send("先成功再失败"),
      /fail_step.*block_step.*禁止结束/,
    );
    assert.equal(session.getCurrent().turns.length, 0);
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.steps[0]?.status, "in_progress");
  });
});

test("an unresolved ordinary failure rejects a later final response without commit or done", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "失败必须先记录再结束",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("success-before-failure", "calculator", {
            expression: "6*7",
          }),
        ],
      }),
      () => ({
        content: "",
        toolCalls: [ordinaryToolCall("unresolved-failure", "calculator", {
          wrong: "field",
        })],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "unresolved-failure").ok, false);
        return { content: "错误地直接结束", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));
    const events: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("先成功再失败并结束")) {
        events.push(event);
      }
    }, /普通工具失败.*fail_step.*block_step|fail_step.*block_step.*禁止结束/);

    assert.equal(events.some((event) => event.type === "done"), false);
    assert.equal(session.getCurrent().turns.length, 0);
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.status, "active");
    assert.equal(stored?.steps[0]?.status, "in_progress");
    assert.notEqual(stored?.status, "completed");
  });
});

test("a plan completed externally during the next provider request rejects its stale final response", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    let plan = planning.createPlan({
      goal: "provider 返回期间完成计划不得提交过期正文",
      steps: AGENT_PLAN_STEPS,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [ordinaryToolCall("ordinary-failure", "calculator", {
          wrong: "field",
        })],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "ordinary-failure").ok, false);
        plan = planning.updatePlan(plan.id, plan.revision, {
          type: "complete_step",
          stepId: "inspect",
          result: "外部完成检查",
        });
        plan = planning.updatePlan(plan.id, plan.revision, {
          type: "start_step",
          stepId: "verify",
        });
        plan = planning.updatePlan(plan.id, plan.revision, {
          type: "complete_step",
          stepId: "verify",
          result: "外部完成验证",
        });
        plan = planning.finishPlan(plan.id, plan.revision, "外部完成计划");
        return { content: "基于旧计划生成的正文", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));
    const events: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("执行后生成正文")) {
        events.push(event);
      }
    }, /计划.*变化|冲突|过期/);

    assert.equal(events.some((event) => event.type === "done"), false);
    assert.equal(session.getCurrent().turns.length, 0);
    assert.equal(
      store.plans.loadForSession(session.getCurrent().id!)?.status,
      "completed",
    );
  });
});

test("an unresolved ordinary failure blocks later ordinary execution until matching block_step", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "失败未记录前不得继续执行",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("initial-failure", "calculator", {
            wrong: "field",
          }),
        ],
      }),
      () => ({
        content: "",
        toolCalls: [ordinaryToolCall("forbidden-ordinary", "calculator", {
          expression: "6*7",
        })],
      }),
      (request) => {
        const blocked = parsedToolResult(request, "forbidden-ordinary");
        assert.equal(blocked.ok, false);
        assert.equal(Object.hasOwn(blocked, "result"), false);
        assert.match(String(blocked.error), /fail_step|block_step|尚未记录/);
        return {
          content: "",
          toolCalls: [planningToolCall("resolve-block", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "block_step",
            stepId: "inspect",
            reason: "记录 calculator 失败",
          })],
        };
      },
      (request) => {
        assert.equal(parsedToolResult(request, "resolve-block").ok, true);
        return { content: "失败已阻塞记录", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(
      await conversation.send("失败后尝试继续"),
      "失败已阻塞记录",
    );
    assert.equal(session.getCurrent().turns.length, 1);
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.status, "blocked");
    assert.equal(stored?.steps[0]?.status, "blocked");
  });
});

test("matching fail_step resolves an ordinary failure obligation and permits final commit", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "fail_step 记录失败后可结束",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("failure", "calculator", { wrong: "field" }),
        ],
      }),
      () => ({
        content: "",
        toolCalls: [planningToolCall("resolve-fail", "update_plan", {
          planId: "agent-plan",
          expectedRevision: 2,
          action: "fail_step",
          stepId: "inspect",
          result: "calculator 参数无效",
        })],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "resolve-fail").ok, true);
        return { content: "失败已记录", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("失败后记录"), "失败已记录");
    assert.equal(session.getCurrent().turns.length, 1);
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.status, "active");
    assert.equal(stored?.steps[0]?.status, "failed");
  });
});

test("ordinary success evidence for one step cannot complete a later step", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "证据严格绑定步骤",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start-inspect", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("inspect-evidence", "calculator", {
            expression: "6*7",
          }),
        ],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("complete-inspect", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "complete_step",
            stepId: "inspect",
            result: "检查步骤有真实证据",
          }),
          planningToolCall("start-verify", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 3,
            action: "start_step",
            stepId: "verify",
          }),
          planningToolCall("wrong-step-complete", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 4,
            action: "complete_step",
            stepId: "verify",
            result: "错误复用检查步骤证据",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "complete-inspect").ok, true);
        assert.equal(parsedToolResult(request, "start-verify").ok, true);
        const rejected = parsedToolResult(request, "wrong-step-complete");
        assert.equal(rejected.ok, false);
        assert.match(String(rejected.error), /前一轮.*工具成功|成功证据/);
        return { content: "不同步骤证据不可复用", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(
      await conversation.send("按步骤执行"),
      "不同步骤证据不可复用",
    );
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.revision, 4);
    assert.equal(stored?.steps[0]?.status, "completed");
    assert.equal(stored?.steps[1]?.status, "in_progress");
  });
});

test("complex planning completes two verified steps in five provider requests with plan-only progress events", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const sessionRevisionsDuringPlan: Array<number | undefined> = [];
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "检查并验证项目",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      (request) => {
        const created = parsedToolResult(request, "create");
        assert.equal(created.ok, true);
        assert.equal((created.plan as TaskPlan).revision, 1);
        sessionRevisionsDuringPlan.push(session.getCurrent().revision);
        return {
          content: "",
          toolCalls: [
            planningToolCall("start-inspect", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 1,
              action: "start_step",
              stepId: "inspect",
            }),
            ordinaryToolCall("shell-inspect", "shell", { command: "pwd" }),
          ],
        };
      },
      (request) => {
        assert.equal(
          (parsedToolResult(request, "start-inspect").plan as TaskPlan).revision,
          2,
        );
        const shellResult = parsedToolResult(request, "shell-inspect");
        assert.equal(shellResult.exitCode, 0);
        assert.match(String(shellResult.output), new RegExp(
          root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ));
        sessionRevisionsDuringPlan.push(session.getCurrent().revision);
        return {
          content: "",
          toolCalls: [
            planningToolCall("complete-inspect", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 2,
              action: "complete_step",
              stepId: "inspect",
              result: "pwd exitCode 0",
            }),
            planningToolCall("start-verify", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 3,
              action: "start_step",
              stepId: "verify",
            }),
            ordinaryToolCall("shell-verify", "shell", { command: "pwd" }),
          ],
        };
      },
      (request) => {
        assert.equal(
          (parsedToolResult(request, "complete-inspect").plan as TaskPlan)
            .revision,
          3,
        );
        assert.equal(
          (parsedToolResult(request, "start-verify").plan as TaskPlan).revision,
          4,
        );
        assert.equal(parsedToolResult(request, "shell-verify").exitCode, 0);
        sessionRevisionsDuringPlan.push(session.getCurrent().revision);
        return {
          content: "",
          toolCalls: [
            planningToolCall("complete-verify", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 4,
              action: "complete_step",
              stepId: "verify",
              result: "验证命令 exitCode 0",
            }),
            planningToolCall("finish", "finish_plan", {
              planId: "agent-plan",
              expectedRevision: 5,
              summary: "两个步骤均有 exitCode 0 证据",
            }),
          ],
        };
      },
      (request) => {
        assert.equal(
          (parsedToolResult(request, "complete-verify").plan as TaskPlan)
            .revision,
          5,
        );
        const finished = parsedToolResult(request, "finish").plan as TaskPlan;
        assert.equal(finished.revision, 6);
        assert.equal(finished.status, "completed");
        sessionRevisionsDuringPlan.push(session.getCurrent().revision);
        return { content: "检查和验证均已完成", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: allowingToolInteraction,
    }));

    const events = await collectConversationEvents(
      conversation.stream("检查这个项目并运行验证"),
    );

    assert.equal(gateway.requests.length, 5);
    const planEvents = events.filter(
      (event): event is Extract<ConversationEvent, { type: "plan_activity" }> =>
        event.type === "plan_activity",
    );
    assert.deepEqual(
      planEvents.map((event) => event.plan.revision),
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      planEvents.map((event) => event.plan.status),
      ["active", "active", "active", "active", "active", "completed"],
    );
    assert.deepEqual(
      progressSequence(events),
      [
        "plan:1",
        "plan:2",
        "status:正在准备调用工具…",
        "tool:shell:start",
        "tool:shell:success",
        "status:正在整理工具结果…",
        "plan:3",
        "plan:4",
        "status:正在准备调用工具…",
        "tool:shell:start",
        "tool:shell:success",
        "status:正在整理工具结果…",
        "plan:5",
        "plan:6",
      ],
    );
    assert.equal(
      events.some((event) =>
        event.type === "tool_activity" &&
        ["create_plan", "update_plan", "finish_plan"].includes(event.event.name)
      ),
      false,
    );
    assert.deepEqual(sessionRevisionsDuringPlan, [1, 1, 1, 1]);
    const current = session.getCurrent();
    assert.equal(current.revision, 2);
    assert.equal(current.turns.length, 1);
    const stored = store.plans.loadForSession(current.id!);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.revision, 6);
    assert.equal(events.at(-1)?.type, "done");
  });
});

test("a failed Shell result is followed by block_step rather than complete_step and persists blocked state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "运行验证并处理失败",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("shell-failure", "shell", {
            command: "node -e 'process.exit(7)'",
          }),
        ],
      }),
      (request) => {
        const shellResult = parsedToolResult(request, "shell-failure");
        assert.equal(shellResult.exitCode, 7);
        return {
          content: "",
          toolCalls: [planningToolCall("block", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "block_step",
            stepId: "inspect",
            reason: "Shell exitCode 7",
          })],
        };
      },
      reply("验证失败，计划已阻塞"),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: allowingToolInteraction,
    }));

    assert.equal(
      await conversation.send("运行验证，失败时记录状态"),
      "验证失败，计划已阻塞",
    );

    const allToolArguments = gateway.requests.flatMap((request) =>
      request.messages.flatMap((message) =>
        message.role === "assistant"
          ? message.toolCalls.map((call) => call.argumentsJson)
          : []
      )
    ).join("\n");
    assert.match(allToolArguments, /block_step/);
    assert.doesNotMatch(allToolArguments, /complete_step/);
    const current = session.getCurrent();
    const stored = store.plans.loadForSession(current.id!);
    assert.equal(stored?.status, "blocked");
    assert.equal(stored?.steps[0]?.status, "blocked");
    assert.equal(stored?.steps[0]?.blockReason, "Shell exitCode 7");
  });
});

test("lazy create_plan is the only allowed zero-turn session identity refresh", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    assert.equal(session.getCurrent().id, undefined);
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "建立计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      (request) => {
        const plan = parsedToolResult(request, "create").plan as TaskPlan;
        const current = session.getCurrent();
        assert.equal(current.id, plan.sessionId);
        assert.equal(current.revision, 1);
        assert.equal(current.turns.length, 0);
        assert.equal(current.providerId, deepSeekModel.providerId);
        assert.equal(current.modelId, deepSeekModel.id);
        return { content: "计划已建立", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("建立复杂任务计划"), "计划已建立");
    assert.equal(session.getCurrent().revision, 2);
  });
});

test("create_plan on an existing session and later plan revisions never change session revision", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    session.commitTurn([
      { role: "user", content: "已有问题" },
      { role: "assistant", content: "已有回答", toolCalls: [] },
    ]);
    const before = session.getCurrent();
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "已有会话中的计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => {
        assert.equal(session.getCurrent().id, before.id);
        assert.equal(session.getCurrent().revision, before.revision);
        return {
          content: "",
          toolCalls: [planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          })],
        };
      },
      () => {
        assert.equal(session.getCurrent().id, before.id);
        assert.equal(session.getCurrent().revision, before.revision);
        return { content: "继续执行", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("继续复杂任务"), "继续执行");
    assert.equal(session.getCurrent().id, before.id);
    assert.equal(session.getCurrent().revision, (before.revision ?? 0) + 1);
  });
});

for (const stopKind of ["abort", "return"] as const) {
  test(`successful create_plan persists its zero-turn session when the consumer chooses ${stopKind} after plan_activity`, async () => {
    await withRealPlanningSession(async ({ store, session, planning }) => {
      const controller = new AbortController();
      const gateway = createFakeGateway([
        () => ({
          content: "",
          toolCalls: [planningToolCall("create", "create_plan", {
            goal: "中断前持久化计划",
            steps: AGENT_PLAN_STEPS,
          })],
        }),
        reply("不应请求"),
      ]);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        planning,
      }));
      const iterator = conversation
        .stream("创建后停止", controller.signal)
        [Symbol.asyncIterator]();
      const first = await iterator.next();

      assert.equal(first.done, false);
      assert.equal(first.value?.type, "plan_activity");
      if (stopKind === "abort") {
        controller.abort();
        await assert.rejects(
          iterator.next(),
          (error: unknown) =>
            error instanceof Error && error.name === "AbortError",
        );
      } else {
        await iterator.return?.();
      }

      assert.equal(gateway.requests.length, 1);
      const current = session.getCurrent();
      assert.equal(current.revision, 1);
      assert.equal(current.turns.length, 0);
      const stored = store.plans.loadForSession(current.id!);
      assert.equal(stored?.revision, 1);
      assert.equal(stored?.status, "active");
    });
  });
}

test("malformed successful plan payload fails safely without a plan event", async () => {
  await withRealPlanningSession(async ({ session }) => {
    session.commitTurn([
      { role: "user", content: "建立现有会话" },
      { role: "assistant", content: "完成", toolCalls: [] },
    ]);
    const sessionId = session.getCurrent().id!;
    const malformed = planSnapshot(sessionId, {
      status: "completed",
    });
    const planning = stubPlanning({
      createPlan() {
        return malformed;
      },
    });
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "无效计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));
    const events: ConversationEvent[] = [];

    await assert.rejects(async () => {
      for await (const event of conversation.stream("创建无效计划")) {
        events.push(event);
      }
    }, /计划工具返回了无效结果/);

    assert.equal(events.some((event) => event.type === "plan_activity"), false);
    assert.equal(session.getCurrent().revision, 1);
    assert.equal(session.getCurrent().turns.length, 1);
  });
});

test("failed create_plan keeps identity unchanged, emits no plan event, and returns its result to the model", async () => {
  await withRealPlanningSession(async ({ session }) => {
    session.commitTurn([
      { role: "user", content: "建立现有会话" },
      { role: "assistant", content: "完成", toolCalls: [] },
    ]);
    const before = session.getCurrent();
    const planning = stubPlanning({
      createPlan() {
        throw new Error("计划创建失败");
      },
    });
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "失败计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      (request) => {
        const result = parsedToolResult(request, "create");
        assert.equal(result.ok, false);
        assert.match(String(result.error), /计划创建失败/);
        assert.equal(session.getCurrent().id, before.id);
        assert.equal(session.getCurrent().revision, before.revision);
        return { content: "计划未创建", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    const events = await collectConversationEvents(
      conversation.stream("创建失败计划"),
    );
    assert.equal(events.some((event) => event.type === "plan_activity"), false);
    assert.equal(events.some((event) => event.type === "tool_activity"), false);
    assert.equal(
      events.some((event) =>
        event.type === "status" &&
        /准备调用工具|整理工具结果/.test(event.text)
      ),
      false,
    );
  });
});

test("a failed create_plan blocks a later Shell call in the same batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ session }) => {
    session.commitTurn([
      { role: "user", content: "建立现有会话" },
      { role: "assistant", content: "完成", toolCalls: [] },
    ]);
    let shellStarts = 0;
    const planning = stubPlanning({
      createPlan() {
        throw new Error("计划创建失败");
      },
    });
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("create", "create_plan", {
            goal: "失败计划后不可执行",
            steps: AGENT_PLAN_STEPS,
          }),
          ordinaryToolCall("shell", "shell", { command: "pwd" }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "create").ok, false);
        assert.equal(parsedToolResult(request, "shell").ok, false);
        assert.match(
          String(parsedToolResult(request, "shell").error),
          /计划.*失败|执行门禁/,
        );
        return { content: "计划失败，未执行 Shell", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: {
        ...allowingToolInteraction,
        beginShell() {
          shellStarts += 1;
        },
      },
    }));

    assert.equal(
      await conversation.send("创建计划并执行 Shell"),
      "计划失败，未执行 Shell",
    );
    assert.equal(shellStarts, 0);
  });
});

test("a failed ordinary tool blocks complete_step in the same batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-fail-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ store, session, planning }) => {
    let mutationCalls = 0;
    let shellStarts = 0;
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "失败后禁止错误完成",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("shell-failure", "shell", {
            command: "node -e 'process.exit(7)'",
          }),
          ordinaryToolCall("write-after-failure", "write", {
            path: "should-not-exist.txt",
            content: "blocked",
          }),
          ordinaryToolCall("shell-after-failure", "shell", {
            command: "pwd",
          }),
          ordinaryToolCall("calculate-after-failure", "calculator", {
            expression: "6*7",
          }),
          planningToolCall("complete", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "complete_step",
            stepId: "inspect",
            result: "不可信的成功声明",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "shell-failure").ok, false);
        for (const id of [
          "write-after-failure",
          "shell-after-failure",
          "calculate-after-failure",
        ]) {
          const blocked = parsedToolResult(request, id);
          assert.equal(blocked.ok, false);
          assert.match(String(blocked.error), /本批.*普通工具失败|后续普通工具/);
        }
        assert.equal(parsedToolResult(request, "complete").ok, false);
        assert.match(
          String(parsedToolResult(request, "complete").error),
          /工具失败.*complete_step|complete_step.*禁止/,
        );
        return {
          content: "",
          toolCalls: [planningToolCall("block", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "block_step",
            stepId: "inspect",
            reason: "Shell exitCode 7",
          })],
        };
      },
      reply("失败已记录，计划未完成"),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: {
        ...allowingToolInteraction,
        async confirmMutation() {
          mutationCalls += 1;
          return true;
        },
        beginShell() {
          shellStarts += 1;
        },
      },
    }));

    assert.equal(
      await conversation.send("运行失败后保持真实状态"),
      "失败已记录，计划未完成",
    );
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.status, "blocked");
    assert.equal(stored?.steps[0]?.status, "blocked");
    assert.notEqual(stored?.status, "completed");
    assert.equal(mutationCalls, 0);
    assert.equal(shellStarts, 1);
    await assert.rejects(
      readFile(path.join(root, "should-not-exist.txt"), "utf8"),
      /ENOENT/,
    );
  });
});

test("a failed calculator short-circuits every later ordinary tool in the same batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-calc-short-circuit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ session, planning }) => {
    let plan = planning.createPlan({
      goal: "计算失败后停止本批普通工具",
      steps: AGENT_PLAN_STEPS,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    let mutationCalls = 0;
    let shellStarts = 0;
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [
          ordinaryToolCall("calculator-failure", "calculator", {
            wrong: "field",
          }),
          ordinaryToolCall("write-after-calculator", "write", {
            path: "calculator-blocked.txt",
            content: "blocked",
          }),
          ordinaryToolCall("shell-after-calculator", "shell", {
            command: "pwd",
          }),
          ordinaryToolCall("calculator-after-calculator", "calculator", {
            expression: "6*7",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "calculator-failure").ok, false);
        for (const id of [
          "write-after-calculator",
          "shell-after-calculator",
          "calculator-after-calculator",
        ]) {
          const blocked = parsedToolResult(request, id);
          assert.equal(blocked.ok, false);
          assert.match(String(blocked.error), /本批.*普通工具失败|后续普通工具/);
          assert.equal(Object.hasOwn(blocked, "result"), false);
        }
        return {
          content: "",
          toolCalls: [planningToolCall(
            "block-after-calculator",
            "update_plan",
            {
              planId: plan.id,
              expectedRevision: plan.revision,
              action: "block_step",
              stepId: "inspect",
              reason: "计算器参数错误，本批普通工具已短路",
            },
          )],
        };
      },
      (request) => {
        assert.equal(parsedToolResult(request, "block-after-calculator").ok, true);
        return { content: "本批已短路", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: {
        ...allowingToolInteraction,
        async confirmMutation() {
          mutationCalls += 1;
          return true;
        },
        beginShell() {
          shellStarts += 1;
        },
      },
    }));

    assert.equal(await conversation.send("执行本批"), "本批已短路");
    assert.equal(mutationCalls, 0);
    assert.equal(shellStarts, 0);
    await assert.rejects(
      readFile(path.join(root, "calculator-blocked.txt"), "utf8"),
      /ENOENT/,
    );
  });
});

test("an external plan cancellation during a tool blocks every later call in the batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ store, session, planning }) => {
    let plan = planning.createPlan({
      goal: "工具期间取消计划",
      steps: AGENT_PLAN_STEPS,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    let shellStarts = 0;
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [
          ordinaryToolCall("shell-before-cancel", "shell", { command: "pwd" }),
          ordinaryToolCall("calculator-after-cancel", "calculator", {
            expression: "6*7",
          }),
          planningToolCall("complete-after-cancel", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "complete_step",
            stepId: "inspect",
            result: "不可提交",
          }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "shell-before-cancel").ok, true);
        for (const id of [
          "calculator-after-cancel",
          "complete-after-cancel",
        ]) {
          const conflict = parsedToolResult(request, id);
          assert.equal(conflict.ok, false);
          assert.match(String(conflict.error), /计划.*变化|冲突/);
        }
        assert.equal(
          Object.hasOwn(parsedToolResult(request, "calculator-after-cancel"), "result"),
          false,
        );
        return { content: "检测到计划竞态", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: {
        ...allowingToolInteraction,
        beginShell() {
          shellStarts += 1;
          planning.cancelCurrent();
        },
      },
    }));

    assert.equal(await conversation.send("运行并检测竞态"), "检测到计划竞态");
    assert.equal(shellStarts, 1);
    assert.equal(
      store.plans.loadForSession(session.getCurrent().id!)?.status,
      "cancelled",
    );
  });
});

test("a locally rejected ordinary tool blocks complete_step after start_step in the same batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-plan-local-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await withRealPlanningSession(async ({ store, session, planning }) => {
    let shellStarts = 0;
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "本地拒绝后禁止错误完成",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "create").ok, true);
        return {
          content: "",
          toolCalls: [
            ordinaryToolCall("rejected-shell", "shell", { command: "pwd" }),
            planningToolCall("start", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 1,
              action: "start_step",
              stepId: "inspect",
            }),
            planningToolCall("complete", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 2,
              action: "complete_step",
              stepId: "inspect",
              result: "不可信的本地拒绝后成功声明",
            }),
          ],
        };
      },
      (request) => {
        const rejected = parsedToolResult(request, "rejected-shell");
        const started = parsedToolResult(request, "start");
        const completed = parsedToolResult(request, "complete");
        assert.equal(rejected.ok, false);
        assert.match(String(rejected.error), /start_step|执行门禁/);
        assert.equal(started.ok, true);
        assert.equal((started.plan as TaskPlan).revision, 2);
        assert.equal(completed.ok, false);
        assert.match(
          String(completed.error),
          /工具失败.*complete_step|complete_step.*禁止/,
        );
        return { content: "本地拒绝已保持真实计划状态", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
      workspaceRoot: root,
      toolInteraction: {
        ...allowingToolInteraction,
        beginShell() {
          shellStarts += 1;
        },
      },
    }));

    assert.equal(
      await conversation.send("本地门禁拒绝后不要完成步骤"),
      "本地拒绝已保持真实计划状态",
    );
    assert.equal(shellStarts, 0);
    const stored = store.plans.loadForSession(session.getCurrent().id!);
    assert.equal(stored?.status, "active");
    assert.equal(stored?.revision, 2);
    assert.equal(stored?.steps[0]?.status, "in_progress");
    assert.notEqual(stored?.steps[0]?.status, "completed");
  });
});

test("ordinary tool behavior is unchanged when planning is enabled without a current plan", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [
          ordinaryToolCall("calculate", "calculator", { expression: "6*7" }),
        ],
      }),
      (request) => {
        assert.equal(parsedToolResult(request, "calculate").result, 42);
        return { content: "42", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("计算 6*7"), "42");
  });
});

test("planning gate reloads the persisted plan after the provider round", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    let plan = planning.createPlan({
      goal: "执行前复核最新计划",
      steps: AGENT_PLAN_STEPS,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    const gateway = createFakeGateway([
      () => {
        plan = planning.updatePlan(plan.id, plan.revision, {
          type: "complete_step",
          stepId: "inspect",
          result: "provider 返回前已由持久状态完成",
        });
        return {
          content: "",
          toolCalls: [
            ordinaryToolCall("calculate", "calculator", {
              expression: "6*7",
            }),
          ],
        };
      },
      (request) => {
        assert.equal(parsedToolResult(request, "calculate").ok, false);
        assert.match(
          String(parsedToolResult(request, "calculate").error),
          /计划.*变化|冲突/,
        );
        return { content: "已按最新计划阻止执行", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(
      await conversation.send("继续"),
      "已按最新计划阻止执行",
    );
  });
});

test("create_plan cannot disguise an unrelated session switch as lazy materialization", async () => {
  await withRealSessionPair(async ({
    session,
    sessionBId,
    sessionABefore,
  }) => {
    const planning = stubPlanning({
      createPlan() {
        session.switchSession(sessionBId);
        return planSnapshot(sessionBId);
      },
    });
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "切换会话",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    await assert.rejects(
      conversation.send("不要切换会话"),
      /历史会话已在回答期间发生变化/,
    );
    assert.notEqual(session.getCurrent().id, sessionABefore.id);
  });
});

test("blocked ambiguity is committed as one clear question and the next user turn resumes before execution", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const turnOneGateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "修改目标项目",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      () => ({
        content: "",
        toolCalls: [
          planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          }),
          planningToolCall("block", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 2,
            action: "block_step",
            stepId: "inspect",
            reason: "缺少目标目录",
          }),
        ],
      }),
      reply("请明确要修改的目标目录是哪一个？"),
    ]);
    const conversation = createConversation(conversationOptions(
      turnOneGateway,
      { session, planning },
    ));

    assert.equal(
      await conversation.send("帮我修改项目"),
      "请明确要修改的目标目录是哪一个？",
    );
    let current = session.getCurrent();
    assert.equal(current.turns.length, 1);
    assert.equal(store.plans.loadForSession(current.id!)?.status, "blocked");

    const turnTwoToolOrder: string[] = [];
    const turnTwoGateway = createFakeGateway([
      (request) => {
        assert.match(
          JSON.stringify(request.messages),
          /请明确要修改的目标目录是哪一个/,
        );
        const systemContext = request.messages[0]?.content ?? "";
        assert.match(systemContext, /当前持久计划（本地已验证）/);
        assert.match(systemContext, /"id":"agent-plan"/);
        assert.match(systemContext, /"revision":3/);
        assert.match(systemContext, /"status":"blocked"/);
        assert.match(systemContext, /缺少目标目录/);
        const toolCalls = [
          planningToolCall("resume", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 3,
            action: "resume_step",
            stepId: "inspect",
          }),
          ordinaryToolCall("calculate", "calculator", {
            expression: "6*7",
          }),
        ];
        turnTwoToolOrder.push(...toolCalls.map((call) => call.id));
        return {
          content: "",
          toolCalls,
        };
      },
      (request) => {
        assert.equal(
          (parsedToolResult(request, "resume").plan as TaskPlan).status,
          "active",
        );
        assert.equal(parsedToolResult(request, "calculate").result, 42);
        return { content: "收到，已恢复并继续执行。", toolCalls: [] };
      },
    ]);
    const resumedConversation = createConversation(conversationOptions(
      turnTwoGateway,
      { session, planning },
    ));

    assert.equal(
      await resumedConversation.send("目标目录是 /tmp/project"),
      "收到，已恢复并继续执行。",
    );
    current = session.getCurrent();
    assert.equal(current.turns.length, 2);
    const resumed = store.plans.loadForSession(current.id!);
    assert.equal(resumed?.status, "active");
    assert.equal(resumed?.steps[0]?.status, "in_progress");
    assert.deepEqual(turnTwoToolOrder, ["resume", "calculate"]);
  });
});

function boundedPlanningSteps(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `step_${index + 1}`,
    title: `步骤 ${index + 1}`,
    successCriteria: `计算工具成功完成步骤 ${index + 1}`,
    dependsOn: index === 0 ? [] : [`step_${index}`],
  }));
}

for (const stepCount of [3, 12]) {
  test(`${stepCount}-step planning receives a bounded dynamic round budget and commits the completed turn`, async () => {
    await withRealPlanningSession(async ({ store, session, planning }) => {
      const steps = boundedPlanningSteps(stepCount);
      const handlers: ReplyHandler[] = [
        () => ({
          content: "",
          toolCalls: [planningToolCall("create", "create_plan", {
            goal: `完成 ${stepCount} 步计划`,
            steps,
          })],
        }),
        (request) => {
          assert.equal(
            (parsedToolResult(request, "create").plan as TaskPlan).revision,
            1,
          );
          return {
            content: "",
            toolCalls: [
              planningToolCall("start-0", "update_plan", {
                planId: "agent-plan",
                expectedRevision: 1,
                action: "start_step",
                stepId: steps[0]!.id,
              }),
              ordinaryToolCall("calculate-0", "calculator", {
                expression: "1+1",
              }),
            ],
          };
        },
      ];
      for (let index = 0; index < stepCount; index += 1) {
        handlers.push((request) => {
          const systemContext = request.messages[0]?.content ?? "";
          assert.match(systemContext, /当前持久计划（本地已验证）/);
          assert.match(systemContext, /"id":"agent-plan"/);
          assert.match(systemContext, new RegExp(
            `"revision":${2 + index * 2}`,
          ));
          assert.equal(
            (parsedToolResult(
              request,
              `start-${index}`,
            ).plan as TaskPlan).revision,
            2 + index * 2,
          );
          assert.equal(
            parsedToolResult(request, `calculate-${index}`).ok,
            true,
          );
          if (index > 0) {
            assert.match(systemContext, new RegExp(
              `步骤 ${index} 已完成`,
            ));
          }
          const toolCalls: Array<{
            id: string;
            name: string;
            argumentsJson: string;
          }> = [
            planningToolCall(`complete-${index}`, "update_plan", {
              planId: "agent-plan",
              expectedRevision: 2 + index * 2,
              action: "complete_step",
              stepId: steps[index]!.id,
              result: `步骤 ${index + 1} 已完成`,
            }),
          ];
          if (index + 1 < stepCount) {
            toolCalls.push(
              planningToolCall(`start-${index + 1}`, "update_plan", {
                planId: "agent-plan",
                expectedRevision: 3 + index * 2,
                action: "start_step",
                stepId: steps[index + 1]!.id,
              }),
              ordinaryToolCall(
                `calculate-${index + 1}`,
                "calculator",
                { expression: `${index + 2}+1` },
              ),
            );
          } else {
            toolCalls.push(planningToolCall("finish", "finish_plan", {
              planId: "agent-plan",
              expectedRevision: 1 + stepCount * 2,
              summary: `${stepCount} 个步骤均已验证`,
            }));
          }
          return {
            content: "",
            toolCalls,
          };
        });
      }
      handlers.push((request) => {
        assert.equal(
          (parsedToolResult(
            request,
            `complete-${stepCount - 1}`,
          ).plan as TaskPlan).revision,
          1 + stepCount * 2,
        );
        const finished = parsedToolResult(request, "finish").plan as TaskPlan;
        assert.equal(finished.status, "completed");
        assert.doesNotMatch(
          request.messages[0]?.content ?? "",
          /当前持久计划（本地已验证）/,
        );
        return { content: `${stepCount} 步计划已完成`, toolCalls: [] };
      });
      const gateway = createFakeGateway(handlers);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        planning,
      }));

      assert.equal(
        await conversation.send(`执行 ${stepCount} 步计划`),
        `${stepCount} 步计划已完成`,
      );
      assert.equal(gateway.requests.length, stepCount + 3);
      const current = session.getCurrent();
      assert.equal(current.turns.length, 1);
      assert.equal(
        store.plans.loadForSession(current.id!)?.status,
        "completed",
      );
    });
  });
}

for (const extraRound of [false, true]) {
  test(`dynamic planning budget ${extraRound ? "rejects one extra round without committing" : "allows completion on the exact final round"}`, async () => {
    await withRealPlanningSession(async ({ store, session, planning }) => {
      const steps = AGENT_PLAN_STEPS;
      const handlers: ReplyHandler[] = [
        () => ({
          content: "",
          toolCalls: [planningToolCall("create", "create_plan", {
            goal: "验证动态轮次边界",
            steps,
          })],
        }),
        () => ({
          content: "",
          toolCalls: [
            planningToolCall("start-inspect", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 1,
              action: "start_step",
              stepId: "inspect",
            }),
            ordinaryToolCall("inspect-evidence", "calculator", {
              expression: "1+1",
            }),
          ],
        }),
        () => ({
          content: "",
          toolCalls: [
            planningToolCall("complete-inspect", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 2,
              action: "complete_step",
              stepId: "inspect",
              result: "检查完成",
            }),
            planningToolCall("start-verify", "update_plan", {
              planId: "agent-plan",
              expectedRevision: 3,
              action: "start_step",
              stepId: "verify",
            }),
            ordinaryToolCall("verify-evidence", "calculator", {
              expression: "2+2",
            }),
          ],
        }),
      ];
      const fillerRounds = extraRound ? 6 : 5;
      for (let index = 0; index < fillerRounds; index += 1) {
        handlers.push(() => ({
          content: "",
          toolCalls: [ordinaryToolCall(
            `verify-extra-evidence-${index}`,
            "calculator",
            { expression: `${index}+1` },
          )],
        }));
      }
      handlers.push(() => ({
        content: "",
        toolCalls: [
          planningToolCall("complete-verify", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 4,
            action: "complete_step",
            stepId: "verify",
            result: "验证完成",
          }),
          planningToolCall("finish", "finish_plan", {
            planId: "agent-plan",
            expectedRevision: 5,
            summary: "恰好在动态预算内完成",
          }),
        ],
      }));
      handlers.push(reply("动态预算边界完成"));
      const gateway = createFakeGateway(handlers);
      const conversation = createConversation(conversationOptions(gateway, {
        session,
        planning,
      }));

      if (extraRound) {
        await assert.rejects(
          conversation.send("多用一轮"),
          /工具调用超过 10 轮/,
        );
        assert.equal(gateway.requests.length, 10);
        assert.equal(session.getCurrent().turns.length, 0);
      } else {
        assert.equal(
          await conversation.send("恰好完成"),
          "动态预算边界完成",
        );
        assert.equal(gateway.requests.length, 10);
        assert.equal(session.getCurrent().turns.length, 1);
      }
      assert.equal(
        store.plans.loadForSession(session.getCurrent().id!)?.status,
        "completed",
      );
    });
  });
}

test("compacted planning results preserve assistant tool-call pairing without full plan data", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    const gateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "完整计划内容不得残留",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
      (request) => {
        assert.match(
          JSON.stringify(parsedToolResult(request, "create")),
          /完整计划内容不得残留|successCriteria/,
        );
        return {
          content: "",
          toolCalls: [planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          })],
        };
      },
      (request) => {
        const compacted = parsedToolResult(request, "create");
        assert.deepEqual(compacted, {
          id: "agent-plan",
          revision: 1,
          status: "active",
          compacted: true,
        });
        assert.doesNotMatch(
          JSON.stringify(compacted),
          /完整计划内容不得残留|sessionId|steps|successCriteria/,
        );
        return { content: "compact 完成", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("创建并开始"), "compact 完成");
    const messages = session.getCurrent().turns[0]?.messages ?? [];
    const planningCallIds = messages.flatMap((message) =>
      message.role === "assistant"
        ? message.toolCalls
          .filter((call) =>
            ["create_plan", "update_plan", "finish_plan"].includes(call.name)
          )
          .map((call) => call.id)
        : []
    );
    assert.deepEqual(planningCallIds, ["create", "start"]);
    for (const [index, toolCallId] of planningCallIds.entries()) {
      const result = messages.find(
        (message) =>
          message.role === "tool" && message.toolCallId === toolCallId,
      );
      assert.ok(result && result.role === "tool");
      assert.deepEqual(JSON.parse(result.content), {
        id: "agent-plan",
        revision: index + 1,
        status: "active",
        compacted: true,
      });
      assert.doesNotMatch(
        result.content,
        /完整计划内容不得残留|sessionId|steps|successCriteria/,
      );
    }
  });
});

test("a zero-turn interrupted plan is injected into the first request of the next turn", async () => {
  await withRealPlanningSession(async ({ store, session, planning }) => {
    const interruptedGateway = createFakeGateway([
      () => ({
        content: "",
        toolCalls: [planningToolCall("create", "create_plan", {
          goal: "中断后恢复原计划",
          steps: AGENT_PLAN_STEPS,
        })],
      }),
    ]);
    const interrupted = createConversation(conversationOptions(
      interruptedGateway,
      { session, planning },
    ));
    const iterator = interrupted
      .stream("创建后由 consumer 停止")
      [Symbol.asyncIterator]();
    const planEvent = await iterator.next();
    assert.equal(planEvent.value?.type, "plan_activity");
    await iterator.return?.();
    assert.equal(session.getCurrent().turns.length, 0);

    const resumedGateway = createFakeGateway([
      (request) => {
        const systemContext = request.messages[0]?.content ?? "";
        assert.match(systemContext, /当前持久计划（本地已验证）/);
        assert.match(systemContext, /"id":"agent-plan"/);
        assert.match(systemContext, /"revision":1/);
        assert.match(systemContext, /"goal":"中断后恢复原计划"/);
        assert.match(systemContext, /"status":"active"/);
        assert.match(systemContext, /"status":"pending"/);
        return {
          content: "",
          toolCalls: [planningToolCall("start", "update_plan", {
            planId: "agent-plan",
            expectedRevision: 1,
            action: "start_step",
            stepId: "inspect",
          })],
        };
      },
      (request) => {
        assert.match(
          request.messages[0]?.content ?? "",
          /"revision":2/,
        );
        return { content: "已从持久计划继续", toolCalls: [] };
      },
    ]);
    const resumed = createConversation(conversationOptions(resumedGateway, {
      session,
      planning,
    }));

    assert.equal(
      await resumed.send("继续"),
      "已从持久计划继续",
    );
    assert.equal(session.getCurrent().turns.length, 1);
    assert.equal(
      store.plans.loadForSession(session.getCurrent().id!)?.revision,
      2,
    );
  });
});

test("persisted plan context follows session switches and never leaks across sessions", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    planning.createPlan({
      goal: "仅属于会话 A",
      steps: AGENT_PLAN_STEPS,
    });
    const sessionAId = session.getCurrent().id!;

    session.startNew(deepSeekModel);
    const sessionBGateway = createFakeGateway([
      (request) => {
        assert.doesNotMatch(
          request.messages[0]?.content ?? "",
          /当前持久计划（本地已验证）|仅属于会话 A/,
        );
        return { content: "会话 B", toolCalls: [] };
      },
    ]);
    await createConversation(conversationOptions(sessionBGateway, {
      session,
      planning,
    })).send("会话 B 的普通问题");

    session.switchSession(sessionAId);
    const sessionAGateway = createFakeGateway([
      (request) => {
        assert.match(
          request.messages[0]?.content ?? "",
          /当前持久计划（本地已验证）/,
        );
        assert.match(request.messages[0]?.content ?? "", /仅属于会话 A/);
        return { content: "会话 A", toolCalls: [] };
      },
    ]);
    await createConversation(conversationOptions(sessionAGateway, {
      session,
      planning,
    })).send("回到会话 A");
  });
});

test("terminal plans are not injected as a forced continuation", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    let plan = planning.createPlan({
      goal: "已结束的计划",
      steps: AGENT_PLAN_STEPS,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "complete_step",
      stepId: "inspect",
      result: "检查完成",
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "verify",
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "complete_step",
      stepId: "verify",
      result: "验证完成",
    });
    plan = planning.finishPlan(plan.id, plan.revision, "计划已完成");
    assert.equal(plan.status, "completed");

    const gateway = createFakeGateway([
      (request) => {
        assert.doesNotMatch(
          request.messages[0]?.content ?? "",
          /当前持久计划（本地已验证）/,
        );
        return { content: "这是新的普通回答", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(
      await conversation.send("一个新的简单问题"),
      "这是新的普通回答",
    );
  });
});

test("persisted plan context redacts quoted and token-shaped secrets in every text field while preserving structure", async () => {
  await withRealPlanningSession(async ({ session, planning }) => {
    let plan = planning.createPlan({
      goal:
        'api_key="goal-double-\\"escaped value" Bearer goal-bearer-secret ' +
        '{"api_key":"json-key-secret"}\n' +
        "Authorization: Basic basic-authorization-secret\n" +
        "aUtHoRiZaTiOn   :   bEaReR spaced-bearer-secret\n" +
        'Authorization: Digest username="coffee", response="digest-response-secret"\n' +
        "Authorization: AWS4-HMAC-SHA256 Credential=coffee, Signature=aws-signature-secret\n" +
        "Authorization: Negotiate negotiate-secret-token\n" +
        "Authorization: Custom custom-authorization-secret\n" +
        '{"authorization":"json-authorization-secret","safe":"保留JSON字段"}\n' +
        "Authorization: Digest realm=coffee\r\n response=folded-digest-secret\r\nX-Normal: keep-crlf-header\n" +
        "Authorization: AWS4-HMAC-SHA256 Credential=coffee\n\tSignature=folded-aws-secret\n保留LF正文\n" +
        "Authorization: MyCustom first-part\n continuation-custom-secret\nAfter: keep-custom-header\n" +
        "Authorization: Bearer bare-cr-secret\r\tbare-cr-continuation-secret\rCR-Normal: keep-bare-cr-header\r" +
        'api_key="unterminated-double-secret\n保留目标说明',
      steps: [
        {
          id: "inspect",
          title:
            "secret='title-escaped-\\'x' sk-title-secret " +
            "\"secret\" : 'json-single-secret'\n" +
            "secret='unterminated-single-secret\n保留标题",
          successCriteria:
            "token=`criteria-backtick-\\`escaped value` tvly-criteria-secret " +
            '"token" = `json-backtick-secret`\n' +
            "token=`unterminated-backtick-secret\n保留验收说明",
          dependsOn: [],
        },
        {
          id: "verify",
          title: "验证安全上下文",
          successCriteria: "确认结构和脱敏结果",
          dependsOn: ["inspect"],
        },
      ],
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "inspect",
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "complete_step",
      stepId: "inspect",
      result:
        'authorization="result-double-\\"escaped value" ' +
        "password='result-single-\\'escaped value' " +
        `Bearer result-bearer-secret ${"x".repeat(650)}`,
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "start_step",
      stepId: "verify",
    });
    plan = planning.updatePlan(plan.id, plan.revision, {
      type: "block_step",
      stepId: "verify",
      reason:
        "credential=`block-backtick-\\`escaped value` " +
        "secret='block-single-secret' sk-block-secret",
    });
    assert.equal(plan.revision, 5);

    const gateway = createFakeGateway([
      (request) => {
        const systemContext = request.messages[0]?.content ?? "";
        const providerMessages = JSON.stringify(request.messages);
        for (const secret of [
          "goal-double-",
          "goal-bearer-secret",
          "json-key-secret",
          "basic-authorization-secret",
          "spaced-bearer-secret",
          "digest-response-secret",
          "aws-signature-secret",
          "negotiate-secret-token",
          "custom-authorization-secret",
          "json-authorization-secret",
          "folded-digest-secret",
          "folded-aws-secret",
          "continuation-custom-secret",
          "bare-cr-secret",
          "bare-cr-continuation-secret",
          "unterminated-double-secret",
          "title-escaped-",
          "sk-title-secret",
          "json-single-secret",
          "unterminated-single-secret",
          "criteria-backtick-",
          "tvly-criteria-secret",
          "json-backtick-secret",
          "unterminated-backtick-secret",
          "result-double-",
          "result-single-",
          "result-bearer-secret",
          "block-backtick-",
          "block-single-secret",
          "sk-block-secret",
        ]) {
          assert.doesNotMatch(
            providerMessages,
            new RegExp(secret),
            `provider messages leaked ${secret}`,
          );
        }
        assert.match(systemContext, /"result":/);
        assert.match(systemContext, /"blockReason":/);
        assert.match(systemContext, /\[REDACTED\]/);
        assert.match(systemContext, /\[已截断\]/);
        const serialized = systemContext
          .split("当前持久计划（本地已验证）：\n")[1]
          ?.split("\n请按该计划")[0];
        assert.ok(serialized);
        const snapshot = JSON.parse(serialized) as TaskPlan;
        assert.equal(snapshot.id, "agent-plan");
        assert.equal(snapshot.sessionId, session.getCurrent().id);
        assert.equal(snapshot.revision, 5);
        assert.equal(snapshot.status, "blocked");
        assert.match(snapshot.goal, /保留目标说明/);
        assert.match(snapshot.goal, /保留JSON字段/);
        assert.match(snapshot.goal, /X-Normal: keep-crlf-header/);
        assert.match(snapshot.goal, /保留LF正文/);
        assert.match(snapshot.goal, /After: keep-custom-header/);
        assert.match(snapshot.goal, /CR-Normal: keep-bare-cr-header/);
        assert.match(snapshot.steps[0]?.title ?? "", /保留标题/);
        assert.match(
          snapshot.steps[0]?.successCriteria ?? "",
          /保留验收说明/,
        );
        assert.deepEqual(
          snapshot.steps.map((step) => ({
            id: step.id,
            status: step.status,
            dependsOn: step.dependsOn,
          })),
          [
            { id: "inspect", status: "completed", dependsOn: [] },
            {
              id: "verify",
              status: "blocked",
              dependsOn: ["inspect"],
            },
          ],
        );
        return { content: "安全恢复", toolCalls: [] };
      },
    ]);
    const conversation = createConversation(conversationOptions(gateway, {
      session,
      planning,
    }));

    assert.equal(await conversation.send("继续"), "安全恢复");
  });
});
