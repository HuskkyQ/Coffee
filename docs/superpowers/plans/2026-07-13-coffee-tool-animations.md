# Coffee Tool Animations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `Tool>` with selectable multi-line coffee animations and persist the global `/like` preference in `coffee.settings.json`.

**Architecture:** A settings module owns safe JSON read/write, a command module parses `/like`, and an activity module owns frames, timing, cursor control, and plain-text fallback. The agent emits tool lifecycle events while the CLI coordinates settings, commands, and rendering.

**Tech Stack:** TypeScript, Node.js 22 filesystem and terminal APIs, native timers, `@inquirer/core`, Node test runner.

---

The directory is not a Git repository, so worktree and commit steps are intentionally omitted.

### Task 1: Persistent Coffee settings

**Files:**
- Create: `src/settings.ts`
- Create: `test/settings.test.ts`

- [ ] **Step 1: Write failing tests for defaults, preservation, and damaged JSON**

```ts
test("uses americano when the settings file is missing", async () => {
  const result = await loadCoffeePreferences(path.join(tempDir, "missing.json"));
  assert.deepEqual(result, { animation: "americano" });
});

test("saves animation while preserving unrelated settings", async () => {
  await writeFile(settingsPath, JSON.stringify({
    theme: "dark",
    "coffee-preferences": { volume: 2, animation: "americano" },
  }));
  await saveAnimationPreference(settingsPath, "latte");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    theme: "dark",
    "coffee-preferences": { volume: 2, animation: "latte" },
  });
});

test("warns and refuses to overwrite damaged JSON", async () => {
  await writeFile(settingsPath, "not-json");
  const loaded = await loadCoffeePreferences(settingsPath);
  assert.equal(loaded.animation, "americano");
  assert.match(loaded.warning ?? "", /JSON/);
  await assert.rejects(saveAnimationPreference(settingsPath, "latte"), /JSON/);
});
```

- [ ] **Step 2: Run `node --import tsx --test test/settings.test.ts`**

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/settings.js`.

- [ ] **Step 3: Implement settings read/write**

```ts
export type CoffeeAnimation = "americano" | "latte";
export const DEFAULT_ANIMATION: CoffeeAnimation = "americano";
export const SETTINGS_PATH = fileURLToPath(
  new URL("../coffee.settings.json", import.meta.url),
);

export interface LoadedCoffeePreferences {
  animation: CoffeeAnimation;
  warning?: string;
}

export async function loadCoffeePreferences(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedCoffeePreferences>;

export async function saveAnimationPreference(
  settingsPath: string,
  animation: CoffeeAnimation,
): Promise<void>;
```

`loadCoffeePreferences` treats `ENOENT` as the default, validates that the root and `coffee-preferences` are JSON objects, accepts only `americano` and `latte`, and returns a warning for invalid content. `saveAnimationPreference` reads the latest object, refuses malformed JSON or non-object roots, preserves unrelated fields, writes two-space JSON, and appends one newline.

- [ ] **Step 4: Run `node --import tsx --test test/settings.test.ts`**

Expected: all settings tests pass.

### Task 2: `/like` command parser

**Files:**
- Create: `src/like-command.ts`
- Create: `test/like-command.test.ts`

- [ ] **Step 1: Write failing parser tests**

```ts
assert.deepEqual(parseLikeCommand("你好"), { type: "none" });
assert.deepEqual(parseLikeCommand("/like"), { type: "menu" });
assert.deepEqual(parseLikeCommand("/like americano"), {
  type: "select", animation: "americano",
});
assert.deepEqual(parseLikeCommand("/like latte"), {
  type: "select", animation: "latte",
});
assert.deepEqual(parseLikeCommand("/like mocha"), { type: "invalid" });
assert.equal(parseLikeMenuChoice("1"), "americano");
assert.equal(parseLikeMenuChoice("2"), "latte");
assert.equal(parseLikeMenuChoice("3"), undefined);
```

- [ ] **Step 2: Run `node --import tsx --test test/like-command.test.ts`**

Expected: FAIL because `src/like-command.ts` does not exist.

- [ ] **Step 3: Implement the parser and menu text**

```ts
export type LikeCommand =
  | { type: "none" }
  | { type: "menu" }
  | { type: "select"; animation: CoffeeAnimation }
  | { type: "invalid" };

export function parseLikeCommand(input: string): LikeCommand;
export function parseLikeMenuChoice(input: string): CoffeeAnimation | undefined;
export function renderLikeMenu(current: CoffeeAnimation): string;
export const LIKE_USAGE = "用法：/like、/like americano 或 /like latte";
```

- [ ] **Step 4: Run `node --import tsx --test test/like-command.test.ts`**

Expected: all parser tests pass.

### Task 3: Multi-line activity renderer

**Files:**
- Create: `src/activity-indicator.ts`
- Create: `test/activity-indicator.test.ts`

- [ ] **Step 1: Write failing tests for frames and terminal behavior**

```ts
test("renders distinct americano and latte frames", () => {
  assert.match(getAnimationFrames("americano", "web_search")[0].join("\n"), /◇/);
  assert.match(getAnimationFrames("latte", "web_search")[0].join("\n"), /♡/);
});

test("animates in a color TTY and leaves one success line", () => {
  const renderer = createActivityRenderer({
    output, isTTY: true, useColor: true,
    getAnimation: () => "americano",
    now: sequenceClock(1000, 2300),
    startTimer, stopTimer,
  });
  renderer.handle({ name: "web_search", phase: "start" });
  renderer.handle({ name: "web_search", phase: "success" });
  assert.match(written, /\u001b\[\?25l/);
  assert.match(written, /\u001b\[\?25h/);
  assert.match(written, /✓ 网络信息已经带回 · 1\.3s/);
});

test("uses plain lines outside a color TTY", () => {
  const renderer = createActivityRenderer({
    output, isTTY: false, useColor: false,
    getAnimation: () => "latte",
    now: sequenceClock(0, 800),
  });
  renderer.handle({ name: "get_current_location", phase: "start" });
  renderer.handle({ name: "get_current_location", phase: "error" });
  assert.doesNotMatch(written, /\u001b\[/);
  assert.match(written, /拿铁正在感知你的位置/);
  assert.match(written, /✗ 近似定位暂时失败 · 0\.8s/);
});
```

- [ ] **Step 2: Run `node --import tsx --test test/activity-indicator.test.ts`**

Expected: FAIL because `src/activity-indicator.ts` does not exist.

- [ ] **Step 3: Implement the renderer**

```ts
export type ToolActivityPhase = "start" | "success" | "error";
export interface ToolActivityEvent { name: string; phase: ToolActivityPhase }
export interface ActivityRenderer {
  handle(event: ToolActivityEvent): void;
  dispose(): void;
}

export function getAnimationFrames(
  animation: CoffeeAnimation,
  toolName: string,
): string[][];

export function createActivityRenderer(options: ActivityOptions): ActivityRenderer;
```

Use fixed eight-line frame arrays. In a color TTY, write `\u001b[?25l`, redraw every 140 ms by moving up and clearing eight lines, then clear the block and write `\u001b[?25h` plus the final status. In fallback mode, write one start line and one final line without ANSI. `dispose()` always clears the timer and restores the cursor without a completion message.

- [ ] **Step 4: Run `node --import tsx --test test/activity-indicator.test.ts`**

Expected: all activity renderer tests pass.

### Task 4: Agent lifecycle events

**Files:**
- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`

- [ ] **Step 1: Replace the old callback test with failing lifecycle assertions**

```ts
const activities: ToolActivityEvent[] = [];
const conversation = createConversation({
  apiKey: "test-key",
  tavilyApiKey: "tvly-test",
  fetchImpl,
  onToolActivity(event) { activities.push(event); },
});
await conversation.send("我在哪里？");
assert.deepEqual(activities, [
  { name: "get_current_location", phase: "start" },
  { name: "get_current_location", phase: "success" },
]);
```

For the existing Tavily 429 test, collect the same events and assert:

```ts
assert.deepEqual(activities, [
  { name: "web_search", phase: "start" },
  { name: "web_search", phase: "error" },
]);
assert.equal(reply, "搜索服务暂时不可用。");
```

- [ ] **Step 2: Run `node --import tsx --test test/agent.test.ts`**

Expected: FAIL because `onToolActivity` is not supported.

- [ ] **Step 3: Emit lifecycle events around every tool execution**

```ts
await onToolActivity?.({ name: toolCall.function.name, phase: "start" });
const result = await tools.execute(toolCall.function.name, toolCall.function.arguments);
const succeeded = JSON.parse(result).ok === true;
await onToolActivity?.({
  name: toolCall.function.name,
  phase: succeeded ? "success" : "error",
});
```

Keep sequential execution, tool result messages, rollback, and the five-round limit unchanged.

- [ ] **Step 4: Run `node --import tsx --test test/agent.test.ts`**

Expected: all agent tests pass.

### Task 5: CLI integration and documentation

**Files:**
- Create: `coffee.settings.json`
- Modify: `src/cli.ts`
- Modify: `src/terminal-format.ts`
- Modify: `test/terminal-format.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Remove the obsolete `tool` label test and add the default settings file**

```json
{
  "coffee-preferences": {
    "animation": "americano"
  }
}
```

- [ ] **Step 2: Load settings, route `/like`, and connect lifecycle rendering**

```ts
const loaded = await loadCoffeePreferences();
let animation = loaded.animation;
const activity = createActivityRenderer({
  output,
  isTTY: output.isTTY,
  useColor,
  getAnimation: () => animation,
});

conversation = createConversation({
  apiKey: process.env.DEEPSEEK_API_KEY,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  onToolActivity(event) { activity.handle(event); },
});
```

For `menu`, ask one extra readline question using the existing abort signal. For `select`, call `saveAnimationPreference(SETTINGS_PATH, selected)` first, update the in-memory preference only after success, and print `✓ 已切换为冰美式` or `✓ 已切换为热拿铁`. Invalid input prints `LIKE_USAGE`. Call `activity.dispose()` in the CLI `finally` block.

- [ ] **Step 3: Remove `tool` from `StyleKind` and `STYLE_CODES`**

The activity renderer now owns progress colors, so the old label style is unused.

- [ ] **Step 4: Update README**

Document the two animations, `/like`, shortcut forms, the `coffee.settings.json` structure, global persistence, TTY behavior, and `NO_COLOR` fallback.

- [ ] **Step 5: Run `npm test`**

Expected: zero failed tests.

- [ ] **Step 6: Run `npm run check`**

Expected: TypeScript exits 0 without diagnostics.

- [ ] **Step 7: Verify the approved scope**

Confirm there are exactly two selectable styles, preference is global and persistent under `coffee-preferences.animation`, unrelated settings survive writes, no animation dependency was added, `/like` never reaches DeepSeek, and existing `/exit` and Ctrl+C behavior remain intact.

### Task 6: Command registry and fuzzy blocking

**Files:**
- Create: `src/commands.ts`
- Create: `test/commands.test.ts`

- [ ] **Step 1: Write failing tests for filtering and unknown commands**

```ts
assert.deepEqual(getCommandSuggestions("/"), [COMMANDS[0], COMMANDS[1]]);
assert.deepEqual(getCommandSuggestions("/li").map((item) => item.name), ["/like"]);
assert.deepEqual(resolveCommandInput("你好"), { type: "chat", input: "你好" });
assert.equal(resolveCommandInput("/like latte").type, "known");
assert.deepEqual(resolveCommandInput("/likes latte"), {
  type: "suggestion",
  unknown: "/likes",
  suggestedInput: "/like latte",
});
assert.equal(resolveCommandInput("/lik").type, "suggestion");
assert.equal(resolveCommandInput("/liek").type, "suggestion");
assert.deepEqual(resolveCommandInput("/coffee"), {
  type: "unknown",
  command: "/coffee",
});
```

- [ ] **Step 2: Run `node --import tsx --test test/commands.test.ts`**

Expected: FAIL because `src/commands.ts` does not exist.

- [ ] **Step 3: Implement the single command registry and resolver**

```ts
export interface CommandDefinition {
  name: "/like" | "/exit";
  description: string;
  acceptsArguments: boolean;
}

export const COMMANDS: readonly CommandDefinition[] = [
  { name: "/like", description: "选择咖啡动画", acceptsArguments: true },
  { name: "/exit", description: "退出 Coffee", acceptsArguments: false },
];

export type CommandResolution =
  | { type: "chat"; input: string }
  | { type: "known"; command: CommandDefinition; input: string }
  | { type: "suggestion"; unknown: string; suggestedInput: string }
  | { type: "unknown"; command: string };

export function getCommandSuggestions(input: string): CommandDefinition[];
export function resolveCommandInput(input: string): CommandResolution;
export function renderAvailableCommands(): string;
```

Use prefix filtering for the live list. For submitted unknown commands, use prefix relation or Levenshtein distance `<= 2`; replace only the first whitespace-delimited token so arguments remain intact. Never classify a leading-slash input as chat.

- [ ] **Step 4: Run `node --import tsx --test test/commands.test.ts`**

Expected: all command registry tests pass.

### Task 7: Inquirer chat input with live dropdown

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/chat-input.ts`
- Create: `test/chat-input.test.ts`

- [ ] **Step 1: Install the approved input dependency**

Run: `npm install @inquirer/core`

Expected: `@inquirer/core` appears under runtime `dependencies`; no React or Ink dependency is added.

- [ ] **Step 2: Write failing pure-state tests for dropdown keys**

```ts
assert.deepEqual(getDropdownView("/", 0, false).items.map((item) => item.name), [
  "/like", "/exit",
]);
assert.equal(applyDropdownKey({ line: "/", active: 0, dismissed: false }, "down").active, 1);
assert.deepEqual(
  applyDropdownKey({ line: "/l", active: 0, dismissed: false }, "tab"),
  { line: "/like ", active: 0, dismissed: false, action: "fill" },
);
assert.equal(
  applyDropdownKey({ line: "/e", active: 0, dismissed: false }, "enter").submit,
  "/exit",
);
assert.equal(
  applyDropdownKey({ line: "/", active: 0, dismissed: false }, "escape").dismissed,
  true,
);
```

- [ ] **Step 3: Run `node --import tsx --test test/chat-input.test.ts`**

Expected: FAIL because `src/chat-input.ts` does not exist.

- [ ] **Step 4: Implement the custom prompt and non-TTY controller**

```ts
export interface InputController {
  ask(message: string, suggestions?: boolean): Promise<string | undefined>;
  close(): void;
}

export function createInputController(options: {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
  signal: AbortSignal;
  useColor: boolean;
}): InputController;
```

For TTY input, use `createPrompt`, `useKeypress`, and `useState` from `@inquirer/core`. Return the prompt line plus a second rendered string containing filtered commands. Up/down changes the active index, Tab rewrites the readline line with `rl.write`, Enter returns the highlighted command or raw line, and Escape dismisses suggestions. For non-TTY input, retain one `readline/promises` interface and return ordinary lines without ANSI. Convert abort and Inquirer exit errors to `undefined`; `close()` releases only resources owned by the controller.

- [ ] **Step 5: Run `node --import tsx --test test/chat-input.test.ts`**

Expected: all prompt state tests pass.

### Task 8: Unknown command confirmation and final CLI wiring

**Files:**
- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add failing no-network CLI tests**

```ts
const typo = await runCli("test-key", "/likes\nn\n/exit\n");
assert.equal(typo.code, 0);
assert.match(typo.stdout + typo.stderr, /是否改用 \/like/);
assert.doesNotMatch(typo.stderr, /意外的网络请求/);

const unknown = await runCli("test-key", "/coffee\n/exit\n");
assert.equal(unknown.code, 0);
assert.match(unknown.stdout + unknown.stderr, /未知命令：\/coffee/);
assert.match(unknown.stdout + unknown.stderr, /\/like/);
assert.match(unknown.stdout + unknown.stderr, /\/exit/);
```

Add the acceptance and persistence case:

```ts
await withSettingsBackup(async (settingsPath) => {
  const accepted = await runCli("test-key", "/likes latte\n\n/exit\n");
  assert.equal(accepted.code, 0);
  assert.doesNotMatch(accepted.stderr, /意外的网络请求/);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    "coffee-preferences": { animation: "latte" },
  });
});
```

- [ ] **Step 2: Run `node --import tsx --test test/cli.test.ts`**

Expected: the new cases fail because unknown slash inputs are not locally resolved.

- [ ] **Step 3: Replace direct readline ownership with `InputController`**

Before routing, call `resolveCommandInput`. For `suggestion`, ask `是否改用 <suggestedInput>？ (Y/n)` without command suggestions; empty input, `y`, or `yes` accepts. For `unknown`, print `未知命令：<command>` plus `renderAvailableCommands()` and continue. Only `chat` reaches `conversation.send`. Route known `/exit` and `/like` locally, preserving the existing animation selection behavior.

- [ ] **Step 4: Run `node --import tsx --test test/cli.test.ts`**

Expected: all CLI tests pass without a real HTTP request.

- [ ] **Step 5: Update README and run full verification**

Document the slash dropdown keys, fuzzy correction, local blocking, `@inquirer/core`, both `/like` forms, animations, and settings file. Run `npm test` and `npm run check`; both must exit 0.
