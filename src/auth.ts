import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { withFileLock } from "./file-lock.js";
import { CREDENTIALS } from "./models/catalog.js";
import type {
  CredentialDefinition,
  CredentialId,
} from "./models/types.js";

export const AUTH_DIRECTORY = join(homedir(), ".coffee");
export const AUTH_PATH = join(AUTH_DIRECTORY, "auth.json");

export interface ResolvedCredential {
  key: string;
  source: "auth-file" | "environment";
}

interface AuthDocument {
  [key: string]: unknown;
  version: 1;
  credentials: Record<string, unknown>;
}

interface ApiKeyEntry {
  type: "api_key";
  key: string;
}

const CREDENTIAL_IDS: readonly CredentialId[] = CREDENTIALS.map(
  (credential) => credential.id,
);

export function maskApiKey(key: string): string {
  if (key.length <= 8) {
    return "•".repeat(key.length);
  }

  return `${key.slice(0, 3)}••••••${key.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiKeyEntry(value: unknown): value is ApiKeyEntry {
  return (
    isRecord(value) &&
    value.type === "api_key" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0
  );
}

async function readAuthDocument(
  authPath: string,
): Promise<AuthDocument | undefined> {
  await tightenExistingPermissions(authPath);

  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`凭证文件不是有效的 JSON：${authPath}`, { cause: error });
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.credentials)
  ) {
    throw new Error(`凭证文件结构无效：${authPath}`);
  }

  for (const id of CREDENTIAL_IDS) {
    if (
      Object.hasOwn(parsed.credentials, id) &&
      !isApiKeyEntry(parsed.credentials[id])
    ) {
      throw new Error(`凭证 ${id} 的记录无效：${authPath}`);
    }
  }

  return parsed as AuthDocument;
}

async function chmodIfExists(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function tightenExistingPermissions(authPath: string): Promise<void> {
  await chmodIfExists(dirname(authPath), 0o700);
  await chmodIfExists(authPath, 0o600);
}

async function writeAuthDocument(
  authPath: string,
  document: AuthDocument,
): Promise<void> {
  const directory = dirname(authPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = join(
    directory,
    `.${basename(authPath)}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, authPath);
    await chmod(authPath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function createCredentialStore(authPath = AUTH_PATH) {
  async function getSavedApiKey(
    id: CredentialId,
  ): Promise<string | undefined> {
    const document = await readAuthDocument(authPath);
    const entry = document?.credentials[id];
    return isApiKeyEntry(entry) ? entry.key.trim() : undefined;
  }

  async function getSavedCredentialIds(): Promise<readonly CredentialId[]> {
    const document = await readAuthDocument(authPath);
    if (document === undefined) {
      return [];
    }

    return CREDENTIAL_IDS.filter((id) =>
      Object.hasOwn(document.credentials, id),
    );
  }

  async function saveApiKey(id: CredentialId, key: string): Promise<void> {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0) {
      throw new Error("API Key 不能为空");
    }

    const authDirectory = dirname(authPath);
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await chmod(authDirectory, 0o700);
    await withFileLock(authPath, async () => {
      const document = (await readAuthDocument(authPath)) ?? {
        version: 1,
        credentials: {},
      };
      const existingEntry = document.credentials[id];
      document.credentials[id] = {
        ...(isRecord(existingEntry) ? existingEntry : {}),
        type: "api_key",
        key: trimmedKey,
      };
      await writeAuthDocument(authPath, document);
    });
  }

  async function deleteApiKey(id: CredentialId): Promise<boolean> {
    const authDirectory = dirname(authPath);
    await mkdir(authDirectory, { recursive: true, mode: 0o700 });
    await chmod(authDirectory, 0o700);
    return withFileLock(authPath, async () => {
      const document = await readAuthDocument(authPath);
      if (
        document === undefined ||
        !Object.hasOwn(document.credentials, id)
      ) {
        return false;
      }

      delete document.credentials[id];
      await writeAuthDocument(authPath, document);
      return true;
    });
  }

  async function resolve(
    definition: CredentialDefinition,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ResolvedCredential | undefined> {
    const savedKey = await getSavedApiKey(definition.id);
    if (savedKey !== undefined) {
      return { key: savedKey, source: "auth-file" };
    }

    for (const envKey of definition.envKeys) {
      const key = env[envKey]?.trim();
      if (key) {
        return { key, source: "environment" };
      }
    }

    return undefined;
  }

  return {
    getSavedApiKey,
    getSavedCredentialIds,
    saveApiKey,
    deleteApiKey,
    resolve,
  };
}
