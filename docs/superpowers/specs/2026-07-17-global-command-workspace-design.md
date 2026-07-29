# Coffee 全局命令与工作区设计

## 目标

让用户在任意终端目录执行 `coffee` 即可启动 Coffee Agent，并将当前 Git 仓库根目录识别为本次会话的工作区。

```bash
cd ~/projects/shop-api/src/controllers
coffee
```

如果启动目录属于 Git 仓库，工作区为 `git rev-parse --show-toplevel` 返回的仓库根目录；如果不属于 Git 仓库，工作区回退为启动时的当前目录。

## 非目标

- 本次不增加文件读取、写入、删除或 Shell 工具。
- 本次不依赖提示词提供文件系统安全隔离。
- 本次不实现面向其他用户发布的 npm 安装包。
- 本次不改变 API Key、对话历史和 Coffee 设置的现有存储位置。

## 全局命令

`package.json` 通过 `bin` 字段注册名为 `coffee` 的可执行入口。开发环境在 Coffee 项目目录执行一次：

```bash
npm link
```

之后 npm 的全局可执行目录中会创建 `coffee` 命令。由于使用符号链接，Coffee 源码发生变化后无需重复安装。

启动入口必须满足以下要求：

1. 保留调用者的当前工作目录，禁止切换到 Coffee 源码目录。
2. 根据入口文件位置定位 Coffee 安装目录。
3. 从 Coffee 安装目录加载 `.env`。
4. 使用项目自身安装的 `tsx` 启动 TypeScript CLI，不能要求调用目录安装 `tsx`。
5. 将 CLI 的退出码原样返回给终端。

## 目录边界

Coffee 同时维护应用目录和工作区，两者用途不同。

### 应用数据

- `.env`：Coffee 安装目录。
- `coffee.settings.json`：Coffee 项目根目录。
- API Key：`~/.coffee/auth.json`。
- SQLite 对话历史：`~/.coffee/history.sqlite`。

这些路径属于 Coffee 自身状态，不受工作区限制。

### 项目工作区

CLI 启动时首先记录 `process.cwd()`，再解析工作区：

1. 对启动目录执行 `git rev-parse --show-toplevel`。
2. Git 命令成功时使用仓库根目录。
3. Git 不可用或当前目录不在仓库中时使用启动目录。
4. 最终路径通过 `realpath` 规范化，消除符号链接和路径别名。

CLI 启动信息显示最终工作区，方便用户在发送请求前检查边界：

```text
Workspace: /Users/sevan/projects/shop-api
```

工作区作为显式运行时数据传入 Conversation，而不是隐藏在可变的全局当前目录中。系统提示可以说明当前工作区，但提示词只用于帮助模型理解环境，不作为安全机制。

## 后续文件工具的安全约束

Coffee 当前没有本地文件工具，因此本次功能不会产生项目文件访问能力。以后增加文件工具时，所有工具必须使用统一的工作区路径解析器，并满足：

- 相对路径以工作区根目录为基准。
- 拒绝解析到工作区之外的绝对路径和 `..` 路径。
- 使用真实路径检查符号链接逃逸。
- 对尚不存在的写入目标检查其最近存在父目录的真实路径。
- 写入、删除等高风险操作进入独立确认流程。
- 通用 Shell 工具必须使用进程级沙箱；路径校验无法约束任意 Shell 命令。

## 错误处理

- `.env` 不存在时沿用当前 CLI 的缺少凭证提示，不制造额外崩溃。
- Git 不可用、命令失败或当前目录不属于仓库时静默回退到启动目录。
- 启动目录无法解析真实路径时打印明确错误并终止启动。
- TypeScript 入口加载失败时保留原始错误信息和非零退出码。

## 验证

自动测试覆盖：

1. 从 Git 仓库根目录启动时识别该目录。
2. 从 Git 仓库子目录启动时识别仓库根目录。
3. 从非 Git 目录启动时回退到当前目录。
4. 路径包含空格时仍能正确启动和识别。
5. 启动器从 Coffee 安装目录加载 `.env`，同时保持调用者当前目录不变。
6. 启动信息展示规范化后的工作区路径。

人工验收命令：

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm link

cd /Users/sevan/ai-tasks/pi-agent/pi/packages/agent
coffee
```

预期 Coffee 正常启动，并显示工作区为：

```text
/Users/sevan/ai-tasks/pi-agent/pi
```

卸载开发链接：

```bash
npm unlink --global coffee-agent
```
