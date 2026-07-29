export interface CommandDefinition {
  name:
    | "/login"
    | "/logout"
    | "/model"
    | "/theme"
    | "/new"
    | "/sessions"
    | "/delete"
    | "/plan"
    | "/exit";
  description: string;
  acceptsArguments: boolean;
}

export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "/login",
    description: "登录模型平台",
    acceptsArguments: false,
  },
  {
    name: "/logout",
    description: "退出模型平台",
    acceptsArguments: false,
  },
  {
    name: "/model",
    description: "切换模型",
    acceptsArguments: false,
  },
  {
    name: "/theme",
    description: "切换终端主题",
    acceptsArguments: false,
  },
  {
    name: "/new",
    description: "开始新会话",
    acceptsArguments: false,
  },
  {
    name: "/sessions",
    description: "查看和切换会话",
    acceptsArguments: false,
  },
  {
    name: "/delete",
    description: "删除当前会话",
    acceptsArguments: false,
  },
  {
    name: "/plan",
    description: "查看或取消当前任务计划",
    acceptsArguments: true,
  },
  {
    name: "/exit",
    description: "退出 Coffee",
    acceptsArguments: false,
  },
];

export type CommandResolution =
  | { type: "chat"; input: string }
  | { type: "known"; command: CommandDefinition; input: string }
  | { type: "suggestion"; unknown: string; suggestedInput: string }
  | { type: "unknown"; command: string };

const RETIRED_COMMANDS = new Set(["/like"]);

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution =
        previous[rightIndex - 1]! +
        (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

export function getCommandSuggestions(input: string): CommandDefinition[] {
  const query = input.trimStart();
  if (!query.startsWith("/") || /\s/.test(query)) {
    return [];
  }
  return COMMANDS.filter((command) => command.name.startsWith(query));
}

function findNearbyCommand(commandName: string): CommandDefinition | undefined {
  const prefixCandidates = COMMANDS.filter((command) =>
    command.name.startsWith(commandName),
  );
  if (prefixCandidates.length === 1) return prefixCandidates[0];
  if (prefixCandidates.length > 1) return undefined;

  const candidates = COMMANDS.map((command) => ({
    command,
    distance: levenshteinDistance(commandName, command.name),
  }))
    .filter((candidate) => candidate.distance <= 2);
  const bestDistance = Math.min(
    ...candidates.map((candidate) => candidate.distance),
  );
  const bestCandidates = candidates.filter(
    (candidate) => candidate.distance === bestDistance,
  );
  return bestCandidates.length === 1 ? bestCandidates[0]?.command : undefined;
}

export function resolveCommandInput(input: string): CommandResolution {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "chat", input };
  }

  const match = trimmed.match(/^(\S+)([\s\S]*)$/);
  const commandName = match?.[1] ?? trimmed;
  const argumentsText = match?.[2] ?? "";
  const known = COMMANDS.find((command) => command.name === commandName);
  if (known) {
    return { type: "known", command: known, input: trimmed };
  }
  if (RETIRED_COMMANDS.has(commandName)) {
    return { type: "unknown", command: commandName };
  }

  const nearby = findNearbyCommand(commandName);
  if (nearby) {
    return {
      type: "suggestion",
      unknown: commandName,
      suggestedInput: `${nearby.name}${argumentsText}`,
    };
  }
  return { type: "unknown", command: commandName };
}

export function renderAvailableCommands(): string {
  return [
    "可用命令：",
    ...COMMANDS.map(
      (command) => `  ${command.name.padEnd(10)}${command.description}`,
    ),
  ].join("\n");
}
