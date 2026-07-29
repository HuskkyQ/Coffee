export type ToolRiskLevel = "read" | "compute" | "execute" | "write";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  riskLevel: ToolRiskLevel;
  execute(
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ToolRegistry {
  definitions: readonly ToolDefinition[];
  execute(
    name: string,
    argumentsJson: string,
    signal?: AbortSignal,
  ): Promise<string>;
  getRiskLevel(name: string): ToolRiskLevel | undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(error: string): string {
  return JSON.stringify({ ok: false, error });
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson);
  } catch {
    throw new Error("工具参数不是有效的 JSON。");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("工具参数必须是 JSON 对象。");
  }
  return value as Record<string, unknown>;
}

export function createToolRegistry(
  tools: readonly RegisteredTool[],
): ToolRegistry {
  const toolsByName = new Map<string, RegisteredTool>();
  for (const tool of tools) {
    const name = tool.definition.name;
    if (toolsByName.has(name)) {
      throw new Error(`重复的工具名称: ${name}`);
    }
    toolsByName.set(name, tool);
  }

  return {
    definitions: tools.map((tool) => tool.definition),
    getRiskLevel(name) {
      return toolsByName.get(name)?.riskLevel;
    },
    async execute(name, argumentsJson, signal) {
      signal?.throwIfAborted();
      const tool = toolsByName.get(name);
      if (!tool) {
        return failure(`未知工具: ${name}`);
      }
      try {
        const args = parseArguments(argumentsJson);
        return JSON.stringify(await tool.execute(args, signal));
      } catch (error) {
        if (
          isAbortError(error) ||
          (signal?.aborted === true && error === signal.reason)
        ) {
          throw error;
        }
        return failure(getErrorMessage(error));
      }
    },
  };
}
