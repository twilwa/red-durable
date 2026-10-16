import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "../src/telemetry.ts";
import type { MemorySql } from "../src/memory.ts";

// Usage and payloads below are synthetic offline fixtures, not live cache evidence.
function setup(t: TestContext, capacity = 2000) {
  const dir = mkdtempSync(join(tmpdir(), "red-telemetry-cache-test-"));
  const path = join(dir, "telemetry.sqlite");
  let db = new DatabaseSync(path);
  const sql: MemorySql = {
    exec(query, ...args) {
      const statement = db.prepare(query);
      const rows = statement.columns().length
        ? statement.all(...args)
        : (statement.run(...args), []);
      return { toArray: () => rows };
    },
  };
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    sql,
    store: new TelemetryStore(sql, capacity),
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      return new TelemetryStore(sql, capacity);
    },
  };
}
const modelEvent = {
  sessionId: "synthetic-session",
  runId: "synthetic-run",
  kind: "model_end" as const,
};

test("cache telemetry preserves reported integers and distinguishes absent counts from zero", (t) => {
  const { store } = setup(t);
  const absent = store.record({ ...modelEvent, inputTokens: 100 });
  const zero = store.record({
    ...modelEvent,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const reported = store.record({
    ...modelEvent,
    inputTokens: 12,
    outputTokens: 8,
    cacheReadTokens: 2048,
    cacheWriteTokens: 1024,
  });
  assert.equal(Object.hasOwn(absent, "cacheReadTokens"), false);
  assert.equal(Object.hasOwn(absent, "cacheWriteTokens"), false);
  assert.equal(zero.cacheReadTokens, 0);
  assert.equal(zero.cacheWriteTokens, 0);
  assert.equal(reported.cacheReadTokens, 2048);
  assert.equal(reported.cacheWriteTokens, 1024);
  assert.deepEqual(store.query().events, [reported, zero, absent]);
  const summary = store.summary();
  assert.equal(summary.metrics.inputTokens, 112);
  assert.equal(summary.metrics.outputTokens, 8);
  assert.equal(summary.metrics.cacheReadTokens, 2048);
  assert.equal(summary.metrics.cacheWriteTokens, 1024);
  assert.match(summary.scope, /Retained events only/);
  assert.match(
    summary.scope,
    /only valid counts supplied by the provider adapter/,
  );
  assert.match(
    summary.scope,
    /zero or missing counts may mean unreported usage and do not prove a cache hit or miss/,
  );
  assert.match(
    summary.scope,
    /No cache-hit rate, billed cost or savings are inferred/,
  );
  assert.deepEqual(Object.keys(summary.metrics).sort(), [
    "averageDurationMs",
    "cacheReadTokens",
    "cacheWriteTokens",
    "inputTokens",
    "outputTokens",
    "runs",
    "sessions",
  ]);
});

test("cache telemetry rejects malformed counts without coercion or clamping", (t) => {
  const { store, sql } = setup(t);
  const hostileObject = {
    valueOf() {
      throw new Error("numeric coercion must not run");
    },
    toJSON() {
      throw new Error("raw payload serialization must not run");
    },
  };
  const invalid: unknown[] = [
    undefined,
    null,
    false,
    true,
    "123",
    "synthetic-private-prompt",
    "Bearer synthetic-credential",
    [],
    [123],
    {},
    hostileObject,
    new Number(123),
    () => 123,
    Symbol("synthetic-private-prompt"),
    123n,
    NaN,
    Infinity,
    -Infinity,
    -1,
    1.5,
    1e9 + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
  ];
  for (const value of invalid) {
    const read = store.record({
      ...modelEvent,
      cacheReadTokens: value,
      cacheWriteTokens: 2,
    } as never);
    assert.equal(Object.hasOwn(read, "cacheReadTokens"), false);
    assert.equal(read.cacheWriteTokens, 2);
    const write = store.record({
      ...modelEvent,
      cacheReadTokens: 3,
      cacheWriteTokens: value,
    } as never);
    assert.equal(write.cacheReadTokens, 3);
    assert.equal(Object.hasOwn(write, "cacheWriteTokens"), false);
  }
  const raw = JSON.stringify(sql.exec("SELECT * FROM red_telemetry").toArray());
  assert.ok(!raw.includes("synthetic-private-prompt"));
  assert.ok(!raw.includes("synthetic-credential"));
  assert.equal(store.summary().metrics.cacheReadTokens, invalid.length * 3);
  assert.equal(store.summary().metrics.cacheWriteTokens, invalid.length * 2);
});

test("cache telemetry drops cache identity, payloads, credentials and cost assertions", (t) => {
  const { store, sql } = setup(t);
  const event = store.record({
    ...modelEvent,
    cacheReadTokens: 42,
    cacheWriteTokens: 7,
    prompt: "synthetic-private-marker",
    promptHash: "synthetic-private-marker",
    cacheIdentity: "synthetic-private-marker",
    cacheKey: "synthetic-private-marker",
    sessionCacheKey: "synthetic-private-marker",
    prompt_cache_key: "synthetic-private-marker",
    apiKey: "synthetic-private-marker",
    credentials: "synthetic-private-marker",
    headers: { authorization: "synthetic-private-marker" },
    cacheHit: true,
    cacheMiss: false,
    savings: 99,
    billedCost: 0.01,
    cost: { cacheRead: 0.01, cacheWrite: 0.02 },
  } as never);
  assert.deepEqual(Object.keys(event).sort(), [
    "at",
    "cacheReadTokens",
    "cacheWriteTokens",
    "id",
    "kind",
    "runId",
    "sessionId",
  ]);
  assert.ok(
    !JSON.stringify(sql.exec("SELECT * FROM red_telemetry").toArray()).includes(
      "synthetic-private-marker",
    ),
  );
});

test("old telemetry rows remain unchanged through real SQLite close and reopen", (t) => {
  const state = setup(t);
  const legacy = {
    ...modelEvent,
    sourceEntryId: "synthetic-entry-1",
    archiveMessageId: 42,
    outcome: "ok",
    durationMs: 12,
    inputTokens: 80,
    outputTokens: 20,
  };
  const at = "2026-10-16T00:00:00.000Z";
  state.sql.exec(
    "INSERT INTO red_telemetry(id,at,session_id,run_id,kind,data) VALUES (?,?,?,?,?,?)",
    7,
    at,
    legacy.sessionId,
    legacy.runId,
    legacy.kind,
    JSON.stringify(legacy),
  );
  const before = state.sql.exec("SELECT * FROM red_telemetry").toArray();
  const reopened = state.reopen();
  assert.deepEqual(
    state.sql.exec("SELECT * FROM red_telemetry").toArray(),
    before,
  );
  assert.deepEqual(reopened.query().events, [{ ...legacy, id: 7, at }]);
  const summary = reopened.summary();
  assert.equal(summary.metrics.cacheReadTokens, 0);
  assert.equal(summary.metrics.cacheWriteTokens, 0);
  assert.equal(summary.metrics.inputTokens, 80);
  assert.equal(summary.metrics.outputTokens, 20);
  assert.equal(summary.metrics.averageDurationMs, 12);
  assert.equal(summary.counts.model_end, 1);
  assert.equal(reopened.hasRun(legacy.runId), true);
});

test("cache totals reflect retained events and survive real SQLite reopen and pagination", (t) => {
  const state = setup(t, 10);
  for (let n = 0; n < 15; n++)
    state.store.record({
      ...modelEvent,
      runId: `synthetic-run-${n}`,
      cacheReadTokens: n,
      ...(n % 2 === 0 ? { cacheWriteTokens: n * 2 } : {}),
    });
  const reopened = state.reopen();
  const summary = reopened.summary();
  assert.equal(summary.retentionEvents, 10);
  assert.equal(summary.counts.model_end, 10);
  assert.equal(summary.metrics.cacheReadTokens, 95);
  assert.equal(summary.metrics.cacheWriteTokens, 100);
  assert.equal(reopened.hasRun("synthetic-run-4"), false);
  const first = reopened.query({ limit: 3 });
  const rest = reopened.query({ beforeId: first.nextBeforeId!, limit: 100 });
  assert.equal(rest.nextBeforeId, null);
  assert.deepEqual(
    [...first.events, ...rest.events].map((event) => event.cacheReadTokens),
    [14, 13, 12, 11, 10, 9, 8, 7, 6, 5],
  );
  assert.equal(
    Object.hasOwn(
      reopened.query({ runId: "synthetic-run-13" }).events[0],
      "cacheWriteTokens",
    ),
    false,
  );
});

test("cache totals remain exact at maximum event and retention bounds", (t) => {
  const { store, sql } = setup(t, 10000);
  sql.exec("BEGIN");
  for (let n = 0; n < 10000; n++)
    store.record({
      ...modelEvent,
      cacheReadTokens: 1e9,
      cacheWriteTokens: 1e9 - 1,
    });
  sql.exec("COMMIT");
  const summary = store.summary();
  assert.equal(summary.counts.model_end, 10000);
  assert.equal(summary.metrics.cacheReadTokens, 10000000000000);
  assert.equal(summary.metrics.cacheWriteTokens, 9999999990000);
  assert.equal(Number.isSafeInteger(summary.metrics.cacheReadTokens), true);
  assert.equal(Number.isSafeInteger(summary.metrics.cacheWriteTokens), true);
});

test("cache metric pages stay byte-bounded without losing continuation events", (t) => {
  const { store } = setup(t);
  for (let n = 0; n < 100; n++)
    store.record({
      sessionId: "s".repeat(128),
      runId: "r".repeat(128),
      kind: "model_end",
      sourceEntryId: "e".repeat(128),
      tool: "t".repeat(128),
      archiveMessageId: n,
      cacheReadTokens: 1e9,
      cacheWriteTokens: 1e9,
    });
  let cursor: number | null = null;
  const ids: number[] = [];
  do {
    const page = store.query({
      limit: 100,
      ...(cursor ? { beforeId: cursor } : {}),
    });
    assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < 13000);
    assert.ok(page.events.length > 0);
    ids.push(...page.events.map((event) => event.id));
    cursor = page.nextBeforeId;
  } while (cursor !== null);
  assert.deepEqual(
    ids,
    Array.from({ length: 100 }, (_, n) => 100 - n),
  );
});
