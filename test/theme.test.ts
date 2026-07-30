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
