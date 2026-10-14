import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BridgeQueue } from "../src/bridge-queue.ts";
import { subscriptionProvider } from "../src/bridge-provider.ts";
import { createModels } from "@earendil-works/pi-ai";
function setup() {
  const db = new DatabaseSync(":memory:");
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
