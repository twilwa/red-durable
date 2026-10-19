import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExperimentStore,
  type ExperimentPolicy,
  type ExperimentGuard,
} from "../src/experiments.ts";
import type { MemorySql } from "../src/memory.ts";
const now = Date.parse("2026-10-19T00:00:00Z");
const policy: ExperimentPolicy = {
  goal: "Improve synthetic greeting fixture",
  startingRevisionId: "a".repeat(64),
  expiresAt: new Date(now + 3600000).toISOString(),
  maxGenerations: 3,
  maxOutputTokens: 100,
  maxProposals: 2,
  maxTests: 2,
  modelId: "subscription-fixture",
  sandbox: "disposable-candidate-v1",
  paidInferenceBudgetUsd: 0,
  externalAccess: false,
};
function setup(
  path = ":memory:",
  clock = () => now,
  models = () => ["subscription-fixture"],
) {
  const db = new DatabaseSync(path);
  const sql: MemorySql = {
    exec(query, ...args) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length
        ? (stmt.all(...args) as Record<string, unknown>[])
        : (stmt.run(...args), []);
      return { toArray: () => rows };
    },
  };
  return { db, sql, store: new ExperimentStore(sql, clock, models) };
}
function active(store: ExperimentStore) {
  const configured = store.configure(policy, store.status().version);
  const started = store.start(configured.version);
  return {
    sessionId: started.sessionId!,
    epoch: started.epoch,
  } satisfies ExperimentGuard;
}
test("experiments default disabled, policy strict and owner version fenced", () => {
  const { db, store, sql } = setup();
  assert.equal(store.status().state, "disabled");
  assert.throws(() => store.start(0));
  for (const change of [
    { externalAccess: true },
    { paidInferenceBudgetUsd: 1 },
    { sandbox: "live" },
    { maxGenerations: 0 },
    { maxOutputTokens: 1.5 },
    { maxTests: -1 },
    { maxProposals: 101 },
    { goal: " " },
    { startingRevisionId: "bad" },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 86400001).toISOString() },
    { modelId: "openrouter/paid" },
    { extraAuthority: true },
  ])
    assert.throws(() => store.configure({ ...policy, ...change }, 0));
  assert.throws(() => new ExperimentStore(sql, () => now).configure(policy, 0));
  store.configure(policy, 0);
  assert.throws(() => store.start(0));
  store.start(1);
  assert.throws(() => store.configure(policy, store.status().version));
  assert.throws(() => store.stop(0));
  assert.equal(store.stop().state, "stopped");
  db.close();
});
test("reservations are exactly once, payload bound, quota charged before effects and never refunded", () => {
  const { db, store } = setup();
  const guard = active(store);
  const first = store.reserve(guard, "gen-1", "generation", "payload-a", 60);
  assert.equal(first.fresh, true);
  const version = store.status().version;
  assert.equal(
    store.reserve(guard, "gen-1", "generation", "payload-a", 60).replay,
    true,
  );
  assert.equal(store.status().version, version);
  assert.throws(() =>
    store.reserve(guard, "gen-1", "generation", "payload-b", 60),
  );
  assert.throws(() => store.reserve(guard, "gen-1", "test", "payload-a"));
  assert.throws(() =>
    store.reserve(guard, "gen-1", "generation", "payload-a", 61),
  );
  assert.throws(() =>
    store.reserve(guard, "gen-2", "generation", "payload", 41),
  );
  store.finish(guard, "gen-1", { status: "failed" });
  assert.equal(store.status().reserved.outputTokens, 60);
  store.finish(guard, "gen-1", { status: "failed" });
  assert.throws(() => store.finish(guard, "gen-1", { status: "succeeded" }));
  store.reserve(guard, "gen-2", "generation", "payload", 40);
  assert.throws(() =>
    store.reserve(guard, "gen-3", "generation", "payload", 1),
  );
  for (const kind of ["proposal", "test"] as const) {
    store.reserve(guard, `${kind}-1`, kind, "a");
    store.reserve(guard, `${kind}-2`, kind, "b");
    assert.throws(() => store.reserve(guard, `${kind}-3`, kind, "c"));
  }
  assert.deepEqual(store.status().reserved, {
    generations: 2,
    outputTokens: 100,
    proposals: 2,
    tests: 2,
  });
  assert.throws(() => store.complete(guard));
  assert.equal(store.fail(guard, "fixture-failure").state, "failed");
  assert.throws(() => store.finish(guard, "gen-2", { status: "succeeded" }));
  assert.throws(() => store.start(store.status().version));
  db.close();
});
test("stop invalidates delayed results and subsequent sessions retain consumed budget", () => {
  const { db, store } = setup();
  const old = active(store);
  store.reserve(old, "pending", "generation", "a", 30);
  store.stop();
  const state = store.start(store.status().version);
  const guard = { sessionId: state.sessionId!, epoch: state.epoch };
  assert.notEqual(guard.sessionId, old.sessionId);
  assert.throws(() => store.finish(old, "pending", { status: "succeeded" }));
  assert.throws(() => store.reserve(old, "late", "test", "a"));
  assert.throws(() => store.reserve(guard, "pending", "generation", "a", 30));
  assert.equal(store.status().reserved.outputTokens, 30);
  store.reserve(guard, "new", "generation", "b", 10);
  store.finish(guard, "new", {
    status: "succeeded",
    reference: "fixture-result",
  });
  assert.equal(store.complete(guard).state, "completed");
  assert.throws(() => store.guard(guard));
  db.close();
});
test("real SQLite close and reopen interrupts active session, persists quotas and never auto resumes", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-experiment-test-"));
  try {
    const path = join(dir, "state.sqlite");
    let connection = setup(path);
    const guard = active(connection.store);
    connection.store.reserve(guard, "in-flight", "generation", "fixture", 25);
    connection.db.close();
    connection = setup(path);
    const state = connection.store.status();
    assert.equal(state.state, "interrupted");
    assert.equal(state.running, false);
    assert.equal(state.reserved.generations, 1);
    assert.equal(state.reserved.outputTokens, 25);
    assert.equal(state.reservations[0].status, "interrupted");
    assert.throws(() =>
      connection.store.finish(guard, "in-flight", { status: "succeeded" }),
    );
    const version = state.version;
    connection.db.close();
    connection = setup(path);
    assert.equal(connection.store.status().version, version);
    assert.equal(connection.store.status().state, "interrupted");
    connection.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("expiry and removed subscription catalog fence asynchronous results", () => {
  let time = now,
    models = ["subscription-fixture"];
  const { db, store } = setup(
    ":memory:",
    () => time,
    () => models,
  );
  let guard = active(store);
  store.reserve(guard, "one", "generation", "a", 1);
  models = [];
  assert.throws(() => store.finish(guard, "one", { status: "succeeded" }));
  models = ["subscription-fixture"];
  time += 3600000;
  assert.throws(() => store.finish(guard, "one", { status: "succeeded" }));
  assert.equal(store.status().state, "expired");
  assert.equal(store.status().reserved.outputTokens, 1);
  assert.throws(() => store.start(store.status().version));
  db.close();
});
test("history is ordered with exact continuation cursor and generation limit enforced", () => {
  const { db, store } = setup();
  store.configure({ ...policy, maxGenerations: 20 }, 0);
  const started = store.start(1),
    guard = { sessionId: started.sessionId!, epoch: started.epoch };
  for (let i = 0; i < 20; i++) {
    store.reserve(guard, `g-${i}`, "generation", `fixture-${i}`, 1);
    store.finish(guard, `g-${i}`, { status: "succeeded" });
  }
  assert.throws(() => store.reserve(guard, "over", "generation", "fixture", 1));
  const first = store.history();
  assert.equal(first.events.length, 20);
  assert.equal(first.nextAfterVersion, 20);
  const second = store.history(first.nextAfterVersion!);
  assert.equal(second.events[0].version, 21);
  assert.equal(second.nextAfterVersion, 40);
  const third = store.history(second.nextAfterVersion!);
  assert.equal(third.events.length, 2);
  assert.equal(third.nextAfterVersion, null);
  assert.throws(() => store.history(-1));
  db.close();
});

test("failed atomic snapshot commit leaves quota and operation identity unconsumed", () => {
  const { db, store } = setup();
  const guard = active(store);
  const before = store.status();
  db.exec(
    "CREATE TRIGGER fail_experiment_commit BEFORE INSERT ON experiment_history BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END",
  );
  assert.throws(
    () => store.reserve(guard, "retry", "generation", "fixture", 10),
    /simulated storage failure/,
  );
  assert.deepEqual(store.status(), before);
  db.exec("DROP TRIGGER fail_experiment_commit");
  assert.equal(
    store.reserve(guard, "retry", "generation", "fixture", 10).fresh,
    true,
  );
  assert.equal(store.status().reserved.generations, 1);
  assert.equal(store.status().reserved.outputTokens, 10);
  db.close();
});
