# Coffee Ctrl+C 退出设计

> 状态：已被 `2026-07-13-coffee-cli-polish-design.md` 取代。真实终端 Ctrl+C 由 readline 自己的 `SIGINT` 事件触发，不能只依赖进程级信号监听。

## 目标

在保留 `/exit` 命令的同时，让 Coffee CLI 在等待终端输入时支持 Ctrl+C，并以退出码 `0` 正常结束。

## 范围

包含：

- 监听当前 Node.js 进程的 `SIGINT` 信号。
- 使用 `AbortController` 中断正在等待的 `readline.question()`。
- Ctrl+C 后输出换行、关闭 readline，并正常退出。
- 启动提示同时说明 `/exit` 和 Ctrl+C 两种退出方式。
- 通过真实子进程测试发送 `SIGINT` 并验证退出行为。
- 更新 README 的退出说明。

不包含：

- 二次退出确认。
- 会话保存。
- 修改 DeepSeek 请求或消息历史逻辑。
- 处理 SIGTERM 等其他操作系统信号。

## 实现设计

`src/cli.ts` 在创建 readline 后创建一个 `AbortController`，并注册一次进程级 `SIGINT` 监听器。监听器只负责输出换行并调用 `abort()`。

每次 `readline.question()` 都接收同一个 `AbortSignal`。Ctrl+C 触发后，等待中的问题以 `AbortError` 结束；CLI 将这个已知中断转换为正常返回码 `0`，其他异常继续抛出。`finally` 中移除信号监听器并关闭 readline，避免残留监听器。

`/exit` 保持现有路径，不触发 `AbortController`，直接返回 `0`。

## 测试设计

扩展 `test/cli.test.ts`：

1. 以测试 API Key 启动真实 CLI 子进程。
2. 等待 stdout 出现 `You>`，确保 CLI 已进入输入等待状态。
3. 向子进程发送 `SIGINT`。
4. 断言子进程退出码为 `0`，stderr 为空。

测试不会输入普通消息，因此不会调用 DeepSeek API，也不会消耗额度。现有缺少 Key 和 `/exit` 测试保持不变。

## 验收标准

- `/exit` 仍以退出码 `0` 正常结束。
- Ctrl+C 以退出码 `0` 正常结束。
- Ctrl+C 不产生未处理异常或错误输出。
- 启动提示和 README 同时列出两种退出方式。
- 全部自动化测试与 TypeScript 类型检查通过。
