import type {
  ModelDefinition,
  ModelGateway,
  ModelMessage,
} from "../models/types.js";
import { redactSummaryContent } from "./context.js";

const SUMMARY_SYSTEM_PROMPT = `
你负责压缩较早的对话。保留用户偏好、事实、已确认决定、约束、未解决任务和工具结论。
删除推理过程、凭证、疑似秘密、重复内容和冗长工具日志。
只输出摘要正文，不调用工具，不解释压缩过程。
`.trim();

export async function generateSummary(options: {
  gateway: ModelGateway;
  model: ModelDefinition;
  apiKey: string;
  source: string;
  targetChars: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: ModelMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `请将以下内容压缩到约 ${options.targetChars} 个字符：\n\n${options.source}`,
    },
  ];
  let content: string | undefined;
  for await (const event of options.gateway.stream({
    model: options.model,
    apiKey: options.apiKey,
    messages,
    tools: [],
    signal: options.signal,
  })) {
    if (event.type === "done") {
      if (event.reply.toolCalls.length > 0) {
        throw new Error("摘要模型返回了工具调用。");
      }
      content = event.reply.content?.trim();
    }
  }
  if (!content) throw new Error("摘要模型未返回有效正文。");
  const redacted = redactSummaryContent(content).trim();
  if (!redacted) throw new Error("摘要模型未返回有效正文。");
  return redacted;
}
