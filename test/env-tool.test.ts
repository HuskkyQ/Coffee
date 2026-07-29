import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

import { createEnvTool } from "../src/code-tools/env-tool.js";
import type { MutationPreview, ToolInteraction } from "../src/code-tools/types.js";
import { createWorkspacePolicy } from "../src/code-tools/workspace-policy.js";

function toolWith(
  root: string,
  overrides: Partial<ToolInteraction> = {},
) {
  return createEnvTool({
    policy: createWorkspacePolicy(root),
    interaction: {
      async authorizeProtected() { return false; },
      async confirmMutation() { return true; },
      async requestSecret() { return "secret"; },
      ...overrides,
    },
  });
}

test("set_env writes a secret while result and preview stay masked", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "TOKEN=old-secret\nKEEP=yes\n");
  let preview: MutationPreview | undefined;
  const tool = toolWith(root, {
    async requestSecret() { return "new-super-secret"; },
    async confirmMutation(value) { preview = value; return true; },
  });

  const result = await tool.execute({ path: ".env", key: "TOKEN" });

  assert.deepEqual(result, { ok: true, path: ".env", key: "TOKEN", set: true });
  assert.doesNotMatch(JSON.stringify({ result, preview }), /old-secret|new-super-secret/);
  assert.match(preview?.patch ?? "", /<hidden/);
  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "TOKEN=new-super-secret\nKEEP=yes\n",
  );
});

test("invalid or duplicate dotenv is rejected before asking for a secret", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "TOKEN=a\nTOKEN=b\n");
  let asked = false;
  const result = await toolWith(root, {
    async requestSecret() { asked = true; return "value"; },
  }).execute({ path: ".env", key: "TOKEN" });

  assert.equal(result.code, "INVALID_ARGUMENT");
  assert.equal(asked, false);
});

test("new dotenv history shape contains no secret", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-new-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = { path: ".env.local", key: "API_KEY" };
  const result = await toolWith(root, {
    async requestSecret() { return "history-must-not-see-this"; },
  }).execute(args);

  assert.doesNotMatch(
    JSON.stringify({ argumentsJson: JSON.stringify(args), result }),
    /history-must-not-see-this/,
  );
  assert.equal(
    await readFile(path.join(root, ".env.local"), "utf8"),
    "API_KEY=history-must-not-see-this\n",
  );
});

test("set_env preserves BOM and CRLF and safely quotes special values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-crlf-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), "\uFEFFTOKEN=old\r\nKEEP=yes\r\n");
  await toolWith(root, {
    async requestSecret() { return "line one\n#still-value"; },
  }).execute({ path: ".env", key: "TOKEN" });

  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "\uFEFFTOKEN='line one\r\n#still-value'\r\nKEEP=yes\r\n",
  );
});

test("cancelling secret input never creates a dotenv file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await toolWith(root, {
    async requestSecret() { return undefined; },
    async confirmMutation() { throw new Error("must not confirm"); },
  }).execute({ path: ".env", key: "TOKEN" });

  assert.equal(result.code, "USER_REJECTED");
  await assert.rejects(readFile(path.join(root, ".env")), /ENOENT/);
});

test("set_env rejects non-env paths, unknown arguments, and inherited values", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-args-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tool = toolWith(root);

  assert.equal((await tool.execute({ path: "config.txt", key: "TOKEN" })).code, "PATH_DENIED");
  assert.equal((await tool.execute({ path: ".env", key: "bad-key" })).code, "INVALID_ARGUMENT");
  assert.equal((await tool.execute({ path: ".env", key: "TOKEN", value: "leak" })).code, "INVALID_ARGUMENT");
  const inherited = Object.create({ path: ".env", key: "TOKEN" }) as Record<string, unknown>;
  assert.equal((await tool.execute(inherited)).code, "INVALID_ARGUMENT");
});

test("confirmation rejection and confirmation-time conflicts never persist", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-conflict-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, ".env");
  await writeFile(target, "TOKEN=old\n");

  const rejected = await toolWith(root, {
    async requestSecret() { return "rejected-secret"; },
    async confirmMutation() { return false; },
  }).execute({ path: ".env", key: "TOKEN" });
  assert.equal(rejected.code, "USER_REJECTED");
  assert.equal(await readFile(target, "utf8"), "TOKEN=old\n");

  const conflicted = await toolWith(root, {
    async requestSecret() { return "new-secret"; },
    async confirmMutation() {
      await writeFile(target, "TOKEN=external\n");
      return true;
    },
  }).execute({ path: ".env", key: "TOKEN" });
  assert.equal(conflicted.code, "EDIT_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "TOKEN=external\n");
  assert.doesNotMatch(JSON.stringify(conflicted), /new-secret/);
});

test("custom abort reason escapes without creating the dotenv file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-abort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = new AbortController();
  const reason = { kind: "cancel-secret" };
  const pending = toolWith(root, {
    async requestSecret() {
      controller.abort(reason);
      return "must-not-persist";
    },
  }).execute({ path: ".env", key: "TOKEN" }, controller.signal);

  await assert.rejects(pending, (error) => error === reason);
  await assert.rejects(readFile(path.join(root, ".env")), /ENOENT/);
});

test("private-key-shaped secrets are stored but remain absent from tool data", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-key-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secret = "-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----";
  let preview: MutationPreview | undefined;
  const result = await toolWith(root, {
    async requestSecret() { return secret; },
    async confirmMutation(value) { preview = value; return true; },
  }).execute({ path: ".env", key: "PRIVATE_KEY" });

  assert.equal(result.ok, true);
  assert.doesNotMatch(JSON.stringify({ result, preview }), /PRIVATE KEY|very-secret/);
  assert.match(await readFile(path.join(root, ".env"), "utf8"), /BEGIN PRIVATE KEY/);
});

test("dotenv encoding round-trips quotes, slashes, tabs, and multiline secrets", async (t) => {
  const values = [
    `a"b`,
    `C:\\tmp\\token`,
    "tab\tvalue",
    "line one\nline two",
    "both'\"quotes",
  ];
  for (const [index, secret] of values.entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `coffee-env-round-${index}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = await toolWith(root, {
      async requestSecret() { return secret; },
    }).execute({ path: ".env", key: "TOKEN" });
    assert.equal(result.ok, true);
    const persisted = await readFile(path.join(root, ".env"), "utf8");
    assert.equal(parseEnv(persisted).TOKEN, secret);
  }
});

test("set_env can update a dotenv file that already contains a PEM value", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-existing-pem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, ".env"),
    "PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----'\nKEEP=old\n",
  );
  const result = await toolWith(root, {
    async requestSecret() { return "new"; },
  }).execute({ path: ".env", key: "KEEP" });

  assert.equal(result.ok, true);
  assert.match(await readFile(path.join(root, ".env"), "utf8"), /BEGIN PRIVATE KEY/);
});

test("set_env preserves export formatting and an inline comment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-format-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env"), 'export TOKEN = "old"  # keep note\n');
  await toolWith(root, {
    async requestSecret() { return "new value"; },
  }).execute({ path: ".env", key: "TOKEN" });

  assert.equal(
    await readFile(path.join(root, ".env"), "utf8"),
    "export TOKEN = 'new value'  # keep note\n",
  );
});

test("interaction paths are terminal-safe and oversized or CR secrets fail early", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-env-safe-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unsafePath = ".env\u001b]0;owned\u0007\u202E";
  const shown: string[] = [];
  const result = await toolWith(root, {
    async requestSecret(request) { shown.push(request.path); return "ok"; },
    async confirmMutation(preview) { shown.push(preview.path); return true; },
  }).execute({ path: unsafePath, key: "TOKEN" });
  assert.equal(result.ok, true);
  assert.ok(shown.every((value) => !/[\u001b\u0007\u202e]/i.test(value)));

  let confirmed = false;
  const tooLarge = await toolWith(root, {
    async requestSecret() { return "x".repeat(1024 * 1024 + 1); },
    async confirmMutation() { confirmed = true; return true; },
  }).execute({ path: ".env.large", key: "TOKEN" });
  assert.equal(tooLarge.code, "LIMIT_EXCEEDED");
  assert.equal(confirmed, false);

  const cr = await toolWith(root, {
    async requestSecret() { return "secret\rvalue"; },
  }).execute({ path: ".env.cr", key: "TOKEN" });
  assert.equal(cr.code, "INVALID_ARGUMENT");
  assert.doesNotMatch(JSON.stringify(cr), /secret/);
});
