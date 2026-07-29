import type { SelectionItem } from "./chat-input.js";
import {
  createStyleContext,
  getThemes,
  paintTheme,
  type ColorMode,
  type ThemeId,
  type ThemeRole,
} from "./theme.js";

export interface ThemeSelectionModel {
  readonly items: readonly SelectionItem<ThemeId>[];
  readonly initialIndex: number;
}

const PREVIEW_ROLES: readonly ThemeRole[] = [
  "primary",
  "accent",
  "success",
];

export function getThemeSelectionModel(
  current: ThemeId,
  colorMode: ColorMode,
): ThemeSelectionModel {
  const items = getThemes().map((theme): SelectionItem<ThemeId> => {
    const styles = createStyleContext(theme.id, colorMode);
    return {
      label: theme.label,
      value: theme.id,
      status: theme.id === current ? "当前" : undefined,
      preview: PREVIEW_ROLES.map((role) =>
        paintTheme("●", role, styles)
      ).join(" "),
    };
  });

  return {
    items,
    initialIndex: Math.max(
      0,
      items.findIndex((item) => item.value === current),
    ),
  };
}
