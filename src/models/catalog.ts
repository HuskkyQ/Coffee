import type {
  CredentialDefinition,
  CredentialId,
  ModelDefinition,
  ProviderDefinition,
} from "./types.js";

export const CREDENTIALS = [
  { id: "deepseek", name: "DeepSeek", envKeys: ["DEEPSEEK_API_KEY"] },
  { id: "opencode", name: "OpenCode", envKeys: ["OPENCODE_API_KEY"] },
  {
    id: "volcengine-ark",
    name: "方舟 Agent Plan",
    envKeys: ["ARK_API_KEY"],
  },
] as const satisfies readonly CredentialDefinition[];

const BASE_URLS = {
  deepseek: "https://api.deepseek.com",
  opencodeGo: "https://opencode.ai/zen/go/v1",
  opencodeZen: "https://opencode.ai/zen/v1",
  ark: "https://ark.cn-beijing.volces.com/api/plan/v3",
} as const;

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-flash-free": "DeepSeek V4 Flash Free",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "doubao-seed-2.0-lite": "Doubao Seed 2.0 Lite",
  "doubao-seed-2.0-mini": "Doubao Seed 2.0 Mini",
  "doubao-seed-2.1-turbo": "Doubao Seed 2.1 Turbo",
  "doubao-seed-evolving": "Doubao Seed Evolving",
  "glm-5": "GLM-5",
  "glm-5.1": "GLM-5.1",
  "glm-5.2": "GLM-5.2",
  "glm-latest": "GLM Latest",
  "kimi-k2.5": "Kimi K2.5",
  "kimi-k2.6": "Kimi K2.6",
  "kimi-k2.7-code": "Kimi K2.7 Code",
  "kimi-k3": "Kimi K3",
  "mimo-v2.5": "MiMo V2.5",
  "mimo-v2.5-free": "MiMo V2.5 Free",
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
    requiresReasoningContentOnAssistantMessages: id.startsWith(
      "deepseek-v4",
    ),
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

const ARK_AGENT_PLAN_IDS = [
  "ark-code-latest",
  "doubao-seed-2.1-turbo",
  "doubao-seed-evolving",
  "glm-5.2",
  "glm-latest",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "doubao-seed-2.0-lite",
  "doubao-seed-2.0-mini",
  "minimax-m2.7",
  "minimax-m3",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "kimi-k3",
] as const;

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    credentialId: "deepseek",
    models: createModels(
      "deepseek",
      "deepseek",
      BASE_URLS.deepseek,
      DEEPSEEK_IDS,
    ),
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    credentialId: "opencode",
    models: createModels(
      "opencode-go",
      "opencode",
      BASE_URLS.opencodeGo,
      OPENCODE_GO_IDS,
    ),
  },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    credentialId: "opencode",
    models: createModels(
      "opencode-zen",
      "opencode",
      BASE_URLS.opencodeZen,
      OPENCODE_ZEN_IDS,
    ),
  },
  {
    id: "volcengine-ark",
    name: "方舟 Agent Plan",
    credentialId: "volcengine-ark",
    models: createModels(
      "volcengine-ark",
      "volcengine-ark",
      BASE_URLS.ark,
      ARK_AGENT_PLAN_IDS,
    ),
  },
];
