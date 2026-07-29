# Coffee SQLite Conversation History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist Coffee conversations in embedded SQLite, restore and manage sessions from the CLI, and keep model requests within a 30,000/40,000-character rolling-summary budget.

**Architecture:** A synchronous `HistoryStore` owns SQLite and atomic transactions; `SessionManager` owns the active persisted-or-lazy session and optimistic revision; pure context helpers select complete turns and prepare redacted summary material. `Conversation` continues to own model/tool streaming but commits through `SessionManager` only after a valid final reply, while the CLI exposes `/new`, `/sessions`, and `/delete`.

**Tech Stack:** Node.js 22, TypeScript 7, `better-sqlite3`, native Node test runner, existing raw `fetch` model gateway and Inquirer-based CLI.

---

## Scope and repository note

Design source: `docs/superpowers/specs/2026-07-16-sqlite-conversation-history-design.md`.

`/Users/sevan/ai-tasks/pi-agent/coffee` is not a Git repository. Commit steps are omitted because `git commit` would fail. Each task ends with focused verification, and the final task runs the complete test suite and type-check.

This feature is delivered in two testable layers inside one plan:

1. Tasks 1-6 produce durable SQLite sessions and session lifecycle APIs.
2. Tasks 7-11 add context selection, rolling summaries, CLI commands, and end-to-end hardening.

## File map

Create:

- `src/history/types.ts` — persisted message, turn, summary, session, list-row, and budget types.
- `src/history/sqlite.ts` — database path, secure opening, PRAGMAs, schema v1, version checks, and close.
- `src/history/message-codec.ts` — strict message JSON encoding and decoding at the database boundary.
- `src/history/store.ts` — session queries and atomic turn/model/summary/delete transactions.
- `src/history/session-manager.ts` — active/lazy session state, model resolution, revisions, and in-memory snapshots.
- `src/history/context.ts` — stable character cost, complete-turn selection, compression planning, and summary redaction.
- `src/history/summarizer.ts` — same-model hidden summary request and safe final-text collection.
- `src/session-commands.ts` — `/sessions` rendering/selection and `/delete` confirmation parsing.
- `test/history-fixture.ts` — isolated temporary database helper.
- `test/history-sqlite.test.ts` — schema, PRAGMA, permissions, and version/corruption coverage.
- `test/history-message-codec.test.ts` — normalized message round-trip and malformed JSON coverage.
- `test/history-store.test.ts` — atomic persistence, list, cascade, summary, and revision coverage.
- `test/session-manager.test.ts` — restore, lazy session, model, switch, delete, and conflict coverage.
- `test/conversation-context.test.ts` — budget, complete-turn, compression, and redaction coverage.
- `test/session-commands.test.ts` — menu and confirmation parser coverage.

Modify:

- `package.json`, `package-lock.json` — add SQLite runtime and TypeScript definitions.
- `src/settings.ts`, `test/settings.test.ts` — load `history-preferences` with validated defaults.
- `src/agent.ts`, `test/agent.test.ts` — use session turns, context planning, hidden summarization, and post-persistence `done`.
- `src/commands.ts`, `test/commands.test.ts` — register `/new`, `/sessions`, and `/delete`.
- `src/cli.ts`, `test/cli.test.ts` — open/close history, restore sessions, dispatch commands, and preserve session model semantics.
- `README.md` — document database location, lifecycle commands, model restoration, compression, and recovery behavior.

### Task 1: Add the SQLite dependency and durable history domain types

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/history/types.ts`

- [ ] **Step 1: Install the supported SQLite driver and definitions**

Run:

```bash
npm install better-sqlite3@^12.10.0
npm install --save-dev @types/better-sqlite3
```

Expected: `package.json` contains `better-sqlite3` under `dependencies`, `@types/better-sqlite3` under `devDependencies`, and the lockfile resolves both packages without a native build error on Node 22.

- [ ] **Step 2: Add the exact persisted domain types**

Create `src/history/types.ts`:

```ts
import type { ModelMessage, ModelReasoning, ModelToolCall } from "../models/types.js";

export type PersistedMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: readonly ModelToolCall[];
      reasoning?: ModelReasoning;
    }
  | { role: "tool"; toolCallId: string; content: string };

export interface StoredTurn {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly messages: readonly PersistedMessage[];
}

export interface StoredSummary {
  readonly throughTurnSequence: number;
  readonly content: string;
  readonly sourceRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: readonly StoredTurn[];
  readonly summary?: StoredSummary;
}

export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly updatedAt: string;
}

export interface HistoryPreferences {
  readonly compressionThresholdChars: number;
  readonly maxContextChars: number;
  readonly summaryTargetChars: number;
}

export const DEFAULT_HISTORY_PREFERENCES: HistoryPreferences = Object.freeze({
  compressionThresholdChars: 30_000,
  maxContextChars: 40_000,
  summaryTargetChars: 5_000,
});

export function clonePersistedMessages(
  messages: readonly PersistedMessage[],
): PersistedMessage[] {
  return structuredClone(messages);
}

export function toModelMessages(
  messages: readonly PersistedMessage[],
): ModelMessage[] {
  return structuredClone(messages);
}
```

- [ ] **Step 3: Verify dependency loading and type compatibility**

Run:

```bash
node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); console.log(db.prepare('select 1 as value').get().value); db.close()"
npm run check
```

Expected: the first command prints `1` without an experimental warning and TypeScript exits 0.

### Task 2: Load and validate context budget settings

**Files:**

- Modify: `src/settings.ts`
- Modify: `test/settings.test.ts`

- [ ] **Step 1: Write failing default, valid, and invalid preference tests**

Add imports for `DEFAULT_HISTORY_PREFERENCES` and `loadHistoryPreferences`, then add these cases to `test/settings.test.ts`:

```ts
test("loads default history preferences when the section is absent", async () => {
  await withTempSettings(async (settingsPath) => {
    assert.deepEqual(await loadHistoryPreferences(settingsPath), {
      preferences: DEFAULT_HISTORY_PREFERENCES,
    });
  });
});

test("loads valid history character budgets", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        "history-preferences": {
          "compression-threshold-chars": 120,
          "max-context-chars": 200,
          "summary-target-chars": 40,
        },
      }),
    );
    assert.deepEqual(await loadHistoryPreferences(settingsPath), {
      preferences: {
        compressionThresholdChars: 120,
        maxContextChars: 200,
        summaryTargetChars: 40,
      },
    });
  });
});

test("falls back as a whole when history budgets are invalid", async () => {
  await withTempSettings(async (settingsPath) => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        "history-preferences": {
          "compression-threshold-chars": 200,
          "max-context-chars": 200,
          "summary-target-chars": -1,
        },
      }),
    );
    const loaded = await loadHistoryPreferences(settingsPath);
    assert.equal(loaded.preferences, DEFAULT_HISTORY_PREFERENCES);
    assert.match(loaded.warning ?? "", /history-preferences/);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="history" test/settings.test.ts
```

Expected: FAIL because `loadHistoryPreferences` is not exported.

- [ ] **Step 3: Implement one strict loader with an all-default fallback**

Add to `src/settings.ts`:

```ts
import {
  DEFAULT_HISTORY_PREFERENCES,
  type HistoryPreferences,
} from "./history/types.js";

export interface LoadedHistoryPreferences {
  preferences: HistoryPreferences;
  warning?: string;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export async function loadHistoryPreferences(
  settingsPath = SETTINGS_PATH,
): Promise<LoadedHistoryPreferences> {
  const text = await readSettingsText(settingsPath);
  if (text === undefined) {
    return { preferences: DEFAULT_HISTORY_PREFERENCES };
  }

  let settings: JsonObject;
  try {
    settings = parseSettings(text);
  } catch (error) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning: error instanceof Error ? error.message : String(error),
    };
  }

  const section = settings["history-preferences"];
  if (section === undefined) {
    return { preferences: DEFAULT_HISTORY_PREFERENCES };
  }
  if (!isObject(section)) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning: "history-preferences 必须是 JSON 对象。",
    };
  }

  const threshold = section["compression-threshold-chars"];
  const maximum = section["max-context-chars"];
  const summaryTarget = section["summary-target-chars"];
  if (
    !isPositiveInteger(threshold) ||
    !isPositiveInteger(maximum) ||
    !isPositiveInteger(summaryTarget) ||
    threshold >= maximum ||
    summaryTarget >= threshold
  ) {
    return {
      preferences: DEFAULT_HISTORY_PREFERENCES,
      warning:
        "history-preferences 必须是正整数，并满足 summary-target < compression-threshold < max-context。",
    };
  }

  return {
    preferences: {
      compressionThresholdChars: threshold,
      maxContextChars: maximum,
      summaryTargetChars: summaryTarget,
    },
  };
}
```

- [ ] **Step 4: Run focused and full settings tests**

Run:

```bash
node --import tsx --test test/settings.test.ts
npm run check
```

Expected: all settings tests PASS and TypeScript exits 0.

### Task 3: Open SQLite securely and migrate schema v1

**Files:**

- Create: `src/history/sqlite.ts`
- Create: `test/history-fixture.ts`
- Create: `test/history-sqlite.test.ts`

- [ ] **Step 1: Add an isolated database fixture and failing schema test**

Create `test/history-fixture.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withHistoryPath(
  run: (databasePath: string, home: string) => Promise<void> | void,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "coffee-history-"));
  try {
    await run(path.join(home, ".coffee", "history.sqlite"), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
```

Create `test/history-sqlite.test.ts` with:

```ts
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { openHistoryDatabase } from "../src/history/sqlite.js";
import { withHistoryPath } from "./history-fixture.js";

test("creates schema v1 with WAL, foreign keys, and private permissions", async () => {
  await withHistoryPath(async (databasePath) => {
    const connection = openHistoryDatabase(databasePath);
    assert.equal(connection.pragma("user_version", { simple: true }), 1);
    assert.equal(connection.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(connection.pragma("foreign_keys", { simple: true }), 1);
    assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, 0o700);
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, [
      "app_metadata",
      "messages",
      "session_summaries",
      "sessions",
      "turns",
    ]);
    connection.close();
  });
});

test("refuses a database created by a newer Coffee version", async () => {
  await withHistoryPath(async (databasePath) => {
    const first = openHistoryDatabase(databasePath);
    first.pragma("user_version = 99");
    first.close();
    await assert.rejects(
      Promise.resolve().then(() => openHistoryDatabase(databasePath)),
      /版本 99.*仅支持 1/,
    );
  });
});

test("does not overwrite a corrupt database", async () => {
  await withHistoryPath(async (databasePath) => {
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "not sqlite", "utf8");
    await assert.rejects(
      Promise.resolve().then(() => openHistoryDatabase(databasePath)),
      /无法打开历史数据库/,
    );
    assert.equal(await readFile(databasePath, "utf8"), "not sqlite");
  });
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run:

```bash
node --import tsx --test test/history-sqlite.test.ts
```

Expected: FAIL because `src/history/sqlite.ts` does not exist.

- [ ] **Step 3: Implement secure open, PRAGMAs, migration, and safe errors**

Create `src/history/sqlite.ts` with these exported contracts:

```ts
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

export const HISTORY_SCHEMA_VERSION = 1;
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
  UNIQUE(session_id, sequence)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_calls_json TEXT,
  reasoning_json TEXT,
  UNIQUE(turn_id, sequence)
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

function secureMode(filePath: string): void {
  if (existsSync(filePath)) chmodSync(filePath, 0o600);
}

export function secureHistoryFiles(databasePath: string): void {
  secureMode(databasePath);
  secureMode(`${databasePath}-wal`);
  secureMode(`${databasePath}-shm`);
}

export function openHistoryDatabase(
  databasePath = DEFAULT_HISTORY_PATH,
): Database.Database {
  const directory = path.dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  let database: Database.Database | undefined;
  const previousUmask = process.umask(0o077);
  try {
    database = new Database(databasePath);
  } catch (error) {
    throw new Error(
      `无法打开历史数据库 ${databasePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    process.umask(previousUmask);
  }

  try {
    const version = database.pragma("user_version", { simple: true }) as number;
    if (version > HISTORY_SCHEMA_VERSION) {
      throw new Error(
        `历史数据库版本 ${version} 高于当前 Coffee 仅支持的版本 ${HISTORY_SCHEMA_VERSION}。`,
      );
    }
    if (version === 0) {
      database.transaction(() => {
        database!.exec(SCHEMA_V1);
        database!.pragma(`user_version = ${HISTORY_SCHEMA_VERSION}`);
      })();
    }
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    database.pragma("synchronous = NORMAL");
    const quickCheck = database.pragma("quick_check(1)", { simple: true });
    if (quickCheck !== "ok") {
      throw new Error(`历史数据库完整性检查失败：${String(quickCheck)}`);
    }
    secureHistoryFiles(databasePath);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && error.message.startsWith("历史数据库")) {
      throw error;
    }
    throw new Error(
      `无法打开历史数据库 ${databasePath}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
```

- [ ] **Step 4: Verify schema, permission, future-version, and corruption behavior**

Run:

```bash
node --import tsx --test test/history-sqlite.test.ts
npm run check
```

Expected: all SQLite opening tests PASS and TypeScript exits 0.

### Task 4: Encode and strictly decode persisted messages

**Files:**

- Create: `src/history/message-codec.ts`
- Create: `test/history-message-codec.test.ts`

- [ ] **Step 1: Write a full tool/reasoning round-trip test**

Create `test/history-message-codec.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeMessageRow,
  encodeMessage,
} from "../src/history/message-codec.js";
import type { PersistedMessage } from "../src/history/types.js";

test("round-trips user, assistant tool calls, reasoning, and tool results", () => {
  const messages: PersistedMessage[] = [
    { role: "user", content: "计算" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "calculator", argumentsJson: "{\"expression\":\"6*7\"}" }],
      reasoning: {
        providerId: "deepseek",
        field: "reasoning_content",
        text: "private",
        details: [{ type: "opaque", value: 1 }],
      },
    },
    { role: "tool", toolCallId: "call-1", content: "{\"ok\":true,\"result\":42}" },
    { role: "assistant", content: "42", toolCalls: [] },
  ];

  assert.deepEqual(
    messages.map((message) => decodeMessageRow(encodeMessage(message))),
    messages,
  );
});

test("rejects malformed role-specific JSON", () => {
  assert.throws(
    () =>
      decodeMessageRow({
        role: "assistant",
        content: "x",
        tool_call_id: null,
        tool_calls_json: "{bad",
        reasoning_json: null,
      }),
    /消息数据损坏/,
  );
});
```

- [ ] **Step 2: Run the codec test and verify RED**

Run:

```bash
node --import tsx --test test/history-message-codec.test.ts
```

Expected: FAIL because the codec module does not exist.

- [ ] **Step 3: Implement role-specific encoding and validation**

Create `src/history/message-codec.ts` with this public shape:

```ts
import type {
  ModelReasoning,
  ModelReasoningField,
  ModelToolCall,
} from "../models/types.js";
import type { PersistedMessage } from "./types.js";

export interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  reasoning_json: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`历史消息数据损坏：${field} 不是有效 JSON。`);
  }
}

function parseToolCalls(text: string | null): ModelToolCall[] {
  if (text === null) return [];
  const value = parseJson(text, "tool_calls_json");
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !isRecord(item) ||
        typeof item.id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.argumentsJson !== "string",
    )
  ) {
    throw new Error("历史消息数据损坏：tool_calls_json 结构无效。");
  }
  return structuredClone(value as ModelToolCall[]);
}

function parseReasoning(text: string | null): ModelReasoning | undefined {
  if (text === null) return undefined;
  const value = parseJson(text, "reasoning_json");
  if (!isRecord(value) || typeof value.providerId !== "string") {
    throw new Error("历史消息数据损坏：reasoning_json 结构无效。");
  }
  const field = value.field;
  const allowed: readonly ModelReasoningField[] = [
    "reasoning_content",
    "reasoning",
    "reasoning_text",
  ];
  if (field !== undefined && !allowed.includes(field as ModelReasoningField)) {
    throw new Error("历史消息数据损坏：reasoning field 无效。");
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    throw new Error("历史消息数据损坏：reasoning text 无效。");
  }
  if (value.details !== undefined && !Array.isArray(value.details)) {
    throw new Error("历史消息数据损坏：reasoning details 无效。");
  }
  return structuredClone(value) as unknown as ModelReasoning;
}

export function encodeMessage(message: PersistedMessage): MessageRow {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
      tool_call_id: null,
      tool_calls_json: null,
      reasoning_json: null,
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      tool_calls_json: null,
      reasoning_json: null,
    };
  }
  return {
    role: "assistant",
    content: message.content,
    tool_call_id: null,
    tool_calls_json: JSON.stringify(message.toolCalls),
    reasoning_json:
      message.reasoning === undefined ? null : JSON.stringify(message.reasoning),
  };
}

export function decodeMessageRow(row: MessageRow): PersistedMessage {
  if (row.role === "user") {
    if (row.tool_call_id || row.tool_calls_json || row.reasoning_json) {
      throw new Error("历史消息数据损坏：user 字段无效。");
    }
    return { role: "user", content: row.content };
  }
  if (row.role === "tool") {
    if (!row.tool_call_id || row.tool_calls_json || row.reasoning_json) {
      throw new Error("历史消息数据损坏：tool 字段无效。");
    }
    return { role: "tool", toolCallId: row.tool_call_id, content: row.content };
  }
  if (row.role === "assistant") {
    if (row.tool_call_id) {
      throw new Error("历史消息数据损坏：assistant tool_call_id 无效。");
    }
    return {
      role: "assistant",
      content: row.content,
      toolCalls: parseToolCalls(row.tool_calls_json),
      ...(row.reasoning_json === null
        ? {}
        : { reasoning: parseReasoning(row.reasoning_json) }),
    };
  }
  throw new Error(`历史消息数据损坏：未知 role ${row.role}。`);
}
```

- [ ] **Step 4: Verify the codec and type-check**

Run:

```bash
node --import tsx --test test/history-message-codec.test.ts
npm run check
```

Expected: all codec tests PASS and TypeScript exits 0.

### Task 5: Implement atomic session storage and optimistic revisions

**Files:**

- Create: `src/history/store.ts`
- Create: `test/history-store.test.ts`

- [ ] **Step 1: Write failing tests for lazy creation, round-trip, list, and cascade**

Create tests that open a store at `withHistoryPath()`, then assert this exact flow:

```ts
const first = store.commitTurn({
  sessionId: undefined,
  expectedRevision: undefined,
  title: "第一杯咖啡",
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  messages: [
    { role: "user", content: "第一杯咖啡" },
    { role: "assistant", content: "你好", toolCalls: [] },
  ],
});
assert.equal(first.revision, 1);
assert.equal(store.getActiveSessionId(), first.id);
assert.deepEqual(store.loadSession(first.id)?.turns[0]?.messages, [
  { role: "user", content: "第一杯咖啡" },
  { role: "assistant", content: "你好", toolCalls: [] },
]);
assert.equal(store.listSessions()[0]?.messageCount, 2);

store.deleteSession(first.id, 1);
assert.equal(store.loadSession(first.id), undefined);
assert.equal(store.getActiveSessionId(), undefined);
```

Add a second test that opens two stores on the same file, commits from store A, and expects store B's stale `expectedRevision` update to throw `/其他 Coffee 进程/` without adding a turn.

- [ ] **Step 2: Run the store tests and verify RED**

Run:

```bash
node --import tsx --test test/history-store.test.ts
```

Expected: FAIL because `createHistoryStore` does not exist.

- [ ] **Step 3: Define the exact store port and write transaction inputs**

Create `src/history/store.ts` with these interfaces:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { decodeMessageRow, encodeMessage, type MessageRow } from "./message-codec.js";
import { openHistoryDatabase } from "./sqlite.js";
import type {
  PersistedMessage,
  SessionListItem,
  StoredSession,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export interface CommitTurnInput {
  readonly sessionId?: string;
  readonly expectedRevision?: number;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly PersistedMessage[];
}

export interface CommitTurnResult {
  readonly id: string;
  readonly revision: number;
  readonly turn: StoredTurn;
}

export interface SaveSummaryInput {
  readonly sessionId: string;
  readonly expectedRevision: number;
  readonly throughTurnSequence: number;
  readonly content: string;
}

export interface HistoryStore {
  getActiveSessionId(): string | undefined;
  setActiveSessionId(sessionId: string | undefined): void;
  loadSession(sessionId: string): StoredSession | undefined;
  listSessions(): readonly SessionListItem[];
  commitTurn(input: CommitTurnInput): CommitTurnResult;
  updateSessionModel(
    sessionId: string,
    expectedRevision: number,
    providerId: string,
    modelId: string,
  ): number;
  saveSummary(input: SaveSummaryInput): { revision: number; summary: StoredSummary };
  deleteSession(sessionId: string, expectedRevision: number): void;
  close(): void;
}

export function createHistoryStore(databasePath?: string): HistoryStore;
```

The overload signature above is followed immediately by its implementation in the real file. The implementation opens one connection with `openHistoryDatabase(databasePath)` and returns the concrete methods completed in Steps 4-6.

- [ ] **Step 4: Implement deterministic row loading and active/list queries**

Use explicit `ORDER BY turns.sequence, messages.sequence`. For each session row, group message rows by `turn_id`, call `decodeMessageRow()`, and return frozen/deep-cloned domain values. The list query must be exactly:

```sql
SELECT
  s.id,
  s.title,
  s.provider_id,
  s.model_id,
  s.updated_at,
  COUNT(m.id) AS message_count
FROM sessions s
LEFT JOIN turns t ON t.session_id = s.id
LEFT JOIN messages m ON m.turn_id = t.id
GROUP BY s.id
ORDER BY s.updated_at DESC, s.id DESC
```

`setActiveSessionId()` updates only `app_metadata.singleton = 1`; passing an unknown non-empty ID must fail via the foreign key instead of inserting a phantom session.

- [ ] **Step 5: Implement the complete atomic `commitTurn()` transaction**

Inside one `database.transaction()`:

```ts
const now = new Date().toISOString();
const sessionId = input.sessionId ?? randomUUID();
let revision: number;

if (input.sessionId === undefined) {
  database.prepare(`
    INSERT INTO sessions(
      id, title, provider_id, model_id, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
  `).run(sessionId, input.title, input.providerId, input.modelId, now, now);
  revision = 1;
} else {
  if (input.expectedRevision === undefined) {
    throw new Error("持久化会话缺少 revision。");
  }
  const updated = database.prepare(`
    UPDATE sessions
    SET revision = revision + 1,
        updated_at = ?, provider_id = ?, model_id = ?
    WHERE id = ? AND revision = ?
  `).run(
    now,
    input.providerId,
    input.modelId,
    input.sessionId,
    input.expectedRevision,
  );
  if (updated.changes !== 1) {
    throw new Error("该会话已被其他 Coffee 进程修改，请使用 /sessions 重新打开。");
  }
  revision = input.expectedRevision + 1;
}

const sequence = (
  database.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM turns WHERE session_id = ?",
  ).get(sessionId) as { value: number }
).value;
const turnId = randomUUID();
database.prepare(
  "INSERT INTO turns(id, session_id, sequence, created_at) VALUES (?, ?, ?, ?)",
).run(turnId, sessionId, sequence, now);

const insertMessage = database.prepare(`
  INSERT INTO messages(
    id, turn_id, sequence, role, content,
    tool_call_id, tool_calls_json, reasoning_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
input.messages.forEach((message, index) => {
  const row = encodeMessage(message);
  insertMessage.run(
    randomUUID(),
    turnId,
    index + 1,
    row.role,
    row.content,
    row.tool_call_id,
    row.tool_calls_json,
    row.reasoning_json,
  );
});
database.prepare(
  "UPDATE app_metadata SET active_session_id = ? WHERE singleton = 1",
).run(sessionId);
```

Return the generated ID/revision and a deep clone of the inserted turn only after the transaction commits.

Call `secureHistoryFiles(databasePath)` in a `finally` block after every mutating transaction so WAL/SHM files created after startup remain mode `0600`.

- [ ] **Step 6: Implement model, summary, and delete transactions with the same revision guard**

`updateSessionModel()` increments revision and changes provider/model/updated time. `saveSummary()` increments revision, then upserts:

```sql
INSERT INTO session_summaries(
  session_id, through_turn_sequence, content,
  source_revision, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
  through_turn_sequence = excluded.through_turn_sequence,
  content = excluded.content,
  source_revision = excluded.source_revision,
  updated_at = excluded.updated_at
```

Use the pre-increment expected revision as `source_revision`. `deleteSession()` first performs `DELETE FROM sessions WHERE id = ? AND revision = ?`; zero changes is a conflict. Foreign keys cascade child rows and set active ID to NULL.

- [ ] **Step 7: Run store and codec tests**

Run:

```bash
node --import tsx --test test/history-message-codec.test.ts test/history-store.test.ts
npm run check
```

Expected: all persistence tests PASS and TypeScript exits 0.

### Task 6: Manage restored and lazy sessions without touching SQL from the CLI

**Files:**

- Create: `src/history/session-manager.ts`
- Create: `test/session-manager.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Cover this sequence with a real temporary `HistoryStore` and the existing model registry:

```ts
const manager = createSessionManager({
  store,
  getModel: (providerId, modelId) => registry.getModel(providerId, modelId),
  defaultModel: deepSeekModel,
});
assert.equal(manager.getCurrent().id, undefined);

manager.startNew(openCodeModel);
assert.equal(store.listSessions().length, 0);
manager.commitTurn([
  { role: "user", content: "  第一行\n第二行  " },
  { role: "assistant", content: "完成", toolCalls: [] },
]);
assert.equal(manager.getCurrent().title, "第一行 第二行");
assert.equal(store.listSessions().length, 1);

const restored = createSessionManager({
  store,
  getModel: (providerId, modelId) => registry.getModel(providerId, modelId),
  defaultModel: deepSeekModel,
});
assert.equal(restored.getModel()?.id, openCodeModel.id);
```

Also test: invalid stored model yields `undefined` without changing IDs; `setModel()` persists for a real session but not a blank one; `startNew()` clears the active ID; `switchSession()` reloads; `deleteCurrent()` cascades and becomes blank; stale revisions throw and leave the in-memory snapshot unchanged.

- [ ] **Step 2: Run the manager test and verify RED**

Run:

```bash
node --import tsx --test test/session-manager.test.ts
```

Expected: FAIL because the manager module does not exist.

- [ ] **Step 3: Define the manager interface and title normalization**

Create `src/history/session-manager.ts` with:

```ts
import type { ModelDefinition } from "../models/types.js";
import type { HistoryStore } from "./store.js";
import type {
  PersistedMessage,
  SessionListItem,
  StoredSession,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export interface CurrentSession {
  readonly id?: string;
  readonly title?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly revision?: number;
  readonly model?: ModelDefinition;
  readonly turns: readonly StoredTurn[];
  readonly summary?: StoredSummary;
}

export interface SessionManager {
  getCurrent(): CurrentSession;
  getModel(): ModelDefinition | undefined;
  listSessions(): readonly SessionListItem[];
  startNew(defaultModel: ModelDefinition | undefined): void;
  switchSession(sessionId: string): CurrentSession;
  deleteCurrent(): boolean;
  setModel(model: ModelDefinition): void;
  commitTurn(messages: readonly PersistedMessage[]): StoredTurn;
  saveSummary(throughTurnSequence: number, content: string): StoredSummary;
}

export interface CreateSessionManagerOptions {
  readonly store: HistoryStore;
  readonly getModel: (
    providerId: string,
    modelId: string,
  ) => ModelDefinition | undefined;
  readonly defaultModel?: ModelDefinition;
}

export function createSessionManager(
  options: CreateSessionManagerOptions,
): SessionManager;

export function createSessionTitle(input: string): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 40).join("") || "新会话";
}
```

- [ ] **Step 4: Implement snapshot replacement only after successful store calls**

At construction, read `store.getActiveSessionId()`, load it if present, and map its provider/model through `getModel`. If the metadata points to a missing session, clear the metadata and start blank.

For every mutation:

1. Build the next snapshot locally.
2. Call the corresponding store method with the current revision.
3. Replace the in-memory snapshot only after the store call succeeds.
4. Return deep-cloned/frozen arrays from `getCurrent()`.

`commitTurn()` derives a new title only when `current.id` is absent, passes the current selected model IDs, then appends the returned turn. If no model is selected, throw the same existing `/login` and `/model` guidance before calling the store.

- [ ] **Step 5: Verify all lifecycle and conflict tests**

Run:

```bash
node --import tsx --test test/history-store.test.ts test/session-manager.test.ts
npm run check
```

Expected: store and manager tests PASS and TypeScript exits 0.

### Task 7: Select complete turns and prepare redacted rolling-summary input

**Files:**

- Create: `src/history/context.ts`
- Create: `test/conversation-context.test.ts`

- [ ] **Step 1: Write failing tests for cost, contiguity, and hard-limit failure**

Use small budgets so tests stay readable:

```ts
const preferences = {
  compressionThresholdChars: 180,
  maxContextChars: 240,
  summaryTargetChars: 40,
};
const selected = buildContext({
  systemPrompt: "system",
  summary: undefined,
  turns: [oldestTurn, middleTurn, newestTurn],
  currentMessages: [{ role: "user", content: "current" }],
  preferences,
});
assert.deepEqual(
  selected.includedTurnSequences,
  [middleTurn.sequence, newestTurn.sequence],
);
assert.ok(selected.cost <= preferences.maxContextChars);
```

Create a gap case where `newestTurn` fits but `middleTurn` does not and a tiny `oldestTurn` would fit; assert that the oldest turn is not included. Create a tool turn and assert it is all included or all excluded. Create a current message larger than the hard cap and assert `/当前回合超过上下文上限/`.

Add a redaction test where reasoning text/details and a key-like field exist, then assert `createSummarySource()` contains user/assistant/tool conclusions but not `private reasoning`, `opaque`, or `sk-test-secret`.

- [ ] **Step 2: Run the context tests and verify RED**

Run:

```bash
node --import tsx --test test/conversation-context.test.ts
```

Expected: FAIL because `src/history/context.ts` does not exist.

- [ ] **Step 3: Implement stable message cost and summary wrapping**

Create these exports in `src/history/context.ts`:

```ts
import type { ModelMessage } from "../models/types.js";
import type {
  HistoryPreferences,
  PersistedMessage,
  StoredSummary,
  StoredTurn,
} from "./types.js";

export const SUMMARY_PREFIX = "以下是较早对话的滚动摘要，仅作为上下文：\n";

export function stableCharacterCost(value: unknown): number {
  return JSON.stringify(value).length;
}

function summaryMessage(summary: StoredSummary | undefined): ModelMessage[] {
  return summary
    ? [{ role: "system", content: `${SUMMARY_PREFIX}${summary.content}` }]
    : [];
}

export interface BuildContextInput {
  readonly systemPrompt: string;
  readonly summary?: StoredSummary;
  readonly turns: readonly StoredTurn[];
  readonly currentMessages: readonly PersistedMessage[];
  readonly preferences: HistoryPreferences;
}

export interface BuiltContext {
  readonly messages: readonly ModelMessage[];
  readonly includedTurnSequences: readonly number[];
  readonly cost: number;
}
```

- [ ] **Step 4: Implement newest-contiguous complete-turn selection**

Build the mandatory array from system, summary, and current messages. Throw if its stable cost exceeds `maxContextChars`. Walk `turns` from newest to oldest; prepend a whole turn only if the new total fits. Break on the first non-fitting turn. Reverse the selected turns back to chronological order before flattening.

Do not filter turns in this function based on summary coverage; the caller passes only turns with `sequence > summary.throughTurnSequence` when a summary is used.

- [ ] **Step 5: Implement compression planning and redacted source material**

Export:

```ts
export interface CompressionPlan {
  readonly shouldCompress: boolean;
  readonly throughTurnSequence?: number;
  readonly source?: string;
}

export function planCompression(input: BuildContextInput): CompressionPlan;

export function createSummarySource(
  previousSummary: StoredSummary | undefined,
  turns: readonly StoredTurn[],
): string;
```

`planCompression()` computes the full unsummarized cost. If below `compressionThresholdChars`, return `{ shouldCompress: false }`. Otherwise, choose the oldest consecutive turns until replacing them with `summaryTargetChars` brings the projected request at or under the threshold. If no complete turn can be compressed, return false and let hard truncation handle the request.

`createSummarySource()` serializes only:

- `user`: content.
- `assistant`: visible content plus tool call names and argument JSON after replacing case-insensitive values matching `(api[_-]?key|authorization|token|secret)` with `[REDACTED]`.
- `tool`: content after the same recursive JSON-key redaction, or plain-text replacement of `sk-`, `tvly-`, and `Bearer ` tokens with `[REDACTED]`.
- existing summary content.

Never copy the `reasoning` property into the summary source.

- [ ] **Step 6: Run all pure context tests**

Run:

```bash
node --import tsx --test test/conversation-context.test.ts
npm run check
```

Expected: all context tests PASS and TypeScript exits 0.

### Task 8: Generate rolling summaries and persist only completed Agent turns

**Files:**

- Create: `src/history/summarizer.ts`
- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`

- [ ] **Step 1: Add failing Agent tests for restore, commit order, summary, and failure fallback**

Extend `conversationOptions()` to accept a fake `SessionManager`. Add these focused assertions:

```ts
const request = gateway.requests[0];
assert.equal(request?.messages[0]?.role, "system");
assert.match(request?.messages[0]?.content ?? "", /Coffee/);
assert.deepEqual(request?.messages.slice(1), [
  { role: "user", content: "已恢复的问题" },
  { role: "assistant", content: "旧回答", toolCalls: [] },
  { role: "user", content: "继续" },
]);
```

Add a fake manager whose `commitTurn()` throws. Assert streamed text was emitted, `done` was not emitted, the error matches `/历史保存失败/`, and the next request does not include the failed turn.

For compression, provide tiny preferences and old turns, make the first fake gateway response be summary text and the second be the user answer. Assert events start with `{ type: "status", text: "正在整理较早的对话…" }`, the summary request has `tools: []`, excludes reasoning, `saveSummary()` runs before `commitTurn()`, and the main request includes `SUMMARY_PREFIX`.

Add a non-abort summary failure test: the main answer still runs with recent complete turns. Add an abort test: no main request, summary write, or turn write occurs.

- [ ] **Step 2: Run focused Agent tests and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="history|summary|persist" test/agent.test.ts
```

Expected: FAIL because Conversation has no session/context ports.

- [ ] **Step 3: Implement the hidden summary request collector**

Create `src/history/summarizer.ts`:

```ts
import type {
  ModelDefinition,
  ModelGateway,
  ModelMessage,
} from "../models/types.js";

const SUMMARY_SYSTEM_PROMPT = `
你负责压缩较早的对话。保留用户偏好、事实、已确认决定、约束、未解决任务和工具结论。
删除推理过程、凭证、疑似秘密、重复内容和冗长工具日志。
只输出摘要正文，不调用工具，不解释压缩过程。
`.trim();

export async function generateSummary(options: {
  gateway: ModelGateway;
  model: ModelDefinition;
  apiKey: string;
  source: string;
  targetChars: number;
  signal?: AbortSignal;
}): Promise<string> {
  const messages: ModelMessage[] = [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    {
      role: "user",
      content: `请将以下内容压缩到约 ${options.targetChars} 个字符：\n\n${options.source}`,
    },
  ];
  let content: string | undefined;
  for await (const event of options.gateway.stream({
    model: options.model,
    apiKey: options.apiKey,
    messages,
    tools: [],
    signal: options.signal,
  })) {
    if (event.type === "done") {
      if (event.reply.toolCalls.length > 0) {
        throw new Error("摘要模型返回了工具调用。");
      }
      content = event.reply.content?.trim();
    }
  }
  if (!content) throw new Error("摘要模型未返回有效正文。");
  return content;
}
```

- [ ] **Step 4: Add an optional session port while preserving existing unit tests**

In `src/agent.ts`, export a `ConversationSession` interface matching the manager methods Conversation needs:

```ts
export interface ConversationSession {
  getCurrent(): CurrentSession;
  getModel(): ModelDefinition | undefined;
  setModel(model: ModelDefinition): void;
  commitTurn(messages: readonly PersistedMessage[]): StoredTurn;
  saveSummary(throughTurnSequence: number, content: string): StoredSummary;
}
```

Add optional `session` and `historyPreferences` fields to `ConversationOptions`. When absent, create a private in-memory implementation initialized with `initialModel`; this preserves existing Agent tests and non-persistent embedding use.

- [ ] **Step 5: Replace the flat committed message array with session turns**

Keep only `currentTurnMessages` mutable during a request. Before every provider round:

1. Read a fresh `session.getCurrent()` snapshot.
2. Remove turns with `sequence <= summary.throughTurnSequence` when a summary exists.
3. Call `buildContext()` with system prompt, summary, remaining turns, and the whole current turn.
4. Pass the returned messages to `gateway.stream()`.

Push assistant and tool messages only into `currentTurnMessages`. On final valid assistant content, call `session.commitTurn(currentTurnMessages)` before setting `committed = true` and before yielding Conversation `done`.

Wrap persistence errors with:

```ts
throw new Error(
  `回答已生成，但历史保存失败，本轮未记录：${
    error instanceof Error ? error.message : String(error)
  }`,
);
```

- [ ] **Step 6: Run compression once before the first main-model round**

Before entering the tool loop, compute `planCompression()`. When compression is needed:

```ts
yield { type: "status", text: "正在整理较早的对话…" };
let generatedSummary: string | undefined;
try {
  generatedSummary = await generateSummary({
    gateway,
    model: turnModel,
    apiKey,
    source: compression.source!,
    targetChars: historyPreferences.summaryTargetChars,
    signal,
  });
} catch (error) {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
    throw error;
  }
}
if (generatedSummary !== undefined) {
  session.saveSummary(compression.throughTurnSequence!, generatedSummary);
}
```

Do not emit raw summary-generation failure text; immediately rebuild with `buildContext()` so recent complete turns are hard-truncated within 40,000 characters. Keep `session.saveSummary()` outside the generation catch: a stale revision or SQLite write failure is a persistence conflict and must stop the turn instead of being mistaken for a model-summary failure.

- [ ] **Step 7: Verify Agent transaction, summary, tool, and legacy behavior**

Run:

```bash
node --import tsx --test test/agent.test.ts test/conversation-context.test.ts
npm run check
```

Expected: all existing streaming/tool rollback tests and new history/summary tests PASS.

### Task 9: Register and render session lifecycle commands

**Files:**

- Create: `src/session-commands.ts`
- Create: `test/session-commands.test.ts`
- Modify: `src/commands.ts`
- Modify: `test/commands.test.ts`

- [ ] **Step 1: Write failing command registry and menu tests**

Add expectations that `/n` suggests `/new`, `/sess` suggests `/sessions`, `/delte` suggests `/delete`, and the help list contains all three descriptions.

Create `test/session-commands.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDeleteConfirmation,
  parseSessionChoice,
  renderSessionsMenu,
} from "../src/session-commands.js";

const sessions = [
  {
    id: "s1",
    title: "第一杯咖啡",
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    messageCount: 4,
    updatedAt: "2026-07-16T08:00:00.000Z",
  },
];

test("renders the current marker and parses a numbered session", () => {
  const menu = renderSessionsMenu(sessions, "s1");
  assert.match(menu, /1\. \* 第一杯咖啡/);
  assert.match(menu, /DeepSeek V4 Flash|deepseek-v4-flash/);
  assert.match(menu, /4 条消息/);
  assert.equal(parseSessionChoice("1", sessions)?.id, "s1");
  assert.equal(parseSessionChoice("2", sessions), undefined);
});

test("delete confirmation is default-no", () => {
  assert.equal(parseDeleteConfirmation(""), false);
  assert.equal(parseDeleteConfirmation("n"), false);
  assert.equal(parseDeleteConfirmation("y"), true);
  assert.equal(parseDeleteConfirmation("YES"), true);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --import tsx --test test/commands.test.ts test/session-commands.test.ts
```

Expected: FAIL because command names and helpers are missing.

- [ ] **Step 3: Extend the command union and registry**

Change `CommandDefinition.name` to include `"/new" | "/sessions" | "/delete"`. Insert these definitions before `/like`:

```ts
{ name: "/new", description: "开始新会话", acceptsArguments: false },
{ name: "/sessions", description: "查看和切换会话", acceptsArguments: false },
{ name: "/delete", description: "删除当前会话", acceptsArguments: false },
```

The existing exact-match, dropdown, typo suggestion, and local blocking logic must remain unchanged.

- [ ] **Step 4: Implement menu formatting and strict parsers**

Create `src/session-commands.ts`:

```ts
import type { SessionListItem } from "./history/types.js";

export function renderSessionsMenu(
  sessions: readonly SessionListItem[],
  activeSessionId?: string,
): string {
  if (sessions.length === 0) return "还没有已保存的会话。";
  return [
    "选择会话（Esc 取消）：",
    ...sessions.map((session, index) => {
      const marker = session.id === activeSessionId ? "*" : " ";
      const time = new Date(session.updatedAt).toLocaleString("zh-CN", {
        hour12: false,
      });
      return `${index + 1}. ${marker} ${session.title}  ${session.providerId}/${session.modelId}  ${session.messageCount} 条消息  ${time}`;
    }),
  ].join("\n");
}

export function parseSessionChoice(
  input: string,
  sessions: readonly SessionListItem[],
): SessionListItem | undefined {
  if (!/^\d+$/u.test(input.trim())) return undefined;
  return sessions[Number(input.trim()) - 1];
}

export function parseDeleteConfirmation(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}
```

- [ ] **Step 5: Verify command resolution and menu behavior**

Run:

```bash
node --import tsx --test test/commands.test.ts test/session-commands.test.ts
npm run check
```

Expected: all command tests PASS and TypeScript exits 0.

### Task 10: Wire history lifecycle into CLI startup, model selection, and shutdown

**Files:**

- Modify: `src/cli.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Make every CLI sandbox use an isolated history database**

Extend the existing CLI sandbox shape with `historyPath`, and set:

```ts
const historyPath = path.join(home, ".coffee", "history.sqlite");
env.COFFEE_HISTORY_PATH = historyPath;
```

Return `historyPath` from the fixture. Add a guard test that runs `/exit` and asserts no file exists at the developer's real `~/.coffee/history.sqlite` as a result of the child process; the child must always receive the override.

- [ ] **Step 2: Write failing black-box tests for lazy new, resume, sessions, delete, and model restoration**

Use the existing fake fetch/SSE preload and scripted stdin:

1. Run one successful turn then `/exit`; assert one session and one full turn in the isolated database.
2. Run Coffee again with the same paths; assert stdout contains `已恢复会话` and the next fake request contains the old turn.
3. Send `/new` then `/exit`; restart and assert no active session is restored and no empty session was added.
4. Create two sessions, execute `/sessions`, choose `1`, then send a message; assert the request uses that session's history and model.
5. Execute `/delete`, answer empty input; assert the session remains. Execute again and answer `y`; assert the session and child rows are gone.
6. Resume a session whose provider/model exists but credential is absent; assert history opens, no request is sent, and the CLI asks for `/login` or `/model`.
7. Force the history path to contain corrupt bytes; assert exit code 1, the error includes the absolute path, and bytes remain unchanged.

- [ ] **Step 3: Open history after settings/model registry initialization and before Conversation creation**

In `main()`:

```ts
const historyPath =
  process.env.COFFEE_HISTORY_PATH?.trim() || DEFAULT_HISTORY_PATH;
let historyStore: HistoryStore | undefined;
try {
  historyStore = createHistoryStore(historyPath);
} catch (error) {
  console.error(styleText(`Error: ${getErrorMessage(error)}`, "error", useColor));
  return 1;
}
```

Create `SessionManager` with the loaded global default model even when no credential exists. Remove the startup behavior that silently replaces a saved model solely because its credential is unavailable; credentials are checked when a message is sent.

If any initialization step after opening SQLite returns early, close `historyStore` in that error branch. Once initialization succeeds, wrap the entire banner/command-loop lifetime in the outer `try/finally` from Step 7.

Pass `session: sessionManager` and loaded history preferences to `createConversation()`.

- [ ] **Step 4: Restore session status without silently changing its model**

After the banner, if `sessionManager.getCurrent().id` exists, print:

```ts
const current = sessionManager.getCurrent();
console.log(
  styleText(
    `已恢复会话：${current.title}（${current.providerId}/${current.modelId}）`,
    "assistant",
    useColor,
  ),
);
```

If `current.model` is undefined, append one warning that `/model` is required. If its credential cannot be resolved, append one warning that `/login` or `/model` is required. Do not call `setModel()` in either case.

- [ ] **Step 5: Dispatch `/new`, `/sessions`, and `/delete` locally**

Add handlers before `/like`:

```ts
if (resolution.command.name === "/new") {
  sessionManager.startNew(loadedGlobalDefaultModel);
  console.log(styleText("✓ 已开始新会话。", "assistant", useColor));
  continue;
}

if (resolution.command.name === "/sessions") {
  const sessions = sessionManager.listSessions();
  if (sessions.length === 0) {
    console.log(renderSessionsMenu(sessions));
    continue;
  }
  const answer = await askMenu(
    renderSessionsMenu(sessions, sessionManager.getCurrent().id),
  );
  if (answer === undefined) return 0;
  if (answer === "\u001b") continue;
  const selected = parseSessionChoice(answer, sessions);
  if (!selected) {
    console.error(styleText("Error: 会话序号无效。", "error", useColor));
    continue;
  }
  sessionManager.switchSession(selected.id);
  console.log(styleText(`✓ 已切换会话：${selected.title}`, "assistant", useColor));
  continue;
}

if (resolution.command.name === "/delete") {
  const current = sessionManager.getCurrent();
  if (!current.id) {
    console.log("当前没有可删除的会话。");
    continue;
  }
  const answer = await inputController.ask(
    `确定删除“${current.title}”及其全部历史吗？ (y/N) `,
    false,
  );
  if (answer === undefined) return 0;
  if (!parseDeleteConfirmation(answer)) continue;
  sessionManager.deleteCurrent();
  console.log(styleText("✓ 当前会话已删除。", "assistant", useColor));
  continue;
}
```

Because the CLI command loop is sequential, these handlers cannot run during `conversation.stream()`. Keep the SessionManager's revision guards as the cross-process protection.

- [ ] **Step 6: Make `/model` update both global and session state in safe order**

Keep `saveModelPreference()` first. Then call `sessionManager.setModel(selectedModel)`. If either write fails, print the error and do not claim success. For a persisted session, `setModel()` increments its revision; for a lazy session, it changes only its in-memory model. `Conversation.getModel()` and `setModel()` delegate to the same manager, so no second model assignment is needed.

- [ ] **Step 7: Always close SQLite on every normal and exceptional exit**

Place `historyStore.close()` in the outermost `finally`, after the input and renderer cleanup. Guard against initialization failure by using optional chaining:

```ts
historyStore?.close();
```

Do not close the database from SIGINT directly while an Agent frame is executing; abort first, then let the normal `finally` path close it.

- [ ] **Step 8: Run all CLI black-box tests**

Run:

```bash
node --import tsx --test test/cli.test.ts test/commands.test.ts test/session-commands.test.ts
npm run check
```

Expected: all existing auth/model/streaming/Ctrl+C tests and new session tests PASS.

### Task 11: Harden failure boundaries, document behavior, and run final verification

**Files:**

- Modify: `test/history-sqlite.test.ts`
- Modify: `test/history-store.test.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/cli.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add regression tests for every no-partial-write path**

For each case below, count sessions, turns, messages, and summaries before and after, then assert they are identical:

- Provider stream throws after visible text.
- Tool execution returns an error that prevents a final assistant message.
- Ctrl+C aborts summary generation.
- Ctrl+C aborts the main response.
- `commitTurn()` throws after the model final reply.
- A second process increments the session revision before `commitTurn()`.
- Summary save encounters a stale revision.
- Current user/tool turn exceeds `maxContextChars`.

In the save-failure case, also assert the terminal retains the streamed partial/final text and contains `回答已生成，但历史保存失败，本轮未记录`.

- [ ] **Step 2: Add raw-history and secret-exclusion assertions**

After a successful rolling summary:

```ts
assert.equal(store.loadSession(sessionId)?.turns.length, originalTurnCount);
assert.equal(store.loadSession(sessionId)?.summary?.throughTurnSequence, expectedSequence);
assert.equal(JSON.stringify(summaryRequest).includes("private reasoning"), false);
assert.equal(JSON.stringify(summaryRequest).includes("sk-test-secret"), false);
assert.equal(JSON.stringify(store.loadSession(sessionId)).includes("api-key-value"), false);
```

The final assertion uses a credential only in the fake `resolveApiKey()` result and verifies it never enters the store.

- [ ] **Step 3: Document the user-facing contract**

Add a concise README section containing:

```markdown
## 会话历史

Coffee 使用嵌入式 SQLite 保存成功完成的对话，不需要启动数据库服务。默认数据库位于 `~/.coffee/history.sqlite`，API Key 不会写入其中。

- `/new`：进入新会话；只有首个成功回合后才会保存。
- `/sessions`：按最近更新时间列出并切换会话。
- `/delete`：确认后删除当前会话及其完整历史。

启动时 Coffee 自动恢复上次活动会话及其模型。如果模型不可用或缺少凭证，历史仍会打开，但需要先使用 `/model` 或 `/login`。

上下文默认在约 30,000 字符时生成滚动摘要，并在 40,000 字符硬限制内只发送最近的完整轮次。摘要不会删除 SQLite 中的原始消息，也不会展示或摘要模型的原始 reasoning。
```

Also extend the settings JSON example with the three `history-preferences` keys from the design.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
npm test
npm run check
history_smoke_dir="$(mktemp -d)"
COFFEE_HISTORY_PATH="$history_smoke_dir/history.sqlite" node --env-file=.env --import tsx src/cli.ts < /dev/null
history_smoke_status=$?
rm -rf "$history_smoke_dir"
test "$history_smoke_status" -eq 0
```

Expected:

- All Node tests PASS.
- TypeScript exits 0.
- Non-interactive CLI startup exits 0 without ANSI cursor-control residue or an unhandled SQLite warning.

- [ ] **Step 5: Verify no tests touched real user data and no temporary files remain**

Run:

```bash
find . -maxdepth 3 \( -name '*.sqlite' -o -name '*.sqlite-wal' -o -name '*.sqlite-shm' -o -name '*.tmp' -o -name '*.lock' \) -print
```

Expected: no test database, SQLite sidecar, temporary, or lock file is printed inside the Coffee project. Tests and the CLI smoke never open the real `~/.coffee/history.sqlite`.
