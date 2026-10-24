/** Browser-facing shapes of the existing owner API. No provider credentials. */
export interface Charter {
  version: number;
  text: string;
  recordedAt: string;
}
export interface Belief {
  id: number;
  kind: string;
  text: string;
  scope: string;
  confidence: number;
  status: string;
  sourceEventIds: number[];
  supersedes?: number;
  expiresAt?: string;
}
export interface Commitment {
  id: number;
  text: string;
  status: string;
  scope: string;
  dueAt?: string;
  sourceEventIds: number[];
  history: {
    id: number;
    status: string;
    evidenceEventIds: number[];
    recordedAt: string;
  }[];
}
export interface Companion {
  charter: Charter | null;
  beliefs: Belief[];
  commitments: Commitment[];
  authorization: string;
  journal: {
    entries: {
      key: string;
      commitmentId: number;
      text: string;
      textTruncated: boolean;
      status: string;
      recordedAt: string;
      evidenceEventIds: number[];
    }[];
    omitted: number;
    notice: string;
  };
}
export interface SourceEventPage {
  id: number;
  source: string;
  sourceRef: string;
  text: string;
  occurredAt: string;
  recordedAt: string;
  offset: number;
  nextOffset: number | null;
}
export interface Revision {
  id: string;
  description: string;
  createdAt: string;
  sourceLength?: number;
  source?: string;
}
export interface Skill {
  name: string;
  revisionId: string;
  description: string;
  status: string;
  createdAt: string;
}
export interface FullSkill extends Skill {
  instructions: string;
  whenToUse: string[];
  whenNotToUse: string[];
  useExamples: string[];
  avoidExamples: string[];
  evidenceRunIds: string[];
  sources: string[];
  evaluation: {
    passed: boolean;
    correct: number;
    total: number;
    warning: string;
  } | null;
}
export interface ExperimentPolicy {
  goal: string;
  startingRevisionId: string;
  expiresAt: string;
  maxGenerations: number;
  maxOutputTokens: number;
  maxProposals: number;
  maxTests: number;
  modelId: string;
  sandbox: "disposable-candidate-v1";
  paidInferenceBudgetUsd: 0;
  externalAccess: false;
}
export interface ExperimentStatus {
  version: number;
  policyVersion: number;
  policy: ExperimentPolicy | null;
  sessionId: string | null;
  epoch: number;
  state: string;
  running: boolean;
  stopped: boolean;
  reserved: {
    generations: number;
    outputTokens: number;
    proposals: number;
    tests: number;
  };
  reason: string | null;
  event: string | null;
}
export interface State {
  experiments?: ExperimentStatus;
  inference: {
    mode: string;
    models: string[];
    selected?: string;
    lastSeen: number | null;
    jobs: { state: string; count: number }[];
    failures: {
      id: string;
      summary?: boolean;
      error?: { kind?: string; message: string };
    }[];
  };
  history: { id: number; kind: string; text: string; date: string }[];
  historyHasMore: boolean;
  pending: unknown[];
  memory: { messages: number; viewBytes: number; [key: string]: unknown };
  releases: Revision[];
  active: { revisionId: string; activatedAt: string } | null;
}
export type CompanionAction =
  | { action: "charter"; text: string; expectedVersion: number }
  | {
      action:
        | "accept-belief"
        | "accept-commitment"
        | "complete-commitment"
        | "cancel-commitment";
      id: number;
    };

/** Status only. Secret values are submitted separately and never returned. */
export type ProviderId =
  "openai" | "kimi-code" | "openrouter" | "opencode-zen" | "opencode-go";
export interface Provider {
  id: ProviderId;
  name: string;
  kind: "oauth" | "api_key" | "subscription";
  connected: boolean;
  status:
    | "connected"
    | "disconnected"
    | "unverified"
    | "saved_unverified"
    | "auth_error"
    | "quota"
    | "error"
    | "no_models"
    | "disabled";
  message: string;
  models: { id: string; name: string }[];
}
export interface ProviderFlow {
  id: string;
  providerId: ProviderId;
  status:
    | "pending"
    | "starting"
    | "waiting"
    | "exchanging"
    | "saving"
    | "connected"
    | "cancelled"
    | "expired"
    | "error";
  url?: string;
  prompt?: { message: string; type: "manual_code" | "text" };
  message?: string;
  expiresAt: number;
}
export type Providers =
  | { available: false; message: string }
  | { available: true; providers: Provider[]; flow: ProviderFlow | null };
