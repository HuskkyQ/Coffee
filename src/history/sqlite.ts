import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export const HISTORY_SCHEMA_VERSION = 2;
export const DEFAULT_HISTORY_PATH = path.join(
  homedir(),
  ".coffee",
  "history.sqlite",
);

const SCHEMA_V1 = `
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
INSERT INTO app_metadata(singleton, active_session_id) VALUES (1, NULL);
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
`;

const SCHEMA_V2 = `
CREATE TABLE task_plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','blocked','completed','cancelled')),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_steps (
  plan_id TEXT NOT NULL REFERENCES task_plans(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  success_criteria TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','blocked','completed','failed','superseded')),
  depends_on_json TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  result TEXT,
  block_reason TEXT,
  PRIMARY KEY(plan_id,id),
  UNIQUE(plan_id,position)
);
`;

function secureMode(filePath: string): void {
  if (existsSync(filePath)) chmodSync(filePath, 0o600);
}

export function secureHistoryFiles(databasePath: string): void {
  secureMode(databasePath);
  secureMode(`${databasePath}-wal`);
  secureMode(`${databasePath}-shm`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UserSchemaObject {
  readonly type: string;
  readonly name: string;
}

function userSchemaObjects(
  database: Database.Database,
): UserSchemaObject[] {
  return database
    .prepare(
      "SELECT type, name FROM sqlite_schema " +
        "WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all() as UserSchemaObject[];
}

function closeBestEffort(database: Database.Database | undefined): string {
  if (!database) return "";
  try {
    database.close();
    return "";
  } catch (error) {
    return `；连接关闭时也遇到错误：${describeError(error)}`;
  }
}

export function openHistoryDatabase(
  databasePath = DEFAULT_HISTORY_PATH,
): Database.Database {
  const absoluteDatabasePath = path.resolve(databasePath);
  const directory = path.dirname(absoluteDatabasePath);
  const previousUmask = process.umask(0o077);
  let database: Database.Database | undefined;

  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    secureHistoryFiles(absoluteDatabasePath);
    database = new Database(absoluteDatabasePath);
    secureHistoryFiles(absoluteDatabasePath);

    const version = database.pragma("user_version", {
      simple: true,
    }) as number;
    if (version > HISTORY_SCHEMA_VERSION) {
      throw new Error(
        `数据库版本 ${version} 高于当前 Coffee 仅支持的版本 ` +
          `${HISTORY_SCHEMA_VERSION}；请升级 Coffee，或改用兼容的数据库副本`,
      );
    }

    if (version === 0) {
      const existingObjects = userSchemaObjects(database);
      if (existingObjects.length > 0) {
        throw new Error(
          "user_version 为 0，但已有用户 schema 对象：" +
            existingObjects
              .map(({ type, name }) => `${type}:${name}`)
              .join("、") +
            "；为避免覆盖外来数据库，Coffee 已拒绝初始化，请改用空数据库路径" +
            "或先备份迁移",
        );
      }
    }

    const quickCheck = database.pragma("quick_check(1)", {
      simple: true,
    });
    if (quickCheck !== "ok") {
      throw new Error(
        `完整性检查失败：${String(quickCheck)}；请先备份并使用 SQLite 检查或修复`,
      );
    }

    if (version === 0 || version === 1) {
      database.transaction(() => {
        let nextVersion = version;
        if (nextVersion === 0) {
          database!.exec(SCHEMA_V1);
          database!.pragma("user_version = 1");
          nextVersion = 1;
        }
        if (nextVersion === 1) {
          database!.exec(SCHEMA_V2);
          database!.pragma("user_version = 2");
        }
      })();
    }

    const journalMode = database.pragma("journal_mode = WAL", {
      simple: true,
    });
    if (journalMode !== "wal") {
      throw new Error(
        `无法启用 WAL，SQLite 返回 ${String(journalMode)}；请检查文件系统是否支持 WAL`,
      );
    }

    database.pragma("foreign_keys = ON");
    if (database.pragma("foreign_keys", { simple: true }) !== 1) {
      throw new Error("无法启用 foreign_keys；请检查 SQLite 配置");
    }

    database.pragma("busy_timeout = 5000");
    if (database.pragma("busy_timeout", { simple: true }) !== 5_000) {
      throw new Error("无法设置 busy_timeout=5000；请检查 SQLite 配置");
    }

    database.pragma("synchronous = NORMAL");
    if (database.pragma("synchronous", { simple: true }) !== 1) {
      throw new Error("无法设置 synchronous=NORMAL；请检查 SQLite 配置");
    }

    secureHistoryFiles(absoluteDatabasePath);
    return database;
  } catch (error) {
    const closeError = closeBestEffort(database);
    throw new Error(
      `无法打开历史数据库 ${absoluteDatabasePath}：${describeError(error)}` +
        `${closeError}。请检查路径、权限、数据库版本和完整性；` +
        "Coffee 不会覆盖、删除或改名原数据库。",
      { cause: error },
    );
  } finally {
    process.umask(previousUmask);
  }
}
