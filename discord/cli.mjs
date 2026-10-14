#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DISCORD_API,
  INTENTS,
  MAX_RESPONSE_BYTES,
  RelayError,
  backoff,
  readConfig,
  readBounded,
  retryDelay,
  gatewayUrl,
  snowflake,
  validateChannel,
  inboundMessage,
  validateDelivery,
  discordPayload,
} from "./protocol.mjs";
import { openStore } from "./store.mjs";

// Only fixed event codes are logged: never message text, HTTP bodies, tokens,
// session IDs, request objects, WebSocket payloads, or exception stack traces.
const safeLog = (code) =>
  process.stderr.write(`${JSON.stringify({ event: code })}\n`);
export class RateLimited extends RelayError {
  constructor(delay) {
    super("rate_limited");
    this.delay = delay;
  }
}
export class Transport {
  constructor(
    config,
    store,
    { fetchImpl = globalThis.fetch, now = Date.now } = {},
  ) {
    this.config = config;
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
  }
  async red(path, body) {
    if (this.config.enabled !== true)
      throw new RelayError("discord_relay_disabled", true);
    if (!["message", "poll", "ack", "retry"].includes(path))
      throw new RelayError("unsupported_red_route", true);
    let response;
    try {
      response = await this.fetch(`${this.config.redUrl}/api/discord/${path}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${this.config.redToken}`,
          "X-Session": this.config.session,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new RelayError("red_network_error");
    }
    if (response.status === 401 || response.status === 403)
      throw new RelayError("red_auth_failed", true);
    let value;
    try {
      value = await readBounded(response, 65536);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (response.status === 429)
      throw new RateLimited(retryDelay(response, value, this.now()));
    if (!response.ok) {
      const error = new RelayError(`red_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return value;
  }
  async discord(method, path, body) {
    if (this.config.enabled !== true)
      throw new RelayError("discord_relay_disabled", true);
    const route = `${method}:${path}`;
    if (
      ![
        "GET:/users/@me",
        "GET:/gateway/bot",
        `GET:/channels/${this.config.channelId}`,
        `POST:/channels/${this.config.channelId}/messages`,
      ].includes(route)
    )
      throw new RelayError("unsupported_discord_route", true);
    const waitUntil = Math.max(
      this.store.get("discord_global_until") ?? 0,
      this.store.get(`limit:${route}`) ?? 0,
    );
    if (waitUntil > this.now()) throw new RateLimited(waitUntil - this.now());
    let response;
    try {
      response = await this.fetch(`${DISCORD_API}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bot ${this.config.botToken}`,
          "Content-Type": "application/json",
          "User-Agent": "RedDiscordRelay/0.1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new RelayError("discord_network_error");
    }
    let value;
    try {
      value = await readBounded(response);
    } catch (error) {
      if (response.ok) throw error;
    }
    if (response.status === 429) {
      const delay = retryDelay(response, value, this.now());
      const global =
        value?.global === true ||
        response.headers.get("x-ratelimit-global") === "true" ||
        response.headers.get("x-ratelimit-scope") === "global";
      this.store.set(
        global ? "discord_global_until" : `limit:${route}`,
        this.now() + delay,
      );
      throw new RateLimited(delay);
    }
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      this.store.set(
        `limit:${route}`,
        this.now() + retryDelay(response, value, this.now()),
      );
    }
    return { status: response.status, ok: response.ok, value };
  }
  async checkChannel() {
    const response = await this.discord(
      "GET",
      `/channels/${this.config.channelId}`,
    );
    if ([401, 403, 404].includes(response.status))
      throw new RelayError("discord_channel_inaccessible", true);
    if (!response.ok) throw new RelayError("discord_channel_check_failed");
    return validateChannel(response.value, this.config);
  }
  async bootstrap() {
    const response = await this.discord("GET", "/users/@me");
    if ([401, 403].includes(response.status))
      throw new RelayError("discord_auth_failed", true);
    if (!response.ok) throw new RelayError("discord_identity_check_failed");
    if (
      response.value?.id !== this.config.botId ||
      response.value?.bot !== true
    )
      throw new RelayError("discord_bot_binding_mismatch", true);
    await this.checkChannel();
  }
}

export class Gateway {
  constructor(
    config,
    store,
    transport,
    {
      WebSocketImpl = globalThis.WebSocket,
      now = Date.now,
      random = Math.random,
      setTimer = setTimeout,
      clearTimer = clearTimeout,
      sleepImpl = sleep,
      log = safeLog,
    } = {},
  ) {
    Object.assign(this, {
      config,
      store,
      transport,
      WebSocketImpl,
      now,
      random,
      setTimer,
      clearTimer,
      sleep: sleepImpl,
      log,
    });
    this.running = false;
    this.ready = false;
    this.socket = null;
    this.timers = new Set();
  }
  timer(fn, delay) {
    const handle = this.setTimer(() => {
      this.timers.delete(handle);
      fn();
    }, delay);
    this.timers.add(handle);
    return handle;
  }
  clearTimers() {
    for (const handle of this.timers) this.clearTimer(handle);
    this.timers.clear();
  }
  invalidateSession() {
    if (this.store.get("gateway_session")) {
      this.store.set("gateway_gap_at", this.now());
      this.log("gateway_resume_unavailable_gap_possible");
    }
    this.store.set("gateway_session", null);
  }
  stop() {
    this.running = false;
    this.ready = false;
    this.clearTimers();
    this.abort?.abort();
    // A non-normal close preserves Discord's short resumability window.
    this.finishConnection?.();
    try {
      this.socket?.close(4000, "relay stopping");
    } catch {}
  }
  async pause(delay) {
    try {
      await this.sleep(delay, undefined, { signal: this.abort?.signal });
    } catch (error) {
      if (!this.abort?.signal.aborted) throw error;
    }
  }
  async run() {
    this.abort = new AbortController();
    this.running = true;
    let attempts = 0;
    while (this.running) {
      try {
        let session = this.store.get("gateway_session");
        let url;
        if (session) url = gatewayUrl(session.url);
        else {
          const lastIdentify = this.store.get("last_identify_at") ?? 0;
          if (lastIdentify + 5500 > this.now())
            await this.pause(lastIdentify + 5500 - this.now());
          if (!this.running) break;
          const response = await this.transport.discord("GET", "/gateway/bot");
          if ([401, 403].includes(response.status))
            throw new RelayError("discord_auth_failed", true);
          if (!response.ok) throw new RelayError("gateway_discovery_failed");
          const limit = response.value?.session_start_limit;
          if (
            !limit ||
            !Number.isInteger(limit.remaining) ||
            limit.remaining < 0 ||
            !Number.isSafeInteger(limit.reset_after) ||
            limit.reset_after < 0 ||
            limit.reset_after > 86400000
          )
            throw new RelayError("invalid_gateway_limits", true);
          if (limit.remaining < 1) {
            this.log("gateway_identify_limit_wait");
            await this.pause(Math.max(5500, limit.reset_after));
            continue;
          }
          if (response.value.shards !== 1)
            throw new RelayError("single_shard_bot_required", true);
          url = gatewayUrl(response.value.url);
          await this.transport.checkChannel();
        }
        if (!this.running) break;
        const result = await this.connect(url, session);
        if (!this.running) break;
        if (result.fatal) throw result.fatal;
        if (result.established) attempts = 0;
        await this.pause(
          Math.max(result.delay ?? 0, backoff(attempts++, this.random)),
        );
      } catch (error) {
        if (error.fatal) {
          this.stop();
          throw error;
        }
        this.log(
          error instanceof RateLimited
            ? "gateway_rate_limited"
            : "gateway_reconnecting",
        );
        await this.pause(
          error instanceof RateLimited
            ? error.delay
            : backoff(attempts++, this.random),
        );
      }
    }
  }
  connect(url, priorSession = null) {
    this.ready = false;
    return new Promise((resolve) => {
      let socket,
        finished = false,
        hello = false,
        awaitingAck = false,
        established = false;
      let sequence = priorSession?.seq ?? null;
      let session = priorSession;
      const finish = (result = {}) => {
        if (finished) return;
        finished = true;
        this.ready = false;
        this.clearTimers();
        this.finishConnection = null;
        try {
          socket?.close(4000, "relay reconnect");
        } catch {}
        resolve({ established, ...result });
      };
      this.finishConnection = finish;
      const send = (op, d) => {
        if (finished || socket.readyState !== 1) return;
        try {
          socket.send(JSON.stringify({ op, d }));
        } catch {
          finish();
        }
      };
      const beat = (requested = false) => {
        if (!requested && awaitingAck) return finish();
        awaitingAck = true;
        send(1, sequence);
      };
      try {
        socket = new this.WebSocketImpl(url);
        this.socket = socket;
      } catch {
        finish();
        return;
      }
      this.timer(() => finish(), 30000); // Includes TCP/TLS and Hello deadline.
      socket.addEventListener("message", (event) => {
        if (finished) return;
        try {
          if (
            typeof event.data !== "string" ||
            Buffer.byteLength(event.data) > MAX_RESPONSE_BYTES
          )
            throw new RelayError("gateway_payload_rejected", true);
          const payload = JSON.parse(event.data);
          if (!Number.isInteger(payload.op))
            throw new RelayError("invalid_gateway_payload", true);
          if (payload.op === 10) {
            if (
              hello ||
              !Number.isInteger(payload.d?.heartbeat_interval) ||
              payload.d.heartbeat_interval < 1000 ||
              payload.d.heartbeat_interval > 120000
            )
              throw new RelayError("invalid_gateway_hello", true);
            hello = true;
            this.clearTimers();
            const interval = payload.d.heartbeat_interval;
            const heartbeat = () => {
              if (finished) return;
              beat();
              if (!finished) this.timer(heartbeat, interval);
            };
            this.timer(heartbeat, Math.floor(interval * this.random()));
            this.timer(() => {
              if (!established) finish();
            }, 60000);
            if (session)
              send(6, {
                token: this.config.botToken,
                session_id: session.id,
                seq: session.seq,
              });
            else {
              this.store.set("last_identify_at", this.now());
              send(2, {
                token: this.config.botToken,
                intents: INTENTS,
                properties: {
                  os: process.platform,
                  browser: "red-discord-relay",
                  device: "red-discord-relay",
                },
                compress: false,
              });
            }
          } else if (payload.op === 11) awaitingAck = false;
          else if (payload.op === 1) beat(true);
          else if (payload.op === 7) finish();
          else if (payload.op === 9) {
            if (payload.d !== true) this.invalidateSession();
            finish({ delay: 1000 + Math.floor(this.random() * 4000) });
          } else if (payload.op === 0) {
            if (!hello || !Number.isSafeInteger(payload.s) || payload.s < 0)
              throw new RelayError("invalid_gateway_sequence", true);
            if (sequence !== null && payload.s <= sequence) return;
            this.store.transaction(() => {
              if (payload.t === "READY") {
                const data = payload.d;
                if (
                  data?.user?.id !== this.config.botId ||
                  data.user.bot !== true ||
                  typeof data.session_id !== "string" ||
                  !data.session_id ||
                  data.session_id.length > 256
                )
                  throw new RelayError("invalid_gateway_ready", true);
                session = {
                  id: data.session_id,
                  url: gatewayUrl(data.resume_gateway_url),
                  seq: payload.s,
                };
                established = true;
                this.ready = true;
              } else if (payload.t === "RESUMED") {
                if (!session)
                  throw new RelayError("unexpected_gateway_resume", true);
                established = true;
                this.ready = true;
              } else if (payload.t === "MESSAGE_CREATE") {
                // Commit message/receipt BEFORE the resumable sequence advances.
                if (snowflake(payload.d?.id))
                  this.store.reconcile(payload.d, this.config);
                const message = inboundMessage(
                  payload.d,
                  this.config,
                  this.store.watermark,
                );
                if (message) this.store.inboxAdd(message, this.now());
              } else if (
                payload.t === "CHANNEL_UPDATE" &&
                payload.d?.id === this.config.channelId
              ) {
                validateChannel(payload.d, this.config);
              } else if (
                (payload.t === "CHANNEL_DELETE" &&
                  payload.d?.id === this.config.channelId) ||
                (payload.t === "GUILD_DELETE" &&
                  payload.d?.id === this.config.guildId)
              ) {
                throw new RelayError("configured_channel_unavailable", true);
              }
              sequence = payload.s;
              if (session) {
                session = { ...session, seq: sequence };
                this.store.set("gateway_session", session);
              }
            });
          }
        } catch (error) {
          finish({
            fatal:
              error instanceof RelayError
                ? error
                : new RelayError("gateway_processing_failed", true),
          });
        }
      });
      socket.addEventListener("close", (event) => {
        if (finished) return;
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(event.code))
          return finish({
            fatal: new RelayError(`gateway_fatal_${event.code}`, true),
          });
        if ([4007, 4009, 1000, 1001].includes(event.code))
          this.invalidateSession();
        finish({ delay: event.code === 4008 ? 60000 : 0 });
      });
      // The close event carries fatal auth/intent codes. Do not race it with
      // a generic error event; the Hello/heartbeat watchdog handles a stuck socket.
      socket.addEventListener("error", () => {});
    });
  }
}

export class Relay {
  constructor(
    config,
    store,
    transport,
    gateway,
    { now = Date.now, log = safeLog } = {},
  ) {
    Object.assign(this, { config, store, transport, gateway, now, log });
    this.pollAfter = 0;
  }
  async ingestOne() {
    const row = this.store.inboxNext(this.now());
    if (!row) return;
    try {
      const result = await this.transport.red("message", row.message);
      if (
        result?.accepted !== true ||
        result.id !== row.id ||
        typeof result.duplicate !== "boolean" ||
        typeof result.state !== "string"
      )
        throw new RelayError("invalid_ingress_receipt", true);
      this.store.inboxDone(row.id);
    } catch (error) {
      if (error.fatal) throw error;
      if ([400, 404, 409, 413, 422].includes(error.status)) {
        this.store.inboxDone(row.id, "rejected");
        this.log("inbox_rejected_owner_review");
      } else
        this.store.inboxRetry(
          row.id,
          this.now() +
            (error instanceof RateLimited
              ? error.delay
              : backoff(row.attempts)),
        );
    }
  }
  async receiptOne() {
    const row = this.store.nextReceipt(this.now());
    if (!row) return;
    const delivery = row.delivery;
    try {
      if (row.state === "sent") {
        const result = await this.transport.red("ack", {
          id: row.id,
          leaseToken: delivery.leaseToken,
          messageId: row.message_id,
        });
        if (result?.ok !== true && typeof result?.accepted !== "boolean")
          throw new RelayError("invalid_ack_receipt");
        this.store.receiptDone(row);
      } else {
        const result = await this.transport.red("retry", {
          id: row.id,
          leaseToken: delivery.leaseToken,
          kind: row.state,
        });
        if (!["queued", "review"].includes(result?.state))
          throw new RelayError("invalid_retry_receipt");
        this.store.notified(row);
      }
    } catch (error) {
      if (error.fatal) throw error;
      // Expired leases can be reacquired through poll; a sent local receipt must
      // never cause another Discord POST when the durable job is leased again.
      if (row.state !== "sent" && error.status === 409) {
        this.store.notified(row);
        return;
      }
      this.store.notifyLater(
        row,
        this.now() + (error instanceof RateLimited ? error.delay : 5000),
      );
    }
  }
  async sendDelivery(delivery) {
    delivery = validateDelivery(delivery, this.config, this.now());
    let row = this.store.accept(delivery, this.now());
    if (["sent", "done", "uncertain", "permanent"].includes(row.state)) {
      if (row.state === "done")
        this.store.state(row.id, "sent", { messageId: row.message_id });
      return;
    }
    if (row.state !== "ready")
      throw new RelayError("invalid_local_delivery_state", true);
    if (row.next_at > this.now()) return;
    try {
      await this.transport.checkChannel();
    } catch (error) {
      if (error.fatal) throw error;
      await this.knownUnsent(
        delivery,
        error instanceof RateLimited ? error.delay : 5000,
        error instanceof RateLimited ? "rate_limit" : "transient",
      );
      return;
    }
    if (!this.gateway.ready || delivery.expiresAt <= this.now() + 15000) {
      await this.knownUnsent(delivery, 5000, "transient");
      return;
    }
    this.store.state(delivery.id, "sending"); // FULL synchronous SQLite commit first.
    let response;
    try {
      response = await this.transport.discord(
        "POST",
        `/channels/${this.config.channelId}/messages`,
        discordPayload(delivery),
      );
    } catch (error) {
      if (error instanceof RateLimited) {
        await this.knownUnsent(delivery, error.delay, "rate_limit");
        return;
      }
      // A concurrent own-bot Gateway event can already have proved delivery.
      if (this.store.delivery(delivery.id).state !== "sent")
        this.store.state(delivery.id, "uncertain");
      this.log("delivery_uncertain_owner_review");
      if (error.fatal) throw error;
      return;
    }
    if (
      response.ok &&
      snowflake(response.value?.id) &&
      response.value.channel_id === this.config.channelId &&
      response.value.author?.id === this.config.botId &&
      response.value.author.bot === true &&
      response.value.content === delivery.content &&
      String(response.value.nonce) === delivery.nonce
    ) {
      this.store.state(delivery.id, "sent", { messageId: response.value.id });
    } else if ([400, 401, 403, 404, 405, 413, 422].includes(response.status)) {
      if (this.store.delivery(delivery.id).state !== "sent")
        this.store.state(delivery.id, "permanent");
      this.log("delivery_rejected_owner_review");
      if ([401, 403].includes(response.status))
        throw new RelayError("discord_send_forbidden", true);
    } else {
      if (this.store.delivery(delivery.id).state !== "sent")
        this.store.state(delivery.id, "uncertain");
      this.log("delivery_uncertain_owner_review");
    }
  }
  async knownUnsent(delivery, delay, kind) {
    this.store.state(delivery.id, "ready", { nextAt: this.now() + delay });
    try {
      await this.transport.red("retry", {
        id: delivery.id,
        leaseToken: delivery.leaseToken,
        kind,
        retryAfterMs: delay,
      });
    } catch (error) {
      if (error.fatal) throw error;
    }
  }
  async tick() {
    await this.ingestOne();
    await this.receiptOne();
    if (!this.gateway.ready || this.pollAfter > this.now()) return;
    try {
      const result = await this.transport.red("poll", {});
      if (!result || !Object.hasOwn(result, "delivery"))
        throw new RelayError("invalid_poll_response", true);
      if (result.delivery !== null)
        await this.sendDelivery(
          validateDelivery(result.delivery, this.config, this.now()),
        );
      this.pollAfter = this.now() + 1000;
    } catch (error) {
      if (error.fatal) throw error;
      this.pollAfter =
        this.now() + (error instanceof RateLimited ? error.delay : 5000);
    }
    this.store.prune(this.now());
  }
}

export async function main(env = process.env, command = process.argv[2]) {
  if (!["check", "run"].includes(command))
    throw new RelayError("usage_node_discord_cli_check_or_run", true);
  const config = readConfig(env);
  if (!config.enabled) {
    safeLog("discord_relay_disabled");
    return;
  }
  if (command === "check") {
    safeLog("discord_config_valid_offline_only");
    return;
  }
  process.umask(0o077);
  const store = openStore(config.directory, config);
  const transport = new Transport(config, store);
  const gateway = new Gateway(config, store, transport);
  const relay = new Relay(config, store, transport, gateway);
  let running = true,
    gatewayFailure;
  const stop = () => {
    running = false;
    gateway.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let gatewayTask;
  try {
    await transport.bootstrap();
    safeLog("discord_relay_started_no_history_import");
    if (!running) return;
    gatewayTask = gateway.run().catch((error) => {
      gatewayFailure = error;
      running = false;
    });
    while (running) {
      await relay.tick();
      if (running) await sleep(1000);
    }
    if (gatewayFailure) throw gatewayFailure;
  } finally {
    gateway.stop();
    await gatewayTask;
    store.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    safeLog(error instanceof RelayError ? error.code : "discord_relay_failed");
    process.exitCode = error.fatal ? 78 : 1;
  });
}
