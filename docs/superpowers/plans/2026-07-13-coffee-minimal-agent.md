# Coffee Minimal Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal TypeScript CLI that keeps an in-memory conversation and calls the fixed DeepSeek `deepseek-v4-flash` model with a key stored directly in `.env`.

**Architecture:** `src/agent.ts` owns conversation state and the DeepSeek HTTP boundary. `src/cli.ts` owns terminal input/output and delegates each non-empty line to the conversation. Tests inject a fake `fetch` for the paid API boundary and spawn the real CLI for startup and `/exit` behavior.

**Tech Stack:** Node.js 22, TypeScript 7, tsx, native `fetch`, `node:test`, DeepSeek Chat Completions API.

---

The workspace is not a Git repository. Do not initialize one or add commit steps unless the user asks.

## File Map

- Create `.env`: local `DEEPSEEK_API_KEY` entry edited directly by the user.
- Create `.gitignore`: prevent `.env` and installed dependencies from being tracked if Git is added later.
- Create `package.json`: scripts, Node requirement, and pinned TypeScript development tools.
- Create `package-lock.json`: generated dependency lockfile.
- Create `tsconfig.json`: strict no-emit type checking.
- Create `src/agent.ts`: fixed-model DeepSeek conversation client.
- Create `src/cli.ts`: terminal read/evaluate/print loop.
- Create `test/agent.test.ts`: request, history, rollback, and API response tests.
- Create `test/cli.test.ts`: missing-key and `/exit` integration tests.
- Create `README.md`: setup, run, test, and first-version boundaries.

### Task 1: Project Configuration

**Files:**
- Create: `.env`
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Generate: `package-lock.json`

- [x] **Step 1: Create the local API configuration**

```dotenv
DEEPSEEK_API_KEY=
```

- [x] **Step 2: Ignore local credentials and dependencies**

```gitignore
.env
node_modules/
```

- [x] **Step 3: Create the package manifest**

```json
{
  "name": "coffee-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --env-file=.env --import tsx src/cli.ts",
    "test": "node --import tsx --test test/*.test.ts",
    "check": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.19.0"
  },
  "devDependencies": {
    "@types/node": "22.20.1",
    "tsx": "4.23.1",
    "typescript": "7.0.2"
  }
}
```

- [x] **Step 4: Create strict TypeScript configuration**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [x] **Step 5: Install pinned development tools without lifecycle scripts**

Run: `npm install --ignore-scripts`

Expected: exit code 0, `node_modules/` and `package-lock.json` created, no application runtime dependencies installed.

### Task 2: DeepSeek Conversation Core

**Files:**
- Create: `test/agent.test.ts`
- Create: `src/agent.ts`

- [x] **Step 1: Write all conversation-core tests before implementation**

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createConversation } from "../src/agent.js";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("rejects a missing DeepSeek API key", () => {
  assert.throws(
    () => createConversation({ apiKey: "" }),
    /DEEPSEEK_API_KEY/,
  );
});

test("sends the first user message to the fixed DeepSeek model", async () => {
  const requests: CapturedRequest[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    requests.push({ url: String(input), init });
    return jsonResponse({
      choices: [{ message: { content: "你好，我是 Coffee。" } }],
    });
  };
  const conversation = createConversation({ apiKey: "test-key", fetchImpl });

  const reply = await conversation.send("你好");

  assert.equal(reply, "你好，我是 Coffee。");
  assert.equal(requests[0]?.url, "https://api.deepseek.com/chat/completions");
  assert.equal(requests[0]?.init?.method, "POST");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(String(requests[0]?.init?.body));
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.messages, [{ role: "user", content: "你好" }]);
});

test("includes prior user and assistant messages in the next request", async () => {
  const bodies: Array<{ messages: unknown[] }> = [];
  const replies = ["第一条回复", "第二条回复"];
  const fetchImpl: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return jsonResponse({
      choices: [{ message: { content: replies.shift() } }],
    });
  };
  const conversation = createConversation({ apiKey: "test-key", fetchImpl });

  await conversation.send("第一条问题");
  await conversation.send("第二条问题");

  assert.deepEqual(bodies[1]?.messages, [
    { role: "user", content: "第一条问题" },
    { role: "assistant", content: "第一条回复" },
    { role: "user", content: "第二条问题" },
  ]);
});

test("reports an API error and rolls back the failed user message", async () => {
  const bodies: Array<{ messages: unknown[] }> = [];
  let callCount = 0;
  const fetchImpl: FetchLike = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    callCount += 1;
    if (callCount === 1) {
      return jsonResponse({ error: { message: "余额不足" } }, 402);
    }
    return jsonResponse({ choices: [{ message: { content: "已恢复" } }] });
  };
  const conversation = createConversation({ apiKey: "test-key", fetchImpl });

  await assert.rejects(conversation.send("失败的一轮"), /402.*余额不足/);
  await conversation.send("重新开始");

  assert.deepEqual(bodies[1]?.messages, [
    { role: "user", content: "重新开始" },
  ]);
});

test("rejects a response without assistant text", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ choices: [] });
  const conversation = createConversation({ apiKey: "test-key", fetchImpl });

  await assert.rejects(
    conversation.send("你好"),
    /响应中没有 assistant 文本/,
  );
});
```

- [x] **Step 2: Run the core tests and observe the missing implementation**

Run: `node --import tsx --test test/agent.test.ts`

Expected: FAIL because `src/agent.ts` does not exist.

- [x] **Step 3: Add a signature stub, then verify a behavior-level failure**

```ts
interface ConversationOptions {
  apiKey: string | undefined;
}

export function createConversation(_options: ConversationOptions): never {
  throw new Error("Not implemented");
}
```

Run: `node --import tsx --test test/agent.test.ts`

Expected: FAIL because the first test expects an error mentioning `DEEPSEEK_API_KEY`, not `Not implemented`.

- [x] **Step 4: Replace the stub with the minimal conversation implementation**

```ts
const API_URL = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface DeepSeekResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  error?: { message?: unknown };
}

interface ConversationOptions {
  apiKey: string | undefined;
  fetchImpl?: FetchLike;
}

export interface Conversation {
  send(input: string): Promise<string>;
}

function getAssistantText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const response = payload as DeepSeekResponse;
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : undefined;
}

function getApiError(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const response = payload as DeepSeekResponse;
  const message = response.error?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

export function createConversation({
  apiKey,
  fetchImpl = fetch,
}: ConversationOptions): Conversation {
  const normalizedApiKey = apiKey?.trim();
  if (!normalizedApiKey) {
    throw new Error("缺少 DEEPSEEK_API_KEY，请编辑 .env 后重试。");
  }

  const messages: ChatMessage[] = [];

  return {
    async send(input: string): Promise<string> {
      messages.push({ role: "user", content: input });

      try {
        const response = await fetchImpl(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${normalizedApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: MODEL, messages }),
        });

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }

        if (!response.ok) {
          const apiMessage = getApiError(payload);
          const suffix = apiMessage ? `: ${apiMessage}` : "";
          throw new Error(`DeepSeek API 请求失败 (${response.status})${suffix}`);
        }

        const assistantText = getAssistantText(payload);
        if (!assistantText) {
          throw new Error("DeepSeek API 响应中没有 assistant 文本。");
        }

        messages.push({ role: "assistant", content: assistantText });
        return assistantText;
      } catch (error) {
        messages.pop();
        throw error;
      }
    },
  };
}
```

- [x] **Step 5: Run the core tests and type checker**

Run: `node --import tsx --test test/agent.test.ts`

Expected: 5 tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

### Task 3: Terminal CLI

**Files:**
- Create: `test/cli.test.ts`
- Create: `src/cli.ts`

- [x] **Step 1: Write CLI integration tests before the CLI exists**

```ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(apiKey: string | undefined, input: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    if (apiKey !== undefined) {
      env.DEEPSEEK_API_KEY = apiKey;
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("exits with a clear message when the API key is missing", async () => {
  const result = await runCli(undefined, "");

  assert.equal(result.code, 1);
  assert.match(result.stderr, /DEEPSEEK_API_KEY/);
  assert.match(result.stderr, /\.env/);
});

test("starts the CLI and exits on slash-exit without calling the API", async () => {
  const result = await runCli("test-key", "/exit\n");

  assert.equal(result.code, 0);
  assert.match(result.stdout, /Coffee CLI/);
  assert.match(result.stdout, /You>/);
  assert.equal(result.stderr, "");
});
```

- [x] **Step 2: Run the CLI tests and observe the missing entry point**

Run: `node --import tsx --test test/cli.test.ts`

Expected: FAIL because `src/cli.ts` does not exist and the expected CLI output is absent.

- [x] **Step 3: Implement the minimal terminal loop**

```ts
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { createConversation, type Conversation } from "./agent.js";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  let conversation: Conversation;
  try {
    conversation = createConversation({ apiKey: process.env.DEEPSEEK_API_KEY });
  } catch (error) {
    console.error(`Error: ${getErrorMessage(error)}`);
    return 1;
  }

  const readline = createInterface({ input, output });
  console.log("Coffee CLI 已启动，输入 /exit 退出。\n");

  try {
    while (true) {
      const userInput = (await readline.question("You> ")).trim();
      if (userInput === "/exit") {
        return 0;
      }
      if (!userInput) {
        continue;
      }

      try {
        const reply = await conversation.send(userInput);
        console.log(`Coffee> ${reply}\n`);
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
      }
    }
  } finally {
    readline.close();
  }
}

process.exitCode = await main();
```

- [x] **Step 4: Run all automated checks**

Run: `npm test`

Expected: 7 tests pass.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

### Task 4: User Documentation and Final Smoke Test

**Files:**
- Create: `README.md`

- [x] **Step 1: Write the minimal Chinese README**

````markdown
# Coffee Agent

Coffee 是一个用 TypeScript 编写的最小终端对话程序。第一版固定使用 DeepSeek `deepseek-v4-flash`，通过 Node.js 原生 `fetch` 调用 API，并在当前进程内保留多轮对话历史。

## 环境要求

- Node.js `>= 22.19.0`
- DeepSeek API Key

## 运行

安装开发依赖：

```bash
npm install
```

打开 `.env`，填写：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
```

启动 CLI：

```bash
npm start
```

在终端中输入消息开始对话，输入 `/exit` 退出。

## 验证

```bash
npm test
npm run check
```

测试使用假的 HTTP 响应，不会调用真实 DeepSeek API，也不会消耗额度。

## 当前边界

第一版只有终端多轮对话，不包含模型选择、工具调用、流式输出、会话持久化、LangChain 或图形 UI。
````

- [x] **Step 2: Verify missing-key startup behavior through the package script**

Keep `.env` as `DEEPSEEK_API_KEY=`.

Run: `npm start`

Expected: exit code 1 and `Error: 缺少 DEEPSEEK_API_KEY，请编辑 .env 后重试。` No network request occurs.

- [x] **Step 3: Verify the non-network `/exit` path**

Run: `DEEPSEEK_API_KEY=test-key node --import tsx src/cli.ts`, then enter `/exit`.

Expected: the CLI prints its startup line and exits with code 0 without calling DeepSeek.

- [x] **Step 4: Run final verification**

Run: `npm test && npm run check`

Expected: 7 tests pass, followed by a clean TypeScript check.

- [x] **Step 5: Inspect the final project boundary**

Run: `find . -maxdepth 4 -type f -not -path './node_modules/*' | sort`

Expected files include `.env`, `.gitignore`, `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, both source files, both test files, the design document, and this plan. No file under `pi/` is changed.
