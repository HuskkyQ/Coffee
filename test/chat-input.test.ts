import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import stringWidth from "string-width";

import {
  applySecretKeypress,
  applyDropdownKey,
  createInputController,
  getDropdownView,
  getInitialSelectionIndex,
  getSelectionWindow,
  moveSelection,
  renderChatPrompt,
  renderCommandDropdown,
  renderSelectionView,
  renderSecretValue,
  syncReadlineLine,
} from "../src/chat-input.js";
import { getThemeSelectionModel } from "../src/theme-command.js";
import { createStyleContext } from "../src/theme.js";

const plainStyles = createStyleContext("latte", "none");

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

test("shows all commands for slash and filters as the user types", () => {
  assert.deepEqual(
    getDropdownView("/", 0, false).items.map((item) => item.name),
    [
      "/login",
      "/logout",
      "/model",
      "/theme",
      "/new",
      "/sessions",
      "/delete",
      "/plan",
      "/exit",
    ],
  );
  assert.deepEqual(
    getDropdownView("/th", 0, false).items.map((item) => item.name),
    ["/theme"],
  );
  assert.deepEqual(getDropdownView("你好", 0, false).items, []);
  assert.deepEqual(getDropdownView("/", 0, true).items, []);
});

test("moves the active command with arrow keys", () => {
  assert.equal(
    applyDropdownKey(
      { line: "/", active: 0, dismissed: false },
      "down",
    ).active,
    1,
  );
  assert.equal(
    applyDropdownKey(
      { line: "/", active: 0, dismissed: false },
      "up",
    ).active,
    8,
  );
});

test("fills an argument command on tab without submitting it", () => {
  assert.deepEqual(
    applyDropdownKey(
      { line: "/pla", active: 0, dismissed: false },
      "tab",
    ),
    {
      line: "/plan ",
      active: 0,
      dismissed: false,
      action: "fill",
    },
  );
});

test("synchronizes the readline buffer after tab completion", () => {
  const readline = { line: "/", cursor: 1 };

  syncReadlineLine(readline, "/plan ");

  assert.deepEqual(readline, { line: "/plan ", cursor: 6 });
});

test("submits the highlighted command on enter", () => {
  assert.equal(
    applyDropdownKey(
      { line: "/e", active: 0, dismissed: false },
      "enter",
    ).submit,
    "/exit",
  );
});

test("dismisses suggestions on escape", () => {
  assert.equal(
    applyDropdownKey(
      { line: "/", active: 0, dismissed: false },
      "escape",
    ).dismissed,
    true,
  );
});

test("renders the active command and descriptions", () => {
  const output = renderCommandDropdown(
    getDropdownView("/", 8, false),
  );

  assert.match(output, /  \/theme\s+切换终端主题/);
  assert.match(output, /  \/sessions\s+查看和切换会话/);
  assert.match(output, /  \/plan\s+查看或取消当前任务计划/);
  assert.doesNotMatch(output, /\/like/u);
  assert.match(output, /› \/exit\s+退出 Coffee/);
});

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

  assert.match(output, /\u001b\[38;2;201;145;167;48;2;66;50;58m/u);
  assert.match(stripAnsi(output), /暮色露营\s+● ● ●\s+当前/u);
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

test("renders an unlabeled Pi-style frame for the main chat input", () => {
  const [main, bottom] = renderChatPrompt({
    message: "",
    line: "hello",
    dropdown: "",
    styles: plainStyles,
    columns: 40,
  });

  assert.match(main, /^─{40}\nhello$/u);
  assert.equal(bottom, "─".repeat(40));
  assert.doesNotMatch(`${main}\n${bottom}`, /You>/u);
});

test("keeps explicit text prompts unframed", () => {
  assert.deepEqual(
    renderChatPrompt({
      message: "确认？ ",
      line: "y",
      dropdown: "",
      styles: plainStyles,
      columns: 40,
    }),
    ["确认？ y", undefined],
  );
});

test("fits the main input border to a narrow terminal", () => {
  const [main, bottom] = renderChatPrompt({
    message: "",
    line: "",
    dropdown: "",
    styles: plainStyles,
    columns: 10,
  });

  assert.equal(main, `${"─".repeat(10)}\n\u200b`);
  assert.equal(bottom, "─".repeat(10));
});

test("spans the main input border across the full terminal width", () => {
  const [main, bottom] = renderChatPrompt({
    message: "",
    line: "hello",
    dropdown: "",
    styles: plainStyles,
    columns: 120,
  });

  assert.match(main, /^─{120}\nhello$/u);
  assert.equal(bottom, "─".repeat(120));
});

test("selects the first enabled item and skips disabled items", () => {
  const items = [
    { label: "A", value: "a" },
    { label: "B", value: "b", disabled: true },
    { label: "C", value: "c" },
  ] as const;

  assert.equal(getInitialSelectionIndex(items), 0);
  assert.equal(moveSelection(items, 0, "down"), 2);
  assert.equal(moveSelection(items, 2, "down"), 0);
  assert.equal(moveSelection(items, 0, "up"), 2);
});

test("returns no initial selection when every item is disabled", () => {
  assert.equal(
    getInitialSelectionIndex([
      { label: "A", value: "a", disabled: true },
      { label: "B", value: "b", disabled: true },
    ]),
    undefined,
  );
});

test("keeps the active selection inside the visible window", () => {
  assert.deepEqual(getSelectionWindow(9, 7, 4), {
    start: 5,
    end: 9,
  });
  assert.deepEqual(getSelectionWindow(3, 1, 8), {
    start: 0,
    end: 3,
  });
});

test("renders a text selection marker, status, description, and controls", () => {
  const output = renderSelectionView({
    message: "选择模型",
    items: [
      {
        label: "Doubao Seed",
        value: "doubao",
        status: "当前",
        description: "方舟 Agent Plan",
      },
      { label: "Kimi", value: "kimi" },
    ],
    active: 0,
    pageSize: 8,
    styles: plainStyles,
    columns: 80,
  });

  assert.match(output, /^选择模型/mu);
  assert.match(output, /> Doubao Seed\s+当前/mu);
  assert.match(output, /方舟 Agent Plan/mu);
  assert.match(output, /↑↓ 移动 · Enter 确认 · Esc 取消/mu);
});

test("truncates CJK selection rows by terminal display width", () => {
  const output = renderSelectionView({
    message: "选择模型",
    items: [
      {
        label: "这是一个非常非常长的中文模型名称",
        value: "long",
      },
    ],
    active: 0,
    pageSize: 8,
    styles: plainStyles,
    columns: 20,
  });
  const selectedRow = output.split("\n")[2] ?? "";

  assert.ok(stringWidth(selectedRow) <= 20);
  assert.match(selectedRow, /…$/u);
});

test("fits selection rows to a narrow terminal", () => {
  const output = renderSelectionView({
    message: "选择",
    items: [{ label: "Long model name", value: "long" }],
    active: 0,
    pageSize: 8,
    styles: plainStyles,
    columns: 10,
  });

  assert.ok(stringWidth(output.split("\n")[2] ?? "") <= 10);
});

test("does not truncate inside an ANSI theme preview", () => {
  const themeItem = getThemeSelectionModel("latte", "truecolor").items[0]!;
  const output = renderSelectionView({
    message: "选择主题",
    items: [themeItem],
    active: 0,
    pageSize: 8,
    styles: createStyleContext("latte", "truecolor"),
    columns: 14,
  });
  const selectedRow = output.split("\n")[2] ?? "";

  assert.doesNotMatch(selectedRow, /\u001b…/u);
  assert.ok(stringWidth(selectedRow) <= 14);
});

test("uses a highlighted arrow row when color is enabled", () => {
  const output = renderSelectionView({
    message: "选择",
    items: [{ label: "DeepSeek", value: "deepseek" }],
    active: 0,
    pageSize: 8,
    styles: createStyleContext("latte", "ansi"),
    columns: 80,
  });

  assert.match(output, /\u001b\[93;100m→ DeepSeek\u001b\[0m/u);
});

test("renders one secret mask per Unicode code point", () => {
  assert.equal(renderSecretValue("abc123"), "••••••");
  assert.equal(renderSecretValue("密钥🔑"), "•••");
  assert.equal(renderSecretValue(""), "");
  assert.equal(renderSecretValue("密钥🔑").includes("密"), false);
  assert.equal(renderSecretValue("密钥🔑").includes("🔑"), false);
});

test("submits secret prompt state even if readline was cleared on enter", () => {
  assert.deepEqual(applySecretKeypress("sk-secret", "", true), {
    line: "sk-secret",
    submit: "sk-secret",
  });
  assert.deepEqual(applySecretKeypress("sk", "sk-1", false), {
    line: "sk-1",
  });
});

test("queues consecutive non-TTY lines between prompts", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  input.end("/plan cancel\n/exit\n");

  assert.equal(await controller.ask("You> "), "/plan cancel");
  assert.equal(await controller.ask("You> "), "/exit");
  controller.close();
});

test("consumes ordinary and secret non-TTY lines in input order without echoing the secret", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  input.end("hello\nsk-test-secret\nbye\n");

  assert.equal(await controller.ask("Chat> "), "hello");
  assert.equal(await controller.askSecret("Key> "), "sk-test-secret");
  assert.equal(await controller.ask("Chat> "), "bye");
  assert.equal(Buffer.concat(chunks).toString(), "Chat> Key> Chat> ");
  assert.equal(Buffer.concat(chunks).toString().includes("sk-test-secret"), false);
  controller.close();
});

test("selects a real value from a numbered non-TTY fallback", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  input.end("2\n");

  assert.equal(
    await controller.select({
      message: "选择模型",
      items: [
        { label: "A", value: "a" },
        { label: "B", value: "b", description: "第二个选项" },
      ],
    }),
    "b",
  );
  assert.match(
    Buffer.concat(chunks).toString(),
    /选择模型\n\n  1\. A\n  2\. B\n     第二个选项\n\n输入序号，或按 Esc 取消：/u,
  );
  assert.match(Buffer.concat(chunks).toString(), /第二个选项/u);
  controller.close();
});

test("selects a real value with TTY arrow keys and enter", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  const selected = controller.select({
    message: "选择模型",
    items: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("\u001b[B\r");

  assert.equal(await selected, "b");
  controller.close();
});

test("honors an explicit initial selection in a TTY menu", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  const selected = controller.select({
    message: "选择主题",
    items: [
      { label: "A", value: "a" },
      { label: "B", value: "b" },
    ],
    initialIndex: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("\r");

  assert.equal(await selected, "b");
  controller.close();
});

test("updates the style context without recreating the input controller", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 40;
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: createStyleContext("latte", "truecolor"),
  });

  controller.setStyleContext(createStyleContext("camp", "truecolor"));
  const selected = controller.select({
    message: "选择",
    items: [{ label: "A", value: "a" }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("\r");
  assert.equal(await selected, "a");

  const rendered = Buffer.concat(chunks).toString();
  assert.match(rendered, /\u001b\[38;2;201;145;167;48;2;66;50;58m/u);
  assert.doesNotMatch(
    rendered,
    /\u001b\[38;2;211;166;111;48;2;64;51;40m/u,
  );
  controller.close();
});

test("cancels a TTY selection with escape", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
  };
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  const selected = controller.select({
    message: "选择模型",
    items: [{ label: "A", value: "a" }],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.write("\u001b");

  assert.equal(await selected, undefined);
  controller.close();
});

test("drains queued non-TTY lines after EOF without writing an extra prompt", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  const ended = once(input, "end");
  input.end("hello\nsk-after-eof\nbye\n");
  await ended;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(await controller.ask("Chat> "), "hello");
  assert.equal(await controller.askSecret("Key> "), "sk-after-eof");
  assert.equal(await controller.ask("Chat> "), "bye");
  assert.equal(await controller.ask("Unused> "), undefined);
  assert.equal(Buffer.concat(chunks).toString(), "Chat> Key> Chat> ");
  controller.close();
});

test("returns undefined when a pending secret prompt is aborted", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const abortController = new AbortController();
  const controller = createInputController({
    input,
    output,
    signal: abortController.signal,
    styles: plainStyles,
  });

  const result = controller.askSecret("Key> ");
  abortController.abort();

  assert.equal(await result, undefined);
  controller.close();
});

test("does not consume queued input or write a prompt after abort", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const abortController = new AbortController();
  const controller = createInputController({
    input,
    output,
    signal: abortController.signal,
    styles: plainStyles,
  });

  input.write("/exit\n");
  abortController.abort();

  assert.equal(await controller.ask("Chat> "), undefined);
  assert.equal(Buffer.concat(chunks).toString(), "");
  controller.close();
});

test("returns undefined when a pending secret prompt is closed", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });

  const result = controller.askSecret("Key> ");
  controller.close();

  assert.equal(await result, undefined);
});

test("reports whether both streams are interactive", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const nonInteractive = createInputController({
    input,
    output,
    signal: new AbortController().signal,
    styles: plainStyles,
  });
  assert.equal(nonInteractive.isInteractive, false);
  nonInteractive.close();

  const ttyInput = new PassThrough();
  const ttyOutput = new PassThrough();
  (ttyInput as PassThrough & { isTTY: boolean }).isTTY = true;
  (ttyOutput as PassThrough & { isTTY: boolean }).isTTY = true;
  const interactive = createInputController({
    input: ttyInput,
    output: ttyOutput,
    signal: new AbortController().signal,
    styles: plainStyles,
  });
  assert.equal(interactive.isInteractive, true);
  interactive.close();
});
