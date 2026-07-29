# Coffee Pi 风格 CLI 交互设计

日期：2026-07-28

## 1. 目标

统一 Coffee 中的离散选项菜单，使用户可以通过上下方向键移动、高亮当前
选项并用 Enter 确认；同时移除普通聊天输入行的 `You>` 标签，改为接近
Pi 的细边界输入区。

本次只调整终端交互层，不改变登录、模型切换、会话管理、咖啡偏好等业务
规则，也不改变模型请求、工具调用或历史记录的数据协议。

## 2. 已确认的产品行为

- 采用基于现有 `@inquirer/core` 的自定义选择器，不新增选择器依赖。
- TTY 菜单支持 `↑`、`↓`、Enter、Esc 和 Ctrl+C。
- 当前项使用青色 `→` 和整行高亮。
- 长列表最多显示约 8 项，并跟随当前项滚动。
- 菜单底部显示 `↑↓ 移动 · Enter 确认 · Esc 取消`。
- 确认后清除菜单，只保留一行简洁的选择结果。
- 普通聊天输入移除 `You>`，使用上下细横线围成的单行输入区。
- `/` 命令补全继续可用。
- API Key、Base URL 等自由文本继续使用文本输入。
- 密钥输入继续隐藏内容。
- Shell/HITL 授权、删除确认、相近命令纠错继续使用明确的 `y/n`。
- 非 TTY 环境继续使用编号菜单。

## 3. 非目标

本次不实现：

- 完整复用或引入 Pi 的 TUI 包。
- 鼠标选择。
- 菜单搜索、过滤或模糊匹配。
- 多列菜单或树形菜单。
- 将安全确认改成带默认值的高亮选项。
- 修改 Coffee 的启动横幅、工具动画或流式 Markdown 样式。
- 改变现有命令名称和业务行为。

## 4. 方案选择

### 4.1 采用方案

在现有 `src/chat-input.ts` 中实现通用的 TTY 选择提示，并由
`InputController.select()` 暴露给 CLI。

该方案沿用当前输入控制器、Ctrl+C 生命周期和 `@inquirer/core` 渲染
机制，可以精确控制 Pi 风格外观，同时避免新增依赖或把 Coffee 与 Pi
内部包耦合。

### 4.2 未采用方案

不引入 `@inquirer/select`。它能减少少量实现代码，但会限制选择标记、
确认后的摘要、滚动提示和输入区风格的一致性。

不直接复用 Pi TUI 组件。该方式会引入跨项目依赖、适配不同输入控制器，
并明显扩大本次改动范围。

## 5. 公共类型与组件边界

`src/chat-input.ts` 新增结构化选项类型：

```ts
export interface SelectionItem<T> {
  readonly label: string;
  readonly value: T;
  readonly description?: string;
  readonly status?: string;
  readonly disabled?: boolean;
}

export interface SelectionOptions<T> {
  readonly message: string;
  readonly items: readonly SelectionItem<T>[];
  readonly pageSize?: number;
}
```

`InputController` 新增：

```ts
select<T>(options: SelectionOptions<T>): Promise<T | undefined>
```

返回语义：

- Enter 返回当前选项的 `value`。
- Esc 返回 `undefined`。
- Ctrl+C 继续触发 Coffee 已有的中断退出路径。
- 空选项列表直接返回 `undefined`，并由调用方展示业务提示。

选择器只处理终端交互，不知道厂商、模型、会话或咖啡偏好等业务概念。

## 6. TTY 选择器行为

### 6.1 导航

- 初始选中第一个可用选项。
- `↑` 和 `↓` 在可用选项之间循环移动。
- 禁用项可以展示，但不能成为当前项。
- Enter 只确认可用项。
- Esc 取消本层菜单。

当所有选项均被禁用时，选择器不进入等待状态，调用方收到
`undefined`。

### 6.2 视窗

- 默认 `pageSize` 为 8。
- 选项数量不超过 `pageSize` 时全部显示。
- 超出时只渲染包含当前项的连续窗口。
- 底部附加 `(当前位置/总数)`，帮助用户理解列表仍有未显示内容。
- 终端尺寸变化后的下一次渲染重新计算可用宽度。

### 6.3 样式

示意：

```text
选择方舟 Agent Plan 模型

  Ark Code Latest
→ Doubao Seed 2.1 Turbo    当前模型
  GLM-5.2
  Kimi K3

↑↓ 移动 · Enter 确认 · Esc 取消
```

- 当前项使用青色箭头、文字和背景高亮。
- 普通项不使用前景强调。
- `status` 用弱化颜色显示在标签之后。
- `description` 可显示在下一行，并与主标签缩进对齐。
- 无颜色终端退化为 `>` 前缀，不依赖颜色表达状态。
- 超长标签按可见列宽截断；`value` 不受影响。

### 6.4 完成后的输出

交互菜单由 `@inquirer/core` 在同一区域重绘，方向键操作不得向终端重复
追加整个列表。确认后清除菜单区域，只保留：

```text
✓ 已选择 Doubao Seed 2.1 Turbo
```

取消后不输出虚假的选择结果。

## 7. 普通输入区

TTY 普通聊天输入改为：

```text
────────────────────────────────────────
帮我检查当前项目的类型错误
────────────────────────────────────────
```

- 不显示 `You>` 或其他角色标签。
- 上下边界使用 Coffee 现有主题中的青色。
- 输入区域保持单行编辑体验。
- `/` 仍触发现有命令建议列表。
- 命令建议的方向键、Tab、Enter 和 Esc 行为保持不变。
- 提交后输入边界退出，避免与流式回答或工具动画重叠。

非 TTY 文本输入不输出装饰边界，避免污染管道输出。

密钥、Base URL 和其他带业务含义的文本问题继续显示明确提示；移除的只是
主聊天循环中的 `You>`。

## 8. 菜单接入范围

以下命令改用 `InputController.select()`：

### 8.1 `/login`

- 选择厂商。
- 选择已有凭证的操作方式。
- 选择动作后继续使用现有自由文本或密钥输入。

### 8.2 `/logout`

- 选择需要退出的厂商。
- 后续业务规则保持不变。

### 8.3 `/model`

- 选择厂商。
- 选择该厂商提供的模型。
- 当前厂商、当前模型和不可用状态通过 `status` 或 `disabled` 展示。

### 8.4 `/sessions`

- 选择历史会话。
- 选择会话相关操作。
- 会话标题、时间等辅助信息通过 `description` 展示。

### 8.5 `/like`

- 选择冰美式或拿铁。
- 选择结果仍写入现有 `coffee.settings.json` 的
  `coffee-preferences`。

## 9. 数据流与兼容层

TTY 数据流：

```text
命令模块生成结构化选项
  → CLI 调用 InputController.select()
  → TTY 选择器返回真实 value
  → 命令模块执行现有业务逻辑
```

非 TTY 数据流：

```text
同一组结构化选项
  → InputController 输出编号菜单
  → 读取编号并完成边界校验
  → 返回与 TTY 相同的真实 value
```

业务模块不再依赖“把用户输入的字符串编号重新解析成业务值”。如果为了
控制改动范围需要暂时保留现有解析函数，它们只能作为非 TTY 兼容层使用，
不得再参与 TTY 选择。

## 10. 安全确认

以下交互明确不使用带默认高亮的选择器：

- Shell 命令执行授权。
- HITL 高风险操作确认。
- 删除会话确认。
- 相近命令纠错确认。

它们继续要求用户输入 `y` 或 `n`。这样不会因为连续按 Enter 或误触方向键
而默认批准有副作用的操作。

## 11. 取消与错误处理

- Esc 只取消当前菜单，并返回对应命令的上一级或主输入循环。
- 取消不能修改认证、模型、会话或偏好状态。
- Ctrl+C 必须经过统一中断处理，不得暴露
  `node:internal/readline` 的 `AbortError` 堆栈。
- 空列表由命令模块显示明确原因，例如“该厂商暂无可选模型”。
- 选项在显示后失效时，业务模块仍按现有校验拒绝操作并刷新状态。
- 渲染异常不得触发模型请求或业务写入。

## 12. 测试设计

### 12.1 `test/chat-input.test.ts`

增加 TTY 选择器测试：

- 初始选中第一项。
- 上下方向键移动和首尾循环。
- Enter 返回真实值。
- Esc 返回 `undefined`。
- Ctrl+C 无未处理 `AbortError`。
- 禁用项被跳过。
- 空列表立即结束。
- 长列表滚动及位置提示。
- 无颜色模式仍有文本选中标记。
- 普通输入不再显示 `You>`。
- `/` 命令补全没有回归。

### 12.2 命令模块测试

更新：

- `test/login-command.test.ts`
- `test/logout-command.test.ts`
- `test/model-command.test.ts`
- `test/session-commands.test.ts`
- `test/like-command.test.ts`

重点验证命令模块生成的结构化选项、取消不写入，以及选择真实值后执行原有
业务逻辑。

### 12.3 CLI 集成测试

更新 `test/cli.test.ts`：

- TTY 主输入行不包含 `You>`。
- `/login`、`/logout`、`/model`、`/sessions` 和 `/like` 能通过键盘选择。
- 菜单重绘不会产生重复文案。
- 确认后只保留简洁结果。
- 未知命令仍在模型请求前被拦截。
- 安全确认仍使用 `y/n`。
- 非 TTY 编号输入仍可完成相同操作。
- Ctrl+C 正常退出且无堆栈。

## 13. 验收标准

实现完成必须满足：

1. 五类列表命令全部支持方向键、高亮、Enter 和 Esc。
2. 主聊天输入不再显示 `You>`，且 `/` 命令建议正常。
3. 菜单导航不向终端追加重复列表。
4. Ctrl+C 不产生 `AbortError` 或未处理拒绝。
5. 安全确认继续使用明确的 `y/n`。
6. 非 TTY 编号菜单可用。
7. `npm test` 全部通过。
8. `npm run check` 通过。

