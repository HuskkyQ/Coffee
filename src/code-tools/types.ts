export const READ_MAX_LINES = 2_000;
export const READ_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const OUTPUT_MAX_BYTES = 50 * 1024;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_LINE_LENGTH = 500;
export const FIND_MAX_RESULTS = 1_000;
export const LS_MAX_ENTRIES = 500;
export const EDIT_MAX_REPLACEMENTS = 20;
export const EDIT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const WRITE_MAX_FILE_BYTES = 1024 * 1024;
export const DIFF_MAX_LINES = 200;
export const DIFF_MAX_BYTES = 50 * 1024;

export type CodeToolErrorCode =
  | "INVALID_ARGUMENT"
  | "PATH_DENIED"
  | "PATH_PROTECTED"
  | "USER_REJECTED"
  | "NOT_FOUND"
  | "NOT_TEXT"
  | "LIMIT_EXCEEDED"
  | "EDIT_NOT_FOUND"
  | "EDIT_NOT_UNIQUE"
  | "EDIT_OVERLAP"
  | "EDIT_NO_CHANGE"
  | "EDIT_CONFLICT"
  | "RG_UNAVAILABLE"
  | "EXECUTION_FAILED";

export class CodeToolError extends Error {
  constructor(
    readonly code: CodeToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeToolError";
  }
}

export interface ProtectedAccessRequest {
  operation: "read" | "write";
  path: string;
  reason: string;
}

export interface MutationPreview {
  kind: "edit" | "write" | "set_env";
  path: string;
  patch: string;
  changedLines: number;
}

export interface SecretRequest {
  path: string;
  key: string;
}

export interface ToolInteraction {
  authorizeProtected(
    request: ProtectedAccessRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  confirmMutation(
    preview: MutationPreview,
    signal?: AbortSignal,
  ): Promise<boolean>;
  requestSecret(
    request: SecretRequest,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

export const DEFAULT_TOOL_INTERACTION: ToolInteraction = {
  async authorizeProtected() {
    return false;
  },
  async confirmMutation() {
    return false;
  },
  async requestSecret() {
    return undefined;
  },
};

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function getErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "工具执行失败。";
  }
}

export async function executeCodeTool(
  operation: () => Promise<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    return await operation();
  } catch (error) {
    if (
      isAbortError(error) ||
      (signal?.aborted === true && error === signal.reason)
    ) {
      throw error;
    }
    if (error instanceof CodeToolError) {
      return { ok: false, code: error.code, error: error.message };
    }
    return {
      ok: false,
      code: "EXECUTION_FAILED",
      error: getErrorMessage(error),
    };
  }
}
