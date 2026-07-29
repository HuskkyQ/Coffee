import assert from "node:assert/strict";
import test from "node:test";

import { toOpenAICompatibleTools } from "../src/model-adapters/openai-compatible-tools.js";

test("converts neutral definitions without leaking local metadata", () => {
  const result = toOpenAICompatibleTools([
    {
      name: "web_search",
      description: "搜索网页",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ]);

  assert.deepEqual(result, [
    {
      type: "function",
      function: {
        name: "web_search",
        description: "搜索网页",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
  ]);
  assert.equal(JSON.stringify(result).includes("riskLevel"), false);
});
