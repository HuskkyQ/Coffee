import path from "node:path";

import type { ShellDecision, ShellRequest } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 300;
const MAX_COMMAND_LENGTH = 4096;

const COMPLEX_SHELL = /[\r\n|&;<>`]|\$\(/u;
const BRACE_EXPANSION = /(^|[^$])\{[^}\r\n]*\}/u;
const DENIED_COMMANDS = new Set([
  "sudo",
  "doas",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "mkfs",
  "fdisk",
  "diskutil",
]);
const SAFE_LS_FLAGS = /^-[alh1F]+$/u;
const SAFE_RG_FLAGS = new Set([
  "-n",
  "--line-number",
  "-i",
  "--ignore-case",
  "-F",
  "--fixed-strings",
  "-l",
  "--files-with-matches",
  "--files",
]);
const SAFE_GIT_OPTIONS = new Set([
  "--",
  "--stat",
  "--name-only",
  "--name-status",
  "--oneline",
  "--decorate",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseShellRequest(args: unknown): ShellRequest {
  if (!isRecord(args)) {
    throw new Error("shell command 必须是 1 到 4096 个字符。");
  }
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("shell command/timeout 参数原型不安全。");
  }
  if (
    Reflect.ownKeys(args).some((key) => key !== "command" && key !== "timeout")
  ) {
    throw new Error("shell 参数包含额外字段。");
  }
  const descriptors = Object.getOwnPropertyDescriptors(args);
  const commandDescriptor = descriptors.command;
  if (
    commandDescriptor === undefined ||
    !("value" in commandDescriptor) ||
    typeof commandDescriptor.value !== "string"
  ) {
    throw new Error("shell command 必须是 1 到 4096 个字符。");
  }

  const command = commandDescriptor.value.trim();
  if (command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
    throw new Error("shell command 必须是 1 到 4096 个字符。");
  }

  const timeoutDescriptor = descriptors.timeout;
  if (timeoutDescriptor !== undefined && !("value" in timeoutDescriptor)) {
    throw new Error("shell timeout 必须是自有数据属性。");
  }
  const timeout = timeoutDescriptor === undefined
    ? DEFAULT_TIMEOUT_SECONDS
    : timeoutDescriptor.value;
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error("shell timeout 必须是不超过 300 的有限正数。");
  }

  return { command, timeoutSeconds: timeout };
}

function tokenizeSimpleCommand(
  command: string,
  preserveEscapedGlobs = false,
): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const character of command) {
    if (escaping) {
      token += preserveEscapedGlobs && /[*?[{]/u.test(character)
        ? `\\${character}`
        : character;
      tokenStarted = true;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      tokenStarted = true;
      escaping = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      tokenStarted = true;
      quote = character;
    } else if (/\s/u.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (escaping || quote !== undefined) return undefined;
  if (tokenStarted) tokens.push(token);
  return tokens;
}

interface CommandSegment {
  text: string;
  separatorBefore?: string;
}

function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let text = "";
  let separatorBefore: string | undefined;
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaping) {
      text += character;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      text += character;
      escaping = true;
    } else if (quote !== undefined) {
      text += character;
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      text += character;
      quote = character;
    } else if (character === "|") {
      if (text.trim() !== "") {
        segments.push({ text, separatorBefore });
        text = "";
      }
      separatorBefore = "|";
      if (command[index + 1] === "&") index += 1;
    } else if (character === "\r" || character === "\n") {
      if (text.trim() === "" && separatorBefore === "|") {
        text = "";
        continue;
      }
      if (text.trim() !== "") segments.push({ text, separatorBefore });
      text = "";
      separatorBefore = character;
    } else if (character === ";" || character === "&") {
      if (text.trim() !== "") segments.push({ text, separatorBefore });
      text = "";
      separatorBefore = character;
    } else {
      text += character;
    }
  }

  if (text.trim() !== "") segments.push({ text, separatorBefore });
  return segments;
}

interface UnwrappedCommand {
  tokens: readonly string[];
  wrapped: boolean;
  reliable: boolean;
  workingDirectories: readonly string[];
}

function unwrapCommandDetails(tokens: readonly string[]): UnwrappedCommand {
  const workingTokens = [...tokens];
  const workingDirectories: string[] = [];
  let index = 0;
  let wrapped = false;
  while (index < workingTokens.length) {
    while (
      index < workingTokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/u.test(workingTokens[index]!)
    ) {
      index += 1;
    }
    if (workingTokens[index] === "command") {
      wrapped = true;
      index += 1;
      while (/^-p+$/u.test(workingTokens[index] ?? "")) index += 1;
      if (workingTokens[index] === "--") index += 1;
      else if (workingTokens[index]?.startsWith("-")) {
        return {
          tokens: workingTokens.slice(index),
          wrapped,
          reliable: false,
          workingDirectories,
        };
      }
      continue;
    }
    if (workingTokens[index] === "env") {
      wrapped = true;
      index += 1;
      while (index < workingTokens.length) {
        const token = workingTokens[index]!;
        if (token === "--") {
          index += 1;
          break;
        }
        if (["-C", "--chdir"].includes(token)) {
          if (index + 1 >= workingTokens.length) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          const value = workingTokens[index + 1]!;
          workingDirectories.push(value);
          if (hasUnsupportedVariableExpansion(value)) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          index += 2;
          continue;
        }
        if (["-u", "--unset", "-P"].includes(token)) {
          if (index + 1 >= workingTokens.length) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          index += 2;
          continue;
        }
        if (/^-C.+/u.test(token)) {
          const value = token.slice(2);
          workingDirectories.push(value);
          if (hasUnsupportedVariableExpansion(value)) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          index += 1;
          continue;
        }
        if (/^-[uP].+/u.test(token)) {
          index += 1;
          continue;
        }
        if (token === "-S" || token === "--split-string") {
          const value = workingTokens[index + 1];
          if (value === undefined) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          if (value.includes("$")) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          const splitTokens = tokenizeSimpleCommand(value);
          if (splitTokens === undefined) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          workingTokens.splice(index, 2, ...splitTokens);
          continue;
        }
        if (token.startsWith("-S") && token.length > 2) {
          const value = token.slice(2);
          if (value.includes("$")) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          const splitTokens = tokenizeSimpleCommand(value);
          if (splitTokens === undefined) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          workingTokens.splice(index, 1, ...splitTokens);
          continue;
        }
        if (token.startsWith("--split-string=")) {
          const value = token.slice("--split-string=".length);
          if (value.includes("$")) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          const splitTokens = tokenizeSimpleCommand(value);
          if (splitTokens === undefined) {
            return { tokens: [], wrapped, reliable: false, workingDirectories };
          }
          workingTokens.splice(index, 1, ...splitTokens);
          continue;
        }
        if (token.startsWith("--chdir=")) {
          const value = token.slice("--chdir=".length);
          workingDirectories.push(value);
          if (hasUnsupportedVariableExpansion(value)) {
            return {
              tokens: workingTokens.slice(index),
              wrapped,
              reliable: false,
              workingDirectories,
            };
          }
          index += 1;
          continue;
        }
        if (token.startsWith("--unset=")) {
          index += 1;
          continue;
        }
        if (
          /^-[i0v]+$/u.test(token) ||
          ["--ignore-environment", "--null", "--debug"].includes(token)
        ) {
          index += 1;
          continue;
        }
        if (token.startsWith("-")) {
          return {
            tokens: workingTokens.slice(index),
            wrapped,
            reliable: false,
            workingDirectories,
          };
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (workingTokens[index] === "exec") {
      wrapped = true;
      index += 1;
      if (workingTokens[index] === "--") index += 1;
      else if (workingTokens[index]?.startsWith("-")) {
        return {
          tokens: workingTokens.slice(index),
          wrapped,
          reliable: false,
          workingDirectories,
        };
      }
      continue;
    }
    break;
  }
  return {
    tokens: workingTokens.slice(index),
    wrapped,
    reliable: true,
    workingDirectories,
  };
}

function commandDetails(segment: string): UnwrappedCommand {
  const tokens = tokenizeSimpleCommand(segment);
  if (tokens !== undefined) return unwrapCommandDetails(tokens);
  const firstWord = /^\s*([^\s'"\\]+)/u.exec(segment)?.[1];
  return {
    tokens: firstWord === undefined ? [] : [firstWord],
    wrapped: firstWord === "env" || firstWord === "command",
    reliable: false,
    workingDirectories: [],
  };
}

function commandTokens(segment: string): readonly string[] {
  return commandDetails(segment).tokens;
}

function hasRemoteExecutionPipe(segments: readonly CommandSegment[]): boolean {
  let outputIsRemote: boolean = false;

  for (const segment of segments) {
    const receivesRemote: boolean =
      segment.separatorBefore === "|" && outputIsRemote;
    const details = commandDetails(segment.text);
    const executable = details.tokens[0] ?? "";
    if (
      receivesRemote &&
      (["sh", "bash", "zsh"].includes(executable) ||
        (details.wrapped && !details.reliable))
    ) {
      return true;
    }
    outputIsRemote = receivesRemote || ["curl", "wget"].includes(executable);
  }

  return false;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolvePwdExpression(token: string, root: string): string | undefined {
  if (token === "$PWD" || token === "${PWD}") return root;
  if (token.startsWith("$PWD/")) {
    return path.resolve(root, token.slice("$PWD/".length));
  }
  if (token.startsWith("${PWD}/")) {
    return path.resolve(root, token.slice("${PWD}/".length));
  }
  return undefined;
}

function explicitPathLeavesWorkspace(token: string, root: string): boolean {
  if (token.startsWith("~")) return true;
  if (/^\$(?:HOME(?:\/|$)|\{HOME\}(?:\/|$))/u.test(token)) return true;
  const pwdCandidate = resolvePwdExpression(token, root);
  if (pwdCandidate !== undefined) return !isInside(root, pwdCandidate);
  const looksLikePath = path.isAbsolute(token) ||
    token === "." ||
    token === ".." ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.includes("/");
  if (!looksLikePath) return false;
  return !isInside(root, path.resolve(root, token));
}

function hasUnsupportedVariableExpansion(token: string): boolean {
  return token.includes("$");
}

function hasRecursiveForce(flags: readonly string[]): boolean {
  const shortFlags = flags
    .filter((token) => /^-[^-]/u.test(token))
    .join("");
  const recursive = shortFlags.includes("r") || flags.includes("--recursive");
  const force = shortFlags.includes("f") || flags.includes("--force");
  return recursive && force;
}

function isWholeWorkspaceRemoval(
  tokens: readonly string[],
  root: string,
): boolean {
  if (tokens[0] !== "rm" || !hasRecursiveForce(tokens.slice(1))) return false;

  return tokens.slice(1).some((token) => {
    if (token.startsWith("-")) return false;

    const target = token.replace(/^\$(?:PWD|\{PWD\})(?=\/|$)/u, root);
    let staticPrefixEnd = target.length;
    let escaping = false;
    for (let index = 0; index < target.length; index += 1) {
      const character = target[index]!;
      if (escaping) {
        escaping = false;
      } else if (character === "\\") {
        escaping = true;
      } else if (/[*?[{]/u.test(character)) {
        staticPrefixEnd = index;
        break;
      }
    }

    const staticPrefix = target.slice(0, staticPrefixEnd);
    const resolvedTarget = path.resolve(root, staticPrefix);
    return path.relative(root, resolvedTarget) === "";
  });
}

function hasDeniedCommand(segments: readonly CommandSegment[]): boolean {
  return segments.some((segment) =>
    DENIED_COMMANDS.has(commandTokens(segment.text)[0] ?? "")
  );
}

function hasOutsidePath(tokens: readonly string[], root: string): boolean {
  return tokens.some((token) => explicitPathLeavesWorkspace(token, root));
}

function hasOutsidePathForCommand(
  tokens: readonly string[],
  root: string,
): boolean {
  if (tokens[0] !== "rg") return hasOutsidePath(tokens, root);

  const { paths, reliable } = parseRgArguments(tokens.slice(1));
  if (!reliable) return false;
  return paths.some((token) => explicitPathLeavesWorkspace(token, root));
}

interface ParsedRgArguments {
  paths: readonly string[];
  autoEligible: boolean;
  reliable: boolean;
}

function parseRgArguments(args: readonly string[]): ParsedRgArguments {
  const positionals: string[] = [];
  const optionPaths: string[] = [];
  let autoEligible = true;
  let reliable = true;
  let filesMode = false;
  let explicitPattern = false;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (optionsEnded) {
      positionals.push(token);
    } else if (token === "--") {
      optionsEnded = true;
    } else if (token === "--files") {
      filesMode = true;
    } else if (SAFE_RG_FLAGS.has(token) || /^-[ABC]\d+$/u.test(token)) {
      continue;
    } else if (
      [
        "-A",
        "-B",
        "-C",
        "-g",
        "--glob",
        "-m",
        "--max-count",
        "-t",
        "--type",
        "--sort",
      ]
        .includes(token)
    ) {
      autoEligible = false;
      if (index + 1 >= args.length) {
        reliable = false;
        break;
      }
      index += 1;
    } else if (/^--(?:glob|max-count|type|sort)=/u.test(token)) {
      autoEligible = false;
    } else if (["-f", "--file"].includes(token)) {
      autoEligible = false;
      explicitPattern = true;
      const value = args[index + 1];
      if (value === undefined) {
        reliable = false;
        break;
      }
      optionPaths.push(value);
      index += 1;
    } else if (token === "--ignore-file") {
      const value = args[index + 1];
      if (value === undefined) {
        reliable = false;
        break;
      }
      optionPaths.push(value);
      index += 1;
    } else if (token.startsWith("--file=")) {
      autoEligible = false;
      explicitPattern = true;
      optionPaths.push(token.slice(token.indexOf("=") + 1));
    } else if (token.startsWith("--ignore-file=")) {
      optionPaths.push(token.slice(token.indexOf("=") + 1));
    } else if (token === "-e" || token === "--regexp") {
      autoEligible = false;
      explicitPattern = true;
      if (index + 1 < args.length) index += 1;
    } else if (token.startsWith("--regexp=") || /^-e.+/u.test(token)) {
      autoEligible = false;
      explicitPattern = true;
    } else if (token.startsWith("-")) {
      autoEligible = false;
      reliable = false;
      break;
    } else {
      positionals.push(token);
    }
  }

  const positionalPaths = filesMode || explicitPattern
    ? positionals
    : positionals.slice(1);
  return {
    paths: [...optionPaths, ...positionalPaths],
    autoEligible,
    reliable,
  };
}

function isSafeAutoCommand(tokens: readonly string[], root: string): boolean {
  if (hasOutsidePathForCommand(tokens, root)) return false;
  if (tokens.some(hasUnsupportedVariableExpansion)) return false;

  if (tokens.length === 1 && tokens[0] === "pwd") return true;

  if (tokens[0] === "ls") {
    return tokens.slice(1).every((token) =>
      !token.startsWith("-") || SAFE_LS_FLAGS.test(token)
    );
  }

  if (tokens[0] === "rg") {
    return parseRgArguments(tokens.slice(1)).autoEligible;
  }

  if (
    tokens[0] === "git" &&
    ["status", "diff", "log", "show"].includes(tokens[1] ?? "")
  ) {
    const args = tokens.slice(2);
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]!;
      if (token === "-n") {
        if (!/^\d+$/u.test(args[index + 1] ?? "")) return false;
        index += 1;
      } else if (
        token.startsWith("-") &&
        !SAFE_GIT_OPTIONS.has(token) &&
        !/^-n\d+$/u.test(token)
      ) {
        return false;
      }
    }
    return true;
  }

  const joined = tokens.join(" ");
  return joined === "npm test" ||
    joined === "npm run test" ||
    /^npm run test:[A-Za-z0-9:_-]+$/u.test(joined) ||
    joined === "npm run check" ||
    joined === "npx --no-install tsc --noEmit";
}

export function classifyShellCommand(
  command: string,
  workspaceRoot: string,
): ShellDecision {
  const root = path.resolve(workspaceRoot);
  const continuedCommand = command.replace(/\\\r?\n/gu, "");
  const denySegments = splitCommandSegments(continuedCommand);
  if (hasRemoteExecutionPipe(denySegments)) {
    return { kind: "deny", reason: "禁止下载后直接执行远程脚本。" };
  }

  if (hasDeniedCommand(denySegments)) {
    return { kind: "deny", reason: "命令可能影响系统或访问工作区之外。" };
  }

  const parsedSegments = denySegments
    .map((segment) => tokenizeSimpleCommand(segment.text, true))
    .filter((tokens): tokens is string[] => tokens !== undefined)
    .map(unwrapCommandDetails);
  if (
    parsedSegments.some((details) =>
      details.workingDirectories.some((directory) =>
        explicitPathLeavesWorkspace(directory, root)
      ) ||
      isWholeWorkspaceRemoval(details.tokens, root) ||
      hasOutsidePathForCommand(details.tokens, root)
    )
  ) {
    return { kind: "deny", reason: "命令可能影响系统或访问工作区之外。" };
  }

  const tokens = tokenizeSimpleCommand(command);
  if (tokens === undefined || tokens.length === 0) {
    return { kind: "confirm", reason: "命令包含无法安全解析的引号或转义。" };
  }

  if (COMPLEX_SHELL.test(command) || BRACE_EXPANSION.test(command)) {
    return { kind: "confirm", reason: "命令包含管道、重定向或组合语法。" };
  }

  const details = unwrapCommandDetails(tokens);
  const autoTokens = details.workingDirectories.length > 0
    ? details.tokens
    : tokens;
  if (details.reliable && isSafeAutoCommand(autoTokens, root)) {
    return { kind: "auto", reason: "命令符合只读或可信项目验证规则。" };
  }

  return { kind: "confirm", reason: "命令不在严格自动执行列表中。" };
}
