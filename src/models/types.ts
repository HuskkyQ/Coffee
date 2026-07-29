import type { ToolDefinition } from "../tool-registry.js";

export type ModelApi = "openai-completions";

export type CredentialId = "deepseek" | "opencode" | "volcengine-ark";

export interface CredentialDefinition {
  readonly id: CredentialId;
  readonly name: string;
  readonly envKeys: readonly string[];
}

export interface ModelDefinition {
  readonly id: string;
  readonly name: string;
  readonly providerId: string;
  readonly credentialId: CredentialId;
  readonly api: ModelApi;
  readonly baseUrl: string;
  readonly disableThinking?: boolean;
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
}

export interface ProviderDefinition {
  readonly id: string;
  readonly name: string;
  readonly credentialId: CredentialId;
  readonly models: readonly ModelDefinition[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelReasoningField =
  | "reasoning_content"
  | "reasoning"
  | "reasoning_text";

export interface ModelReasoning {
  readonly providerId: string;
  readonly field?: ModelReasoningField;
  readonly text?: string;
  readonly details?: readonly unknown[];
}

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: readonly ModelToolCall[];
      reasoning?: ModelReasoning;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface ModelReply {
  content?: string;
  toolCalls: ModelToolCall[];
  reasoning?: ModelReasoning;
}

export type ModelStreamEvent =
  | { readonly type: "start" }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "reasoning_delta";
      readonly field: ModelReasoningField;
      readonly delta: string;
    }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | {
      readonly type: "reasoning_details";
      readonly details: readonly unknown[];
    }
  | { readonly type: "fallback" }
  | { readonly type: "done"; readonly reply: ModelReply };

export interface ModelRequest {
  model: ModelDefinition;
  apiKey: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelGateway {
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
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
