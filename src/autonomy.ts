/** Trusted supervisor bootstrap controls. Never expose mutators to model tools.
 * No scheduler, inference, promotion, network or credential capabilities live here.
 * One append-only state snapshot per transition makes state + history atomic even
 * without cross-table transactions. Quotas count reservations, including failures.
 */
import type { MemorySql } from "./memory.ts";
export interface BootstrapPolicy {
  revisionId: string;
  sandbox: "disposable-candidate-v1";
  maxAttempts: number;
  expiresAt: string;
  paidInferenceBudgetUsd: 0;
  externalAccess: false;
}
type AttemptStatus =
  "running" | "passed" | "failed" | "stopped" | "interrupted";
interface Attempt {
  id: string;
  policyVersion: number;
  revisionId: string;
  status: AttemptStatus;
}
interface State {
  version: number;
  policyVersion: number;
  policy: BootstrapPolicy | null;
  stopped: boolean;
  attempts: Attempt[];
  lifetimeAttempts: number;
  event: string;
  at: string;
}
export class AutonomyError extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}
function exact(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    keys.some((k) => !(k in value))
  )
    throw new AutonomyError("Unexpected or missing policy fields", 400);
}
export class AutonomyStore {
  private sql: MemorySql;
  private now: () => number;
  constructor(sql: MemorySql, now = () => Date.now()) {
    this.sql = sql;
    this.now = now;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS autonomy_history (version INTEGER PRIMARY KEY, body TEXT NOT NULL)",
    );
    // Never replay an interrupted candidate or refund its reserved attempt.
    const state = this.read();
    if (state.attempts.some((a) => a.status === "running")) {
      state.attempts = state.attempts.map((a) =>
        a.status === "running" ? { ...a, status: "interrupted" } : a,
      );
      state.stopped = true;
      this.save(state, "restart-interrupted");
    }
  }
  private read(): State {
    const row = this.sql
      .exec("SELECT body FROM autonomy_history ORDER BY version DESC LIMIT 1")
      .toArray()[0];
    return row
      ? JSON.parse(String(row.body))
      : {
          version: 0,
          policyVersion: 0,
          policy: null,
          stopped: true,
          attempts: [],
          lifetimeAttempts: 0,
          event: "unconfigured",
          at: new Date(this.now()).toISOString(),
        };
  }
  private save(state: State, event: string) {
    const expected = state.version;
    state.version++;
    state.event = event;
    state.at = new Date(this.now()).toISOString();
    const result = this.sql
      .exec(
        "INSERT INTO autonomy_history(version,body) SELECT ?,? WHERE COALESCE((SELECT MAX(version) FROM autonomy_history),0)=? RETURNING version",
        state.version,
        JSON.stringify(state),
        expected,
      )
      .toArray();
    if (!result.length) throw new AutonomyError("Stale autonomy state");
    return state;
  }
  status() {
    const state = this.read();
    const blockers = [
      ...(!state.policy ? ["policy-unconfigured"] : []),
      ...(state.stopped ? ["owner-stop-latched"] : []),
      ...(state.policy && Date.parse(state.policy.expiresAt) <= this.now()
        ? ["policy-expired"]
        : []),
      ...(state.policy && state.attempts.length >= state.policy.maxAttempts
        ? ["attempt-budget-exhausted"]
        : []),
      ...(state.attempts.some((a) => a.status === "running")
        ? ["candidate-in-flight"]
        : []),
    ];
    return {
      ...state,
      explorationEnabled: false,
      explorationRunning: false,
      implementation: "owner-triggered-candidate-validation-only",
      bootstrapReady: blockers.length === 0,
      blockers,
      reservedAttempts: state.attempts.length,
      paidInferenceRequests: 0,
      externalRequests: 0,
      accountingScope:
        "bootstrap-only; excludes existing chat, platform hosting and manual tools",
    };
  }
  history(afterVersion = 0) {
    if (!Number.isSafeInteger(afterVersion) || afterVersion < 0)
      throw new AutonomyError("Invalid history cursor", 400);
    const rows = this.sql
      .exec(
        "SELECT body FROM autonomy_history WHERE version>? ORDER BY version LIMIT 21",
        afterVersion,
      )
      .toArray();
    const events = rows.slice(0, 20).map((r) => {
      const s = JSON.parse(String(r.body)) as State;
      return {
        version: s.version,
        policyVersion: s.policyVersion,
        event: s.event,
        at: s.at,
        stopped: s.stopped,
        lifetimeAttempts: s.lifetimeAttempts,
        revisionId: s.policy?.revisionId ?? null,
        latestAttempt: s.attempts.at(-1) ?? null,
      };
    });
    return {
      events,
      nextAfterVersion: rows.length > 20 ? events.at(-1)!.version : null,
    };
  }
  configure(input: unknown, expectedVersion: unknown) {
    exact(input, [
      "revisionId",
      "sandbox",
      "maxAttempts",
      "expiresAt",
      "paidInferenceBudgetUsd",
      "externalAccess",
    ]);
    if (
      typeof input.revisionId !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.revisionId) ||
      input.sandbox !== "disposable-candidate-v1" ||
      input.paidInferenceBudgetUsd !== 0 ||
      input.externalAccess !== false ||
      !Number.isSafeInteger(input.maxAttempts) ||
      Number(input.maxAttempts) < 1 ||
      Number(input.maxAttempts) > 20 ||
      typeof input.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= this.now() ||
      Date.parse(input.expiresAt) > this.now() + 86400000
    )
      throw new AutonomyError(
        "Invalid bootstrap limits; only candidate sandbox, 1–20 attempts, <=24 hours, zero paid inference and no external access are supported",
        400,
      );
    const state = this.read();
    if (expectedVersion !== state.version)
      throw new AutonomyError("Stale autonomy state");
    if (state.attempts.some((a) => a.status === "running"))
      throw new AutonomyError("Stop the running bootstrap before configuring");
    state.policy = {
      ...input,
      expiresAt: new Date(input.expiresAt).toISOString(),
    } as unknown as BootstrapPolicy;
    state.policyVersion++;
    state.attempts = [];
    state.stopped = true;
    this.save(state, "owner-configured");
    return this.status();
  }
  start(expectedVersion: unknown) {
    const state = this.read();
    if (expectedVersion !== state.version)
      throw new AutonomyError("Stale autonomy state");
    if (
      !state.policy ||
      Date.parse(state.policy.expiresAt) <= this.now() ||
      state.attempts.length >= state.policy.maxAttempts
    )
      throw new AutonomyError("Bootstrap policy is not ready");
    if (state.stopped) {
      state.stopped = false;
      this.save(state, "owner-started-bootstrap");
    }
    return this.status();
  }
  stop() {
    const state = this.read();
    if (!state.stopped || state.attempts.some((a) => a.status === "running")) {
      state.stopped = true;
      state.attempts = state.attempts.map((a) =>
        a.status === "running" ? { ...a, status: "stopped" } : a,
      );
      this.save(state, "owner-stopped-bootstrap");
    }
    return this.status();
  }
  reserve(id: unknown, revisionId: unknown, policyVersion: unknown) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))
      throw new AutonomyError("Invalid bootstrap request ID", 400);
    const state = this.read();
    if (
      policyVersion !== state.policyVersion ||
      revisionId !== state.policy?.revisionId
    )
      throw new AutonomyError("Stale or out-of-scope bootstrap policy");
    const existing = state.attempts.find((a) => a.id === id);
    if (existing) return { attempt: existing, fresh: false };
    if (!this.status().bootstrapReady)
      throw new AutonomyError("Bootstrap admission blocked");
    const attempt: Attempt = {
      id,
      revisionId: state.policy!.revisionId,
      policyVersion: state.policyVersion,
      status: "running",
    };
    state.attempts.push(attempt);
    state.lifetimeAttempts++;
    this.save(state, "candidate-reserved");
    return { attempt, fresh: true };
  }
  finish(id: string, policyVersion: number, status: "passed" | "failed") {
    const state = this.read();
    const attempt = state.attempts.find(
      (a) => a.id === id && a.policyVersion === policyVersion,
    );
    if (!attempt || attempt.status !== "running") return this.status();
    attempt.status = status;
    this.save(state, `candidate-${status}`);
    return this.status();
  }
}
/** Stop bypasses the supervisor's long-running work gate and cancels this facet.
 * Completion after a stop cannot overwrite the durable stopped outcome.
 */
export class BootstrapRunner {
  private active?: AbortController;
  private store: AutonomyStore;
  private validate: (id: string, signal: AbortSignal) => Promise<unknown>;
  constructor(
    store: AutonomyStore,
    validate: (id: string, signal: AbortSignal) => Promise<unknown>,
  ) {
    this.store = store;
    this.validate = validate;
  }
  stop() {
    const state = this.store.stop();
    this.active?.abort();
    return state;
  }
  async run(id: unknown, revisionId: unknown, policyVersion: unknown) {
    const admission = this.store.reserve(id, revisionId, policyVersion);
    if (!admission.fresh) return this.store.status();
    const controller = new AbortController();
    this.active = controller;
    try {
      await this.validate(admission.attempt.revisionId, controller.signal);
      this.store.finish(
        admission.attempt.id,
        admission.attempt.policyVersion,
        "passed",
      );
    } catch {
      this.store.finish(
        admission.attempt.id,
        admission.attempt.policyVersion,
        "failed",
      );
    } finally {
      if (this.active === controller) this.active = undefined;
    }
    return this.store.status();
  }
}
