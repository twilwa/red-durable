import type {
  BridgeCacheScope,
  BridgeExperimentScope,
} from "../shared/bridge.ts";
import { isMeteredModel, validBridgeModel } from "../shared/providers.ts";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { MemorySql } from "./memory";
export interface InferenceJob {
  id: string;
  modelId: string;
  summary: boolean;
  context: Context;
  cache?: BridgeCacheScope;
  scope?: BridgeExperimentScope;
  options: { reasoning?: string; maxTokens?: number };
  leaseToken: string;
  expiresAt: number;
}
export interface BridgeResult {
  jobId: string;
  leaseToken: string;
  message?: AssistantMessage;
  error?: { kind: string; message: string; retryAfterMs?: number };
}
interface Row {
  id: string;
  payload: string;
  state: string;
  lease: string | null;
  expires: number;
  result: string | null;
  [key: string]: unknown;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${label}`);
  return value as Record<string, unknown>;
}
function number(value: unknown, label: string, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1e15 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error(`Invalid ${label}`);
  return value;
}
function boundedString(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value;
}
function jsonTree(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Tool arguments nesting exceeds32");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const v of value) jsonTree(v, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) jsonTree(v, depth + 1);
    return;
  }
  throw new Error("Invalid JSON tool argument");
}
/** Accept a narrow Pi response envelope, never arbitrary provider metadata or reasoning. */
export function normalizeBridgeMessage(
  value: unknown,
  modelId: string,
): AssistantMessage {
  const m = record(value, "assistant response");
  if (
    m.role !== "assistant" ||
    !Array.isArray(m.content) ||
    m.content.length > 1024 ||
    !["stop", "length", "toolUse", "error", "aborted"].includes(
      String(m.stopReason),
    )
  )
    throw new Error("Invalid assistant response");
  const content: AssistantMessage["content"] = [];
  const toolIds = new Set<string>();
  for (const item of m.content) {
    const block = record(item, "content block");
    if (block.type === "thinking") {
      if (typeof block.thinking !== "string")
        throw new Error("Invalid thinking block");
      continue;
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("Invalid text block");
      content.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "toolCall") {
      const id = boundedString(block.id, "tool call ID"),
        name = boundedString(block.name, "tool name", 128);
      if (!/^[a-zA-Z0-9_.:-]+$/.test(name) || toolIds.has(id))
        throw new Error("Invalid or duplicate tool call");
      toolIds.add(id);
      const args = record(block.arguments, "tool arguments");
      jsonTree(args);
      content.push({
        type: "toolCall",
        id,
        name,
        arguments: JSON.parse(JSON.stringify(args)),
      });
      continue;
    }
    throw new Error("Unsupported content block");
  }
  if (m.stopReason === "toolUse" && !toolIds.size)
    throw new Error("Tool-use response needs a tool call");
  const u = record(m.usage, "usage"),
    c = record(u.cost, "usage cost");
  const usage: AssistantMessage["usage"] = {
    input: number(u.input, "input tokens", true),
    output: number(u.output, "output tokens", true),
    cacheRead: number(u.cacheRead, "cache read", true),
    cacheWrite: number(u.cacheWrite, "cache write", true),
    totalTokens: number(u.totalTokens, "total tokens", true),
    cost: {
      input: number(c.input, "input cost"),
      output: number(c.output, "output cost"),
      cacheRead: number(c.cacheRead, "cache read cost"),
      cacheWrite: number(c.cacheWrite, "cache write cost"),
      total: number(c.total, "total cost"),
    },
  };
  if (u.reasoning !== undefined)
    usage.reasoning = number(u.reasoning, "reasoning tokens", true);
  if (u.cacheWrite1h !== undefined)
    usage.cacheWrite1h = number(u.cacheWrite1h, "cache write1h", true);
  const normalized: AssistantMessage = {
    role: "assistant",
    content,
    provider: "red-subscription",
    api: "red-subscription",
    model: modelId,
    usage,
    stopReason: m.stopReason as AssistantMessage["stopReason"],
    timestamp: number(m.timestamp, "timestamp", true),
  };
  if (m.stopReason === "error" || m.stopReason === "aborted")
    normalized.errorMessage =
      m.stopReason === "error"
        ? "Provider inference failed"
        : "Provider inference cancelled";
  return normalized;
}
const bridgeErrorMessages: Record<string, string> = {
  quota:
    "Provider usage or credit limit reached. Review that provider before retrying.",
  auth: "Provider credentials need attention. Reconnect on the trusted host.",
  model: "Requested model is unavailable to this connection.",
  transient: "Inference failed or was interrupted. Retry explicitly.",
  invalid:
    "Inference result is invalid or its outcome is unknown. Review before retrying.",
};

export class BridgeLeaseError extends Error {
  readonly status = 409;
}
export class BridgeQueue {
  private sql: MemorySql;
  constructor(sql: MemorySql) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_inference_alias (canonical TEXT PRIMARY KEY,current TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_bridge_config (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_inference (id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,lease TEXT,expires INTEGER NOT NULL DEFAULT 0,result TEXT,created INTEGER NOT NULL)",
    );
  }
  private cacheScope(
    summary: boolean,
    scope?: BridgeExperimentScope,
  ): BridgeCacheScope {
    // Persist UUID namespaces to remain compatible with trusted-host validation.
    const key = scope
      ? `prompt-cache-experiment-v1:${JSON.stringify([scope.sessionId, scope.epoch])}`
      : "prompt-cache-namespace-v1";
    this.sql.exec(
      "INSERT OR IGNORE INTO red_bridge_config(key,value) VALUES (?,?)",
      key,
      crypto.randomUUID(),
    );
    const namespace = String(
      this.sql
        .exec("SELECT value FROM red_bridge_config WHERE key=?", key)
        .toArray()[0].value,
    );
    return {
      version: 1,
      namespace,
      purpose: summary ? "summary" : "conversation",
    };
  }
  private row(id: string) {
    return this.sql
      .exec("SELECT * FROM red_inference WHERE id=?", id)
      .toArray()[0] as Row | undefined;
  }
  async enqueue(
    modelId: string,
    context: Context,
    options: { reasoning?: string; maxTokens?: number } = {},
    idempotencyKey?: string,
    scope?: BridgeExperimentScope,
  ) {
    if (scope) {
      if (scope.purpose !== "experiment")
        throw new Error("Invalid inference purpose");
      boundedString(scope.sessionId, "experiment session ID");
      boundedString(scope.operationId, "experiment operation ID");
      number(scope.epoch, "experiment epoch", true);
      if (!validBridgeModel(modelId) || isMeteredModel(modelId))
        throw new Error("Experiments require a subscription model");
      if (
        context.tools?.some(
          (tool) =>
            !["starter", "read", "propose", "validate", "report"].includes(
              tool.name,
            ),
        )
      )
        throw new Error(
          "Experiment inference only permits restricted session tools",
        );
    }
    const summary = !scope && Boolean(idempotencyKey);
    const payload = JSON.stringify({
      modelId,
      context,
      options,
      summary,
      ...(scope ? { scope } : {}),
      cache: this.cacheScope(summary, scope),
    });
    if (new TextEncoder().encode(payload).length > 300000)
      throw new Error("Inference request exceeds300KB");
    const stable = JSON.stringify(
      scope
        ? {
            purpose: scope.purpose,
            sessionId: scope.sessionId,
            epoch: scope.epoch,
            operationId: scope.operationId,
          }
        : idempotencyKey
          ? { modelId, idempotencyKey }
          : { modelId, context, options },
      (key, value) => (key === "timestamp" ? undefined : value),
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stable),
    );
    const id = Array.from(new Uint8Array(digest), (x) =>
      x.toString(16).padStart(2, "0"),
    ).join("");
    const existing = scope ? this.row(id) : undefined;
    if (existing) {
      const withoutTimestamps = (encoded: string) =>
        JSON.stringify(JSON.parse(encoded), (key, value) =>
          key === "timestamp" ? undefined : value,
        );
      if (withoutTimestamps(existing.payload) !== withoutTimestamps(payload))
        throw new Error("Experiment operation payload is immutable");
      return id;
    }
    const alias = this.sql
      .exec("SELECT current FROM red_inference_alias WHERE canonical=?", id)
      .toArray()[0];
    if (alias) return String(alias.current);
    this.sql.exec(
      "INSERT OR IGNORE INTO red_inference(id,payload,state,created) VALUES (?,?,?,?)",
      id,
      payload,
      "queued",
      Date.now(),
    );
    return id;
  }
  poll(
    now = Date.now(),
    allowExperiment?: (scope: BridgeExperimentScope) => boolean,
  ): InferenceJob | null {
    // A reservation permits one dispatch, including when a host dies mid-call.
    this.sql.exec(
      "UPDATE red_inference SET state='done',result=? WHERE state='leased' AND expires<? AND json_extract(payload,'$.scope.purpose')='experiment'",
      JSON.stringify({
        error: { kind: "invalid", message: bridgeErrorMessages.invalid },
      }),
      now,
    );
    while (true) {
      const row = this.sql
        .exec(
          "SELECT * FROM red_inference WHERE state='queued' OR (state='leased' AND expires<?) ORDER BY created LIMIT 1",
          now,
        )
        .toArray()[0] as Row | undefined;
      if (!row) return null;
      const payload = JSON.parse(row.payload);
      if (payload.scope?.purpose === "experiment") {
        let allowed = false;
        try {
          allowed = allowExperiment?.(payload.scope) === true;
        } catch {
          // Missing, stale, terminal, or expired sessions fail closed.
        }
        if (!allowed) {
          this.cancel(row.id);
          continue;
        }
      }
      // No await between session authorization and durable lease creation.
      const leaseToken = crypto.randomUUID(),
        expiresAt = now + 180000;
      this.sql.exec(
        "UPDATE red_inference SET state='leased',lease=?,expires=? WHERE id=?",
        leaseToken,
        expiresAt,
        row.id,
      );
      return { ...payload, id: row.id, leaseToken, expiresAt };
    }
  }

  finish(value: BridgeResult, now = Date.now()) {
    record(value, "bridge result");
    boundedString(value.jobId, "job ID", 128);
    boundedString(value.leaseToken, "lease token", 256);
    const row = this.row(value.jobId);
    if (!row) throw new BridgeLeaseError("Unknown inference job");
    if (row.lease !== value.leaseToken)
      throw new BridgeLeaseError("Stale inference lease");
    if (new TextEncoder().encode(JSON.stringify(value)).length > 256000)
      throw new Error("Inference result exceeds256KB");
    if (Boolean(value.message) === Boolean(value.error))
      throw new Error("Expected exactly one result or error");
    let normalized: Pick<BridgeResult, "message" | "error">;
    if (value.message) {
      const message = normalizeBridgeMessage(
        value.message,
        JSON.parse(row.payload).modelId,
      );
      normalized =
        message.stopReason === "error" || message.stopReason === "aborted"
          ? {
              error: {
                kind: "transient",
                message: bridgeErrorMessages.transient,
              },
            }
          : { message };
    } else {
      const e = record(value.error, "bridge error");
      const kind = boundedString(e.kind, "bridge error kind");
      if (
        !Object.hasOwn(bridgeErrorMessages, kind) ||
        typeof e.message !== "string" ||
        e.message.length > 2000
      )
        throw new Error("Invalid bridge error");
      normalized = {
        error: {
          kind,
          message: bridgeErrorMessages[kind],
          ...(e.retryAfterMs === undefined
            ? {}
            : {
                retryAfterMs: Math.min(
                  number(e.retryAfterMs, "retry delay", true),
                  86400000,
                ),
              }),
        },
      };
    }
    const encoded = JSON.stringify(normalized);
    if (row.state === "done") {
      if (row.result !== encoded)
        throw new Error("Conflicting duplicate result");
      return { accepted: false };
    }
    if (row.state !== "leased")
      throw new BridgeLeaseError("Inference job is not leased");
    if (now > row.expires)
      throw new BridgeLeaseError("Expired inference lease");
    this.sql.exec(
      "UPDATE red_inference SET state='done',result=? WHERE id=?",
      encoded,
      row.id,
    );
    return { accepted: true };
  }

  read(id: string): {
    state: string;
    message?: AssistantMessage;
    error?: { kind: string; message: string };
  } {
    const row = this.row(id);
    if (!row) throw new Error("Unknown inference job");
    return { state: row.state, ...(row.result ? JSON.parse(row.result) : {}) };
  }
  retrySummary(id: string) {
    const original = this.row(id);
    if (
      original &&
      JSON.parse(original.payload).scope?.purpose === "experiment"
    )
      throw new Error("Experiment retries require a new reserved operation");
    const previous = this.sql
      .exec("SELECT current FROM red_inference_alias WHERE canonical=?", id)
      .toArray()[0];
    if (previous && previous.current !== id)
      return { id: String(previous.current) };
    const row = this.row(id);
    if (
      !row ||
      row.state !== "done" ||
      !row.result ||
      !JSON.parse(row.result).error
    )
      throw new Error("Only failed summary jobs can be retried");
    const payload = JSON.parse(row.payload);
    if (!payload.summary)
      throw new Error("For chat, resubmit the original request instead");
    const next = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO red_inference(id,payload,state,created) VALUES (?,?,?,?)",
      next,
      row.payload,
      "queued",
      Date.now(),
    );
    this.sql.exec(
      "UPDATE red_inference_alias SET current=? WHERE current=?",
      next,
      id,
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO red_inference_alias(canonical,current) VALUES (?,?)",
      id,
      next,
    );
    return { id: next };
  }
  failures() {
    return this.sql
      .exec(
        "SELECT id,payload,result FROM red_inference WHERE state='done' AND NOT EXISTS (SELECT 1 FROM red_inference_alias WHERE canonical=red_inference.id AND current<>red_inference.id) AND json_extract(result,'$.error') IS NOT NULL ORDER BY created DESC LIMIT 20",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        summary: Boolean(JSON.parse(String(r.payload)).summary),
        ...(JSON.parse(String(r.payload)).scope?.purpose === "experiment"
          ? { purpose: "experiment" as const }
          : {}),
        error: JSON.parse(String(r.result)).error,
      }));
  }
  cancelExperiment(sessionId: string, epoch: number) {
    boundedString(sessionId, "experiment session ID");
    number(epoch, "experiment epoch", true);
    this.sql.exec(
      "UPDATE red_inference SET state='cancelled' WHERE state IN ('queued','leased') AND json_extract(payload,'$.scope.purpose')='experiment' AND json_extract(payload,'$.scope.sessionId')=? AND json_extract(payload,'$.scope.epoch')=?",
      sessionId,
      epoch,
    );
  }
  cancel(id: string) {
    this.sql.exec(
      "UPDATE red_inference SET state='cancelled' WHERE id=? AND state!='done'",
      id,
    );
  }
  setModels(ids: unknown) {
    if (
      !Array.isArray(ids) ||
      ids.length > 200 ||
      ids.some((x) => !validBridgeModel(x))
    )
      throw new Error("Invalid model catalog");
    this.sql.exec(
      "INSERT OR REPLACE INTO red_bridge_config(key,value) VALUES (?,?)",
      "models",
      JSON.stringify([...new Set(ids)]),
    );
  }
  models(): string[] {
    const r = this.sql
      .exec("SELECT value FROM red_bridge_config WHERE key=?", "models")
      .toArray()[0];
    return r ? JSON.parse(String(r.value)) : [];
  }
  stats() {
    return this.sql
      .exec("SELECT state,COUNT(*) AS count FROM red_inference GROUP BY state")
      .toArray();
  }
}
