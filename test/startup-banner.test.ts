import assert from "node:assert/strict";
import test from "node:test";

import { renderStartupBanner } from "../src/startup-banner.js";
import { createStyleContext } from "../src/theme.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

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
  assert.match(output, /\u001b\[38;2;211;166;111mCoffee/u);
  assert.match(
    output,
    /\u001b\[38;2;238;225;207mDeepSeek V4 Flash · ziling-erp-admin/u,
  );
  assert.match(output, /\u001b\[38;2;167;147;121m\/ 查看命令/u);
  assert.doesNotMatch(output, /ICE AMERICANO|HOT LATTE|______/u);
});

test("shows a clear fallback when no model is selected", () => {
  const output = renderStartupBanner({
    isTTY: true,
    styles: createStyleContext("coast", "none"),
    workspaceRoot: "/workspace/coffee",
  });

  assert.equal(output, [
    "Coffee",
    "未选择模型 · coffee",
    "/ 查看命令 · Ctrl+C 退出",
  ].join("\n"));
});

test("keeps non-TTY startup plain with the full workspace path", () => {
  const output = renderStartupBanner({
    isTTY: false,
    styles: createStyleContext("camp", "truecolor"),
    workspaceRoot: "/Users/test/shop-api",
    modelName: "DeepSeek V4 Flash",
  });

  assert.equal(
    output,
    "Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。\n" +
      "Workspace: /Users/test/shop-api",
  );
  assert.doesNotMatch(output, /\u001b\[/u);
});
