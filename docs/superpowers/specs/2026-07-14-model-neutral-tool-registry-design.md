# Coffee 模型无关工具注册表设计

## 目标

把当前 `tools.ts` 中硬编码的工具定义与 `if` 分发改为模型无关的工具注册表，为后续 WebFetch、计算器、HITL 和其他模型接入提供稳定边界。

本阶段是纯重构：Coffee 仍然使用 DeepSeek，仍然只有 `web_search` 和 `get_current_location`，外部请求、工具结果、动画、错误文案和最多 5 轮工具调用行为保持不变。

## 范围

本阶段包含：

- 模型无关的工具定义、风险等级和执行接口。
- 工具名称查找、参数解析、错误序列化与重复名称校验。
- OpenAI-compatible 工具定义适配器，供当前 DeepSeek 请求使用。
- 将现有 Tavily 搜索和 IPWho 定位注册到新注册表。
- 提供风险等级查询接口，但暂不执行权限拦截。

本阶段不包含：

- WebFetch、计算器或其他新工具。
- HITL 确认流程或权限策略引擎。
- 模型选择命令、其他模型客户端或工具调用响应适配器。
- 对 CLI、设置文件或工具动画的改造。

## 模型无关定义

新增 `src/tool-registry.ts`，定义注册表的公共结构：

```ts
export type ToolRiskLevel = "read" | "compute" | "execute" | "write";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  riskLevel: ToolRiskLevel;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface ToolRegistry {
  definitions: readonly ToolDefinition[];
  execute(name: string, argumentsJson: string): Promise<string>;
  getRiskLevel(name: string): ToolRiskLevel | undefined;
}

export function createToolRegistry(
  tools: readonly RegisteredTool[],
): ToolRegistry;
```

`ToolDefinition` 不包含 DeepSeek、OpenAI 或 Anthropic 字段名。`riskLevel` 只存在于本地注册项，不属于发送给模型的定义。

## 注册表行为

`createToolRegistry()` 在创建时构建名称索引，并按输入顺序暴露 definitions。

执行 `registry.execute(name, argumentsJson)` 时：

1. 根据精确名称查找工具。
2. 未找到时返回 `{"ok":false,"error":"未知工具: <name>"}`。
3. 使用 `JSON.parse` 解析参数。
4. 参数不是合法 JSON 对象时返回现有中文错误。
5. 调用注册工具的 `execute(args)`。
6. 将工具返回对象序列化为 JSON 字符串。
7. 工具抛出异常时统一返回 `{"ok":false,"error":"<message>"}`。

注册项名称重复时，`createToolRegistry()` 立即抛出包含重复名称的错误，避免模型看到一个定义但执行到另一个实现。

成功对象由具体工具返回，并继续使用当前扁平格式，例如：

```json
{
  "ok": true,
  "query": "上海咖啡",
  "results": []
}
```

不增加统一的 `data` 包装层，避免改变模型当前收到的工具结果结构。

## 模型适配器

新增 `src/model-adapters/openai-compatible-tools.ts`，只负责定义格式转换：

```ts
export function toOpenAICompatibleTools(
  definitions: readonly ToolDefinition[],
): OpenAICompatibleTool[];
```

转换关系为：

```text
ToolDefinition.name        → function.name
ToolDefinition.description → function.description
ToolDefinition.inputSchema → function.parameters
```

输出格式：

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "...",
    "parameters": {}
  }
}
```

当前 DeepSeek 使用 OpenAI-compatible 工具调用格式，因此 `agent.ts` 在构建请求体前调用该适配器。将来接入 Anthropic 或其他格式时，新增适配器即可，不修改注册表或工具实现。

本阶段不移动 `agent.ts` 中 DeepSeek 响应解析逻辑；未来实现模型选择时，再将请求与响应归一化为独立模型客户端。

## 现有工具迁移

`src/tools.ts` 继续拥有 Tavily 和 IPWho 的请求、校验与响应归一化函数，并在 `createTools()` 中创建两个注册项：

```text
web_search           riskLevel=read
get_current_location riskLevel=read
```

两个执行器从接收 JSON 字符串改为接收已解析的参数对象，并返回普通对象而不是已经序列化的字符串。注册表负责参数解析、异常捕获和最终 JSON 序列化。

`createTools()` 的返回值改为 `ToolRegistry`，因此 `agent.ts` 仍然通过 `tools.execute()` 执行工具，同时通过适配器转换 `tools.definitions` 后发送给 DeepSeek。

## 数据流

```text
createTools(fetch, keys)
        ↓
模型无关 ToolRegistry
   ├── definitions ──→ OpenAI-compatible Adapter ──→ DeepSeek tools
   ├── getRiskLevel ─→ 未来 HITL
   └── execute(name, JSON)
          ↓
      解析参数 → 查找执行器 → Tavily/IPWho → JSON 工具结果
```

## 错误与兼容性

- 无效 JSON、数组参数、空值参数、未知工具和外部服务异常继续返回 `ok: false`，不让异常逃出 Agent 工具循环。
- 缺少 Tavily Key 的启动校验保持不变。
- 工具成功与失败的 `ok` 字段保持不变，Agent 继续用它发送 `success` 或 `error` 活动事件。
- 工具定义的名称、描述、JSON Schema 和发送顺序保持不变。
- `riskLevel` 暂不影响执行，也不发送给 DeepSeek。
- 不新增运行时依赖。

## 测试

新增 `test/tool-registry.test.ts`，覆盖：

- 保持注册顺序并暴露模型无关 definitions。
- 查询四种风险等级中的已注册值。
- 成功执行并序列化返回对象。
- 非法 JSON、非对象参数和未知工具返回失败 JSON。
- 执行器异常转换为失败 JSON。
- 重复名称在创建阶段被拒绝。

新增 `test/openai-compatible-tools.test.ts`，验证字段转换以及 riskLevel 不会进入模型定义。

更新现有 `test/tools.test.ts` 与 `test/agent.test.ts`，确保：

- Tavily 和 IPWho 请求与结果保持原样。
- DeepSeek 请求仍收到两个相同顺序的函数工具。
- 工具生命周期、失败处理和 5 轮上限不变。

最后运行 `npm test` 和 `npm run check`。

## 后续阶段

注册表验收后，按已确认顺序分别设计和实现：

1. WebFetch。
2. 安全计算器。
3. 基于 `riskLevel` 的 HITL。
4. PDF 与 OCR 文档读取。
5. 任务规划、显式长期记忆、只读 SQL 和外部协同。

每个阶段单独规格、单独测试，不在本次注册表重构中预埋未确认的实现。
