import type { SelectionItem } from "./chat-input.js";
import { parseNumberedChoice } from "./login-command.js";
import type { ModelRegistry } from "./models/registry.js";
import type {
  CredentialId,
  ModelDefinition,
  ProviderDefinition,
} from "./models/types.js";

export function getModelMenuProviders(
  registry: ModelRegistry,
  availableCredentialIds: ReadonlySet<CredentialId>,
): readonly ProviderDefinition[] {
  return registry.getAvailableProviders((credentialId) =>
    availableCredentialIds.has(credentialId),
  );
}

export function getProviderSelectionItems(
  providers: readonly ProviderDefinition[],
  activeProviderId?: string,
): SelectionItem<ProviderDefinition>[] {
  return providers.map((provider) => ({
    label: provider.name,
    value: provider,
    status: provider.id === activeProviderId ? "当前" : undefined,
  }));
}

export function getModelSelectionItems(
  provider: ProviderDefinition,
  activeModelId?: string,
): SelectionItem<ModelDefinition>[] {
  return provider.models.map((model) => ({
    label: model.name,
    value: model,
    status: model.id === activeModelId ? "当前" : undefined,
  }));
}

export function renderProviderMenu(
  providers: readonly ProviderDefinition[],
  activeProviderId?: string,
): string {
  if (providers.length === 0) {
    return "没有可用的模型平台，请先使用 /login 登录。";
  }

  return [
    "选择模型平台：",
    "",
    ...providers.map(
      (provider, index) =>
        `  ${index + 1}. ${provider.name}${
          provider.id === activeProviderId ? "  当前" : ""
        }`,
    ),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}

export function parseProviderChoice(
  input: string,
  providers: readonly ProviderDefinition[],
): ProviderDefinition | undefined {
  return parseNumberedChoice(input, providers);
}

export function renderModelMenu(
  provider: ProviderDefinition,
  activeModelId?: string,
): string {
  return [
    `选择 ${provider.name} 模型：`,
    "",
    ...provider.models.map(
      (model, index) =>
        `  ${index + 1}. ${model.name}${
          model.id === activeModelId ? "  当前" : ""
        }`,
    ),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}

export function parseModelChoice(
  input: string,
  provider: ProviderDefinition,
): ModelDefinition | undefined {
  return parseNumberedChoice(input, provider.models);
}
