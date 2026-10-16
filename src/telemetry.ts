import type { MemorySql } from "./memory.ts";
export const TELEMETRY_KINDS = [
  "run_start",
  "run_end",
  "tool_start",
  "tool_end",
  "model_end",
  "quota",
  "failure",
  "skill_proposal",
  "skill_evaluation",
  "skill_activation",
] as const;
export type TelemetryKind = (typeof TELEMETRY_KINDS)[number];
export interface TelemetryInput {
  sessionId: string;
  runId: string;
  kind: TelemetryKind;
  tool?: string;
  sourceEntryId?: string;
  archiveMessageId?: number;
  outcome?: "ok" | "error" | "cancelled" | "deferred";
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-adapter counts only; adapters may default unreported usage to zero. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  errorCode?:
    "quota" | "auth" | "timeout" | "invalid" | "unavailable" | "unknown";
}
export interface TelemetryEvent extends TelemetryInput {
  id: number;
  at: string;
}
export interface TelemetryFilter {
  sessionId?: string;
  runId?: string;
  kind?: TelemetryKind;
  beforeId?: number;
  limit?: number;
}
/** Only host-generated machine identifiers and enumerated results enter this table.
 * Pattern filtering is defense in depth, not an arbitrary-secret detector. Never pass prompts,
 * tool arguments/results, exception messages, headers, credentials, or thinking. */
export function safeIdentifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ||
    /(?:sk-|Bearer|token|secret|password|eyJ)/i.test(value)
  )
    return "[redacted]";
  return value;
}
function metric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 1e12)
    : undefined;
}
function cacheTokens(value: unknown): number | undefined {
  // Reject rather than coerce or clamp reported token counts. This ceiling keeps
  // retained totals exact even at the maximum capacity of 10,000 events.
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1e9
    ? value
    : undefined;
}
export class TelemetryStore {
  private readonly sql: MemorySql;
  private readonly capacity: number;
  constructor(sql: MemorySql, capacity = 2000) {
    this.sql = sql;
    this.capacity = Math.max(10, Math.min(10000, Math.floor(capacity) || 2000));
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_telemetry (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE INDEX IF NOT EXISTS red_telemetry_run ON red_telemetry(run_id,id)",
    );
  }
  record(input: TelemetryInput): TelemetryEvent {
    if (!TELEMETRY_KINDS.includes(input.kind))
      throw new Error("Unsupported telemetry kind");
    const clean: TelemetryInput = {
      sessionId: safeIdentifier(input.sessionId),
      runId: safeIdentifier(input.runId),
      kind: input.kind,
    };
    if (input.tool !== undefined) clean.tool = safeIdentifier(input.tool);
    if (input.sourceEntryId !== undefined)
      clean.sourceEntryId = safeIdentifier(input.sourceEntryId);
    if (
      input.archiveMessageId !== undefined &&
      Number.isSafeInteger(input.archiveMessageId) &&
      input.archiveMessageId >= 0
    )
      clean.archiveMessageId = input.archiveMessageId;
    if (
      input.outcome &&
      ["ok", "error", "cancelled", "deferred"].includes(input.outcome)
    )
      clean.outcome = input.outcome;
    if (
      input.errorCode &&
      [
        "quota",
        "auth",
        "timeout",
        "invalid",
        "unavailable",
        "unknown",
      ].includes(input.errorCode)
    )
      clean.errorCode = input.errorCode;
    for (const key of ["durationMs", "inputTokens", "outputTokens"] as const) {
      const n = metric(input[key]);
      if (n !== undefined) clean[key] = n;
    }
    for (const key of ["cacheReadTokens", "cacheWriteTokens"] as const) {
      const n = cacheTokens(input[key]);
      if (n !== undefined) clean[key] = n;
    }
    const at = new Date().toISOString();
    const row = this.sql
      .exec(
        "INSERT INTO red_telemetry(at,session_id,run_id,kind,data) VALUES (?,?,?,?,?) RETURNING id",
        at,
        clean.sessionId,
        clean.runId,
        clean.kind,
        JSON.stringify(clean),
      )
      .toArray()[0];
    this.sql.exec(
      "DELETE FROM red_telemetry WHERE id <= (SELECT COALESCE(MAX(id),0)-? FROM red_telemetry)",
      this.capacity,
    );
    return { ...clean, id: Number(row.id), at };
  }
  query(filter: TelemetryFilter = {}) {
    const where: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of [
      ["sessionId", "session_id"],
      ["runId", "run_id"],
      ["kind", "kind"],
    ] as const)
      if (filter[key] !== undefined) {
        where.push(`${column}=?`);
        values.push(
          key === "kind" ? String(filter[key]) : safeIdentifier(filter[key]),
        );
      }
    if (filter.beforeId !== undefined) {
      if (!Number.isSafeInteger(filter.beforeId) || filter.beforeId < 1)
        throw new Error("Invalid cursor");
      where.push("id<?");
      values.push(filter.beforeId);
    }
    const limit = Math.max(
      1,
      Math.min(100, Math.floor(filter.limit ?? 20) || 20),
    );
    const rows = this.sql
      .exec(
        `SELECT id,at,data FROM red_telemetry ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
        ...values,
        limit + 1,
      )
      .toArray();
    const events: TelemetryEvent[] = [];
    let size = 0;
    for (const r of rows.slice(0, limit)) {
      const event = {
        ...JSON.parse(String(r.data)),
        id: Number(r.id),
        at: String(r.at),
      } as TelemetryEvent;
      const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
      if (size + bytes > 12000) break;
      events.push(event);
      size += bytes;
    }
    return {
      events,
      nextBeforeId:
        rows.length > events.length ? events[events.length - 1].id : null,
      retentionEvents: this.capacity,
    };
  }
  summary() {
    const rows = this.sql
      .exec("SELECT kind,COUNT(*) AS count FROM red_telemetry GROUP BY kind")
      .toArray();
    const metrics = this.sql
      .exec(
        "SELECT COUNT(DISTINCT session_id) AS sessions,COUNT(DISTINCT run_id) AS runs,COALESCE(AVG(json_extract(data,'$.durationMs')),0) AS averageDurationMs,COALESCE(SUM(json_extract(data,'$.inputTokens')),0) AS inputTokens,COALESCE(SUM(json_extract(data,'$.outputTokens')),0) AS outputTokens,COALESCE(SUM(json_extract(data,'$.cacheReadTokens')),0) AS cacheReadTokens,COALESCE(SUM(json_extract(data,'$.cacheWriteTokens')),0) AS cacheWriteTokens FROM red_telemetry",
      )
      .toArray()[0];
    return {
      metrics,
      retentionEvents: this.capacity,
      counts: Object.fromEntries(rows.map((r) => [r.kind, Number(r.count)])),
      scope:
        "Retained events only. Cache token totals include only valid counts supplied by the provider adapter; zero or missing counts may mean unreported usage and do not prove a cache hit or miss. No cache-hit rate, billed cost or savings are inferred. No raw messages, prompts, prompt hashes, cache identities, credentials, tool payloads or private reasoning.",
    };
  }
  hasRun(runId: string) {
    return (
      this.sql
        .exec(
          "SELECT id FROM red_telemetry WHERE run_id=? LIMIT 1",
          safeIdentifier(runId),
        )
        .toArray().length > 0
    );
  }
}
