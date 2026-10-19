import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeQueue } from "../src/bridge-queue.ts";
import { subscriptionProvider } from "../src/bridge-provider.ts";
import { createModels } from "@earendil-works/pi-ai";
function setup(path = ":memory:") {
  const db = new DatabaseSync(path);
  const sql = {
    exec(q: string, ...args: (string | number | null)[]) {
      const s = db.prepare(q);
      const rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
      return { toArray: () => rows };
    },
  };
  return { db, sql, q: new BridgeQueue(sql) };
}
const context = {
  messages: [{ role: "user" as const, content: "Hi", timestamp: 1 }],
};
const message = {
  role: "assistant" as const,
  content: [{ type: "text" as const, text: "Hello" }],
  api: "openai-responses",
  provider: "openai",
  model: "local-test",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 2,
};
test("queue survives reopen, hashes retries, renews expired lease and rejects stale result", async () => {
  const { q, sql, db } = setup();
  const id = await q.enqueue("local-test", context);
  assert.equal(
    await q.enqueue("local-test", {
      messages: [{ ...context.messages[0], timestamp: 50 }],
    }),
    id,
  );
  const first = q.poll(1000)!;
  assert.equal(first.id, id);
  assert.equal(q.poll(1100), null);
  const reopened = new BridgeQueue(sql);
  const second = reopened.poll(182000)!;
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.throws(
    () =>
      q.finish({ jobId: id, leaseToken: first.leaseToken, message }, 182001),
    /Stale/,
  );
  assert.equal(
    q.finish({ jobId: id, leaseToken: second.leaseToken, message }, 182001)
      .accepted,
    true,
  );
  assert.equal(
    q.finish({ jobId: id, leaseToken: second.leaseToken, message }, 182001)
      .accepted,
    false,
  );
  assert.equal(reopened.read(id).message?.content[0].type, "text");
  db.close();
});
test("cancelled jobs cannot receive late results and malformed responses fail", async () => {
  const { q, db } = setup();
  const id = await q.enqueue("local-test", context);
  const job = q.poll()!;
  assert.throws(
    () => q.finish({ jobId: id, leaseToken: job.leaseToken }),
    /exactly one/,
  );
  q.cancel(id);
  assert.throws(
    () => q.finish({ jobId: id, leaseToken: job.leaseToken, message }),
    /not leased/,
  );
  db.close();
});
test("actual Pi models emits deferred response then final answer from durable queue", async () => {
  const { q, db } = setup();
  const models = createModels();
  models.setProvider(subscriptionProvider(q, () => ["local-test"]));
  const model = models.getModel("red-subscription", "local-test")!;
  const first = await models.completeSimple(model, context);
  assert.equal(first.stopReason, "deferred");
  const job = q.poll()!;
  q.finish({ jobId: job.id, leaseToken: job.leaseToken, message });
  const final = await models.fetchDeferred(model, first.deferred!);
  assert.equal(final.stopReason, "stop");
  assert.equal(final.provider, "red-subscription");
  assert.deepEqual(final.content, message.content);
  db.close();
});

// Synthetic model fixtures only; these tests do not exercise provider login.
const experiment = {
  purpose: "experiment" as const,
  sessionId: "session-a",
  epoch: 1,
  operationId: "reserved-attempt-1",
};
test("experiment operation identity and cache stay isolated from chat and summaries across reopen", async () => {
  const { q, sql, db } = setup();
  const chat = await q.enqueue("local-test", context);
  const summary = await q.enqueue("local-test", context, {}, "same-key");
  const id = await q.enqueue("local-test", context, {}, "same-key", experiment);
  assert.equal(
    await new BridgeQueue(sql).enqueue(
      "local-test",
      context,
      {},
      undefined,
      experiment,
    ),
    id,
  );
  await assert.rejects(
    q.enqueue("another-subscription-model", context, {}, undefined, experiment),
    /immutable/,
  );
  const next = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    operationId: "reserved-attempt-2",
  });
  const otherSession = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    sessionId: "session-b",
  });
  const otherEpoch = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    epoch: 2,
  });
  assert.equal(
    new Set([chat, summary, id, next, otherSession, otherEpoch]).size,
    6,
  );
  const payload = (jobId: string) =>
    JSON.parse(
      String(
        sql
          .exec("SELECT payload FROM red_inference WHERE id=?", jobId)
          .toArray()[0].payload,
      ),
    );
  assert.equal(payload(id).summary, false);
  assert.equal(payload(summary).summary, true);
  assert.equal(payload(id).cache.purpose, "conversation");
  assert.notEqual(payload(id).cache.namespace, payload(chat).cache.namespace);
  assert.notEqual(
    payload(id).cache.namespace,
    payload(summary).cache.namespace,
  );
  assert.notEqual(
    payload(id).cache.namespace,
    payload(otherSession).cache.namespace,
  );
  assert.notEqual(
    payload(id).cache.namespace,
    payload(otherEpoch).cache.namespace,
  );
  assert.deepEqual(payload(id).cache, payload(next).cache);
  db.close();
});

test("experiment cancellation fences queued and leased work only in the selected epoch", async () => {
  const { q, sql, db } = setup();
  const completed = await q.enqueue(
    "local-test",
    context,
    {},
    undefined,
    experiment,
  );
  const completedJob = q.poll(Date.now(), () => true)!;
  q.finish({ jobId: completed, leaseToken: completedJob.leaseToken, message });
  const leased = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    operationId: "leased",
  });
  const job = q.poll(Date.now(), () => true)!;
  const queued = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    operationId: "queued",
  });
  const otherEpoch = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    epoch: 2,
  });
  const otherSession = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    sessionId: "other",
  });
  const chat = await q.enqueue("local-test", context);
  new BridgeQueue(sql).cancelExperiment(experiment.sessionId, experiment.epoch);
  assert.equal(q.read(completed).state, "done");
  assert.equal(q.read(leased).state, "cancelled");
  assert.equal(q.read(queued).state, "cancelled");
  for (const id of [otherEpoch, otherSession, chat])
    assert.equal(q.read(id).state, "queued");
  assert.throws(
    () => q.finish({ jobId: leased, leaseToken: job.leaseToken, message }),
    /not leased/,
  );
  db.close();
});

test("experiment attempts cannot use generic retry, metered models, or broad tools", async () => {
  const { q, db } = setup();
  for (const model of ["openrouter::model", "opencode-zen::model"]) {
    await assert.rejects(
      q.enqueue(model, context, {}, undefined, experiment),
      /subscription model/,
    );
  }
  await assert.rejects(
    q.enqueue(
      "local-test",
      {
        ...context,
        tools: [
          { name: "tool", description: "fixture", parameters: {} as never },
        ],
      },
      {},
      undefined,
      experiment,
    ),
    /restricted session tools/,
  );
  const id = await q.enqueue(
    "local-test",
    context,
    {},
    "summary-looking-key",
    experiment,
  );
  const job = q.poll(Date.now(), () => true)!;
  q.finish({
    jobId: id,
    leaseToken: job.leaseToken,
    error: { kind: "transient", message: "synthetic failure" },
  });
  assert.throws(() => q.retrySummary(id), /reserved operation/);
  assert.deepEqual(
    q.failures().map(({ summary, purpose }) => ({ summary, purpose })),
    [{ summary: false, purpose: "experiment" }],
  );
  assert.equal(
    await q.enqueue("local-test", context, {}, undefined, experiment),
    id,
  );
  assert.equal(
    q.poll(Date.now(), () => true),
    null,
  );
  db.close();
});

test("experiment cache and cancellation persist after closing and reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "red-experiment-queue-"));
  const path = join(directory, "queue.sqlite");
  let database: DatabaseSync | undefined;
  try {
    const first = setup(path);
    database = first.db;
    const id = await first.q.enqueue(
      "local-test",
      context,
      {},
      undefined,
      experiment,
    );
    const job = first.q.poll(Date.now(), () => true)!;
    first.q.cancelExperiment(experiment.sessionId, experiment.epoch);
    first.db.close();
    database = undefined;
    const reopened = setup(path);
    database = reopened.db;
    assert.equal(
      await reopened.q.enqueue(
        "local-test",
        context,
        {},
        undefined,
        experiment,
      ),
      id,
    );
    assert.equal(reopened.q.read(id).state, "cancelled");
    assert.equal(
      reopened.q.poll(Date.now(), () => true),
      null,
    );
    assert.throws(
      () =>
        reopened.q.finish({ jobId: id, leaseToken: job.leaseToken, message }),
      /not leased/,
    );
    await reopened.q.enqueue("local-test", context, {}, undefined, {
      ...experiment,
      operationId: "next-reserved-operation",
    });
    assert.deepEqual(reopened.q.poll(Date.now(), () => true)!.cache, job.cache);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired experiment leases never dispatch a second provider attempt", async () => {
  const { q, db } = setup();
  const id = await q.enqueue("local-test", context, {}, undefined, experiment);
  const job = q.poll(1000, () => true)!;
  assert.equal(
    q.poll(182000, () => true),
    null,
  );
  assert.equal(q.read(id).state, "done");
  assert.equal(q.read(id).error?.kind, "invalid");
  assert.throws(
    () => q.finish({ jobId: id, leaseToken: job.leaseToken, message }, 182001),
    /Conflicting/,
  );
  assert.throws(() => q.retrySummary(id), /reserved operation/);
  assert.equal(
    await q.enqueue("local-test", context, {}, undefined, experiment),
    id,
  );
  assert.equal(
    q.poll(190000, () => true),
    null,
  );
  db.close();
});

test("experiment inference permits only its five restricted session tools", async () => {
  const { q, db } = setup();
  const tools = ["starter", "read", "propose", "validate", "report"].map(
    (name) => ({
      name,
      description: "Synthetic session tool",
      parameters: {} as never,
    }),
  );
  await q.enqueue(
    "local-test",
    { ...context, tools },
    {},
    undefined,
    experiment,
  );
  assert.deepEqual(q.poll(Date.now(), () => true)!.context.tools, tools);
  db.close();
});

test("experiment polling synchronously fences stale sessions and skips to authorized work", async () => {
  const { q, db } = setup();
  const stale = await q.enqueue(
    "local-test",
    context,
    {},
    undefined,
    experiment,
  );
  const currentScope = { ...experiment, epoch: 2 };
  const current = await q.enqueue(
    "local-test",
    context,
    {},
    undefined,
    currentScope,
  );
  const seen: unknown[] = [];
  const job = q.poll(Date.now(), (scope) => {
    seen.push(scope);
    return scope.sessionId === experiment.sessionId && scope.epoch === 2;
  })!;
  assert.deepEqual(seen, [experiment, currentScope]);
  assert.equal(job.id, current);
  assert.equal(q.read(stale).state, "cancelled");
  assert.equal(q.read(current).state, "leased");
  db.close();
});

test("experiment polling defaults closed and treats guard exceptions as denial", async () => {
  const { q, db } = setup();
  const orphan = await q.enqueue(
    "local-test",
    context,
    {},
    undefined,
    experiment,
  );
  const chat = await q.enqueue("local-test", context);
  assert.equal(q.poll()!.id, chat);
  assert.equal(q.read(orphan).state, "cancelled");
  const invalid = await q.enqueue("local-test", context, {}, undefined, {
    ...experiment,
    operationId: "invalid-session",
  });
  assert.equal(
    q.poll(Date.now(), () => {
      throw new Error("Session is expired");
    }),
    null,
  );
  assert.equal(q.read(invalid).state, "cancelled");
  db.close();
});
