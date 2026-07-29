# Coffee Global Command and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register a global `coffee` development command that preserves the caller directory, loads Coffee's own `.env`, and exposes the enclosing Git repository root as the current workspace.

**Architecture:** A small JavaScript bin entry locates the Coffee installation and boots the existing TypeScript CLI through the package-local `tsx`. A focused workspace module resolves `process.cwd()` to a real Git root with a current-directory fallback; the CLI displays that root and passes it into the conversation system context. Coffee-owned settings, credentials, and history remain in their existing locations.

**Tech Stack:** Node.js 22, TypeScript, `tsx`, npm `bin`/`npm link`, Git CLI, Node test runner.

---

## File map

- Create `bin/coffee.js`: npm executable entry; locate the package and load the TypeScript launcher with package-local `tsx`.
- Create `src/launcher.ts`: load `<coffee-root>/.env` and then start the existing CLI.
- Create `src/workspace.ts`: detect and normalize the Git workspace root.
- Create `test/launcher.test.ts`: verify application-root `.env` selection and missing-file behavior.
- Create `test/workspace.test.ts`: verify Git-root detection, fallback, real paths, and spaces.
- Modify `src/cli.ts`: resolve the workspace once, pass it to the banner and conversation.
- Modify `src/agent.ts`: add the workspace to the generated system prompt.
- Modify `src/startup-banner.ts`: show the workspace in wide and compact startup output.
- Modify `test/agent.test.ts`: verify workspace context reaches the model request.
- Modify `test/startup-banner.test.ts`: verify workspace display.
- Modify `package.json`: register `coffee` and route `npm start` through the same launcher.
- Modify `README.md`: document `npm link`, global use, workspace selection, and unlinking.

The `coffee` directory has no `.git`, so this plan must not initialize a repository or create commits. Each task ends with a verification checkpoint instead.

### Task 1: Resolve the current workspace

**Files:**
- Create: `src/workspace.ts`
- Create: `test/workspace.test.ts`

- [ ] **Step 1: Write the failing workspace tests**

Create `test/workspace.test.ts` with real temporary directories and a real temporary Git repository:

```ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolveWorkspaceRoot } from "../src/workspace.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

test("resolves a Git subdirectory to the repository root", async (t) => {
  const repository = await temporaryDirectory("coffee workspace ");
  t.after(() => rm(repository, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: repository });
  const nested = path.join(repository, "src", "feature");
  await mkdir(nested, { recursive: true });

  assert.equal(
    await resolveWorkspaceRoot(nested),
    await realpath(repository),
  );
});

test("uses the current real directory when Git discovery fails", async (t) => {
  const directory = await temporaryDirectory("coffee fallback ");
  t.after(() => rm(directory, { recursive: true, force: true }));

  assert.equal(
    await resolveWorkspaceRoot(directory, async () => {
      throw new Error("git unavailable");
    }),
    await realpath(directory),
  );
});

test("normalizes a discovered workspace containing spaces", async (t) => {
  const directory = await temporaryDirectory("coffee spaced workspace ");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nested = path.join(directory, "nested folder");
  await mkdir(nested, { recursive: true });

  assert.equal(
    await resolveWorkspaceRoot(nested, async () => directory),
    await realpath(directory),
  );
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
node --import tsx --test test/workspace.test.ts
```

Expected: FAIL with `Cannot find module '../src/workspace.js'`.

- [ ] **Step 3: Implement the minimal workspace resolver**

Create `src/workspace.ts`:

```ts
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRootLookup = (directory: string) => Promise<string | undefined>;

async function findGitRoot(directory: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: directory, encoding: "utf8" },
  );
  const root = stdout.trim();
  return root || undefined;
}

export async function resolveWorkspaceRoot(
  startDirectory = process.cwd(),
  lookupGitRoot: GitRootLookup = findGitRoot,
): Promise<string> {
  const realStartDirectory = await realpath(startDirectory);
  let discoveredRoot: string | undefined;
  try {
    discoveredRoot = await lookupGitRoot(realStartDirectory);
  } catch {
    discoveredRoot = undefined;
  }
  if (!discoveredRoot) return realStartDirectory;
  const candidate = path.isAbsolute(discoveredRoot)
    ? discoveredRoot
    : path.resolve(realStartDirectory, discoveredRoot);
  return await realpath(candidate);
}
```

- [ ] **Step 4: Run workspace tests and type checking**

Run:

```bash
node --import tsx --test test/workspace.test.ts
npm run check
```

Expected: 3 tests PASS and TypeScript exits with code 0.

- [ ] **Step 5: Verification checkpoint**

Confirm only `src/workspace.ts` and `test/workspace.test.ts` were added for this task. No Git commit is possible because the project is not a repository.

### Task 2: Add the package-local executable launcher

**Files:**
- Create: `bin/coffee.js`
- Create: `src/launcher.ts`
- Create: `test/launcher.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing launcher tests**

Create `test/launcher.test.ts`:

```ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCoffeeEnvironment } from "../src/launcher.js";

test("loads .env from the supplied Coffee application root", async (t) => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "coffee app "));
  t.after(() => rm(appRoot, { recursive: true, force: true }));
  const loadedPaths: string[] = [];

  loadCoffeeEnvironment(appRoot, (filePath) => {
    loadedPaths.push(filePath);
  });

  assert.deepEqual(loadedPaths, [path.join(appRoot, ".env")]);
});

test("ignores a missing application .env file", () => {
  assert.doesNotThrow(() =>
    loadCoffeeEnvironment("/missing/coffee", () => {
      const error = new Error("missing") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }),
  );
});

test("preserves non-ENOENT environment loading errors", () => {
  assert.throws(
    () =>
      loadCoffeeEnvironment("/broken/coffee", () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    /permission denied/,
  );
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test test/launcher.test.ts
```

Expected: FAIL with `Cannot find module '../src/launcher.js'`.

- [ ] **Step 3: Implement environment loading and TypeScript startup**

Create `src/launcher.ts`:

```ts
import path from "node:path";

type LoadEnvFile = (filePath: string) => void;

export function loadCoffeeEnvironment(
  appRoot: string,
  loadEnvFile: LoadEnvFile = process.loadEnvFile.bind(process),
): void {
  try {
    loadEnvFile(path.join(appRoot, ".env"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function launchCoffee(appRoot: string): Promise<void> {
  loadCoffeeEnvironment(appRoot);
  await import("./cli.js");
}
```

Create `bin/coffee.js`:

```js
#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { launchCoffee } = await tsImport(
  path.join(appRoot, "src", "launcher.ts"),
  import.meta.url,
);
await launchCoffee(appRoot);
```

Make the bin entry executable:

```bash
chmod 755 bin/coffee.js
```

- [ ] **Step 4: Register the command in `package.json`**

Add the top-level `bin` field and route the existing start script through it. The complete resulting file is:

```json
{
  "name": "coffee-agent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "coffee": "./bin/coffee.js"
  },
  "scripts": {
    "start": "node bin/coffee.js",
    "test": "node --import tsx --test test/*.test.ts",
    "check": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22.19.0 <27"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "22.20.1",
    "tsx": "4.23.1",
    "typescript": "7.0.2"
  },
  "dependencies": {
    "@inquirer/core": "^11.2.1",
    "better-sqlite3": "^12.10.0",
    "mathjs": "^15.2.0",
    "string-width": "^8.2.2"
  }
}
```

Do not change dependency versions or the Node engine range.

- [ ] **Step 5: Run launcher tests and checks**

Run:

```bash
node --import tsx --test test/launcher.test.ts
npm run check
```

Expected: 3 tests PASS and TypeScript exits with code 0.

- [ ] **Step 6: Verification checkpoint**

Confirm the executable mode is present with `stat -f '%Sp %N' bin/coffee.js` and that no unrelated package metadata changed.

### Task 3: Display and propagate the workspace

**Files:**
- Modify: `src/startup-banner.ts`
- Modify: `test/startup-banner.test.ts`
- Modify: `src/agent.ts`
- Modify: `test/agent.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Add failing startup-banner expectations**

Update every `renderStartupBanner` call in `test/startup-banner.test.ts` to include:

```ts
workspaceRoot: "/Users/test/shop-api",
```

Add these assertions to the wide and compact cases:

```ts
assert.match(output, /Workspace: \/Users\/test\/shop-api/);
```

For the compact case, expect:

```ts
"Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。\nWorkspace: /Users/test/shop-api"
```

- [ ] **Step 2: Run the banner tests and verify failure**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
```

Expected: FAIL because `StartupBannerOptions` has no `workspaceRoot` and output omits the workspace.

- [ ] **Step 3: Implement workspace rendering**

Extend `StartupBannerOptions`:

```ts
export interface StartupBannerOptions {
  isTTY: boolean | undefined;
  columns: number | undefined;
  useColor: boolean;
  workspaceRoot: string;
}
```

Replace `renderStartupBanner` with the following implementation while leaving the logo constants unchanged:

```ts
export function renderStartupBanner({
  isTTY,
  columns,
  useColor,
  workspaceRoot,
}: StartupBannerOptions): string {
  const workspaceLine = `Workspace: ${workspaceRoot}`;
  if (
    isTTY !== true ||
    columns === undefined ||
    !Number.isFinite(columns) ||
    columns < FULL_BANNER_WIDTH
  ) {
    return `${COMPACT_STARTUP}\n${workspaceLine}`;
  }

  return [
    paint(LOGO, ANSI.cyan, useColor),
    "",
    paint(SUBTITLE, ANSI.gray, useColor),
    "",
    ...COFFEE_ROWS.map(
      ([left, gap, right]) =>
        `${paint(left, ANSI.blue, useColor)}${gap}${paint(right, ANSI.yellow, useColor)}`,
    ),
    "",
    `${paint(FOOTER_STATUS, ANSI.magenta, useColor)}` +
      `${FOOTER_GAP}${paint(FOOTER_HINT, ANSI.gray, useColor)}`,
    paint(workspaceLine, ANSI.gray, useColor),
  ].join("\n");
}
```

Keep `FULL_BANNER_WIDTH` based on the logo and coffee art rather than the dynamic workspace path.

- [ ] **Step 4: Add a failing agent request test**

Extend the `conversationOptions` override type in `test/agent.test.ts`:

```ts
workspaceRoot?: string;
```

Add:

```ts
test("includes the current workspace in the model system context", async () => {
  const gateway = createFakeGateway([reply("ok")]);
  const conversation = createConversation(
    conversationOptions(gateway, {
      workspaceRoot: "/Users/test/shop-api",
    }),
  );

  await conversation.send("检查项目");

  const systemMessage = gateway.requests[0]!.messages[0]!;
  assert.equal(systemMessage.role, "system");
  assert.match(systemMessage.content, /\/Users\/test\/shop-api/);
});
```

- [ ] **Step 5: Run the agent test and verify failure**

Run:

```bash
node --import tsx --test --test-name-pattern="includes the current workspace" test/agent.test.ts
```

Expected: FAIL because `ConversationOptions` does not accept or use `workspaceRoot`.

- [ ] **Step 6: Build a per-conversation system prompt**

Add `workspaceRoot?: string` to `ConversationOptions`. Replace the constant-only use with a helper:

```ts
function createSystemPrompt(workspaceRoot?: string): string {
  const root = workspaceRoot?.trim();
  if (!root) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}\n\n运行环境：\n- 当前工作区：${JSON.stringify(root)}\n- 当前版本没有本地文件工具，不要声称已经读取或修改工作区文件。`;
}
```

At the beginning of `createConversation`, compute:

```ts
const systemPrompt = createSystemPrompt(workspaceRoot);
```

Use this local `systemPrompt` in every `planCompression` and `buildContext` call that currently uses `SYSTEM_PROMPT`.

- [ ] **Step 7: Resolve and pass the workspace from the CLI**

Import `resolveWorkspaceRoot` in `src/cli.ts`. At the beginning of `main`, resolve once:

```ts
const workspaceRoot = await resolveWorkspaceRoot();
```

Pass it into both consumers:

```ts
const conversation = createConversation({
  gateway,
  resolveApiKey,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  session: sessionManager,
  historyPreferences: loadedHistoryPreferences.preferences,
  workspaceRoot,
});

renderStartupBanner({
  isTTY: output.isTTY,
  columns: output.columns,
  useColor,
  workspaceRoot,
});
```

Let a `realpath` failure reach the existing top-level CLI error handling so startup ends with code 1 and a clear error.

- [ ] **Step 8: Run focused and complete verification**

Run:

```bash
node --import tsx --test test/startup-banner.test.ts
node --import tsx --test --test-name-pattern="includes the current workspace" test/agent.test.ts
npm test
npm run check
```

Expected: focused tests PASS, the full suite has zero failures, and TypeScript exits with code 0.

- [ ] **Step 9: Verification checkpoint**

Review the diff-equivalent file list manually and confirm no file or Shell tools were added.

### Task 4: Document and smoke-test `npm link`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the global development command**

After the existing `npm start` command in `README.md`, add:

````markdown
开发阶段也可以注册全局 `coffee` 命令：

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm link
```

之后可以在任意项目目录启动：

```bash
cd /path/to/your/project
coffee
```

Coffee 会保留启动目录：如果当前目录位于 Git 仓库中，使用仓库根目录作为 Workspace；否则使用当前目录。`.env` 仍从 Coffee 安装目录加载，API Key、设置和对话历史继续使用 Coffee 自身的存储位置。当前版本没有本地文件或 Shell 工具，因此只识别和展示 Workspace，不会读取或修改其中的文件。

移除开发链接：

```bash
npm unlink --global coffee-agent
```
````

- [ ] **Step 2: Register the real global link**

Run:

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm link
```

Expected: npm exits with code 0 and reports one linked package.

- [ ] **Step 3: Verify the command path**

Run:

```bash
command -v coffee
```

Expected: prints a path in the active Node/npm global bin directory.

- [ ] **Step 4: Smoke-test from a nested Git directory without API calls**

Run `coffee` from the Pi repository and immediately exit:

```bash
cd /Users/sevan/ai-tasks/pi-agent/pi/packages/agent
printf '/exit\n' | coffee
```

Expected: exit code 0, no network request, and output contains:

```text
Workspace: /Users/sevan/ai-tasks/pi-agent/pi
```

- [ ] **Step 5: Final verification**

Run:

```bash
cd /Users/sevan/ai-tasks/pi-agent/coffee
npm test
npm run check
```

Expected: all tests PASS and TypeScript exits with code 0. Leave the `npm link` installed because the requested outcome is a usable global `coffee` command.
