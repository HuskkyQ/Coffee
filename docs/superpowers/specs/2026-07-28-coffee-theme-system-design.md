# Coffee 可扩展终端主题设计

日期：2026-07-28

## 1. 目标

为 Coffee CLI 增加可扩展的内置主题系统，通过 `/theme` 使用统一的方向键
选择器切换主题，并将选择保存到项目根目录的 `coffee.settings.json`。

首版内置三套休闲风主题：

- `latte`：奶油拿铁，默认主题。
- `coast`：周末海岸。
- `camp`：暮色露营。

本次同时完成此前已经确认的相关 CLI 收尾：

- 移除 `/like` 命令、冰美式和拿铁多行动画。
- 将工具和等待状态统一为简洁的单行旋转动画。
- 移除大型 `COFFEE` 启动字样，改用简约启动信息。
- 修复空输入时输入区出现两行高度的问题。

## 2. 非目标

本次不实现：

- 用户在 `coffee.settings.json` 中定义任意自定义主题。
- 从网络下载、安装或分享主题。
- `/theme latte` 等参数快捷方式。
- 为终端设置全局背景色。
- 完整 TUI 框架、鼠标操作或主题编辑器。
- 修改模型请求、工具协议、历史记录或任务计划业务规则。

以后新增内置主题时，只修改主题注册表并补充对应测试，不改变命令和设置
协议。

## 3. 已确认的产品行为

- `/theme` 打开统一选择器。
- TTY 中支持上下方向键移动、选中项高亮、Enter 确认、Esc 取消和
  Ctrl+C 退出。
- 菜单展示主题中文名称、三枚配色色点和当前主题状态。
- 选中后立即应用新主题，并原子保存到 `coffee.settings.json`。
- 保存失败时保持原主题，不出现运行时状态与持久化状态不一致。
- 新用户或没有主题设置的用户默认使用 `latte`。
- 无效主题回退到 `latte`，同时显示一条警告。
- `/theem` 等相近错误命令由本地命令解析器建议 `/theme`，不发送模型
  请求。
- True Color 终端使用精确 RGB 配色；其他彩色终端使用相近 ANSI 色；
  非 TTY 或设置 `NO_COLOR` 时输出纯文本。

## 4. 方案选择

采用“语义化主题注册表 + 显式样式上下文”方案。

每个主题只定义颜色角色，不知道具体 CLI 页面。CLI 启动时解析当前主题和
终端颜色能力，构造不可变的样式上下文，再明确传给输入、Markdown、流式
状态、工具、任务规划和启动信息等渲染器。

不采用全局活动主题。全局可变状态虽然改动较少，但会让并发测试、运行时
切换和渲染器隔离变得不可靠。

不实现完整样式引擎。字体、间距、图标和布局仍由各渲染组件管理，本阶段
只集中颜色语义。

## 5. 主题模型

新增独立主题模块 `src/theme.ts`，公开以下概念：

```ts
type ThemeId = "latte" | "coast" | "camp";
type ColorMode = "none" | "truecolor" | "ansi";

interface TerminalTheme {
  readonly id: ThemeId;
  readonly label: string;
  readonly colors: {
    readonly primary: ThemeColor;
    readonly accent: ThemeColor;
    readonly success: ThemeColor;
    readonly warning: ThemeColor;
    readonly error: ThemeColor;
    readonly muted: ThemeColor;
    readonly border: ThemeColor;
    readonly selectionBackground: ThemeColor;
  };
}

interface TerminalStyleContext {
  readonly theme: TerminalTheme;
  readonly colorMode: ColorMode;
}
```

`ThemeColor` 同时保存精确 RGB 值和 ANSI 降级颜色。渲染组件只按语义角色
请求颜色，不直接写死青色、黄色或品红色控制码。

主题注册表提供：

- 按 `ThemeId` 查找主题。
- 按注册顺序返回 `/theme` 菜单选项。
- 返回默认主题 `latte`。
- 创建角色样式和清除样式的 ANSI 序列。

主题对象和样式上下文均为只读值。运行时切换通过创建新的上下文完成，不
修改共享全局状态。

## 6. 内置主题

### 6.1 奶油拿铁 `latte`

面向温暖、松弛的咖啡馆氛围：

- 主色：`#D3A66F`
- 强调文字：`#EEE1CF`
- 成功：`#9FBC87`
- 警告：`#D3A66F`
- 错误：`#D78273`
- 弱化文字：`#A79379`
- 边框：`#806A54`
- 选中背景：`#403328`

### 6.2 周末海岸 `coast`

面向轻盈、清爽的周末海边氛围：

- 主色：`#80C1B7`
- 强调文字：`#E0EBE7`
- 成功：`#9BC492`
- 警告：`#D4B278`
- 错误：`#DC8179`
- 弱化文字：`#88A09E`
- 边框：`#4E787A`
- 选中背景：`#2B4244`

### 6.3 暮色露营 `camp`

面向安静、柔和的傍晚露营氛围：

- 主色：`#C991A7`
- 强调文字：`#ECDEE4`
- 成功：`#A8BD88`
- 警告：`#D2AE76`
- 错误：`#D47E75`
- 弱化文字：`#A18C96`
- 边框：`#725765`
- 选中背景：`#42323A`

三套主题的 ANSI 降级色分别以黄、青、品红作为主色，并共享绿、黄、红和
灰色的状态语义。Diff 的新增和删除继续保留绿、红含义，避免主题改变
代码审阅语义。

## 7. 颜色能力检测

颜色模式按以下顺序确定：

1. 输出不是 TTY，或存在 `NO_COLOR`：`none`。
2. `COLORTERM` 为 `truecolor` 或 `24bit`，`TERM` 明确包含
   `truecolor`、`24bit` 或 `direct`，或 `TERM_PROGRAM` 是 Coffee
   明确支持的现代终端：`truecolor`。
3. 其他 TTY：`ansi`。

首版明确识别 macOS Terminal、iTerm2、WezTerm、VS Code Terminal 和
Hyper 的 `TERM_PROGRAM` 标识。无法可靠识别的终端采用 ANSI 降级，
不会冒险输出不受支持的 24 位控制序列。

`none` 模式不得输出任何 ANSI 控制符，也不能仅依赖颜色传达当前项、
成功、错误或选择状态。

## 8. 设置格式与迁移

主题保存在现有 `coffee-preferences` 节点：

```json
{
  "coffee-preferences": {
    "theme": "latte"
  }
}
```

设置模块新增：

```ts
loadThemePreference(settingsPath?): Promise<LoadedThemePreference>
saveThemePreference(settingsPath, themeId): Promise<void>
```

行为规则：

- 文件不存在或没有 `theme` 时返回 `latte`。
- `theme` 不是字符串或不在注册表中时返回 `latte` 和警告。
- 保存时复用现有文件锁、写入队列和临时文件原子替换。
- 保存只更新 `coffee-preferences.theme`，保留根节点和偏好节点中的
  其他未知键。
- JSON 损坏时不覆盖原文件。
- 旧 `coffee-preferences.animation` 不再读取，也不主动删除或迁移。

`CoffeeAnimation`、`loadCoffeePreferences()` 和
`saveAnimationPreference()` 在没有其他调用方后删除。

## 9. `/theme` 命令

命令注册表增加：

```text
/theme    切换终端主题
```

并删除 `/like`。

TTY 菜单示意：

```text
选择主题

❯ 奶油拿铁   ● ● ●   当前
  周末海岸   ● ● ●
  暮色露营   ● ● ●

↑↓ 选择 · Enter 确认 · Esc 取消
```

- 菜单复用现有 `InputController.select()`。
- 初始项是当前主题。
- 色点分别使用该候选主题的主色、强调色和成功色；ANSI 模式使用候选
  主题的降级色；无颜色模式不显示依赖颜色的色点。
- 菜单框架和高亮使用当前活动主题，避免移动光标时提前切换整个界面。
- Enter 后先保存设置；成功后替换活动样式上下文，并输出使用新主题
  渲染的 `✓ 已切换为 <主题名称>`。
- Esc 返回主输入循环且不输出虚假成功信息。
- Ctrl+C 走 Coffee 统一中断路径，不显示 `AbortError` 堆栈。
- 非 TTY 使用现有编号选择兼容层；输入结束或无有效选择时安全取消。

## 10. 主题切换数据流

```text
启动
  → 读取 theme id
  → 解析终端颜色能力
  → 创建 TerminalStyleContext
  → 创建各终端渲染器

/theme
  → 选择候选主题
  → 原子保存候选 id
  → 创建新的 TerminalStyleContext
  → 显式更新输入控制器和空闲长生命周期渲染器的样式上下文
  → 后续输出使用新主题
```

Coffee 只会在主输入循环空闲时执行 `/theme`，此时不存在正在运行的模型
流或工具动画。输入控制器、工具状态和任务进度实例通过
`setStyleContext()` 更新各自的实例内上下文，避免销毁输入控制器时关闭
`stdin`。该状态不在模块全局共享；活动的流式渲染器不需要在中途换色。

## 11. 渲染接入范围

### 11.1 终端格式

`terminal-format.ts` 不再拥有固定颜色映射。`styleText()`、
`renderMarkdown()` 和 `styleDiffLine()` 接收显式样式上下文。

- 用户或输入边界：`primary`。
- Coffee 回复标识及成功消息：`success` 或 `primary`。
- Markdown 标题：`accent`。
- 加粗和重点：`warning`。
- 行内代码和链接：`primary`。
- 次要说明：`muted`。
- 错误：`error`。

### 11.2 输入区和选择器

- 输入区上下边界使用 `border`。
- 命令下拉和通用选择器的当前项使用 `primary` 与
  `selectionBackground`。
- 无颜色模式继续使用箭头或 `>` 标记当前项。
- 修复空输入时两行高度：在 `@inquirer/core` 的原始 prompt 行中加入
  不可见且显示宽度为零的锚点，使其 JavaScript 长度不为零，避免
  ScreenManager 把空行误判为“刚好占满终端宽度”并额外补行。
- 锚点不得出现在最终文本、光标位置计算或非 TTY 输出中。

### 11.3 简约启动信息

TTY 启动信息改为：

```text
Coffee
DeepSeek V4 Flash · ziling-erp-admin
/ 查看命令 · Ctrl+C 退出
```

其中模型名和工作区名使用实际值。未选择模型时显示“未选择模型”；工作区
只显示根目录 basename。`Coffee` 使用 `primary`，模型与工作区使用
`accent`，提示使用 `muted`。

非 TTY 保留紧凑纯文本启动信息和完整工作区路径，避免装饰性输出影响日志
可读性。

大型字样、咖啡杯图案及相关宽度分支全部删除。

### 11.4 单行加载与工具状态

删除冰美式和拿铁多行动画，统一使用：

```text
◐ 正在连接 DeepSeek V4 Flash…
◓ 正在分析问题…
◑ 正在准备调用工具…
◒ 正在整理工具结果…
```

- TTY 中只重绘当前物理行。
- 用户提交输入后立即显示初始状态，不等待模型返回第一个事件。
- 收到真实 `status`、工具或计划事件时更新文案。
- 正文开始前清除临时状态。
- 工具完成后保留一行简洁结果和耗时。
- 图标使用 `primary`，状态正文使用 `muted`，成功和失败分别使用
  `success` 与 `error`。
- 非 TTY 使用追加式纯文本状态，不输出动画控制符。
- Ctrl+C、异常和重复清理都必须恢复光标且不留下半行。

### 11.5 任务规划和代码 Diff

- 任务标题、当前步骤、进度动画和完成状态改用语义颜色。
- 任务计划的结构、状态机和 HITL 规则不变。
- Diff 文件头和块头使用 `primary`。
- 新增行保持绿色，删除行保持红色，普通上下文不着色。

## 12. 错误处理

- 无效的已保存主题：使用 `latte` 并显示一次警告，不自动改写文件。
- 设置读取错误：保持现有启动失败或警告边界，不吞掉磁盘错误。
- 主题保存失败：保留原样式上下文和原渲染器，显示清洗后的错误。
- 渲染异常：不得触发模型请求、工具执行或设置写入。
- 未知命令：继续由本地命令解析器阻断并给出相似命令建议。
- 任何主题中，错误、选择和安全确认都必须有非颜色标记。

## 13. 测试设计

### 13.1 主题单元测试

- 注册表包含 `latte`、`coast`、`camp`，且 `latte` 为默认。
- 每套主题具有全部语义角色。
- True Color 输出包含预期 RGB 控制序列。
- ANSI 模式只包含降级控制序列。
- `none` 模式不包含 ANSI 控制符。
- 未知主题 id 返回默认主题和警告。

### 13.2 设置测试

- 文件缺失、偏好缺失和有效主题。
- 非字符串及未知主题。
- 保存主题时保留根节点、`coffee-preferences` 其他键和未知键。
- JSON 损坏时不覆盖。
- 并发写入继续由现有队列和文件锁串行化。
- 旧 `animation` 键被忽略但保留。

### 13.3 命令与输入测试

- `/theme` 出现在命令列表、斜杠下拉和帮助中。
- `/like` 从命令列表、下拉、帮助和 CLI 路由中消失。
- `/theem` 建议 `/theme`，且不触发模型请求。
- 上下键、高亮、当前主题初始项、Enter、Esc 和 Ctrl+C。
- 色点在三种颜色模式下正确退化。
- 空输入和输入文本时均保持单行高度。

### 13.4 渲染与 CLI 回归测试

- 简约 TTY 启动信息使用实际模型和工作区名称。
- 非 TTY 启动信息保持纯文本。
- Markdown、命令菜单、输入边界、加载状态、工具、任务规划和 Diff
  使用传入主题。
- 主题切换后后续输出使用新主题。
- 保存失败不切换运行时主题。
- 输入提交后在首个流事件前立即出现单行状态。
- Ctrl+C 不显示内部 `readline` 堆栈。
- 流式正文不重复，非 TTY 不产生光标控制序列。

最后执行：

```bash
npm run check
npm test
```

## 14. 验收标准

- `/theme` 可以通过方向键在三套主题间切换，并在重启后保持选择。
- 三套主题在 True Color 终端呈现已确认的休闲配色，在其他环境可靠
  降级。
- 所有主要终端渲染面都不再写死旧的青、黄、品红主题。
- `/like`、咖啡多行动画和大型启动字样完全移除。
- 空输入区与有文本时高度一致。
- 用户提交后立即看到单行状态，工具和模型等待期间没有视觉滞空。
- 非 TTY、`NO_COLOR`、Ctrl+C、设置损坏和保存失败均安全退化。
- TypeScript 检查和完整测试套件通过。
