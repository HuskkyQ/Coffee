import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelSelectionItems,
  getModelMenuProviders,
  getProviderSelectionItems,
  parseModelChoice,
  parseProviderChoice,
  renderModelMenu,
  renderProviderMenu,
} from "../src/model-command.js";
import { CREDENTIALS, PROVIDERS } from "../src/models/catalog.js";
import { createModelRegistry } from "../src/models/registry.js";
import type {
  CredentialId,
  ProviderDefinition,
} from "../src/models/types.js";

const registry = createModelRegistry(CREDENTIALS, PROVIDERS);

test("builds provider and model selection items with current status", () => {
  const providers = [PROVIDERS[0]!, PROVIDERS[1]!];
  const providerItems = getProviderSelectionItems(providers, "deepseek");
  const modelItems = getModelSelectionItems(
    providers[0]!,
    "deepseek-v4-pro",
  );

  assert.strictEqual(providerItems[0]?.value, providers[0]);
  assert.equal(providerItems[0]?.status, "当前");
  assert.equal(providerItems[1]?.status, undefined);
  assert.strictEqual(modelItems[1]?.value, providers[0]?.models[1]);
  assert.equal(modelItems[1]?.status, "当前");
});

test("opens both OpenCode providers for the shared credential", () => {
  const providers = getModelMenuProviders(
    registry,
    new Set<CredentialId>(["opencode"]),
  );

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["opencode-go", "opencode-zen"],
  );
});

test("preserves registry order for multiple available credentials", () => {
  const credentials = new Set<CredentialId>([
    "volcengine-ark",
    "deepseek",
    "opencode",
  ]);

  assert.deepEqual(
    getModelMenuProviders(registry, credentials).map(
      (provider) => provider.id,
    ),
    ["deepseek", "opencode-go", "opencode-zen", "volcengine-ark"],
  );
  assert.deepEqual([...credentials], [
    "volcengine-ark",
    "deepseek",
    "opencode",
  ]);
});

test("returns no providers when no credentials are available", () => {
  assert.deepEqual(getModelMenuProviders(registry, new Set()), []);
});

test("renders providers in input order and marks the active provider", () => {
  const providers: ProviderDefinition[] = [PROVIDERS[2]!, PROVIDERS[0]!];
  const original = [...providers];

  const output = renderProviderMenu(providers, "deepseek");
  const lines = output.split("\n");

  assert.ok(lines.some((line) => /1\. OpenCode Zen$/.test(line)));
  assert.ok(lines.some((line) => /2\. DeepSeek\s+当前$/.test(line)));
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /输入序号/);
  assert.deepEqual(providers, original);
});

test("asks the user to login when the provider menu is empty", () => {
  const output = renderProviderMenu([]);

  assert.match(output, /没有可用的模型平台/);
  assert.match(output, /先使用 \/login/);
  assert.equal(output.includes("\u001b"), false);
});

test("parses provider choices at one-based boundaries", () => {
  const providers = [PROVIDERS[0]!, PROVIDERS[1]!];

  assert.equal(parseProviderChoice(" 1 ", providers)?.id, "deepseek");
  assert.equal(parseProviderChoice("2", providers)?.id, "opencode-go");
  for (const input of ["", "0", "3", "provider", "\u001b"]) {
    assert.equal(parseProviderChoice(input, providers), undefined);
  }
});

test("renders only the selected provider models and marks the active model", () => {
  const provider = registry.getProvider("opencode-go")!;
  const originalModels = [...provider.models];

  const output = renderModelMenu(provider, "kimi-k2.7-code");
  const activeLine = output
    .split("\n")
    .find((line) => line.includes("Kimi K2.7 Code"));

  assert.match(output, /选择 OpenCode Go 模型/);
  assert.match(output, /DeepSeek V4 Flash/);
  assert.match(activeLine ?? "", /当前$/);
  assert.doesNotMatch(output, /Ark Code Latest/);
  assert.doesNotMatch(output, /Big Pickle/);
  assert.equal(output.includes("\u001b"), false);
  assert.deepEqual(provider.models, originalModels);
});

test("renders every supported Agent Plan Chat model as a selectable option", () => {
  const provider = registry.getProvider("volcengine-ark")!;
  const output = renderModelMenu(provider, "ark-code-latest");

  for (const name of [
    "Ark Code Latest",
    "Doubao Seed 2.1 Turbo",
    "Doubao Seed Evolving",
    "GLM-5.2",
    "GLM Latest",
    "DeepSeek V4 Flash",
    "DeepSeek V4 Pro",
    "Doubao Seed 2.0 Lite",
    "Doubao Seed 2.0 Mini",
    "MiniMax M2.7",
    "MiniMax M3",
    "Kimi K2.6",
    "Kimi K2.7 Code",
    "Kimi K3",
  ]) {
    assert.match(output, new RegExp(name.replaceAll(".", "\\.")));
  }

  assert.equal(parseModelChoice("14", provider)?.id, "kimi-k3");
});

test("parses model choices at one-based boundaries", () => {
  const provider = registry.getProvider("deepseek")!;

  assert.equal(
    parseModelChoice(" 1 ", provider)?.id,
    "deepseek-v4-flash",
  );
  assert.equal(parseModelChoice("2", provider)?.id, "deepseek-v4-pro");
  for (const input of ["", "0", "3", "model", "\u001b"]) {
    assert.equal(parseModelChoice(input, provider), undefined);
  }
});
