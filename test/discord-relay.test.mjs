import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  gatewayUrl,
  validateChannel,
  inboundMessage,
  validateDelivery,
  discordPayload,
  retryDelay,
  readBounded,
  RelayError,
} from "../discord/protocol.mjs";
import { openStore } from "../discord/store.mjs";
import {
  Gateway,
  Transport,
  Relay,
  RateLimited,
  main,
} from "../discord/cli.mjs";

// All account IDs, messages and credentials below are synthetic fixtures.
// No test performs a network request or validates a real account/installation.
const NOW = 1802300000000;
const idAt = (time, increment = 1) =>
  String((BigInt(time - 1420070400000) << 22n) + BigInt(increment));
const env = {
  DISCORD_RELAY_ENABLED: "true",
  RED_URL: "https://red.example",
  RED_DISCORD_TOKEN: "fake-red-token-".padEnd(48, "r"),
  DISCORD_BOT_TOKEN: "fake-bot-token-".padEnd(48, "b"),
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_CHANNEL_ID: "234567890123456789",
  DISCORD_OWNER_ID: "345678901234567890",
  DISCORD_BOT_ID: "456789012345678901",
  DISCORD_SESSION: "private_test",
  RED_DISCORD_DIR: "/tmp/not-opened-by-config-test",
};
const config = readConfig(env);
const channel = () => ({
  id: config.channelId,
  guild_id: config.guildId,
  type: 0,
  permission_overwrites: [
    { id: config.guildId, type: 0, allow: "0", deny: "1024" },
    { id: config.ownerId, type: 1, allow: "1024", deny: "0" },
    { id: config.botId, type: 1, allow: "1024", deny: "0" },
  ],
});
const message = (changes = {}) => ({
  id: idAt(NOW + 10),
  guild_id: config.guildId,
  channel_id: config.channelId,
  author: { id: config.ownerId, bot: false },
  type: 0,
  content: "Synthetic lighthouse message",
  ...changes,
});
const delivery = (changes = {}) => ({
  id: `d:${idAt(NOW + 10)}:entry:0`,
  channelId: config.channelId,
  replyToMessageId: idAt(NOW + 10),
  content: "Synthetic harbor reply",
  nonce: "0123456789abcdef01234567",
  leaseToken: "fake-lease-one",
  expiresAt: NOW + 120000,
  ...changes,
});
const response = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "red-discord-test-"));
  chmodSync(dir, 0o700);
  let store = openStore(dir, config, NOW);
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = openStore(dir, config, NOW + 100);
      return store;
    },
  };
}
class FakeSocket {
  static sockets = [];
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.sockets.push(this);
  }
  addEventListener(name, fn) {
    this.listeners.set(name, fn);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  close(code) {
    this.readyState = 3;
    this.closedWith = code;
  }
  event(name, data) {
    this.listeners.get(name)?.(data);
  }
  receive(payload) {
    this.event("message", { data: JSON.stringify(payload) });
  }
}
function fakeClock() {
  let now = NOW,
    next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, time: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.time <= target)
          .sort((a, b) => a[1].time - b[1].time)[0];
        if (!due) break;
        now = due[1].time;
        timers.delete(due[0]);
        due[1].fn();
      }
      now = target;
    },
  };
}
function makeGateway(store, logs = []) {
  const clock = fakeClock();
  const gateway = new Gateway(
    config,
    store,
    {},
    {
      WebSocketImpl: FakeSocket,
      ...clock,
      random: () => 0.5,
      log: (code) => logs.push(code),
    },
  );
  return { gateway, clock };
}
function ready(socket, seq = 1) {
  socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  socket.receive({
    op: 0,
    t: "READY",
    s: seq,
    d: {
      user: { id: config.botId, bot: true },
      session_id: "fake-gateway-session",
      resume_gateway_url: "wss://gateway.discord.gg",
    },
  });
}

test("Discord config is disabled by default and fails closed without distinct fixed binding", async () => {
  assert.deepEqual(readConfig({}), { enabled: false });
  await main({}, "check");
  await main(env, "check");
  await assert.rejects(
    main(env, "unknown"),
    /usage_node_discord_cli_check_or_run/,
  );
  for (const patch of [
    { DISCORD_RELAY_ENABLED: "yes" },
    { DISCORD_BOT_TOKEN: "" },
    { RED_DISCORD_TOKEN: env.DISCORD_BOT_TOKEN },
    { OWNER_TOKEN: env.RED_DISCORD_TOKEN },
    { DISCORD_OWNER_ID: config.botId },
    { DISCORD_SESSION: "bad.name" },
    { RED_URL: "https://red.example/path" },
    { RED_URL: "https://user:pass@red.example" },
    { RED_URL: "http://localhost:8787" },
    { RED_URL: "https://red.example?query" },
    { RED_DISCORD_DIR: "relative" },
  ]) {
    assert.throws(() => readConfig({ ...env, ...patch }));
  }
  assert.equal(
    readConfig({
      ...env,
      RED_URL: "http://localhost:8787",
      RED_DISCORD_ALLOW_HTTP_LOOPBACK: "true",
    }).redUrl,
    "http://localhost:8787",
  );
  assert.throws(() =>
    readConfig({
      ...env,
      RED_URL: "http://evil.example",
      RED_DISCORD_ALLOW_HTTP_LOOPBACK: "true",
    }),
  );
  assert.equal(
    gatewayUrl("wss://us-east1.gateway.discord.gg"),
    "wss://us-east1.gateway.discord.gg/?v=10&encoding=json",
  );
  for (const url of [
    "wss://evil.example",
    "wss://gateway.discord.gg.evil.example",
    "ws://gateway.discord.gg",
    "wss://gateway.discord.gg/private",
  ])
    assert.throws(() => gatewayUrl(url));
});

test("private channel validation rejects threads, other guilds and permission drift", () => {
  assert.equal(validateChannel(channel(), config).id, config.channelId);
  for (const patch of [
    { type: 11 },
    { guild_id: "567890123456789012" },
    { permission_overwrites: [] },
    {
      permission_overwrites: [
        ...channel().permission_overwrites,
        { id: "567890123456789012", type: 0, allow: "1024", deny: "0" },
      ],
    },
  ]) {
    assert.throws(() => validateChannel({ ...channel(), ...patch }, config));
  }
});

test("ingress admits only new fixed-owner text, omits privileges and attachment URLs", () => {
  const raw = message({
    attachments: [
      {
        id: "567890123456789012",
        filename: "sample.txt",
        size: 9,
        url: "https://private.invalid/file",
        content_type: "text/plain",
      },
    ],
    roles: ["admin"],
    approvals: ["approve"],
  });
  const accepted = inboundMessage(raw, config, NOW);
  assert.equal(accepted.content, raw.content);
  assert.equal(accepted.attachments[0].url, undefined);
  assert.equal(accepted.roles, undefined);
  assert.ok(inboundMessage(message({ type: 19 }), config, NOW));
  for (const patch of [
    { guild_id: undefined },
    { channel_id: "567890123456789012" },
    { author: { id: config.botId, bot: true } },
    { author: { id: config.ownerId, bot: true } },
    { author: { id: config.ownerId, bot: "false" } },
    { webhook_id: "567890123456789012" },
    { type: 7 },
    { id: idAt(NOW - 1) },
    { content: "x".repeat(4001) },
    { content: "" },
    { attachments: new Array(11).fill({}) },
  ]) {
    assert.equal(inboundMessage(message(patch), config, NOW), null);
  }
});

test("SQLite journal, fixed storage binding and exclusive process lock survive reopen", (t) => {
  const f = fixture(t);
  f.store.inboxAdd(message(), NOW);
  f.store.set("gateway_session", {
    id: "fixture",
    seq: 2,
    url: "wss://gateway.discord.gg",
  });
  assert.throws(() => openStore(f.dir, config, NOW), /relay_already_running/);
  const d = delivery();
  f.store.accept(d, NOW);
  f.store.state(d.id, "sending");
  f.reopen();
  assert.equal(f.store.watermark, NOW);
  assert.equal(f.store.inboxNext(NOW).message.id, message().id);
  assert.equal(f.store.delivery(d.id).state, "uncertain");
  assert.equal(f.store.get("gateway_session").seq, 2);
  assert.equal(f.store.inboxAdd(message(), NOW), false);
  assert.throws(
    () => f.store.accept({ ...d, content: "changed" }, NOW),
    /delivery_changed/,
  );
  assert.throws(
    () => f.store.accept({ ...d, id: "different" }, NOW),
    /nonce_reused/,
  );
  f.store.transaction(() => {
    f.store.inboxDone(message().id);
    f.store.set("transaction_fixture", true);
  });
  f.reopen();
  assert.equal(f.store.inboxNext(NOW), null);
  assert.equal(f.store.get("transaction_fixture"), true);
});

test("SQLite transaction rolls back ingress with sequence and rejects unsafe local directory", (t) => {
  const f = fixture(t);
  assert.throws(() =>
    f.store.transaction(() => {
      f.store.inboxAdd(message(), NOW);
      f.store.set("gateway_session", { seq: 99 });
      throw new Error("synthetic crash");
    }),
  );
  f.reopen();
  assert.equal(f.store.inboxNext(NOW), null);
  assert.equal(f.store.get("gateway_session"), null);
  const target = join(f.dir, "unsafe");
  symlinkSync(f.dir, target);
  assert.throws(
    () => openStore(target, config, NOW),
    /unsafe_storage_directory/,
  );
});

test("response and delivery bounds reject hostile destinations and disable mentions", async () => {
  assert.equal(validateDelivery(delivery(), config, NOW).id, delivery().id);
  for (const patch of [
    { channelId: "567890123456789012" },
    { content: "x".repeat(2001) },
    { nonce: "x".repeat(26) },
    { expiresAt: NOW + 100 },
    { replyToMessageId: "bad" },
    { leaseToken: "\n" },
    { id: "../escape" },
  ])
    assert.throws(() => validateDelivery(delivery(patch), config, NOW));
  const payload = discordPayload(delivery());
  assert.deepEqual(payload.allowed_mentions, {
    parse: [],
    replied_user: false,
  });
  assert.equal(payload.enforce_nonce, true);
  assert.equal(payload.message_reference.fail_if_not_exists, true);
  await assert.rejects(
    readBounded(response({ data: "x".repeat(100) }), 50),
    /response_too_large/,
  );
  assert.equal(
    retryDelay(
      response({}, 429, { "Retry-After": "3" }),
      { retry_after: 5 },
      NOW,
    ),
    5100,
  );
});

test("Discord REST obeys persisted global and route rate limits without network retries", async (t) => {
  const f = fixture(t);
  let calls = 0,
    now = NOW;
  let transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return response({ retry_after: 2, global: true }, 429);
    },
  });
  await assert.rejects(
    transport.discord("POST", `/channels/${config.channelId}/messages`, {}),
    RateLimited,
  );
  f.reopen();
  transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async () => {
      calls++;
      return response({});
    },
  });
  await assert.rejects(transport.discord("GET", "/users/@me"), RateLimited);
  assert.equal(calls, 1);
  now += 2200;
  await transport.discord("GET", "/users/@me");
  assert.equal(calls, 2);
  transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async () =>
      response({}, 200, {
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "4",
      }),
  });
  await transport.discord("GET", "/users/@me");
  await assert.rejects(transport.discord("GET", "/users/@me"), RateLimited);
  await transport.discord("GET", `/channels/${config.channelId}`);
});

test("inbox survives failed ingress and relays with fixed X-Session only", async (t) => {
  const f = fixture(t);
  f.store.inboxAdd(message(), NOW);
  let fail = true,
    now = NOW,
    seen;
  const transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async (url, options) => {
      seen = { url, options };
      if (fail) throw new Error("synthetic private transport error");
      return response({
        accepted: true,
        duplicate: true,
        id: message().id,
        state: "queued",
      });
    },
  });
  const relay = new Relay(
    config,
    f.store,
    transport,
    { ready: false },
    { now: () => now, log: () => {} },
  );
  await relay.ingestOne();
  assert.ok(f.store.inboxNext(NOW + 100000));
  fail = false;
  now += 100000;
  await relay.ingestOne();
  assert.equal(f.store.inboxNext(now), null);
  assert.equal(seen.url, "https://red.example/api/discord/message");
  assert.equal(seen.options.headers["X-Session"], config.session);
  assert.equal(seen.options.headers.Authorization, `Bearer ${config.redToken}`);
  assert.equal(seen.options.redirect, "error");
});

test("send commits intent before POST, receipt before ack, and never resends after reopen", async (t) => {
  const f = fixture(t);
  const d = delivery();
  const sentId = idAt(NOW + 20);
  let posts = 0,
    ack = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith(`/channels/${config.channelId}`))
      return response(channel());
    if (url.endsWith("/messages")) {
      posts++;
      assert.equal(f.store.delivery(d.id).state, "sending");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.allowed_mentions.parse, []);
      return response({
        id: sentId,
        channel_id: config.channelId,
        author: { id: config.botId, bot: true },
        content: d.content,
        nonce: d.nonce,
      });
    }
    if (url.endsWith("/ack")) {
      ack++;
      assert.equal(f.store.delivery(d.id).message_id, sentId);
      return response({ accepted: false });
    }
    throw new Error("unexpected URL");
  };
  let transport = new Transport(config, f.store, { fetchImpl, now: () => NOW });
  let relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await relay.sendDelivery(d);
  assert.equal(f.store.delivery(d.id).state, "sent");
  f.reopen();
  transport = new Transport(config, f.store, { fetchImpl, now: () => NOW });
  relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await relay.sendDelivery({ ...d, leaseToken: "renewed-lease" });
  await relay.receiptOne();
  assert.equal(posts, 1);
  assert.equal(ack, 1);
  assert.equal(f.store.delivery(d.id).state, "done");
});

test("network and 5xx outcomes park uncertain; only matching own-bot nonce proves receipt", async (t) => {
  const f = fixture(t);
  const d = delivery();
  let posts = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith(`/channels/${config.channelId}`))
      return response(channel());
    if (url.endsWith("/messages")) {
      posts++;
      return response({ private: "not logged" }, 502);
    }
    return response({ accepted: true });
  };
  let transport = new Transport(config, f.store, { fetchImpl, now: () => NOW });
  let relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await relay.sendDelivery(d);
  assert.equal(f.store.delivery(d.id).state, "uncertain");
  f.reopen();
  transport = new Transport(config, f.store, { fetchImpl, now: () => NOW });
  relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await relay.sendDelivery({ ...d, leaseToken: "new" });
  assert.equal(posts, 1);
  const own = message({
    id: idAt(NOW + 20),
    author: { id: config.botId, bot: true },
    content: d.content,
    nonce: d.nonce,
    type: 19,
    message_reference: { message_id: d.replyToMessageId },
  });
  assert.equal(f.store.reconcile({ ...own, content: "wrong" }, config), false);
  assert.equal(f.store.reconcile({ ...own, nonce: "wrong" }, config), false);
  assert.equal(f.store.reconcile(own, config), true);
  assert.equal(inboundMessage(own, config, NOW), null);
  await relay.receiptOne();
  assert.equal(f.store.delivery(d.id).state, "done");
});

test("429 is known unsent and privacy drift prevents even the first message POST", async (t) => {
  const f = fixture(t);
  const d = delivery();
  let posts = 0,
    now = NOW,
    retryBody;
  let transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async (url, options) => {
      if (url.endsWith(`/channels/${config.channelId}`))
        return response(channel());
      if (url.endsWith("/messages")) {
        posts++;
        return response({ retry_after: 10 }, 429);
      }
      if (url.endsWith("/retry")) {
        retryBody = JSON.parse(options.body);
        return response({ accepted: true });
      }
      throw new Error("unexpected URL");
    },
  });
  let relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => now, log: () => {} },
  );
  await relay.sendDelivery(d);
  assert.equal(f.store.delivery(d.id).state, "ready");
  assert.equal(retryBody.kind, "rate_limit");
  assert.equal(retryBody.retryAfterMs, 10100);
  await relay.sendDelivery(d);
  assert.equal(posts, 1);
  now += 11000;
  transport = new Transport(config, f.store, {
    now: () => now,
    fetchImpl: async () =>
      response({ ...channel(), permission_overwrites: [] }),
  });
  relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => now, log: () => {} },
  );
  await assert.rejects(relay.sendDelivery(d), /private_channel_required/);
  assert.equal(posts, 1);
});

test("Gateway heartbeat jitter, ACK, server request, sequence journal and resume are durable", async (t) => {
  const f = fixture(t);
  let { gateway, clock } = makeGateway(f.store);
  let task = gateway.connect("wss://gateway.discord.gg/?v=10&encoding=json");
  let socket = FakeSocket.sockets.at(-1);
  ready(socket);
  assert.equal(socket.sent[0].op, 2);
  assert.equal(socket.sent[0].d.intents, 33281);
  clock.advance(499);
  assert.equal(socket.sent.length, 1);
  clock.advance(1);
  assert.deepEqual(socket.sent.at(-1), { op: 1, d: 1 });
  socket.receive({ op: 11 });
  socket.receive({ op: 1 });
  assert.equal(socket.sent.at(-1).op, 1);
  socket.receive({ op: 11 });
  socket.receive({
    op: 0,
    t: "MESSAGE_UPDATE",
    s: 2,
    d: message({ content: "ignored edit" }),
  });
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 3, d: message() });
  assert.equal(f.store.inboxNext(NOW + 100).message.content, message().content);
  assert.equal(f.store.get("gateway_session").seq, 3);
  socket.receive({ op: 7 });
  await task;
  f.reopen();
  ({ gateway, clock } = makeGateway(f.store));
  task = gateway.connect(
    "wss://gateway.discord.gg/?v=10&encoding=json",
    f.store.get("gateway_session"),
  );
  socket = FakeSocket.sockets.at(-1);
  socket.receive({ op: 10, d: { heartbeat_interval: 1000 } });
  assert.equal(socket.sent[0].op, 6);
  assert.equal(socket.sent[0].d.seq, 3);
  socket.receive({ op: 0, t: "MESSAGE_CREATE", s: 4, d: message() });
  socket.receive({ op: 0, t: "RESUMED", s: 5, d: {} });
  assert.equal(gateway.ready, true);
  clock.advance(500);
  clock.advance(1000);
  const result = await task;
  assert.equal(result.established, true);
  assert.equal(socket.closedWith, 4000);
});

test("Gateway handles fatal intent/auth close, invalid sessions, and permission drift", async (t) => {
  const f = fixture(t);
  const logs = [];
  let { gateway } = makeGateway(f.store, logs);
  let task = gateway.connect("wss://gateway.discord.gg");
  let socket = FakeSocket.sockets.at(-1);
  socket.event("error", {});
  socket.event("close", { code: 4014 });
  assert.equal((await task).fatal.code, "gateway_fatal_4014");
  ({ gateway } = makeGateway(f.store, logs));
  task = gateway.connect("wss://gateway.discord.gg");
  socket = FakeSocket.sockets.at(-1);
  ready(socket);
  socket.receive({ op: 9, d: false });
  await task;
  assert.equal(f.store.get("gateway_session"), null);
  assert.ok(logs.includes("gateway_resume_unavailable_gap_possible"));
  ({ gateway } = makeGateway(f.store));
  task = gateway.connect("wss://gateway.discord.gg");
  socket = FakeSocket.sockets.at(-1);
  ready(socket);
  socket.receive({
    op: 0,
    t: "CHANNEL_UPDATE",
    s: 2,
    d: { ...channel(), permission_overwrites: [] },
  });
  assert.equal((await task).fatal.code, "private_channel_required");
  assert.equal(gateway.ready, false);
  assert.equal(f.store.get("gateway_session").seq, 1);
});

test("uncertain retry receipt parks once and saved Gateway proof can acknowledge it later", async (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.accept(d, NOW);
  f.store.state(d.id, "uncertain");
  const calls = [];
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response(
        url.endsWith("/retry") ? { state: "review" } : { accepted: true },
      );
    },
  });
  const relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await relay.receiptOne();
  await relay.receiptOne();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.kind, "uncertain");
  assert.equal(f.store.delivery(d.id).notified, 1);
  f.store.reconcile(
    message({
      id: idAt(NOW + 30),
      author: { id: config.botId, bot: true },
      content: d.content,
      nonce: d.nonce,
      message_reference: { message_id: d.replyToMessageId },
    }),
    config,
  );
  await relay.receiptOne();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.endsWith("/ack"));
  assert.equal(f.store.delivery(d.id).state, "done");
});

test("network failure after durable send intent is uncertain and logs no raw exception", async (t) => {
  const f = fixture(t),
    d = delivery(),
    logs = [];
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async (url) => {
      if (url.endsWith(`/channels/${config.channelId}`))
        return response(channel());
      throw new Error(`synthetic socket error ${config.botToken} ${d.content}`);
    },
  });
  const relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: (code) => logs.push(code) },
  );
  await relay.sendDelivery(d);
  assert.equal(f.store.delivery(d.id).state, "uncertain");
  assert.deepEqual(logs, ["delivery_uncertain_owner_review"]);
});

test("poll validates destination before journaling or any Discord call", async (t) => {
  const f = fixture(t),
    calls = [];
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async (url) => {
      calls.push(url);
      return response({
        delivery: delivery({ channelId: "567890123456789012" }),
      });
    },
  });
  const relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  await assert.rejects(relay.tick(), /invalid_delivery/);
  assert.deepEqual(calls, ["https://red.example/api/discord/poll"]);
  assert.equal(f.store.delivery(delivery().id), null);
});

test("startup verifies bot identity before channel access and never uses relay token for Discord", async (t) => {
  const f = fixture(t),
    calls = [];
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, `Bot ${config.botToken}`);
      return response({ id: config.ownerId, bot: false });
    },
  });
  await assert.rejects(transport.bootstrap(), /discord_bot_binding_mismatch/);
  assert.deepEqual(calls, ["https://discord.com/api/v10/users/@me"]);
});

test("Gateway discovers limits before identifying and stop cancels an exhausted-limit wait", async (t) => {
  const f = fixture(t),
    calls = [],
    logs = [];
  let waiting;
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async (url) => {
      calls.push(url);
      return response({
        url: "wss://gateway.discord.gg",
        shards: 1,
        session_start_limit: { remaining: 0, reset_after: 3600000 },
      });
    },
  });
  const gateway = new Gateway(config, f.store, transport, {
    WebSocketImpl: FakeSocket,
    now: () => NOW,
    log: (code) => logs.push(code),
    sleepImpl: (_delay, _value, { signal }) =>
      new Promise((resolve) => {
        waiting = true;
        signal.addEventListener("abort", resolve, { once: true });
      }),
  });
  const before = FakeSocket.sockets.length,
    task = gateway.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting, true);
  gateway.stop();
  await task;
  assert.deepEqual(calls, ["https://discord.com/api/v10/gateway/bot"]);
  assert.equal(FakeSocket.sockets.length, before);
  assert.deepEqual(logs, ["gateway_identify_limit_wait"]);
});

test("closed-session restart records a gap and never asks Discord for message history", async (t) => {
  const f = fixture(t),
    logs = [];
  const { gateway } = makeGateway(f.store, logs);
  const task = gateway.connect("wss://gateway.discord.gg");
  const socket = FakeSocket.sockets.at(-1);
  ready(socket);
  socket.event("close", { code: 4009 });
  await task;
  assert.equal(f.store.get("gateway_session"), null);
  assert.equal(f.store.get("gateway_gap_at"), NOW);
  assert.deepEqual(logs, ["gateway_resume_unavailable_gap_possible"]);
  assert.deepEqual(
    socket.sent.map((item) => item.op),
    [2],
  );
});

test("one-day rate delay stays within the server protocol boundary", () => {
  assert.equal(
    retryDelay(
      response({}, 429, { "Retry-After": "86400" }),
      { retry_after: 86400 },
      NOW,
    ),
    86400000,
  );
  assert.throws(
    () => retryDelay(response({}, 429), { retry_after: 86401 }, NOW),
    /invalid_rate_limit/,
  );
});

for (const status of [200, 409]) {
  test(`Gateway proof during retry HTTP ${status} stays pending for ack after SQLite reopen`, async (t) => {
    const f = fixture(t),
      d = delivery(),
      sentId = idAt(NOW + 40);
    f.store.accept(d, NOW);
    f.store.state(d.id, "uncertain");
    let release,
      started,
      acks = 0;
    const pending = new Promise((resolve) => {
      started = resolve;
    });
    const fetchImpl = async (url, options) => {
      if (url.endsWith("/retry")) {
        started();
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      assert.ok(url.endsWith("/ack"));
      assert.equal(JSON.parse(options.body).messageId, sentId);
      acks++;
      return response({ accepted: true });
    };
    const makeRelay = () =>
      new Relay(
        config,
        f.store,
        new Transport(config, f.store, { fetchImpl, now: () => NOW }),
        { ready: true },
        { now: () => NOW, log: () => {} },
      );
    let relay = makeRelay();
    const notifying = relay.receiptOne();
    await pending;
    assert.equal(
      f.store.reconcile(
        message({
          id: sentId,
          author: { id: config.botId, bot: true },
          content: d.content,
          nonce: d.nonce,
          message_reference: { message_id: d.replyToMessageId },
        }),
        config,
      ),
      true,
    );
    release(
      response(
        status === 200
          ? { state: "review" }
          : { error: "synthetic stale lease" },
        status,
      ),
    );
    await notifying;
    assert.equal(f.store.delivery(d.id).state, "sent");
    assert.equal(f.store.delivery(d.id).notified, 0);
    assert.equal(f.store.nextReceipt(NOW).message_id, sentId);
    f.reopen();
    relay = makeRelay();
    await relay.receiptOne();
    assert.equal(acks, 1);
    assert.equal(f.store.delivery(d.id).state, "done");
  });
}

test("stale retry response cannot mark a replaced delivery lease notified", async (t) => {
  const f = fixture(t),
    d = delivery();
  f.store.accept(d, NOW);
  f.store.state(d.id, "uncertain");
  let release, started;
  const pending = new Promise((resolve) => {
    started = resolve;
  });
  const transport = new Transport(config, f.store, {
    now: () => NOW,
    fetchImpl: async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const relay = new Relay(
    config,
    f.store,
    transport,
    { ready: true },
    { now: () => NOW, log: () => {} },
  );
  const notifying = relay.receiptOne();
  await pending;
  f.store.accept({ ...d, leaseToken: "synthetic-renewed-lease" }, NOW);
  release(response({ state: "review" }));
  await notifying;
  assert.equal(f.store.delivery(d.id).notified, 0);
  assert.equal(
    f.store.nextReceipt(NOW).delivery.leaseToken,
    "synthetic-renewed-lease",
  );
});

test("delayed inbox head blocks later messages across SQLite reopen until ingress succeeds", async (t) => {
  const f = fixture(t),
    first = message(),
    second = message({
      id: idAt(NOW + 11),
      content: "Synthetic second message",
    });
  f.store.inboxAdd(first, NOW);
  f.store.inboxAdd(second, NOW - 1); // Even a wall-clock adjustment must not reorder dispatches.
  let now = NOW,
    fail = true;
  const ingested = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.endsWith("/message"));
    const body = JSON.parse(options.body);
    ingested.push(body.id);
    if (fail) return response({ retry_after: 5 }, 429);
    return response({
      accepted: true,
      duplicate: false,
      id: body.id,
      state: "queued",
    });
  };
  const makeRelay = () =>
    new Relay(
      config,
      f.store,
      new Transport(config, f.store, { fetchImpl, now: () => now }),
      { ready: false },
      { now: () => now, log: () => {} },
    );
  let relay = makeRelay();
  await relay.ingestOne();
  await relay.ingestOne();
  assert.deepEqual(ingested, [first.id]);
  assert.equal(f.store.inboxNext(NOW), null);
  f.reopen();
  relay = makeRelay();
  await relay.ingestOne();
  assert.deepEqual(ingested, [first.id]);
  fail = false;
  now += 5200;
  await relay.ingestOne();
  await relay.ingestOne();
  assert.deepEqual(ingested, [first.id, first.id, second.id]);
  assert.equal(f.store.inboxNext(now), null);
});
