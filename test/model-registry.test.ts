import assert from "node:assert/strict";
import test from "node:test";

import { CREDENTIALS, PROVIDERS } from "../src/models/catalog.js";
import { createModelRegistry } from "../src/models/registry.js";
import type {
  CredentialDefinition,
  CredentialId,
  ModelDefinition,
  ProviderDefinition,
} from "../src/models/types.js";

function makeMutableRegistryInput() {
  const credential = {
    id: "deepseek" as const,
    name: "Original credential",
    envKeys: ["ORIGINAL_API_KEY"],
  };
  const model = {
    id: "original-model",
    name: "Original model",
    providerId: "original-provider",
    credentialId: "deepseek" as const,
    api: "openai-completions" as const,
    baseUrl: "https://original.example.com",
  };
  const provider = {
    id: "original-provider",
    name: "Original provider",
    credentialId: "deepseek" as const,
    models: [model],
  };

  return {
    credential,
    credentials: [credential],
    model,
    provider,
    providers: [provider],
  };
}

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

test("returns both OpenCode providers in catalog order", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

  assert.deepEqual(
    registry
      .getAvailableProviders((credentialId) => credentialId === "opencode")
      .map((provider) => provider.id),
    ["opencode-go", "opencode-zen"],
  );
});

test("preserves catalog order and supports direct lookups", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

  assert.deepEqual(
    registry.getCredentials().map((credential) => credential.id),
    ["deepseek", "opencode", "volcengine-ark"],
  );
  assert.equal(registry.getCredential("opencode")?.name, "OpenCode");
  assert.deepEqual(
    registry.getProviders().map((provider) => provider.id),
    ["deepseek", "opencode-go", "opencode-zen", "volcengine-ark"],
  );
  assert.equal(registry.getProvider("missing"), undefined);
  assert.equal(registry.getModel("opencode-go", "missing"), undefined);
});

test("configures Volcengine Agent Plan with its dedicated Chat API base URL", () => {
  const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

  assert.equal(
    registry.getCredential("volcengine-ark")?.name,
    "方舟 Agent Plan",
  );
  assert.equal(
    registry.getProvider("volcengine-ark")?.name,
    "方舟 Agent Plan",
  );
  assert.equal(
    registry.getModel("volcengine-ark", "ark-code-latest")?.baseUrl,
    "https://ark.cn-beijing.volces.com/api/plan/v3",
  );
});

test("isolates registry metadata from later input mutations", () => {
  const input = makeMutableRegistryInput();
  const registry = createModelRegistry(input.credentials, input.providers);

  input.credentials.length = 0;
  input.providers.length = 0;
  input.credential.name = "Changed credential";
  input.credential.envKeys[0] = "CHANGED_API_KEY";
  input.provider.name = "Changed provider";
  input.model.name = "Changed model";
  input.model.baseUrl = "https://changed.example.com";

  assert.equal(registry.getCredentials().length, 1);
  assert.equal(registry.getCredential("deepseek")?.name, "Original credential");
  assert.deepEqual(registry.getCredential("deepseek")?.envKeys, [
    "ORIGINAL_API_KEY",
  ]);
  assert.equal(registry.getProviders().length, 1);
  assert.equal(
    registry.getProvider("original-provider")?.name,
    "Original provider",
  );
  assert.equal(
    registry.getModel("original-provider", "original-model")?.name,
    "Original model",
  );
  assert.equal(
    registry.getModel("original-provider", "original-model")?.baseUrl,
    "https://original.example.com",
  );
});

test("exposes immutable registry metadata collections", () => {
  const input = makeMutableRegistryInput();
  const registry = createModelRegistry(input.credentials, input.providers);
  const provider = registry.getProvider("original-provider")!;

  assert.throws(() =>
    (registry.getCredentials() as CredentialDefinition[]).push(
      registry.getCredential("deepseek")!,
    ),
  );
  assert.throws(() =>
    (registry.getProviders() as ProviderDefinition[]).push(provider),
  );
  assert.throws(() =>
    (provider.models as ModelDefinition[]).push(provider.models[0]!),
  );
  assert.throws(() =>
    (
      registry.getAvailableProviders(() => true) as ProviderDefinition[]
    ).push(provider),
  );
  assert.throws(() => {
    (provider as { name: string }).name = "Changed provider";
  });
});

test("rejects duplicate provider ids", () => {
  assert.throws(
    () => createModelRegistry(CREDENTIALS, [PROVIDERS[0]!, PROVIDERS[0]!]),
    /重复的平台: deepseek/,
  );
});

test("rejects duplicate credential ids", () => {
  assert.throws(
    () => createModelRegistry([CREDENTIALS[0]!, CREDENTIALS[0]!], []),
    /重复的凭证: deepseek/,
  );
});

test("rejects duplicate model ids within a provider", () => {
  const provider = PROVIDERS[0]!;
  const duplicateModels: ProviderDefinition = {
    ...provider,
    models: [provider.models[0]!, provider.models[0]!],
  };

  assert.throws(
    () => createModelRegistry(CREDENTIALS, [duplicateModels]),
    /重复的模型: deepseek\/deepseek-v4-flash/,
  );
});

test("rejects providers with an unknown credential id", () => {
  const provider: ProviderDefinition = {
    ...PROVIDERS[0]!,
    credentialId: "missing" as CredentialId,
  };

  assert.throws(
    () => createModelRegistry(CREDENTIALS, [provider]),
    /引用了未知凭证: missing/,
  );
});

test("rejects a model whose provider id does not match its owner", () => {
  const provider = PROVIDERS[0]!;
  const model: ModelDefinition = {
    ...provider.models[0]!,
    providerId: "another-provider",
  };

  assert.throws(
    () => createModelRegistry(CREDENTIALS, [{ ...provider, models: [model] }]),
    /providerId 不匹配/,
  );
});

test("rejects a model whose credential id does not match its owner", () => {
  const provider = PROVIDERS[0]!;
  const model: ModelDefinition = {
    ...provider.models[0]!,
    credentialId: "opencode",
  };

  assert.throws(
    () => createModelRegistry(CREDENTIALS, [{ ...provider, models: [model] }]),
    /credentialId 不匹配.*平台 deepseek.*模型 opencode/,
  );
});

test("catalog exposes the exact model ids and base URLs for each provider", () => {
  const expected = [
    {
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      modelIds: ["deepseek-v4-flash", "deepseek-v4-pro"],
    },
    {
      providerId: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      modelIds: [
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
      ],
    },
    {
      providerId: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      modelIds: [
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
      ],
    },
    {
      providerId: "volcengine-ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
      modelIds: [
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
      ],
    },
  ];

  assert.deepEqual(
    PROVIDERS.map((provider) => ({
      providerId: provider.id,
      baseUrl: provider.models[0]?.baseUrl,
      modelIds: provider.models.map((model) => model.id),
    })),
    expected,
  );

  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      assert.equal(model.baseUrl, provider.models[0]?.baseUrl);
    }
  }
});

test("catalog models match their owner and disable thinking for DeepSeek V4", () => {

  for (const provider of PROVIDERS) {
    for (const model of provider.models) {
      assert.equal(model.providerId, provider.id);
      assert.equal(model.credentialId, provider.credentialId);
      assert.equal(model.api, "openai-completions");
      assert.equal(
        model.disableThinking,
        model.id.startsWith("deepseek-v4"),
      );
    }
  }
});
