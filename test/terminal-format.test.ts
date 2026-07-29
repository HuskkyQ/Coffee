import assert from "node:assert/strict";
import test from "node:test";

import {
  renderMarkdown,
  sanitizeTerminalLabel,
  sanitizeTerminalText,
  styleDiffLine,
  styleText,
  wrapTerminalLine,
} from "../src/terminal-format.js";
import { createStyleContext } from "../src/theme.js";

const plainStyles = createStyleContext("latte", "none");

const markdown = [
  "# 咖啡店推荐",
  "* **晨光咖啡**",
  "适合 `手冲`",
  "[查看地图](https://example.com/map)",
].join("\n");

test("renders common Markdown as clean terminal text", () => {
  assert.equal(
    renderMarkdown(markdown, plainStyles),
    [
      "咖啡店推荐",
      "• 晨光咖啡",
      "适合 手冲",
      "查看地图 (https://example.com/map)",
    ].join("\n"),
  );
});

test("renders markdown with the selected theme", () => {
  const styles = createStyleContext("coast", "truecolor");
  const output = renderMarkdown("# 标题\n- **重点**和`代码`", styles);

  assert.match(output, /\u001b\[1;38;2;224;235;231m标题/u);
  assert.match(output, /\u001b\[1;38;2;212;178;120m重点/u);
  assert.match(output, /\u001b\[38;2;128;193;183m代码/u);
  assert.match(output, /\u001b\[38;2;128;193;183m•/u);
  assert.doesNotMatch(output, /\*\*/u);
});

test("styles labels while preserving plain-text mode", () => {
  assert.equal(styleText("Coffee> ", "assistant", plainStyles), "Coffee> ");
  assert.match(
    styleText(
      "Coffee> ",
      "assistant",
      createStyleContext("camp", "truecolor"),
    ),
    /\u001b\[1;38;2;168;189;136m/u,
  );
  assert.match(
    styleText("Error", "error", createStyleContext("coast", "truecolor")),
    /\u001b\[1;38;2;220;129;121m/u,
  );
});

test("keeps diff addition and deletion semantics across themes", () => {
  const styles = createStyleContext("camp", "truecolor");
  assert.match(styleDiffLine("+added", styles), /\u001b\[38;2;168;189;136m/u);
  assert.match(styleDiffLine("-removed", styles), /\u001b\[38;2;212;126;117m/u);
  assert.match(
    styleDiffLine("@@ hunk @@", styles),
    /\u001b\[1;38;2;201;145;167m/u,
  );
  assert.doesNotMatch(styleDiffLine("+added", plainStyles), /\u001b/u);
});

test("wraps and sanitizes raw terminal text independently of styling", () => {
  assert.deepEqual(wrapTerminalLine("abcdefgh", 4), ["abcd", "efgh"]);
  assert.equal(sanitizeTerminalText("safe\u001b[31m"), "safe[31m");
  assert.equal(
    sanitizeTerminalText("a\u0085b\u009bc\u009cd\u009de"),
    "abcde",
  );
  assert.equal(sanitizeTerminalLabel("a\nb"), "a\\nb");
});
