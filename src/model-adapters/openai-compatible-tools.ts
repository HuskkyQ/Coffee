import type { ToolDefinition } from "../tool-registry.js";

export interface OpenAICompatibleTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export function toOpenAICompatibleTools(
  definitions: readonly ToolDefinition[],
): OpenAICompatibleTool[] {
  return definitions.map((definition) => ({
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
}
