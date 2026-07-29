import path from "node:path";

type LoadEnvFile = (filePath: string) => void;

export function loadCoffeeEnvironment(
  appRoot: string,
  loadEnvFile: LoadEnvFile = process.loadEnvFile.bind(process),
): void {
  try {
    loadEnvFile(path.join(appRoot, ".env"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export async function launchCoffee(appRoot: string): Promise<void> {
  loadCoffeeEnvironment(appRoot);
  await import("./cli.js");
}
