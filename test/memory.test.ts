import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MemoryStore,
  mostDue,
  utf8Bytes,
  type MemorySql,
} from "../src/memory.ts";
function setup() {
  const db = new DatabaseSync(":memory:");
  const sql: MemorySql = {
    exec(q, ...args) {
      const s = db.prepare(q);
      return {
        toArray: () =>
          s.columns().length
            ? (s.all(...args) as Record<string, unknown>[])
            : (s.run(...args), []),
      };
    },
  };
  // DO exec executes immediately, toArray only materializes returned rows.
  sql.exec = (q, ...args) => {
    const s = db.prepare(q);
    const rows = s.columns().length
      ? (s.all(...args) as Record<string, unknown>[])
      : (s.run(...args), []);
    return { toArray: () => rows };
  };
  return { db, sql };
}
test("UTF-8 counting and exact raw zoom, dates, persistent views", async () => {
  const { sql, db } = setup();
  const memory = new MemoryStore(sql);
  assert.equal(utf8Bytes("🙂"), 4);
  const original = "🙂".repeat(200);
  const id = memory.append("user", original, "2026-10-09T00:00:00Z");
  assert.match(memory.renderView(), /not summarized yet/);
  const settled = await memory.settle(
    async () => "user: discussed emoji rendering",
  );
  assert.equal(settled.pending, 0);
  assert.equal(memory.zoom(id, 1).text, original);
  assert.equal(memory.date(id), "2026-10-09T00:00:00Z");
  assert.equal(new MemoryStore(sql).renderView(), memory.renderView());
  db.close();
});
test("due ordering measures pair end; recent pair wins recipe counterexample", () => {
  assert.equal(
    mostDue(
      [
        { level: 2, index: 0 },
        { level: 2, index: 1 },
        { level: 0, index: 8 },
        { level: 0, index: 9 },
      ],
      10,
      () => true,
    ),
    2,
  );
});
test("sawtooth compacts, preserves originals and persisted ordering", async () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql, { highBytes: 900, lowBytes: 450 });
  for (let i = 0; i < 100; i++) {
    m.append("user", `Message ${i} ${"x".repeat(40)}`);
    await m.settle(
      async ({ id, count }) =>
        `Messages ${id} through ${id + count - 1}: discussion`,
    );
  }
  assert.ok(m.stats().viewBytes <= 900);
  assert.equal(m.stats().messages, 100);
  assert.match(String(m.zoom(99, 1).text), /Message 99/);
  const view = m.renderView();
  assert.equal(
    new MemoryStore(sql, { highBytes: 900, lowBytes: 450 }).renderView(),
    view,
  );
  assert.equal(m.zoom(0, 2).children?.length, 2);
  assert.throws(() => m.zoom(1, 2));
  db.close();
});
test("failed compression remains retryable and never loses source", async () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql);
  const text = "a".repeat(1000);
  m.append("user", text);
  const first = await m.settle(async () => {
    throw new Error("offline");
  });
  assert.equal(first.failed, 1);
  assert.equal(first.pending, 1);
  assert.equal(m.zoom(0, 1).text, text);
  assert.match(m.renderView(), /not summarized yet/);
  const second = await m.settle(async () => "user: a long message");
  assert.equal(second.pending, 0);
  db.close();
});
test("byte retry uses shortest response, short leaves require no model", async () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql);
  m.append("user", "hi");
  let calls = 0;
  await m.settle(async () => {
    calls++;
    return "no";
  });
  assert.equal(calls, 0);
  m.append("user", "z".repeat(1200));
  await m.settle(async () =>
    ++calls === 1 ? "🙂".repeat(200) : "user: long text",
  );
  assert.ok(calls >= 2);
  assert.ok(!m.renderView().includes("🙂"));
  db.close();
});
test("every persisted view tiles originals with aligned power-of-two ranges", async () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql, { highBytes: 1100, lowBytes: 550 });
  const originals: string[] = [];
  for (let i = 0; i < 175; i++) {
    const text = `message-${i}: ${"日本語🙂".repeat((i % 20) + 1)}`;
    originals.push(text);
    m.append("user", text);
    await m.settle(
      async ({ id, count }) => `user: 記録 ${id}–${id + count - 1}`,
    );
    const lines = m.renderView().split("\n").slice(1, -1);
    let cursor = 0;
    for (const line of lines) {
      const match = /^(\d+)\+(\d+)\|/.exec(line);
      assert.ok(match);
      const id = Number(match[1]),
        count = Number(match[2]);
      assert.equal(id, cursor);
      assert.ok(Number.isInteger(Math.log2(count)));
      assert.equal(id % count, 0);
      cursor += count;
    }
    assert.equal(cursor, i + 1);
    if (i % 17 === 0)
      assert.equal(
        new MemoryStore(sql, { highBytes: 1100, lowBytes: 550 }).renderView(),
        m.renderView(),
      );
  }
  for (let i = 0; i < originals.length; i++)
    assert.equal(m.zoom(i, 1).text, originals[i]);
  assert.throws(() => m.append("thinking", "private"));
  assert.equal(m.stats().messages, originals.length);
  const nodes = sql.exec("SELECT text FROM mem_nodes").toArray();
  for (const node of nodes) assert.ok(utf8Bytes(String(node.text)) <= 512);
  db.close();
});
test("failed earliest leaf does not let more than seven later leaves overtake it", async () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql);
  const started: number[] = [];
  for (let i = 0; i < 12; i++) m.append("user", `${i}: ${"x".repeat(1000)}`);
  await m.settle(async ({ id, count }) => {
    if (count === 1) started.push(id);
    throw new Error("offline");
  });
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(m.stats().pending, 12);
  db.close();
});
test("zoom pages survive JSON tool budget and reconstruct escaped originals", () => {
  const { sql, db } = setup();
  const m = new MemoryStore(sql);
  const original = '\u0000\u0001\n\t\\"🙂日本語'.repeat(2500);
  m.append("user", original);
  let offset: number | null = 0;
  let reconstructed = "";
  let pages = 0;
  while (offset !== null) {
    const page = m.zoom(0, 1, offset);
    const serialized = JSON.stringify(page);
    assert.ok(serialized.length < 16_000);
    assert.ok(utf8Bytes(serialized) < 16_000);
    const delivered = JSON.parse(serialized);
    reconstructed += delivered.text;
    offset = delivered.nextOffset;
    pages++;
  }
  assert.equal(reconstructed, original);
  assert.ok(pages > 1);
  db.close();
});
