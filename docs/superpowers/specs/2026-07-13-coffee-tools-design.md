# Coffee Tools 设计

## 目标

在现有 TypeScript CLI 中加入两个由 DeepSeek 自主选择的工具：

- `web_search`：通过 Tavily 搜索网页。
- `get_current_location`：通过 IPWho 获取当前公网 IP 对应的近似城市位置。

项目继续使用 Node.js 原生 `fetch`，不引入 LangChain、MCP 或第三方 SDK。

## 交互流程

1. Coffee 把对话历史和工具定义发送给 DeepSeek。
2. 如果 DeepSeek 返回 `tool_calls`，Coffee 校验工具名称和 JSON 参数。
3. Coffee 执行工具，把结构化结果作为 `tool` 消息加入当前对话。
4. Coffee 再次请求 DeepSeek，直到得到最终文本或达到 5 轮上限。

DeepSeek 固定使用 `deepseek-v4-flash`，显式关闭思考模式，避免工具调用期间还要维护 `reasoning_content`。

## 工具边界

`web_search` 只接受非空的 `query` 字符串，调用 Tavily basic search 并最多返回 5 条标题、URL 和摘要。`get_current_location` 不接受参数，只返回城市、地区、国家、近似经纬度和时区，不把公网 IP 返回给模型。

工具执行失败不会终止 CLI。执行器会返回带 `ok: false` 的工具结果，让 DeepSeek 向用户解释失败。DeepSeek API 本身请求失败时，撤销本轮所有新增消息，保持既有对话历史一致。

## 配置与终端反馈

`.env` 需要同时包含 `DEEPSEEK_API_KEY` 和 `TAVILY_API_KEY`。CLI 在调用工具前输出彩色状态，例如 `Tool> 正在联网搜索…`，随后仍由 Coffee 输出最终回答。

## 验证

测试全部使用注入的假 `fetch`：覆盖 Tavily 请求与结果裁剪、IPWho 结果、参数错误、DeepSeek 多轮工具循环、工具错误恢复、最大轮数、环境变量检查和终端样式。最后运行 `npm test` 与 `npm run check`。
