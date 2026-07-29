# Coffee Multi-Provider Model Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Pi-style `/login`, `/logout`, and `/model` commands so Coffee can authenticate and switch among DeepSeek, OpenCode Go, OpenCode Zen, and Volcengine Ark Coding Plan while preserving conversation history.

**Architecture:** Introduce a small model domain with separate credential definitions, provider/model catalog entries, a registry, and an OpenAI Chat Completions adapter. Keep the agent loop protocol-neutral, store credentials in `~/.coffee/auth.json`, and store only the active provider/model in `coffee.settings.json`.

**Tech Stack:** Node.js 22, TypeScript 7, native `fetch`, `@inquirer/core`, Node test runner.

---

## Scope and repository note

`/Users/sevan/ai-tasks/pi-agent/coffee` is not currently a Git repository. The normal per-task commit steps are intentionally omitted because `git commit` would fail. Each task instead ends with a focused test command; the final task runs the full test and type-check suites.

## File map

Create:

- `src/models/types.ts` — neutral messages, model definitions, gateway result, and model errors.
- `src/models/catalog.ts` — credential definitions and the first supported model catalog.
- `src/models/registry.ts` — provider/model lookup and authenticated-provider filtering.
- `src/models/openai-completions.ts` — native-fetch Chat Completions adapter.
- `src/auth.ts` — global credential storage and `.env` fallback.
- `src/login-command.ts` — pure `/login` menu state and rendering helpers.
- `src/logout-command.ts` — pure `/logout` menu state and rendering helpers.
- `src/model-command.ts` — pure two-stage model menu helpers.
- `test/model-registry.test.ts`
- `test/auth.test.ts`
- `test/openai-completions.test.ts`
- `test/login-command.test.ts`
- `test/logout-command.test.ts`
- `test/model-command.test.ts`

Modify:

- `src/agent.ts` — use the model gateway, resolve credentials per request, and support `setModel()`.
- `src/settings.ts` — load/save `model-preferences` without disturbing coffee preferences.
- `src/chat-input.ts` — add masked `askSecret()` input.
- `src/commands.ts` — register `/login`, `/logout`, and `/model`.
- `src/cli.ts` — orchestrate login/logout/model selection and allow startup without a model credential.
- `test/agent.test.ts`
- `test/settings.test.ts`
- `test/chat-input.test.ts`
- `test/commands.test.ts`
- `test/cli.test.ts`
- `README.md`

### Task 1: Model domain, catalog, and registry

**Files:**

- Create: `src/models/types.ts`
- Create: `src/models/catalog.ts`
- Create: `src/models/registry.ts`
- Create: `test/model-registry.test.ts`

- [ ] **Step 1: Write registry tests that define the public behavior**

Create `test/model-registry.test.ts` with focused assertions:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { CREDENTIALS, PROVIDERS } from "../src/models/catalog.js";
import { createModelRegistry } from "../src/models/registry.js";

test("shares one OpenCode credential between Go and Zen", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

  assert.equal(registry.getProvider("opencode-go")?.credentialId, "opencode");
  assert.equal(registry.getProvider("opencode-zen")?.credentialId, "opencode");
});

test("finds a model by provider and model id", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);
  const model = registry.getModel("opencode-go", "kimi-k2.7-code");

  assert.equal(model?.api, "openai-completions");
  assert.equal(model?.baseUrl, "https://opencode.ai/zen/go/v1");
});

test("returns both OpenCode plans when the shared credential is available", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

  assert.deepEqual(
    registry
      .getAvailableProviders((credentialId) => credentialId === "opencode")
      .map((provider) => provider.id),
    ["opencode-go", "opencode-zen"],
  );
});

test("rejects duplicate provider ids and duplicate model ids", () => {
  assert.throws(
    () => createModelRegistry(CREDENTIALS, [PROVIDERS[0]!, PROVIDERS[0]!]),
    /重复的平台/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- --test-name-pattern="OpenCode|finds a model|duplicate"
```

Expected: FAIL because the model catalog and registry modules do not exist.

- [ ] **Step 3: Add neutral model types and registry behavior**

Define these contracts in `src/models/types.ts`:

```ts
import type { ToolDefinition } from "../tool-registry.js";

export type ModelApi = "openai-completions";
export type CredentialId = "deepseek" | "opencode" | "volcengine-ark";

export interface CredentialDefinition {
  id: CredentialId;
  name: string;
  envKeys: readonly string[];
}

export interface ModelDefinition {
  id: string;
  name: string;
  providerId: string;
  credentialId: CredentialId;
  api: ModelApi;
  baseUrl: string;
  disableThinking?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  credentialId: CredentialId;
  models: readonly ModelDefinition[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: readonly ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelReply {
  content?: string;
  toolCalls: ModelToolCall[];
}

export interface ModelRequest {
  model: ModelDefinition;
  apiKey: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelReply>;
}

export type ModelErrorCode =
  | "auth"
  | "model"
  | "rate_limit"
  | "server"
  | "network"
  | "invalid_response";

export class ModelRequestError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelRequestError";
  }
}
```

Implement `createModelRegistry()` in `src/models/registry.ts` with these methods:

```ts
import type {
  CredentialDefinition,
  CredentialId,
  ModelDefinition,
  ProviderDefinition,
} from "./types.js";

export interface ModelRegistry {
  getCredentials(): readonly CredentialDefinition[];
  getCredential(id: CredentialId): CredentialDefinition | undefined;
  getProviders(): readonly ProviderDefinition[];
  getProvider(id: string): ProviderDefinition | undefined;
  getModel(providerId: string, modelId: string): ModelDefinition | undefined;
  getAvailableProviders(
    hasCredential: (credentialId: CredentialId) => boolean,
  ): ProviderDefinition[];
}

export function createModelRegistry(
  credentials: readonly CredentialDefinition[],
  providers: readonly ProviderDefinition[],
): ModelRegistry {
  const credentialsById = new Map(credentials.map((item) => [item.id, item]));
  const providersById = new Map<string, ProviderDefinition>();

  for (const provider of providers) {
    if (providersById.has(provider.id)) {
      throw new Error(`重复的平台: ${provider.id}`);
    }
    if (!credentialsById.has(provider.credentialId)) {
      throw new Error(`平台 ${provider.id} 引用了未知凭证: ${provider.credentialId}`);
    }
    const ids = new Set<string>();
    for (const model of provider.models) {
      if (ids.has(model.id)) throw new Error(`重复的模型: ${provider.id}/${model.id}`);
      if (model.providerId !== provider.id) {
        throw new Error(`模型 ${model.id} 的 providerId 不匹配`);
      }
      ids.add(model.id);
    }
    providersById.set(provider.id, provider);
  }

  return {
    getCredentials: () => credentials,
    getCredential: (id) => credentialsById.get(id),
    getProviders: () => providers,
    getProvider: (id) => providersById.get(id),
    getModel: (providerId, modelId) =>
      providersById.get(providerId)?.models.find((model) => model.id === modelId),
    getAvailableProviders: (hasCredential) =>
      providers.filter((provider) => hasCredential(provider.credentialId)),
  };
}
```

Populate `src/models/catalog.ts` with this exact catalog:

```ts
import type {
  CredentialDefinition,
  CredentialId,
  ModelDefinition,
  ProviderDefinition,
} from "./types.js";

export const CREDENTIALS = [
  { id: "deepseek", name: "DeepSeek", envKeys: ["DEEPSEEK_API_KEY"] },
  { id: "opencode", name: "OpenCode", envKeys: ["OPENCODE_API_KEY"] },
  { id: "volcengine-ark", name: "方舟 Coding Plan", envKeys: ["ARK_API_KEY"] },
] as const satisfies readonly CredentialDefinition[];

const BASE_URLS = {
  deepseek: "https://api.deepseek.com",
  opencodeGo: "https://opencode.ai/zen/go/v1",
  opencodeZen: "https://opencode.ai/zen/v1",
  ark: "https://ark.cn-beijing.volces.com/api/coding/v3",
} as const;

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "glm-5": "GLM-5",
  "glm-5.1": "GLM-5.1",
  "glm-5.2": "GLM-5.2",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "mimo-v2.5": "MiMo V2.5",
  "mimo-v2.5-pro": "MiMo V2.5 Pro",
  "minimax-m2.5": "MiniMax M2.5",
  "minimax-m2.7": "MiniMax M2.7",
  "minimax-m3": "MiniMax M3",
  "qwen3.6-plus": "Qwen3.6 Plus",
  "ark-code-latest": "Ark Code Latest",
};

function createModels(
  providerId: string,
  credentialId: CredentialId,
  baseUrl: string,
  ids: readonly string[],
): ModelDefinition[] {
  return ids.map((id) => ({
    id,
    name: DISPLAY_NAMES[id] ?? id,
    providerId,
    credentialId,
    api: "openai-completions",
    baseUrl,
    disableThinking: id.startsWith("deepseek-v4"),
  }));
}

const DEEPSEEK_IDS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;
const OPENCODE_GO_IDS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "glm-5.1",
  "glm-5.2",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m2.7",
  "qwen3.6-plus",
] as const;
const OPENCODE_ZEN_IDS = [
  "big-pickle",
  "deepseek-v4-flash",
  "deepseek-v4-flash-free",
  "deepseek-v4-pro",
  "glm-5",
  "glm-5.1",
  "glm-5.2",
  "grok-4.5",
  "grok-build-0.1",
  "hy3-free",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "mimo-v2.5-free",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
] as const;

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    credentialId: "deepseek",
    models: createModels("deepseek", "deepseek", BASE_URLS.deepseek, DEEPSEEK_IDS),
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    credentialId: "opencode",
    models: createModels("opencode-go", "opencode", BASE_URLS.opencodeGo, OPENCODE_GO_IDS),
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    credentialId: "opencode",
    models: createModels("opencode-zen", "opencode", BASE_URLS.opencodeZen, OPENCODE_ZEN_IDS),
  },
  {
    id: "volcengine-ark",
    name: "方舟 Coding Plan",
    credentialId: "volcengine-ark",
    models: createModels("volcengine-ark", "volcengine-ark", BASE_URLS.ark, ["ark-code-latest"]),
  },
];
```

- [ ] **Step 4: Run registry tests and type-check**

Run:

```bash
npm test -- test/model-registry.test.ts
npm run check
```

Expected: all registry tests PASS and TypeScript reports no errors.

### Task 2: Global credential store

**Files:**

- Create: `src/auth.ts`
- Create: `test/auth.test.ts`

- [ ] **Step 1: Write credential storage tests**

Cover saved-key priority, `.env` fallback, OpenCode sharing, deletion, masking, malformed JSON, and POSIX permissions:

```ts
test("prefers auth.json over environment variables", async () => {
  await store.saveApiKey("deepseek", "saved-key");
  const resolved = await store.resolve(CREDENTIALS[0], {
    DEEPSEEK_API_KEY: "env-key",
  });
  assert.deepEqual(resolved, { key: "saved-key", source: "auth-file" });
});

test("falls back to the configured environment key", async () => {
  const resolved = await store.resolve(CREDENTIALS[1], {
    OPENCODE_API_KEY: "env-opencode",
  });
  assert.deepEqual(resolved, { key: "env-opencode", source: "environment" });
});

test("writes the directory as 0700 and auth file as 0600", async () => {
  await store.saveApiKey("opencode", "secret");
  assert.equal((await stat(authDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
});

test("deleting a saved key allows environment fallback", async () => {
  await store.saveApiKey("volcengine-ark", "saved");
  await store.deleteApiKey("volcengine-ark");
  assert.deepEqual(
    await store.resolve(CREDENTIALS[2], { ARK_API_KEY: "env-ark" }),
    { key: "env-ark", source: "environment" },
  );
});
```

- [ ] **Step 2: Run the credential tests and verify failure**

Run:

```bash
npm test -- test/auth.test.ts
```

Expected: FAIL because `src/auth.ts` does not exist.

- [ ] **Step 3: Implement the credential store**

Expose a testable factory and production defaults:

```ts
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CredentialDefinition, CredentialId } from "./models/types.js";

export const AUTH_DIRECTORY = join(homedir(), ".coffee");
export const AUTH_PATH = join(AUTH_DIRECTORY, "auth.json");

interface AuthFile {
  version: 1;
  credentials: Partial<Record<CredentialId, { type: "api_key"; key: string }>>;
}

export interface ResolvedCredential {
  key: string;
  source: "auth-file" | "environment";
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return `${key.slice(0, 3)}${"•".repeat(6)}${key.slice(-4)}`;
}

export function createCredentialStore(authPath = AUTH_PATH) {
  const authDirectory = dirname(authPath);

  async function readAuthFile(): Promise<AuthFile> {
    try {
      const value = JSON.parse(await readFile(authPath, "utf8")) as unknown;
      if (typeof value !== "object" || value === null) throw new Error();
      const file = value as Partial<AuthFile>;
      if (file.version !== 1 || typeof file.credentials !== "object" || file.credentials === null) {
        throw new Error();
      }
      return file as AuthFile;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { version: 1, credentials: {} };
      }
      throw new Error("~/.coffee/auth.json 不是有效的凭证文件。");
    }
  }

  async function writeAuthFile(file: AuthFile): Promise<void> {
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await chmod(authDirectory, 0o700);
    await writeFile(authPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(authPath, 0o600);
  }

  async function getSavedApiKey(id: CredentialId): Promise<string | undefined> {
    return (await readAuthFile()).credentials[id]?.key.trim() || undefined;
  }

  return {
    getSavedApiKey,
    async saveApiKey(id: CredentialId, key: string): Promise<void> {
      const normalized = key.trim();
      if (!normalized) throw new Error("API Key 不能为空。");
      const file = await readAuthFile();
      file.credentials[id] = { type: "api_key", key: normalized };
      await writeAuthFile(file);
    },
    async deleteApiKey(id: CredentialId): Promise<boolean> {
      const file = await readAuthFile();
      const existed = file.credentials[id] !== undefined;
      delete file.credentials[id];
      if (existed) await writeAuthFile(file);
      return existed;
    },
    async resolve(
      definition: CredentialDefinition,
      env: NodeJS.ProcessEnv = process.env,
    ): Promise<ResolvedCredential | undefined> {
      const saved = await getSavedApiKey(definition.id);
      if (saved) return { key: saved, source: "auth-file" };
      for (const envKey of definition.envKeys) {
        const value = env[envKey]?.trim();
        if (value) return { key: value, source: "environment" };
      }
      return undefined;
    },
  };
}
```

- [ ] **Step 4: Run credential tests and type-check**

Run:

```bash
npm test -- test/auth.test.ts
npm run check
```

Expected: PASS; permission assertions pass on macOS.

### Task 3: Persist the active model in project settings

**Files:**

- Modify: `src/settings.ts`
- Modify: `test/settings.test.ts`

- [ ] **Step 1: Add failing settings tests**

Add tests proving that model settings are independent from animation settings:

```ts
test("loads and saves model preferences while preserving coffee settings", async () => {
  await writeFile(
    settingsPath,
    JSON.stringify({ "coffee-preferences": { animation: "latte" }, theme: "dark" }),
  );

  await saveModelPreference(settingsPath, {
    provider: "opencode-go",
    model: "kimi-k2.7-code",
  });

  assert.deepEqual(await loadModelPreference(settingsPath), {
    preference: { provider: "opencode-go", model: "kimi-k2.7-code" },
  });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    "coffee-preferences": { animation: "latte" },
    theme: "dark",
    "model-preferences": {
      provider: "opencode-go",
      model: "kimi-k2.7-code",
    },
  });
});

test("warns instead of accepting malformed model preferences", async () => {
  await writeFile(settingsPath, JSON.stringify({ "model-preferences": { provider: 1 } }));
  const loaded = await loadModelPreference(settingsPath);
  assert.equal(loaded.preference, undefined);
  assert.match(loaded.warning ?? "", /model-preferences/);
});
```

- [ ] **Step 2: Run settings tests and verify failure**

Run:

```bash
npm test -- test/settings.test.ts
```

Expected: FAIL because `loadModelPreference()` and `saveModelPreference()` are missing.

- [ ] **Step 3: Add model preference functions**

Add these exports without changing the existing animation behavior:

```ts
export interface ModelPreference {
  provider: string;
  model: string;
}

export interface LoadedModelPreference {
  preference?: ModelPreference;
  warning?: string;
}

export async function loadModelPreference(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedModelPreference> {
  const text = await readSettingsText(settingsPath);
  if (text === undefined) return {};
  let settings: JsonObject;
  try {
    settings = parseSettings(text);
  } catch (error) {
    return { warning: error instanceof Error ? error.message : String(error) };
  }
  const value = settings["model-preferences"];
  if (value === undefined) return {};
  if (!isObject(value) || typeof value.provider !== "string" || typeof value.model !== "string") {
    return { warning: "model-preferences 必须包含字符串 provider 和 model。" };
  }
  return { preference: { provider: value.provider, model: value.model } };
}

export async function saveModelPreference(
  settingsPath: string,
  preference: ModelPreference,
): Promise<void> {
  const text = await readSettingsText(settingsPath);
  const settings = text === undefined ? {} : parseSettings(text);
  settings["model-preferences"] = preference;
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}
```

- [ ] **Step 4: Run settings and existing animation tests**

Run:

```bash
npm test -- test/settings.test.ts
npm run check
```

Expected: every old and new settings test PASS.

### Task 4: Native-fetch OpenAI Completions adapter

**Files:**

- Create: `src/models/openai-completions.ts`
- Create: `test/openai-completions.test.ts`

- [ ] **Step 1: Write request, tool-call, and error mapping tests**

Use a fake fetch to capture the request and return controlled payloads:

```ts
test("posts neutral messages and tools to the selected model base URL", async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const gateway = createOpenAICompletionsGateway(async (input, init) => {
    calls.push({ input: String(input), init });
    return Response.json({ choices: [{ message: { content: "你好" } }] });
  });

  const reply = await gateway.complete({
    model: OPENCODE_GO_KIMI,
    apiKey: "secret",
    messages: [{ role: "user", content: "你好" }],
    tools: [],
  });

  assert.equal(calls[0]?.input, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(new Headers(calls[0]?.init?.headers).get("Authorization"), "Bearer secret");
  assert.equal(reply.content, "你好");
});

test("maps assistant tool calls into the neutral shape", async () => {
  const gateway = createOpenAICompletionsGateway(async () =>
    Response.json({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "calculator", arguments: "{\"expression\":\"2+2\"}" },
          }],
        },
      }],
    }),
  );
  const reply = await gateway.complete(baseRequest);
  assert.deepEqual(reply.toolCalls, [{
    id: "call-1",
    name: "calculator",
    argumentsJson: "{\"expression\":\"2+2\"}",
  }]);
});

for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "model"], [429, "rate_limit"], [503, "server"]] as const) {
  test(`maps HTTP ${status} to ${code}`, async () => {
    const gateway = createOpenAICompletionsGateway(async () =>
      Response.json({ error: { message: "provider detail" } }, { status }),
    );
    await assert.rejects(gateway.complete(baseRequest), (error: unknown) =>
      error instanceof ModelRequestError && error.code === code && error.status === status,
    );
  });
}
```

- [ ] **Step 2: Run adapter tests and verify failure**

Run:

```bash
npm test -- test/openai-completions.test.ts
```

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the adapter**

The adapter must:

1. Append `/chat/completions` to `model.baseUrl` after removing a trailing slash.
2. Convert neutral assistant tool calls to `tool_calls` and neutral tool results to `tool_call_id` messages.
3. Reuse `toOpenAICompatibleTools()` for tool definitions.
4. Add `thinking: { type: "disabled" }` only when `model.disableThinking === true`.
5. Parse provider error messages without exposing the API key.

Use this status mapping:

```ts
function codeForStatus(status: number): ModelErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model";
  if (status === 429) return "rate_limit";
  return "server";
}

function messageForError(model: ModelDefinition, status: number): string {
  const label = `${model.providerId}/${model.id}`;
  if (status === 401 || status === 403) {
    return `${label} 的凭证无效或没有访问权限，请使用 /login 更新凭证。`;
  }
  if (status === 404) return `${label} 不存在或当前套餐不支持。`;
  if (status === 429) return `${label} 的额度已用完或请求过于频繁。`;
  return `${label} 服务暂时异常 (${status})。`;
}
```

Wrap thrown fetch failures in `ModelRequestError` with code `network`; reject malformed success responses with code `invalid_response`.

- [ ] **Step 4: Run adapter tests and type-check**

Run:

```bash
npm test -- test/openai-completions.test.ts
npm run check
```

Expected: PASS with no TypeScript errors.

### Task 5: Refactor the agent around a mutable, protocol-neutral model

**Files:**

- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`

- [ ] **Step 1: Replace DeepSeek-specific agent tests with gateway-level tests**

Keep the existing tool-loop coverage, but inject a fake `ModelGateway`. Add these behaviors:

```ts
test("uses the selected model and preserves history after switching", async () => {
  const requests: ModelRequest[] = [];
  const gateway: ModelGateway = {
    async complete(request) {
      requests.push(request);
      return { content: requests.length === 1 ? "第一轮" : "第二轮", toolCalls: [] };
    },
  };
  const conversation = createConversation({
    initialModel: DEEPSEEK_FLASH,
    gateway,
    resolveApiKey: async () => "key",
    tavilyApiKey: "tvly-test",
  });

  await conversation.send("你好");
  conversation.setModel(OPENCODE_GO_KIMI);
  await conversation.send("继续");

  assert.equal(requests[0]?.model.providerId, "deepseek");
  assert.equal(requests[1]?.model.providerId, "opencode-go");
  assert.deepEqual(
    requests[1]?.messages.filter((message) => message.role === "user"),
    [{ role: "user", content: "你好" }, { role: "user", content: "继续" }],
  );
});

test("keeps one model for every tool round in a send call", async () => {
  const requestedModels: string[] = [];
  let round = 0;
  const gateway: ModelGateway = {
    async complete(request) {
      requestedModels.push(`${request.model.providerId}/${request.model.id}`);
      round += 1;
      if (round === 1) {
        return {
          toolCalls: [{
            id: "call-1",
            name: "calculator",
            argumentsJson: "{\"expression\":\"2+2\"}",
          }],
        };
      }
      return { content: "4", toolCalls: [] };
    },
  };
  const conversation = createConversation({
    initialModel: DEEPSEEK_FLASH,
    gateway,
    resolveApiKey: async () => "key",
    tavilyApiKey: "tvly-test",
  });

  assert.equal(await conversation.send("2+2"), "4");
  assert.deepEqual(requestedModels, [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash",
  ]);
});

test("rolls back the current turn after a model request error", async () => {
  const requests: ModelRequest[] = [];
  let call = 0;
  const gateway: ModelGateway = {
    async complete(request) {
      requests.push(request);
      call += 1;
      if (call === 2) throw new ModelRequestError("额度受限", "rate_limit", 429);
      return { content: `reply-${call}`, toolCalls: [] };
    },
  };
  const conversation = createConversation({
    initialModel: DEEPSEEK_FLASH,
    gateway,
    resolveApiKey: async () => "key",
    tavilyApiKey: "tvly-test",
  });

  await conversation.send("保留");
  await assert.rejects(conversation.send("失败消息"), /额度受限/);
  await conversation.send("继续");

  assert.equal(
    requests[2]?.messages.some(
      (message) => message.role === "user" && message.content === "失败消息",
    ),
    false,
  );
});

test("blocks chat locally when no model is selected", async () => {
  const conversation = createConversation({
    gateway,
    resolveApiKey: async () => undefined,
    tavilyApiKey: "tvly-test",
  });
  await assert.rejects(conversation.send("你好"), /先使用 \/login.*\/model/);
});
```

- [ ] **Step 2: Run agent tests and verify failure**

Run:

```bash
npm test -- test/agent.test.ts
```

Expected: FAIL because `Conversation` has no `setModel()` and still hardcodes DeepSeek.

- [ ] **Step 3: Refactor `createConversation()`**

Change the public interface to:

```ts
interface ConversationOptions {
  initialModel?: ModelDefinition;
  gateway: ModelGateway;
  resolveApiKey(credentialId: CredentialId): Promise<string | undefined>;
  tavilyApiKey?: string;
  fetchImpl?: FetchLike;
  onToolActivity?: (event: ToolActivityEvent) => void | Promise<void>;
}

export interface Conversation {
  send(input: string): Promise<string>;
  getModel(): ModelDefinition | undefined;
  setModel(model: ModelDefinition): void;
}
```

At the beginning of `send()` capture `const turnModel = activeModel`. Resolve its Provider credential ID through a callback supplied by the CLI; do not cache the key in the Conversation. Continue using the same `turnModel` throughout all tool rounds. Preserve the existing `messages.splice(turnStart)` rollback.

Replace DeepSeek-specific text with provider-neutral errors. Remove `API_URL`, `MODEL`, `DeepSeekResponse`, and direct `fetch` request code from `agent.ts`.

- [ ] **Step 4: Run agent and tool tests**

Run:

```bash
npm test -- test/agent.test.ts test/tools.test.ts test/tool-registry.test.ts
npm run check
```

Expected: PASS; existing tool behavior remains unchanged.

### Task 6: Pure login, logout, and model command helpers

**Files:**

- Create: `src/login-command.ts`
- Create: `src/logout-command.ts`
- Create: `src/model-command.ts`
- Create: `test/login-command.test.ts`
- Create: `test/logout-command.test.ts`
- Create: `test/model-command.test.ts`

- [ ] **Step 1: Write parser and renderer tests**

Keep interactive parsing separate from filesystem effects. Tests must cover numeric choice, escape/cancel, invalid input, credential source labels, and two-level model selection:

```ts
test("renders one shared OpenCode login entry", () => {
  const output = renderLoginMenu(CREDENTIALS, new Map([
    ["deepseek", { source: "environment", maskedKey: "sk-••••1234" }],
  ]));
  assert.equal((output.match(/OpenCode/g) ?? []).length, 1);
  assert.match(output, /DeepSeek.*已通过 \.env 配置/);
});

test("parses a login credential choice", () => {
  assert.equal(parseNumberedChoice("2", CREDENTIALS)?.id, "opencode");
  assert.equal(parseNumberedChoice("0", CREDENTIALS), undefined);
});

test("shows only authenticated model providers", () => {
  const providers = getModelMenuProviders(registry, new Set(["opencode"]));
  assert.deepEqual(providers.map((provider) => provider.id), ["opencode-go", "opencode-zen"]);
});

test("renders models only for the selected provider", () => {
  const provider = registry.getProvider("opencode-go")!;
  const output = renderModelMenu(provider, "kimi-k2.7-code");
  assert.match(output, /Kimi K2\.7 Code/);
  assert.doesNotMatch(output, /ark-code-latest/);
});
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
npm test -- test/login-command.test.ts test/logout-command.test.ts test/model-command.test.ts
```

Expected: FAIL because the command helper modules are missing.

- [ ] **Step 3: Implement deterministic helper functions**

Use one generic numbered-choice parser internally:

```ts
export function parseNumberedChoice<T>(
  input: string,
  items: readonly T[],
): T | undefined {
  const index = Number.parseInt(input.trim(), 10) - 1;
  return Number.isInteger(index) ? items[index] : undefined;
}
```

Required exports:

```ts
// login-command.ts
export interface CredentialStatus {
  source: "auth-file" | "environment";
  maskedKey: string;
}
export function renderLoginMenu(
  credentials: readonly CredentialDefinition[],
  statuses: ReadonlyMap<CredentialId, CredentialStatus>,
): string {
  return [
    "选择登录平台：",
    "",
    ...credentials.map((credential, index) => {
      const status = statuses.get(credential.id);
      const label = status
        ? status.source === "auth-file"
          ? `已登录 ${status.maskedKey}`
          : `已通过 .env 配置 ${status.maskedKey}`
        : "未登录";
      return `  ${index + 1}. ${credential.name}  ${label}`;
    }),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}
export function renderConfiguredLoginActions(status: CredentialStatus): string {
  const source = status.source === "auth-file" ? "~/.coffee/auth.json" : ".env";
  return [
    `当前凭证：${status.maskedKey}`,
    `来源：${source}`,
    "",
    "  1. 保留当前凭证",
    "  2. 更新 API Key",
    "  3. 取消",
    "",
    "请输入 1、2 或 3：",
  ].join("\n");
}

// logout-command.ts
export function getLogoutCandidates(
  credentials: readonly CredentialDefinition[],
  savedIds: ReadonlySet<CredentialId>,
): CredentialDefinition[] {
  return credentials.filter((credential) => savedIds.has(credential.id));
}
export function renderLogoutMenu(credentials: readonly CredentialDefinition[]): string {
  if (credentials.length === 0) return "没有保存在 ~/.coffee/auth.json 中的凭证。";
  return [
    "选择退出的平台：",
    "",
    ...credentials.map((credential, index) => `  ${index + 1}. ${credential.name}`),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}

// model-command.ts
export function getModelMenuProviders(
  registry: ModelRegistry,
  availableCredentialIds: ReadonlySet<CredentialId>,
): ProviderDefinition[] {
  return registry.getAvailableProviders((id) => availableCredentialIds.has(id));
}
export function renderProviderMenu(
  providers: readonly ProviderDefinition[],
  activeProviderId?: string,
): string {
  return [
    "选择模型平台：",
    "",
    ...providers.map((provider, index) =>
      `  ${index + 1}. ${provider.name}${provider.id === activeProviderId ? "  当前" : ""}`,
    ),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}
export function renderModelMenu(
  provider: ProviderDefinition,
  activeModelId?: string,
): string {
  return [
    `选择 ${provider.name} 模型：`,
    "",
    ...provider.models.map((model, index) =>
      `  ${index + 1}. ${model.name}${model.id === activeModelId ? "  当前" : ""}`,
    ),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}
```

Rendering must show `当前` for the active provider/model and use `已登录`, `已通过 .env 配置`, or `未登录` for credential state.

- [ ] **Step 4: Run helper tests and type-check**

Run:

```bash
npm test -- test/login-command.test.ts test/logout-command.test.ts test/model-command.test.ts
npm run check
```

Expected: PASS.

### Task 7: Masked API-key input and slash command registration

**Files:**

- Modify: `src/chat-input.ts`
- Modify: `src/commands.ts`
- Modify: `test/chat-input.test.ts`
- Modify: `test/commands.test.ts`

- [ ] **Step 1: Add failing input and command tests**

Add `/login`, `/logout`, and `/model` expectations to command filtering, typo suggestions, and help output. Add a pure secret renderer test:

```ts
test("renders secret input as bullets", () => {
  assert.equal(renderSecretValue("sk-secret"), "•••••••••");
});

test("registers model authentication commands", () => {
  assert.deepEqual(
    getCommandSuggestions("/lo").map((command) => command.name),
    ["/login", "/logout"],
  );
  assert.equal(resolveCommandInput("/modle").type, "suggestion");
  const help = renderAvailableCommands();
  assert.match(help, /\/login/);
  assert.match(help, /\/logout/);
  assert.match(help, /\/model/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm test -- test/chat-input.test.ts test/commands.test.ts
```

Expected: FAIL because the new commands and secret input are missing.

- [ ] **Step 3: Add `askSecret()` without another dependency**

Extend `InputController`:

```ts
export interface InputController {
  ask(message: string, suggestions?: boolean): Promise<string | undefined>;
  askSecret(message: string): Promise<string | undefined>;
  close(): void;
}

export function renderSecretValue(value: string): string {
  return "•".repeat(Array.from(value).length);
}

interface SecretPromptConfig {
  message: string;
}

const secretPrompt = createPrompt<string, SecretPromptConfig>((config, done) => {
  const [line, setLine] = useState("");

  useKeypress((key, readline) => {
    if (isEnterKey(key)) {
      done(line);
      return;
    }
    setLine(readline.line);
  });

  return `${config.message}${renderSecretValue(line)}`;
});
```

Add `askSecret()` to the object returned by `createInputController()`. In TTY mode call `secretPrompt({ message }, { input, output, signal })`. In non-TTY mode use the same queued-line read path as `ask()`; piped stdin does not echo input. Factor that path into one local `readPlainLine(message)` helper so `ask()` and `askSecret()` do not duplicate queue/abort handling. Catch `AbortPromptError` and `ExitPromptError` exactly as `ask()` already does.

Update `CommandDefinition["name"]` and `COMMANDS`:

```ts
export interface CommandDefinition {
  name: "/login" | "/logout" | "/model" | "/like" | "/exit";
  description: string;
  acceptsArguments: boolean;
}
```

All three new commands have `acceptsArguments: false`. Their descriptions are `登录模型平台`, `退出模型平台`, and `切换模型`.

- [ ] **Step 4: Run input and command tests**

Run:

```bash
npm test -- test/chat-input.test.ts test/commands.test.ts
npm run check
```

Expected: PASS; `/likes` still suggests `/like` rather than `/login`.

### Task 8: Integrate `/login`, `/logout`, and `/model` into the CLI

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Expand the CLI harness to isolate HOME and settings**

Change `runCli()` to create a temporary HOME/auth path per test and accept an environment map. Do not let tests read or write the developer's real `~/.coffee/auth.json`.

Add end-to-end tests with piped numeric menu input:

```ts
test("starts without a model API key so the user can login", async () => {
  const result = await runCli({ TAVILY_API_KEY: "tvly-test" }, "/exit\n");
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.stderr, /DEEPSEEK_API_KEY/);
});

test("logs into OpenCode once and exposes Go and Zen in model selection", async () => {
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    "/login\n2\nopencode-secret\n/model\n1\n1\n/exit\n",
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /OpenCode.*凭证已保存/);
  assert.match(result.stdout, /OpenCode Go/);
  assert.match(result.stdout, /OpenCode Zen/);
});

test("persists a selected model and keeps unrelated settings", async () => {
  await withCliSandbox(async ({ home, settingsPath }) => {
    await writeFile(
      settingsPath,
      `${JSON.stringify({ "coffee-preferences": { animation: "latte" } }, null, 2)}\n`,
    );
    const authDirectory = path.join(home, ".coffee");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      path.join(authDirectory, "auth.json"),
      `${JSON.stringify({
        version: 1,
        credentials: { opencode: { type: "api_key", key: "opencode-secret" } },
      }, null, 2)}\n`,
    );

    const result = await runCli(
      { HOME: home, TAVILY_API_KEY: "tvly-test" },
      "/model\n1\n6\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      "coffee-preferences": { animation: "latte" },
      "model-preferences": {
        provider: "opencode-go",
        model: "kimi-k2.7-code",
      },
    });
  });
});

test("logout removes the saved key but reports environment fallback", async () => {
  await withCliSandbox(async ({ home }) => {
    const authDirectory = path.join(home, ".coffee");
    const authPath = path.join(authDirectory, "auth.json");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify({
        version: 1,
        credentials: { deepseek: { type: "api_key", key: "saved-key" } },
      }, null, 2)}\n`,
    );

    const result = await runCli(
      {
        HOME: home,
        DEEPSEEK_API_KEY: "env-key",
        TAVILY_API_KEY: "tvly-test",
      },
      "/logout\n1\n/exit\n",
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\.env 中的凭证仍然生效/);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      version: 1,
      credentials: {},
    });
  });
});

test("blocks chat locally when no provider is logged in", async () => {
  const result = await runCli(
    { TAVILY_API_KEY: "tvly-test" },
    "你好\n/exit\n",
  );
  assert.match(result.stderr, /先使用 \/login.*\/model/);
  assert.doesNotMatch(result.stderr, /意外的网络请求/);
});
```

Use this helper in the test file so no test touches the real home directory:

```ts
async function withCliSandbox(
  run: (paths: { home: string; settingsPath: string }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "coffee-home-"));
  const settingsPath = path.resolve("coffee.settings.json");
  let originalSettings: string | undefined;
  try {
    originalSettings = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }

  try {
    await run({ home, settingsPath });
  } finally {
    await rm(home, { recursive: true, force: true });
    if (originalSettings === undefined) {
      await rm(settingsPath, { force: true });
    } else {
      await writeFile(settingsPath, originalSettings);
    }
  }
}
```

Import `mkdir`, `mkdtemp`, `readFile`, `rm`, and `writeFile` from `node:fs/promises`, plus `os` and `path`.

- [ ] **Step 2: Run CLI tests and verify failure**

Run:

```bash
npm test -- test/cli.test.ts
```

Expected: new tests FAIL; existing CLI still exits when `DEEPSEEK_API_KEY` is missing.

- [ ] **Step 3: Build CLI services before the input loop**

Create one registry and credential store:

```ts
const registry = createModelRegistry(CREDENTIALS, PROVIDERS);
const credentialStore = createCredentialStore();
const gateway = createOpenAICompletionsGateway();
```

Resolve the startup model in this order:

1. Saved `model-preferences` if the model exists and its credential resolves.
2. `deepseek/deepseek-v4-flash` if DeepSeek resolves.
3. The first model of the first provider whose credential resolves.
4. `undefined` when no credential exists.

Create the Conversation even when the initial model is undefined. Keep the existing Tavily requirement and activity renderer behavior.

- [ ] **Step 4: Implement `/login` orchestration**

For each credential definition resolve status and render one numbered menu. If unconfigured, call `askSecret()` and save a non-empty key. If configured, render actions:

```text
1. 保留当前凭证
2. 更新 API Key
3. 取消
```

Saving OpenCode under credential ID `opencode` automatically makes both model providers available. `/login` never calls `conversation.setModel()`.

- [ ] **Step 5: Implement `/logout` orchestration**

Only list credential IDs that exist in `auth.json`; do not claim an environment credential can be deleted. After deletion, resolve the credential again. If an environment key remains, print:

```text
已删除保存的凭证，但项目 .env 中的凭证仍然生效。
```

If the active model loses all credentials, retain its model selection but let the next chat produce the local login guidance. Do not silently switch providers during logout.

- [ ] **Step 6: Implement transactional `/model` orchestration**

Resolve all credentials, derive available Provider entries, and ask for provider then model. Do not modify state until both choices are valid. Then:

```ts
await saveModelPreference(SETTINGS_PATH, {
  provider: selectedProvider.id,
  model: selectedModel.id,
});
conversation.setModel(selectedModel);
```

If settings saving fails, do not call `setModel()`. On success print the selected provider/model. Existing conversation history remains inside the Conversation object.

- [ ] **Step 7: Run CLI, agent, and command tests**

Run:

```bash
npm test -- test/cli.test.ts test/agent.test.ts test/commands.test.ts
npm run check
```

Expected: PASS; no tests access the real home directory or network.

### Task 9: Documentation and full regression verification

**Files:**

- Modify: `README.md`
- Verify: all `src/**/*.ts` and `test/*.test.ts`

- [ ] **Step 1: Update README configuration and command documentation**

Document:

```md
## 模型平台

Coffee 支持 DeepSeek、OpenCode Go、OpenCode Zen 和方舟 Coding Plan。

- `/login`：添加或更新平台 API Key
- `/logout`：删除保存在 `~/.coffee/auth.json` 中的平台凭证
- `/model`：从已登录平台中切换模型

交互输入的 API Key 保存在 `~/.coffee/auth.json`。目录权限为 `0700`，文件权限为 `0600`。也可以继续在项目 `.env` 中配置：

DEEPSEEK_API_KEY=...
OPENCODE_API_KEY=...
ARK_API_KEY=...
TAVILY_API_KEY=...

OpenCode Go 和 Zen 共用一个 `OPENCODE_API_KEY`。模型选择保存在项目根目录 `coffee.settings.json`，其中不包含 API Key。
```

Remove wording that says Coffee always uses one fixed DeepSeek model. Explain that the first release only lists models supported through OpenAI Chat Completions.

- [ ] **Step 2: Scan for obsolete DeepSeek coupling and secret leakage**

Run:

```bash
rg -n "API_URL|const MODEL|DeepSeek API|DEEPSEEK_API_KEY" src test README.md
rg -n "console\.(log|error).*apiKey|JSON\.stringify\(.*apiKey" src
```

Expected:

- No hardcoded `API_URL`, fixed `MODEL`, or `DeepSeek API` errors remain in `src/agent.ts`.
- `DEEPSEEK_API_KEY` appears only in the catalog, documentation, and tests that exercise environment fallback.
- No logging statement prints an API key.

- [ ] **Step 3: Run the full automated suite**

Run:

```bash
npm test
npm run check
```

Expected: all tests PASS and `tsc --noEmit` exits 0.

- [ ] **Step 4: Perform a local no-network CLI smoke test**

Run:

```bash
env -u DEEPSEEK_API_KEY -u OPENCODE_API_KEY -u ARK_API_KEY npm start
```

Manually verify:

1. Coffee starts instead of exiting for a missing model credential.
2. `/` autocomplete includes `/login`, `/logout`, and `/model`.
3. `/login` masks typed characters.
4. Canceling a menu leaves the current model unchanged.
5. Ctrl+C exits cleanly without an AbortError stack trace.

Do not enter or save a real API key during this no-network smoke test.
