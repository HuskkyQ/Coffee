import { basename } from "node:path";

import {
  paintTheme,
  type TerminalStyleContext,
} from "./theme.js";

export interface StartupBannerOptions {
  readonly isTTY: boolean | undefined;
  readonly styles: TerminalStyleContext;
  readonly workspaceRoot: string;
  readonly modelName?: string;
}

export const COMPACT_STARTUP =
  "Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。";

export function renderStartupBanner({
  isTTY,
  styles,
  workspaceRoot,
  modelName,
}: StartupBannerOptions): string {
  if (isTTY !== true) {
    return `${COMPACT_STARTUP}\nWorkspace: ${workspaceRoot}`;
  }

  return [
    paintTheme("Coffee", "primary", styles),
    paintTheme(
      `${modelName ?? "未选择模型"} · ${basename(workspaceRoot)}`,
      "accent",
      styles,
    ),
    paintTheme("/ 查看命令 · Ctrl+C 退出", "muted", styles),
  ].join("\n");
}
