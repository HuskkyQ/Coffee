import { toOpenAICompatibleTools } from "../model-adapters/openai-compatible-tools.js";
import { readSseData } from "./sse.js";
import {
  ModelRequestError,
  type ModelGateway,
  type ModelMessage,
  type ModelReasoning,
  type ModelReasoningField,
  type ModelReply,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelToolCall,
} from "./types.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function context(request: ModelRequest): string {
  return `提供商 ${request.model.providerId} 的模型 ${request.model.id}`;
}

function invalidResponse(request: ModelRequest): ModelRequestError {
  return new ModelRequestError(
    `${context(request)} 返回了无效响应。`,
    "invalid_response",
  );
}

function statusError(request: ModelRequest, status: number): ModelRequestError {
  if (status === 401 || status === 403) {
    return new ModelRequestError(
      `${context(request)} 认证失败（HTTP ${status}）。请使用 /login 重新登录。`,
      "auth",
      status,
    );
  }
  if (status === 404) {
    return new ModelRequestError(
      `${context(request)} 不可用：当前套餐不支持该模型（HTTP 404）。`,
      "model",
      status,
    );
  }
  if (status === 429) {
    return new ModelRequestError(
      `${context(request)} 请求受限（HTTP 429）。请检查额度或稍后重试以降低请求频率。`,
      "rate_limit",
      status,
    );
  }
  return new ModelRequestError(
    `${context(request)} 服务异常（HTTP ${status}）。请稍后重试。`,
    "server",
    status,
  );
}

const REASONING_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
] as const satisfies readonly ModelReasoningField[];

function requiresReasoningContent(model: ModelRequest["model"]): boolean {
  return model.requiresReasoningContentOnAssistantMessages === true;
}

function mapMessage(
  message: ModelMessage,
  model: ModelRequest["model"],
): Record<string, unknown> {
  if (message.role === "assistant") {
    const mapped: Record<string, unknown> = {
      role: "assistant",
      content: message.content,
    };
    if (message.toolCalls.length > 0) {
      mapped.tool_calls = message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsJson,
        },
      }));
    }
    if (message.reasoning?.providerId === model.providerId) {
      const { field, text, details } = message.reasoning;
      if (field !== undefined && text !== undefined) {
        const replayField =
          model.providerId === "opencode-go" && field === "reasoning"
            ? "reasoning_content"
            : field;
        mapped[replayField] = text;
      }
      if (details !== undefined) {
        mapped.reasoning_details = structuredClone(details);
      }
    }
    if (
      requiresReasoningContent(model) &&
      mapped.reasoning_content === undefined
    ) {
      mapped.reasoning_content = "";
    }
    return mapped;
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function requestBody(
  request: ModelRequest,
  streaming: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: request.messages.map((message) =>
      mapMessage(message, request.model),
    ),
  };
  if (streaming) {
    body.stream = true;
  }
  if (request.tools.length > 0) {
    body.tools = toOpenAICompatibleTools(request.tools);
    body.tool_choice = "auto";
  }
  if (request.model.disableThinking === true) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  try {
    return isRecord(error) && error.name === "AbortError";
  } catch {
    return false;
  }
}

function safeAbortError(): Error {
  const error = new Error("请求已取消。");
  error.name = "AbortError";
  return error;
}

async function fetchCompletion(
  fetchImpl: FetchLike,
  request: ModelRequest,
  streaming: boolean,
): Promise<Response> {
  const requestJson = JSON.stringify(requestBody(request, streaming));
  try {
    return await fetchImpl(
      `${request.model.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          "Content-Type": "application/json",
        },
        body: requestJson,
        signal: request.signal,
      },
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw safeAbortError();
    }
    throw new ModelRequestError(`${context(request)} 网络请求失败。`, "network");
  }
}

function readToolCalls(
  value: unknown,
  request: ModelRequest,
): ModelToolCall[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidResponse(request);
  }

  return value.map((toolCall) => {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
      throw invalidResponse(request);
    }
    const id = toolCall.id;
    const type = toolCall.type;
    const name = toolCall.function.name;
    const argumentsJson = toolCall.function.arguments;
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      type !== "function" ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof argumentsJson !== "string"
    ) {
      throw invalidResponse(request);
    }
    return { id, name, argumentsJson };
  });
}

function readReasoning(
  message: Record<string, unknown>,
  request: ModelRequest,
): ModelReasoning | undefined {
  let field: ModelReasoningField | undefined;
  let text: string | undefined;

  for (const candidate of REASONING_FIELDS) {
    if (!Object.hasOwn(message, candidate)) {
      continue;
    }
    const value = message[candidate];
    if (typeof value !== "string") {
      throw invalidResponse(request);
    }
    if (field === undefined && value.length > 0) {
      field = candidate;
      text = value;
    }
  }

  let details: readonly unknown[] | undefined;
  if (Object.hasOwn(message, "reasoning_details")) {
    if (!Array.isArray(message.reasoning_details)) {
      throw invalidResponse(request);
    }
    details = structuredClone(message.reasoning_details);
  }

  if (field === undefined && details === undefined) {
    return undefined;
  }
  return {
    providerId: request.model.providerId,
    ...(field === undefined ? {} : { field, text }),
    ...(details === undefined ? {} : { details }),
  };
}

function readReply(value: unknown, request: ModelRequest): ModelReply {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw invalidResponse(request);
  }
  const firstChoice = value.choices[0];
  if (
    !isRecord(firstChoice) ||
    !isRecord(firstChoice.message) ||
    firstChoice.message.role !== "assistant" ||
    !Object.hasOwn(firstChoice.message, "content")
  ) {
    throw invalidResponse(request);
  }

  const rawContent = firstChoice.message.content;
  if (rawContent !== null && typeof rawContent !== "string") {
    throw invalidResponse(request);
  }
  const reasoning = readReasoning(firstChoice.message, request);
  return {
    content: rawContent === null || rawContent === "" ? undefined : rawContent,
    toolCalls: readToolCalls(firstChoice.message.tool_calls, request),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

interface PartialToolCall {
  readonly index: number;
  id: string;
  name: string;
  argumentsJson: string;
}

function finalizeStreamedToolCalls(
  toolCallsByIndex: ReadonlyMap<number, PartialToolCall>,
  request: ModelRequest,
): ModelToolCall[] {
  return [...toolCallsByIndex.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ id, name, argumentsJson }) => {
      if (id.length === 0 || name.length === 0) {
        throw invalidResponse(request);
      }
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(argumentsJson);
      } catch {
        throw invalidResponse(request);
      }
      if (!isRecord(parsedArguments)) {
        throw invalidResponse(request);
      }
      return { id, name, argumentsJson };
    });
}

function responseMediaType(response: Response): string | undefined {
  return response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the response result or error.
  }
}

async function readCompleteReply(
  response: Response,
  request: ModelRequest,
): Promise<ModelReply> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw safeAbortError();
    }
    throw invalidResponse(request);
  } finally {
    await cancelResponseBody(response);
  }
  return readReply(body, request);
}

const STREAM_TERM = /(?:^|[^a-z0-9])stream(?:ing)?(?:$|[^a-z0-9])/i;
const UNSUPPORTED_TERM =
  /(?:^|[^a-z0-9])(?:unsupported|not[\s_-]+supported)(?:$|[^a-z0-9])|不支持/i;
const UNSUPPORTED_PARAMETER_CODES = new Set([
  "unsupported_parameter",
  "unsupported-parameter",
  "unsupported_param",
  "unsupported-param",
]);

function explicitlySaysStreamingIsUnsupported(value: string): boolean {
  const bounded = value.slice(0, 512);
  return STREAM_TERM.test(bounded) && UNSUPPORTED_TERM.test(bounded);
}

async function explicitlyRejectsStreaming(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 422) {
    return false;
  }

  try {
    if (responseMediaType(response) !== "application/json") {
      return false;
    }
    const body: unknown = await response.json();
    if (!isRecord(body) || !isRecord(body.error)) {
      return false;
    }
    const structuredError = body.error;

    const fields = ["message", "code", "type", "param"] as const;
    if (
      fields.some((field) => {
        const value = structuredError[field];
        return (
          typeof value === "string" &&
          explicitlySaysStreamingIsUnsupported(value)
        );
      })
    ) {
      return true;
    }

    const rawParam = structuredError.param;
    const param =
      typeof rawParam === "string" ? rawParam.trim().toLowerCase() : "";
    if (param !== "stream" && param !== "streaming") {
      return false;
    }
    return [structuredError.code, structuredError.type].some(
      (value) =>
        typeof value === "string" &&
        UNSUPPORTED_PARAMETER_CODES.has(value.trim().toLowerCase()),
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw safeAbortError();
    }
    return false;
  } finally {
    await cancelResponseBody(response);
  }
}

export function createOpenAICompletionsGateway(
  fetchImpl: FetchLike = fetch,
): ModelGateway {
  return {
    async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
      const response = await fetchCompletion(fetchImpl, request, true);

      if (response.ok && responseMediaType(response) === "application/json") {
        try {
          yield { type: "start" };
          yield { type: "fallback" };
          const reply = await readCompleteReply(response, request);
          if (reply.content !== undefined) {
            yield { type: "text_delta", delta: reply.content };
          }
          yield { type: "done", reply };
          return;
        } finally {
          await cancelResponseBody(response);
        }
      }

      if (!response.ok) {
        if (await explicitlyRejectsStreaming(response)) {
          yield { type: "start" };
          yield { type: "fallback" };
          const fallbackResponse = await fetchCompletion(
            fetchImpl,
            request,
            false,
          );
          if (!fallbackResponse.ok) {
            await cancelResponseBody(fallbackResponse);
            throw statusError(request, fallbackResponse.status);
          }
          const reply = await readCompleteReply(fallbackResponse, request);
          if (reply.content !== undefined) {
            yield { type: "text_delta", delta: reply.content };
          }
          yield { type: "done", reply };
          return;
        }
        await cancelResponseBody(response);
        throw statusError(request, response.status);
      }
      const mediaType = responseMediaType(response);
      if (
        mediaType !== "text/event-stream" ||
        response.body === null
      ) {
        await cancelResponseBody(response);
        throw invalidResponse(request);
      }

      const responseBody = response.body;
      try {
        yield { type: "start" };
        let content = "";
        let reasoningField: ModelReasoningField | undefined;
        let reasoningText = "";
        const reasoningDetails: unknown[] = [];
        const toolCallsByIndex = new Map<number, PartialToolCall>();
        let sawReasoningDetails = false;
        let sawFinishReason = false;

        try {
          for await (const data of readSseData(responseBody, request.signal)) {
            if (data === "[DONE]") {
              break;
            }

            let value: unknown;
            try {
              value = JSON.parse(data);
            } catch {
              throw invalidResponse(request);
            }
            if (!isRecord(value) || !Array.isArray(value.choices)) {
              throw invalidResponse(request);
            }
            if (value.choices.length === 0) {
              continue;
            }

            const choice = value.choices[0];
            if (!isRecord(choice)) {
              throw invalidResponse(request);
            }
            if (
              choice.finish_reason !== null &&
              choice.finish_reason !== undefined
            ) {
              if (
                typeof choice.finish_reason !== "string" ||
                choice.finish_reason.trim().length === 0
              ) {
                throw invalidResponse(request);
              }
              sawFinishReason = true;
            }
            if (!isRecord(choice.delta)) {
              throw invalidResponse(request);
            }

            const delta = choice.delta;
            if (Object.hasOwn(delta, "tool_calls")) {
              if (!Array.isArray(delta.tool_calls)) {
                throw invalidResponse(request);
              }
              for (const rawToolCall of delta.tool_calls) {
                if (!isRecord(rawToolCall)) {
                  throw invalidResponse(request);
                }
                const index = rawToolCall.index;
                if (
                  typeof index !== "number" ||
                  !Number.isSafeInteger(index) ||
                  index < 0
                ) {
                  throw invalidResponse(request);
                }
                let id: string | undefined;
                if (Object.hasOwn(rawToolCall, "id")) {
                  if (typeof rawToolCall.id !== "string") {
                    throw invalidResponse(request);
                  }
                  id = rawToolCall.id;
                }
                if (
                  Object.hasOwn(rawToolCall, "type") &&
                  rawToolCall.type !== "function"
                ) {
                  throw invalidResponse(request);
                }

                let name: string | undefined;
                let argumentsDelta: string | undefined;
                if (Object.hasOwn(rawToolCall, "function")) {
                  if (!isRecord(rawToolCall.function)) {
                    throw invalidResponse(request);
                  }
                  if (Object.hasOwn(rawToolCall.function, "name")) {
                    if (typeof rawToolCall.function.name !== "string") {
                      throw invalidResponse(request);
                    }
                    name = rawToolCall.function.name;
                  }
                  if (Object.hasOwn(rawToolCall.function, "arguments")) {
                    if (typeof rawToolCall.function.arguments !== "string") {
                      throw invalidResponse(request);
                    }
                    argumentsDelta = rawToolCall.function.arguments;
                  }
                }

                let partial = toolCallsByIndex.get(index);
                if (partial === undefined) {
                  partial = { index, id: "", name: "", argumentsJson: "" };
                  toolCallsByIndex.set(index, partial);
                }
                if (partial.id.length === 0 && id !== undefined && id.length > 0) {
                  partial.id = id;
                }
                if (name !== undefined) {
                  partial.name += name;
                }
                if (argumentsDelta !== undefined) {
                  partial.argumentsJson += argumentsDelta;
                }
                yield {
                  type: "tool_call_delta",
                  index,
                  ...(id === undefined ? {} : { id }),
                  ...(name === undefined ? {} : { name }),
                  ...(argumentsDelta === undefined
                    ? {}
                    : { argumentsDelta }),
                };
              }
            }

            if (Object.hasOwn(delta, "content")) {
              const rawContent = delta.content;
              if (typeof rawContent !== "string") {
                throw invalidResponse(request);
              }
              if (rawContent.length > 0) {
                content += rawContent;
                yield { type: "text_delta", delta: rawContent };
              }
            }

            let selectedReasoning:
              | { field: ModelReasoningField; text: string }
              | undefined;
            for (const field of REASONING_FIELDS) {
              if (!Object.hasOwn(delta, field)) {
                continue;
              }
              const rawReasoning = delta[field];
              if (typeof rawReasoning !== "string") {
                throw invalidResponse(request);
              }
              if (
                selectedReasoning === undefined &&
                rawReasoning.length > 0
              ) {
                selectedReasoning = { field, text: rawReasoning };
              }
            }
            if (selectedReasoning !== undefined) {
              reasoningField ??= selectedReasoning.field;
              reasoningText += selectedReasoning.text;
              yield {
                type: "reasoning_delta",
                field: selectedReasoning.field,
                delta: selectedReasoning.text,
              };
            }

            if (Object.hasOwn(delta, "reasoning_details")) {
              if (!Array.isArray(delta.reasoning_details)) {
                throw invalidResponse(request);
              }
              sawReasoningDetails = true;
              const details = structuredClone(delta.reasoning_details);
              reasoningDetails.push(...details);
              yield {
                type: "reasoning_details",
                details: structuredClone(details),
              };
            }
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw safeAbortError();
          }
          if (error instanceof ModelRequestError) {
            throw error;
          }
          throw new ModelRequestError(
            `${context(request)} 网络请求失败。`,
            "network",
          );
        }

        if (!sawFinishReason) {
          throw invalidResponse(request);
        }

        const reasoning =
          reasoningField === undefined && !sawReasoningDetails
            ? undefined
            : {
                providerId: request.model.providerId,
                ...(reasoningField === undefined
                  ? {}
                  : { field: reasoningField, text: reasoningText }),
                ...(sawReasoningDetails ? { details: reasoningDetails } : {}),
              };
        yield {
          type: "done",
          reply: {
            content: content === "" ? undefined : content,
            toolCalls: finalizeStreamedToolCalls(toolCallsByIndex, request),
            ...(reasoning === undefined ? {} : { reasoning }),
          },
        };
      } finally {
        try {
          await responseBody.cancel();
        } catch {
          // Cleanup must not replace the stream error or an early return.
        }
      }
    },
  };
}
