# Coffee CLI Startup Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the successful-startup line with a wide, colored, hollow italic `COFFEE` banner and horizontally aligned americano/latte art, while retaining a compact fallback.

**Architecture:** A new pure `startup-banner` module owns artwork, width selection, and ANSI color composition. The CLI passes terminal capabilities to that module and prints its returned string only after Agent configuration succeeds. Narrow and non-TTY output remains the existing compact startup sentence.

**Tech Stack:** TypeScript, Node.js terminal streams, ANSI escape sequences, Node test runner.

---

This directory is not a Git repository, so commit steps are intentionally omitted.

### Task 1: Startup banner renderer

**Files:**
- Create: `src/startup-banner.ts`
- Create: `test/startup-banner.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Create `test/startup-banner.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  FULL_BANNER_WIDTH,
  renderStartupBanner,
} from "../src/startup-banner.js";

test("renders the hollow italic logo and aligned coffee art in a wide TTY", () => {
  const output = renderStartupBanner({
    isTTY: true,
    columns: FULL_BANNER_WIDTH,
    useColor: false,
  });
  const lines = output.split("\n");

  assert.match(output, /______.*______.*__________/);
  assert.match(output, /YOUR THOUGHTFUL AI BARISTA/);
  assert.ok(lines.some((line) =>
    line.includes("╰──────╯") && line.includes("╰──────╯╯"),
  ));
  assert.ok(lines.some((line) =>
    line.includes("ICE AMERICANO") && line.includes("HOT LATTE"),
  ));
  assert.match(output, /Coffee Agent is ready/);
  assert.match(output, /Ctrl\+C 退出/);
});

test("adds distinct colors only when color is enabled", () => {
  const colored = renderStartupBanner({
    isTTY: true,
    columns: FULL_BANNER_WIDTH,
    useColor: true,
  });
  const plain = renderStartupBanner({
    isTTY: true,
    columns: FULL_BANNER_WIDTH,
    useColor: false,
  });

  assert.match(colored, /\u001b\[96m/);
  assert.match(colored, /\u001b\[94m/);
  assert.match(colored, /\u001b\[93m/);
  assert.doesNotMatch(plain, /\u001b\[/);
});

test("uses the compact startup line outside a wide TTY", () => {
  for (const options of [
    { isTTY: false, columns: FULL_BANNER_WIDTH, useColor: false },
    { isTTY: true, columns: FULL_BANNER_WIDTH - 1, useColor: false },
    { isTTY: true, columns: undefined, useColor: false },
  ]) {
    assert.equal(
      renderStartupBanner(options),
      "Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。",
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify the red state**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/startup-banner.js`.

- [ ] **Step 3: Implement the minimal banner module**

Create `src/startup-banner.ts` with these public definitions:

```ts
export interface StartupBannerOptions {
  isTTY: boolean | undefined;
  columns: number | undefined;
  useColor: boolean;
}

export const COMPACT_STARTUP =
  "Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。";

const LOGO = String.raw`      ________      ________      __________    __________    __________    __________
    /  ______/    /  ____  /    /  _______/   /  _______/   /  _______/   /  _______/
   /  /          /  /   / /    /  /          /  /          /  /          /  /
  /  /          /  /   / /    /  /_____     /  /_____     /  /_____     /  /_____
 /  /          /  /   / /    /  ______/    /  ______/    /  ______/    /  ______/
/  /______    /  /___/ /    /  /          /  /          /  /_____     /  /_____
\________/   /________/    /__/           /__/          /________/    /________/`;

const COFFEE_ROWS = [
  ["         ╲", "                                     ", "(  )"],
  ["          ╲", "                                     ", ")("],
  ["      ╭───╲──╮", "                              ", "╭──────╮"],
  ["      │ ◇  ◆ │", "                              ", "│  ♡   │╮"],
  ["      │██████│", "                              ", "│      ││"],
  ["      ╰──────╯", "                              ", "╰──────╯╯"],
  ["     ICE AMERICANO", "                          ", "HOT LATTE"],
] as const;

const SUBTITLE = "                         YOUR THOUGHTFUL AI BARISTA";
const FOOTER =
  "  Coffee Agent is ready                  / 查看命令 · Ctrl+C 退出";

const ANSI = {
  reset: "\u001b[0m",
  cyan: "\u001b[96m",
  gray: "\u001b[90m",
  blue: "\u001b[94m",
  yellow: "\u001b[93m",
  magenta: "\u001b[95m",
} as const;

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${ANSI.reset}` : text;
}

const PLAIN_FULL_BANNER = [
  LOGO,
  "",
  SUBTITLE,
  "",
  ...COFFEE_ROWS.map(([left, gap, right]) => `${left}${gap}${right}`),
  "",
  FOOTER,
].join("\n");

export const FULL_BANNER_WIDTH = Math.max(
  ...PLAIN_FULL_BANNER.split("\n").map((line) => line.length),
);

export function renderStartupBanner({
  isTTY,
  columns,
  useColor,
}: StartupBannerOptions): string {
  if (
    isTTY !== true ||
    columns === undefined ||
    !Number.isFinite(columns) ||
    columns < FULL_BANNER_WIDTH
  ) {
    return COMPACT_STARTUP;
  }

  return [
    paint(LOGO, ANSI.cyan, useColor),
    "",
    paint(SUBTITLE, ANSI.gray, useColor),
    "",
    ...COFFEE_ROWS.map(
      ([left, gap, right]) =>
        `${paint(left, ANSI.blue, useColor)}${gap}${paint(right, ANSI.yellow, useColor)}`,
    ),
    "",
    `${paint("  Coffee Agent is ready", ANSI.magenta, useColor)}` +
      `${"                  "}${paint("/ 查看命令 · Ctrl+C 退出", ANSI.gray, useColor)}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
npm run check
```

Expected: all startup banner tests pass and TypeScript exits 0.

### Task 2: CLI integration

**Files:**
- Modify: `src/cli.ts:1-20,113-116`
- Modify: `test/cli.test.ts:108-116`

- [ ] **Step 1: Strengthen the existing CLI startup assertion**

Change the startup assertion in `test/cli.test.ts`:

```ts
assert.match(
  result.stdout,
  /Coffee CLI 已启动，输入 \/exit 或按 Ctrl\+C 退出。/,
);
```

The spawned child uses piped stdout, so this test intentionally verifies the non-TTY compact fallback.

- [ ] **Step 2: Run the focused CLI test before integration**

Run:

```bash
node --import tsx --test test/cli.test.ts \
  --test-name-pattern="starts the CLI"
```

Expected: PASS against the existing compact line; this protects the fallback while integration changes.

- [ ] **Step 3: Route startup output through the renderer**

Add this import to `src/cli.ts`:

```ts
import { renderStartupBanner } from "./startup-banner.js";
```

Replace the existing startup `console.log` with:

```ts
console.log(
  `${renderStartupBanner({
    isTTY: output.isTTY,
    columns: output.columns,
    useColor,
  })}\n`,
);
```

Do not move this block: it must remain after `createConversation` succeeds and before the first prompt.

- [ ] **Step 4: Run CLI tests and type checking**

Run:

```bash
node --import tsx --test test/cli.test.ts
npm run check
```

Expected: all CLI tests pass and TypeScript exits 0.

- [ ] **Step 5: Verify the full banner in a real TTY**

Run:

```bash
DEEPSEEK_API_KEY=test-key TAVILY_API_KEY=tvly-test \
node --import tsx --import ./test/no-fetch.mjs src/cli.ts
```

In a terminal at least `FULL_BANNER_WIDTH` columns wide, verify the hollow italic Logo is not wrapped, the cups and labels are horizontally aligned, `/exit` exits without a network request, and Ctrl+C exits cleanly.

### Task 3: Documentation and full verification

**Files:**
- Modify: `README.md:26-41`

- [ ] **Step 1: Document the startup banner behavior**

After the `npm start` block in `README.md`, add:

```md
在足够宽的真实终端中，Coffee 会显示空心斜体 `COFFEE` Logo，以及水平排列的冰美式和热拿铁。窄终端或管道输出会自动使用紧凑启动文案；设置 `NO_COLOR=1` 只关闭颜色，不移除字符画。
```

Keep the existing command dropdown and Markdown-color documentation unchanged.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
npm test
npm run check
npm ls --depth=0
```

Expected: zero failed tests, TypeScript exits 0, and the dependency list remains unchanged with `@inquirer/core` as the only runtime dependency.

- [ ] **Step 3: Check the requested scope line by line**

Confirm from fresh output that:

- The successful wide-TTY startup uses the approved hollow italic `COFFEE`.
- Americano and latte tops, bodies, bottoms, and labels are horizontally aligned.
- Narrow/non-TTY startup remains compact.
- `NO_COLOR` removes ANSI only.
- Missing API keys still show the existing error without a success banner.
- No Agent, model, tool, command, settings, or animation behavior changed.
