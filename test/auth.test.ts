import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  AUTH_DIRECTORY,
  AUTH_PATH,
  createCredentialStore,
  maskApiKey,
} from "../src/auth.js";
import { CREDENTIALS } from "../src/models/catalog.js";
import type { CredentialDefinition } from "../src/models/types.js";
import {
  holdPersistenceLock,
  startPersistenceWorker,
  stopPersistenceWorkers,
} from "./persistence-worker-harness.js";

async function withTempAuth(
  run: (authPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "coffee-auth-"));
  try {
    await run(join(directory, "nested", "auth.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function authJson(credentials: Record<string, unknown>): string {
  return `${JSON.stringify({ version: 1, credentials }, null, 2)}\n`;
}

const DEEPSEEK = CREDENTIALS[0];

async function expectBlockedUntilRelease(
  operations: readonly Promise<unknown>[],
  release: () => Promise<void>,
  confirmationMs = 250,
): Promise<void> {
  const completion = Promise.all(operations);
  let state: "settled" | "waiting";
  try {
    state = await Promise.race([
      completion.then(() => "settled" as const),
      new Promise<"waiting">((resolve) =>
        setTimeout(() => resolve("waiting"), confirmationMs),
      ),
    ]);
  } finally {
    await release();
  }
  await completion;
  assert.equal(state, "waiting", "写操作应等待已存在的持久化锁");
}

test("uses the documented default auth path", () => {
  assert.equal(AUTH_DIRECTORY, join(homedir(), ".coffee"));
  assert.equal(AUTH_PATH, join(AUTH_DIRECTORY, "auth.json"));
});

test("masks API keys without exposing the complete secret", () => {
  assert.equal(maskApiKey("short"), "•••••");
  assert.equal(maskApiKey("12345678"), "••••••••");

  const key = "sk-1234567890abcd";
  const masked = maskApiKey(key);

  assert.equal(masked, "sk-••••••abcd");
  assert.equal(masked.includes(key), false);
});

test("prefers a saved API key over the environment", async () => {
  await withTempAuth(async (authPath) => {
    const store = createCredentialStore(authPath);
    await store.saveApiKey("deepseek", "saved-key");

    assert.deepEqual(
      await store.resolve(DEEPSEEK, { DEEPSEEK_API_KEY: "environment-key" }),
      { key: "saved-key", source: "auth-file" },
    );
  });
});

test("falls back through environment keys in definition order", async () => {
  await withTempAuth(async (authPath) => {
    const definition: CredentialDefinition = {
      id: "deepseek",
      name: "DeepSeek",
      envKeys: ["FIRST_KEY", "SECOND_KEY", "THIRD_KEY"],
    };

    assert.deepEqual(
      await createCredentialStore(authPath).resolve(definition, {
        FIRST_KEY: "   ",
        SECOND_KEY: "  second-key  ",
        THIRD_KEY: "third-key",
      }),
      { key: "second-key", source: "environment" },
    );
  });
});

test("returns undefined when no saved or environment key is configured", async () => {
  await withTempAuth(async (authPath) => {
    const store = createCredentialStore(authPath);

    assert.equal(await store.getSavedApiKey("deepseek"), undefined);
    assert.deepEqual(await store.getSavedCredentialIds(), []);
    assert.equal(await store.resolve(DEEPSEEK, {}), undefined);
  });
});

test("saves, reads, and deletes keys while preserving other entries", async () => {
  await withTempAuth(async (authPath) => {
    const store = createCredentialStore(authPath);
    await store.saveApiKey("deepseek", "  deepseek-key  ");
    await store.saveApiKey("opencode", "opencode-key");

    assert.equal(await store.getSavedApiKey("deepseek"), "deepseek-key");
    assert.match(await readFile(authPath, "utf8"), /\n$/);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      version: 1,
      credentials: {
        deepseek: { type: "api_key", key: "deepseek-key" },
        opencode: { type: "api_key", key: "opencode-key" },
      },
    });

    assert.equal(await store.deleteApiKey("deepseek"), true);
    assert.equal(await store.getSavedApiKey("deepseek"), undefined);
    assert.equal(await store.getSavedApiKey("opencode"), "opencode-key");

    const beforeMissingDelete = await readFile(authPath, "utf8");
    assert.equal(await store.deleteApiKey("deepseek"), false);
    assert.equal(await readFile(authPath, "utf8"), beforeMissingDelete);
  });
});

test("preserves unknown credential entries when saving", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          metadata: { createdBy: "future-coffee" },
          credentials: {
            deepseek: {
              type: "api_key",
              key: "old-key",
              extra: { scope: "coding" },
            },
            external: { type: "custom", value: 42 },
          },
        },
        null,
        2,
      )}\n`,
    );

    await createCredentialStore(authPath).saveApiKey("deepseek", "new-key");

    const saved = JSON.parse(await readFile(authPath, "utf8"));
    assert.deepEqual(saved.metadata, { createdBy: "future-coffee" });
    assert.deepEqual(saved.credentials.deepseek, {
      type: "api_key",
      key: "new-key",
      extra: { scope: "coding" },
    });
    assert.deepEqual(saved.credentials.external, {
      type: "custom",
      value: 42,
    });
  });
});

test("atomically replaces an existing auth file without temp residue", async () => {
  await withTempAuth(async (authPath) => {
    const store = createCredentialStore(authPath);
    await store.saveApiKey("deepseek", "first-key");
    const originalInode = (await stat(authPath)).ino;

    await store.saveApiKey("deepseek", "replacement-key");

    assert.notEqual((await stat(authPath)).ino, originalInode);
    assert.deepEqual(await readdir(dirname(authPath)), ["auth.json"]);
    assert.equal(await store.getSavedApiKey("deepseek"), "replacement-key");
  });
});

test("does not create a file when deleting a missing key", async () => {
  await withTempAuth(async (authPath) => {
    assert.equal(
      await createCredentialStore(authPath).deleteApiKey("deepseek"),
      false,
    );
    await assert.rejects(stat(authPath), { code: "ENOENT" });
  });
});

test("rejects an empty API key after trimming", async () => {
  await withTempAuth(async (authPath) => {
    await assert.rejects(
      createCredentialStore(authPath).saveApiKey("deepseek", " \t\n "),
      /API Key 不能为空/,
    );
    await assert.rejects(stat(authPath), { code: "ENOENT" });
  });
});

test("rejects malformed JSON without overwriting it", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, "not-json");
    await chmod(dirname(authPath), 0o755);
    await chmod(authPath, 0o644);
    const store = createCredentialStore(authPath);

    await assert.rejects(store.getSavedApiKey("deepseek"), /JSON/);
    assert.equal((await stat(dirname(authPath))).mode & 0o777, 0o700);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    await assert.rejects(store.saveApiKey("deepseek", "new-key"), /JSON/);
    await assert.rejects(store.deleteApiKey("deepseek"), /JSON/);
    assert.equal(await readFile(authPath, "utf8"), "not-json");
  });
});

test("rejects invalid auth file structures with Chinese errors", async (t) => {
  const invalidDocuments: readonly [string, unknown][] = [
    ["数组根结构", []],
    ["错误 version", { version: 2, credentials: {} }],
    ["数组 credentials", { version: 1, credentials: [] }],
  ];

  for (const [name, document] of invalidDocuments) {
    await t.test(name, async () => {
      await withTempAuth(async (authPath) => {
        await mkdir(dirname(authPath), { recursive: true });
        await writeFile(authPath, JSON.stringify(document));

        await assert.rejects(
          createCredentialStore(authPath).getSavedCredentialIds(),
          /凭证文件.*无效/,
        );
      });
    });
  }
});

test("rejects an invalid known credential without overwriting it", async () => {
  await withTempAuth(async (authPath) => {
    const original = authJson({
      deepseek: { type: "api_key", key: "" },
      opencode: { type: "api_key", key: "keep-me" },
    });
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, original);
    const store = createCredentialStore(authPath);

    await assert.rejects(store.getSavedApiKey("deepseek"), /凭证 deepseek.*无效/);
    await assert.rejects(store.saveApiKey("deepseek", "replacement"), /凭证 deepseek.*无效/);
    await assert.rejects(store.deleteApiKey("deepseek"), /凭证 deepseek.*无效/);
    assert.equal(await readFile(authPath, "utf8"), original);
  });
});

test("creates and tightens directory and file permissions", async () => {
  await withTempAuth(async (authPath) => {
    const store = createCredentialStore(authPath);
    await store.saveApiKey("deepseek", "first-key");

    assert.equal((await stat(dirname(authPath))).mode & 0o777, 0o700);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);

    await chmod(dirname(authPath), 0o755);
    await chmod(authPath, 0o644);
    await store.saveApiKey("opencode", "second-key");

    assert.equal((await stat(dirname(authPath))).mode & 0o777, 0o700);
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
  });
});

test("tightens permissions through every read-only store operation", async (t) => {
  const operations = [
    {
      name: "getSavedApiKey",
      run: (authPath: string) =>
        createCredentialStore(authPath).getSavedApiKey("deepseek"),
    },
    {
      name: "getSavedCredentialIds",
      run: (authPath: string) =>
        createCredentialStore(authPath).getSavedCredentialIds(),
    },
    {
      name: "resolve",
      run: (authPath: string) =>
        createCredentialStore(authPath).resolve(DEEPSEEK, {}),
    },
  ] as const;

  for (const operation of operations) {
    await t.test(operation.name, async () => {
      await withTempAuth(async (authPath) => {
        await mkdir(dirname(authPath), { recursive: true });
        await writeFile(
          authPath,
          authJson({ deepseek: { type: "api_key", key: "saved-key" } }),
        );
        await chmod(dirname(authPath), 0o755);
        await chmod(authPath, 0o644);

        await operation.run(authPath);

        assert.equal((await stat(dirname(authPath))).mode & 0o777, 0o700);
        assert.equal((await stat(authPath)).mode & 0o777, 0o600);
      });
    });
  }
});

test("trims a key read from a hand-written auth file", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      authJson({ deepseek: { type: "api_key", key: "  saved-key  " } }),
    );

    assert.equal(
      await createCredentialStore(authPath).getSavedApiKey("deepseek"),
      "saved-key",
    );
  });
});

test("returns saved credential ids in stable catalog order", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      authJson({
        "volcengine-ark": { type: "api_key", key: "ark-key" },
        external: { any: "value" },
        opencode: { type: "api_key", key: "opencode-key" },
        deepseek: { type: "api_key", key: "deepseek-key" },
      }),
    );

    assert.deepEqual(
      await createCredentialStore(authPath).getSavedCredentialIds(),
      ["deepseek", "opencode", "volcengine-ark"],
    );
  });
});

test("serializes save and delete across independent stores without losing either update", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(
      authPath,
      authJson({ opencode: { type: "api_key", key: "remove-me" } }),
    );
    const release = await holdPersistenceLock(authPath);
    const firstStore = createCredentialStore(authPath);
    const secondStore = createCredentialStore(authPath);

    await expectBlockedUntilRelease(
      [
        firstStore.saveApiKey("deepseek", "deepseek-key"),
        secondStore.deleteApiKey("opencode"),
      ],
      release,
    );

    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      version: 1,
      credentials: {
        deepseek: { type: "api_key", key: "deepseek-key" },
      },
    });
    assert.deepEqual(await readdir(dirname(authPath)), ["auth.json"]);
  });
});

test("serializes credential saves from separate Node processes", async () => {
  await withTempAuth(async (authPath) => {
    await mkdir(dirname(authPath), { recursive: true });
    await writeFile(authPath, authJson({}));
    const release = await holdPersistenceLock(authPath);
    const workers = [
      startPersistenceWorker("auth-save-deepseek", authPath),
      startPersistenceWorker("auth-save-opencode", authPath),
    ];
    try {
      await Promise.all(workers.map((worker) => worker.ready));
      for (const worker of workers) {
        worker.start();
      }
      await Promise.all(workers.map((worker) => worker.attempting));
      await Promise.all(workers.map((worker) => worker.started));

      await expectBlockedUntilRelease(
        workers.map((worker) => worker.completion),
        release,
        75,
      );

      assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
        version: 1,
        credentials: {
          deepseek: { type: "api_key", key: "deepseek-key" },
          opencode: { type: "api_key", key: "opencode-key" },
        },
      });
      assert.deepEqual(await readdir(dirname(authPath)), ["auth.json"]);
    } finally {
      await release();
      await stopPersistenceWorkers(workers);
    }
  });
});
