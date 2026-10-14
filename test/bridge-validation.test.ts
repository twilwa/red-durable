import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BridgeQueue, normalizeBridgeMessage } from "../src/bridge-queue.ts";
const valid = () => ({
  role: "assistant",
  content: [{ type: "text", text: "Visible" }],
  api: "upstream",
  provider: "openai",
  model: "upstream",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});
test("bridge normalizes identifiers and strips reasoning and arbitrary metadata", () => {
  const m = valid();
  m.content.push({ type: "thinking", thinking: "PRIVATE REASONING" } as never);
  const got = normalizeBridgeMessage(
    {
      ...m,
      headers: { Authorization: "Bearer SECRET" },
      diagnostics: [{ secret: "SECRET" }],
      responseId: "SECRET",
    },
    "approved-model",
  );
  assert.equal(got.provider, "red-subscription");
  assert.equal(got.model, "approved-model");
  assert.deepEqual(got.content, [{ type: "text", text: "Visible" }]);
  assert.ok(!JSON.stringify(got).includes("SECRET"));
  assert.ok(!JSON.stringify(got).includes("PRIVATE"));
});
test("bridge rejects malformed blocks, usage, tools and nested arguments", () => {
  for (const change of [
    { role: "system" },
    { content: [null] },
    { content: [{ type: "text", text: 3 }] },
    { content: [{ type: "image", data: "x" }] },
    { usage: undefined },
    { usage: { ...valid().usage, input: -1 } },
    { timestamp: Infinity },
    { stopReason: "deferred" },
    { stopReason: "toolUse", content: [] },
    { content: [{ type: "toolCall", id: "x", name: "f", arguments: [] }] },
  ])
    assert.throws(() => normalizeBridgeMessage({ ...valid(), ...change }, "m"));
  const tool = {
    type: "toolCall",
    id: "id",
    name: "memory_zoom",
    arguments: { id: 1, count: 1 },
  };
  assert.equal(
    normalizeBridgeMessage(
      { ...valid(), stopReason: "toolUse", content: [tool] },
      "m",
    ).content[0].type,
    "toolCall",
  );
  assert.throws(() =>
    normalizeBridgeMessage(
      { ...valid(), stopReason: "toolUse", content: [tool, tool] },
      "m",
    ),
  );
  let nested: unknown = {};
  for (let i = 0; i < 35; i++) nested = { child: nested };
  assert.throws(() =>
    normalizeBridgeMessage(
      { ...valid(), content: [{ ...tool, arguments: nested }] },
      "m",
    ),
  );
});
test("queue rejects malformed result before commit and sanitizes duplicate error receipts", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q: string, ...args: (string | number | null)[]) {
      const s = db.prepare(q);
      return {
        toArray: () =>
          s.columns().length ? s.all(...args) : (s.run(...args), []),
      };
    },
  };
  // Match immediate Durable Object SQL execution semantics.
  sql.exec = (q, ...args) => {
    const s = db.prepare(q);
    const rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
    return { toArray: () => rows };
  };
  const queue = new BridgeQueue(sql);
  const id = await queue.enqueue("m", { messages: [] });
  const job = queue.poll()!;
  assert.throws(() =>
    queue.finish({
      jobId: id,
      leaseToken: job.leaseToken,
      message: { ...valid(), content: [null] } as never,
    }),
  );
  assert.equal(queue.read(id).state, "leased");
  const result = {
    jobId: id,
    leaseToken: job.leaseToken,
    error: { kind: "auth", message: "SECRET upstream credential" },
  };
  assert.equal(queue.finish(result).accepted, true);
  assert.equal(queue.finish(result).accepted, false);
  assert.ok(!JSON.stringify(queue.read(id)).includes("SECRET"));
  db.close();
});
test("owner summary retry allocates one fresh attempt and survives alias restart", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q: string, ...args: (string | number | null)[]) {
      const s = db.prepare(q);
      const rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const queue = new BridgeQueue(sql);
  const context = { messages: [] };
  const id = await queue.enqueue(
    "m",
    context,
    {},
    "red-memory:leaf:1:1:sourcehash",
  );
  const job = queue.poll()!;
  queue.finish({
    jobId: id,
    leaseToken: job.leaseToken,
    error: { kind: "quota", message: "Limited" },
  });
  const retry = queue.retrySummary(id);
  assert.notEqual(retry.id, id);
  assert.equal(queue.retrySummary(id).id, retry.id);
  const reopened = new BridgeQueue(sql);
  assert.equal(
    await reopened.enqueue("m", context, {}, "red-memory:leaf:1:1:sourcehash"),
    retry.id,
  );
  assert.equal(reopened.poll()?.id, retry.id);
  assert.equal(reopened.poll(), null);
  assert.ok(!reopened.failures().some((f) => f.id === id));
  db.close();
});
test("terminal assistant errors normalize to retryable sanitized failure envelopes", async () => {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q: string, ...args: (string | number | null)[]) {
      const s = db.prepare(q);
      const rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
      return { toArray: () => rows };
    },
  };
  const q = new BridgeQueue(sql);
  for (const stopReason of ["error", "aborted"]) {
    const id = await q.enqueue(
      "m",
      { messages: [] },
      {},
      `red-memory:${stopReason}`,
    );
    const job = q.poll()!;
    q.finish({
      jobId: id,
      leaseToken: job.leaseToken,
      message: { ...valid(), stopReason, errorMessage: "SECRET" } as never,
    });
    assert.equal(q.read(id).error?.kind, "transient");
    assert.equal(q.read(id).message, undefined);
    assert.ok(!JSON.stringify(q.read(id)).includes("SECRET"));
    const retry = q.retrySummary(id);
    assert.notEqual(retry.id, id);
    q.cancel(retry.id);
  }
  db.close();
});
