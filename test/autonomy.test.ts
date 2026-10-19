import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutonomyStore, BootstrapRunner } from "../src/autonomy.ts";
const revisionId = "a".repeat(64);
const now = Date.parse("2026-10-19T00:00:00Z");
const policy = (overrides = {}) => ({
  revisionId,
  sandbox: "disposable-candidate-v1",
  maxAttempts: 2,
  expiresAt: new Date(now + 3600000).toISOString(),
  paidInferenceBudgetUsd: 0,
  externalAccess: false,
  ...overrides,
});
function setup(path = ":memory:", clock = () => now) {
  const db = new DatabaseSync(path);
  const store = new AutonomyStore(
    {
      exec(q, ...args) {
        const st = db.prepare(q);
        const rows = st.columns().length
          ? st.all(...args)
          : (st.run(...args), []);
        return { toArray: () => rows };
      },
    },
    clock,
  );
  return { db, store };
}
function arm(s: AutonomyStore, maxAttempts = 2) {
  s.configure(policy({ maxAttempts }), s.status().version);
  s.start(s.status().version);
}
test("default disabled and fail closed, strict policy fields and revision CAS", () => {
  const { db, store: s } = setup();
  assert.equal(s.status().explorationEnabled, false);
  assert.equal(s.status().stopped, true);
  assert.throws(() => s.reserve("one", revisionId, 0));
  assert.throws(() => s.start(0));
  for (const change of [
    { externalAccess: true },
    { paidInferenceBudgetUsd: 1 },
    { maxAttempts: 0 },
    { maxAttempts: 21 },
    { maxAttempts: 1.5 },
    { sandbox: "host" },
    { revisionId: "bad" },
    { credentials: "forbidden" },
    { expiresAt: "invalid" },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 86400001).toISOString() },
  ])
    assert.throws(() => s.configure(policy(change), 0));
  assert.equal(s.status().version, 0);
  assert.equal(s.history().events.length, 0);
  s.configure(policy(), 0);
  assert.equal(s.status().stopped, true);
  assert.throws(() => s.configure(policy(), 0));
  assert.throws(() => s.start(0));
  s.start(1);
  assert.equal(s.status().bootstrapReady, true);
  assert.throws(() => s.reserve("one", "b".repeat(64), 1));
  assert.throws(() => s.reserve("one", revisionId, 0));
  db.close();
});
test("attempt boundary counts failures and retries cannot spend again", async () => {
  const { db, store: s } = setup();
  arm(s, 1);
  let calls = 0;
  const runner = new BootstrapRunner(s, async () => {
    calls++;
    throw new Error("synthetic failure");
  });
  await runner.run("one", revisionId, 1);
  assert.equal(s.status().attempts[0].status, "failed");
  await runner.run("one", revisionId, 1);
  assert.equal(calls, 1);
  await assert.rejects(runner.run("two", revisionId, 1));
  assert.equal(s.status().reservedAttempts, 1);
  assert.equal(s.status().paidInferenceRequests, 0);
  assert.equal(s.status().externalRequests, 0);
  db.close();
});
test("stop is durable, idempotent and cancels actual runner signal; late result cannot restore success", async () => {
  const { db, store: s } = setup();
  arm(s);
  let signal: AbortSignal | undefined;
  let done!: () => void;
  const runner = new BootstrapRunner(s, async (_, sig) => {
    signal = sig;
    await new Promise<void>((resolve) => (done = resolve));
  });
  const running = runner.run("one", revisionId, 1);
  assert.equal(s.status().attempts[0].status, "running");
  await assert.rejects(runner.run("two", revisionId, 1));
  runner.stop();
  assert.equal(signal!.aborted, true);
  const v = s.status().version;
  runner.stop();
  assert.equal(s.status().version, v);
  done();
  await running;
  assert.equal(s.status().attempts[0].status, "stopped");
  assert.equal(s.status().stopped, true);
  await runner.run("one", revisionId, 1);
  await assert.rejects(runner.run("two", revisionId, 1));
  db.close();
});
test("real SQLite restart marks in-flight interrupted and keeps stop plus reserved quota", () => {
  const dir = mkdtempSync(join(tmpdir(), "red-autonomy-"));
  const path = join(dir, "state.sqlite");
  try {
    const a = setup(path);
    arm(a.store);
    a.store.reserve("one", revisionId, 1);
    a.db.close();
    const b = setup(path);
    assert.equal(b.store.status().stopped, true);
    assert.equal(b.store.status().attempts[0].status, "interrupted");
    assert.equal(b.store.status().reservedAttempts, 1);
    b.db.close();
    const c = setup(path);
    const version = c.store.status().version;
    c.store.stop();
    assert.equal(c.store.status().version, version);
    assert.equal(c.store.status().lifetimeAttempts, 1);
    c.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("expiry blocks admission, reconfiguration requires new revision and never refunds lifetime accounting", () => {
  let clock = now;
  const { db, store: s } = setup(":memory:", () => clock);
  arm(s);
  s.reserve("one", revisionId, 1);
  assert.throws(() => s.configure(policy(), s.status().version));
  s.finish("one", 1, "passed");
  clock += 3600000;
  assert.equal(s.status().bootstrapReady, false);
  assert.throws(() => s.reserve("two", revisionId, 1));
  s.configure(
    policy({ expiresAt: new Date(clock + 3600000).toISOString() }),
    s.status().version,
  );
  assert.equal(s.status().stopped, true);
  assert.equal(s.status().reservedAttempts, 0);
  assert.equal(s.status().lifetimeAttempts, 1);
  assert.throws(() => s.reserve("one", revisionId, 1));
  db.close();
});
test("history paginates bounded exact versions and includes owner/attempt outcomes without secrets", () => {
  const { db, store: s } = setup();
  for (let i = 0; i < 12; i++) {
    s.configure(policy(), s.status().version);
    s.start(s.status().version);
    s.stop();
  }
  const first = s.history();
  assert.equal(first.events.length, 20);
  assert.equal(first.nextAfterVersion, 20);
  const rest = s.history(first.nextAfterVersion!);
  assert.equal(rest.events.length, 16);
  assert.equal(rest.nextAfterVersion, null);
  assert.throws(() => s.history(-1));
  assert.doesNotMatch(JSON.stringify(s.status()), /token|credential|api_key/i);
  db.close();
});
