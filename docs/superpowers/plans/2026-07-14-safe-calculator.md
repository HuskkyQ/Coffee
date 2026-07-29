# Safe Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a model-neutral `calculator` tool that uses mathjs 15.2.0 to evaluate only bounded basic arithmetic expressions.

**Architecture:** A new isolated `calculator.ts` module parses expressions with mathjs, validates the entire syntax tree against a strict node and operator whitelist, and evaluates the already-validated node with a fresh empty scope. `tools.ts` registers this function as a local `compute` tool; the existing OpenAI-compatible adapter exposes it to DeepSeek without leaking risk metadata, and the activity renderer supplies dedicated progress copy.

**Tech Stack:** TypeScript, Node.js 22, mathjs 15.2.0, Node test runner.

---

This directory is not a Git repository, so worktree and commit steps are intentionally omitted.

### Task 1: Dependency and arithmetic core

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/calculator.ts`
- Create: `test/calculator.test.ts`

- [x] **Step 1: Install the approved mathjs dependency**

Run:

```bash
npm install mathjs@15.2.0
```

Expected: `mathjs` appears under `dependencies` in `package.json`, the lock file records version 15.2.0, and no unrelated direct dependency changes.

- [x] **Step 2: Write the first failing arithmetic test**

Create `test/calculator.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import { calculateExpression } from "../src/calculator.js";

test("calculates supported basic arithmetic with normal precedence", () => {
  const cases: Array<{ expression: string; result: number }> = [
    { expression: "1 + 2 * 3", result: 7 },
    { expression: "(1 + 2) * 3", result: 9 },
    { expression: "10 % 3", result: 1 },
    { expression: "-2.5 + +4", result: 1.5 },
    { expression: "20 / 4", result: 5 },
  ];

  for (const item of cases) {
    assert.deepEqual(calculateExpression(item), {
      ok: true,
      expression: item.expression,
      result: item.result,
    });
  }
});
```

- [x] **Step 3: Run the focused test and verify the first red state**

Run:

```bash
node --import tsx --test test/calculator.test.ts
```

Expected: FAIL because `src/calculator.ts` does not exist. This confirms the test targets the missing feature.

- [x] **Step 4: Create the minimal calculator API**

Create `src/calculator.ts` with a deliberately incomplete implementation:

```ts
export interface CalculatorResult extends Record<string, unknown> {
  ok: true;
  expression: string;
  result: number;
}

export function calculateExpression(
  _args: Record<string, unknown>,
): CalculatorResult {
  throw new Error("calculator 尚未实现。");
}
```

- [x] **Step 5: Re-run the focused test and verify a behavioral red state**

Run:

```bash
node --import tsx --test test/calculator.test.ts
```

Expected: FAIL with `calculator 尚未实现。`, rather than a module-resolution error.

- [x] **Step 6: Implement the minimum arithmetic evaluator**

Replace `src/calculator.ts` with:

```ts
import { parse } from "mathjs";

export interface CalculatorResult extends Record<string, unknown> {
  ok: true;
  expression: string;
  result: number;
}

export function calculateExpression(
  args: Record<string, unknown>,
): CalculatorResult {
  const expression =
    typeof args.expression === "string" ? args.expression.trim() : "";
  const node = parse(expression);
  const result: unknown = node.compile().evaluate(new Map());

  return {
    ok: true,
    expression,
    result: result as number,
  };
}
```

This is only the smallest implementation needed for arithmetic tests. Do not register it as a tool until the safety tests in Task 2 pass.

- [x] **Step 7: Run the focused test and verify the arithmetic core is green**

Run:

```bash
node --import tsx --test test/calculator.test.ts
npm run check
```

Expected: the arithmetic test passes and TypeScript exits 0.

### Task 2: Input limits, syntax-tree whitelist, and finite results

**Files:**
- Modify: `test/calculator.test.ts`
- Modify: `src/calculator.ts`

- [x] **Step 1: Write failing input and parse-error tests**

Append to `test/calculator.test.ts`:

```ts
test("rejects missing, blank, and oversized expressions", () => {
  for (const args of [{}, { expression: "" }, { expression: "   " }]) {
    assert.throws(
      () => calculateExpression(args),
      /缺少非空的 expression 参数/,
    );
  }

  assert.throws(
    () => calculateExpression({ expression: "1".repeat(201) }),
    /不能超过 200 个字符/,
  );
});

test("normalizes invalid mathjs syntax", () => {
  assert.throws(
    () => calculateExpression({ expression: "1 +" }),
    /无法解析表达式/,
  );
});
```

- [x] **Step 2: Run the focused test and verify the validation red state**

Run:

```bash
node --import tsx --test test/calculator.test.ts
```

Expected: the new tests fail because the current implementation exposes raw mathjs errors and has no 200-character check.

- [x] **Step 3: Add input normalization and parse-error handling**

Add constants and helpers near the top of `src/calculator.ts`:

```ts
const MAX_EXPRESSION_LENGTH = 200;

function normalizeExpression(args: Record<string, unknown>): string {
  const expression =
    typeof args.expression === "string" ? args.expression.trim() : "";
  if (!expression) {
    throw new Error("calculator 缺少非空的 expression 参数。");
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new Error("calculator 的 expression 不能超过 200 个字符。");
  }
  return expression;
}
```

Replace expression extraction and parsing inside `calculateExpression` with:

```ts
  const expression = normalizeExpression(args);
  let node;
  try {
    node = parse(expression);
  } catch {
    throw new Error("calculator 无法解析表达式。");
  }
```

Keep the existing compile, evaluate, and return logic after this block.

- [x] **Step 4: Run the focused tests and verify input handling is green**

Run:

```bash
node --import tsx --test test/calculator.test.ts
npm run check
```

Expected: all current calculator tests pass and TypeScript exits 0.

- [x] **Step 5: Write failing syntax-tree whitelist and complexity tests**

Append to `test/calculator.test.ts`:

```ts
test("rejects every unapproved mathjs expression feature", () => {
  const expressions = [
    "x + 1",
    "x = 2",
    "sqrt(4)",
    "[1, 2]",
    "2 cm",
    "2 ^ 3",
    "50%",
    '"coffee"',
  ];

  for (const expression of expressions) {
    assert.throws(
      () => calculateExpression({ expression }),
      /仅支持数字、括号和 \+ - \* \/ % 运算/,
    );
  }
});

test("rejects an arithmetic syntax tree with more than 100 nodes", () => {
  const expression = `${"1+".repeat(50)}1`;
  assert.ok(expression.length <= 200);

  assert.throws(
    () => calculateExpression({ expression }),
    /表达式过于复杂/,
  );
});
```

- [x] **Step 6: Run the focused test and verify the whitelist red state**

Run:

```bash
node --import tsx --test test/calculator.test.ts
```

Expected: unapproved expressions such as `sqrt(4)` evaluate successfully or fail with unrelated errors, and the 101-node expression is not rejected by Coffee's own limit.

- [x] **Step 7: Implement syntax-tree and node-count validation**

Change the mathjs import in `src/calculator.ts` to:

```ts
import {
  isConstantNode,
  isOperatorNode,
  isParenthesisNode,
  parse,
  type MathNode,
  type OperatorNode,
} from "mathjs";
```

Add after `normalizeExpression`:

```ts
const MAX_NODE_COUNT = 100;
const ALLOWED_BINARY_OPERATORS = new Set(["+", "-", "*", "/", "%"]);
const ALLOWED_UNARY_OPERATORS = new Set(["+", "-"]);
const UNSUPPORTED_EXPRESSION_ERROR =
  "calculator 仅支持数字、括号和 + - * / % 运算。";

function assertAllowedTree(root: MathNode): void {
  let nodeCount = 0;

  root.traverse((node) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT) {
      throw new Error("calculator 的表达式过于复杂。");
    }

    if (isConstantNode(node)) {
      const value = node.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(UNSUPPORTED_EXPRESSION_ERROR);
      }
      return;
    }

    if (isParenthesisNode(node)) {
      return;
    }

    if (isOperatorNode(node)) {
      const operator = node as OperatorNode & { isPercentage?: boolean };
      if (operator.isPercentage === true) {
        throw new Error(UNSUPPORTED_EXPRESSION_ERROR);
      }
      const allowedUnary =
        operator.args.length === 1 &&
        ALLOWED_UNARY_OPERATORS.has(operator.op);
      const allowedBinary =
        operator.args.length === 2 &&
        ALLOWED_BINARY_OPERATORS.has(operator.op);
      if (allowedUnary || allowedBinary) {
        return;
      }
    }

    throw new Error(UNSUPPORTED_EXPRESSION_ERROR);
  });
}
```

Call the validator immediately after the parse block in `calculateExpression`:

```ts
  assertAllowedTree(node);
```

- [x] **Step 8: Run the focused tests and verify the whitelist is green**

Run:

```bash
node --import tsx --test test/calculator.test.ts
npm run check
```

Expected: all calculator tests pass and TypeScript exits 0.

- [x] **Step 9: Write the failing non-finite result test**

Append to `test/calculator.test.ts`:

```ts
test("rejects division results that are not finite real numbers", () => {
  for (const expression of ["1 / 0", "0 / 0"]) {
    assert.throws(
      () => calculateExpression({ expression }),
      /结果必须是有限实数/,
    );
  }
});
```

- [x] **Step 10: Run the focused test and verify the result-check red state**

Run:

```bash
node --import tsx --test test/calculator.test.ts
```

Expected: the new test fails because the current implementation returns `Infinity` or `NaN`.

- [x] **Step 11: Validate the evaluated result and normalize evaluation failures**

Replace the direct evaluation and return block in `calculateExpression` with:

```ts
  let result: unknown;
  try {
    result = node.compile().evaluate(new Map());
  } catch {
    throw new Error("calculator 计算失败。");
  }
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error("calculator 的结果必须是有限实数。");
  }

  return {
    ok: true,
    expression,
    result,
  };
```

- [x] **Step 12: Run calculator tests and type checking**

Run:

```bash
node --import tsx --test test/calculator.test.ts
npm run check
```

Expected: all calculator tests pass and TypeScript exits 0.

### Task 3: Model-neutral registration and DeepSeek adapter integration

**Files:**
- Modify: `test/tools.test.ts`
- Modify: `test/agent.test.ts`
- Modify: `src/tools.ts`

- [x] **Step 1: Write failing registry and tool-execution assertions**

Update the registration test in `test/tools.test.ts`:

```ts
test("registers current tools with model-neutral risk levels", () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  assert.deepEqual(
    tools.definitions.map((definition) => definition.name),
    ["web_search", "web_fetch", "get_current_location", "calculator"],
  );
  assert.equal(tools.getRiskLevel("web_search"), "read");
  assert.equal(tools.getRiskLevel("web_fetch"), "read");
  assert.equal(tools.getRiskLevel("get_current_location"), "read");
  assert.equal(tools.getRiskLevel("calculator"), "compute");
  assert.equal(tools.getRiskLevel("missing"), undefined);
});
```

Add to `test/tools.test.ts`:

```ts
test("executes calculator expressions without making a network request", async () => {
  let requested = false;
  const tools = createTools({
    tavilyApiKey: "tvly-test",
    fetchImpl: async () => {
      requested = true;
      return jsonResponse({});
    },
  });

  const result = JSON.parse(
    await tools.execute("calculator", '{"expression":"(8 + 4) / 3"}'),
  );

  assert.deepEqual(result, {
    ok: true,
    expression: "(8 + 4) / 3",
    result: 4,
  });
  assert.equal(requested, false);
});

test("normalizes calculator validation errors as tool failures", async () => {
  const tools = createTools({ tavilyApiKey: "tvly-test" });

  const result = JSON.parse(
    await tools.execute("calculator", '{"expression":"sqrt(4)"}'),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /仅支持数字、括号/);
});
```

- [x] **Step 2: Write the failing DeepSeek tool-definition assertion**

In the existing `executes a DeepSeek web search tool call and returns the final response` test in `test/agent.test.ts`, change the expected count and add the fourth tool assertion:

```ts
assert.equal(firstBody.tools.length, 4);
assert.deepEqual(firstBody.tools[3], {
  type: "function",
  function: {
    name: "calculator",
    description:
      "精确计算基础算术表达式，支持加减乘除、取余、小数、正负号和括号。",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "要计算的基础算术表达式，例如 (128 * 37) / 2。",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
});
assert.equal(JSON.stringify(firstBody.tools).includes("riskLevel"), false);
```

Keep the existing definitions for `web_search` and `web_fetch` unchanged.

- [x] **Step 3: Run integration tests and verify the registration red state**

Run:

```bash
node --import tsx --test test/tools.test.ts test/agent.test.ts
```

Expected: tests fail because `calculator` is not registered and DeepSeek still receives three tools.

- [x] **Step 4: Register the calculator tool**

Add this import to `src/tools.ts`:

```ts
import { calculateExpression } from "./calculator.js";
```

Append this `RegisteredTool` after `get_current_location` in the `registeredTools` array:

```ts
{
  definition: {
    name: "calculator",
    description:
      "精确计算基础算术表达式，支持加减乘除、取余、小数、正负号和括号。",
    inputSchema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "要计算的基础算术表达式，例如 (128 * 37) / 2。",
        },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  riskLevel: "compute",
  async execute(args) {
    return calculateExpression(args);
  },
},
```

Do not change the registry, adapter, or Agent loop; the existing neutral-definition adapter handles the new tool.

- [x] **Step 5: Run integration tests and type checking**

Run:

```bash
node --import tsx --test test/tools.test.ts test/agent.test.ts
npm run check
```

Expected: all focused integration tests pass, TypeScript exits 0, the calculator performs no network request, and `riskLevel` remains absent from model requests.

### Task 4: Calculator activity copy

**Files:**
- Modify: `test/activity-indicator.test.ts`
- Modify: `src/activity-indicator.ts`

- [x] **Step 1: Write failing start, success, and failure copy tests**

Append to `test/activity-indicator.test.ts`:

```ts
test("uses dedicated start and completion copy for calculator", () => {
  let written = "";
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: false,
    useColor: false,
    getAnimation: () => "americano",
    now: sequenceClock(0, 100),
  });

  renderer.handle({ name: "calculator", phase: "start" });
  renderer.handle({ name: "calculator", phase: "success" });

  assert.match(written, /冰美式正在研磨数字/);
  assert.match(written, /✓ 计算结果已经出炉 · 0\.1s/);
});

test("uses dedicated failure copy for calculator", () => {
  let written = "";
  const renderer = createActivityRenderer({
    output: { write(chunk) { written += chunk; } },
    isTTY: false,
    useColor: false,
    getAnimation: () => "latte",
    now: sequenceClock(0, 100),
  });

  renderer.handle({ name: "calculator", phase: "start" });
  renderer.handle({ name: "calculator", phase: "error" });

  assert.match(written, /热拿铁正在研磨数字/);
  assert.match(written, /✗ 这次计算没有成功 · 0\.1s/);
});
```

- [x] **Step 2: Run the focused test and verify the activity red state**

Run:

```bash
node --import tsx --test test/activity-indicator.test.ts
```

Expected: the new tests receive generic tool copy instead of calculator-specific copy.

- [x] **Step 3: Add dedicated calculator activity copy**

In `getActionText()` before the location branch, add:

```ts
if (toolName === "calculator") {
  return "正在研磨数字…";
}
```

In `getCompletionText()` before the location branch, add:

```ts
if (toolName === "calculator") {
  return succeeded ? "计算结果已经出炉" : "这次计算没有成功";
}
```

- [x] **Step 4: Run activity tests and type checking**

Run:

```bash
node --import tsx --test test/activity-indicator.test.ts
npm run check
```

Expected: all activity tests pass and TypeScript exits 0.

### Task 5: Complete verification and scope audit

**Files:**
- Verify: `package.json`
- Verify: `package-lock.json`
- Verify: `src/calculator.ts`
- Verify: `src/tools.ts`
- Verify: `src/activity-indicator.ts`
- Verify: `test/calculator.test.ts`
- Verify: `test/tools.test.ts`
- Verify: `test/activity-indicator.test.ts`
- Verify: `test/agent.test.ts`

- [x] **Step 1: Run the complete verification suite**

Run:

```bash
npm test
npm run check
npm ls --depth=0
```

Expected: zero failed tests, TypeScript exits 0, and the direct dependency list contains existing dependencies plus `mathjs@15.2.0` only.

- [x] **Step 2: Verify the approved safety scope from source and tests**

Run:

```bash
rg -n "MAX_EXPRESSION_LENGTH|MAX_NODE_COUNT|ALLOWED_BINARY_OPERATORS|ALLOWED_UNARY_OPERATORS|new Map|calculator|riskLevel|MAX_TOOL_ROUNDS" src test package.json
```

Confirm from the source and fresh test output that:

- Input is one nonempty expression of at most 200 characters.
- The syntax tree contains at most 100 nodes.
- Only finite numeric constants, parentheses, binary `+ - * / %`, and unary `+ -` reach evaluation.
- Variables, assignments, functions, arrays, matrices, units, powers, strings, and non-finite results are rejected.
- Every evaluation receives a new empty `Map`; no parser state persists between calls.
- `calculator` is classified locally as `compute`, but the model request contains no risk metadata.
- Existing search, WebFetch, location, commands, animations, and the five-round Agent loop remain intact.
- No Python interpreter, scientific functions, unit conversion, Worker, child process, HITL, or Finish behavior was added.

- [x] **Step 3: Confirm repository state**

Run:

```bash
git rev-parse --is-inside-work-tree
```

Expected: exit 128 because `coffee` is not a Git repository. Do not initialize Git or create commits as part of this task.
