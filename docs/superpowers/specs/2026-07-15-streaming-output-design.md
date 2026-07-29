# Coffee 流式输出设计

日期：2026-07-15

## 背景

Coffee 当前通过 OpenAI Chat Completions 兼容接口获取完整 JSON。模型、工具循环全部结束后，`Conversation.send()` 才返回完整字符串，CLI 再一次性调用 `renderMarkdown()` 输出。

本设计将输出改为端到端事件流，同时保留现有的模型中立结构、工具循环、reasoning 回放、模型切换、凭证解析和 Ctrl+C 取消行为。

## 目标

- 模型正文到达后立即显示，不等待完整回答。
- 在交互式 TTY 中持续重绘带颜色的 Markdown。
- 不展示原始 reasoning，只显示简洁的思考进度。
- 工具调用仍使用现有咖啡动画，并与正文流式区域互不破坏。
- Ctrl+C 保留屏幕上已经显示的部分内容，但回滚本轮历史。
- 不支持流式输出的模型自动回退到一次性完整输出。
- 保持 DeepSeek V4 reasoning 回放、OpenCode Go 字段归一化和跨厂商 reasoning 隔离。

## 非目标

- 不增加 `/stream` 命令或持久化流式开关。
- 不向用户展示原始 chain-of-thought、reasoning 文本或加密 reasoning details。
- 不把未完成的回答写入会话历史。
- 不支持任意自定义 SSE 协议；首版只处理内置平台的 OpenAI Chat Completions 风格流。
- 不改变工具定义、工具审批策略或模型目录。

## 总体架构

数据依次经过三层：

```text
厂商 SSE / 完整 JSON
  -> ModelGateway：解析、校验并组装模型事件
  -> Conversation：执行工具循环并生成安全展示事件
  -> StreamingMarkdownRenderer：TTY 重绘或非 TTY 追加输出
```

模型层和展示层使用不同事件类型，避免 CLI 接触原始 reasoning 或厂商协议细节。

## 模型事件

`ModelGateway.stream()` 取代当前的 `complete()`，返回 `AsyncIterable<ModelStreamEvent>`。非流式重试属于 OpenAI adapter 内部实现，不扩散成第二套 Gateway 接口。事件至少包括：

```ts
type ModelStreamEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | {
      type: "reasoning_delta";
      field: ModelReasoningField;
      delta: string;
    }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: "reasoning_details"; details: readonly unknown[] }
  | { type: "fallback" }
  | { type: "done"; reply: ModelReply };
```

`done.reply` 是本轮模型消息的唯一权威结果。增量事件只用于展示和内部组装，不能直接写入历史。

模型层继续负责：

- 严格校验正文、reasoning 和工具调用字段。
- 深拷贝 opaque `reasoning_details`。
- 保存 reasoning 来源 provider。
- OpenCode Go 的 `reasoning` 回放归一化为 `reasoning_content`。
- DeepSeek V4 assistant 回放缺少字段时注入空 `reasoning_content`。
- 跨 provider 切换时不回放原 provider 的 reasoning 文本或 details。

## SSE 请求与解析

请求体增加 `stream: true`，继续使用原生 `fetch`、`Response.body`、`ReadableStream` 和 `TextDecoder`，不引入 SSE 框架。

解析器必须正确处理：

- 网络 chunk 任意切分，包括 UTF-8 中文字符被拆分。
- `\n` 与 `\r\n`。
- SSE 注释、空行、多个 `data:` 行和 `[DONE]`。
- 单个 chunk 包含多个 SSE event。
- 空 choices 和 usage-only chunk。
- 流结束但没有合法结束原因。
- AbortSignal 取消读取。

工具调用按流中的稳定 `index` 聚合。ID、函数名和参数都允许分段到达；参数字符串必须完整拼接，并在 `done` 前通过现有 JSON 规则校验。不能仅按 tool call ID 聚合，因为部分兼容平台会在流中改变 ID。

reasoning 文本按照 `reasoning_content`、`reasoning`、`reasoning_text` 的优先级选择同一 chunk 中第一个非空字段，避免重复累计。原始 reasoning delta 不进入展示层。

## Agent 事件与工具循环

`Conversation` 新增 `stream(input, signal)`，返回 `AsyncIterable<ConversationEvent>`：

```ts
type ConversationEvent =
  | { type: "status"; text: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_activity"; event: ToolActivityEvent }
  | { type: "fallback"; text: string }
  | { type: "segment_end" }
  | { type: "done"; content: string };
```

`Conversation.send()` 保留为兼容入口：它消费 `stream()`，忽略展示事件并返回最终正文。

现有 `ConversationOptions.onToolActivity` 被移除，`tool_activity` 事件成为工具进度的唯一输出通道，避免 callback 与 stream 重复通知。CLI 使用 `stream()`；只需要最终文本的调用方继续使用 `send()`。

每个用户回合遵循以下事务：

1. 固定当前模型、API Key 和 AbortSignal。
2. 暂存用户消息，但不立即提交完整回合。
3. 消费一个模型流，组装完整 assistant 消息。
4. 若存在工具调用，先提交该 assistant 消息到本轮暂存区，再逐个执行工具。
5. 工具完成后开始下一轮模型流，最多保持现有五轮限制。
6. 只有获得最终有效 assistant 正文时，才把本轮所有消息提交到会话历史。
7. 任意解析错误、网络错误、工具异常或取消都会回滚本轮历史。

已显示到终端的正文不因回滚而清除。

## 简洁思考进度

CLI 不接收 reasoning 内容，只接收由 Agent 根据事件阶段生成的状态：

- 首次收到 reasoning：`正在分析问题…`
- 开始组装工具调用：`正在准备调用工具…`
- 工具名称明确后：使用现有工具友好文案。
- 工具结束并进入下一轮：`正在整理工具结果…`
- 非流式回退：`当前模型暂不支持流式输出，已切换为完整输出。`

相同状态不得因每个 reasoning delta 重复输出。

## TTY Markdown 重绘

新增独立 `StreamingMarkdownRenderer`，不把光标控制逻辑继续堆入 `cli.ts`。

TTY 行为：

- 保存当前模型轮次的原始 Markdown 缓冲区。
- 收到 `text_delta` 后追加缓冲区。
- 约每 40ms 合并刷新一次，避免逐字符刷新造成闪烁。
- 每次使用现有 `renderMarkdown()` 渲染完整缓冲区。
- 清除上一帧实际占用的终端行，再绘制新帧。
- 使用直接依赖 `string-width` 计算去除 ANSI 后的中文、Emoji 和自动换行宽度。
- 刷新、结束、错误和取消路径都必须恢复光标。

每个模型工具轮是一个独立渲染段。进入工具调用前，当前正文段被固定并换行；工具动画在其下方运行。下一轮正文创建新段，不跨过工具动画重绘。

非 TTY 行为：

- 不输出 ANSI 光标控制序列。
- 不做历史帧清除。
- 原始 Markdown delta 按顺序追加为普通字符；允许保留 `**` 等 Markdown 标记，但不输出 ANSI 控制序列。
- 状态和工具活动继续使用现有非 TTY 单行文案。

## 自动回退

自动回退仅允许发生在尚未接收任何正文、reasoning 或工具增量时：

1. 若 `stream: true` 返回成功的普通完整 JSON，直接解析为一次性 `ModelReply`，不重复请求。
2. 若 HTTP 400/422 的安全结构化错误明确表示不支持 stream，则只重试一次非流式请求。
3. 其他 HTTP 错误保持现有安全错误映射，不输出厂商原始 body 或 API Key。
4. 一旦已经收到正文、reasoning 或工具增量，流异常时禁止重试，避免重复生成或重复执行工具。

回退时发出一次 `fallback` 展示事件。回退结果仍必须通过当前完整响应校验。

## 错误与取消

- Ctrl+C 使用现有 AbortSignal，必须同时取消 SSE 读取和正在运行的网络工具。
- 取消后 CLI 以退出码 0 结束，不打印 `AbortError`。
- 已显示的部分正文保留，当前状态行和动画被正确收尾。
- 历史回滚到本轮开始前。
- SSE JSON 损坏、工具参数不完整、缺少结束原因或 response body 不可读，都返回不包含密钥和原始响应体的安全错误。
- 流过程中发生错误时，在已显示内容下方另起一行显示错误，不能尝试清除用户已经看到的正文。

## 测试策略

### 模型层

- SSE event 和 UTF-8 字符跨 chunk 分片。
- CRLF、注释、多 data 行、usage-only chunk 和 `[DONE]`。
- 正文、三种 reasoning 字段及 details 增量组装。
- 工具 ID、名称、参数按 index 聚合，包含中途改变 ID。
- 多工具并行 delta。
- 流意外结束、损坏 JSON、非法字段、AbortSignal。
- 成功普通 JSON回退、明确不支持 stream 的单次重试、已有 delta 后禁止重试。
- DeepSeek V4 reasoning 回放和跨 provider 隔离不退化。

### Agent 层

- 展示事件顺序和状态去重。
- 单轮正文与多轮工具循环。
- `send()` 正确消费 `stream()`。
- 成功时提交完整历史。
- 取消、流错误和工具错误时回滚历史。
- 部分正文不会误写历史。

### 渲染层与 CLI

- TTY 多帧 Markdown 重绘。
- 中文、Emoji、ANSI 和窄终端换行行数。
- 40ms 合并刷新使用可控时钟测试，不依赖真实 sleep。
- 工具调用前固定正文段，动画后创建新段。
- 非 TTY 不含光标控制符。
- 正常结束、异常和 Ctrl+C 均恢复光标。
- 活跃 SSE 请求 Ctrl+C 后快速、干净退出。

## 验收标准

- TTY 中首个正文 delta 到达后立即可见，并持续显示格式化 Markdown。
- 流式过程中不显示原始 reasoning。
- 工具动画与正文不互相覆盖。
- Ctrl+C 保留屏幕部分正文、回滚历史并正常退出。
- 不支持流式的模型自动回退且最多重试一次。
- DeepSeek、OpenCode Go、OpenCode Zen、方舟的现有模型目录和鉴权行为不退化。
- 全量测试和 `tsc --noEmit` 通过。
