# Coffee Shell and Test Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-neutral `shell` tool that safely classifies, approves, executes, streams, cancels, and reports project commands from Coffee's fixed workspace.

**Architecture:** Keep policy, output processing, process lifecycle, and tool wiring in separate `src/shell/` modules. The existing tool registry receives one additional `execute`-risk tool, while the existing CLI `ToolInteraction` is extended through an optional Shell interaction contract so existing code-tool tests and non-interactive consumers remain compatible.

**Tech Stack:** TypeScript, Node.js `child_process`, `AbortSignal`, native `TextDecoder`, Node test runner, existing Coffee CLI/activity/terminal helpers. No new runtime dependency.

**Repository note:** `/Users/sevan/ai-tasks/pi-agent/coffee` is not currently inside a Git repository. Do not initialize Git or manufacture commit steps. Each task ends with a verified checkpoint; commits can be added later only if the user initializes or supplies a repository.

---

## File map

**Create**

- `src/shell/types.ts` — shared Shell request, decision, result, error, and optional CLI interaction contracts.
- `src/shell/command-policy.ts` — input validation, conservative tokenization, workspace checks, and `auto`/`confirm`/`deny` classification.
- `src/shell/output.ts` — stateful terminal-control sanitization, UTF-8-safe bounded terminal output, and model head/tail truncation.
- `src/shell/executor.ts` — Bash discovery, minimal environment construction, child-process lifecycle, timeout, cancellation, and process-tree termination.
- `src/shell/tool.ts` — provider-neutral registered tool definition and orchestration of policy, approval, display, and execution.
- `test/shell-command-policy.test.ts` — classification and validation tests.
- `test/shell-output.test.ts` — sanitizer and truncation tests.
- `test/shell-executor.test.ts` — cwd, environment, output, exit, timeout, cancellation, and cleanup tests.
- `test/shell-tool.test.ts` — policy/approval/executor wiring tests.
- `test/shell-process-fixture.mjs` — deterministic child/grandchild fixture for process-tree cancellation tests.

**Modify**

- `src/tools.ts` — register the `shell` tool when a workspace exists.
- `src/tool-interaction.ts` — implement Shell confirmation, command header, and append-only output callbacks.
- `src/activity-indicator.ts` — dedicated Shell animation and completion copy.
- `src/agent.ts` — advertise the capability accurately in the workspace system prompt.
- `test/tools.test.ts` — registry-level presence and risk tests.
- `test/tool-interaction.test.ts` — CLI approval, sanitization, append-only output, and non-interactive tests.
- `test/activity-indicator.test.ts` — Shell-specific progress copy.
- `test/agent.test.ts` — provider-neutral definition, tool result continuation, denial, and cancellation coverage.
- `test/streaming-fetch.mjs` — deterministic CLI Shell tool-call scenarios.
- `test/cli.test.ts` — end-to-end output, approval, and SIGINT process cleanup.
- `README.md` — document Shell behavior, trust boundary, confirmation rules, and limitations.

---

### Task 1: Shared contracts and conservative command policy

**Files:**

- Create: `src/shell/types.ts`
- Create: `src/shell/command-policy.ts`
- Create: `test/shell-command-policy.test.ts`

- [ ] **Step 1: Write validation and classification tests**

Create `test/shell-command-policy.test.ts` with table-driven cases that lock down every classification boundary:

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  classifyShellCommand,
  parseShellRequest,
} from "../src/shell/command-policy.js";

const root = path.resolve("/tmp/coffee-workspace");

test("parses a bounded command and default timeout", () => {
  assert.deepEqual(parseShellRequest({ command: "  npm test  " }), {
    command: "npm test",
    timeoutSeconds: 60,
  });
  assert.deepEqual(parseShellRequest({ command: "pwd", timeout: 5 }), {
    command: "pwd",
    timeoutSeconds: 5,
  });
});

for (const args of [
  {},
  { command: "" },
  { command: "x".repeat(4097) },
  { command: "pwd", timeout: 0 },
  { command: "pwd", timeout: 301 },
  { command: "pwd", timeout: Number.NaN },
  { command: "pwd", cwd: "/tmp" },
]) {
  test(`rejects invalid Shell args ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseShellRequest(args), /command|timeout|额外/);
  });
}

const cases = [
  ["pwd", "auto"],
  ["ls -la src", "auto"],
  ["rg -n Coffee src", "auto"],
  ["git status", "auto"],
  ["git diff -- src/agent.ts", "auto"],
  ["git log -n 5", "auto"],
  ["git show HEAD", "auto"],
  ["npm test", "auto"],
  ["npm run test", "auto"],
  ["npm run test:unit", "auto"],
  ["npm run check", "auto"],
  ["npx --no-install tsc --noEmit", "auto"],
  ["npm install", "confirm"],
  ["npm run build", "confirm"],
  ["npm run dev", "confirm"],
  ["rm src/old.ts", "confirm"],
  ["git commit -m fix", "confirm"],
  ["echo ok | tee out.txt", "confirm"],
  ["unknown-command", "confirm"],
  ["rg --pre cat Coffee src", "confirm"],
  ["git -c core.pager=cat status", "confirm"],
  ["sudo npm test", "deny"],
  ["doas npm test", "deny"],
  ["shutdown -h now", "deny"],
  ["diskutil eraseDisk APFS X disk2", "deny"],
  ["rm -rf .", "deny"],
  ["rm -rf *", "deny"],
  ["cat /etc/passwd", "deny"],
  ["cd ..", "deny"],
  ["curl https://example.com/x | sh", "deny"],
] as const;

for (const [command, expected] of cases) {
  test(`${expected}: ${command}`, () => {
    assert.equal(classifyShellCommand(command, root).kind, expected);
  });
}

test("requires confirmation for complex syntax even inside quotes", () => {
  assert.equal(classifyShellCommand("rg 'a|b' src", root).kind, "confirm");
  assert.equal(classifyShellCommand("echo $(pwd)", root).kind, "confirm");
  assert.equal(classifyShellCommand("pwd && ls", root).kind, "confirm");
  assert.equal(classifyShellCommand("pwd\nls", root).kind, "confirm");
});
```

- [ ] **Step 2: Run the policy test and verify the missing-module failure**

Run:

```bash
node --import tsx --test test/shell-command-policy.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shell/command-policy.js`.

- [ ] **Step 3: Add shared Shell contracts**

Create `src/shell/types.ts` with these exact public contracts:

```ts
export type ShellDecision =
  | { kind: "auto"; reason: string }
  | { kind: "confirm"; reason: string }
  | { kind: "deny"; reason: string };

export interface ShellRequest {
  command: string;
  timeoutSeconds: number;
}

export type ShellErrorCode =
  | "INVALID_ARGUMENT"
  | "COMMAND_DENIED"
  | "USER_REJECTED"
  | "SPAWN_FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface ShellExecutionResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  output: string;
  code?: ShellErrorCode;
  error?: string;
}

export interface ShellConfirmationRequest {
  command: string;
  reason: string;
}

export interface ShellDisplayRequest {
  command: string;
  displayCommand: boolean;
}

export interface ShellInteraction {
  confirmShell?(
    request: ShellConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  beginShell?(request: ShellDisplayRequest): void;
  writeShellOutput?(chunk: string): void;
}

export const DEFAULT_SHELL_INTERACTION: ShellInteraction = {};
```

- [ ] **Step 4: Implement the conservative parser and classifier**

Create `src/shell/command-policy.ts`. Keep these rules explicit rather than building a general Shell parser:

```ts
import path from "node:path";

import type { ShellDecision, ShellRequest } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_COMMAND_LENGTH = 4096;
const COMPLEX_SHELL = /[\r\n|&;<>`]|\$\(/;
const REMOTE_PIPE = /\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i;
const DENIED_COMMANDS = new Set([
  "sudo", "doas", "shutdown", "reboot", "halt", "poweroff",
  "mkfs", "fdisk", "diskutil",
]);
const SAFE_LS_FLAGS = /^-[alh1F]+$/;
const SAFE_RG_FLAGS = new Set([
  "-n", "--line-number", "-i", "--ignore-case", "-F",
  "--fixed-strings", "-l", "--files-with-matches", "--files",
]);
const SAFE_GIT_OPTIONS = new Set([
  "--", "--stat", "--name-only", "--name-status", "--oneline", "--decorate",
]);

function hasOnlyOwnKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseShellRequest(args: Record<string, unknown>): ShellRequest {
  if (!hasOnlyOwnKeys(args, ["command", "timeout"])) {
    throw new Error("shell 参数包含额外字段。");
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command || command.length > MAX_COMMAND_LENGTH) {
    throw new Error("shell command 必须是 1 到 4096 个字符。");
  }
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error("shell timeout 必须是 0 到 300 之间的有限正数。");
  }
  return { command, timeoutSeconds: timeout };
}

function tokenizeSimpleCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else {
      token += character;
    }
  }
  if (escaping || quote !== undefined) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function explicitPathLeavesWorkspace(token: string, root: string): boolean {
  if (token === "~" || token.startsWith("~/")) return true;
  if (!path.isAbsolute(token) && !token.startsWith("..")) return false;
  return !isInside(root, path.resolve(root, token));
}

function isWholeWorkspaceRemoval(tokens: readonly string[], root: string): boolean {
  if (tokens[0] !== "rm") return false;
  return tokens.slice(1).some((token) =>
    [".", "./", "*", "./*", root, `${root}/`].includes(token)
  );
}

function isSafeAutoCommand(tokens: readonly string[], root: string): boolean {
  if (tokens.some((token) => explicitPathLeavesWorkspace(token, root))) return false;
  if (tokens.length === 1 && tokens[0] === "pwd") return true;
  if (tokens[0] === "ls") {
    return tokens.slice(1).every((token) =>
      !token.startsWith("-") || SAFE_LS_FLAGS.test(token)
    );
  }
  if (tokens[0] === "rg") {
    if (tokens.some((token) => token === "--pre" || token.startsWith("--pre="))) {
      return false;
    }
    return tokens.slice(1).every((token) =>
      !token.startsWith("-") || SAFE_RG_FLAGS.has(token) || /^-[ABC]\d+$/.test(token)
    );
  }
  if (tokens[0] === "git" && ["status", "diff", "log", "show"].includes(tokens[1] ?? "")) {
    return tokens.slice(2).every((token) =>
      !token.startsWith("-") || SAFE_GIT_OPTIONS.has(token) || /^-n\d*$/.test(token)
    );
  }
  const joined = tokens.join(" ");
  return joined === "npm test" ||
    joined === "npm run test" ||
    /^npm run test:[A-Za-z0-9:_-]+$/.test(joined) ||
    joined === "npm run check" ||
    joined === "npx --no-install tsc --noEmit";
}

export function classifyShellCommand(command: string, workspaceRoot: string): ShellDecision {
  const root = path.resolve(workspaceRoot);
  if (REMOTE_PIPE.test(command)) {
    return { kind: "deny", reason: "禁止下载后直接执行远程脚本。" };
  }
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === undefined || tokens.length === 0) {
    return { kind: "confirm", reason: "命令包含无法安全解析的引号或转义。" };
  }
  if (
    DENIED_COMMANDS.has(tokens[0]!) ||
    isWholeWorkspaceRemoval(tokens, root) ||
    tokens.some((token) => explicitPathLeavesWorkspace(token, root))
  ) {
    return { kind: "deny", reason: "命令可能影响系统或访问工作区之外。" };
  }
  if (COMPLEX_SHELL.test(command)) {
    return { kind: "confirm", reason: "命令包含管道、重定向或组合语法。" };
  }
  if (isSafeAutoCommand(tokens, root)) {
    return { kind: "auto", reason: "命令符合只读或可信项目验证规则。" };
  }
  return { kind: "confirm", reason: "命令不在严格自动执行列表中。" };
}
```

The first version intentionally does not auto-approve value-taking `rg` options such as `-g`, `--glob`, `-C`, `-A`, `-B`, or `--max-count`. They fall through to `confirm`. Unknown `rg` and Git options also fall through to `confirm`; only the exact constants and regular expressions above are automatic.

- [ ] **Step 5: Run policy tests and type checking**

Run:

```bash
node --import tsx --test test/shell-command-policy.test.ts
npm run check
```

Expected: policy tests PASS and TypeScript exits `0`.

- [ ] **Step 6: Checkpoint**

Record Task 1 as complete in this plan. Do not initialize Git.

---

### Task 2: Stateful output safety and bounded context

**Files:**

- Create: `src/shell/output.ts`
- Create: `test/shell-output.test.ts`

- [ ] **Step 1: Write sanitizer and truncation tests**

Create `test/shell-output.test.ts` covering split Unicode, split ANSI/OSC sequences, carriage returns, C0/C1 controls, terminal display caps, and head/tail model output:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  createShellOutputProcessor,
  truncateShellOutput,
} from "../src/shell/output.js";

test("preserves split UTF-8 and removes split terminal controls", () => {
  const visible: string[] = [];
  const processor = createShellOutputProcessor({
    onVisibleChunk(chunk) { visible.push(chunk); },
  });
  processor.push("stdout", Buffer.from([0xe5, 0x92]));
  processor.push("stdout", Buffer.from([0x96, 0xe5, 0x95, 0xa1, 0x0a]));
  processor.push("stderr", Buffer.from("\u001b]0;bad"));
  processor.push("stderr", Buffer.from(" title\u0007error\u001b[31m!\u001b[0m\n"));
  const result = processor.finish();
  assert.equal(visible.join(""), "咖啡\nerror!\n");
  assert.equal(result.output, "咖啡\nerror!\n");
  assert.doesNotMatch(result.output, /\u001b|bad title/);
});

test("normalizes carriage-return redraws without overwriting history", () => {
  const processor = createShellOutputProcessor();
  processor.push("stdout", Buffer.from("10%\r20%\r100%\n"));
  assert.equal(processor.finish().output, "10%\n20%\n100%\n");
});

test("retains model head and tail with a single truncation marker", () => {
  const input = Array.from({ length: 2100 }, (_, index) => `line-${index}\n`).join("");
  const result = truncateShellOutput(input);
  assert.equal(result.truncated, true);
  assert.match(result.output, /^line-0/);
  assert.match(result.output, /output truncated/);
  assert.match(result.output, /line-2099\n$/);
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 52 * 1024);
});

test("stops terminal writes once without unbounded memory", () => {
  let visible = "";
  const processor = createShellOutputProcessor({
    terminalMaxBytes: 12,
    terminalMaxLines: 2,
    onVisibleChunk(chunk) { visible += chunk; },
  });
  processor.push("stdout", Buffer.from("one\ntwo\nthree\nfour\n"));
  const result = processor.finish();
  assert.equal(visible.split("[Shell output truncated]").length - 1, 1);
  assert.equal(result.output, "one\ntwo\nthree\nfour\n");
});
```

- [ ] **Step 2: Run the output test and verify it fails**

Run:

```bash
node --import tsx --test test/shell-output.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shell/output.js`.

- [ ] **Step 3: Implement a stateful sanitizer and bounded accumulator**

Create `src/shell/output.ts` with:

```ts
type StreamName = "stdout" | "stderr";

export interface ShellOutputProcessor {
  push(stream: StreamName, chunk: Buffer): void;
  finish(): { output: string; truncated: boolean };
}

export interface ShellOutputProcessorOptions {
  onVisibleChunk?: (chunk: string) => void;
  terminalMaxBytes?: number;
  terminalMaxLines?: number;
}

const MODEL_MAX_BYTES = 50 * 1024;
const MODEL_MAX_LINES = 2_000;
const TERMINAL_MAX_BYTES = 200 * 1024;
const TERMINAL_MAX_LINES = 2_000;
```

Implement one `TextDecoder` and one stateful terminal-sequence sanitizer per stream. The sanitizer must retain its escape state across chunks and implement these states:

```ts
type EscapeState = "text" | "escape" | "csi" | "osc" | "osc_escape";
```

Rules:

- Keep printable text, `\n`, and `\t`.
- Convert each `\r` to `\n`.
- Drop C0/C1 controls other than allowed whitespace.
- From ESC, consume CSI until `0x40..0x7e`.
- From OSC, consume until BEL or `ESC \\`.
- Preserve sanitizer state when a sequence is split across buffers.
- Flush each decoder at `finish()` without emitting incomplete escape sequences.
- Maintain bounded first and rolling-tail buffers rather than retaining arbitrary output.
- Emit `[Shell output truncated]` to the terminal once when either terminal limit is reached.

Implement `truncateShellOutput(input)` so line truncation retains the first 1000 and last 1000 logical lines, then byte truncation retains UTF-8-safe prefixes and suffixes within 25KB each. Add one English marker containing `output truncated` so tests and model parsing have a stable phrase.

- [ ] **Step 4: Run output tests and type checking**

Run:

```bash
node --import tsx --test test/shell-output.test.ts
npm run check
```

Expected: all output tests PASS and TypeScript exits `0`.

- [ ] **Step 5: Checkpoint**

Record Task 2 as complete. Do not initialize Git.

---

### Task 3: Bash execution, timeout, cancellation, and process trees

**Files:**

- Create: `src/shell/executor.ts`
- Create: `test/shell-executor.test.ts`
- Create: `test/shell-process-fixture.mjs`

- [ ] **Step 1: Write the deterministic process fixture**

Create `test/shell-process-fixture.mjs`:

```js
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const tracePath = process.argv[2];
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
appendFileSync(tracePath, `${process.pid},${child.pid}\n`, "utf8");
setInterval(() => {}, 1000);
```

- [ ] **Step 2: Write executor tests**

Create `test/shell-executor.test.ts` with actual local child processes and bounded timeouts:

```ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeShellCommand } from "../src/shell/executor.js";

test("executes in the fixed cwd with a minimal secret-free environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await executeShellCommand({
    command: `${JSON.stringify(process.execPath)} -e 'console.log(process.cwd()); console.log(process.env.DEEPSEEK_API_KEY ?? "missing")'`,
    cwd: root,
    timeoutSeconds: 5,
    processEnv: { ...process.env, DEEPSEEK_API_KEY: "must-not-leak" },
  });
  assert.equal(result.ok, true);
  assert.match(result.output, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.output, /missing/);
  assert.doesNotMatch(result.output, /must-not-leak/);
});

test("returns nonzero exit and merged output without throwing", async () => {
  const result = await executeShellCommand({
    command: "printf out; printf err >&2; exit 7",
    cwd: process.cwd(),
    timeoutSeconds: 5,
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.match(result.output, /out/);
  assert.match(result.output, /err/);
});

test("returns SPAWN_FAILED for a missing Bash", async () => {
  const result = await executeShellCommand({
    command: "pwd",
    cwd: process.cwd(),
    timeoutSeconds: 5,
    shellPath: "/definitely/missing/bash",
  });
  assert.equal(result.code, "SPAWN_FAILED");
  assert.equal(result.exitCode, null);
});

test("times out and terminates the process tree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const trace = path.join(root, "pids.txt");
  const result = await executeShellCommand({
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("test/shell-process-fixture.mjs"))} ${JSON.stringify(trace)}`,
    cwd: process.cwd(),
    timeoutSeconds: 0.2,
  });
  assert.equal(result.code, "TIMED_OUT");
  const pids = (await readFile(trace, "utf8")).trim().split(",").map(Number);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const pid of pids) assert.throws(() => process.kill(pid, 0));
});

test("AbortSignal cancels the whole process tree", async () => {
  const controller = new AbortController();
  const pending = executeShellCommand({
    command: "sleep 30",
    cwd: process.cwd(),
    timeoutSeconds: 60,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const result = await pending;
  assert.equal(result.code, "CANCELLED");
  assert.equal(result.cancelled, true);
});
```

- [ ] **Step 3: Run the executor test and verify it fails**

Run:

```bash
node --import tsx --test test/shell-executor.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shell/executor.js`.

- [ ] **Step 4: Implement Bash discovery and minimal environment**

Create `src/shell/executor.ts` with these entry points:

```ts
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import type { ShellExecutionResult } from "./types.js";
import { createShellOutputProcessor } from "./output.js";

export interface ExecuteShellOptions {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  processEnv?: NodeJS.ProcessEnv;
  shellPath?: string;
}

const PASSTHROUGH_ENV = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
] as const;

export function buildShellEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return {
    ...result,
    CI: "1",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
  };
}
```

Implement `resolveBash()` by checking an explicit test path first, then `/bin/bash` on Unix, then executable `bash`/`bash.exe` files in `PATH`. Use `access(candidate, constants.X_OK)`. Do not fall back to `sh`, zsh, a login shell, or `shell: true`.

- [ ] **Step 5: Implement process lifecycle and tree termination**

Spawn with:

```ts
const child = spawn(shellPath, ["-c", command], {
  cwd,
  detached: process.platform !== "win32",
  env: buildShellEnvironment(processEnv ?? process.env),
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
```

Connect both streams to `createShellOutputProcessor({ onVisibleChunk: onOutput })`. Race the child `error`/`close` lifecycle against timeout and `AbortSignal`, but resolve exactly once. On POSIX, terminate the negative process-group PID with `SIGTERM`, wait at most 250ms, then use `SIGKILL` if still alive. On Windows, invoke `taskkill /PID <pid> /T /F` with `shell: false`. Always remove abort listeners and clear timeout/kill timers.

Return `ShellExecutionResult` with:

- normal exit: `ok: exitCode === 0`, `code` absent;
- timeout: `code: "TIMED_OUT"`, `timedOut: true`, `exitCode: null`;
- abort: `code: "CANCELLED"`, `cancelled: true`, `exitCode: null`;
- resolution/spawn failure: `code: "SPAWN_FAILED"`, `exitCode: null`.

Use `performance.now()` for `durationMs`, rounded to a non-negative integer.

- [ ] **Step 6: Run executor tests and type checking**

Run:

```bash
node --import tsx --test test/shell-output.test.ts test/shell-executor.test.ts
npm run check
```

Expected: all tests PASS; no fixture child remains alive; TypeScript exits `0`.

- [ ] **Step 7: Checkpoint**

Record Task 3 as complete. Do not initialize Git.

---

### Task 4: Registered `shell` tool and approval orchestration

**Files:**

- Create: `src/shell/tool.ts`
- Create: `test/shell-tool.test.ts`
- Modify: `src/tools.ts`
- Modify: `test/tools.test.ts`

- [ ] **Step 1: Write Shell tool orchestration tests**

Create `test/shell-tool.test.ts` with an injected executor so policy behavior is tested without spawning:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { createShellTool } from "../src/shell/tool.js";
import type { ShellExecutionResult } from "../src/shell/types.js";

const success: ShellExecutionResult = {
  ok: true,
  command: "pwd",
  exitCode: 0,
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  truncated: false,
  output: "/workspace\n",
};

test("auto command executes without asking", async () => {
  let asked = 0;
  let executed = 0;
  const tool = createShellTool({
    workspaceRoot: process.cwd(),
    interaction: { async confirmShell() { asked += 1; return false; } },
    async execute(options) {
      executed += 1;
      assert.equal(options.command, "pwd");
      return success;
    },
  });
  assert.equal((await tool.execute({ command: "pwd" })).ok, true);
  assert.equal(asked, 0);
  assert.equal(executed, 1);
});

test("confirmed command executes once and rejected command never starts", async () => {
  for (const allow of [true, false]) {
    let executed = 0;
    const tool = createShellTool({
      workspaceRoot: process.cwd(),
      interaction: { async confirmShell() { return allow; } },
      async execute() { executed += 1; return { ...success, command: "npm install" }; },
    });
    const result = await tool.execute({ command: "npm install" });
    assert.equal(executed, allow ? 1 : 0);
    assert.equal(result.code, allow ? undefined : "USER_REJECTED");
  }
});

test("denied command never asks and never executes", async () => {
  let calls = 0;
  const tool = createShellTool({
    workspaceRoot: process.cwd(),
    interaction: { async confirmShell() { calls += 1; return true; } },
    async execute() { calls += 1; return success; },
  });
  const result = await tool.execute({ command: "sudo npm test" });
  assert.equal(result.code, "COMMAND_DENIED");
  assert.equal(calls, 0);
});

test("passes timeout, signal, and append-only output to executor", async () => {
  const controller = new AbortController();
  const chunks: string[] = [];
  const tool = createShellTool({
    workspaceRoot: process.cwd(),
    interaction: {
      beginShell(request) { assert.equal(request.displayCommand, true); },
      writeShellOutput(chunk) { chunks.push(chunk); },
    },
    async execute(options) {
      assert.equal(options.timeoutSeconds, 5);
      assert.equal(options.signal, controller.signal);
      options.onOutput?.("line\n");
      return success;
    },
  });
  await tool.execute({ command: "pwd", timeout: 5 }, controller.signal);
  assert.deepEqual(chunks, ["line\n"]);
});
```

- [ ] **Step 2: Run the tool test and verify it fails**

Run:

```bash
node --import tsx --test test/shell-tool.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/shell/tool.js`.

- [ ] **Step 3: Implement the registered tool**

Create `src/shell/tool.ts`:

```ts
import type { RegisteredTool } from "../tool-registry.js";
import { classifyShellCommand, parseShellRequest } from "./command-policy.js";
import { executeShellCommand, type ExecuteShellOptions } from "./executor.js";
import {
  DEFAULT_SHELL_INTERACTION,
  type ShellExecutionResult,
  type ShellInteraction,
} from "./types.js";

interface CreateShellToolOptions {
  workspaceRoot: string;
  interaction?: ShellInteraction;
  execute?: (options: ExecuteShellOptions) => Promise<ShellExecutionResult>;
}

function failure(code: "COMMAND_DENIED" | "USER_REJECTED", error: string) {
  return { ok: false, code, error };
}

export function createShellTool({
  workspaceRoot,
  interaction = DEFAULT_SHELL_INTERACTION,
  execute = executeShellCommand,
}: CreateShellToolOptions): RegisteredTool {
  return {
    definition: {
      name: "shell",
      description: "在当前可信工作区运行命令。简单读取、测试和类型检查可自动执行；其他命令可能需要用户逐次确认。",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的完整 Bash 命令。" },
          timeout: { type: "number", description: "可选超时秒数，默认 60，最大 300。" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    riskLevel: "execute",
    async execute(args, signal) {
      const request = parseShellRequest(args);
      const decision = classifyShellCommand(request.command, workspaceRoot);
      if (decision.kind === "deny") {
        return failure("COMMAND_DENIED", decision.reason);
      }
      if (decision.kind === "confirm") {
        const allowed = await interaction.confirmShell?.({
          command: request.command,
          reason: decision.reason,
        }, signal) ?? false;
        if (!allowed) return failure("USER_REJECTED", "用户拒绝执行该命令。");
      }
      signal?.throwIfAborted();
      interaction.beginShell?.({
        command: request.command,
        displayCommand: decision.kind === "auto",
      });
      return await execute({
        command: request.command,
        cwd: workspaceRoot,
        timeoutSeconds: request.timeoutSeconds,
        signal,
        onOutput: (chunk) => interaction.writeShellOutput?.(chunk),
      });
    },
  };
}
```

Ensure `parseShellRequest` failures become structured `{ ok:false, code:"INVALID_ARGUMENT", error }` records inside the Shell tool, rather than losing the code in the generic registry catch.

- [ ] **Step 4: Register Shell only when a workspace exists**

Modify `src/tools.ts`:

```ts
import { createShellTool } from "./shell/tool.js";
import type { ShellInteraction } from "./shell/types.js";

interface ToolOptions {
  // existing fields stay unchanged
  toolInteraction?: ToolInteraction & ShellInteraction;
}

if (workspaceRoot) {
  registeredTools.push(
    ...createCodeTools({ workspaceRoot, interaction: toolInteraction }),
    createShellTool({ workspaceRoot, interaction: toolInteraction }),
  );
}
```

Because `ShellInteraction` methods are optional, existing `ToolInteraction` test doubles remain assignable.

Also update the type-only imports and `ConversationOptions.toolInteraction` in `src/agent.ts` to `ToolInteraction & ShellInteraction`; no Agent behavior changes in this task.

- [ ] **Step 5: Add registry assertions**

Extend `test/tools.test.ts` so the workspace test includes `shell` and verifies:

```ts
assert.ok(names.includes("shell"));
assert.equal(tools.getRiskLevel("shell"), "execute");
```

Also keep the no-workspace test unchanged: it must not expose `shell`.

- [ ] **Step 6: Run focused tests and type checking**

Run:

```bash
node --import tsx --test test/shell-command-policy.test.ts test/shell-tool.test.ts test/tools.test.ts
npm run check
```

Expected: all focused tests PASS and TypeScript exits `0`.

- [ ] **Step 7: Checkpoint**

Record Task 4 as complete. Do not initialize Git.

---

### Task 5: CLI approval, append-only display, and activity copy

**Files:**

- Modify: `src/tool-interaction.ts`
- Modify: `src/activity-indicator.ts`
- Modify: `test/tool-interaction.test.ts`
- Modify: `test/activity-indicator.test.ts`

- [ ] **Step 1: Add failing interaction tests**

Extend `test/tool-interaction.test.ts`:

```ts
test("shows a sanitized Shell command and accepts only one y", async () => {
  const prompts: string[] = [];
  let paused = 0;
  const interaction = createToolInteraction({
    input: {
      isInteractive: true,
      async ask(message) { prompts.push(message); return "y"; },
      async askSecret() { return undefined; },
      close() {},
    },
    activity: { handle() {}, pause() { paused += 1; }, dispose() {} },
    output: { write() {} },
    useColor: false,
  });
  assert.equal(await interaction.confirmShell?.({
    command: "npm install\u001b[31m",
    reason: "安装依赖\u009b",
  }), true);
  assert.equal(paused, 1);
  assert.match(prompts.join(""), /\$ npm install/);
  assert.match(prompts.join(""), /安装依赖/);
  assert.doesNotMatch(prompts.join(""), /[\u001b\u0080-\u009f]/);
});

test("non-interactive Shell confirmation denies without prompting", async () => {
  const interaction = createToolInteraction({
    input: {
      isInteractive: false,
      async ask() { throw new Error("must not ask"); },
      async askSecret() { return undefined; },
      close() {},
    },
    activity: { handle() {}, pause() {}, dispose() {} },
    output: { write() {} },
    useColor: false,
  });
  assert.equal(await interaction.confirmShell?.({ command: "npm install", reason: "依赖变更" }), false);
});

test("starts Shell output once and appends sanitized chunks", () => {
  let output = "";
  let paused = 0;
  const interaction = createInteraction({
    onPause() { paused += 1; },
    onWrite(chunk) { output += chunk; },
  });
  interaction.beginShell?.({ command: "pwd", displayCommand: true });
  interaction.writeShellOutput?.("ok\u001b[31m\rnext\n");
  assert.equal(paused, 1);
  assert.match(output, /\$ pwd/);
  assert.match(output, /ok/);
  assert.doesNotMatch(output, /\u001b/);
});
```

Terminal byte and line limits are already tested and enforced by `src/shell/output.ts`; do not duplicate that state in `ToolInteraction`.

- [ ] **Step 2: Add failing Shell activity-copy tests**

Extend `test/activity-indicator.test.ts`:

```ts
test("uses dedicated Shell running and completion copy", () => {
  let written = "";
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: false,
    useColor: false,
    getAnimation: () => "americano",
    now: sequenceClock(0, 500),
  });
  renderer.handle({ name: "shell", phase: "start" });
  renderer.handle({ name: "shell", phase: "success" });
  assert.match(written, /正在运行命令/);
  assert.match(written, /命令执行已经完成/);
  assert.match(written, /0\.5s/);
});
```

- [ ] **Step 3: Run the two tests and verify failures**

Run:

```bash
node --import tsx --test test/tool-interaction.test.ts test/activity-indicator.test.ts
```

Expected: FAIL because `confirmShell`, `beginShell`, `writeShellOutput`, and dedicated Shell copy are absent.

- [ ] **Step 4: Implement the local Shell interaction**

Change the return type of `createToolInteraction` to:

```ts
ToolInteraction & ShellInteraction
```

Import the Shell contract from `src/shell/types.ts`, then add:

```ts
async confirmShell(request, signal) {
  if (!input.isInteractive) return false;
  signal?.throwIfAborted();
  activity.pause();
  return await askConfirmation(
    "Coffee 准备执行命令\n\n$ " +
      sanitizeTerminalLabel(request.command) +
      "\n\n原因：" +
      sanitizeTerminalLabel(request.reason) +
      "\n仅允许本次执行？",
    signal,
  );
},
beginShell(request) {
  activity.pause();
  if (request.displayCommand) {
    output.write("\n$ " + sanitizeTerminalLabel(request.command) + "\n\n");
  }
},
writeShellOutput(chunk) {
  output.write(sanitizeTerminalText(chunk));
},
```

The output processor supplies already bounded chunks; the CLI performs defense-in-depth control-character cleaning and writes them once. Never emit cursor-up sequences.

- [ ] **Step 5: Add dedicated Shell copy**

Modify the two functions in `src/activity-indicator.ts`:

```ts
if (toolName === "shell") return "正在运行命令…";
```

and:

```ts
if (toolName === "shell") {
  return succeeded ? "命令执行已经完成" : "命令执行暂时失败";
}
```

- [ ] **Step 6: Run interaction, activity, and type tests**

Run:

```bash
node --import tsx --test test/tool-interaction.test.ts test/activity-indicator.test.ts test/shell-tool.test.ts
npm run check
```

Expected: all tests PASS and TypeScript exits `0`.

- [ ] **Step 7: Checkpoint**

Record Task 5 as complete. Do not initialize Git.

---

### Task 6: Agent prompt, tool-loop continuation, and SIGINT integration

**Files:**

- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`
- Modify: `test/streaming-fetch.mjs`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Update the failing capability test**

Change the first workspace capability test in `test/agent.test.ts` to require `shell` and accurate instructions:

```ts
for (const name of [
  "ls", "find", "grep", "read", "edit", "write", "set_env", "shell",
]) {
  assert.ok(names.includes(name), name);
}
assert.match(systemMessage.content, /shell/);
assert.match(systemMessage.content, /测试/);
assert.match(systemMessage.content, /当前工作区/);
assert.doesNotMatch(systemMessage.content, /没有 bash、自动测试或构建能力/);
```

- [ ] **Step 2: Add an Agent Shell continuation test**

Add a test using a temporary workspace and an auto `pwd` call:

```ts
test("executes a Shell tool result and continues the model round", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coffee-agent-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = createFakeGateway([
    () => ({
      content: "",
      toolCalls: [{ id: "call-shell", name: "shell", argumentsJson: '{"command":"pwd"}' }],
    }),
    reply("测试命令已经执行。"),
  ]);
  const conversation = createConversation(conversationOptions(gateway, { workspaceRoot: root }));
  assert.equal(await conversation.send("运行 pwd"), "测试命令已经执行。");
  const toolMessage = gateway.requests[1]!.messages.at(-1)!;
  assert.equal(toolMessage.role, "tool");
  assert.match(toolMessage.content, /"exitCode":0/);
  assert.match(toolMessage.content, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
```

Add a denied-command test where the first model response calls `sudo npm test`; assert the next provider request receives `COMMAND_DENIED` and no confirmation callback runs.

- [ ] **Step 3: Run Agent tests and verify capability failures**

Run:

```bash
node --import tsx --test test/agent.test.ts
```

Expected: FAIL because the system prompt still denies Shell capability or the tool is not fully wired.

- [ ] **Step 4: Update the workspace system prompt**

Modify `createSystemPrompt()` in `src/agent.ts`:

```ts
return SYSTEM_PROMPT + "\n\n运行环境：\n" +
  "- 当前工作区：" + JSON.stringify(root) + "\n" +
  "- 可用本地工具：read、ls、find、grep、edit、write、set_env、shell。\n" +
  "- 修改前先读取文件；优先使用小范围 edit。\n" +
  "- shell 始终在当前工作区运行；简单读取、测试和类型检查可能自动执行，其他命令需要用户确认。\n" +
  "- 只有收到 exitCode 0 或明确成功结果后，才能声称测试或命令执行成功。\n" +
  "- 工具失败、命令被禁止或用户拒绝时必须如实说明。";
```

- [ ] **Step 5: Add deterministic CLI Shell SSE scenarios**

Extend `test/streaming-fetch.mjs` with:

- `shell-auto`: first request streams a `shell` tool call with `{"command":"pwd"}`, second request returns final text.
- `shell-confirm`: read a basename from `COFFEE_TEST_SHELL_MARKER_NAME`, validate it with `/^[A-Za-z0-9._-]+$/`, then make the first request call `shell` with `{"command":"touch <basename>"}`. The harness answers `n`; the test asserts the marker was not created and removes it in cleanup even if the assertion fails.
- `shell-hang`: first request calls `shell` with a long-running Node command that writes its PID to `COFFEE_TEST_SHELL_PID_PATH` and then stays alive; the CLI harness sends SIGINT after observing a stable `SHELL_STARTED` output line.

Use the same OpenAI-compatible streamed `tool_calls` shape already used by the existing `tool` scenario. Keep all scenarios local and deterministic; never invoke a real model or package registry.

- [ ] **Step 6: Add CLI end-to-end assertions**

Extend `test/cli.test.ts` with tests that assert:

```ts
assert.equal(result.code, 0);
assert.match(result.stdout, /\$ pwd/);
assert.equal(result.stdout.split("$ pwd").length - 1, 1);
assert.match(result.stdout, /命令执行已经完成/);
assert.doesNotMatch(result.stderr, /AbortError|node:internal\/readline/);
```

For the confirmation scenario, assert the complete command and reason appear, `n` returns a `USER_REJECTED` tool result to the second model request, and no dependency files change.

For SIGINT, read the fixture PID, poll for at most one second, and assert it is no longer alive. Also assert Coffee exits with code `0`, does not duplicate `SHELL_STARTED`, and leaves no readline/AbortError stack.

- [ ] **Step 7: Run Agent and CLI tests**

Run:

```bash
node --import tsx --test test/agent.test.ts test/cli.test.ts
```

Expected: all tests PASS; CLI fixtures exit; no child process remains alive.

- [ ] **Step 8: Checkpoint**

Record Task 6 as complete. Do not initialize Git.

---

### Task 7: Documentation and full regression verification

**Files:**

- Modify: `README.md`
- Verify: all `src/**/*.ts` and `test/**/*.ts`

- [ ] **Step 1: Update the README capability summary**

In `README.md`:

- Change the introduction to mention local code editing and project command/test execution.
- In “本地代码工具”, add `shell` and remove the sentence claiming Coffee has no bash or test ability.
- Document the three risk levels with concrete examples: `npm test` auto, `npm install` asks once, `sudo` denied.
- State that commands always start in the detected workspace and the model cannot supply `cwd`.
- State that the policy is not an OS sandbox and trusted project scripts can run arbitrary code.
- State default 60-second and maximum 300-second timeout.
- State that child processes do not inherit model/Tavily credential environment variables.
- State that output is append-only, sanitized, and truncated before entering model context.

Use this concise example:

```text
You> 修复类型错误并运行测试
Coffee> 修改代码
Coffee> 自动运行 npm test
Coffee> 根据失败结果继续修复并再次验证
```

- [ ] **Step 2: Run every new focused test**

Run:

```bash
node --import tsx --test \
  test/shell-command-policy.test.ts \
  test/shell-output.test.ts \
  test/shell-executor.test.ts \
  test/shell-tool.test.ts \
  test/tool-interaction.test.ts \
  test/activity-indicator.test.ts \
  test/tools.test.ts \
  test/agent.test.ts \
  test/cli.test.ts
```

Expected: all focused tests PASS with zero leaked child processes.

- [ ] **Step 3: Run the full Coffee test suite**

Run:

```bash
npm test
```

Expected: every existing and new test passes; exit code `0`.

- [ ] **Step 4: Run the TypeScript check**

Run:

```bash
npm run check
```

Expected: `tsc --noEmit` exits `0` with no diagnostics.

- [ ] **Step 5: Perform a final scope and secret audit**

Run:

```bash
rg -n "DEEPSEEK_API_KEY|TAVILY_API_KEY|API_KEY|TOKEN|SECRET" src/shell test/shell-*.test.ts
rg -n "TODO|TBD|shell: true|cwd.*args|fullOutputPath" src/shell README.md
```

Expected:

- credential names appear only in filtering/tests, never as literal credential values;
- no TODO/TBD remains;
- no `shell: true` is used;
- the tool schema has no caller-controlled `cwd`;
- no persistent full-output path is introduced.

- [ ] **Step 6: Final checkpoint**

Mark the plan complete only after fresh `npm test` and `npm run check` evidence is available. Report exact pass counts and any platform-specific skipped tests. Do not claim a Git commit because no repository exists.
