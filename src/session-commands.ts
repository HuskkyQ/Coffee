import type { SelectionItem } from "./chat-input.js";
import type { SessionListItem } from "./history/types.js";

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(
      /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu,
      " ",
    )
    .replace(
      /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/gu,
      " ",
    )
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatSessionUpdatedAt(updatedAt: string): string {
  return new Date(updatedAt).toLocaleString("zh-CN", {
    hour12: false,
    timeZone: "Asia/Shanghai",
  });
}

export function getSessionSelectionItems(
  sessions: readonly SessionListItem[],
  activeSessionId?: string,
): SelectionItem<SessionListItem>[] {
  return sessions.map((session) => {
    const title = sanitizeTerminalText(session.title) || "新会话";
    const providerId =
      sanitizeTerminalText(session.providerId) || "未知平台";
    const modelId = sanitizeTerminalText(session.modelId) || "未知模型";
    return {
      label: title,
      value: session,
      description: `${providerId}/${modelId} · ${session.messageCount} 条消息 · ${formatSessionUpdatedAt(session.updatedAt)}`,
      status: session.id === activeSessionId ? "当前" : undefined,
    };
  });
}

export function renderSessionsMenu(
  sessions: readonly SessionListItem[],
  activeSessionId?: string,
): string {
  if (sessions.length === 0) return "还没有已保存的会话。";

  return [
    "选择会话（Esc 取消）：",
    ...sessions.map((session, index) => {
      const marker = session.id === activeSessionId ? "*" : " ";
      const title = sanitizeTerminalText(session.title) || "新会话";
      const providerId =
        sanitizeTerminalText(session.providerId) || "未知平台";
      const modelId = sanitizeTerminalText(session.modelId) || "未知模型";
      const updatedAt = formatSessionUpdatedAt(session.updatedAt);
      return `${index + 1}. ${marker} ${title}  ${providerId}/${modelId}  ${session.messageCount} 条消息  ${updatedAt}`;
    }),
  ].join("\n");
}

export function parseSessionChoice(
  input: string,
  sessions: readonly SessionListItem[],
): SessionListItem | undefined {
  const normalized = input.trim();
  if (!/^[0-9]+$/u.test(normalized)) return undefined;

  const choice = Number(normalized);
  if (!Number.isSafeInteger(choice) || choice <= 0) return undefined;

  try {
    const length = Object.getOwnPropertyDescriptor(sessions, "length")?.value;
    if (!Number.isSafeInteger(length) || choice > length) return undefined;

    const item = Object.getOwnPropertyDescriptor(
      sessions,
      String(choice - 1),
    );
    if (!item || !("value" in item)) return undefined;
    return item.value as SessionListItem | undefined;
  } catch {
    return undefined;
  }
}

export function parseDeleteConfirmation(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
