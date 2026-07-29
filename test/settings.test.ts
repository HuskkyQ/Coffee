import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadHistoryPreferences,
  loadModelPreference,
  loadThemePreference,
  saveModelPreference,
  saveThemePreference,
} from "../src/settings.js";
import { DEFAULT_HISTORY_PREFERENCES } from "../src/history/types.js";
import {
  holdPersistenceLock,
  startPersistenceWorker,
  stopPersistenceWorkers,
} from "./persistence-worker-harness.js";

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

async function withTempSettings(
  run: (settingsPath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coffee-settings-"));
  try {
    await run(path.join(directory, "coffee.settings.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads latte by default and loads a registered theme", async () => {
  await withTempSettings(async (settingsPath) => {
    assert.deepEqual(await loadThemePreference(settingsPath), {
      themeId: "latte",
    });

    await writeFile(
      settingsPath,
      JSON.stringify({ "coffee-preferences": { theme: "coast" } }),
    );

    assert.deepEqual(await loadThemePreference(settingsPath), {
      themeId: "coast",
    });
  });
});

test("warns and uses latte for invalid theme preferences", async () => {
  const invalidSettings = [
    { "coffee-preferences": "latte" },
    { "coffee-preferences": { theme: "neon" } },
    { "coffee-preferences": { theme: 42 } },
  ];

  for (const settings of invalidSettings) {
    await withTempSettings(async (settingsPath) => {
      await writeFile(settingsPath, JSON.stringify(settings));

      const result = await loadThemePreference(settingsPath);

      assert.equal(result.themeId, "latte");
      assert.match(result.warning ?? "", /coffee-preferences/);
    });
  }
});

test("warns for damaged JSON and refuses to overwrite it with a theme", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "not-json");

    const loaded = await loadThemePreference(settingsPath);

    assert.equal(loaded.themeId, "latte");
    assert.match(loaded.warning ?? "", /JSON/);
    await assert.rejects(saveThemePreference(settingsPath, "camp"), /JSON/);
    assert.equal(await readFile(settingsPath, "utf8"), "not-json");
  });
});

test("saves a theme atomically while preserving unrelated and legacy keys", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        keep: true,
        "coffee-preferences": { animation: "latte", volume: 2 },
      }),
    );

    await saveThemePreference(settingsPath, "coast");

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      keep: true,
      "coffee-preferences": {
        animation: "latte",
        volume: 2,
        theme: "coast",
      },
    });
    assert.match(await readFile(settingsPath, "utf8"), /\n$/u);
    assert.deepEqual(await readdir(path.dirname(settingsPath)), [
      "coffee.settings.json",
    ]);
  });
});

test("replaces a non-object preference section when saving a theme", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({ keep: true, "coffee-preferences": "invalid" }),
    );

    await saveThemePreference(settingsPath, "camp");

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      keep: true,
      "coffee-preferences": { theme: "camp" },
    });
  });
});

test("serializes concurrent theme and model preference saves", async () => {
  await withTempSettings(async (settingsPath) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await writeFile(settingsPath, "{}\n");

      await Promise.all([
        saveThemePreference(settingsPath, "coast"),
        saveModelPreference(settingsPath, {
          provider: "openai",
          model: "gpt-5",
        }),
      ]);

      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        "coffee-preferences": { theme: "coast" },
        "model-preferences": { provider: "openai", model: "gpt-5" },
      });
    }
  });
});

test("returns no model preference when settings or the section is missing", async () => {
  await withTempSettings(async (settingsPath) => {
    assert.deepEqual(await loadModelPreference(settingsPath), {});

    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));

    assert.deepEqual(await loadModelPreference(settingsPath), {});
  });
});

test("loads and trims a valid model preference", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        "model-preferences": {
          provider: "  openai  ",
          model: "  gpt-5  ",
        },
      }),
    );

    assert.deepEqual(await loadModelPreference(settingsPath), {
      preference: { provider: "openai", model: "gpt-5" },
    });
  });
});

test("warns for invalid model preference sections", async () => {
  const invalidSections = [
    "openai/gpt-5",
    { model: "gpt-5" },
    { provider: "openai" },
    { provider: 42, model: "gpt-5" },
    { provider: "openai", model: false },
    { provider: "   ", model: "gpt-5" },
    { provider: "openai", model: "   " },
  ];

  for (const section of invalidSections) {
    await withTempSettings(async (settingsPath) => {
      await writeFile(
        settingsPath,
        JSON.stringify({ "model-preferences": section }),
      );

      const result = await loadModelPreference(settingsPath);

      assert.equal(result.preference, undefined);
      assert.match(result.warning ?? "", /model-preferences/);
    });
  }
});

test("warns for damaged or non-object settings when loading a model preference", async () => {
  for (const text of ["not-json", "[]"]) {
    await withTempSettings(async (settingsPath) => {
      await writeFile(settingsPath, text);

      const result = await loadModelPreference(settingsPath);

      assert.equal(result.preference, undefined);
      assert.ok(result.warning);
    });
  }
});

test("history preferences use the shared defaults when the file or section is missing", async () => {
  await withTempSettings(async (settingsPath) => {
    const missingFile = await loadHistoryPreferences(settingsPath);

    assert.strictEqual(
      missingFile.preferences,
      DEFAULT_HISTORY_PREFERENCES,
    );
    assert.equal(missingFile.warning, undefined);

    await writeFile(settingsPath, JSON.stringify({ theme: "dark" }));

    const missingSection = await loadHistoryPreferences(settingsPath);

    assert.strictEqual(
      missingSection.preferences,
      DEFAULT_HISTORY_PREFERENCES,
    );
    assert.equal(missingSection.warning, undefined);
  });
});

test("history preferences load valid kebab-case values", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        "history-preferences": {
          "compression-threshold-chars": 20_000,
          "max-context-chars": 30_000,
          "summary-target-chars": 4_000,
        },
      }),
    );

    assert.deepEqual(await loadHistoryPreferences(settingsPath), {
      preferences: {
        compressionThresholdChars: 20_000,
        maxContextChars: 30_000,
        summaryTargetChars: 4_000,
      },
    });
  });
});

test("history preferences reject an invalid section as a whole", async () => {
  const invalidSections: readonly unknown[] = [
    "30000/40000/5000",
    {
      "compression-threshold-chars": 30_000,
      "max-context-chars": 40_000,
    },
    {
      "compression-threshold-chars": 30_000.5,
      "max-context-chars": 40_000,
      "summary-target-chars": 5_000,
    },
    {
      "compression-threshold-chars": -30_000,
      "max-context-chars": 40_000,
      "summary-target-chars": 5_000,
    },
    {
      "compression-threshold-chars": 40_000,
      "max-context-chars": 40_000,
      "summary-target-chars": 5_000,
    },
    {
      "compression-threshold-chars": 30_000,
      "max-context-chars": 40_000,
      "summary-target-chars": 30_000,
    },
  ];

  for (const section of invalidSections) {
    await withTempSettings(async (settingsPath) => {
      await writeFile(
        settingsPath,
        JSON.stringify({ "history-preferences": section }),
      );

      const result = await loadHistoryPreferences(settingsPath);

      assert.strictEqual(result.preferences, DEFAULT_HISTORY_PREFERENCES);
      assert.match(result.warning ?? "", /history-preferences/);
    });
  }
});

test("history preferences preserve parse warnings for damaged or non-object settings", async () => {
  const invalidSettings = [
    ["not-json", /不是有效的 JSON/],
    ["[]", /根节点必须是 JSON 对象/],
  ] as const;

  for (const [text, warningPattern] of invalidSettings) {
    await withTempSettings(async (settingsPath) => {
      await writeFile(settingsPath, text);

      const result = await loadHistoryPreferences(settingsPath);

      assert.strictEqual(result.preferences, DEFAULT_HISTORY_PREFERENCES);
      assert.match(result.warning ?? "", warningPattern);
    });
  }
});

test("creates a formatted settings file when saving the first model preference", async () => {
  await withTempSettings(async (settingsPath) => {
    await saveModelPreference(settingsPath, {
      provider: "openai",
      model: "gpt-5",
    });

    assert.equal(
      await readFile(settingsPath, "utf8"),
      `${JSON.stringify(
        {
          "model-preferences": { provider: "openai", model: "gpt-5" },
        },
        null,
        2,
      )}\n`,
    );
  });
});

test("updates the model preference while preserving other settings", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        theme: "dark",
        "coffee-preferences": { animation: "latte", volume: 2 },
        "model-preferences": {
          provider: "deepseek",
          model: "deepseek-chat",
          temperature: 0.2,
        },
      }),
    );

    await saveModelPreference(settingsPath, {
      provider: "openai",
      model: "gpt-5",
    });

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      theme: "dark",
      "coffee-preferences": { animation: "latte", volume: 2 },
      "model-preferences": {
        provider: "openai",
        model: "gpt-5",
        temperature: 0.2,
      },
    });
  });
});

test("trims a model preference before saving it", async () => {
  await withTempSettings(async (settingsPath) => {
    await saveModelPreference(settingsPath, {
      provider: "  openai  ",
      model: "  gpt-5  ",
    });

    assert.deepEqual(await loadModelPreference(settingsPath), {
      preference: { provider: "openai", model: "gpt-5" },
    });
  });
});

test("rejects blank model preferences without writing a settings file", async () => {
  for (const preference of [
    { provider: "   ", model: "gpt-5" },
    { provider: "openai", model: "   " },
  ]) {
    await withTempSettings(async (settingsPath) => {
      await assert.rejects(
        saveModelPreference(settingsPath, preference),
        /provider.*model|model.*provider/,
      );
      await assert.rejects(readFile(settingsPath, "utf8"), /ENOENT/);
    });
  }
});

test("refuses to overwrite damaged JSON when saving a model preference", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "not-json");

    await assert.rejects(
      saveModelPreference(settingsPath, {
        provider: "openai",
        model: "gpt-5",
      }),
      /JSON/,
    );
    assert.equal(await readFile(settingsPath, "utf8"), "not-json");
  });
});

test("allows a settings update after a queued update fails", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "not-json");
    await assert.rejects(
      saveThemePreference(settingsPath, "coast"),
      /JSON/,
    );

    await writeFile(settingsPath, "{}\n");
    await saveModelPreference(settingsPath, {
      provider: "openai",
      model: "gpt-5",
    });

    assert.deepEqual(await loadModelPreference(settingsPath), {
      preference: { provider: "openai", model: "gpt-5" },
    });
  });
});

test("holds the complete theme and model read-modify-write under one lock", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "{}\n");
    const release = await holdPersistenceLock(settingsPath);

    await expectBlockedUntilRelease(
      [
        saveThemePreference(settingsPath, "coast"),
        saveModelPreference(settingsPath, {
          provider: "openai",
          model: "gpt-5",
        }),
      ],
      release,
    );

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
      "coffee-preferences": { theme: "coast" },
      "model-preferences": { provider: "openai", model: "gpt-5" },
    });
    assert.deepEqual(await readdir(path.dirname(settingsPath)), [
      "coffee.settings.json",
    ]);
  });
});

test("serializes theme and model saves from separate Node processes", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(settingsPath, "{}\n");
    const release = await holdPersistenceLock(settingsPath);
    const workers = [
      startPersistenceWorker("settings-save-theme", settingsPath),
      startPersistenceWorker("settings-save-model", settingsPath),
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

      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
        "coffee-preferences": { theme: "coast" },
        "model-preferences": { provider: "openai", model: "gpt-5" },
      });
      assert.deepEqual(await readdir(path.dirname(settingsPath)), [
        "coffee.settings.json",
      ]);
    } finally {
      await release();
      await stopPersistenceWorkers(workers);
    }
  });
});

test("never automatically removes an old lock and recovers after manual removal", async (t) => {
  const cases = [
    { name: "没有 owner 文件", owner: undefined },
    {
      name: "owner PID 已不存在",
      owner: {
        pid: 2_147_483_647,
        createdAt: "2000-01-01T00:00:00.000Z",
        token: "dead-owner",
      },
    },
  ] as const;

  for (const lockCase of cases) {
    await t.test(lockCase.name, async () => {
      await withTempSettings(async (settingsPath) => {
        const lockPath = `${settingsPath}.lock`;
        await mkdir(lockPath, { mode: 0o700 });
        if (lockCase.owner !== undefined) {
          await writeFile(
            path.join(lockPath, "owner.json"),
            JSON.stringify(lockCase.owner),
            { mode: 0o600 },
          );
        }
        const staleTime = new Date(Date.now() - 60_000);
        await utimes(lockPath, staleTime, staleTime);

        await assert.rejects(
          saveThemePreference(settingsPath, "coast"),
          /等待文件锁超时.*确认没有 Coffee 进程后手动删除锁目录/,
        );
        assert.equal((await stat(lockPath)).isDirectory(), true);

        await rm(lockPath, { recursive: true });
        await saveThemePreference(settingsPath, "coast");
        assert.deepEqual(await loadThemePreference(settingsPath), {
          themeId: "coast",
        });
        await assert.rejects(stat(lockPath), { code: "ENOENT" });
      });
    });
  }
});

test("times out with actionable Chinese guidance while an active lock remains", async () => {
  await withTempSettings(async (settingsPath) => {
    const release = await holdPersistenceLock(settingsPath);
    const startedAt = Date.now();
    try {
      await assert.rejects(
        saveThemePreference(settingsPath, "coast"),
        /等待文件锁超时.*稍后重试.*确认没有 Coffee 进程后手动删除锁目录/,
      );
      assert.ok(Date.now() - startedAt < 5_000, "锁等待必须有明确上限");
    } finally {
      await release();
    }
  });
});
