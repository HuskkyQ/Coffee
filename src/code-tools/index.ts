import type { RegisteredTool } from "../tool-registry.js";
import { createEnvTool } from "./env-tool.js";
import { createMutationTools } from "./mutation-tools.js";
import { createReadTools } from "./read-tools.js";
import { createSearchTools } from "./search-tools.js";
import {
  DEFAULT_TOOL_INTERACTION,
  type ToolInteraction,
} from "./types.js";
import { createWorkspacePolicy } from "./workspace-policy.js";

export function createCodeTools({
  workspaceRoot,
  interaction = DEFAULT_TOOL_INTERACTION,
}: {
  workspaceRoot: string;
  interaction?: ToolInteraction;
}): RegisteredTool[] {
  const policy = createWorkspacePolicy(workspaceRoot);
  return [
    ...createReadTools({ policy, interaction }),
    ...createSearchTools({ policy, interaction }),
    ...createMutationTools({ policy, interaction }),
    createEnvTool({ policy, interaction }),
  ];
}
