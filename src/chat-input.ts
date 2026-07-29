import {
  AbortPromptError,
  createPrompt,
  ExitPromptError,
  isDownKey,
  isEnterKey,
  isTabKey,
  isUpKey,
  useKeypress,
  useState,
} from "@inquirer/core";
import { createInterface } from "node:readline";

import stringWidth from "string-width";

import {
  getCommandSuggestions,
  type CommandDefinition,
} from "./commands.js";
import {
  paintTheme,
  type TerminalStyleContext,
} from "./theme.js";

const EMPTY_INPUT_ANCHOR = "\u200b";

export interface DropdownState {
  line: string;
  active: number;
  dismissed: boolean;
}

export type DropdownKey = "up" | "down" | "tab" | "enter" | "escape";

export interface DropdownTransition extends DropdownState {
  action?: "fill";
  submit?: string;
}

export interface DropdownView {
  items: CommandDefinition[];
  active: number;
}

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

export type SelectionMove = "up" | "down";

export function getInitialSelectionIndex<T>(
  items: readonly SelectionItem<T>[],
): number | undefined {
  const index = items.findIndex((item) => item.disabled !== true);
  return index === -1 ? undefined : index;
}

export function moveSelection<T>(
  items: readonly SelectionItem<T>[],
  active: number,
  move: SelectionMove,
): number {
  if (items.length === 0) {
    return active;
  }
  const direction = move === "down" ? 1 : -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index =
      (active + direction * offset + items.length * 2) % items.length;
    if (items[index]?.disabled !== true) {
      return index;
    }
  }
  return active;
}

export function getSelectionWindow(
  total: number,
  active: number,
  pageSize: number,
): { start: number; end: number } {
  const size = Math.max(1, Math.floor(pageSize));
  if (total <= size) {
    return { start: 0, end: total };
  }
  const start = Math.min(
    Math.max(0, active - size + 2),
    Math.max(0, total - size),
  );
  return { start, end: Math.min(total, start + size) };
}

function truncateTerminalText(value: string, width: number): string {
  if (stringWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return "…";
  }
  let truncated = "";
  for (const character of value) {
    if (stringWidth(`${truncated}${character}`) + 1 > width) {
      break;
    }
    truncated += character;
  }
  return `${truncated}…`;
}

function renderSelectionRow(
  item: SelectionItem<unknown>,
  marker: string,
  width: number,
): string {
  const status = item.status ? `  ${item.status}` : "";
  const withoutPreview = `${marker} ${item.label}${status}`;
  if (!item.preview) {
    return truncateTerminalText(withoutPreview, width);
  }

  const withPreview = `${marker} ${item.label}  ${item.preview}${status}`;
  return stringWidth(withPreview) <= width
    ? withPreview
    : truncateTerminalText(withoutPreview, width);
}

export function renderSelectionView<T>(config: {
  message: string;
  items: readonly SelectionItem<T>[];
  active: number;
  pageSize: number;
  styles: TerminalStyleContext;
  columns?: number;
}): string {
  const width =
    config.columns !== undefined && Number.isFinite(config.columns)
      ? Math.max(1, Math.min(Math.floor(config.columns), 120))
      : 80;
  const window = getSelectionWindow(
    config.items.length,
    config.active,
    config.pageSize,
  );
  const rows: string[] = [
    paintTheme(config.message, "accent", config.styles, { bold: true }),
    "",
  ];
  const useColor = config.styles.colorMode !== "none";

  for (let index = window.start; index < window.end; index += 1) {
    const item = config.items[index];
    if (!item) {
      continue;
    }
    const selected = index === config.active;
    const marker = selected ? (useColor ? "→" : ">") : " ";
    const label = renderSelectionRow(item, marker, width);
    rows.push(
      selected
        ? paintTheme(label, "primary", config.styles, {
            backgroundRole: "selectionBackground",
          })
        : item.disabled
          ? paintTheme(label, "muted", config.styles)
          : label,
    );
    if (item.description) {
      const description = truncateTerminalText(
        `  ${item.description}`,
        width,
      );
      rows.push(paintTheme(description, "muted", config.styles));
    }
  }

  rows.push("");
  if (config.items.length > config.pageSize) {
    rows.push(
      paintTheme(
        `(${config.active + 1}/${config.items.length})`,
        "muted",
        config.styles,
      ),
    );
  }
  rows.push(
    paintTheme(
      "↑↓ 移动 · Enter 确认 · Esc 取消",
      "muted",
      config.styles,
    ),
  );
  return rows.join("\n");
}

export function getDropdownView(
  line: string,
  active: number,
  dismissed: boolean,
): DropdownView {
  const items = dismissed ? [] : getCommandSuggestions(line);
  return {
    items,
    active: items.length === 0 ? 0 : Math.min(active, items.length - 1),
  };
}

export function applyDropdownKey(
  state: DropdownState,
  key: DropdownKey,
): DropdownTransition {
  if (key === "escape") {
    return { ...state, dismissed: true };
  }

  const view = getDropdownView(state.line, state.active, state.dismissed);
  if (view.items.length === 0) {
    return state;
  }
  if (key === "up") {
    return {
      ...state,
      active: (view.active - 1 + view.items.length) % view.items.length,
    };
  }
  if (key === "down") {
    return {
      ...state,
      active: (view.active + 1) % view.items.length,
    };
  }

  const selected = view.items[view.active];
  if (!selected) {
    return state;
  }
  if (key === "tab") {
    return {
      line: `${selected.name}${selected.acceptsArguments ? " " : ""}`,
      active: 0,
      dismissed: false,
      action: "fill",
    };
  }
  return { ...state, submit: selected.name };
}

export function renderCommandDropdown(view: DropdownView): string {
  return view.items
    .map((command, index) => {
      const marker = index === view.active ? "›" : " ";
      return `${marker} ${command.name.padEnd(11)}${command.description}`;
    })
    .join("\n");
}

interface ChatPromptConfig {
  message: string;
  suggestions: boolean;
  styles: TerminalStyleContext;
  columns?: number;
}

interface MutableReadline {
  line: string;
  cursor: number;
}

export function syncReadlineLine(
  readline: MutableReadline,
  line: string,
): void {
  readline.line = line;
  readline.cursor = line.length;
}

function colorizeDropdown(
  output: string,
  styles: TerminalStyleContext,
): string {
  return output
    .split("\n")
    .map((line) =>
      line.startsWith("›")
        ? paintTheme(line, "primary", styles, {
            backgroundRole: "selectionBackground",
          })
        : paintTheme(line, "muted", styles),
    )
    .join("\n");
}

export function renderChatPrompt(config: {
  message: string;
  line: string;
  dropdown: string;
  styles: TerminalStyleContext;
  columns?: number;
}): [string, string | undefined] {
  const dropdown = config.dropdown
    ? colorizeDropdown(config.dropdown, config.styles)
    : undefined;
  if (config.message !== "") {
    return [`${config.message}${config.line}`, dropdown];
  }

  const width =
    config.columns !== undefined && Number.isFinite(config.columns)
      ? Math.max(1, Math.floor(config.columns))
      : 80;
  const border = "─".repeat(width);
  const styledBorder = paintTheme(border, "border", config.styles, {
    backgroundRole: "inputBackground",
  });
  const inputLine = config.line === "" ? EMPTY_INPUT_ANCHOR : config.line;
  const styledInputLine = paintTheme(inputLine, "primary", config.styles, {
    backgroundRole: "inputBackground",
  });
  return [
    `${styledBorder}\n${styledInputLine}`,
    [styledBorder, dropdown].filter(Boolean).join("\n"),
  ];
}

const ttyPrompt = createPrompt<string, ChatPromptConfig>((config, done) => {
  const [line, setLine] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useKeypress((key, readline) => {
    if (!config.suggestions && key.name === "escape") {
      done("\u001b");
      return;
    }

    let dropdownKey: DropdownKey | undefined;
    if (isUpKey(key)) {
      dropdownKey = "up";
    } else if (isDownKey(key)) {
      dropdownKey = "down";
    } else if (isTabKey(key)) {
      dropdownKey = "tab";
    } else if (key.name === "escape") {
      dropdownKey = "escape";
    } else if (isEnterKey(key)) {
      dropdownKey = "enter";
    }

    if (config.suggestions && dropdownKey) {
      const transition = applyDropdownKey(
        { line, active, dismissed },
        dropdownKey,
      );
      if (transition.submit !== undefined) {
        done(transition.submit);
        return;
      }
      if (transition.action === "fill") {
        syncReadlineLine(
          readline as unknown as MutableReadline,
          transition.line,
        );
      }
      setLine(transition.line);
      setActive(transition.active);
      setDismissed(transition.dismissed);
      if (dropdownKey !== "enter") {
        return;
      }
    }

    if (isEnterKey(key)) {
      done(line);
      return;
    }

    const currentLine = readline.line;
    setLine(currentLine);
    if (currentLine !== line) {
      setActive(0);
      setDismissed(false);
    }
  });

  const view = config.suggestions
    ? getDropdownView(line, active, dismissed)
    : { items: [], active: 0 };
  const dropdown = renderCommandDropdown(view);
  return renderChatPrompt({
    message: config.message,
    line,
    dropdown,
    styles: config.styles,
    columns: config.columns,
  });
});

interface SelectionPromptConfig {
  message: string;
  items: readonly SelectionItem<unknown>[];
  pageSize: number;
  initialIndex?: number;
  styles: TerminalStyleContext;
  columns?: number;
}

function resolveInitialSelectionIndex(
  items: readonly SelectionItem<unknown>[],
  initialIndex: number | undefined,
): number {
  if (
    initialIndex !== undefined &&
    Number.isInteger(initialIndex) &&
    initialIndex >= 0 &&
    initialIndex < items.length &&
    items[initialIndex]?.disabled !== true
  ) {
    return initialIndex;
  }
  return getInitialSelectionIndex(items) ?? 0;
}

const selectionPrompt = createPrompt<unknown, SelectionPromptConfig>(
  (config, done) => {
    const [active, setActive] = useState(
      resolveInitialSelectionIndex(config.items, config.initialIndex),
    );

    useKeypress((key) => {
      if (isUpKey(key)) {
        setActive(moveSelection(config.items, active, "up"));
        return;
      }
      if (isDownKey(key)) {
        setActive(moveSelection(config.items, active, "down"));
        return;
      }
      if (key.name === "escape") {
        done(undefined);
        return;
      }
      if (isEnterKey(key)) {
        const selected = config.items[active];
        if (selected?.disabled !== true) {
          done(selected?.value);
        }
      }
    });

    return renderSelectionView({
      ...config,
      active,
    });
  },
);

interface SecretPromptConfig {
  message: string;
}

export function renderSecretValue(value: string): string {
  return Array.from(value, () => "•").join("");
}

export interface SecretKeypressTransition {
  line: string;
  submit?: string;
}

export function applySecretKeypress(
  line: string,
  readlineLine: string,
  isEnter: boolean,
): SecretKeypressTransition {
  return isEnter ? { line, submit: line } : { line: readlineLine };
}

const secretPrompt = createPrompt<string, SecretPromptConfig>((config, done) => {
  const [line, setLine] = useState("");

  useKeypress((key, readline) => {
    const transition = applySecretKeypress(
      line,
      readline.line,
      isEnterKey(key),
    );
    if (transition.submit !== undefined) {
      done(transition.submit);
      return;
    }
    setLine(transition.line);
  });

  return `${config.message}${renderSecretValue(line)}`;
});

interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
}

interface OutputStream extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
}

export interface InputController {
  readonly isInteractive: boolean;
  ask(message: string, suggestions?: boolean): Promise<string | undefined>;
  askSecret(message: string): Promise<string | undefined>;
  select<T>(options: SelectionOptions<T>): Promise<T | undefined>;
  setStyleContext(styles: TerminalStyleContext): void;
  close(): void;
}

export function createInputController({
  input,
  output,
  signal,
  styles,
}: {
  input: InputStream;
  output: OutputStream;
  signal: AbortSignal;
  styles: TerminalStyleContext;
}): InputController {
  const isTTY = input.isTTY === true && output.isTTY === true;
  const readline = isTTY ? undefined : createInterface({ input });
  const queuedLines: string[] = [];
  let pendingLine: ((line: string | undefined) => void) | undefined;
  let currentStyles = styles;
  let closed = false;

  readline?.on("line", (line) => {
    if (pendingLine) {
      const resolve = pendingLine;
      pendingLine = undefined;
      resolve(line);
      return;
    }
    queuedLines.push(line);
  });
  readline?.on("close", () => {
    closed = true;
    pendingLine?.(undefined);
    pendingLine = undefined;
  });
  signal.addEventListener(
    "abort",
    () => {
      pendingLine?.(undefined);
      pendingLine = undefined;
    },
    { once: true },
  );

  async function readLine(message: string): Promise<string | undefined> {
    if (signal.aborted) {
      return undefined;
    }
    const queued = queuedLines.shift();
    if (queued !== undefined) {
      output.write(message);
      return queued;
    }
    if (closed) {
      return undefined;
    }
    output.write(message);
    return await new Promise<string | undefined>((resolve) => {
      pendingLine = resolve;
    });
  }

  async function handlePrompt<T>(
    prompt: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await prompt();
    } catch (error) {
      if (
        signal.aborted ||
        error instanceof AbortPromptError ||
        error instanceof ExitPromptError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  return {
    isInteractive: isTTY,
    async ask(message, suggestions = true) {
      if (readline) {
        return await readLine(message);
      }
      return await handlePrompt(() =>
        ttyPrompt(
          {
            message,
            suggestions,
            styles: currentStyles,
            columns: output.columns,
          },
          { input, output, signal },
        ),
      );
    },
    async askSecret(message) {
      if (readline) {
        return await readLine(message);
      }
      return await handlePrompt(() =>
        secretPrompt({ message }, { input, output, signal }),
      );
    },
    async select<T>(
      options: SelectionOptions<T>,
    ): Promise<T | undefined> {
      if (
        options.items.length === 0 ||
        getInitialSelectionIndex(options.items) === undefined
      ) {
        return undefined;
      }
      if (readline) {
        const menu = [
          options.message,
          "",
          ...options.items.flatMap((item, index) => {
            const status = item.status ? `  ${item.status}` : "";
            const disabled = item.disabled ? "  不可用" : "";
            const row = `  ${index + 1}. ${item.label}${status}${disabled}`;
            return item.description
              ? [row, `     ${item.description}`]
              : [row];
          }),
          "",
          "输入序号，或按 Esc 取消：",
        ].join("\n");
        const answer = await readLine(menu);
        if (answer === undefined || answer.trim() === "\u001b") {
          return undefined;
        }
        const normalized = answer.trim();
        if (!/^\d+$/u.test(normalized)) {
          return undefined;
        }
        const index = Number(normalized) - 1;
        const item = Number.isSafeInteger(index)
          ? options.items[index]
          : undefined;
        return item?.disabled === true ? undefined : item?.value;
      }
      const result = await handlePrompt(() =>
        selectionPrompt(
          {
            message: options.message,
            items: options.items,
            pageSize: options.pageSize ?? 8,
            initialIndex: options.initialIndex,
            styles: currentStyles,
            columns: output.columns,
          },
          {
            input,
            output,
            signal,
            clearPromptOnDone: true,
          },
        ),
      );
      return result as T | undefined;
    },
    setStyleContext(nextStyles) {
      currentStyles = nextStyles;
    },
    close() {
      readline?.close();
    },
  };
}
