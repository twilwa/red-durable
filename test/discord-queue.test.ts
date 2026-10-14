import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordQueue } from "../src/discord-queue.ts";
import {
  validateDelivery,
  snowflake as relaySnowflake,
} from "../discord/protocol.mjs";
import {
  DiscordError,
  discordBinding,
  discordChunks,
  normalizeDiscordInput,
  snowflake,
  type DiscordBinding,
  type DiscordDelivery,
  type DiscordEnvironment,
} from "../shared/discord.ts";
import type { MemorySql } from "../src/memory.ts";

// All identities, credentials and messages below are synthetic offline fixtures.
const binding: DiscordBinding = {
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  ownerId: "100000000000000003",
  botId: "100000000000000004",
  session: "offline-discord-test",
};
const otherBinding: DiscordBinding = {
  ...binding,
  channelId: "100000000000000005",
  session: "offline-discord-other",
};
const inputId = "200000000000000001";
const deliveredId = "300000000000000001";
function message(id = inputId, overrides: Record<string, unknown> = {}) {
  return {
    id,
    guild_id: binding.guildId,
    channel_id: binding.channelId,
    author: { id: binding.ownerId, bot: false },
    type: 0,
    content: "Synthetic lighthouse question",
    attachments: [],
    ...overrides,
  };
}
function environment(
  overrides: Partial<DiscordEnvironment> = {},
): DiscordEnvironment {
  return {
    DISCORD_ENABLED: "true",
    DISCORD_RELAY_TOKEN: "fake-offline-relay-credential-000000000000",
    OWNER_TOKEN: "fake-offline-owner-credential-000000000000",
    BRIDGE_TOKEN: "fake-offline-bridge-credential-00000000000",
    DISCORD_GUILD_ID: binding.guildId,
    DISCORD_CHANNEL_ID: binding.channelId,
    DISCORD_OWNER_ID: binding.ownerId,
    DISCORD_BOT_ID: binding.botId,
    DISCORD_SESSION: binding.session,
    ...overrides,
  };
}
function rejects(action: () => unknown, status: number, pattern?: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DiscordError);
    assert.equal(error.status, status);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}
function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "red-discord-queue-test-"));
  const path = join(dir, "queue.sqlite");
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
  const state = {
    q: new DiscordQueue(sql),
    sql,
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      this.q = new DiscordQueue(sql);
      return this.q;
    },
  };
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return state;
}
function count(sql: MemorySql, table: "inbox" | "outbox", where = "1=1") {
  return Number(
    sql
      .exec(`SELECT COUNT(*) AS n FROM red_discord_${table} WHERE ${where}`)
      .toArray()[0].n,
  );
}
function receipt(delivery: DiscordDelivery, messageId = deliveredId) {
  return { id: delivery.id, leaseToken: delivery.leaseToken, messageId };
}
function seedInbox(sql: MemorySql, total: number, state = "done") {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
     INSERT INTO red_discord_inbox(id,payload,binding,state,created)
     SELECT 'seed-in-' || i, ?, ?, ?, i FROM n`,
    total,
    JSON.stringify(normalizeDiscordInput(message(), binding)),
    JSON.stringify(binding),
    state,
  );
}
function seedOutbox(sql: MemorySql, total: number, state = "sent") {
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
     INSERT INTO red_discord_outbox(id,input_id,binding,content,nonce,state,created)
     SELECT 'seed-out-' || i, ?, ?, 'Synthetic retained output', 'seed-' || i, ?, i FROM n`,
    total,
    inputId,
    JSON.stringify(binding),
    state,
  );
}

test("Discord transport is disabled unless explicitly enabled", () => {
  for (const DISCORD_ENABLED of [undefined, "", "false", "TRUE", "1"]) {
    assert.equal(discordBinding({ DISCORD_ENABLED }), null);
    assert.equal(
      discordBinding(
        environment({ DISCORD_ENABLED, DISCORD_RELAY_TOKEN: undefined }),
      ),
      null,
    );
  }
  assert.deepEqual(discordBinding(environment()), binding);
});

test("enabled Discord requires a distinct sufficiently long relay credential", () => {
  const env = environment();
  for (const DISCORD_RELAY_TOKEN of [
    undefined,
    "",
    "x".repeat(31),
    env.OWNER_TOKEN,
    env.BRIDGE_TOKEN,
  ]) {
    rejects(() => discordBinding(environment({ DISCORD_RELAY_TOKEN })), 503);
  }
  assert.ok(
    discordBinding(environment({ DISCORD_RELAY_TOKEN: "x".repeat(32) })),
  );
});

test("binding rejects absent, malformed or unsafe fixed identities and sessions", () => {
  for (const key of [
    "DISCORD_GUILD_ID",
    "DISCORD_CHANNEL_ID",
    "DISCORD_OWNER_ID",
    "DISCORD_BOT_ID",
  ] as const) {
    for (const value of [
      undefined,
      "",
      "123",
      "1".repeat(21),
      "1".repeat(16) + "a",
      " 100000000000000001",
    ]) {
      rejects(() => discordBinding(environment({ [key]: value })), 503);
    }
  }
  rejects(
    () => discordBinding(environment({ DISCORD_BOT_ID: binding.ownerId })),
    503,
  );
  for (const DISCORD_SESSION of [
    undefined,
    "",
    "a".repeat(65),
    "../owner",
    "session/name",
    "has space",
    "session\n",
    "démo",
  ]) {
    rejects(() => discordBinding(environment({ DISCORD_SESSION })), 503);
  }
  assert.ok(
    discordBinding(environment({ DISCORD_SESSION: "A_b-9".repeat(12) })),
  );
  assert.ok(discordBinding(environment({ DISCORD_SESSION: "a".repeat(64) })));
});

test("all four fixed Discord binding identities must be distinct", () => {
  const keys = [
    "DISCORD_GUILD_ID",
    "DISCORD_CHANNEL_ID",
    "DISCORD_OWNER_ID",
    "DISCORD_BOT_ID",
  ] as const;
  const env = environment();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      rejects(
        () => discordBinding(environment({ [keys[j]]: env[keys[i]] })),
        503,
      );
    }
  }
});

test("snowflake validation preserves strings without numeric coercion", () => {
  for (const value of [
    "1".repeat(17),
    "1".repeat(20),
    "18446744073709551615",
  ]) {
    assert.equal(snowflake(value), true);
    assert.equal(relaySnowflake(value), true);
  }
  for (const value of [
    null,
    undefined,
    100000000000000001,
    1n,
    {},
    [],
    "1".repeat(16),
    "1".repeat(21),
    "0".repeat(17),
    "0" + "1".repeat(17),
    "9".repeat(20),
    "18446744073709551616",
    "1e18",
    "-100000000000000001",
    "100000000000000001\n",
  ]) {
    assert.equal(snowflake(value), false);
    assert.equal(relaySnowflake(value), false);
  }
});

test("normalization accepts owner text and replies while retaining literal text", () => {
  const content =
    "  Synthetic @everyone <@100000000000000004>\n/activate never grants authority  ";
  for (const type of [0, 19]) {
    assert.deepEqual(
      normalizeDiscordInput(message(inputId, { content, type }), binding),
      {
        id: inputId,
        text: content,
        attachmentCount: 0,
        guildId: binding.guildId,
        channelId: binding.channelId,
        authorId: binding.ownerId,
      },
    );
  }
  assert.equal(
    normalizeDiscordInput(message(inputId, { webhook_id: null }), binding).id,
    inputId,
  );
});

test("hostile guild, channel, author, bot, webhook, DM and system messages fail closed", () => {
  const hostile: Record<string, unknown>[] = [
    { guild_id: otherBinding.guildId + "0" },
    { guild_id: null },
    { guild_id: undefined },
    { channel_id: otherBinding.channelId },
    { channel_id: null },
    { author: { id: "100000000000000099", bot: false } },
    { author: { id: binding.ownerId, bot: true } },
    { author: { id: binding.ownerId, bot: "false" } },
    { author: { id: binding.ownerId, bot: null } },
    { author: { id: binding.ownerId, bot: 0 } },
    { author: { id: binding.botId, bot: true } },
    { author: { id: binding.botId, bot: false } },
    { author: null },
    { author: undefined },
    { author: {} },
    { author: binding.ownerId },
    { webhook_id: "100000000000000009" },
    { webhook_id: "" },
    { type: 1 },
    { type: 6 },
    { type: 7 },
    { type: 20 },
    { type: 21 },
    { type: "0" },
    { type: null },
    { type: undefined },
    { type: NaN },
    { id: "not-a-snowflake" },
    { id: Number(inputId) },
  ];
  for (const overrides of hostile) {
    rejects(
      () => normalizeDiscordInput(message(inputId, overrides), binding),
      403,
    );
  }
});

test("ingress content is byte-bounded and attachments remain metadata only", () => {
  for (const content of ["x".repeat(32000), "🌊".repeat(8000)]) {
    assert.equal(
      normalizeDiscordInput(message(inputId, { content }), binding).text,
      content,
    );
  }
  for (const content of [
    "x".repeat(32001),
    "🌊".repeat(8001),
    "",
    " \n\t",
    null,
    {},
    42,
  ]) {
    rejects(
      () => normalizeDiscordInput(message(inputId, { content }), binding),
      400,
    );
  }
  const attachments = Array.from({ length: 10 }, () => ({
    url: "https://invalid.example/synthetic-do-not-fetch",
  }));
  assert.deepEqual(
    normalizeDiscordInput(
      message(inputId, { content: "", attachments }),
      binding,
    ),
    {
      id: inputId,
      text: "",
      attachmentCount: 10,
      guildId: binding.guildId,
      channelId: binding.channelId,
      authorId: binding.ownerId,
    },
  );
  for (const attachments of [null, {}, "attachment", Array(11).fill({})]) {
    rejects(
      () => normalizeDiscordInput(message(inputId, { attachments }), binding),
      400,
    );
  }
});

test("rejected ingress never changes durable inbox state", (t) => {
  const { q, sql } = setup(t);
  rejects(
    () =>
      q.receive(
        message(inputId, { author: { id: binding.botId, bot: true } }),
        binding,
        1,
      ),
    403,
  );
  rejects(
    () =>
      q.receive(message(inputId, { content: "x".repeat(32001) }), binding, 1),
    400,
  );
  assert.equal(count(sql, "inbox"), 0);
  assert.equal(q.next(binding), null);
  assert.equal(q.active(), null);
});

test("queued ingress persists through an actual SQLite close and reopen", (t) => {
  const state = setup(t);
  const result = state.q.receive(message(), binding, 10);
  assert.deepEqual(result, {
    accepted: true,
    duplicate: false,
    id: inputId,
    state: "queued",
  });
  assert.equal(state.q.active(), null);
  assert.equal(state.q.hasQueued(binding), true);
  const reopened = state.reopen();
  assert.deepEqual(
    reopened.next(binding),
    normalizeDiscordInput(message(), binding),
  );
  assert.equal(reopened.next(otherBinding), null);
  assert.equal(reopened.hasQueued(otherBinding), false);
  assert.deepEqual(reopened.receive(message(), binding, 999), {
    ...result,
    duplicate: true,
  });
  assert.equal(count(state.sql, "inbox"), 1);
});

test("duplicate ingress rejects changed content, attachment count or binding", (t) => {
  const { q, sql } = setup(t);
  q.receive(message(), binding, 1);
  for (const overrides of [
    { content: "Changed synthetic question" },
    { attachments: [{}] },
  ]) {
    rejects(
      () => q.receive(message(inputId, overrides), binding, 2),
      409,
      /Conflicting/,
    );
  }
  rejects(
    () =>
      q.receive(
        message(inputId, { channel_id: otherBinding.channelId }),
        otherBinding,
        2,
      ),
    409,
  );
  rejects(
    () => q.receive(message(), { ...binding, session: "changed-session" }, 2),
    409,
  );
  assert.equal(
    q.receive(
      message(inputId, { unrelated: "ignored transport metadata" }),
      binding,
      2,
    ).duplicate,
    true,
  );
  assert.equal(count(sql, "inbox"), 1);
  assert.equal(q.next(binding)?.text, message().content);
});

test("admission is FIFO with stable equal-time ordering and one global active turn", (t) => {
  const { q } = setup(t);
  const secondId = "200000000000000002";
  const otherId = "200000000000000003";
  q.receive(message(), binding, 10);
  q.receive(message(secondId), binding, 10);
  q.receive(
    message(otherId, { channel_id: otherBinding.channelId }),
    otherBinding,
    1,
  );
  assert.equal(q.next(binding)?.id, inputId);
  q.admitted(inputId, "synthetic-run-1");
  assert.deepEqual(q.active(), {
    input: normalizeDiscordInput(message(), binding),
    binding,
    runId: "synthetic-run-1",
  });
  assert.equal(q.next(binding)?.id, secondId);
  rejects(() => q.admitted(secondId, "synthetic-run-2"), 409);
  rejects(() => q.admitted(otherId, "synthetic-run-3"), 409);
  q.admitted(inputId, "synthetic-run-1");
  assert.equal(q.active()?.runId, "synthetic-run-1");
  q.complete(inputId);
  assert.equal(q.active(), null);
  q.admitted(secondId, "synthetic-run-2");
  assert.equal(q.active()?.input.id, secondId);
});

test("admitted work, run identity and deduplication survive restart through completion", (t) => {
  const state = setup(t);
  state.q.receive(message(), binding, 1);
  state.q.admitted(inputId, "synthetic-durable-run");
  let q = state.reopen();
  assert.equal(q.active()?.runId, "synthetic-durable-run");
  assert.equal(q.next(binding), null);
  assert.equal(q.receive(message(), binding, 2).state, "admitted");
  q.complete(inputId);
  q = state.reopen();
  assert.equal(q.active(), null);
  assert.equal(q.next(binding), null);
  assert.equal(q.receive(message(), binding, 3).state, "done");
  assert.equal(count(state.sql, "inbox"), 1);
});

test("inbox backpressure counts both queued and admitted work and accepts exact retries", (t) => {
  const { q, sql } = setup(t);
  for (let i = 0; i < 100; i++)
    q.receive(message(String(BigInt(inputId) + BigInt(i))), binding, i);
  q.admitted(inputId, "synthetic-active-run");
  rejects(() => q.receive(message("200000000000001000"), binding, 1000), 429);
  assert.equal(q.receive(message(), binding, 1000).duplicate, true);
  assert.equal(count(sql, "inbox"), 100);
  q.complete(inputId);
  assert.equal(
    q.receive(message("200000000000001000"), binding, 1001).duplicate,
    false,
  );
  assert.equal(count(sql, "inbox"), 101);
});

test("inbox retained-history limit is exact and does not discard completed records", (t) => {
  const { q, sql } = setup(t);
  seedInbox(sql, 9999);
  q.receive(message(), binding, 10000);
  q.complete(inputId);
  assert.equal(count(sql, "inbox"), 10000);
  rejects(() => q.receive(message("200000000000000002"), binding, 10001), 429);
  assert.equal(q.receive(message(), binding, 10002).duplicate, true);
  assert.equal(count(sql, "inbox"), 10000);
});

test("Discord chunks neutralize every mention without splitting surrogate pairs", () => {
  const text =
    "x".repeat(1899) +
    "🌊" +
    " @everyone @here <@123456789012345678> <@&123456789012345678>" +
    "🚢".repeat(1900);
  const chunks = discordChunks(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text.replace(/@/g, "@\u200b"));
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= 1900);
    assert.equal(chunk.isWellFormed(), true);
    assert.doesNotMatch(chunk, /@(?!\u200b)/);
  }
  assert.deepEqual(discordChunks(""), []);
  assert.deepEqual(discordChunks("x".repeat(1900)), ["x".repeat(1900)]);
  assert.deepEqual(discordChunks("x".repeat(1901)), ["x".repeat(1900), "x"]);
});

test("mention neutralization is safe at a chunk boundary", () => {
  const chunks = discordChunks("x".repeat(1899) + "@everyone");
  assert.equal(chunks.join(""), "x".repeat(1899) + "@\u200beveryone");
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.ok(chunks.every((chunk) => !chunk.includes("@everyone")));
});

test("all-whitespace replies produce no chunks or durable deliveries", (t) => {
  const { q, sql } = setup(t);
  const texts = [
    "",
    " ",
    "\t\r\n",
    " ".repeat(1900),
    " ".repeat(3801),
    "\u2003\u00a0".repeat(2000),
  ];
  for (const [index, text] of texts.entries()) {
    assert.deepEqual(discordChunks(text), []);
    q.enqueue(inputId, `whitespace-${index}`, text, binding, 100);
  }
  assert.equal(count(sql, "outbox"), 0);
  assert.equal(q.poll(binding, 101), null);
});

const whitespaceChunkFixtures = [
  {
    name: "leading exact whitespace chunk",
    text: " ".repeat(1900) + "Synthetic harbor reply",
    expected: ["Synthetic harbor reply"],
  },
  {
    name: "leading 1900-plus whitespace segment",
    text: " ".repeat(1901) + "Synthetic harbor reply  ",
    expected: [" Synthetic harbor reply  "],
  },
  {
    name: "intermediate whitespace chunks",
    text:
      "First useful text".padEnd(1900, " ") +
      "\t".repeat(3800) +
      "  Last useful text\n",
    expected: ["First useful text".padEnd(1900, " "), "  Last useful text\n"],
  },
  {
    name: "intermediate 1900-plus and trailing whitespace segments",
    text:
      "Useful text".padEnd(1900, "\n") +
      " ".repeat(1901) +
      "More useful text".padEnd(1899, " ") +
      "\t".repeat(1901),
    expected: [
      "Useful text".padEnd(1900, "\n"),
      " " + "More useful text".padEnd(1899, " "),
    ],
  },
];

test("whitespace-only chunks are omitted while every useful chunk stays exact", () => {
  for (const { name, text, expected } of whitespaceChunkFixtures) {
    const chunks = discordChunks(text);
    assert.deepEqual(chunks, expected, name);
    assert.ok(
      chunks.every((chunk) => chunk.trim().length > 0 && chunk.length <= 1900),
      name,
    );
  }
});

test("queued whitespace-boundary replies satisfy the actual relay delivery contract after restart", (t) => {
  const state = setup(t);
  const now = 1700000000000;
  for (const [
    index,
    { name, text, expected },
  ] of whitespaceChunkFixtures.entries()) {
    state.q.enqueue(
      inputId,
      `whitespace-contract-${index}`,
      text,
      binding,
      now - 1,
    );
    const q = state.reopen();
    for (const [chunkIndex, content] of expected.entries()) {
      const delivery = q.poll(binding, now)!;
      assert.ok(delivery, name);
      assert.equal(delivery.content, content, name);
      assert.equal(delivery.expiresAt, now + 120000);
      // This calls the relay's real validator, not a duplicated queue-only rule.
      assert.deepEqual(
        validateDelivery(delivery, binding, now),
        delivery,
        name,
      );
      q.ack(
        receipt(
          delivery,
          String(BigInt(deliveredId) + BigInt(index * 10 + chunkIndex)),
        ),
        binding,
      );
    }
    assert.equal(q.poll(binding, now), null, name);
  }
});

test("durable outbox replays identical content, nonce and input identity after reopen", (t) => {
  const state = setup(t);
  const text = "Synthetic harbor reply " + "🌊".repeat(1200);
  state.q.enqueue(inputId, "assistant-entry-1", text, binding, 10);
  const q = state.reopen();
  q.enqueue(inputId, "assistant-entry-1", text, binding, 20);
  const expected = discordChunks(text);
  assert.equal(count(state.sql, "outbox"), expected.length);
  for (let i = 0; i < expected.length; i++) {
    const delivery = q.poll(binding, 100 + i)!;
    assert.ok(delivery);
    assert.equal(delivery.id, `d:${inputId}:assistant-entry-1:${i}`);
    assert.equal(delivery.channelId, binding.channelId);
    assert.equal(delivery.replyToMessageId, inputId);
    assert.equal(delivery.content, expected[i]);
    assert.match(delivery.nonce, /^[a-zA-Z0-9_-]{1,25}$/);
    assert.ok(delivery.leaseToken);
    assert.equal(delivery.expiresAt, 120100 + i);
    assert.equal(q.poll(binding, 101 + i), null);
    assert.deepEqual(
      q.ack(
        receipt(delivery, String(BigInt(deliveredId) + BigInt(i))),
        binding,
      ),
      { accepted: true },
    );
  }
  assert.equal(q.poll(binding, 1000), null);
  assert.equal(state.reopen().poll(binding, 1000000), null);
});

test("outbox rejects conflicting duplicate text or binding before adding any chunk", (t) => {
  const { q, sql } = setup(t);
  q.enqueue(inputId, "entry", "original", binding, 1);
  const original = q.poll(binding, 2)!;
  rejects(() => q.enqueue(inputId, "entry", "changed", binding, 3), 409);
  rejects(
    () =>
      q.enqueue(inputId, "entry", "original" + "x".repeat(2000), binding, 3),
    409,
  );
  rejects(() => q.enqueue(inputId, "entry", "original", otherBinding, 3), 409);
  assert.equal(count(sql, "outbox"), 1);
  q.ack(receipt(original), binding);
  q.enqueue(inputId, "entry", "original", binding, 4);
  assert.equal(q.poll(binding, 5), null);
});

for (const failBeforeChunk of [1, 2]) {
  test(`interrupted enqueue before chunk ${failBeforeChunk} reopens without changing its original event`, (t) => {
    const state = setup(t);
    let inserted = 0;
    const interruptedSql: MemorySql = {
      exec(query, ...args) {
        if (
          /INSERT[^;]*INTO red_discord_outbox/i.test(query) &&
          ++inserted === failBeforeChunk
        ) {
          throw new Error("Synthetic SQLite write interruption");
        }
        return state.sql.exec(query, ...args);
      },
    };
    const interrupted = new DiscordQueue(interruptedSql);
    const text = "a".repeat(1900) + "original last chunk";
    assert.throws(
      () => interrupted.enqueue(inputId, "interrupted-entry", text, binding, 1),
      /Synthetic SQLite write interruption/,
    );
    assert.equal(count(state.sql, "outbox"), failBeforeChunk - 1);
    const before = state.sql
      .exec("SELECT nonce FROM red_discord_outbox ORDER BY created,rowid")
      .toArray();
    const q = state.reopen();
    rejects(
      () =>
        q.enqueue(
          inputId,
          "interrupted-entry",
          "a".repeat(1900) + "changed last chunk",
          binding,
          2,
        ),
      409,
    );
    rejects(
      () => q.enqueue(inputId, "interrupted-entry", text, otherBinding, 2),
      409,
    );
    assert.equal(count(state.sql, "outbox"), failBeforeChunk - 1);
    q.enqueue(inputId, "interrupted-entry", text, binding, 3);
    assert.equal(count(state.sql, "outbox"), 2);
    q.enqueue(inputId, "interrupted-entry", text, binding, 4);
    assert.equal(count(state.sql, "outbox"), 2);
    const first = q.poll(binding, 5)!;
    assert.equal(first.content, "a".repeat(1900));
    if (before.length) assert.equal(first.nonce, before[0].nonce);
    q.ack(receipt(first), binding);
    assert.equal(q.poll(binding, 6)?.content, "original last chunk");
  });
}

test("empty outbox replies are no-ops and oversized or unsafe identities are atomic failures", (t) => {
  const { q, sql } = setup(t);
  q.enqueue(inputId, "empty", "", binding, 1);
  assert.equal(count(sql, "outbox"), 0);
  for (const text of ["x".repeat(256001), "🌊".repeat(64001)]) {
    rejects(() => q.enqueue(inputId, "oversized", text, binding, 1), 503);
    assert.equal(count(sql, "outbox"), 0);
  }
  for (const entryId of [
    "unsafe/entry",
    "unsafe entry",
    "entry'--",
    "x".repeat(128),
  ]) {
    rejects(
      () => q.enqueue(inputId, entryId, "Synthetic output", binding, 1),
      503,
    );
    assert.equal(count(sql, "outbox"), 0);
  }
  q.enqueue(inputId, "maximum", "🌊".repeat(64000), binding, 1);
  assert.equal(count(sql, "outbox"), discordChunks("🌊".repeat(64000)).length);
});

test("outbox pending limit preflights whole chunk batches without partial insertion", (t) => {
  const { q, sql } = setup(t);
  seedOutbox(sql, 998, "queued");
  rejects(
    () => q.enqueue(inputId, "too-many", "x".repeat(3801), binding, 1),
    503,
  );
  assert.equal(count(sql, "outbox"), 998);
  q.enqueue(inputId, "fits", "x".repeat(1901), binding, 1);
  assert.equal(count(sql, "outbox"), 1000);
  q.enqueue(inputId, "fits", "x".repeat(1901), binding, 2);
  rejects(() => q.enqueue(inputId, "over", "x", binding, 3), 503);
  assert.equal(count(sql, "outbox"), 1000);
});

test("leased and parked outbox entries still count against pending capacity", (t) => {
  const { q, sql } = setup(t);
  seedOutbox(sql, 999, "review");
  q.enqueue(inputId, "last-slot", "Synthetic output", binding, 1);
  sql.exec(
    "UPDATE red_discord_outbox SET state='leased' WHERE id=?",
    `d:${inputId}:last-slot:0`,
  );
  rejects(() => q.enqueue(inputId, "over", "x", binding, 2), 503);
  assert.equal(count(sql, "outbox"), 1000);
});

test("outbox retained-history limit includes sent messages and preserves idempotent retries", (t) => {
  const { q, sql } = setup(t);
  seedOutbox(sql, 19999);
  q.enqueue(inputId, "last-slot", "Synthetic output", binding, 20000);
  assert.equal(count(sql, "outbox"), 20000);
  rejects(() => q.enqueue(inputId, "over", "x", binding, 20001), 503);
  q.enqueue(inputId, "last-slot", "Synthetic output", binding, 20002);
  const delivery = q.poll(binding, 20003)!;
  q.ack(receipt(delivery), binding);
  rejects(() => q.enqueue(inputId, "still-over", "x", binding, 20004), 503);
  assert.equal(count(sql, "outbox"), 20000);
});

test("poll only exposes the fixed binding and serializes ordered deliveries", (t) => {
  const { q } = setup(t);
  q.enqueue(inputId, "first", "first output", binding, 10);
  q.enqueue(inputId, "second", "second output", binding, 10);
  q.enqueue(inputId, "other", "other channel output", otherBinding, 1);
  const first = q.poll(binding, 100)!;
  assert.equal(first.content, "first output");
  assert.equal(q.poll(binding, 101), null);
  const other = q.poll(otherBinding, 101)!;
  assert.equal(other.content, "other channel output");
  rejects(() => q.ack(receipt(first), otherBinding), 409);
  q.ack(receipt(first), binding);
  assert.equal(q.poll(binding, 102)?.content, "second output");
});

test("leases survive file reopen and expired claims retain nonce while rejecting stale receipts", (t) => {
  const state = setup(t);
  state.q.enqueue(inputId, "entry", "Synthetic output", binding, 1);
  const first = state.q.poll(binding, 1000)!;
  const q = state.reopen();
  assert.equal(q.poll(binding, 1001), null);
  assert.equal(q.poll(binding, first.expiresAt), null);
  const second = q.poll(binding, first.expiresAt + 1)!;
  assert.equal(second.id, first.id);
  assert.equal(second.nonce, first.nonce);
  assert.equal(second.content, first.content);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.expiresAt, first.expiresAt + 120001);
  rejects(() => q.ack(receipt(first), binding), 409);
  rejects(
    () =>
      q.retry(
        { ...receipt(first), kind: "transient" },
        binding,
        first.expiresAt + 2,
      ),
    409,
  );
  assert.deepEqual(q.ack(receipt(second), binding), { accepted: true });
  assert.equal(state.reopen().poll(binding, 1000000), null);
});

test("an expired but unreclaimed lease can acknowledge the completed send exactly once", (t) => {
  const state = setup(t);
  state.q.enqueue(inputId, "entry", "Synthetic output", binding, 1);
  const first = state.q.poll(binding, 0)!;
  const q = state.reopen();
  assert.deepEqual(q.ack(receipt(first), binding), { accepted: true });
  assert.deepEqual(q.ack(receipt(first), binding), { accepted: false });
  assert.deepEqual(state.reopen().ack(receipt(first), binding), {
    accepted: false,
  });
  rejects(() => q.ack(receipt(first, "300000000000000002"), binding), 409);
  rejects(
    () =>
      q.retry(
        { ...receipt(first), kind: "rate_limit" },
        binding,
        first.expiresAt + 1,
      ),
    409,
  );
  assert.equal(q.poll(binding, first.expiresAt + 1000000), null);
});

test("unknown, malformed and wrong-binding receipt identities never acknowledge a delivery", (t) => {
  const { q } = setup(t);
  q.enqueue(inputId, "entry", "Synthetic output", binding, 1);
  const first = q.poll(binding, 2)!;
  for (const value of [
    {},
    { id: first.id },
    { id: 123, leaseToken: first.leaseToken },
    { id: first.id, leaseToken: 123 },
  ]) {
    rejects(() => q.ack(value, binding), 400);
    rejects(() => q.retry({ ...value, kind: "transient" }, binding, 3), 400);
  }
  for (const value of [
    { ...receipt(first), id: "unknown" },
    { ...receipt(first), leaseToken: "stale" },
  ]) {
    rejects(() => q.ack(value, binding), 409);
    rejects(() => q.retry({ ...value, kind: "transient" }, binding, 3), 409);
  }
  for (const messageId of [
    undefined,
    null,
    "",
    "123",
    Number(deliveredId),
    "3".repeat(21),
  ]) {
    rejects(() => q.ack({ ...receipt(first), messageId }, binding), 400);
  }
  rejects(() => q.ack(receipt(first), otherBinding), 409);
  rejects(
    () => q.retry({ ...receipt(first), kind: "transient" }, otherBinding, 3),
    409,
  );
  assert.equal(q.poll(binding, 3), null);
  assert.deepEqual(q.ack(receipt(first), binding), { accepted: true });
});

test("rate-limit retries preserve head-of-line order and survive restart", (t) => {
  const state = setup(t);
  state.q.enqueue(inputId, "first", "first output", binding, 1);
  state.q.enqueue(inputId, "second", "second output", binding, 2);
  const first = state.q.poll(binding, 100)!;
  assert.deepEqual(
    state.q.retry(
      { ...receipt(first), kind: "rate_limit", retryAfterMs: 7000 },
      binding,
      200,
    ),
    { state: "queued" },
  );
  const q = state.reopen();
  assert.equal(q.poll(binding, 7199), null);
  const retried = q.poll(binding, 7200)!;
  assert.equal(retried.id, first.id);
  assert.equal(retried.nonce, first.nonce);
  assert.notEqual(retried.leaseToken, first.leaseToken);
  rejects(() => q.ack(receipt(first), binding), 409);
  q.ack(receipt(retried), binding);
  assert.equal(q.poll(binding, 7201)?.content, "second output");
});

test("transient retry delays use a minimum and a default without losing the durable reply", (t) => {
  const { q } = setup(t);
  q.enqueue(inputId, "entry", "Synthetic output", binding, 1);
  const first = q.poll(binding, 100)!;
  q.retry(
    { ...receipt(first), kind: "transient", retryAfterMs: 0 },
    binding,
    200,
  );
  assert.equal(q.poll(binding, 1199), null);
  const second = q.poll(binding, 1200)!;
  q.retry({ ...receipt(second), kind: "transient" }, binding, 1300);
  assert.equal(q.poll(binding, 31299), null);
  const third = q.poll(binding, 31300)!;
  assert.equal(third.id, first.id);
  assert.equal(third.nonce, first.nonce);
});

test("maximum one-day retry delay is accepted and cannot be bypassed by another poll", (t) => {
  const { q } = setup(t);
  q.enqueue(inputId, "first", "first output", binding, 1);
  q.enqueue(inputId, "second", "second output", binding, 2);
  const first = q.poll(binding, 100)!;
  q.retry(
    { ...receipt(first), kind: "rate_limit", retryAfterMs: 86400000 },
    binding,
    200,
  );
  rejects(
    () =>
      q.retry(
        { ...receipt(first), kind: "transient", retryAfterMs: 0 },
        binding,
        201,
      ),
    409,
  );
  assert.equal(q.poll(binding, 86400199), null);
  assert.equal(q.poll(binding, 86400200)?.id, first.id);
});

test("invalid retry outcomes and delays leave the current lease unchanged", (t) => {
  const { q } = setup(t);
  q.enqueue(inputId, "entry", "Synthetic output", binding, 1);
  const first = q.poll(binding, 100)!;
  for (const kind of [
    undefined,
    null,
    "success",
    "network-error",
    1,
    ["uncertain"],
    ["permanent"],
    ["rate_limit"],
    {},
  ]) {
    rejects(() => q.retry({ ...receipt(first), kind }, binding, 200), 400);
  }
  for (const retryAfterMs of [-1, 1.5, NaN, Infinity, "1000", 86400001]) {
    rejects(
      () =>
        q.retry(
          { ...receipt(first), kind: "rate_limit", retryAfterMs },
          binding,
          200,
        ),
      400,
    );
  }
  assert.equal(q.poll(binding, 201), null);
  assert.deepEqual(q.ack(receipt(first), binding), { accepted: true });
});

for (const kind of ["uncertain", "permanent"]) {
  test(`${kind} sends are durably parked for review and block unsafe later chunks`, (t) => {
    const state = setup(t);
    state.q.enqueue(inputId, "entry", "x".repeat(1901), binding, 1);
    const first = state.q.poll(binding, 100)!;
    assert.deepEqual(state.q.retry({ ...receipt(first), kind }, binding, 200), {
      state: "review",
    });
    const q = state.reopen();
    assert.equal(q.poll(binding, 1000000000), null);
    rejects(
      () => q.retry({ ...receipt(first), kind: "transient" }, binding, 201),
      409,
    );
    assert.equal(count(state.sql, "outbox", "state='review'"), 1);
    assert.equal(count(state.sql, "outbox", "state='queued'"), 1);
    assert.equal(count(state.sql, "outbox"), 2);
    // A matching, concrete Discord receipt can resolve an uncertain send even
    // after a restart; parking itself must never automatically resend it.
    rejects(
      () => q.ack({ ...receipt(first), leaseToken: "wrong-proof" }, binding),
      409,
    );
    assert.deepEqual(q.ack(receipt(first), binding), { accepted: true });
    assert.deepEqual(q.ack(receipt(first), binding), { accepted: false });
    rejects(() => q.ack(receipt(first, "300000000000000002"), binding), 409);
    assert.equal(q.poll(binding, 1000000001)?.content, "x");
  });
}

test("status reports durable lifecycle counts without private content", (t) => {
  const state = setup(t);
  state.q.receive(message(), binding, 1);
  state.q.admitted(inputId, "synthetic-run");
  state.q.enqueue(inputId, "entry", "Synthetic private output", binding, 2);
  state.q.poll(binding, 3);
  const status = state.reopen().status();
  assert.deepEqual(
    status.inbox.map((row) => ({ ...row })),
    [{ state: "admitted", count: 1 }],
  );
  assert.deepEqual(
    status.outbox.map((row) => ({ ...row })),
    [{ state: "leased", count: 1 }],
  );
  assert.doesNotMatch(
    JSON.stringify(status),
    /Synthetic|credential|leaseToken|200000000000000001/,
  );
});
