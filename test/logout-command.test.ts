import assert from "node:assert/strict";
import test from "node:test";

import {
  getLogoutCandidates,
  getLogoutSelectionItems,
  parseLogoutChoice,
  renderLogoutMenu,
} from "../src/logout-command.js";
import { CREDENTIALS } from "../src/models/catalog.js";
import type {
  CredentialDefinition,
  CredentialId,
} from "../src/models/types.js";

test("builds logout selection items with credential values", () => {
  const candidates = [CREDENTIALS[1]!, CREDENTIALS[0]!];
  const items = getLogoutSelectionItems(candidates);

  assert.deepEqual(
    items.map((item) => item.label),
    ["OpenCode", "DeepSeek"],
  );
  assert.strictEqual(items[0]?.value, candidates[0]);
});

test("returns only auth-file saved credentials in catalog order", () => {
  const credentials: CredentialDefinition[] = [...CREDENTIALS];
  const savedIds = new Set<CredentialId>(["volcengine-ark", "deepseek"]);
  const originalCredentials = [...credentials];

  const candidates = getLogoutCandidates(credentials, savedIds);

  assert.deepEqual(
    candidates.map((credential) => credential.id),
    ["deepseek", "volcengine-ark"],
  );
  assert.deepEqual(credentials, originalCredentials);
  assert.deepEqual([...savedIds], ["volcengine-ark", "deepseek"]);
});

test("does not list an environment-only credential as a logout candidate", () => {
  const savedIds = new Set<CredentialId>(["deepseek"]);

  assert.deepEqual(
    getLogoutCandidates(CREDENTIALS, savedIds).map(
      (credential) => credential.id,
    ),
    ["deepseek"],
  );
});

test("renders numbered logout choices without mutating candidates", () => {
  const candidates: CredentialDefinition[] = [CREDENTIALS[1]!, CREDENTIALS[0]!];
  const original = [...candidates];

  const output = renderLogoutMenu(candidates);

  assert.match(output, /1\. OpenCode/);
  assert.match(output, /2\. DeepSeek/);
  assert.match(output, /输入序号/);
  assert.match(output, /Esc/);
  assert.equal(output.includes("\u001b"), false);
  assert.deepEqual(candidates, original);
});

test("explains when no saved credential can be logged out", () => {
  const output = renderLogoutMenu([]);

  assert.match(output, /没有保存在 ~\/\.coffee\/auth\.json 中的凭证/);
  assert.equal(output.includes("\u001b"), false);
});

test("parses trimmed logout choices and rejects invalid input", () => {
  const candidates = [CREDENTIALS[1]!, CREDENTIALS[2]!];

  assert.equal(parseLogoutChoice(" 1 ", candidates)?.id, "opencode");
  assert.equal(parseLogoutChoice("2", candidates)?.id, "volcengine-ark");
  for (const input of ["", "0", "3", "x", "\u001b"]) {
    assert.equal(parseLogoutChoice(input, candidates), undefined);
  }
});
