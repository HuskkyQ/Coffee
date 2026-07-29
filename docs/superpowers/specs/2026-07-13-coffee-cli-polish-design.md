# Coffee CLI 退出与终端样式设计

## 目标

修复真实终端按 Ctrl+C 时冒出 `AbortError` 堆栈的问题，并为 Coffee CLI 增加无第三方依赖的彩色 Markdown 轻量渲染，让咖啡店推荐等回答更适合终端阅读。

## 已确认根因

Node.js 22 的 readline 在收到终端 Ctrl+C 时会检查 readline 接口自身是否注册了 `SIGINT` 监听器。当前 Coffee 没有注册，因此 readline 关闭并以 `AbortError("Aborted with Ctrl+C")` 拒绝正在等待的 `question()`；该异常没有被捕获，最终显示内部堆栈。

模型回答则未经处理直接传给 `console.log`。DeepSeek 返回的 `**加粗**`、`* 列表` 等 Markdown 标记会原样出现，同时没有 ANSI 色彩。

当前 `agent.ts` 中的咖啡店 `SYSTEM_PROMPT` 是用户新增内容，必须原样保留。现有三个 Agent 测试失败是因为旧断言没有包含新的 system 消息，应同步测试预期，不得删除角色定义来让旧测试通过。

## Ctrl+C 设计

CLI 创建一个 `AbortController` 和一个幂等的退出处理器。该处理器输出一个换行并调用 `abort()`。

同一个处理器同时注册到：

- readline 接口的 `SIGINT` 事件：覆盖真实终端按 Ctrl+C。
- Node.js 进程的 `SIGINT` 事件：覆盖外部发送操作系统信号以及自动化子进程测试。

`readline.question()` 接收对应的 `AbortSignal`。等待被中断后，CLI 只在信号已经 abort 时把异常转换成正常退出码 `0`；其他输入异常继续抛出。`finally` 中移除 readline 和 process 两处监听器，并关闭 readline。

`/exit` 保持现有行为，仍返回退出码 `0`。

## 终端渲染设计

新增 `src/terminal-format.ts`，只负责把模型文本转换成适合终端显示的字符串，不参与 API 请求或消息历史。

支持以下轻量规则：

- Markdown 标题：移除 `#`，使用亮紫色粗体。
- `**加粗**`：移除星号，使用亮黄色粗体。
- `*` 或 `-` 开头的无序列表：统一转换为 `•`，项目符号使用青色。
- 行内代码：移除反引号，使用亮青色。
- Markdown 链接：显示链接文字，并把 URL 设为蓝色下划线。
- `Coffee>` 标签使用亮绿色粗体。
- `You>` 标签使用亮青色粗体。
- 启动提示使用紫色与青色组合。
- 错误提示使用亮红色。

渲染器使用原生 ANSI 转义码，不添加 Chalk、marked-terminal 或其他运行时依赖。CLI 在真实 TTY 中启用颜色；输出被管道重定向或设置 `NO_COLOR` 时输出无 ANSI 的干净文本。测试可以显式打开颜色，获得确定性断言。

这不是完整 Markdown 解析器。第一版只处理 Coffee 常见回答所需的标题、加粗、列表、行内代码和链接，避免为单一 CLI 引入复杂语法树。

## 测试设计

### Ctrl+C

- 子进程测试等待 `You>` 出现后发送 `SIGINT`，断言退出码为 `0`、不是被信号杀死、stderr 为空。
- 使用 tmux 启动真实 TTY，发送 Ctrl+C，断言 CLI 返回退出码 `0` 且没有 `AbortError` 堆栈。
- 保留 `/exit` 与缺少 API Key 的现有测试。

### 渲染器

- 输入包含标题、`**加粗**`、星号列表、行内代码与链接的固定文本。
- 无颜色模式断言 Markdown 标记被正确清理、星号列表变成 `•`。
- 颜色模式断言包含预期 ANSI 颜色码，并且 Markdown 星号不再显示。
- CLI 测试验证启动提示包含 `/exit` 和 Ctrl+C。

### 用户角色测试

- 更新请求体断言，明确第一条消息为 system 角色，并验证后续 user/assistant 历史顺序。
- 不修改用户写入的 `SYSTEM_PROMPT` 内容。

## 文件边界

- 修改 `src/cli.ts`：中断处理与渲染器接入。
- 新增 `src/terminal-format.ts`：ANSI 颜色和轻量 Markdown 格式化。
- 修改 `test/cli.test.ts`：SIGINT 子进程回归测试。
- 新增 `test/terminal-format.test.ts`：格式与颜色测试。
- 修改 `test/agent.test.ts`：同步 system 消息预期。
- 修改 `README.md`：两种退出方式和彩色输出说明。
- 不修改 `agent.ts` 中的角色提示词，不修改 `../pi`。

## 验收标准

- 真实终端 Ctrl+C 不显示 `AbortError`，退出码为 `0`。
- `/exit` 继续正常工作。
- 咖啡店推荐中的 Markdown 标题、加粗、列表、代码和链接在终端得到彩色展示。
- Markdown 的 `**` 和列表 `*` 不再原样出现。
- 非 TTY 或 `NO_COLOR` 环境不输出 ANSI 转义码。
- 用户的 Coffee 角色提示词保持不变。
- 所有测试和 TypeScript 类型检查通过。
