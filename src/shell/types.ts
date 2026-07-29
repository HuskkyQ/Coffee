export type ShellDecision =
  | { kind: "auto"; reason: string }
  | { kind: "confirm"; reason: string }
  | { kind: "deny"; reason: string };

export interface ShellRequest {
  command: string;
  timeoutSeconds: number;
}

export type ShellErrorCode =
  | "INVALID_ARGUMENT"
  | "COMMAND_DENIED"
  | "USER_REJECTED"
  | "SPAWN_FAILED"
  | "TIMED_OUT"
  | "CANCELLED";

export interface ShellExecutionResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  output: string;
  code?: ShellErrorCode;
  error?: string;
}

export interface ShellConfirmationRequest {
  command: string;
  reason: string;
}

export interface ShellDisplayRequest {
  command: string;
  displayCommand: boolean;
}

export interface ShellInteraction {
  confirmShell?(
    request: ShellConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
  beginShell?(request: ShellDisplayRequest): void;
  writeShellOutput?(chunk: string): void;
}

export const DEFAULT_SHELL_INTERACTION: ShellInteraction = {};
