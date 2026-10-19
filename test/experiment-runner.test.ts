// Synthetic model replies only; real SQLite, no provider or account access.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ExperimentStore } from "../src/experiments.ts";
import { ExperimentRunner } from "../src/experiment-runner.ts";
import { BridgeQueue } from "../src/bridge-queue.ts";
const revision = "a".repeat(64),
  proposed = "b".repeat(64);
function fixture(overrides = {}, hooks = {}) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q, ...args) {
      const st = db.prepare(q);
      const rows = st.columns().length
        ? st.all(...args)
        : (st.run(...args), []);
      return { toArray: () => rows };
    },
  };
  let catalog = ["gpt-test"];
  const store = new ExperimentStore(
    sql,
    () => Date.now(),
    () => catalog,
  );
  const queue = new BridgeQueue(sql);
  let proposals = 0,
    tests = 0;
  const releases = {
    async get(id) {
      return { id, source: "synthetic source" };
    },
    async propose(_input, guard) {
      proposals++;
      await hooks.propose?.();
      guard?.();
      return { id: proposed };
    },
    async validate(_id, signal, options) {
      tests++;
      await hooks.validate?.(signal);
      options.guard();
      assert.equal(options.evidenceOnly, true);
      return { ok: true };
    },
  };
  const runner = new ExperimentRunner(sql, store, queue, releases as any);
  store.configure(
    {
      goal: "Improve synthetic counter",
      startingRevisionId: revision,
      modelId: "gpt-test",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxGenerations: 3,
      maxOutputTokens: 12288,
      maxProposals: 1,
      maxTests: 1,
      sandbox: "disposable-candidate-v1",
      paidInferenceBudgetUsd: 0,
      externalAccess: false,
      ...overrides,
    },
    0,
  );
  store.start(store.status().version);
  return {
    db,
    store,
    queue,
    runner,
    sql,
    counts: () => ({ proposals, tests }),
    setCatalog: (models) => {
      catalog = models;
    },
  };
}
function result(queue, content) {
  const job = queue.poll(Date.now(), () => true);
  assert.ok(job);
  queue.finish({
    jobId: job.id,
    leaseToken: job.leaseToken,
    message: {
      role: "assistant",
      content,
      provider: "synthetic",
      api: "synthetic",
      model: "gpt-test",
      stopReason: content.some((c) => c.type === "toolCall")
        ? "toolUse"
        : "stop",
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
}
const call = (name, args, id = "call-1") => ({
  type: "toolCall",
  name,
  arguments: args,
  id,
});
test("one owner start drives proposal, candidate test and report without individual approvals", async () => {
  const f = fixture();
  await f.runner.tick();
  result(f.queue, [
    call("propose", { source: "synthetic", description: "fixture" }),
  ]);
  await f.runner.tick();
  result(f.queue, [call("validate", { id: proposed })]);
  await f.runner.tick();
  result(f.queue, [
    call("report", { text: "Synthetic smoke passed; no quality claim." }),
  ]);
  await f.runner.tick();
  assert.equal(f.store.status().state, "completed");
  assert.deepEqual(f.counts(), { proposals: 1, tests: 1 });
  assert.equal(f.store.status().reserved.generations, 3);
  assert.match(f.runner.report().report, /Synthetic/);
  assert.equal(f.queue.poll(), null);
  f.db.close();
});
test("forbidden tool cannot reach owner registry, memory, or active facet", async () => {
  const f = fixture();
  await f.runner.tick();
  result(f.queue, [call("behavior_call", { name: "counter_increment" })]);
  await f.runner.tick();
  assert.equal(f.store.status().state, "failed");
  assert.deepEqual(f.counts(), { proposals: 0, tests: 0 });
  assert.equal(f.queue.poll(), null);
  f.db.close();
});
test("stop during candidate awaits fences completion and subsequent generation", async () => {
  let entered;
  const started = new Promise((r) => (entered = r));
  let finish;
  const waiting = new Promise((r) => (finish = r));
  const f = fixture(
    {},
    {
      validate: async () => {
        entered();
        await waiting;
      },
    },
  );
  await f.runner.tick();
  result(f.queue, [call("validate", { id: revision })]);
  const tick = f.runner.tick();
  await started;
  f.runner.stop();
  finish();
  await tick;
  assert.equal(f.store.status().state, "stopped");
  assert.equal(f.store.status().reserved.tests, 1);
  assert.equal(f.store.status().reserved.generations, 1);
  assert.equal(f.queue.poll(), null);
  f.db.close();
});
test("budget exhaustion stops after tool result without an extra inference", async () => {
  const f = fixture({ maxGenerations: 1 });
  await f.runner.tick();
  result(f.queue, [call("starter", {})]);
  await f.runner.tick();
  assert.equal(f.store.status().state, "failed");
  assert.equal(f.store.status().reserved.generations, 1);
  assert.equal(f.queue.poll(), null);
  f.db.close();
});
test("restart after accepted result is stopped and never executes its tool", async () => {
  const f = fixture();
  await f.runner.tick();
  result(f.queue, [
    call("propose", { source: "fixture", description: "fixture" }),
  ]);
  const restored = new ExperimentStore(
    f.sql,
    () => Date.now(),
    () => ["gpt-test"],
  );
  const runner = new ExperimentRunner(f.sql, restored, f.queue, {} as any);
  await runner.tick();
  assert.equal(restored.status().state, "interrupted");
  assert.deepEqual(f.counts(), { proposals: 0, tests: 0 });
  assert.equal(restored.status().reserved.generations, 1);
  f.db.close();
});
test("repeated lifecycle wake never double consumes completed tool result", async () => {
  const f = fixture();
  await Promise.all([f.runner.tick(), f.runner.tick()]);
  result(f.queue, [
    call("propose", { source: "fixture", description: "fixture" }),
  ]);
  await Promise.all([f.runner.tick(), f.runner.tick(), f.runner.tick()]);
  assert.equal(f.counts().proposals, 1);
  assert.equal(f.store.status().reserved.generations, 2);
  f.runner.stop();
  f.db.close();
});

test("realistic source size is hashed for reservation rather than rejected as fingerprint", async () => {
  const f = fixture();
  await f.runner.tick();
  result(f.queue, [
    call("propose", {
      source: "synthetic".repeat(1000),
      description: "large fixture",
    }),
  ]);
  await f.runner.tick();
  assert.equal(f.counts().proposals, 1);
  assert.equal(
    f.store.status().reservations.find((r) => r.kind === "proposal")
      .payloadFingerprint.length,
    64,
  );
  f.runner.stop();
  f.db.close();
});
test("owner restart keeps quota but new session operation IDs do not collide", async () => {
  const f = fixture();
  await f.runner.tick();
  f.runner.stop();
  f.store.start(f.store.status().version);
  await f.runner.tick();
  assert.equal(f.store.status().running, true);
  assert.equal(f.store.status().reserved.generations, 2);
  f.runner.stop();
  f.db.close();
});
test("provider output over requested allowance stops future work and records excess", async () => {
  const f = fixture({ maxOutputTokens: 1 });
  await f.runner.tick();
  const job = f.queue.poll(Date.now(), () => true);
  assert.ok(job);
  f.queue.finish({
    jobId: job.id,
    leaseToken: job.leaseToken,
    message: {
      role: "assistant",
      content: [call("propose", { source: "fixture", description: "fixture" })],
      provider: "synthetic",
      api: "synthetic",
      model: "gpt-test",
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  await f.runner.tick();
  assert.equal(f.store.status().state, "failed");
  assert.equal(f.runner.report().providerReportedOutputTokens, 10);
  assert.equal(f.counts().proposals, 0);
  f.db.close();
});

test("model revocation while candidate is busy is terminal and fences late results", async () => {
  let entered;
  const started = new Promise((r) => (entered = r));
  let finish;
  const waiting = new Promise((r) => (finish = r));
  const f = fixture(
    {},
    {
      validate: async () => {
        entered();
        await waiting;
      },
    },
  );
  await f.runner.tick();
  result(f.queue, [call("validate", { id: revision })]);
  const tick = f.runner.tick();
  await started;
  f.setCatalog([]);
  f.runner.fence();
  assert.equal(f.store.status().state, "failed");
  f.setCatalog(["gpt-test"]);
  finish();
  await tick;
  assert.equal(f.store.status().state, "failed");
  assert.equal(f.store.status().reserved.generations, 1);
  assert.equal(f.queue.poll(), null);
  f.db.close();
});
