import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRootLookup = (directory: string) => Promise<string | undefined>;

async function findGitRoot(directory: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: directory, encoding: "utf8" },
  );
  const root = stdout.trim();
  return root || undefined;
}

export async function resolveWorkspaceRoot(
  startDirectory = process.cwd(),
  lookupGitRoot: GitRootLookup = findGitRoot,
): Promise<string> {
  const realStartDirectory = await realpath(startDirectory);
  let discoveredRoot: string | undefined;
  try {
    discoveredRoot = await lookupGitRoot(realStartDirectory);
  } catch {
    discoveredRoot = undefined;
  }
  if (!discoveredRoot) return realStartDirectory;
  const candidate = path.isAbsolute(discoveredRoot)
    ? discoveredRoot
    : path.resolve(realStartDirectory, discoveredRoot);
  return await realpath(candidate);
}
