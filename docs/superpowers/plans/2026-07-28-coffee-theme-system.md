# Coffee Theme System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three persistent, extensible terminal themes behind `/theme`, remove the old drink animations and oversized banner, and provide stable single-line waiting feedback.

**Architecture:** A typed theme registry owns semantic color roles and terminal fallbacks. The CLI creates an immutable `TerminalStyleContext` and passes it into renderers; long-lived renderer instances expose instance-local `setStyleContext()` methods for safe runtime switching. Theme selection is saved atomically through the existing settings lock, while all non-TTY and `NO_COLOR` paths remain plain text.

**Tech Stack:** TypeScript 7, Node.js 22+, `@inquirer/core`, `string-width`, Node test runner, existing JSON settings/file-lock layer.

---

## Repository note

`/Users/sevan/ai-tasks/pi-agent/coffee` has no Git metadata. The usual commit step
after each task is therefore replaced by a verification checkpoint. Do not initialize
a repository, create a worktree, or manufacture commit history.

## File responsibility map

**Create**

- `src/theme.ts` — theme types, registry, color capability detection and ANSI painting.
- `src/theme-command.ts` — `/theme` selection items and current selection index.
- `src/line-status.ts` — reusable, one-line spinner for model waiting and tool activity.
- `test/theme.test.ts` — registry, True Color, ANSI and no-color behavior.
- `test/theme-command.test.ts` — theme menu construction and current selection.
- `test/line-status.test.ts` — spinner lifecycle, append-only fallback and cleanup.

**Modify**

- `src/settings.ts` — load and atomically save `coffee-preferences.theme`.
- `src/commands.ts` — register `/theme`; eventually remove `/like`.
- `src/chat-input.ts` — theme-aware prompts, preview swatches, initial selection and
  stable empty-line height.
- `src/terminal-format.ts` — replace fixed ANSI palette with semantic theme roles.
- `src/startup-banner.ts` — replace the artwork with compact startup content.
- `src/activity-indicator.ts` — replace drink art with `line-status`.
- `src/planning/render.ts` — remove drink preference and use theme roles.
- `src/streaming-markdown-renderer.ts` — receive the style context for Markdown output.
- `src/tool-interaction.ts` — theme-aware Diff output and runtime style update.
- `src/cli.ts` — load/switch themes, show immediate waiting status, and remove `/like`.
- `README.md` — document `/theme`, the minimal banner and single-line status.
- Existing tests in `test/settings.test.ts`, `test/commands.test.ts`,
  `test/chat-input.test.ts`, `test/terminal-format.test.ts`,
  `test/startup-banner.test.ts`, `test/activity-indicator.test.ts`,
  `test/planning-render.test.ts`, `test/streaming-markdown-renderer.test.ts`,
  `test/tool-interaction.test.ts`, and `test/cli.test.ts`.

**Delete after all callers are migrated**

- `src/like-command.ts`
- `test/like-command.test.ts`

### Task 1: Typed theme registry and color capability detection

**Files:**

- Create: `src/theme.ts`
- Create: `test/theme.test.ts`

- [x] **Step 1: Write the failing registry and color-mode tests**

Create `test/theme.test.ts` with concrete expectations:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_THEME_ID,
  createStyleContext,
  getTheme,
  getThemes,
  paintTheme,
  resolveColorMode,
} from "../src/theme.js";

test("registers the three themes with latte as the default", () => {
  assert.equal(DEFAULT_THEME_ID, "latte");
  assert.deepEqual(
    getThemes().map(({ id, label }) => ({ id, label })),
    [
      { id: "latte", label: "奶油拿铁" },
      { id: "coast", label: "周末海岸" },
      { id: "camp", label: "暮色露营" },
    ],
  );
  assert.equal(getTheme("missing"), undefined);
});

test("paints exact RGB, ANSI fallback, and plain text", () => {
  const rgb = createStyleContext("latte", "truecolor");
  assert.equal(
    paintTheme("Coffee", "primary", rgb),
    "\u001b[38;2;211;166;111mCoffee\u001b[0m",
  );
  assert.match(
    paintTheme("Coffee", "primary", createStyleContext("coast", "ansi")),
    /^\u001b\[[0-9;]+mCoffee\u001b\[0m$/u,
  );
  assert.equal(
    paintTheme("Coffee", "primary", createStyleContext("camp", "none")),
    "Coffee",
  );
});

test("detects no color, true color, and ANSI fallback deterministically", () => {
  assert.equal(resolveColorMode({ isTTY: false }), "none");
  assert.equal(resolveColorMode({ isTTY: true, noColor: "1" }), "none");
  assert.equal(
    resolveColorMode({ isTTY: true, colorTerm: "truecolor" }),
    "truecolor",
  );
  assert.equal(
    resolveColorMode({ isTTY: true, termProgram: "Apple_Terminal" }),
    "truecolor",
  );
  assert.equal(resolveColorMode({ isTTY: true, term: "xterm-256color" }), "ansi");
});
```

- [x] **Step 2: Run the test and verify the missing module failure**

Run:

```bash
node --import tsx --test test/theme.test.ts
```

Expected: FAIL with `Cannot find module '../src/theme.js'`.

- [x] **Step 3: Implement the immutable registry and painter**

Create `src/theme.ts` with these public types and functions:

```ts
export type ThemeId = "latte" | "coast" | "camp";
export type ColorMode = "none" | "truecolor" | "ansi";
export type ThemeRole =
  | "primary"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "border"
  | "selectionBackground";

export interface ThemeColor {
  readonly rgb: readonly [number, number, number];
  readonly ansi: string;
}

export interface TerminalTheme {
  readonly id: ThemeId;
  readonly label: string;
  readonly colors: Readonly<Record<ThemeRole, ThemeColor>>;
}

export interface TerminalStyleContext {
  readonly theme: TerminalTheme;
  readonly colorMode: ColorMode;
}

export const DEFAULT_THEME_ID: ThemeId = "latte";

export function getThemes(): readonly TerminalTheme[];
export function getTheme(id: string): TerminalTheme | undefined;
export function createStyleContext(
  themeId: ThemeId,
  colorMode: ColorMode,
): TerminalStyleContext;
export function resolveColorMode(options: {
  isTTY: boolean | undefined;
  noColor?: string;
  colorTerm?: string;
  term?: string;
  termProgram?: string;
}): ColorMode;
export function paintTheme(
  text: string,
  role: ThemeRole,
  styles: TerminalStyleContext,
  options?: {
    bold?: boolean;
    underline?: boolean;
    backgroundRole?: ThemeRole;
  },
): string;
```

Define every role for all three palettes using the RGB values in
`docs/superpowers/specs/2026-07-28-coffee-theme-system-design.md`. Use yellow,
cyan and magenta as the respective ANSI primary fallbacks, plus standard green,
yellow, red and gray status fallbacks. `paintTheme()` must emit background RGB
only when `backgroundRole` is supplied and must return the input unchanged in
`none` mode.

- [x] **Step 4: Run the focused tests**

Run:

```bash
node --import tsx --test test/theme.test.ts
```

Expected: all tests in `test/theme.test.ts` PASS.

- [x] **Step 5: Verification checkpoint**

Run:

```bash
npx tsc --noEmit --pretty false
```

Expected: the existing project still type-checks because no current caller has been
changed yet.

### Task 2: Persistent theme preference

**Files:**

- Modify: `src/settings.ts:11-20,120-162,264-279`
- Modify: `test/settings.test.ts`

- [x] **Step 1: Add failing theme preference tests**

Add tests that use temporary settings files:

```ts
test("loads latte by default and warns for an unknown theme", async () => {
  const missing = join(await mkdtemp(join(tmpdir(), "coffee-theme-")), "settings.json");
  assert.deepEqual(await loadThemePreference(missing), { themeId: "latte" });

  await writeFile(
    missing,
    JSON.stringify({ "coffee-preferences": { theme: "neon" } }),
  );
  const invalid = await loadThemePreference(missing);
  assert.equal(invalid.themeId, "latte");
  assert.match(invalid.warning ?? "", /coffee-preferences\\.theme/);
});

test("saves theme atomically while preserving unrelated and legacy keys", async () => {
  await writeFile(
    settingsPath,
    JSON.stringify({
      keep: true,
      "coffee-preferences": { animation: "latte", volume: 2 },
    }),
  );
  await saveThemePreference(settingsPath, "coast");
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    keep: true,
    "coffee-preferences": {
      animation: "latte",
      volume: 2,
      theme: "coast",
    },
  });
});
```

Also cover a non-object `coffee-preferences`, malformed JSON, and two concurrent
theme/model writes.

- [x] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test test/settings.test.ts
```

Expected: FAIL because `loadThemePreference` and `saveThemePreference` are not
exported.

- [x] **Step 3: Add theme loading and saving**

Import `DEFAULT_THEME_ID`, `getTheme`, and `ThemeId` from `theme.ts`, then add:

```ts
export interface LoadedThemePreference {
  themeId: ThemeId;
  warning?: string;
}

export async function loadThemePreference(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedThemePreference>;

export async function saveThemePreference(
  settingsPath: string,
  themeId: ThemeId,
): Promise<void>;
```

`loadThemePreference()` must preserve malformed-file behavior, return
`DEFAULT_THEME_ID` when the section or key is missing, and warn when the key is
not a registered theme. `saveThemePreference()` must call the existing
`updateSettings()` helper and spread existing object keys before assigning
`theme: themeId`.

Do not remove animation APIs yet; the CLI still imports them until Task 8.

- [x] **Step 4: Run settings tests and type-check**

Run:

```bash
node --import tsx --test test/settings.test.ts
npx tsc --noEmit --pretty false
```

Expected: both commands PASS.

### Task 3: `/theme` command data and local typo blocking

**Files:**

- Create: `src/theme-command.ts`
- Create: `test/theme-command.test.ts`
- Modify: `src/commands.ts:1-62`
- Modify: `src/chat-input.ts:39-45`
- Modify: `test/commands.test.ts`

- [x] **Step 1: Write failing command and menu-model tests**

Create `test/theme-command.test.ts`:

```ts
test("builds registered themes in stable order with the current index", () => {
  const model = getThemeSelectionModel("coast", "truecolor");
  assert.equal(model.initialIndex, 1);
  assert.deepEqual(model.items.map((item) => item.value), [
    "latte",
    "coast",
    "camp",
  ]);
  assert.equal(model.items[1]?.status, "当前");
  assert.match(model.items[0]?.preview ?? "", /●/u);
});
```

Update command tests to assert:

```ts
assert.ok(COMMANDS.some((command) => command.name === "/theme"));
assert.deepEqual(resolveCommandInput("/theem"), {
  type: "suggestion",
  unknown: "/theem",
  suggestedInput: "/theme",
});
```

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
node --import tsx --test test/theme-command.test.ts test/commands.test.ts
```

Expected: FAIL because `theme-command.ts` and `/theme` do not exist.

- [x] **Step 3: Implement the selection model and register `/theme`**

Add `/theme` to the `CommandDefinition["name"]` union and `COMMANDS`:

```ts
{
  name: "/theme",
  description: "切换终端主题",
  acceptsArguments: false,
}
```

Create `src/theme-command.ts`:

```ts
export interface ThemeSelectionModel {
  readonly items: readonly SelectionItem<ThemeId>[];
  readonly initialIndex: number;
}

export function getThemeSelectionModel(
  current: ThemeId,
  colorMode: ColorMode,
): ThemeSelectionModel;
```

Add `readonly preview?: string` to `SelectionItem` in `src/chat-input.ts`.
Map the registered themes to stable labels and values, mark the current item with
`status: "当前"`, and return its array index. Build a candidate style context for
each registered theme and place `primary`, `accent`, and `success` `●` glyphs in
`preview`. In `none` mode, use the plain text preview `● ● ●`.

Keep `/like` registered until Task 8 so the existing CLI remains coherent during
intermediate checkpoints.

- [x] **Step 4: Run the tests**

Run:

```bash
node --import tsx --test test/theme-command.test.ts test/commands.test.ts
```

Expected: PASS, including the `/theem` local suggestion.

### Task 4: Theme-aware input and stable empty prompt height

**Files:**

- Modify: `src/chat-input.ts:39-51,114-175,238-298,373-482,547-629`
- Modify: `test/chat-input.test.ts`

- [x] **Step 1: Add failing render and controller tests**

Add focused tests for:

```ts
test("uses semantic theme colors for selection and previews", () => {
  const styles = createStyleContext("camp", "truecolor");
  const output = renderSelectionView({
    message: "选择主题",
    items: [{
      label: "暮色露营",
      value: "camp",
      status: "当前",
      preview: "● ● ●",
    }],
    active: 0,
    pageSize: 8,
    styles,
  });
  assert.match(output, /\u001b\[48;2;66;50;58m/u);
  assert.match(stripAnsi(output), /暮色露营.*● ● ●.*当前/u);
});

test("keeps an empty chat prompt on one visual input row", () => {
  const [main] = renderChatPrompt({
    message: "",
    line: "",
    dropdown: "",
    styles: createStyleContext("latte", "ansi"),
    columns: 40,
  });
  const promptLine = main.split("\n").at(-1) ?? "";
  assert.equal(stringWidth(promptLine), 0);
  assert.ok(promptLine.length > 0);
});
```

Also verify `initialIndex` is honored by the TTY selector and
`setStyleContext()` changes subsequent prompts without recreating the controller.

- [x] **Step 2: Run the test and verify the old fixed cyan behavior fails**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: FAIL because prompt functions still require `useColor`, have no preview,
and emit a truly empty raw prompt line.

- [x] **Step 3: Implement explicit instance-local styles**

Change the public input contracts to:

```ts
export interface SelectionItem<T> {
  readonly label: string;
  readonly value: T;
  readonly description?: string;
  readonly status?: string;
  readonly preview?: string;
  readonly disabled?: boolean;
}

export interface SelectionOptions<T> {
  readonly message: string;
  readonly items: readonly SelectionItem<T>[];
  readonly pageSize?: number;
  readonly initialIndex?: number;
}

export interface InputController {
  readonly isInteractive: boolean;
  ask(message: string, suggestions?: boolean): Promise<string | undefined>;
  askSecret(message: string): Promise<string | undefined>;
  select<T>(options: SelectionOptions<T>): Promise<T | undefined>;
  setStyleContext(styles: TerminalStyleContext): void;
  close(): void;
}
```

`createInputController()` receives initial `styles`, stores them in an
instance-local variable and passes the current value into every new prompt.
Render selection marker, status, description, dropdown and borders with semantic
roles. Apply `selectionBackground` without overwriting ANSI already present in a
candidate preview.

Use `"\u200B"` as the raw empty-line anchor only in the TTY decorated prompt. It
has JavaScript length 1 and terminal display width 0, preventing Inquirer
ScreenManager's `0 % width === 0` extra newline. Do not include it in submitted
input or non-TTY output.

- [x] **Step 4: Run input tests**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: all input, dropdown, selection, Esc and Ctrl+C tests PASS.

### Task 5: Semantic terminal formatting and direct consumers

**Files:**

- Modify: `src/terminal-format.ts:1-129`
- Modify: `src/streaming-markdown-renderer.ts:1-4,180-203,306-315`
- Modify: `src/tool-interaction.ts:1-27,52-67`
- Modify: `test/terminal-format.test.ts`
- Modify: `test/streaming-markdown-renderer.test.ts`
- Modify: `test/tool-interaction.test.ts`

- [x] **Step 1: Add failing semantic-role tests**

Replace fixed-color assertions with theme assertions:

```ts
test("renders markdown with the selected theme", () => {
  const styles = createStyleContext("coast", "truecolor");
  const output = renderMarkdown("# 标题\n- **重点**和`代码`", styles);
  assert.match(output, /\u001b\[38;2;224;235;231m标题/u);
  assert.match(output, /\u001b\[38;2;212;178;120m重点/u);
  assert.match(output, /\u001b\[38;2;128;193;183m代码/u);
  assert.doesNotMatch(output, /\*\*/u);
});

test("keeps diff addition and deletion semantics across themes", () => {
  const styles = createStyleContext("camp", "truecolor");
  assert.match(styleDiffLine("+added", styles), /\u001b\[38;2;168;189;136m/u);
  assert.match(styleDiffLine("-removed", styles), /\u001b\[38;2;212;126;117m/u);
});
```

Update renderer fixtures to pass `styles` instead of `useColor`; assert
`NO_COLOR`-equivalent contexts contain no ANSI.

- [x] **Step 2: Run the three focused suites and verify signature failures**

Run:

```bash
node --import tsx --test \
  test/terminal-format.test.ts \
  test/streaming-markdown-renderer.test.ts \
  test/tool-interaction.test.ts
```

Expected: FAIL at the old boolean formatting signatures.

- [x] **Step 3: Refactor terminal formatting**

Keep `StyleKind` for call-site readability, but map it to theme roles:

```ts
const STYLE_ROLES: Record<StyleKind, ThemeRole> = {
  user: "primary",
  assistant: "success",
  startup: "primary",
  error: "error",
};
```

Final signatures:

```ts
renderMarkdown(input: string, styles: TerminalStyleContext): string;
styleText(text: string, kind: StyleKind, styles: TerminalStyleContext): string;
styleDiffLine(line: string, styles: TerminalStyleContext): string;
```

Delete `shouldUseColor()` after all callers move to `resolveColorMode()`.
Headings use `accent`, list bullets and inline code use `primary`, emphasis uses
`warning`, links use underlined `primary`, and Diff uses the rules in the design.

Staging note: `planning/render.ts` and the remaining CLI text call sites are
scheduled for Tasks 7 and 8, so their boolean compatibility path and
`shouldUseColor()` remain until those callers move.

- [x] **Step 4: Migrate streaming and tool interaction**

Change `StreamingMarkdownRendererOptions.useColor` to `styles` and call
`renderMarkdown(currentLine, styles)`.

Make `createToolInteraction()` return a named interface with:

```ts
export interface CoffeeToolInteraction
  extends ToolInteraction, ShellInteraction {
  setStyleContext(styles: TerminalStyleContext): void;
}
```

Store styles per instance, use the current styles for Diff lines, and leave all
HITL wording and `y/N` behavior unchanged.

- [x] **Step 5: Run the focused suites**

Run:

```bash
node --import tsx --test \
  test/terminal-format.test.ts \
  test/streaming-markdown-renderer.test.ts \
  test/tool-interaction.test.ts
```

Expected: PASS with no repeated streaming output regressions.

### Task 6: Minimal startup output

**Files:**

- Modify: `src/startup-banner.ts`
- Modify: `test/startup-banner.test.ts`

- [x] **Step 1: Replace artwork expectations with failing compact-banner tests**

Write tests for:

```ts
test("renders the minimal themed TTY startup", () => {
  const output = renderStartupBanner({
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    workspaceRoot: "/workspace/ziling-erp-admin",
    modelName: "DeepSeek V4 Flash",
  });
  assert.equal(stripAnsi(output), [
    "Coffee",
    "DeepSeek V4 Flash · ziling-erp-admin",
    "/ 查看命令 · Ctrl+C 退出",
  ].join("\n"));
  assert.doesNotMatch(output, /ICE AMERICANO|HOT LATTE|______/u);
});
```

Also assert an absent model renders `未选择模型` and non-TTY output contains the
full workspace path with no ANSI.

- [x] **Step 2: Run the banner tests and verify failure**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
```

Expected: FAIL against the old logo and coffee cups.

- [x] **Step 3: Implement the minimal banner**

Replace the logo constants and width branching with:

```ts
export interface StartupBannerOptions {
  readonly isTTY: boolean | undefined;
  readonly styles: TerminalStyleContext;
  readonly workspaceRoot: string;
  readonly modelName?: string;
}
```

Use `basename(workspaceRoot)` for TTY. Render `Coffee` with `primary`, model and
workspace with `accent`, and the hint with `muted`. For non-TTY, keep a plain
compact startup line plus `Workspace: <full path>`.

- [x] **Step 4: Run the banner tests**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
```

Expected: PASS.

### Task 7: Reusable single-line status, tools and planning

**Files:**

- Create: `src/line-status.ts`
- Create: `test/line-status.test.ts`
- Modify: `src/activity-indicator.ts`
- Modify: `test/activity-indicator.test.ts`
- Modify: `src/planning/render.ts`
- Modify: `test/planning-render.test.ts`

- [x] **Step 1: Write failing line-status lifecycle tests**

Create tests using injected timers and an in-memory output:

```ts
test("animates one physical line and clears it safely", () => {
  const renderer = createLineStatus({
    output,
    isTTY: true,
    styles: createStyleContext("latte", "truecolor"),
    startTimer: (callback) => {
      tick = callback;
      return timer;
    },
    stopTimer: () => undefined,
  });
  renderer.show("正在分析问题…");
  tick();
  renderer.clear();
  assert.match(writes.join(""), /◐ 正在分析问题…/u);
  assert.match(writes.join(""), /◓ 正在分析问题…/u);
  assert.doesNotMatch(writes.join(""), /\u001b\[[0-9]+A/u);
  assert.ok(writes.join("").includes("\u001b[?25h"));
});
```

Add tests for `setStyleContext()`, idempotent dispose, writer failure, and
non-TTY append-only output.

- [x] **Step 2: Run the new suite and verify missing module failure**

Run:

```bash
node --import tsx --test test/line-status.test.ts
```

Expected: FAIL because `line-status.ts` does not exist.

- [x] **Step 3: Implement the generic one-line status**

Expose:

```ts
export interface LineStatusRenderer {
  show(text: string): void;
  clear(): void;
  complete(text: string, role: "success" | "error"): void;
  setStyleContext(styles: TerminalStyleContext): void;
  dispose(): void;
}

export function createLineStatus(options: {
  output: { write(chunk: string): unknown };
  isTTY: boolean | undefined;
  styles: TerminalStyleContext;
  now?: () => number;
  startTimer?: TimerStart;
  stopTimer?: TimerStop;
}): LineStatusRenderer;
```

Use frames `["◐", "◓", "◑", "◒"]`, `\r\u001b[2K` for same-line redraw, and
hide/show cursor idempotently. Sanitize status text before output. Non-TTY writes
each distinct status once and never emits cursor controls.

- [x] **Step 4: Refactor tool activity onto the one-line component**

Remove `CoffeeAnimation`, drink names, cup-frame generators and
`getAnimationFrames()`. Keep the current per-tool action/completion wording and
elapsed-time calculation. `ActivityRenderer` becomes:

```ts
export interface ActivityRenderer {
  handle(event: ToolActivityEvent): void;
  pause(): void;
  setStyleContext(styles: TerminalStyleContext): void;
  dispose(): void;
}
```

On `start`, call `lineStatus.show(getActionText(name))`; on success/error, emit
one timed completion line through `lineStatus.complete()`.

- [x] **Step 5: Refactor plan rendering**

Remove `CoffeeAnimation` and `getAnimation` from planning types. Use the same
four spinner glyphs for the current step, `primary` for active progress,
`success` for completion, `error` for failure, and `muted` for secondary text.
Add `setStyleContext()` to `PlanProgressRenderer`. Change `renderPlan(plan,
styles)` to accept the style context.

The task plan state machine, revision checks, append-only non-TTY behavior and
HITL rules must remain unchanged.

- [x] **Step 6: Run focused status suites**

Run:

```bash
node --import tsx --test \
  test/line-status.test.ts \
  test/activity-indicator.test.ts \
  test/planning-render.test.ts
```

Expected: PASS; output contains no multi-line drink art.

### Task 8: CLI integration, runtime switching and `/like` removal

**Files:**

- Modify: `src/cli.ts:1-806`
- Modify: `src/commands.ts`
- Modify: `src/settings.ts`
- Modify: `test/cli.test.ts`
- Modify: `test/commands.test.ts`
- Modify: `test/settings.test.ts`
- Delete: `src/like-command.ts`
- Delete: `test/like-command.test.ts`

- [x] **Step 1: Add failing end-to-end CLI tests**

Extend the existing `SpawnPtyCliOptions` with `scriptedInput?: string`. In the
existing `MAIN_INPUT_BORDER` branch, write
`options.scriptedInput ?? "你好\r"` so a test can drive `/theme` and direction
keys through the real PTY selector.

Add scenarios that use the existing `withCliSandbox()` and `spawnPtyCli()` helpers:

```ts
test("switches theme with arrows and persists it without a model request", async () => {
  await withCliSandbox(async (sandbox) => {
    const result = await spawnPtyCli(
      sandbox,
      {},
      {
        streamScenario: "pty-preview",
        scriptedInput: "/theme\r\u001b[B\r/exit\r",
      },
    );
    assert.match(stripAnsi(result.stdout), /已切换为 周末海岸/u);
    assert.equal(
      JSON.parse(await readFile(sandbox.settingsPath, "utf8"))
        ["coffee-preferences"].theme,
      "coast",
    );
    assert.equal(existsSync(sandbox.requestsPath), false);
  });
});
```

Add cases for Esc preserving the old theme, save failure preserving the runtime
theme, invalid saved themes warning and fallback, `/theem` suggestion,
`/like` becoming unknown, and restart restoration.

Add a streaming fixture whose gateway delays its first event; assert a
`正在连接 <model>…` status appears before the delayed response, is cleared before
the first text delta, and produces no repeated answer text.

- [x] **Step 2: Run the CLI suite and verify failures**

Run:

```bash
node --import tsx --test test/cli.test.ts
```

Expected: FAIL because `/theme` is not routed and the CLI still uses `/like`.

- [x] **Step 3: Load the theme before styled startup warnings**

At the start of `main()`:

```ts
const loadedTheme = await loadThemePreference(settingsPath);
const colorMode = resolveColorMode({
  isTTY: output.isTTY,
  noColor: process.env.NO_COLOR,
  colorTerm: process.env.COLORTERM,
  term: process.env.TERM,
  termProgram: process.env.TERM_PROGRAM,
});
let styles = createStyleContext(loadedTheme.themeId, colorMode);
```

Include `loadedTheme.warning` in the existing deduplicated startup warning set.
Replace every `useColor` call with the explicit `styles` context.

- [x] **Step 4: Wire `/theme` with save-before-switch semantics**

Add a local command handler:

```ts
async function selectTheme(): Promise<void> {
  const model = getThemeSelectionModel(styles.theme.id, styles.colorMode);
  const selected = await inputController.select({
    message: "选择主题",
    items: model.items,
    initialIndex: model.initialIndex,
  });
  if (!selected || selected === styles.theme.id) return;

  await saveThemePreference(settingsPath, selected);
  styles = createStyleContext(selected, styles.colorMode);
  inputController.setStyleContext(styles);
  activityRenderer.setStyleContext(styles);
  planProgressRenderer.setStyleContext(styles);
  toolInteraction.setStyleContext(styles);
  responseStatus.setStyleContext(styles);
  console.log(styleText(
    `✓ 已切换为 ${styles.theme.label}`,
    "assistant",
    styles,
  ));
}
```

Only assign `styles` after `saveThemePreference()` resolves. Route `/theme`
inside the known-command branch and continue the main loop after completion.

- [x] **Step 5: Show an immediate response status**

Create one `LineStatusRenderer` beside the activity and plan renderers. Immediately
before entering `for await (const event of conversation.stream(...))`, call:

```ts
const activeModelName =
  sessionManager.getCurrent().model?.name ??
  loadedGlobalDefaultModel?.name ??
  "当前模型";
responseStatus.show(`正在连接 ${activeModelName}…`);
```

Update it for `status` and `fallback` events. Clear it before `text_delta`,
`tool_activity`, `plan_activity`, `done`, errors and every dispose path. Keep tool
and plan renderers mutually exclusive as they are now.

- [x] **Step 6: Remove animation preference and `/like`**

Delete all imports, state, handlers and route fallthrough related to:

```ts
CoffeeAnimation
loadCoffeePreferences
saveAnimationPreference
parseLikeCommand
getLikeSelectionItems
getAnimationNameForDisplay
LIKE_USAGE
```

Remove `/like` from `CommandDefinition` and `COMMANDS`. Delete
`src/like-command.ts` and `test/like-command.test.ts`. Remove obsolete settings
tests that assert animation validation, but keep tests proving a legacy
`animation` key is preserved during a theme save.

- [x] **Step 7: Pass actual startup model and styles**

Call:

```ts
renderStartupBanner({
  isTTY: output.isTTY,
  styles,
  workspaceRoot,
  modelName:
    sessionManager.getCurrent().model?.name ??
    loadedGlobalDefaultModel?.name,
})
```

The banner must render after the session manager exists so it can use the restored
or default model name.

- [x] **Step 8: Run CLI, command and settings tests**

Run:

```bash
node --import tsx --test \
  test/cli.test.ts \
  test/commands.test.ts \
  test/settings.test.ts
npx tsc --noEmit --pretty false
```

Expected: all tests PASS and TypeScript reports no stale `/like`, animation or
boolean-style imports.

### Task 9: Documentation and complete regression

**Files:**

- Modify: `README.md:70-100,150-170`
- Verify: all `src/**/*.ts` and `test/**/*.test.ts`

- [ ] **Step 1: Update user-facing documentation**

Replace the old logo and drink-animation sections with:

```md
Coffee 在交互终端中使用简洁的三行启动信息。输入 `/theme` 可以通过上下
方向键在“奶油拿铁”“周末海岸”和“暮色露营”之间切换；选择会保存到
`coffee.settings.json` 的 `coffee-preferences.theme`。

提交问题后，Coffee 会立即显示单行旋转状态，并在模型正文、工具输出或
任务计划开始前清理该行。非 TTY 和 `NO_COLOR` 环境自动使用纯文本输出。
```

Update the command list to include `/theme` and remove every `/like`,
`americano`, `latte` animation-command and multi-line cup claim. Preserve
unrelated API, model, history, tool and security documentation.

- [ ] **Step 2: Search for stale product references**

Run:

```bash
rg -n \
  "CoffeeAnimation|DEFAULT_ANIMATION|saveAnimationPreference|loadCoffeePreferences|getAnimationFrames|/like|ICE AMERICANO|HOT LATTE" \
  src test README.md
```

Expected: no matches. A fixture that intentionally checks an unknown `/like` may
remain only if its assertion explicitly proves the removed command is blocked.

- [ ] **Step 3: Run formatting-surface regression suites**

Run:

```bash
node --import tsx --test \
  test/theme.test.ts \
  test/theme-command.test.ts \
  test/chat-input.test.ts \
  test/terminal-format.test.ts \
  test/startup-banner.test.ts \
  test/line-status.test.ts \
  test/activity-indicator.test.ts \
  test/planning-render.test.ts \
  test/streaming-markdown-renderer.test.ts \
  test/tool-interaction.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 4: Run the full verification**

Run:

```bash
npm run check
npm test
```

Expected: TypeScript emits no errors and the complete Coffee test suite passes
without failures, hangs, unhandled `AbortError`, ANSI leakage in non-TTY output,
or repeated streaming text.

- [ ] **Step 5: Manual TTY acceptance**

Run:

```bash
npm start
```

Verify this sequence:

1. Startup uses three compact lines and no large logo.
2. An empty input row has the same height as a row containing text.
3. `/theme` opens at the saved theme; arrow movement and highlight work.
4. Each of the three themes changes the next prompt and response colors.
5. Restarting Coffee restores the last selected theme.
6. Submitting a normal question immediately shows a one-line spinner.
7. A tool call uses one line while active and one timed completion line.
8. Ctrl+C exits cleanly with the cursor restored.

Because this directory has no Git metadata, record the final test totals and manual
acceptance result in the execution handoff instead of committing.
