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

test("rejects division results that are not finite real numbers", () => {
  for (const expression of ["1 / 0", "0 / 0"]) {
    assert.throws(
      () => calculateExpression({ expression }),
      /结果必须是有限实数/,
    );
  }
});
