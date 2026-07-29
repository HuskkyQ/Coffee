import stringWidth from "string-width";

import {
  createStyleContext,
  DEFAULT_THEME_ID,
  paintTheme,
  type TerminalStyleContext,
  type ThemeRole,
} from "./theme.js";

export type StyleKind = "user" | "assistant" | "startup" | "error";

const STYLE_ROLES: Record<StyleKind, ThemeRole> = {
  user: "primary",
  assistant: "success",
  startup: "primary",
  error: "error",
};

type StyleContextInput = TerminalStyleContext | boolean;

const LEGACY_COLOR_STYLES = createStyleContext(DEFAULT_THEME_ID, "ansi");
const LEGACY_PLAIN_STYLES = createStyleContext(DEFAULT_THEME_ID, "none");

function resolveStyles(styles: StyleContextInput): TerminalStyleContext {
  return typeof styles === "boolean"
    ? styles
      ? LEGACY_COLOR_STYLES
      : LEGACY_PLAIN_STYLES
    : styles;
}

function renderInline(
  input: string,
  styles: TerminalStyleContext,
): string {
  return input
    .replace(
      /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g,
      (_match, label, url) => {
        const styledUrl = paintTheme(
          url,
          "primary",
          styles,
          { underline: true },
        );
        return `${label} (${styledUrl})`;
      },
    )
    .replace(/`([^`]+)`/g, (_match, code) =>
      paintTheme(code, "primary", styles),
    )
    .replace(/\*\*([^*]+)\*\*/g, (_match, bold) =>
      paintTheme(bold, "warning", styles, { bold: true }),
    );
}

function renderLine(line: string, styles: TerminalStyleContext): string {
  const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
  if (heading) {
    return paintTheme(
      renderInline(heading[1] ?? "", styles),
      "accent",
      styles,
      { bold: true },
    );
  }

  const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (bullet) {
    const prefix =
      `${bullet[1] ?? ""}${paintTheme("•", "primary", styles)}`;
    return `${prefix} ${renderInline(bullet[2] ?? "", styles)}`;
  }

  return renderInline(line, styles);
}

export function renderMarkdown(
  input: string,
  styleContext: StyleContextInput,
): string {
  const styles = resolveStyles(styleContext);
  return input
    .split("\n")
    .map((line) => renderLine(line, styles))
    .join("\n");
}

export function shouldUseColor(
  isTTY: boolean | undefined,
  noColor: string | undefined,
): boolean {
  return isTTY === true && noColor === undefined;
}

export function styleText(
  text: string,
  kind: StyleKind,
  styleContext: StyleContextInput,
): string {
  return paintTheme(
    text,
    STYLE_ROLES[kind],
    resolveStyles(styleContext),
    { bold: true },
  );
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\r/g, "\\r")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function sanitizeTerminalLabel(value: string): string {
  return sanitizeTerminalText(value)
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
}

export function wrapTerminalLine(
  line: string,
  columns: number | undefined,
): string[] {
  const width = Math.max(1, columns ?? 100);
  const result: string[] = [];
  let current = "";
  for (const character of line) {
    if (current && stringWidth(current + character) > width) {
      result.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

export function styleDiffLine(
  line: string,
  styleContext: StyleContextInput,
): string {
  const styles = resolveStyles(styleContext);
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return paintTheme(line, "primary", styles, { bold: true });
  }
  if (line.startsWith("+")) return paintTheme(line, "success", styles);
  if (line.startsWith("-")) return paintTheme(line, "error", styles);
  return line;
}
