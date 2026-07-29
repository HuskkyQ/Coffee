# Coffee SIGINT Exit Implementation Plan

> 状态：不要执行。本计划已被真实终端的 `AbortError` 证据推翻，后续以 CLI polish 设计和计划为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve `/exit` and add graceful Ctrl+C termination with exit code `0` while the Coffee CLI waits for input.

**Architecture:** Extend the existing child-process CLI test helper so it can send `SIGINT` after the prompt appears. In `src/cli.ts`, use one `AbortController` to cancel the pending readline question, translate that known cancellation into a normal return, and remove the process listener during cleanup.

**Tech Stack:** Node.js 22, TypeScript, `node:readline/promises`, `AbortController`, `node:test`.

---

The workspace is not a Git repository. Do not initialize one or add commit steps unless the user asks.

### Task 1: SIGINT Integration Test and CLI Behavior

**Files:**
- Modify: `test/cli.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Extend the CLI test harness and add the failing SIGINT test**

Update `CliResult` and `runCli`:

```ts
interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(
  apiKey: string | undefined,
  input: string,
  interruptWhenReady = false,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    if (apiKey !== undefined) {
      env.DEEPSEEK_API_KEY = apiKey;
    }

    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let interrupted = false;
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (interruptWhenReady && !interrupted && stdout.includes("You>")) {
        interrupted = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (!interruptWhenReady) {
      child.stdin.end(input);
    }
  });
}
```

Add this test after the `/exit` test:

```ts
test("exits cleanly when it receives SIGINT", async () => {
  const result = await runCli("test-key", "", true);

  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
});
```

- [ ] **Step 2: Run the CLI tests and verify RED**

Run: `node --import tsx --test test/cli.test.ts`

Expected: the two existing tests pass; the new SIGINT test fails because the process is terminated by signal, with `code === null` instead of `0`.

- [ ] **Step 3: Add graceful SIGINT handling to the CLI**

Replace the readline setup and loop in `main()` with this version while preserving API-key validation:

```ts
  const readline = createInterface({ input, output });
  const abortController = new AbortController();
  const handleSigint = () => {
    output.write("\n");
    abortController.abort();
  };
  process.once("SIGINT", handleSigint);
  console.log("Coffee CLI 已启动，输入 /exit 或按 Ctrl+C 退出。\n");

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = (
          await readline.question("You> ", { signal: abortController.signal })
        ).trim();
      } catch (error) {
        if (abortController.signal.aborted) {
          return 0;
        }
        throw error;
      }

      if (userInput === "/exit") {
        return 0;
      }
      if (!userInput) {
        continue;
      }

      try {
        const reply = await conversation.send(userInput);
        console.log(`Coffee> ${reply}\n`);
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
      }
    }
  } finally {
    process.off("SIGINT", handleSigint);
    readline.close();
  }
```

- [ ] **Step 4: Run CLI tests and type checking to verify GREEN**

Run: `node --import tsx --test test/cli.test.ts`

Expected: 3 CLI tests pass, including SIGINT with exit code `0` and no stderr.

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

### Task 2: Documentation and Full Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document both exit paths**

Replace the existing sentence after the start command with:

```markdown
在终端中输入消息开始对话，输入 `/exit` 或按 Ctrl+C 退出。
```

- [ ] **Step 2: Run the complete automated test suite**

Run: `npm test`

Expected: 8 tests pass with 0 failures.

- [ ] **Step 3: Run final TypeScript verification**

Run: `npm run check`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 4: Verify the user-facing text and source boundary**

Run: `rg -n "Ctrl\\+C|SIGINT|AbortController" README.md src/cli.ts test/cli.test.ts`

Expected: README mentions Ctrl+C, the CLI registers SIGINT and uses AbortController, and the CLI test sends SIGINT. No file under `../pi` is modified.
