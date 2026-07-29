import assert from "node:assert/strict";
import fs from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import {
  HISTORY_SCHEMA_VERSION,
  openHistoryDatabase,
  secureHistoryFiles,
} from "../src/history/sqlite.js";
import { withHistoryPath } from "./history-fixture.js";

interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: 0 | 1;
  readonly dflt_value: string | null;
  readonly pk: 0 | 1;
}

interface ForeignKey {
  readonly table: string;
  readonly from: string;
  readonly to: string;
  readonly on_delete: string;
}

function columns(connection: Database.Database, table: string): TableColumn[] {
  return (connection.pragma(`table_info(${table})`) as TableColumn[]).map(
    ({ name, type, notnull, dflt_value, pk }) => ({
      name,
      type,
      notnull,
      dflt_value,
      pk,
    }),
  );
}

function foreignKeys(
  connection: Database.Database,
  table: string,
): ForeignKey[] {
  return (connection.pragma(`foreign_key_list(${table})`) as ForeignKey[]).map(
    ({ table: targetTable, from, to, on_delete }) => ({
      table: targetTable,
      from,
      to,
      on_delete,
    }),
  );
}

function schemaSnapshot(connection: Database.Database): unknown[] {
  return connection
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
        "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function seedV1Schema(connection: Database.Database): void {
  connection.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE app_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (session_id, sequence)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      tool_call_id TEXT,
      tool_calls_json TEXT,
      reasoning_json TEXT,
      UNIQUE (turn_id, sequence)
    );
    CREATE TABLE session_summaries (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      through_turn_sequence INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function escapedPath(databasePath: string): RegExp {
  return new RegExp(databasePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

test("creates the exact schema v2 and singleton metadata row", async () => {
  await withHistoryPath(async (databasePath) => {
    const connection = openHistoryDatabase(databasePath);
    try {
      assert.equal(
        connection.pragma("user_version", { simple: true }),
        HISTORY_SCHEMA_VERSION,
      );

      const tables = connection
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      assert.deepEqual(tables, [
        "app_metadata",
        "messages",
        "session_summaries",
        "sessions",
        "task_plans",
        "task_steps",
        "turns",
      ]);

      assert.deepEqual(columns(connection, "sessions"), [
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        {
          name: "provider_id",
          type: "TEXT",
          notnull: 1,
          dflt_value: null,
          pk: 0,
        },
        {
          name: "model_id",
          type: "TEXT",
          notnull: 1,
          dflt_value: null,
          pk: 0,
        },
        {
          name: "revision",
          type: "INTEGER",
          notnull: 1,
          dflt_value: "1",
          pk: 0,
        },
        {
          name: "created_at",
          type: "TEXT",
          notnull: 1,
          dflt_value: null,
          pk: 0,
        },
        {
          name: "updated_at",
          type: "TEXT",
          notnull: 1,
          dflt_value: null,
          pk: 0,
        },
      ]);
      assert.deepEqual(
        columns(connection, "app_metadata").map((column) => column.name),
        ["singleton", "active_session_id"],
      );
      assert.deepEqual(
        columns(connection, "turns").map((column) => column.name),
        ["id", "session_id", "sequence", "created_at"],
      );
      assert.deepEqual(
        columns(connection, "messages").map((column) => column.name),
        [
          "id",
          "turn_id",
          "sequence",
          "role",
          "content",
          "tool_call_id",
          "tool_calls_json",
          "reasoning_json",
        ],
      );
      assert.deepEqual(
        columns(connection, "session_summaries").map(
          (column) => column.name,
        ),
        [
          "session_id",
          "through_turn_sequence",
          "content",
          "source_revision",
          "created_at",
          "updated_at",
        ],
      );
      assert.deepEqual(columns(connection, "task_plans"), [
        { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
        { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "goal", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { name: "created_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "updated_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      ]);
      assert.deepEqual(columns(connection, "task_steps"), [
        { name: "plan_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
        { name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
        { name: "position", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "success_criteria", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "depends_on_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
        { name: "retry_count", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
        { name: "result", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        { name: "block_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      ]);

      assert.deepEqual(
        connection.prepare("SELECT * FROM app_metadata").all(),
        [{ singleton: 1, active_session_id: null }],
      );

      assert.deepEqual(foreignKeys(connection, "app_metadata"), [
        {
          table: "sessions",
          from: "active_session_id",
          to: "id",
          on_delete: "SET NULL",
        },
      ]);
      assert.deepEqual(foreignKeys(connection, "turns"), [
        {
          table: "sessions",
          from: "session_id",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);
      assert.deepEqual(foreignKeys(connection, "messages"), [
        {
          table: "turns",
          from: "turn_id",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);
      assert.deepEqual(foreignKeys(connection, "session_summaries"), [
        {
          table: "sessions",
          from: "session_id",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);
      assert.deepEqual(foreignKeys(connection, "task_plans"), [
        {
          table: "sessions",
          from: "session_id",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);
      assert.deepEqual(foreignKeys(connection, "task_steps"), [
        {
          table: "task_plans",
          from: "plan_id",
          to: "id",
          on_delete: "CASCADE",
        },
      ]);

      const creationOrder = connection
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY rowid",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      assert.ok(
        creationOrder.indexOf("sessions") <
          creationOrder.indexOf("app_metadata"),
      );

      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO app_metadata(singleton, active_session_id) " +
                "VALUES (2, NULL)",
            )
            .run(),
        /CHECK constraint failed/,
      );

      connection
        .prepare(
          "INSERT INTO sessions(" +
            "id, title, provider_id, model_id, created_at, updated_at" +
            ") VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session-1", "title", "provider", "model", "now", "now");
      assert.equal(
        connection
          .prepare("SELECT revision FROM sessions WHERE id = ?")
          .pluck()
          .get("session-1"),
        1,
      );
      connection
        .prepare(
          "INSERT INTO turns(id, session_id, sequence, created_at) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run("turn-1", "session-1", 1, "now");
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO turns(id, session_id, sequence, created_at) " +
                "VALUES (?, ?, ?, ?)",
            )
            .run("turn-2", "session-1", 1, "now"),
        /UNIQUE constraint failed/,
      );
      connection
        .prepare(
          "INSERT INTO task_plans(" +
            "id, session_id, goal, status, revision, created_at, updated_at" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("plan-1", "session-1", "goal", "active", 1, "now", "now");
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO task_plans(" +
                "id, session_id, goal, status, revision, created_at, updated_at" +
                ") VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run("plan-2", "session-1", "goal", "active", 1, "now", "now"),
        /UNIQUE constraint failed/,
      );
      connection
        .prepare(
          "INSERT INTO sessions(" +
            "id, title, provider_id, model_id, created_at, updated_at" +
            ") VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session-2", "title", "provider", "model", "now", "now");
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO task_plans(" +
                "id, session_id, goal, status, revision, created_at, updated_at" +
                ") VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run("plan-2", "session-2", "goal", "unknown", 1, "now", "now"),
        /CHECK constraint failed/,
      );
      connection
        .prepare(
          "INSERT INTO task_steps(" +
            "plan_id, id, position, title, success_criteria, status, " +
            "depends_on_json, retry_count" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("plan-1", "step-1", 1, "title", "criteria", "pending", "[]", 0);
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO task_steps(" +
                "plan_id, id, position, title, success_criteria, status, " +
                "depends_on_json, retry_count" +
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run("plan-1", "step-2", 1, "title", "criteria", "pending", "[]", 0),
        /UNIQUE constraint failed/,
      );
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO task_steps(" +
                "plan_id, id, position, title, success_criteria, status, " +
                "depends_on_json, retry_count" +
                ") VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run("plan-1", "step-2", 2, "title", "criteria", "invalid", "[]", 0),
        /CHECK constraint failed/,
      );
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO messages(" +
                "id, turn_id, sequence, role, content" +
                ") VALUES (?, ?, ?, ?, ?)",
            )
            .run("message-1", "turn-1", 1, "system", "no"),
        /CHECK constraint failed/,
      );
      connection
        .prepare(
          "INSERT INTO messages(id, turn_id, sequence, role, content) " +
            "VALUES (?, ?, ?, ?, ?)",
        )
        .run("message-1", "turn-1", 1, "user", "hello");
      assert.throws(
        () =>
          connection
            .prepare(
              "INSERT INTO messages(id, turn_id, sequence, role, content) " +
                "VALUES (?, ?, ?, ?, ?)",
            )
            .run("message-2", "turn-1", 1, "assistant", "hello"),
        /UNIQUE constraint failed/,
      );
      connection.prepare("DELETE FROM sessions WHERE id = ?").run("session-1");
      assert.equal(
        connection.prepare("SELECT COUNT(*) FROM task_plans").pluck().get(),
        0,
      );
      assert.equal(
        connection.prepare("SELECT COUNT(*) FROM task_steps").pluck().get(),
        0,
      );
    } finally {
      connection.close();
    }
  });
});

test("configures all required PRAGMAs", async () => {
  await withHistoryPath(async (databasePath) => {
    const connection = openHistoryDatabase(databasePath);
    try {
      assert.equal(
        connection.pragma("journal_mode", { simple: true }),
        "wal",
      );
      assert.equal(
        connection.pragma("foreign_keys", { simple: true }),
        1,
      );
      assert.equal(
        connection.pragma("busy_timeout", { simple: true }),
        5_000,
      );
      assert.equal(
        connection.pragma("synchronous", { simple: true }),
        1,
      );
      assert.equal(
        connection.pragma("quick_check(1)", { simple: true }),
        "ok",
      );
    } finally {
      connection.close();
    }
  });
});

test("migrates a populated v1 database to v2 without changing legacy rows", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    seedV1Schema(seed);
    seed
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("session-1", "title", "provider", "model", 7, "created", "updated");
    seed
      .prepare("INSERT INTO app_metadata VALUES (?, ?)")
      .run(1, "session-1");
    seed
      .prepare("INSERT INTO turns VALUES (?, ?, ?, ?)")
      .run("turn-1", "session-1", 3, "turn-created");
    seed
      .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("message-1", "turn-1", 2, "tool", "content", "call", "calls", "reasoning");
    seed
      .prepare("INSERT INTO session_summaries VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", 3, "summary", 7, "summary-created", "summary-updated");
    seed.pragma("user_version = 1");
    const legacyRows = [
      "sessions",
      "turns",
      "messages",
      "session_summaries",
      "app_metadata",
    ].map((table) => ({ table, rows: seed.prepare(`SELECT * FROM ${table}`).all() }));
    seed.close();

    const connection = openHistoryDatabase(databasePath);
    try {
      assert.equal(connection.pragma("user_version", { simple: true }), 2);
      assert.deepEqual(
        legacyRows.map(({ table }) => ({
          table,
          rows: connection.prepare(`SELECT * FROM ${table}`).all(),
        })),
        legacyRows,
      );
      assert.deepEqual(connection.prepare("SELECT * FROM task_plans").all(), []);
      assert.deepEqual(connection.prepare("SELECT * FROM task_steps").all(), []);
    } finally {
      connection.close();
    }
  });
});

test("rolls back a v1 to v2 migration when task step creation conflicts", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    seedV1Schema(seed);
    seed
      .prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("session-1", "title", "provider", "model", 1, "created", "updated");
    seed.prepare("INSERT INTO app_metadata VALUES (?, ?)").run(1, "session-1");
    seed
      .prepare("INSERT INTO turns VALUES (?, ?, ?, ?)")
      .run("turn-1", "session-1", 1, "turn-created");
    seed
      .prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("message-1", "turn-1", 1, "assistant", "content", null, null, null);
    seed
      .prepare("INSERT INTO session_summaries VALUES (?, ?, ?, ?, ?, ?)")
      .run("session-1", 1, "summary", 1, "summary-created", "summary-updated");
    seed.exec("CREATE TABLE task_steps(marker TEXT NOT NULL)");
    seed.prepare("INSERT INTO task_steps VALUES (?)").run("keep me");
    seed.pragma("user_version = 1");
    const beforeSchema = schemaSnapshot(seed);
    const legacyRows = [
      "sessions",
      "turns",
      "messages",
      "session_summaries",
      "app_metadata",
    ].map((table) => ({ table, rows: seed.prepare(`SELECT * FROM ${table}`).all() }));
    const taskStepRows = seed.prepare("SELECT * FROM task_steps").all();
    seed.close();

    assert.throws(
      () => openHistoryDatabase(databasePath),
      (error: unknown) => {
        assert.match(String(error), /无法打开历史数据库/);
        assert.match(String(error), /task_steps/i);
        assert.match(String(error), escapedPath(databasePath));
        return true;
      },
    );

    const after = new Database(databasePath);
    try {
      assert.equal(after.pragma("user_version", { simple: true }), 1);
      assert.deepEqual(schemaSnapshot(after), beforeSchema);
      assert.deepEqual(
        legacyRows.map(({ table }) => ({
          table,
          rows: after.prepare(`SELECT * FROM ${table}`).all(),
        })),
        legacyRows,
      );
      assert.deepEqual(
        after.prepare("SELECT * FROM task_steps").all(),
        taskStepRows,
      );
      assert.deepEqual(
        after
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'task_plans'",
          )
          .all(),
        [],
      );
    } finally {
      after.close();
    }
  });
});

test("creates a private directory and main database file", async () => {
  await withHistoryPath(async (_fixturePath, home) => {
    const databasePath = path.join(
      home,
      ".coffee history",
      "history with spaces.sqlite",
    );
    const connection = openHistoryDatabase(databasePath);
    try {
      assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, 0o700);
      assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    } finally {
      connection.close();
    }
  });
});

test("tightens pre-existing broad directory and database permissions", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true, mode: 0o777 });
    const seed = new Database(databasePath);
    seed.close();
    await chmod(path.dirname(databasePath), 0o777);
    await chmod(databasePath, 0o666);

    const connection = openHistoryDatabase(databasePath);
    try {
      assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, 0o700);
      assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    } finally {
      connection.close();
    }
  });
});

test("closes and safely wraps a failure after the database opens", async () => {
  await withHistoryPath(async (databasePath) => {
    const initialUmask = process.umask();
    const originalChmodSync = fs.chmodSync;
    const originalClose = Database.prototype.close;
    let closeCalls = 0;

    fs.chmodSync = ((filePath, mode) => {
      if (path.resolve(String(filePath)) === databasePath) {
        throw new Error("post-open chmod fixture failure");
      }
      originalChmodSync(filePath, mode);
    }) as typeof fs.chmodSync;
    Database.prototype.close = function closeWithCount(): Database.Database {
      closeCalls += 1;
      return originalClose.call(this);
    };
    syncBuiltinESMExports();

    try {
      assert.throws(
        () => openHistoryDatabase(databasePath),
        (error: unknown) => {
          assert.match(String(error), /无法打开历史数据库/);
          assert.match(String(error), /post-open chmod fixture failure/);
          assert.match(String(error), escapedPath(databasePath));
          return true;
        },
      );
      assert.equal(closeCalls, 1);
      assert.equal(process.umask(), initialUmask);
    } finally {
      fs.chmodSync = originalChmodSync;
      Database.prototype.close = originalClose;
      syncBuiltinESMExports();
    }
  });
});

test("refuses a future schema without changing its bytes or schema", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    try {
      assert.equal(seed.pragma("journal_mode = WAL", { simple: true }), "wal");
      seed.exec("CREATE TABLE future_data(value TEXT)");
      seed.prepare("INSERT INTO future_data(value) VALUES (?)").run("keep me");
      seed.pragma("user_version = 99");
      const beforeSchema = schemaSnapshot(seed);
      const beforeBytes = await readFile(databasePath);
      const beforeWal = await readFile(`${databasePath}-wal`);
      const beforeWalStat = await stat(`${databasePath}-wal`);

      assert.throws(
        () => openHistoryDatabase(databasePath),
        (error: unknown) => {
          assert.match(String(error), /版本 99.*仅支持.*2/);
          assert.match(String(error), escapedPath(databasePath));
          return true;
        },
      );

      assert.deepEqual(await readFile(databasePath), beforeBytes);
      assert.deepEqual(await readFile(`${databasePath}-wal`), beforeWal);
      assert.equal((await stat(`${databasePath}-wal`)).ino, beforeWalStat.ino);

      const after = new Database(databasePath, { readonly: true });
      try {
        assert.deepEqual(schemaSnapshot(after), beforeSchema);
        assert.equal(after.pragma("user_version", { simple: true }), 99);
      } finally {
        after.close();
      }
    } finally {
      seed.close();
    }
  });
});

test("refuses corrupt bytes without changing them", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const corruptBytes = Buffer.from("not sqlite\0coffee", "utf8");
    await writeFile(databasePath, corruptBytes);

    assert.throws(
      () => openHistoryDatabase(databasePath),
      (error: unknown) => {
        assert.match(String(error), /无法打开历史数据库/);
        assert.match(String(error), escapedPath(databasePath));
        return true;
      },
    );
    assert.deepEqual(await readFile(databasePath), corruptBytes);
  });
});

test("checks a readable-header database before WAL can modify corrupt pages", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    seed.exec("CREATE TABLE payloads(value TEXT NOT NULL)");
    const insert = seed.prepare("INSERT INTO payloads(value) VALUES (?)");
    seed.transaction(() => {
      for (let index = 0; index < 100; index += 1) {
        insert.run(`${index}:${"x".repeat(1_000)}`);
      }
    })();
    seed.pragma(`user_version = ${HISTORY_SCHEMA_VERSION}`);
    const pageSize = seed.pragma("page_size", { simple: true }) as number;
    assert.ok(
      (seed.pragma("page_count", { simple: true }) as number) > 2,
    );
    seed.close();

    const corruptBytes = await readFile(databasePath);
    corruptBytes.fill(0x7f, pageSize, pageSize + 32);
    await writeFile(databasePath, corruptBytes);
    const beforeBytes = await readFile(databasePath);

    assert.throws(
      () => openHistoryDatabase(databasePath),
      (error: unknown) => {
        assert.match(String(error), /无法打开历史数据库|完整性检查失败/);
        assert.match(String(error), escapedPath(databasePath));
        return true;
      },
    );
    assert.deepEqual(await readFile(databasePath), beforeBytes);
  });
});

test("refuses a version-zero foreign database without changing its table", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    seed.exec("CREATE TABLE foreign_records(id INTEGER PRIMARY KEY, value TEXT)");
    seed.prepare("INSERT INTO foreign_records(value) VALUES (?)").run("keep me");
    const beforeSchema = schemaSnapshot(seed);
    seed.close();
    const beforeBytes = await readFile(databasePath);

    assert.throws(
      () => openHistoryDatabase(databasePath),
      (error: unknown) => {
        assert.match(String(error), /user_version.*0.*已有用户表|外来数据库/);
        assert.match(String(error), escapedPath(databasePath));
        return true;
      },
    );

    assert.deepEqual(await readFile(databasePath), beforeBytes);
    const after = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(schemaSnapshot(after), beforeSchema);
      assert.deepEqual(after.prepare("SELECT * FROM foreign_records").all(), [
        { id: 1, value: "keep me" },
      ]);
      assert.equal(after.pragma("user_version", { simple: true }), 0);
    } finally {
      after.close();
    }
  });
});

test("refuses a version-zero database containing only a view", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    try {
      assert.equal(seed.pragma("journal_mode = WAL", { simple: true }), "wal");
      seed.exec("CREATE VIEW foreign_view AS SELECT 1 AS value");
      const beforeSchema = schemaSnapshot(seed);
      const beforeWal = await readFile(`${databasePath}-wal`);
      const beforeWalStat = await stat(`${databasePath}-wal`);

      assert.throws(
        () => openHistoryDatabase(databasePath),
        (error: unknown) => {
          assert.match(String(error), /user_version.*0.*用户.*view|外来数据库/i);
          assert.match(String(error), escapedPath(databasePath));
          return true;
        },
      );

      assert.deepEqual(schemaSnapshot(seed), beforeSchema);
      assert.deepEqual(await readFile(`${databasePath}-wal`), beforeWal);
      assert.equal((await stat(`${databasePath}-wal`)).ino, beforeWalStat.ino);
    } finally {
      seed.close();
    }
  });
});

test("does not mistake a sqliteX-prefixed user view for SQLite internals", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    const seed = new Database(databasePath);
    seed.exec("CREATE VIEW sqliteXforeign AS SELECT 1 AS value");
    const beforeSchema = schemaSnapshot(seed);
    seed.close();
    const beforeBytes = await readFile(databasePath);

    assert.throws(
      () => openHistoryDatabase(databasePath),
      (error: unknown) => {
        assert.match(String(error), /schema 对象.*view:sqliteXforeign/i);
        assert.match(String(error), escapedPath(databasePath));
        return true;
      },
    );

    assert.deepEqual(await readFile(databasePath), beforeBytes);
    const after = new Database(databasePath, { readonly: true });
    try {
      assert.deepEqual(schemaSnapshot(after), beforeSchema);
      assert.equal(after.pragma("user_version", { simple: true }), 0);
    } finally {
      after.close();
    }
  });
});

test("secureHistoryFiles tightens real main and sidecar files", async () => {
  await withHistoryPath(async (databasePath) => {
    const connection = openHistoryDatabase(databasePath);
    try {
      connection
        .prepare(
          "INSERT INTO sessions(" +
            "id, title, provider_id, model_id, created_at, updated_at" +
            ") VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("session-sidecar", "title", "provider", "model", "now", "now");

      for (const filePath of [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        await chmod(filePath, 0o666);
      }

      secureHistoryFiles(databasePath);

      for (const filePath of [
        databasePath,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
      ]) {
        assert.equal((await stat(filePath)).mode & 0o777, 0o600);
      }
    } finally {
      connection.close();
    }
  });
});

test("restores the process umask after successful and failed opens", async () => {
  await withHistoryPath(async (databasePath) => {
    const initialUmask = process.umask();
    const connection = openHistoryDatabase(databasePath);
    connection.close();
    assert.equal(process.umask(), initialUmask);

    const seed = new Database(databasePath);
    seed.pragma("user_version = 99");
    seed.close();
    assert.throws(() => openHistoryDatabase(databasePath));
    assert.equal(process.umask(), initialUmask);
  });
});
