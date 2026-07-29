import type { ActivityRenderer } from "./activity-indicator.js";
import type { InputController } from "./chat-input.js";
import type { ToolInteraction } from "./code-tools/types.js";
import type { ShellInteraction } from "./shell/types.js";
import {
  sanitizeTerminalLabel,
  sanitizeTerminalText,
  styleDiffLine,
  wrapTerminalLine,
} from "./terminal-format.js";
import type { TerminalStyleContext } from "./theme.js";

interface InteractionOutput {
  write(chunk: string): unknown;
  columns?: number;
}

export interface CoffeeToolInteraction
  extends ToolInteraction, ShellInteraction {
  setStyleContext(styles: TerminalStyleContext): void;
}

export function createToolInteraction({
  input,
  activity,
  output,
  styles,
}: {
  input: InputController;
  activity: ActivityRenderer;
  output: InteractionOutput;
  styles: TerminalStyleContext;
}): CoffeeToolInteraction {
  let currentStyles = styles;

  async function askConfirmation(
    message: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    signal?.throwIfAborted();
    const answer = await input.ask(message + " [y/N] ", false);
    signal?.throwIfAborted();
    return answer?.trim().toLowerCase() === "y";
  }

  return {
    async authorizeProtected(request, signal) {
      if (!input.isInteractive) return false;
      signal?.throwIfAborted();
      activity.pause();
      const operation = request.operation === "read" ? "读取" : "修改";
      return await askConfirmation(
        "Coffee 想" + operation + "受保护路径：" +
          sanitizeTerminalLabel(request.path) + "\n原因：" +
          sanitizeTerminalLabel(request.reason) + "\n仅允许本次操作？",
        signal,
      );
    },

    async confirmMutation(preview, signal) {
      if (!input.isInteractive) return false;
      signal?.throwIfAborted();
      activity.pause();
      output.write(
        "\nCoffee 准备修改 " + sanitizeTerminalLabel(preview.path) + "\n\n",
      );
      const safePatch = sanitizeTerminalText(preview.patch);
      output.write(
        safePatch
          .split("\n")
          .flatMap((line) => wrapTerminalLine(line, output.columns))
          .map((line) => styleDiffLine(line, currentStyles))
          .join("\n") + "\n",
      );
      return await askConfirmation("确认修改？", signal);
    },

    async requestSecret(request, signal) {
      if (!input.isInteractive) return undefined;
      signal?.throwIfAborted();
      activity.pause();
      const value = await input.askSecret(
        "请输入 " + sanitizeTerminalLabel(request.key) + "（" +
          sanitizeTerminalLabel(request.path) + "）: ",
      );
      signal?.throwIfAborted();
      return value;
    },

    async confirmShell(request, signal) {
      if (!input.isInteractive) return false;
      signal?.throwIfAborted();
      activity.pause();
      return await askConfirmation(
        "Coffee 准备执行命令\n\n$ " +
          sanitizeTerminalLabel(request.command) +
          "\n\n原因：" +
          sanitizeTerminalLabel(request.reason) +
          "\n仅允许本次执行？",
        signal,
      );
    },

    beginShell(request) {
      activity.pause();
      if (request.displayCommand) {
        output.write(
          "\n$ " + sanitizeTerminalLabel(request.command) + "\n\n",
        );
      }
    },

    writeShellOutput(chunk) {
      output.write(sanitizeTerminalText(chunk));
    },

    setStyleContext(nextStyles) {
      currentStyles = nextStyles;
    },
  };
}
