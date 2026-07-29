# Coffee 最小对话 Agent 设计

## 目标

在 `pi` 的同级目录中创建一个独立的 Node.js + TypeScript 命令行项目 `coffee`。第一版固定调用 DeepSeek，不提供模型选择，通过终端完成多轮对话。项目直接提供本地 `.env` 配置文件，用户填入 API Key 后即可运行。

这一版用于展示 Pi 最基础的对话骨架：接收输入、维护消息历史、调用模型、展示回复、继续下一轮。

## 范围

包含：

- TypeScript 实现的 Node.js 终端交互。
- 内存中的多轮消息历史。
- 固定调用 `deepseek-v4-flash`。
- 使用 Node.js 原生 `fetch` 调用 DeepSeek Chat Completions API。
- `/exit` 退出命令。
- 缺少 API Key、HTTP 失败和异常响应的明确错误提示。
- Node.js 内置测试框架覆盖核心行为。

不包含：

- Provider 或模型选择。
- 文件读写、Shell、搜索等工具调用。
- 流式输出。
- 会话持久化。
- LangChain 或其他 Agent 框架。
- 图形 UI、完整 TUI、扩展系统、Skill、审批或沙箱。

因此，第一版更准确地说是 Coffee 的对话内核；后续加入工具调用和自动循环后，才成为完整的工具型 Agent。

## 技术选择

- 运行时：Node.js 22 或更高版本。
- 开发语言：TypeScript，启用严格类型检查。
- 模块格式：ES Modules。
- HTTP：Node.js 原生 `fetch`，不添加应用运行时依赖。
- TypeScript 执行：`tsx`。
- 类型检查：`tsc --noEmit`。
- 测试：TypeScript 测试文件配合 `node:test` 和 `node:assert/strict`。
- API：`POST https://api.deepseek.com/chat/completions`。
- 鉴权：`Authorization: Bearer ${DEEPSEEK_API_KEY}`。
- 固定模型：`deepseek-v4-flash`。

不使用 LangChain，因为当前范围只有一个固定 Provider 和一个简单对话循环。直接调用 API 能保留学习价值，也减少依赖和间接层。

## 目录结构

```text
coffee/
├── .env
├── .gitignore
├── package.json
├── README.md
├── tsconfig.json
├── docs/
│   └── superpowers/specs/
│       └── 2026-07-13-coffee-minimal-agent-design.md
├── src/
│   ├── agent.ts
│   └── cli.ts
└── test/
    ├── agent.test.ts
    └── cli.test.ts
```

## 组件职责

### `src/agent.ts`

提供一个最小会话对象：

- 接收 API Key 和可替换的 `fetch` 实现。
- 保存当前进程内的消息历史。
- 将用户输入追加为 `user` 消息。
- 调用 DeepSeek API。
- 从响应中提取第一条 assistant 文本。
- 成功后把 assistant 回复追加到历史并返回文本。
- 请求失败时不写入不完整的 assistant 消息。

允许注入 `fetch` 只用于无付费、可重复的自动化测试；正常运行始终使用 Node.js 全局 `fetch`。

### `src/cli.ts`

负责命令行体验：

- 启动时检查 `DEEPSEEK_API_KEY`。
- 创建会话并循环读取终端输入。
- 空输入不发送请求。
- 输入 `/exit` 时正常结束。
- 打印模型回复。
- 捕获 API 错误，显示简洁消息，然后允许用户继续输入；缺少 API Key 时直接退出。

## 数据流

1. `npm start` 使用 `tsx` 执行 TypeScript，并从 `.env` 加载凭证。
2. CLI 读取一行用户输入。
3. 会话对象把输入追加到内存消息列表。
4. 会话对象发送固定模型和完整消息历史到 DeepSeek。
5. API 返回 assistant 消息。
6. 会话对象保存并返回该消息。
7. CLI 打印回复，然后等待下一行输入。

第一版进程退出后不保存对话。

## 配置与运行

`.env` 直接提供空配置项：

```dotenv
DEEPSEEK_API_KEY=
```

用户运行：

```bash
npm install
# 编辑 .env，填写真实 Key
npm start
```

`.env` 必须被 `.gitignore` 忽略，README 不展示真实凭证。

## 错误处理

- 未配置 Key：启动失败，并提示编辑 `.env`。
- 非 2xx 响应：优先显示 DeepSeek 返回的错误消息，同时包含 HTTP 状态码。
- 响应缺少 assistant 文本：提示 API 响应格式不符合预期。
- 网络异常：显示异常消息，不输出调用栈给普通用户。
- 单轮 API 调用失败：保留 CLI 进程，但回滚本轮用户消息，防止下一轮携带一段没有对应 assistant 回复的历史。

## 测试策略

按 TDD 实现以下行为，并用 `npm run check` 做严格类型检查：

1. 缺少 API Key 时拒绝创建会话。
2. 首轮请求使用固定端点、Bearer 鉴权、固定模型和正确的用户消息。
3. 第二轮请求包含此前的 user/assistant 历史。
4. API 失败时返回可理解的错误，并回滚本轮消息。
5. API 响应缺少 assistant 文本时返回格式错误。
6. CLI 缺少 Key 时失败退出，输入 `/exit` 时正常退出。

测试不调用真实 DeepSeek API，不消耗额度，也不读取开发者的 `.env`。

## 验收标准

- `coffee` 与 `pi` 位于同一级目录。
- 项目源码和测试均使用 TypeScript。
- 项目没有 LangChain、OpenAI SDK 等应用运行时依赖；只安装 TypeScript 开发工具。
- 用户仅填写 `DEEPSEEK_API_KEY` 即可启动。
- `npm start` 能进入多轮终端对话，`/exit` 能退出。
- 请求始终使用 `deepseek-v4-flash`，没有模型选择入口。
- `npm test` 全部通过。
- `npm run check` 类型检查通过。
- 缺少 Key 时不会发起网络请求，并给出明确操作提示。
