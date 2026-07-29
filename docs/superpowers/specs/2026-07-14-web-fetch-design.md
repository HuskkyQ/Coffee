# Coffee WebFetch 设计

## 目标

为 Coffee 增加只读工具 `web_fetch`，使模型可以在 Tavily 搜索之后读取某个确定网页的 Markdown 正文。

本阶段只支持一次读取一个 HTTPS URL，复用现有 `TAVILY_API_KEY` 和模型无关工具注册表，不增加依赖、批量抓取、图片提取或直接网页下载。

## 工具定义

注册第三个模型无关工具：

```ts
{
  definition: {
    name: "web_fetch",
    description: "读取指定 HTTPS 网页的正文内容，返回清洗后的 Markdown。",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "要读取的完整 HTTPS 网页地址。",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  riskLevel: "read",
}
```

注册顺序为：

```text
web_search
web_fetch
get_current_location
```

## 输入校验

`web_fetch` 在发出网络请求前依次校验：

1. `url` 必须是字符串，去除两端空格后不能为空。
2. URL 长度不得超过 2,048 个字符。
3. `new URL(url)` 必须能够解析。
4. 协议必须严格等于 `https:`。
5. URL 不得包含 `username` 或 `password`。

校验成功后使用 `URL.toString()` 得到规范化 URL。路径、查询参数和 fragment 保持不变。

所有输入校验失败都由工具注册表转换为 `ok: false` JSON，且不得调用 Tavily。

## Tavily Extract 请求

请求端点：

```text
POST https://api.tavily.com/extract
```

请求头：

```text
Authorization: Bearer <TAVILY_API_KEY>
Content-Type: application/json
```

请求体固定为：

```json
{
  "urls": "https://example.com/page",
  "extract_depth": "basic",
  "format": "markdown",
  "include_images": false,
  "timeout": 15
}
```

第一版不让模型控制提取深度、格式、图片或超时时间，避免扩大成本和返回体积。

## 响应处理

响应必须是 JSON 对象，且 `results` 必须是非空数组。读取第一个结果：

- `url` 必须是非空字符串。
- `raw_content` 必须是非空字符串。

正文最大保留 20,000 个 JavaScript 字符。返回格式：

```json
{
  "ok": true,
  "url": "https://example.com/page",
  "content": "Markdown 正文",
  "truncated": false
}
```

当 `raw_content.length > 20000` 时：

- `content` 使用 `raw_content.slice(0, 20000)`。
- `truncated` 为 `true`。

返回的 `url` 使用 Tavily 成功结果中的 URL，以便模型引用实际提取来源。

## 错误处理

以下情况抛出中文工具错误，并由注册表转换为 `ok: false`：

- 缺少或为空的 URL。
- URL 超长、无法解析、不是 HTTPS 或包含凭据。
- 缺少 `TAVILY_API_KEY`。
- Tavily 返回非 2xx，错误中包含 HTTP 状态码。
- 响应不是对象。
- `results` 缺失或为空，包括只存在 `failed_results` 的响应。
- 成功结果缺少有效 `url` 或 `raw_content`。

不将 Tavily API Key、请求头或完整异常对象写入工具结果。

## 活动动画

为 `web_fetch` 增加专属状态文案：

```text
冰美式正在细读网页…
热拿铁正在细读网页…
✓ 网页正文已经读完 · 1.2s
✗ 网页读取暂时失败 · 1.2s
```

动画帧、颜色、刷新频率和 `/like` 偏好行为保持不变。

## 文件边界

修改 `src/tools.ts`：

- 增加 Tavily Extract URL 常量。
- 增加 `web_fetch` 校验、请求和响应归一化函数。
- 注册 `web_fetch` 为 `read` 工具。

修改 `src/activity-indicator.ts`：

- 为 `web_fetch` 增加开始、成功和失败文案。

不修改工具注册表、模型适配器、CLI、设置文件或 Agent 工具循环结构。

## 测试

更新 `test/tools.test.ts`，覆盖：

- 三个工具的注册顺序及 `web_fetch` 风险等级。
- Extract URL、HTTP 方法、鉴权头和固定请求体。
- 正常 Markdown 返回结构。
- 20,000 字符边界和超长截断。
- 缺失 URL、无效 URL、HTTP URL、带凭据 URL 和超长 URL 均不发出请求。
- Tavily 非 2xx、空结果及缺失正文返回失败 JSON。

更新 `test/activity-indicator.test.ts`，覆盖读取开始、成功和失败文案。

更新 `test/agent.test.ts` 中工具数量与定义断言，确认 DeepSeek 收到三个 OpenAI-compatible 工具，且请求中没有 `riskLevel`。

最后运行：

```bash
npm test
npm run check
npm ls --depth=0
```

验收标准是全部测试通过、没有新增依赖，并且现有搜索、定位、命令、动画与退出行为没有回归。

## 后续阶段

WebFetch 验收后，下一阶段单独设计安全计算器。本阶段不预先加入表达式解析或 HITL 行为。
