# Coffee Pi 风格 CLI 交互 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Coffee 的列表菜单增加方向键、高亮、Enter 确认、Esc 取消交互，并把主聊天提示改为无 `You>` 的 Pi 风格细边界输入区。

**Architecture:** 在现有 `InputController` 内增加泛型 `select()`，TTY 使用基于 `@inquirer/core` 的状态驱动选择器，非 TTY 使用同一组选项生成编号回退菜单。CLI 只把业务对象映射为结构化选项，选中后继续执行原有登录、模型、会话和偏好逻辑。

**Tech Stack:** TypeScript、Node.js、`@inquirer/core`、Node test runner、tsx

---

> Coffee 目录没有 Git 元数据。以下任务以红灯、绿灯和完整回归作为检查点，
> 不执行 Git commit。

### Task 1: 通用选择状态机与渲染

**Files:**
- Modify: `src/chat-input.ts`
- Test: `test/chat-input.test.ts`

- [ ] **Step 1: 写选择状态机的失败测试**

在 `test/chat-input.test.ts` 导入新的纯函数和类型，并覆盖首项、循环、禁用项、
Esc、窗口滚动：

```ts
const items = [
  { label: "A", value: "a" },
  { label: "B", value: "b", disabled: true },
  { label: "C", value: "c" },
] as const;

assert.equal(getInitialSelectionIndex(items), 0);
assert.equal(moveSelection(items, 0, "down"), 2);
assert.equal(moveSelection(items, 2, "down"), 0);
assert.deepEqual(getSelectionWindow(9, 7, 4), {
  start: 5,
  end: 9,
});
```

为渲染增加断言：

```ts
const rendered = renderSelectionView({
  message: "选择模型",
  items,
  active: 0,
  pageSize: 8,
  useColor: false,
});
assert.match(rendered, /> A/);
assert.match(rendered, /↑↓ 移动 · Enter 确认 · Esc 取消/);
```

- [ ] **Step 2: 运行测试并确认因 API 缺失而失败**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: FAIL，提示 `getInitialSelectionIndex`、`moveSelection`、
`getSelectionWindow` 或 `renderSelectionView` 尚未导出。

- [ ] **Step 3: 实现最小纯状态与渲染函数**

在 `src/chat-input.ts` 增加：

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

export type SelectionMove = "up" | "down";

export function getInitialSelectionIndex<T>(
  items: readonly SelectionItem<T>[],
): number | undefined;

export function moveSelection<T>(
  items: readonly SelectionItem<T>[],
  active: number,
  move: SelectionMove,
): number;

export function getSelectionWindow(
  total: number,
  active: number,
  pageSize: number,
): { start: number; end: number };

export function renderSelectionView<T>(config: {
  message: string;
  items: readonly SelectionItem<T>[];
  active: number;
  pageSize: number;
  useColor: boolean;
  columns?: number;
}): string;
```

实现约束：

- 初始项为第一个 `disabled !== true` 的选项。
- 上下移动跳过禁用项并首尾循环。
- `pageSize` 至少为 1。
- 无颜色当前项使用 `>`；有颜色时使用 `→` 和反显。
- `status` 放在标签右侧，`description` 放在下一行。
- 只截断显示文本，不修改 `value`。

- [ ] **Step 4: 运行选择状态机测试并确认通过**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: PASS。

### Task 2: TTY 选择提示与非 TTY 回退

**Files:**
- Modify: `src/chat-input.ts`
- Test: `test/chat-input.test.ts`

- [ ] **Step 1: 写 `InputController.select()` 的失败测试**

使用现有 TTY 测试流构造控制器，增加：

```ts
const selected = controller.select({
  message: "选择模型",
  items: [
    { label: "A", value: "a" },
    { label: "B", value: "b" },
  ],
});
input.write("\u001b[B\r");
assert.equal(await selected, "b");
```

再覆盖：

```ts
input.write("\u001b");
assert.equal(await cancelled, undefined);
```

非 TTY 使用输入 `2\n`，断言返回第二项真实值，并断言输出包含：

```text
1. A
2. B
```

- [ ] **Step 2: 运行测试并确认因 `select` 不存在而失败**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: FAIL，提示 `controller.select is not a function` 或接口缺少该方法。

- [ ] **Step 3: 实现 TTY prompt 和回退**

使用 `createPrompt` 增加内部 `selectionPrompt`：

```ts
interface SelectionPromptConfig<T> extends SelectionOptions<T> {
  readonly useColor: boolean;
  readonly columns?: number;
}

const selectionPrompt = createPrompt<unknown, SelectionPromptConfig<unknown>>(
  (config, done) => {
    const [active, setActive] = useState(
      getInitialSelectionIndex(config.items) ?? 0,
    );
    useKeypress((key) => {
      if (isUpKey(key)) setActive(moveSelection(config.items, active, "up"));
      else if (isDownKey(key)) {
        setActive(moveSelection(config.items, active, "down"));
      } else if (key.name === "escape") done(undefined);
      else if (isEnterKey(key) && !config.items[active]?.disabled) {
        done(config.items[active]?.value);
      }
    });
    return renderSelectionView({
      ...config,
      active,
      pageSize: config.pageSize ?? 8,
    });
  },
);
```

为 `InputController` 增加：

```ts
select<T>(options: SelectionOptions<T>): Promise<T | undefined>;
```

TTY 调用传入：

```ts
{
  input,
  output,
  signal,
  clearPromptOnDone: true,
}
```

非 TTY：

- 输出 `message` 和编号选项。
- 读取一行。
- 只接受 `1..items.length` 的安全整数。
- 禁用项和无效编号返回 `undefined`。
- 空列表不读取输入并返回 `undefined`。

- [ ] **Step 4: 运行测试并确认通过**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: PASS，且没有未处理的 `AbortPromptError` 或 `ExitPromptError`。

### Task 3: Pi 风格主输入行

**Files:**
- Modify: `src/chat-input.ts`
- Modify: `src/cli.ts`
- Test: `test/chat-input.test.ts`
- Test: `test/cli.test.ts`

- [ ] **Step 1: 写无 `You>` 输入区的失败测试**

纯渲染测试要求空 `message` 的主输入包含上下边界：

```ts
const view = renderChatPrompt({
  message: "",
  line: "hello",
  dropdown: "",
  useColor: false,
  columns: 40,
});
assert.match(view[0], /^─{20,}\nhello$/u);
assert.match(view[1] ?? "", /^─{20,}$/u);
```

CLI PTY 测试改为等待细横线和输入行，不再等待 `You>`，并断言：

```ts
assert.doesNotMatch(output, /You>/);
```

- [ ] **Step 2: 运行测试并确认旧提示导致失败**

Run:

```bash
node --import tsx --test test/chat-input.test.ts test/cli.test.ts
```

Expected: FAIL，输出仍包含 `You>` 或 `renderChatPrompt` 尚不存在。

- [ ] **Step 3: 实现边界输入区**

在 `src/chat-input.ts` 增加纯函数：

```ts
export function renderChatPrompt(config: {
  message: string;
  line: string;
  dropdown: string;
  useColor: boolean;
  columns?: number;
}): [string, string | undefined];
```

规则：

- `message !== ""` 时保持 `${message}${line}` 的现有文本问题样式。
- `message === ""` 时使用 `Math.max(20, Math.min(columns ?? 80, 80))`
  个 `─`。
- 主内容为 `topBorder + "\n" + line`。
- bottom content 为 `bottomBorder`，有命令建议时在边界后追加建议。
- 边界使用 Coffee 用户主题色；无颜色时保留字符。

在 `src/cli.ts` 删除：

```ts
const prompt = styleText("You> ", "user", useColor);
```

主循环改为：

```ts
const answer = await inputController.ask("");
```

- [ ] **Step 4: 运行输入与 CLI 测试并确认通过**

Run:

```bash
node --import tsx --test test/chat-input.test.ts test/cli.test.ts
```

Expected: PASS，主提示无 `You>`，`/` 建议测试继续通过。

### Task 4: 接入登录、退出和模型菜单

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`
- Test: `test/login-command.test.ts`
- Test: `test/logout-command.test.ts`
- Test: `test/model-command.test.ts`

- [ ] **Step 1: 写三个命令的键盘选择失败测试**

CLI PTY 测试分别输入：

```ts
"/login\r", "\u001b[B", "\r"
"/logout\r", "\r"
"/model\r", "\u001b[B", "\r", "\u001b[B", "\r"
```

断言：

- 菜单中出现 `→` 或无颜色回退标记。
- 方向键不会把 ANSI 字节当成文本编号。
- Enter 触发现有凭证或模型业务逻辑。
- Esc 返回主输入，不写入状态。

- [ ] **Step 2: 运行测试并确认编号菜单无法满足测试**

Run:

```bash
node --import tsx --test test/cli.test.ts
```

Expected: FAIL，旧 CLI 仍要求输入数字。

- [ ] **Step 3: 用结构化选项替换 `askMenu()`**

`/login` 平台选项：

```ts
const selected = await inputController.select({
  message: "选择登录平台",
  items: modelRegistry.getCredentials().map((credential) => ({
    label: credential.name,
    value: credential,
    status: formatCredentialStatus(statuses.get(credential.id)),
  })),
});
```

已配置凭证动作：

```ts
[
  { label: "保留当前凭证", value: "keep" as const },
  { label: "更新 API Key", value: "update" as const },
  { label: "取消", value: "cancel" as const },
]
```

`/logout` 直接把 `CredentialDefinition` 作为 `value`。

`/model`：

- provider `value` 为 `ProviderDefinition`。
- model `value` 为 `ModelDefinition`。
- 当前项设置 `status: "当前"`。
- 不再调用 `parseProviderChoice()` 或 `parseModelChoice()`。

选择返回 `undefined` 时取消当前命令；若 `abortController.signal.aborted`
则主循环下一次读取立即退出。

- [ ] **Step 4: 运行相关测试并确认通过**

Run:

```bash
node --import tsx --test \
  test/chat-input.test.ts \
  test/login-command.test.ts \
  test/logout-command.test.ts \
  test/model-command.test.ts \
  test/cli.test.ts
```

Expected: PASS。

### Task 5: 接入会话和咖啡偏好菜单

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`
- Test: `test/session-commands.test.ts`
- Test: `test/like-command.test.ts`

- [ ] **Step 1: 写 `/sessions` 和 `/like` 键盘选择失败测试**

会话选项测试要求：

```ts
{
  label: sanitizeTerminalText(session.title) || "新会话",
  value: session,
  description: `${providerId}/${modelId} · ${messageCount} 条消息 · ${updatedAt}`,
  status: session.id === activeSessionId ? "当前" : undefined,
}
```

`/like` 测试用 `↓` 后 Enter 选择拿铁，并断言设置文件写入 `latte`。

- [ ] **Step 2: 运行测试并确认旧编号菜单失败**

Run:

```bash
node --import tsx --test \
  test/session-commands.test.ts \
  test/like-command.test.ts \
  test/cli.test.ts
```

Expected: FAIL，旧菜单仍需要数字。

- [ ] **Step 3: 接入结构化选择**

`/sessions`：

```ts
const selected = await inputController.select({
  message: "选择会话",
  items: sessions.map((session) => ({
    label: sanitizeTerminalText(session.title) || "新会话",
    value: session,
    description: formatSessionDescription(session),
    status:
      session.id === sessionManager.getCurrent().id ? "当前" : undefined,
  })),
});
```

`/like`：

```ts
const selected = await inputController.select({
  message: "选择你喜欢的工具动画",
  items: [
    {
      label: "冰美式",
      value: "americano" as const,
      status: animation === "americano" ? "当前" : undefined,
    },
    {
      label: "热拿铁",
      value: "latte" as const,
      status: animation === "latte" ? "当前" : undefined,
    },
  ],
});
```

确认安全交互继续调用 `inputController.ask(..., false)`，不得改为
`select()`。

- [ ] **Step 4: 运行相关测试并确认通过**

Run:

```bash
node --import tsx --test \
  test/chat-input.test.ts \
  test/session-commands.test.ts \
  test/like-command.test.ts \
  test/cli.test.ts
```

Expected: PASS。

### Task 6: 回归与终端行为验收

**Files:**
- Modify only if a failing requirement identifies a defect in files already listed
- Test: `test/*.test.ts`

- [ ] **Step 1: 运行完整测试**

Run:

```bash
npm test
```

Expected: 0 failed。

- [ ] **Step 2: 运行 TypeScript 检查**

Run:

```bash
npm run check
```

Expected: exit code 0。

- [ ] **Step 3: 运行真实 PTY 冒烟测试**

Run:

```bash
npm start
```

手动验证：

- 主输入没有 `You>`。
- 输入 `/` 出现命令建议。
- `/model` 可用上下方向键、高亮和 Esc。
- `/like` 可选择两种咖啡。
- Ctrl+C 正常退出且不出现堆栈。

- [ ] **Step 4: 对照设计验收**

逐项检查
`docs/superpowers/specs/2026-07-28-pi-style-cli-interactions-design.md`
第 13 节的八条验收标准。任何一项未满足都不能声明完成。
