import type { SelectionItem } from "./chat-input.js";
import type {
  CredentialDefinition,
  CredentialId,
} from "./models/types.js";

export interface CredentialStatus {
  source: "auth-file" | "environment";
  maskedKey: string;
}

export type LoginAction = "keep" | "update" | "cancel";

function getCredentialStatusLabel(
  status: CredentialStatus | undefined,
): string {
  return status === undefined
    ? "未登录"
    : status.source === "auth-file"
      ? `已登录 ${status.maskedKey}`
      : `已通过 .env 配置 ${status.maskedKey}`;
}

export function getLoginCredentialItems(
  credentials: readonly CredentialDefinition[],
  statuses: ReadonlyMap<CredentialId, CredentialStatus>,
): SelectionItem<CredentialDefinition>[] {
  return credentials.map((credential) => ({
    label: credential.name,
    value: credential,
    status: getCredentialStatusLabel(statuses.get(credential.id)),
  }));
}

export function getConfiguredLoginActionItems(): SelectionItem<LoginAction>[] {
  return [
    { label: "保留当前凭证", value: "keep" },
    { label: "更新 API Key", value: "update" },
    { label: "取消", value: "cancel" },
  ];
}

export function parseNumberedChoice<T>(
  input: string,
  items: readonly T[],
): T | undefined {
  const choice = input.trim();
  if (!/^\d+$/.test(choice)) {
    return undefined;
  }

  const index = Number(choice) - 1;
  return Number.isSafeInteger(index) ? items[index] : undefined;
}

export function renderLoginMenu(
  credentials: readonly CredentialDefinition[],
  statuses: ReadonlyMap<CredentialId, CredentialStatus>,
): string {
  return [
    "选择登录平台：",
    "",
    ...credentials.map((credential, index) => {
      const label = getCredentialStatusLabel(statuses.get(credential.id));
      return `  ${index + 1}. ${credential.name}  ${label}`;
    }),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}

export function renderConfiguredLoginActions(
  status: CredentialStatus,
): string {
  const source =
    status.source === "auth-file" ? "~/.coffee/auth.json" : ".env";
  return [
    `当前凭证：${status.maskedKey}`,
    `来源：${source}`,
    "",
    "  1. 保留当前凭证",
    "  2. 更新 API Key",
    "  3. 取消",
    "",
    "请输入 1、2 或 3：",
  ].join("\n");
}

export function parseLoginAction(input: string): LoginAction | undefined {
  return parseNumberedChoice(input, ["keep", "update", "cancel"] as const);
}
