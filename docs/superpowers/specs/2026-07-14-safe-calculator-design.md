# Coffee 安全计算器设计

## 目标

为 Coffee 增加模型无关工具 `calculator`，使 Agent 能够精确计算基础算术表达式，避免语言模型直接心算造成错误。

首版使用 `mathjs` 解析表达式，但只开放数字、基础运算符和括号。它不是 Python 代码解释器，也不开放 mathjs 的变量、函数、单位、矩阵或符号计算能力。

## 工具定义

注册第四个模型无关工具：

```ts
{
  definition: {
    name: "calculator",
    description: "精确计算基础算术表达式，支持加减乘除、取余、小数、正负号和括号。",
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
}
```

注册顺序为：

```text
web_search
web_fetch
get_current_location
calculator
```

`riskLevel` 只供本地注册表使用，不发送给 DeepSeek 或后续模型提供商。

## 输入与复杂度限制

计算前依次校验：

1. `expression` 必须是字符串，去除两端空格后不能为空。
2. 表达式长度不得超过 200 个 JavaScript 字符。
3. 使用 mathjs 将表达式解析为语法树。
4. 整棵语法树不得超过 100 个节点。
5. 只允许以下节点：
   - `ConstantNode`：值必须是有限实数。
   - `OperatorNode`：二元运算只允许 `+`、`-`、`*`、`/`、`%`，一元运算只允许正号和负号；运算符的参数数量必须与这两种形式匹配，并拒绝 mathjs 标记为 `isPercentage` 的一元百分比节点。
   - `ParenthesisNode`。
6. 拒绝其他所有节点，包括变量、赋值、函数调用、数组、矩阵、对象、属性访问、范围、条件、关系表达式和代码块。

首版不支持 `^`、`sqrt`、`sin`、`log`、百分号语义、单位换算或隐式变量。这里的 `%` 仅表示取余运算，例如 `10 % 3` 返回 `1`。

## 计算流程

通过校验后，对已经解析并验证过的节点调用 `node.compile().evaluate(new Map())`，不再次解析原始字符串，也不创建会保存状态的 mathjs Parser。

计算时传入一个新的空 `Map` 作为 scope。每次工具调用彼此独立，不能保存变量或函数。

成功返回：

```json
{
  "ok": true,
  "expression": "(128 * 37) / 2",
  "result": 2368
}
```

结果必须是 JavaScript `number` 且为有限实数。以下结果返回工具错误：

- `Infinity` 或 `-Infinity`，例如除以零。
- `NaN`。
- 复数、BigNumber、Fraction、Unit、Matrix 或其他 mathjs 类型。

## 安全边界

不直接对模型输入调用 JavaScript `eval()` 或 `new Function()`。

mathjs 官方说明其表达式解析器不使用 JavaScript `eval`，但任意表达式仍可能带来安全和稳定性风险。因此 Coffee 在求值前执行语法树白名单，并限制输入长度和节点数量：

- <https://mathjs.org/docs/expressions/security.html>
- <https://mathjs.org/docs/expressions/parsing.html>

首版不增加子进程或 Worker 隔离。由于只允许最多 100 个基础算术节点，复杂矩阵、递归函数、超大集合和用户定义函数均无法进入执行阶段。若以后开放科学函数、矩阵或任意代码，需要重新设计资源隔离，不能沿用本阶段的安全结论。

## 错误处理

以下情况抛出中文工具错误，并由现有工具注册表转换为 `ok: false` JSON：

- 缺少、为空或超长的表达式。
- mathjs 无法解析表达式。
- 语法树节点过多。
- 使用未允许的节点或运算符。
- 除以零或结果不是有限实数。
- mathjs 在解析、编译或求值阶段抛出异常。

错误结果不包含调用栈或内部对象。

## 活动动画

为 `calculator` 增加专属状态文案：

```text
冰美式正在研磨数字…
热拿铁正在研磨数字…
✓ 计算结果已经出炉 · 0.1s
✗ 这次计算没有成功 · 0.1s
```

动画帧、颜色、刷新频率和 `/like` 偏好保持不变。

## 文件边界

新增 `src/calculator.ts`：

- 封装表达式校验、语法树白名单和求值。
- 不依赖 Tavily、网络或模型适配器。

修改 `src/tools.ts`：

- 注册 `calculator` 为 `compute` 工具。
- 调用 `src/calculator.ts`，不在注册表中堆叠解析细节。

修改 `src/activity-indicator.ts`：

- 增加计算开始、成功和失败文案。

修改 `package.json` 和锁文件：

- 增加 `mathjs` 运行时依赖。

不修改工具注册表、模型适配器、CLI、设置文件或 Agent 的五轮工具循环。

## 测试

新增 `test/calculator.test.ts`，覆盖：

- 加减乘除、取余、小数、负数和嵌套括号。
- 运算优先级。
- 空输入和超过 200 字符的输入。
- 无效语法。
- 变量、赋值、函数、数组、矩阵、单位、乘方和其他未允许节点。
- 超过 100 个语法树节点。
- 除以零和非有限结果。

更新 `test/tools.test.ts`，覆盖：

- 四个工具的注册顺序及 `calculator` 的 `compute` 风险等级。
- 工具参数、成功结果和错误 JSON。

更新 `test/activity-indicator.test.ts`，覆盖计算开始、成功和失败文案。

更新 `test/agent.test.ts`，确认模型请求包含 OpenAI-compatible 的 `calculator` 定义，但不包含 `riskLevel`。

最后运行：

```bash
npm test
npm run check
npm ls --depth=0
```

验收标准是全部测试通过、`mathjs` 是唯一新增的直接依赖，并且现有搜索、网页读取、定位、命令、动画和退出行为没有回归。

## 后续阶段

安全计算器验收后，再单独设计任务管控中的 Finish 终止或人工询问（HITL）。科学函数、Python 代码解释器和单位换算不在本阶段提前实现。
