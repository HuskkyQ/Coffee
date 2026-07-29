import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { withFileLock } from "./file-lock.js";
import {
  DEFAULT_HISTORY_PREFERENCES,
  type HistoryPreferences,
} from "./history/types.js";
import {
  DEFAULT_THEME_ID,
  getTheme,
  type ThemeId,
} from "./theme.js";

export const SETTINGS_PATH = fileURLToPath(
  new URL("../coffee.settings.json", import.meta.url),
);

export interface LoadedThemePreference {
  themeId: ThemeId;
  warning?: string;
}

export interface ModelPreference {
  provider: string;
  model: string;
}

export interface LoadedModelPreference {
  preference?: ModelPreference;
  warning?: string;
}

export interface LoadedHistoryPreferences {
  preferences: HistoryPreferences;
  warning?: string;
}

type JsonObject = Record<string, unknown>;

const settingsUpdateQueues = new Map<string, Promise<void>>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function readSettingsText(settingsPath: string): Promise<string | undefined> {
  try {
    return await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function parseSettings(text: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("coffee.settings.json 不是有效的 JSON。");
  }
  if (!isObject(value)) {
    throw new Error("coffee.settings.json 的根节点必须是 JSON 对象。");
  }
  return value;
}

async function writeSettingsAtomically(
  settingsPath: string,
  settings: JsonObject,
): Promise<void> {
  const temporaryPath = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, settingsPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function updateSettings(
  settingsPath: string,
  update: (settings: JsonObject) => void,
): Promise<void> {
  const previousUpdate = settingsUpdateQueues.get(settingsPath);
  const currentUpdate = (previousUpdate ?? Promise.resolve())
    .catch(() => undefined)
    .then(() =>
      withFileLock(settingsPath, async () => {
        const text = await readSettingsText(settingsPath);
        const settings = text === undefined ? {} : parseSettings(text);
        update(settings);
        await writeSettingsAtomically(settingsPath, settings);
      }),
    );

  settingsUpdateQueues.set(settingsPath, currentUpdate);
  try {
    await currentUpdate;
  } finally {
    if (settingsUpdateQueues.get(settingsPath) === currentUpdate) {
      settingsUpdateQueues.delete(settingsPath);
    }
  }
}

export async function loadThemePreference(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedThemePreference> {
  const text = await readSettingsText(settingsPath);
  if (text === undefined) {
    return { themeId: DEFAULT_THEME_ID };
  }

  let settings: JsonObject;
  try {
    settings = parseSettings(text);
  } catch (error) {
    return {
      themeId: DEFAULT_THEME_ID,
      warning: error instanceof Error ? error.message : String(error),
    };
  }

  const preferences = settings["coffee-preferences"];
  if (preferences === undefined) {
    return { themeId: DEFAULT_THEME_ID };
  }
  if (!isObject(preferences)) {
    return {
      themeId: DEFAULT_THEME_ID,
      warning: "coffee-preferences 必须是 JSON 对象。",
    };
  }

  const theme = preferences.theme;
  if (theme === undefined) {
    return { themeId: DEFAULT_THEME_ID };
  }
  const registeredTheme =
    typeof theme === "string" ? getTheme(theme) : undefined;
  if (registeredTheme === undefined) {
    return {
      themeId: DEFAULT_THEME_ID,
      warning:
        "coffee-preferences.theme 只允许 latte、coast 或 camp。",
    };
  }

  return { themeId: registeredTheme.id };
}

export async function loadModelPreference(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedModelPreference> {
  const text = await readSettingsText(settingsPath);
  if (text === undefined) {
    return {};
  }

  let settings: JsonObject;
  try {
    settings = parseSettings(text);
  } catch (error) {
    return {
      warning: error instanceof Error ? error.message : String(error),
    };
  }

  const preference = settings["model-preferences"];
  if (preference === undefined) {
    return {};
  }
  if (
    !isObject(preference) ||
    typeof preference.provider !== "string" ||
    typeof preference.model !== "string" ||
    preference.provider.trim() === "" ||
    preference.model.trim() === ""
  ) {
    return {
      warning: "model-preferences 必须包含非空字符串 provider 和 model。",
    };
  }

  return {
    preference: {
      provider: preference.provider.trim(),
      model: preference.model.trim(),
    },
  };
}

export async function loadHistoryPreferences(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedHistoryPreferences> {
  const text = await readSettingsText(settingsPath);
  if (text === undefined) {
    return { preferences: DEFAULT_HISTORY_PREFERENCES };
  }

  let settings: JsonObject;
  try {
    settings = parseSettings(text);
  } catch (error) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning: error instanceof Error ? error.message : String(error),
    };
  }

  const section = settings["history-preferences"];
  if (section === undefined) {
    return { preferences: DEFAULT_HISTORY_PREFERENCES };
  }
  if (!isObject(section)) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning: "history-preferences 必须是 JSON 对象。",
    };
  }

  const compressionThresholdChars = section["compression-threshold-chars"];
  const maxContextChars = section["max-context-chars"];
  const summaryTargetChars = section["summary-target-chars"];
  if (
    !Number.isInteger(compressionThresholdChars) ||
    (compressionThresholdChars as number) <= 0 ||
    !Number.isInteger(maxContextChars) ||
    (maxContextChars as number) <= 0 ||
    !Number.isInteger(summaryTargetChars) ||
    (summaryTargetChars as number) <= 0 ||
    (summaryTargetChars as number) >= (compressionThresholdChars as number) ||
    (compressionThresholdChars as number) >= (maxContextChars as number)
  ) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning:
        "history-preferences 必须包含正整数 compression-threshold-chars、max-context-chars 和 summary-target-chars，且 summary-target-chars < compression-threshold-chars < max-context-chars。",
    };
  }

  return {
    preferences: {
      compressionThresholdChars: compressionThresholdChars as number,
      maxContextChars: maxContextChars as number,
      summaryTargetChars: summaryTargetChars as number,
    },
  };
}

export async function saveThemePreference(
  settingsPath: string,
  themeId: ThemeId,
): Promise<void> {
  await updateSettings(settingsPath, (settings) => {
    const existingPreferences = settings["coffee-preferences"];
    const preferences = isObject(existingPreferences)
      ? existingPreferences
      : {};

    settings["coffee-preferences"] = {
      ...preferences,
      theme: themeId,
    };
  });
}

export async function saveModelPreference(
  settingsPath: string,
  preference: ModelPreference,
): Promise<void> {
  const provider = preference.provider.trim();
  const model = preference.model.trim();
  if (provider === "" || model === "") {
    throw new Error("模型偏好 provider 和 model 必须是非空字符串。");
  }

  await updateSettings(settingsPath, (settings) => {
    const existingPreference = settings["model-preferences"];
    const modelPreference = isObject(existingPreference)
      ? existingPreference
      : {};

    settings["model-preferences"] = {
      ...modelPreference,
      provider,
      model,
    };
  });
}
