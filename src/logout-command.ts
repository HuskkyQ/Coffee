import type { SelectionItem } from "./chat-input.js";
import { parseNumberedChoice } from "./login-command.js";
import type {
  CredentialDefinition,
  CredentialId,
} from "./models/types.js";

export function getLogoutCandidates(
  credentials: readonly CredentialDefinition[],
  savedIds: ReadonlySet<CredentialId>,
): CredentialDefinition[] {
  return credentials.filter((credential) => savedIds.has(credential.id));
}

export function getLogoutSelectionItems(
  candidates: readonly CredentialDefinition[],
): SelectionItem<CredentialDefinition>[] {
  return candidates.map((credential) => ({
    label: credential.name,
    value: credential,
  }));
}

export function renderLogoutMenu(
  candidates: readonly CredentialDefinition[],
): string {
  if (candidates.length === 0) {
    return "没有保存在 ~/.coffee/auth.json 中的凭证。";
  }

  return [
    "选择退出的平台：",
    "",
    ...candidates.map(
      (credential, index) => `  ${index + 1}. ${credential.name}`,
    ),
    "",
    "输入序号，或按 Esc 取消：",
  ].join("\n");
}

export function parseLogoutChoice(
  input: string,
  candidates: readonly CredentialDefinition[],
): CredentialDefinition | undefined {
  return parseNumberedChoice(input, candidates);
}
