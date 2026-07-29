import {
  isConstantNode,
  isOperatorNode,
  isParenthesisNode,
  parse,
  type MathNode,
  type OperatorNode,
} from "mathjs";

const MAX_EXPRESSION_LENGTH = 200;
const MAX_NODE_COUNT = 100;
const ALLOWED_BINARY_OPERATORS = new Set(["+", "-", "*", "/", "%"]);
const ALLOWED_UNARY_OPERATORS = new Set(["+", "-"]);
const UNSUPPORTED_EXPRESSION_ERROR =
  "calculator 仅支持数字、括号和 + - * / % 运算。";

export interface CalculatorResult extends Record<string, unknown> {
  ok: true;
  expression: string;
  result: number;
}

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

export function calculateExpression(
  args: Record<string, unknown>,
): CalculatorResult {
  const expression = normalizeExpression(args);
  let node;
  try {
    node = parse(expression);
  } catch {
    throw new Error("calculator 无法解析表达式。");
  }
  assertAllowedTree(node);
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
}
