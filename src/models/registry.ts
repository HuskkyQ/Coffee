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
  ): readonly ProviderDefinition[];
}

export function createModelRegistry(
  credentials: readonly CredentialDefinition[],
  providers: readonly ProviderDefinition[],
): ModelRegistry {
  const credentialSnapshots: readonly CredentialDefinition[] = Object.freeze(
    credentials.map((credential) =>
      Object.freeze({
        ...credential,
        envKeys: Object.freeze([...credential.envKeys]),
      }),
    ),
  );
  const providerSnapshots: readonly ProviderDefinition[] = Object.freeze(
    providers.map((provider) =>
      Object.freeze({
        ...provider,
        models: Object.freeze(
          provider.models.map((model) => Object.freeze({ ...model })),
        ),
      }),
    ),
  );
  const credentialsById = new Map<CredentialId, CredentialDefinition>();
  for (const credential of credentialSnapshots) {
    if (credentialsById.has(credential.id)) {
      throw new Error(`重复的凭证: ${credential.id}`);
    }
    credentialsById.set(credential.id, credential);
  }
  const providersById = new Map<string, ProviderDefinition>();

  for (const provider of providerSnapshots) {
    if (providersById.has(provider.id)) {
      throw new Error(`重复的平台: ${provider.id}`);
    }
    if (!credentialsById.has(provider.credentialId)) {
      throw new Error(
        `平台 ${provider.id} 引用了未知凭证: ${provider.credentialId}`,
      );
    }

    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (modelIds.has(model.id)) {
        throw new Error(`重复的模型: ${provider.id}/${model.id}`);
      }
      if (!credentialsById.has(model.credentialId)) {
        throw new Error(
          `模型 ${provider.id}/${model.id} 引用了未知凭证: ${model.credentialId}`,
        );
      }
      if (model.credentialId !== provider.credentialId) {
        throw new Error(
          `模型 ${provider.id}/${model.id} 的 credentialId 不匹配: ` +
            `平台 ${provider.credentialId}, 模型 ${model.credentialId}`,
        );
      }
      if (model.providerId !== provider.id) {
        throw new Error(`模型 ${model.id} 的 providerId 不匹配`);
      }
      modelIds.add(model.id);
    }

    providersById.set(provider.id, provider);
  }

  return {
    getCredentials: () => credentialSnapshots,
    getCredential: (id) => credentialsById.get(id),
    getProviders: () => providerSnapshots,
    getProvider: (id) => providersById.get(id),
    getModel: (providerId, modelId) =>
      providersById
        .get(providerId)
        ?.models.find((model) => model.id === modelId),
    getAvailableProviders: (hasCredential) =>
      Object.freeze(
        providerSnapshots.filter((provider) =>
          hasCredential(provider.credentialId),
        ),
      ),
  };
}
