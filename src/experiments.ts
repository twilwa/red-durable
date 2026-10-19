/** Trusted, owner-configured experiment accounting. A single CAS snapshot commits
 * history, fences and reservations atomically. Failed work never refunds budget.
 * No inference, network, code activation or scheduler capability lives here. */
import type { MemorySql } from "./memory.ts";

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
export interface ExperimentGuard {
  sessionId: string;
  epoch: number;
}
export type ExperimentOperation = "generation" | "proposal" | "test";
export interface ExperimentReservation extends ExperimentGuard {
  id: string;
  kind: ExperimentOperation;
  payloadFingerprint: string;
  outputTokens: number;
  status: "reserved" | "succeeded" | "failed" | "interrupted";
  reference?: string;
}
export interface ExperimentState {
  version: number;
  policyVersion: number;
  policy: ExperimentPolicy | null;
  sessionId: string | null;
  epoch: number;
  state:
    | "disabled"
    | "configured"
    | "active"
    | "stopped"
    | "interrupted"
    | "completed"
    | "failed"
    | "expired";
  running: boolean;
  stopped: boolean;
  reservations: ExperimentReservation[];
  reserved: {
    generations: number;
    outputTokens: number;
    proposals: number;
    tests: number;
  };
  event: string;
  at: string;
  reason: string | null;
}
export class ExperimentError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}
const policyKeys = [
  "goal",
  "startingRevisionId",
  "expiresAt",
  "maxGenerations",
  "maxOutputTokens",
  "maxProposals",
  "maxTests",
  "modelId",
  "sandbox",
  "paidInferenceBudgetUsd",
  "externalAccess",
];
export class ExperimentStore {
  private sql: MemorySql;
  private now: () => number;
  private subscriptionModelIds: () => string[];
  constructor(
    sql: MemorySql,
    now = () => Date.now(),
    subscriptionModelIds: () => string[] = () => [],
  ) {
    this.sql = sql;
    this.now = now;
    this.subscriptionModelIds = subscriptionModelIds;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS experiment_history (version INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
    const state = this.read();
    if (state.running)
      this.terminate(state, "interrupted", "restart-interrupted");
  }
  private read(): ExperimentState {
    const row = this.sql
      .exec("SELECT body FROM experiment_history ORDER BY version DESC LIMIT 1")
      .toArray()[0];
    return row
      ? JSON.parse(String(row.body))
      : {
          version: 0,
          policyVersion: 0,
          policy: null,
          sessionId: null,
          epoch: 0,
          state: "disabled",
          running: false,
          stopped: true,
          reservations: [],
          reserved: { generations: 0, outputTokens: 0, proposals: 0, tests: 0 },
          event: "unconfigured",
          at: new Date(this.now()).toISOString(),
          reason: null,
        };
  }
  private save(state: ExperimentState, event: string) {
    const expected = state.version;
    state.version++;
    state.event = event;
    state.at = new Date(this.now()).toISOString();
    const rows = this.sql
      .exec(
        "INSERT INTO experiment_history(version,body) SELECT ?,? WHERE COALESCE((SELECT MAX(version) FROM experiment_history),0)=? RETURNING version",
        state.version,
        JSON.stringify(state),
        expected,
      )
      .toArray();
    if (!rows.length) throw new ExperimentError("Stale experiment state");
    return state;
  }
  private expect(state: ExperimentState, version: unknown) {
    if (!Number.isSafeInteger(version) || version !== state.version)
      throw new ExperimentError("Stale experiment version");
  }
  private terminate(
    state: ExperimentState,
    outcome: "stopped" | "interrupted" | "completed" | "failed" | "expired",
    reason: string | null,
  ) {
    state.running = false;
    state.stopped = true;
    state.state = outcome;
    state.reason = reason;
    state.reservations = state.reservations.map((r) =>
      r.status === "reserved" ? { ...r, status: "interrupted" } : r,
    );
    // Keep the terminated epoch addressable for queue cancellation. A later
    // start advances it; running=false immediately fences all result writes.
    return this.save(state, `experiment-${outcome}`);
  }
  status(): ExperimentState {
    const state = this.read();
    if (
      state.running &&
      state.policy &&
      Date.parse(state.policy.expiresAt) <= this.now()
    )
      return this.terminate(state, "expired", "policy-expired");
    return state;
  }
  configure(input: unknown, expectedVersion: unknown): ExperimentState {
    const state = this.status();
    this.expect(state, expectedVersion);
    if (state.running)
      throw new ExperimentError(
        "Stop the active experiment before configuring",
      );
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== policyKeys.length ||
      policyKeys.some((k) => !Object.hasOwn(input, k))
    )
      throw new ExperimentError(
        "Unexpected or missing experiment policy fields",
        400,
      );
    const p = input as ExperimentPolicy;
    const integer = (n: number, min: number, max: number) =>
      Number.isSafeInteger(n) && n >= min && n <= max;
    if (
      typeof p.goal !== "string" ||
      !p.goal.trim() ||
      p.goal.length > 4000 ||
      typeof p.startingRevisionId !== "string" ||
      !/^[a-f0-9]{64}$/.test(p.startingRevisionId) ||
      typeof p.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      Date.parse(p.expiresAt) <= this.now() ||
      Date.parse(p.expiresAt) > this.now() + 24 * 60 * 60 * 1000 ||
      !integer(p.maxGenerations, 1, 100) ||
      !integer(p.maxOutputTokens, 1, 1600000) ||
      !integer(p.maxProposals, 0, 100) ||
      !integer(p.maxTests, 0, 100) ||
      typeof p.modelId !== "string" ||
      !this.subscriptionModelIds().includes(p.modelId) ||
      p.sandbox !== "disposable-candidate-v1" ||
      p.paidInferenceBudgetUsd !== 0 ||
      p.externalAccess !== false
    )
      throw new ExperimentError(
        "Invalid or non-subscription experiment policy",
        400,
      );
    state.policy = structuredClone(p);
    state.policyVersion++;
    state.epoch++;
    state.sessionId = null;
    state.state = "configured";
    state.running = false;
    state.stopped = true;
    state.reason = null;
    state.reservations = [];
    state.reserved = {
      generations: 0,
      outputTokens: 0,
      proposals: 0,
      tests: 0,
    };
    return this.save(state, "owner-configured-experiment");
  }
  start(expectedVersion: unknown): ExperimentState {
    const state = this.status();
    this.expect(state, expectedVersion);
    if (
      state.running ||
      !state.policy ||
      Date.parse(state.policy.expiresAt) <= this.now() ||
      !this.subscriptionModelIds().includes(state.policy.modelId) ||
      state.reserved.generations >= state.policy.maxGenerations ||
      state.reserved.outputTokens >= state.policy.maxOutputTokens
    )
      throw new ExperimentError("Experiment cannot start");
    state.epoch++;
    state.sessionId = crypto.randomUUID();
    state.running = true;
    state.stopped = false;
    state.state = "active";
    state.reason = null;
    return this.save(state, "owner-started-experiment");
  }
  stop(expectedVersion?: unknown): ExperimentState {
    const state = this.status();
    if (expectedVersion !== undefined) this.expect(state, expectedVersion);
    if (!state.running && state.stopped) return state;
    return this.terminate(state, "stopped", "owner-stop");
  }
  guard(guard: ExperimentGuard): ExperimentState {
    const state = this.status();
    if (
      !state.running ||
      state.stopped ||
      !guard ||
      guard.sessionId !== state.sessionId ||
      guard.epoch !== state.epoch ||
      !state.policy ||
      !this.subscriptionModelIds().includes(state.policy.modelId)
    )
      throw new ExperimentError("Stale or inactive experiment session");
    return state;
  }
  reserve(
    guard: ExperimentGuard,
    operationId: string,
    kind: ExperimentOperation,
    payloadFingerprint: string,
    outputTokens = 0,
  ) {
    const state = this.guard(guard);
    if (
      typeof operationId !== "string" ||
      !/^[a-zA-Z0-9_:.\-]{1,512}$/.test(operationId) ||
      !["generation", "proposal", "test"].includes(kind) ||
      typeof payloadFingerprint !== "string" ||
      !payloadFingerprint ||
      payloadFingerprint.length > 1024 ||
      !Number.isSafeInteger(outputTokens) ||
      (kind === "generation"
        ? outputTokens < 1 || outputTokens > 16000
        : outputTokens !== 0)
    )
      throw new ExperimentError("Invalid experiment reservation", 400);
    const existing = state.reservations.find((r) => r.id === operationId);
    if (existing) {
      if (
        existing.sessionId !== guard.sessionId ||
        existing.epoch !== guard.epoch ||
        existing.kind !== kind ||
        existing.payloadFingerprint !== payloadFingerprint ||
        existing.outputTokens !== outputTokens
      )
        throw new ExperimentError("Experiment operation ID payload conflict");
      return { reservation: existing, replay: true, fresh: false };
    }
    const p = state.policy!,
      counts = state.reserved;
    if (
      (kind === "generation" &&
        (counts.generations >= p.maxGenerations ||
          counts.outputTokens + outputTokens > p.maxOutputTokens)) ||
      (kind === "proposal" && counts.proposals >= p.maxProposals) ||
      (kind === "test" && counts.tests >= p.maxTests)
    )
      throw new ExperimentError("Experiment budget exhausted");
    if (kind === "generation") {
      counts.generations++;
      counts.outputTokens += outputTokens;
    } else if (kind === "proposal") counts.proposals++;
    else counts.tests++;
    const reservation: ExperimentReservation = {
      ...guard,
      id: operationId,
      kind,
      payloadFingerprint,
      outputTokens,
      status: "reserved",
    };
    state.reservations.push(reservation);
    this.save(state, `${kind}-reserved`);
    return { reservation, replay: false, fresh: true };
  }
  finish(
    guard: ExperimentGuard,
    operationId: string,
    result: { status: "succeeded" | "failed"; reference?: string },
  ) {
    const state = this.guard(guard);
    if (
      !result ||
      !["succeeded", "failed"].includes(result.status) ||
      (result.reference !== undefined &&
        (typeof result.reference !== "string" ||
          result.reference.length > 1024))
    )
      throw new ExperimentError("Invalid experiment result", 400);
    const reservation = state.reservations.find(
      (r) =>
        r.id === operationId &&
        r.sessionId === guard.sessionId &&
        r.epoch === guard.epoch,
    );
    if (!reservation)
      throw new ExperimentError("Unknown experiment reservation");
    if (reservation.status !== "reserved") {
      if (
        reservation.status !== result.status ||
        reservation.reference !== result.reference
      )
        throw new ExperimentError("Conflicting experiment result");
      return state;
    }
    reservation.status = result.status;
    if (result.reference !== undefined)
      reservation.reference = result.reference;
    return this.save(state, `${reservation.kind}-${result.status}`);
  }
  complete(guard: ExperimentGuard) {
    const state = this.guard(guard);
    if (state.reservations.some((r) => r.status === "reserved"))
      throw new ExperimentError("Experiment operations still in flight");
    return this.terminate(state, "completed", null);
  }
  fail(guard: ExperimentGuard, reason: string) {
    if (typeof reason !== "string" || !reason || reason.length > 1024)
      throw new ExperimentError("Invalid failure reason", 400);
    const state = this.status();
    if (
      !state.running ||
      state.sessionId !== guard.sessionId ||
      state.epoch !== guard.epoch
    )
      throw new ExperimentError("Stale experiment session");
    return this.terminate(state, "failed", reason);
  }
  history(afterVersion = 0) {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0)
      throw new ExperimentError("Invalid history cursor", 400);
    const rows = this.sql
      .exec(
        "SELECT body FROM experiment_history WHERE version>? ORDER BY version LIMIT 21",
        afterVersion,
      )
      .toArray();
    const events = rows
      .slice(0, 20)
      .map((row) => JSON.parse(String(row.body)) as ExperimentState);
    return {
      events,
      nextAfterVersion: rows.length > 20 ? events.at(-1)!.version : null,
    };
  }
}
