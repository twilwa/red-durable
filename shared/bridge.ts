import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
export const BRIDGE_MAX_BYTES = 512 * 1024;
export interface BridgeJob {
  id: string;
  leaseToken: string;
  expiresAt: number;
  modelId: string;
  context: Context;
  options?: {
    maxTokens?: number;
    reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  };
}
export type BridgeErrorKind =
  "quota" | "auth" | "model" | "transient" | "invalid";
export interface BridgeResult {
  jobId: string;
  leaseToken: string;
  message?: AssistantMessage;
  error?: { kind: BridgeErrorKind; message: string; retryAfterMs?: number };
}
export interface BridgePoll {
  modelIds: string[];
}
export interface BridgePollResponse {
  job: BridgeJob | null;
}
