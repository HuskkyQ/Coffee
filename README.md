# Coffee Agent

Coffee 是一个用 TypeScript 编写的终端 Agent。它通过 Node.js 原生 `fetch` 调用可切换的模型，保留多轮对话历史，并支持联网搜索、近似定位、本地代码编辑，以及项目命令和测试执行。

## 环境要求

- Node.js `>= 22.19.0`
- Tavily API Key（必须配置在项目 `.env` 中）
- 进行对话时需要至少一个支持的模型平台 API Key（可在 CLI 启动后用 `/login` 配置）

## 模型平台

Coffee 支持 DeepSeek、OpenCode Go、OpenCode Zen 和方舟 Agent Plan。首版模型目录仅包含已配置固定 Base URL 的内置平台和模型。

- `/login`：添加或更新平台 API Key，输入时会隐藏字符。
- `/logout`：删除保存在 `~/.coffee/auth.json` 中的平台凭证；如果项目 `.env` 中还有对应 Key，该 Key 仍然生效。
- `/model`：先选择已登录的平台，再切换该平台的模型。

交互输入的 API Key 以明文 JSON 保存在 `~/.coffee/auth.json`。在 macOS/Linux 上，Coffee 会尝试将 `~/.coffee` 目录权限设为 `0700`、文件权限设为 `0600`；Windows 文件模式不提供同等隔离，请依赖当前账户 ACL 和受保护的用户目录。无论使用哪个操作系统，都不要共享或提交该文件。凭证解析时优先使用该文件，没有对应凭证时再读取项目 `.env`；`/login` 不会把 `.env` 中的 Key 自动复制到凭证文件。OpenCode Go 和 Zen 共用一份 OpenCode API Key，登录一次即可在 `/model` 中选择两个平台。

模型选择保存在项目根目录 `coffee.settings.json` 的 `model-preferences` 中，不包含 API Key。切换模型不会清空当前会话，新模型从下一轮消息开始使用。

## 运行

安装开发依赖：

```bash
npm install
```

在项目根目录新建或编辑 `.env`。`TAVILY_API_KEY` 是必需项，模型平台 Key 也可以在这里配置：

```dotenv
DEEPSEEK_API_KEY=你的_DeepSeek_API_Key
OPENCODE_API_KEY=你的_OpenCode_API_Key
ARK_API_KEY=你的_方舟_Agent_Plan_API_Key
TAVILY_API_KEY=你的_Tavily_API_Key
```

只要 `TAVILY_API_KEY` 已配置，没有模型平台 Key 时 Coffee 也能启动，然后可以使用 `/login` 登录并用 `/model` 选择模型。

方舟必须使用 [Agent Plan 专属 API Key](https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan)，Coding Plan API Key 和普通方舟推理 API Key 均不能复用。Coffee 通过 Agent Plan Chat API `https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions` 调用模型。

`/model` 中内置了 Agent Plan 官方 Chat API 示例列出的文本模型：`ark-code-latest`、Doubao Seed 2.1 Turbo、Doubao Seed Evolving、GLM-5.2、GLM Latest、DeepSeek V4 Flash/Pro、Doubao Seed 2.0 Lite/Mini、MiniMax M2.7/M3、Kimi K2.6、Kimi K2.7 Code 和 Kimi K3。具体可用范围由你的 Agent Plan 版本及服务端当前授权决定。

启动 CLI：

```bash
npm start
```

开发阶段也可以注册全局 `coffee` 命令：

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm link
```

之后可以在任意项目目录启动：

```bash
cd /path/to/your/project
coffee
```

Coffee 会保留启动目录：如果当前目录位于 Git 仓库中，使用仓库根目录作为 Workspace；否则使用当前目录。`.env` 仍从 Coffee 安装目录加载，API Key、设置和对话历史继续使用 Coffee 自身的存储位置。本地文件工具只在该 Workspace 内操作。

移除开发链接：

```bash
npm unlink --global coffee-agent
```

在足够宽的真实终端中，Coffee 会显示空心斜体 `COFFEE` Logo，以及水平排列的冰美式和热拿铁。窄终端或管道输出会自动使用紧凑启动文案；设置 `NO_COLOR=1` 只关闭颜色，不移除字符画。

在终端中输入消息开始对话，输入 `/exit` 或按 Ctrl+C 退出。Coffee 默认流式显示模型回答：完整行会立即提交，只有当前未完成行可作为预览覆盖；TTY 支持 ANSI 时会在同一行刷新预览。设置 `NO_COLOR=1` 可关闭颜色。

非 TTY、`TERM=dumb`、终端宽度无效或写入异常时，输出会安全降级为只追加，内容不丢失也不重复。模型的原始推理内容不会显示，CLI 只提供“正在分析问题”等简短状态。工具调用会结束当前回答段，再配合已有的冰美式或热拿铁动画执行，后续结果会进入新的稳定段。

如果模型在输出任何正文、推理或工具增量之前明确表示不支持流式请求，Coffee 会安全地自动回退为完整响应；已经收到增量后发生错误时不会重试，以免重复回答或工具调用。按 Ctrl+C 中断时，Coffee 会保留已显示内容并正常收尾，但未完成的一轮不会写入当前会话历史。同一个 Conversation 同时只处理一个请求，并发请求会立即报错。

输入 `/` 时会出现命令下拉提示：使用 ↑/↓ 选择，Tab 补全，Enter 执行，Esc 关闭提示。当前命令包括：

- `/login`：添加、保留或更新模型平台凭证。
- `/logout`：删除保存在全局凭证文件中的平台凭证。
- `/model`：从已登录的平台中选择模型。
- `/new`：进入一个尚未保存的新会话；成功创建计划时会立即保存该计划所属的零回合会话。
- `/sessions`：列出并切换已保存的会话。
- `/delete`：确认后删除当前会话及其历史。
- `/plan [cancel]`：查看或取消当前任务计划。
- `/like`：交互选择工具动画。
- `/like americano`：切换为冰美式动画。
- `/like latte`：切换为热拿铁动画。
- `/exit`：退出 Coffee。

不存在的斜杠命令不会发送给模型。对于 `/likes`、`/lik` 等相近拼写，Coffee 会先询问是否改用 `/like`；其他未知命令会直接显示可用命令。

## 结构化任务规划

Coffee 会让模型为多文件修改、多个工具协作、需要测试验证或存在步骤依赖的复杂任务先创建计划。简单问答、翻译、单次读取和单步计算不会强制创建计划。

- `/plan`：查看当前会话的目标、状态和步骤。
- `/plan cancel`：取消 active 或 blocked 计划，不删除对话历史。
- 计划随 Session 保存在 SQLite；`/new` 使用新计划空间，`/sessions` 会恢复所选会话的计划。
- 遇到关键歧义且缺少继续执行所需信息时，计划可进入 blocked，Coffee 会先询问用户，再在下一轮恢复。
- Ctrl+C 会退出当前运行，但已经提交的计划状态会保留。

V1 不包含后台任务、自动调度、自动重试、并行步骤、上层自治 Loop 或 RAG。

## 本地代码工具

在项目目录执行 `coffee` 后，Coffee 会使用启动时检测到的工作区，并可使用：

- `read` / `ls` / `find` / `grep`：读取和搜索文本代码。
- `edit`：使用 `path + edits[]` 精确修改已有文件。
- `write`：只创建新文件，不覆盖。
- `set_env`：在本地隐藏输入 `.env*` 变量值。
- `shell`：在工作区中执行项目测试、检查和构建命令。

`edit`、`write` 和 `set_env` 都会显示行内 Diff，并等待 `y` 确认。回车、`n`、Ctrl+C、非交互终端都会拒绝修改。Coffee 不提供删除或重命名专用工具；上述文件工具不能访问工作区外、`.git`、私钥和二进制文件。

Shell 命令分为三档：`npm test` 等只读或验证命令可以自动执行；`npm install` 等会修改项目状态的命令每次都会询问，批准仅对本次执行有效；`sudo` 等高风险命令会直接拒绝。命令始终从启动时检测到的 Workspace 执行，模型不能另行提供 `cwd`。默认超时为 60 秒，可指定的最大超时为 300 秒。

Shell 策略不是操作系统沙箱：即使命令本身可以自动执行，受信任的项目脚本仍可能运行任意代码。子进程只继承运行所需的有限环境变量，不继承模型平台或 Tavily 的凭证环境变量。终端输出采用只追加显示，控制序列会被清洗，并在进入模型上下文前截断，避免超长输出持续占用上下文。

```text
You> 修复类型错误并运行测试
Coffee> 修改代码
Coffee> 自动运行 npm test
Coffee> 根据失败结果继续修复并再次验证
```

## 会话历史

Coffee 使用嵌入式 SQLite 保存成功完成的对话，不需要启动数据库服务。默认数据库位于 `~/.coffee/history.sqlite`。Coffee 的登录凭证（模型平台 API Key）不会写入历史库；对话正文会原样保存，请勿在消息中粘贴 API Key 或其他秘密。

- `/new`：进入新会话；普通会话通常在首个成功回合后才会保存，但成功创建计划会立即物化零回合 Session 并保留计划。
- `/sessions`：按最近更新时间列出并切换会话。
- `/delete`：确认后删除当前会话及其完整历史。

启动时 Coffee 自动恢复上次活动会话及其模型。如果模型不可用或缺少凭证，历史仍会打开，但需要先使用 `/model` 或 `/login`。

上下文默认在约 30,000 字符时生成滚动摘要，并在 40,000 字符硬限制内只发送最近的完整轮次。摘要不会删除 SQLite 中的原始消息。模型的原始 reasoning 不会展示，也不会进入滚动摘要。

## Tools

Coffee 会让当前模型根据问题自行决定是否调用以下工具：

- `web_search`：使用 Tavily 搜索网页，最多返回 5 条标题、链接和摘要。
- `web_fetch`：使用 Tavily Extract 读取一个指定 HTTPS 网页，返回最多 20,000 字符的 Markdown 正文。
- `get_current_location`：使用 IPWho 根据公网 IP 获取近似城市、地区、国家、经纬度和时区。
- `calculator`：计算包含数字、括号和 `+ - * / %` 的基础算术表达式。

调用工具时，CLI 会根据当前偏好显示多行冰美式或热拿铁动画，并在完成后留下简短的耗时状态。IP 定位不是 GPS 定位，使用 VPN 或代理时可能不准确；定位请求会发送到第三方 IPWho 服务。

动画偏好和模型偏好都保存在项目根目录的 `coffee.settings.json` 中：

```json
{
  "coffee-preferences": {
    "animation": "americano"
  },
  "model-preferences": {
    "provider": "opencode-go",
    "model": "kimi-k2.7-code"
  },
  "history-preferences": {
    "compression-threshold-chars": 30000,
    "max-context-chars": 40000,
    "summary-target-chars": 5000
  }
}
```

## 验证

```bash
npm test
npm run check
```

测试使用假的 HTTP 响应和本地 `fetch` preload，不会调用真实模型平台、Tavily 或 IPWho API，也不会消耗真实 API 额度。当前尚未在线验证各真实模型平台的流式兼容性。

## 当前边界

当前版本只通过目录内置平台的固定 Base URL，接入支持 OpenAI Chat Completions 风格流式输出与工具调用的模型，不支持任意自定义兼容端点。真实平台是否完整兼容仍需在线验证。当前不包含 LangChain、MCP 或图形 UI；单次请求最多连续执行 5 轮工具调用。
