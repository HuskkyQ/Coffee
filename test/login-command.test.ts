import assert from "node:assert/strict";
import test from "node:test";

import {
  getConfiguredLoginActionItems,
  getLoginCredentialItems,
  parseLoginAction,
  parseNumberedChoice,
  renderConfiguredLoginActions,
  renderLoginMenu,
  type CredentialStatus,
} from "../src/login-command.js";
import { CREDENTIALS } from "../src/models/catalog.js";
import type {
  CredentialDefinition,
  CredentialId,
} from "../src/models/types.js";

test("builds credential selection items with status and business values", () => {
  const credentials: CredentialDefinition[] = [...CREDENTIALS];
  const statuses = new Map<CredentialId, CredentialStatus>([
    [
      "deepseek",
      { source: "auth-file", maskedKey: "dee••••••1234" },
    ],
  ]);

  const items = getLoginCredentialItems(credentials, statuses);

  assert.strictEqual(items[0]?.value, credentials[0]);
  assert.equal(items[0]?.status, "已登录 dee••••••1234");
  assert.equal(items[1]?.status, "未登录");
  assert.deepEqual(
    getConfiguredLoginActionItems().map((item) => item.value),
    ["keep", "update", "cancel"],
  );
});

test("renders each credential once with missing, saved, and environment status", () => {
  const credentials: CredentialDefinition[] = [...CREDENTIALS];
  const statuses = new Map<CredentialId, CredentialStatus>([
    [
      "deepseek",
      { source: "auth-file", maskedKey: "dee••••••1234" },
    ],
    [
      "opencode",
      { source: "environment", maskedKey: "ope••••••5678" },
    ],
  ]);
  const originalCredentials = [...credentials];
  const originalStatuses = [...statuses];

  const output = renderLoginMenu(credentials, statuses);

  assert.match(output, /1\. DeepSeek\s+已登录 dee••••••1234/);
  assert.match(
    output,
    /2\. OpenCode\s+已通过 \.env 配置 ope••••••5678/,
  );
  assert.match(output, /3\. 方舟 Agent Plan\s+未登录/);
  assert.equal((output.match(/OpenCode/g) ?? []).length, 1);
  assert.match(output, /输入序号/);
  assert.match(output, /Esc/);
  assert.equal(output.includes("\u001b"), false);
  assert.deepEqual(credentials, originalCredentials);
  assert.deepEqual([...statuses], originalStatuses);
});

test("renders configured login actions with a masked auth-file credential", () => {
  const status: CredentialStatus = {
    source: "auth-file",
    maskedKey: "sk-••••••1234",
  };
  const output = renderConfiguredLoginActions(status);

  assert.match(output, /当前凭证：sk-••••••1234/);
  assert.match(output, /来源：~\/\.coffee\/auth\.json/);
  assert.match(output, /1\. 保留当前凭证/);
  assert.match(output, /2\. 更新 API Key/);
  assert.match(output, /3\. 取消/);
  assert.equal(output.includes("\u001b"), false);
});

test("renders configured login actions with an environment source", () => {
  const output = renderConfiguredLoginActions({
    source: "environment",
    maskedKey: "••••••••",
  });

  assert.match(output, /当前凭证：••••••••/);
  assert.match(output, /来源：\.env/);
  assert.doesNotMatch(output, /auth\.json/);
});

test("parses trimmed one-based numbered choices", () => {
  assert.equal(parseNumberedChoice(" 2 ", CREDENTIALS)?.id, "opencode");
  assert.equal(parseNumberedChoice("1", ["first", "second"]), "first");
});

test("returns undefined for invalid, empty, and escaped numbered choices", () => {
  for (const input of ["", "   ", "0", "4", "-1", "other", "\u001b"]) {
    assert.equal(parseNumberedChoice(input, CREDENTIALS), undefined);
  }
});

test("parses configured login actions and rejects cancellation-like input", () => {
  assert.equal(parseLoginAction(" 1 "), "keep");
  assert.equal(parseLoginAction("2"), "update");
  assert.equal(parseLoginAction("3"), "cancel");

  for (const input of ["", "0", "4", "no", "\u001b"]) {
    assert.equal(parseLoginAction(input), undefined);
  }
});
