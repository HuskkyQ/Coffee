import type {
  ModelMessage,
  ModelReasoning,
  ModelToolCall,
} from "../models/types.js";

export type PersistedMessage =
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ModelToolCall[];
      readonly reasoning?: ModelReasoning;
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };

export interface StoredTurn {
  readonly id: string;
  readonly sequence: number;
  readonly createdAt: string;
  readonly messages: readonly PersistedMessage[];
}

export interface StoredSummary {
  readonly throughTurnSequence: number;
  readonly content: string;
  readonly sourceRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredSession {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly turns: readonly StoredTurn[];
  readonly summary?: StoredSummary;
}

export interface SessionListItem {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messageCount: number;
  readonly updatedAt: string;
}

export interface HistoryPreferences {
  readonly compressionThresholdChars: number;
  readonly maxContextChars: number;
  readonly summaryTargetChars: number;
}

export const DEFAULT_HISTORY_PREFERENCES: HistoryPreferences = Object.freeze({
  compressionThresholdChars: 30_000,
  maxContextChars: 40_000,
  summaryTargetChars: 5_000,
});

export function clonePersistedMessages(
  messages: readonly PersistedMessage[],
): PersistedMessage[] {
  return [...structuredClone(messages)];
}

export function toModelMessages(
  messages: readonly PersistedMessage[],
): ModelMessage[] {
  return [...structuredClone(messages)];
}
