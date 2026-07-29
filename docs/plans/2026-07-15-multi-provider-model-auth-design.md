# Coffee 多厂商模型与登录设计

## 目标

让 Coffee 在保留 TypeScript、CLI 和原生 `fetch` 的前提下，接入 DeepSeek、OpenCode Go、OpenCode Zen 与火山方舟 Coding Plan，并用与 Pi 一致的 `/login`、`/logout`、`/model` 命令管理凭证和切换模型。

第一版只实现 OpenAI Chat Completions 兼容协议。使用 Anthropic Messages、OpenAI Responses 或 Google Generative AI 的模型暂不展示。

## 设计原则

- 学习 Pi 的 Provider、Model、API Adapter、Registry 分层，不直接依赖完整的 `@earendil-works/pi-ai`。
- 保留原生 `fetch`，不引入 LangChain。
- API Key 与项目设置分开保存。
- Agent、工具注册表与具体模型厂商解耦。
- 只内置已经确认协议和工具调用能力的模型。
- 切换模型后保留当前对话，下一轮开始使用新模型。

## 架构

```text
CLI
 ├─ /login、/logout：Credential Store
 ├─ /model：Model Registry + coffee.settings.json
 └─ 普通消息：Conversation
                    │
                    ▼
              Model Registry
       ├─ Credential Definition
       ├─ Provider Definition
       └─ Model Definition
                    │ model.api
                    ▼
       OpenAI Completions Adapter
                    │
                    ▼
 DeepSeek / OpenCode Go / OpenCode Zen / Ark Coding Plan
```

### 模块边界

- `agent.ts`：维护中立消息历史、工具循环和当前模型，不出现厂商 URL、环境变量名或厂商专属错误。
- `models/types.ts`：中立消息、工具调用、凭证、Provider、Model 与 Adapter 类型。
- `models/catalog.ts`：第一版凭证、Provider 与模型目录。
- `models/registry.ts`：按 `provider + model` 查找模型，枚举已鉴权平台。
- `models/openai-completions.ts`：将中立消息和工具定义转换为 OpenAI Chat Completions 请求，并把响应转换回中立结果。
- `auth.ts`：读取、写入、删除和解析 API Key。
- `settings.ts`：继续管理咖啡动画，并增加活动模型偏好。
- `login-command.ts`、`logout-command.ts`、`model-command.ts`：只负责各自命令的菜单和状态变化。

## 凭证设计

交互输入的凭证保存在：

```text
~/.coffee/auth.json
```

目录权限为 `0700`，文件权限为 `0600`。文件格式：

```json
{
  "version": 1,
  "credentials": {
    "deepseek": { "type": "api_key", "key": "..." },
    "opencode": { "type": "api_key", "key": "..." },
    "volcengine-ark": { "type": "api_key", "key": "..." }
  }
}
```

OpenCode Go 和 Zen 共用 `opencode` 凭证。`/login` 中只显示一个 OpenCode 登录项，登录一次同时使 Go 和 Zen 出现在 `/model` 中。

凭证解析顺序：

1. `~/.coffee/auth.json`
2. 项目 `.env`

`.env` 继续支持 `DEEPSEEK_API_KEY`、`OPENCODE_API_KEY`、`ARK_API_KEY`。不会自动将 `.env` 的值复制到全局凭证文件。

`/login` 选择未登录厂商时隐藏输入 API Key；选择已登录厂商时可保留或更新。`/logout` 删除全局凭证；如果 `.env` 中仍有对应 Key，会明确提示环境变量仍然生效。

## 模型设置

活动模型保存在项目根目录 `coffee.settings.json`：

```json
{
  "coffee-preferences": {
    "animation": "americano"
  },
  "model-preferences": {
    "provider": "opencode-go",
    "model": "kimi-k2.7-code"
  }
}
```

API Key 不写入该文件。保存模型设置时保留其他已有字段。

启动时优先恢复已保存且仍存在、仍有凭证的模型；否则使用第一个已有凭证的平台模型。没有任何模型凭证时 CLI 仍然启动，以便用户执行 `/login`，普通聊天会在本地提示先登录并选择模型。

## `/model` 交互

`/model` 使用两级选择：

1. 选择已经鉴权的平台或套餐。
2. 选择该平台中第一版协议支持的模型。

选择完成后同时更新 `coffee.settings.json` 和当前 Conversation。任一步骤取消或保存失败，都保留旧模型。

### 第一版目录

DeepSeek：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

OpenCode Go：

- `deepseek-v4-flash`
- `deepseek-v4-pro`
- `glm-5.1`
- `glm-5.2`
- `kimi-k2.6`
- `kimi-k2.7-code`
- `mimo-v2.5`
- `mimo-v2.5-pro`
- `minimax-m2.7`
- `qwen3.6-plus`

OpenCode Zen：内置 Pi 当前目录中使用 `openai-completions` 的 DeepSeek、GLM、Kimi、MiniMax、Grok、MiMo 与免费模型。Claude、GPT Responses、Gemini 和采用 Anthropic 协议的 Qwen 模型暂不展示。

火山方舟 Coding Plan：

- `ark-code-latest`

## 对话切换

Coffee 内部使用中立消息格式保存 system、user、assistant、tool call 和 tool result。切换模型不会清空历史，也不会把“已切换模型”写入对话内容。

一次 `send()` 开始时固定本轮模型；即使以后支持并发控制，同一轮中的多次工具往返也始终使用同一模型。下一次 `send()` 才读取新的活动模型。

## 错误处理

- `401/403`：凭证无效或无权访问模型，提示 `/login` 更新。
- `404`：模型不存在或套餐不支持。
- `429`：额度或请求频率受限。
- `5xx`：厂商服务暂时异常。
- 网络错误：提示检查网络并重试。
- 无效 JSON 或响应结构：报告厂商、模型和协议，不输出 Key 或完整请求体。

请求失败时回滚本轮新增的用户消息、assistant 工具调用和工具结果，保留之前历史和当前模型。Coffee 不自动切换厂商，避免意外消耗其他套餐。

## 测试

- 凭证文件格式、权限、遮罩、优先级和 `.env` 回退。
- `/login` 新增、保留、更新；OpenCode 一次登录开放 Go 与 Zen。
- `/logout` 删除全局凭证以及环境变量仍生效的提示。
- Registry 查找、重复检测和已鉴权平台过滤。
- 模型设置读取、保存、损坏配置警告和旧字段保留。
- `/model` 两级选择、取消回滚和对话保留。
- OpenAI Completions 请求 URL、模型、消息、工具和响应解析。
- `401/403/404/429/5xx` 映射与对话回滚。
- `/login`、`/logout`、`/model` 的补全、拼写建议和未知命令阻断。
- 现有 DeepSeek、Tavily、计算器、咖啡动画和 Ctrl+C 测试不回归。

## 非目标

- OAuth 登录。
- 动态 `/models` 发现。
- Anthropic Messages、OpenAI Responses、Google Generative AI。
- 成本统计、Token 统计和自动模型故障转移。
- 将凭证迁移到 macOS Keychain。

## 参考实现与资料

- `../pi/packages/ai/src/models.ts`：Pi 的 Provider、Model collection 与按 API 分发设计。
- `../pi/packages/ai/src/providers/opencode.ts`：OpenCode Zen 的多协议 Provider。
- `../pi/packages/ai/src/providers/opencode-go.ts`：OpenCode Go 的多协议 Provider。
- `../pi/packages/ai/src/providers/opencode.models.ts` 与 `opencode-go.models.ts`：第一版静态模型目录依据。
- [OpenCode Go 官方文档](https://opencode.ai/docs/go/)
- [OpenCode Zen 官方文档](https://opencode.ai/docs/zen/)
- [方舟 Coding Plan 官方页面](https://www.volcengine.com/activity/codingplan)
