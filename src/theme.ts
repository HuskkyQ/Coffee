export type ThemeId = "latte" | "coast" | "camp";
export type ColorMode = "none" | "truecolor" | "ansi";
export type ThemeRole =
  | "primary"
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "muted"
  | "border"
  | "selectionBackground"
  | "inputBackground";

export interface ThemeColor {
  readonly rgb: readonly [number, number, number];
  readonly ansi: string;
}

export interface TerminalTheme {
  readonly id: ThemeId;
  readonly label: string;
  readonly colors: Readonly<Record<ThemeRole, ThemeColor>>;
}

export interface TerminalStyleContext {
  readonly theme: TerminalTheme;
  readonly colorMode: ColorMode;
}

interface ColorModeOptions {
  isTTY: boolean | undefined;
  noColor?: string;
  colorTerm?: string;
  term?: string;
  termProgram?: string;
}

interface PaintOptions {
  bold?: boolean;
  underline?: boolean;
  backgroundRole?: ThemeRole;
}

const ESCAPE = "\u001b[";
const RESET = "\u001b[0m";
const TRUE_COLOR_TERMINALS = new Set([
  "apple_terminal",
  "hyper",
  "iterm.app",
  "vscode",
  "wezterm",
]);

function color(
  rgb: readonly [number, number, number],
  ansi: string,
): ThemeColor {
  return Object.freeze({ rgb: Object.freeze(rgb), ansi });
}

function defineTheme(
  id: ThemeId,
  label: string,
  colors: Record<ThemeRole, ThemeColor>,
): TerminalTheme {
  return Object.freeze({
    id,
    label,
    colors: Object.freeze(colors),
  });
}

const THEMES = Object.freeze([
  defineTheme("latte", "奶油拿铁", {
    primary: color([211, 166, 111], "93"),
    accent: color([238, 225, 207], "97"),
    success: color([159, 188, 135], "92"),
    warning: color([211, 166, 111], "93"),
    error: color([215, 130, 115], "91"),
    muted: color([167, 147, 121], "90"),
    border: color([128, 106, 84], "33"),
    selectionBackground: color([64, 51, 40], "90"),
    inputBackground: color([75, 62, 50], "90"),
  }),
  defineTheme("coast", "周末海岸", {
    primary: color([128, 193, 183], "96"),
    accent: color([224, 235, 231], "97"),
    success: color([155, 196, 146], "92"),
    warning: color([212, 178, 120], "93"),
    error: color([220, 129, 121], "91"),
    muted: color([136, 160, 158], "90"),
    border: color([78, 120, 122], "36"),
    selectionBackground: color([43, 66, 68], "90"),
    inputBackground: color([54, 77, 79], "90"),
  }),
  defineTheme("camp", "暮色露营", {
    primary: color([201, 145, 167], "95"),
    accent: color([236, 222, 228], "97"),
    success: color([168, 189, 136], "92"),
    warning: color([210, 174, 118], "93"),
    error: color([212, 126, 117], "91"),
    muted: color([161, 140, 150], "90"),
    border: color([114, 87, 101], "35"),
    selectionBackground: color([66, 50, 58], "90"),
    inputBackground: color([77, 61, 69], "90"),
  }),
] satisfies readonly TerminalTheme[]);

const THEMES_BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

export const DEFAULT_THEME_ID: ThemeId = "latte";

export function getThemes(): readonly TerminalTheme[] {
  return THEMES;
}

export function getTheme(id: string): TerminalTheme | undefined {
  return THEMES_BY_ID.get(id as ThemeId);
}

export function createStyleContext(
  themeId: ThemeId,
  colorMode: ColorMode,
): TerminalStyleContext {
  return Object.freeze({
    theme: THEMES_BY_ID.get(themeId)!,
    colorMode,
  });
}

export function resolveColorMode({
  isTTY,
  noColor,
  colorTerm,
  term,
  termProgram,
}: ColorModeOptions): ColorMode {
  if (isTTY !== true || noColor !== undefined) {
    return "none";
  }
  if (/^(?:truecolor|24bit)$/iu.test(colorTerm?.trim() ?? "")) {
    return "truecolor";
  }
  if (/(?:truecolor|24bit|direct)/iu.test(term ?? "")) {
    return "truecolor";
  }
  if (TRUE_COLOR_TERMINALS.has(termProgram?.trim().toLowerCase() ?? "")) {
    return "truecolor";
  }
  return "ansi";
}

function rgbCode(
  colorValue: ThemeColor,
  background: boolean,
): string {
  const [red, green, blue] = colorValue.rgb;
  return `${background ? 48 : 38};2;${red};${green};${blue}`;
}

function ansiBackgroundCode(foregroundCode: string): string {
  const code = Number(foregroundCode);
  if (
    (code >= 30 && code <= 37) ||
    (code >= 90 && code <= 97)
  ) {
    return String(code + 10);
  }
  return "40";
}

export function paintTheme(
  text: string,
  role: ThemeRole,
  styles: TerminalStyleContext,
  options: PaintOptions = {},
): string {
  if (styles.colorMode === "none" || text === "") {
    return text;
  }

  const foreground = styles.theme.colors[role];
  const codes: string[] = [];
  if (options.bold) {
    codes.push("1");
  }
  if (options.underline) {
    codes.push("4");
  }
  codes.push(
    styles.colorMode === "truecolor"
      ? rgbCode(foreground, false)
      : foreground.ansi,
  );

  if (options.backgroundRole) {
    const background = styles.theme.colors[options.backgroundRole];
    codes.push(
      styles.colorMode === "truecolor"
        ? rgbCode(background, true)
        : ansiBackgroundCode(background.ansi),
    );
  }

  return `${ESCAPE}${codes.join(";")}m${text}${RESET}`;
}
