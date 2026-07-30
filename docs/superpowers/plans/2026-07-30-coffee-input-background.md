# Coffee Input Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove theme coloring from the two input borders and fill the complete middle input row with the selected theme background without changing prompt height or cursor behavior.

**Architecture:** Extend the existing `paintTheme()` primitive with an opt-in ANSI Erase in Line suffix that runs before style reset. Keep `renderChatPrompt()` responsible for the three-line frame: raw borders plus one themed input row. Preserve the existing zero-width empty-input anchor and plain-output fallback.

**Tech Stack:** TypeScript, Node.js ANSI terminal output, `@inquirer/core`, Node test runner

---

### Task 1: Add background fill-to-end support

**Files:**
- Modify: `src/theme.ts:31-35,124-166`
- Test: `test/theme.test.ts:24-38`

- [ ] **Step 1: Write the failing theme-rendering test**

Add this test after the existing exact RGB test:

```ts
test("fills the current background to the end of the line before reset", () => {
  const styles = createStyleContext("latte", "truecolor");

  assert.equal(
    paintTheme("Coffee", "primary", styles, {
      backgroundRole: "inputBackground",
      fillToEnd: true,
    }),
    "\u001b[38;2;211;166;111;48;2;75;62;50mCoffee\u001b[K\u001b[0m",
  );
  assert.equal(
    paintTheme(
      "Coffee",
      "primary",
      createStyleContext("latte", "none"),
      { backgroundRole: "inputBackground", fillToEnd: true },
    ),
    "Coffee",
  );
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --import tsx --test test/theme.test.ts
```

Expected: FAIL because `paintTheme()` does not append `\u001b[K` before the
reset sequence.

- [ ] **Step 3: Implement the minimal rendering option**

Extend `PaintOptions` and add the erase sequence:

```ts
interface PaintOptions {
  bold?: boolean;
  underline?: boolean;
  backgroundRole?: ThemeRole;
  fillToEnd?: boolean;
}

const ERASE_TO_END = `${ESCAPE}K`;
```

Change the colored return value in `paintTheme()` to:

```ts
return `${ESCAPE}${codes.join(";")}m${text}${
  options.fillToEnd ? ERASE_TO_END : ""
}${RESET}`;
```

Keep the existing early return unchanged so `ColorMode === "none"` never emits
ANSI background or erase sequences.

- [ ] **Step 4: Run the theme test and verify GREEN**

Run:

```bash
node --import tsx --test test/theme.test.ts
```

Expected: all theme tests PASS.

- [ ] **Step 5: Commit the theme primitive**

```bash
git add src/theme.ts test/theme.test.ts
git commit -m "feat: support terminal background line fill"
```

### Task 2: Restyle the main input frame

**Files:**
- Modify: `src/chat-input.ts:305-335`
- Test: `test/chat-input.test.ts:143-213`

- [ ] **Step 1: Write the failing input-frame test**

Add this test before the existing empty-input-height test:

```ts
test("keeps borders plain and fills the input row for every theme", () => {
  const expectedStyles = [
    ["latte", "38;2;211;166;111;48;2;75;62;50"],
    ["coast", "38;2;128;193;183;48;2;54;77;79"],
    ["camp", "38;2;201;145;167;48;2;77;61;69"],
  ] as const;

  for (const [themeId, ansiCodes] of expectedStyles) {
    const [main, bottom] = renderChatPrompt({
      message: "",
      line: "hello",
      dropdown: "",
      styles: createStyleContext(themeId, "truecolor"),
      columns: 40,
    });
    const [top, inputLine] = main.split("\n");

    assert.equal(top, "─".repeat(40));
    assert.equal(bottom, "─".repeat(40));
    assert.equal(
      inputLine,
      `\u001b[${ansiCodes}mhello\u001b[K\u001b[0m`,
    );
    assert.doesNotMatch(`${top}${bottom}`, /\u001b/u);
  }
});
```

Extend the existing empty-input test with:

```ts
assert.match(promptLine, /\u200b\u001b\[K\u001b\[0m$/u);
```

The existing plain Pi-style frame test remains the `ColorMode === "none"`
regression guard.

- [ ] **Step 2: Run the input test and verify RED**

Run:

```bash
node --import tsx --test test/chat-input.test.ts
```

Expected: FAIL because both borders are themed and the input row does not contain
Erase in Line.

- [ ] **Step 3: Implement the main input rendering**

Replace the themed border rendering in `renderChatPrompt()` with raw borders and
enable line fill only on the input row:

```ts
const border = "─".repeat(width);
const inputLine = config.line === "" ? EMPTY_INPUT_ANCHOR : config.line;
const styledInputLine = paintTheme(inputLine, "primary", config.styles, {
  backgroundRole: "inputBackground",
  fillToEnd: true,
});
return [
  `${border}\n${styledInputLine}`,
  [border, dropdown].filter(Boolean).join("\n"),
];
```

Do not change explicit text prompts, dropdown rendering, selection rendering or
input submission behavior.

- [ ] **Step 4: Run the input and theme tests and verify GREEN**

Run:

```bash
node --import tsx --test test/theme.test.ts test/chat-input.test.ts
```

Expected: all tests PASS, including empty input, narrow width, full width,
selection, Esc and Ctrl+C input-controller cases.

- [ ] **Step 5: Commit the input-frame change**

```bash
git add src/chat-input.ts test/chat-input.test.ts
git commit -m "feat: restyle Coffee input background"
```

### Task 3: Complete regression and real-terminal acceptance

**Files:**
- Verify: `src/theme.ts`
- Verify: `src/chat-input.ts`
- Verify: `test/theme.test.ts`
- Verify: `test/chat-input.test.ts`

- [ ] **Step 1: Run focused terminal regression**

Run:

```bash
node --import tsx --test \
  test/theme.test.ts \
  test/chat-input.test.ts \
  test/startup-banner.test.ts \
  test/terminal-format.test.ts
```

Expected: all focused tests PASS with no changed selection, startup or Markdown
formatting behavior.

- [ ] **Step 2: Run TypeScript and full regression**

Run:

```bash
npm run check
npm test
```

Expected: TypeScript reports no errors and the complete test suite passes with
zero failures, cancellations or skipped tests.

- [ ] **Step 3: Inspect the exact change set**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Pre-existing README and 2026-07-28 plan changes
may remain uncommitted; they must not be included in the feature commits.

- [ ] **Step 4: Perform isolated TTY acceptance**

Start Coffee in an isolated temporary HOME with the existing fake streaming
response preload:

```bash
COFFEE_TTY_HOME="$(mktemp -d /tmp/coffee-input-bg.XXXXXX)"
env \
  HOME="$COFFEE_TTY_HOME" \
  USERPROFILE="$COFFEE_TTY_HOME" \
  COFFEE_SETTINGS_PATH="$COFFEE_TTY_HOME/coffee.settings.json" \
  COFFEE_HISTORY_PATH="$COFFEE_TTY_HOME/history.sqlite" \
  DEEPSEEK_API_KEY=test-key \
  TAVILY_API_KEY=tvly-test \
  COFFEE_STREAM_TEST_SCENARIO=delayed-first-text \
  NODE_OPTIONS='--import ./test/streaming-fetch.mjs' \
  TERM=xterm-256color \
  COLORTERM=truecolor \
  npm start
```

Verify:

1. Both `─` borders use the terminal default color.
2. The middle row background reaches the right edge.
3. Empty and non-empty input both occupy one row.
4. `/theme` changes the next input-row background.
5. Ctrl+C exits with the cursor restored.

Remove only the temporary directory created by this command after Coffee exits.
