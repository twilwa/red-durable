import type { MemorySql } from "./memory.ts";
import {
  DiscordError,
  discordChunks,
  normalizeDiscordInput,
  snowflake,
  type DiscordBinding,
  type DiscordInput,
  type DiscordDelivery,
} from "../shared/discord.ts";

type Row = Record<string, unknown>;
/** Caller serializes admission and wraps ingress + chat admission in its DO gate. */
export class DiscordQueue {
  private sql: MemorySql;
  constructor(sql: MemorySql) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_discord_events(id TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_discord_inbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,binding TEXT NOT NULL,state TEXT NOT NULL,run_id TEXT,created INTEGER NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_discord_outbox(id TEXT PRIMARY KEY,input_id TEXT NOT NULL,binding TEXT NOT NULL,content TEXT NOT NULL,nonce TEXT NOT NULL,state TEXT NOT NULL,lease TEXT,expires INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,message_id TEXT,created INTEGER NOT NULL)",
    );
  }
  private rows(query: string, ...args: (string | number | null)[]) {
    return this.sql.exec(query, ...args).toArray();
  }
  receive(
    raw: Record<string, unknown>,
    binding: DiscordBinding,
    now = Date.now(),
  ) {
    const input = normalizeDiscordInput(raw, binding),
      encoded = JSON.stringify(input),
      key = JSON.stringify(binding);
    const previous = this.rows(
      "SELECT * FROM red_discord_inbox WHERE id=?",
      input.id,
    )[0];
    if (previous) {
      if (previous.payload !== encoded || previous.binding !== key)
        throw new DiscordError("Conflicting duplicate Discord message", 409);
      return {
        accepted: true,
        duplicate: true,
        id: input.id,
        state: String(previous.state),
      };
    }
    if (
      Number(this.rows("SELECT COUNT(*) AS n FROM red_discord_inbox")[0].n) >=
        10000 ||
      Number(
        this.rows(
          "SELECT COUNT(*) AS n FROM red_discord_inbox WHERE state IN ('queued','admitted')",
        )[0].n,
      ) >= 100
    )
      throw new DiscordError(
        "Discord inbox is full; review retained work before accepting more",
        429,
      );
    this.sql.exec(
      "INSERT INTO red_discord_inbox(id,payload,binding,state,created) VALUES (?,?,?,'queued',?)",
      input.id,
      encoded,
      key,
      now,
    );
    return { accepted: true, duplicate: false, id: input.id, state: "queued" };
  }
  next(binding: DiscordBinding): DiscordInput | null {
    const row = this.rows(
      "SELECT payload FROM red_discord_inbox WHERE state='queued' AND binding=? ORDER BY created,rowid LIMIT 1",
      JSON.stringify(binding),
    )[0];
    return row ? JSON.parse(String(row.payload)) : null;
  }
  active(): {
    input: DiscordInput;
    binding: DiscordBinding;
    runId: string;
  } | null {
    const row = this.rows(
      "SELECT * FROM red_discord_inbox WHERE state='admitted' ORDER BY created LIMIT 1",
    )[0];
    return row
      ? {
          input: JSON.parse(String(row.payload)),
          binding: JSON.parse(String(row.binding)),
          runId: String(row.run_id),
        }
      : null;
  }
  admitted(id: string, runId: string) {
    const active = this.active();
    if (active && active.input.id !== id)
      throw new DiscordError("A Discord turn is already active", 409);
    this.sql.exec(
      "UPDATE red_discord_inbox SET state='admitted',run_id=? WHERE id=? AND state='queued'",
      runId,
      id,
    );
  }
  complete(id: string) {
    this.sql.exec("UPDATE red_discord_inbox SET state='done' WHERE id=?", id);
  }
  hasQueued(binding: DiscordBinding) {
    return this.next(binding) !== null;
  }
  enqueue(
    inputId: string,
    entryId: string,
    text: string,
    binding: DiscordBinding,
    now = Date.now(),
  ) {
    const eventId = `${inputId}:${entryId}`;
    const eventPayload = JSON.stringify({ text, binding });
    const previous = this.rows(
      "SELECT payload FROM red_discord_events WHERE id=?",
      eventId,
    )[0];
    if (previous) {
      if (previous.payload !== eventPayload)
        throw new DiscordError("Conflicting duplicate Discord output", 409);
    }
    const chunks = discordChunks(text);
    if (!chunks.length) return;
    if (new TextEncoder().encode(text).length > 256000)
      throw new DiscordError("Discord reply exceeds bounded output size", 503);
    const ids = chunks.map((_, i) => `d:${inputId}:${entryId}:${i}`);
    if (ids.some((id) => !/^[a-zA-Z0-9_:-]{1,128}$/.test(id)))
      throw new DiscordError("Invalid output identity", 503);
    const prefix = `d:${inputId}:${entryId}:`;
    for (const row of this.rows(
      "SELECT id,content,binding FROM red_discord_outbox WHERE input_id=? AND substr(id,1,?)=?",
      inputId,
      prefix.length,
      prefix,
    )) {
      const index = ids.indexOf(String(row.id));
      if (
        index < 0 ||
        row.content !== chunks[index] ||
        row.binding !== JSON.stringify(binding)
      )
        throw new DiscordError("Conflicting partial Discord output", 409);
    }
    const missing = ids.filter(
      (id) =>
        !this.rows("SELECT id FROM red_discord_outbox WHERE id=?", id).length,
    );
    if (
      Number(this.rows("SELECT COUNT(*) AS n FROM red_discord_outbox")[0].n) +
        missing.length >
        20000 ||
      Number(
        this.rows(
          "SELECT COUNT(*) AS n FROM red_discord_outbox WHERE state!='sent'",
        )[0].n,
      ) +
        missing.length >
        1000
    )
      throw new DiscordError(
        "Discord outbox is full; pending replies are retained",
        503,
      );
    // Pin the entire immutable event before any chunks, so standalone callers
    // can recover a partial write without accepting a changed unwritten suffix.
    this.sql.exec(
      "INSERT OR IGNORE INTO red_discord_events(id,payload) VALUES (?,?)",
      eventId,
      eventPayload,
    );
    chunks.forEach((content, index) =>
      this.sql.exec(
        "INSERT OR IGNORE INTO red_discord_outbox(id,input_id,binding,content,nonce,state,created) VALUES (?,?,?,?,?,'queued',?)",
        ids[index],
        inputId,
        JSON.stringify(binding),
        content,
        crypto.randomUUID().replace(/-/g, "").slice(0, 24),
        now,
      ),
    );
  }
  poll(binding: DiscordBinding, now = Date.now()): DiscordDelivery | null {
    const row = this.rows(
      "SELECT * FROM red_discord_outbox WHERE binding=? AND state!='sent' ORDER BY created,rowid LIMIT 1",
      JSON.stringify(binding),
    )[0];
    if (
      !row ||
      row.state === "review" ||
      Number(row.next_at) > now ||
      (row.state === "leased" && Number(row.expires) >= now)
    )
      return null;
    const leaseToken = crypto.randomUUID(),
      expiresAt = now + 120000;
    this.sql.exec(
      "UPDATE red_discord_outbox SET state='leased',lease=?,expires=? WHERE id=?",
      leaseToken,
      expiresAt,
      String(row.id),
    );
    return {
      id: String(row.id),
      channelId: binding.channelId,
      replyToMessageId: String(row.input_id),
      content: String(row.content),
      nonce: String(row.nonce),
      leaseToken,
      expiresAt,
    };
  }
  private leased(value: Record<string, unknown>, binding: DiscordBinding): Row {
    if (typeof value.id !== "string" || typeof value.leaseToken !== "string")
      throw new DiscordError("Invalid delivery receipt");
    const row = this.rows(
      "SELECT * FROM red_discord_outbox WHERE id=? AND binding=?",
      value.id,
      JSON.stringify(binding),
    )[0];
    if (!row || row.lease !== value.leaseToken)
      throw new DiscordError("Unknown or stale Discord delivery lease", 409);
    return row;
  }
  ack(value: Record<string, unknown>, binding: DiscordBinding) {
    const row = this.leased(value, binding);
    if (!snowflake(value.messageId))
      throw new DiscordError("Invalid Discord delivery message ID");
    if (row.state === "sent") {
      if (row.message_id !== value.messageId)
        throw new DiscordError("Conflicting delivery acknowledgement", 409);
      return { accepted: false };
    }
    if (row.state !== "leased" && row.state !== "review")
      throw new DiscordError("Delivery is not leased", 409);
    // Expiry alone is safe: a later claim changes the lease and rejects this receipt.
    this.sql.exec(
      "UPDATE red_discord_outbox SET state='sent',message_id=? WHERE id=?",
      value.messageId,
      String(row.id),
    );
    return { accepted: true };
  }
  retry(
    value: Record<string, unknown>,
    binding: DiscordBinding,
    now = Date.now(),
  ) {
    const row = this.leased(value, binding);
    if (row.state !== "leased")
      throw new DiscordError("Delivery is not leased", 409);
    if (
      typeof value.kind !== "string" ||
      !["rate_limit", "transient", "uncertain", "permanent"].includes(
        value.kind,
      )
    )
      throw new DiscordError("Invalid delivery outcome");
    const delay = value.retryAfterMs ?? 30000;
    if (
      typeof delay !== "number" ||
      !Number.isSafeInteger(delay) ||
      delay < 0 ||
      delay > 86400000
    )
      throw new DiscordError("Invalid retry delay");
    const state =
      value.kind === "uncertain" || value.kind === "permanent"
        ? "review"
        : "queued";
    this.sql.exec(
      "UPDATE red_discord_outbox SET state=?,next_at=?,lease=?,expires=0 WHERE id=?",
      state,
      now + Math.max(1000, delay),
      state === "review" ? String(row.lease) : null,
      String(row.id),
    );
    return { state };
  }
  status() {
    return {
      inbox: this.rows(
        "SELECT state,COUNT(*) AS count FROM red_discord_inbox GROUP BY state",
      ),
      outbox: this.rows(
        "SELECT state,COUNT(*) AS count FROM red_discord_outbox GROUP BY state",
      ),
    };
  }
}
