import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function withHistoryPath(
  run: (databasePath: string, home: string) => Promise<void> | void,
): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "coffee-history-"));
  try {
    await run(path.join(home, ".coffee", "history.sqlite"), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
