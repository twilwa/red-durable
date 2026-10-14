import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MAX_INBOX, RelayError } from "./protocol.mjs";

// No credentials are stored. The directory contains private message content and
// Gateway resumability metadata; keep it on one local disk, never network storage.
export function openStore(directory, config, now = Date.now()) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.mode & 0o077)
    throw new RelayError("unsafe_storage_directory", true);
  for (const name of [
    "lock.sqlite",
    "lock.sqlite-journal",
    "relay.sqlite",
    "relay.sqlite-wal",
    "relay.sqlite-shm",
    "relay.sqlite-journal",
  ]) {
    const path = join(directory, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (
      stat &&
      (!stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.mode & 0o077)
    )
      throw new RelayError("unsafe_storage_file", true);
  }
  let lock, db;
  try {
    lock = new DatabaseSync(join(directory, "lock.sqlite"));
    chmodSync(join(directory, "lock.sqlite"), 0o600);
    lock.exec(
      "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;",
    );
  } catch {
    lock?.close();
    throw new RelayError("relay_already_running", true);
  }
  try {
    db = new DatabaseSync(join(directory, "relay.sqlite"));
    chmodSync(join(directory, "relay.sqlite"), 0o600);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;
      PRAGMA max_page_count=32768;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', received INTEGER NOT NULL, next_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL, message_id TEXT, next_at INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    `);
    for (const suffix of ["-wal", "-shm"])
      if (existsSync(join(directory, `relay.sqlite${suffix}`)))
        chmodSync(join(directory, `relay.sqlite${suffix}`), 0o600);
    const get = (key) => {
      const row = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
      return row ? JSON.parse(row.value) : null;
    };
    const set = (key, value) =>
      db
        .prepare(
          "INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(key, JSON.stringify(value));
    const binding = JSON.stringify([
      config.guildId,
      config.channelId,
      config.ownerId,
      config.botId,
      config.session,
      config.redUrl,
    ]);
    if (get("binding") !== null && get("binding") !== binding)
      throw new RelayError("storage_binding_mismatch", true);
    set("binding", binding);
    if (get("watermark") === null) set("watermark", now);
    db.exec(
      "UPDATE outbox SET state='uncertain',notified=0 WHERE state='sending'",
    );
    const transaction = (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    const decode = (row) =>
      row ? { ...row, delivery: JSON.parse(row.body) } : null;
    return {
      get,
      set,
      transaction,
      watermark: get("watermark"),
      inboxAdd(message, received = Date.now()) {
        if (db.prepare("SELECT 1 FROM inbox WHERE id=?").get(message.id))
          return false;
        if (
          db
            .prepare("SELECT count(*) AS n FROM inbox WHERE state='pending'")
            .get().n >= MAX_INBOX
        )
          throw new RelayError("inbox_full", true);
        db.prepare("INSERT INTO inbox(id,body,received) VALUES(?,?,?)").run(
          message.id,
          JSON.stringify(message),
          received,
        );
        return true;
      },
      inboxNext(time = Date.now()) {
        const row = db
          .prepare(
            "SELECT * FROM inbox WHERE state='pending' ORDER BY rowid LIMIT 1",
          )
          .get();
        // Preserve Gateway dispatch order, including across rate limits/restarts.
        // Filtering retry deadlines in SQL would let a later message overtake.
        return row && row.next_at <= time
          ? { ...row, message: JSON.parse(row.body) }
          : null;
      },
      inboxDone(id, state = "done") {
        if (state === "done")
          db.prepare("UPDATE inbox SET state=?,body='{}' WHERE id=?").run(
            state,
            id,
          );
        else db.prepare("UPDATE inbox SET state=? WHERE id=?").run(state, id);
      },
      inboxRetry(id, time) {
        db.prepare(
          "UPDATE inbox SET attempts=attempts+1,next_at=? WHERE id=?",
        ).run(time, id);
      },
      delivery(id) {
        return decode(db.prepare("SELECT * FROM outbox WHERE id=?").get(id));
      },
      accept(delivery, time = Date.now()) {
        const digest = createHash("sha256")
          .update(
            JSON.stringify([
              delivery.channelId,
              delivery.replyToMessageId,
              delivery.content,
              delivery.nonce,
            ]),
          )
          .digest("hex");
        const old = this.delivery(delivery.id);
        if (old && old.digest !== digest)
          throw new RelayError("delivery_changed", true);
        if (
          !old &&
          db
            .prepare("SELECT count(*) AS n FROM outbox WHERE state!='done'")
            .get().n >= MAX_INBOX
        )
          throw new RelayError("outbox_full", true);
        try {
          db.prepare(
            "INSERT INTO outbox(id,nonce,digest,body,state,created) VALUES(?,?,?,?,'ready',?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,notified=0",
          ).run(
            delivery.id,
            delivery.nonce,
            digest,
            JSON.stringify(delivery),
            time,
          );
        } catch (error) {
          if (error.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(error.message))
            throw new RelayError("nonce_reused", true);
          throw error;
        }
        return this.delivery(delivery.id);
      },
      state(id, state, { messageId = null, nextAt = 0, notified = 0 } = {}) {
        db.prepare(
          "UPDATE outbox SET state=?,message_id=COALESCE(?,message_id),next_at=?,notified=? WHERE id=?",
        ).run(state, messageId, nextAt, notified, id);
      },
      nextReceipt(time = Date.now()) {
        return decode(
          db
            .prepare(
              "SELECT * FROM outbox WHERE state IN ('sent','uncertain','permanent') AND notified=0 AND next_at<=? ORDER BY created LIMIT 1",
            )
            .get(time),
        );
      },
      // HTTP completions race with synchronous Gateway nonce proofs. Compare
      // the entire leased body and prior state; never hide a newly proven send.
      notifyLater(row, time) {
        db.prepare(
          "UPDATE outbox SET next_at=? WHERE id=? AND state=? AND body=? AND message_id IS ?",
        ).run(time, row.id, row.state, row.body, row.message_id);
      },
      notified(row) {
        db.prepare(
          "UPDATE outbox SET notified=1 WHERE id=? AND state=? AND body=? AND state IN ('uncertain','permanent')",
        ).run(row.id, row.state, row.body);
      },
      receiptDone(row) {
        db.prepare(
          "UPDATE outbox SET state='done',notified=1,next_at=0 WHERE id=? AND state='sent' AND body=? AND message_id=?",
        ).run(row.id, row.body, row.message_id);
      },
      reconcile(message, config) {
        if (
          message.guild_id !== config.guildId ||
          message.channel_id !== config.channelId ||
          message.author?.id !== config.botId ||
          message.author.bot !== true ||
          message.webhook_id != null ||
          ![0, 19].includes(message.type)
        )
          return false;
        const row = decode(
          db
            .prepare(
              "SELECT * FROM outbox WHERE nonce=? AND state IN ('sending','uncertain','sent')",
            )
            .get(String(message.nonce ?? "")),
        );
        if (
          !row ||
          row.delivery.content !== message.content ||
          message.message_reference?.message_id !==
            row.delivery.replyToMessageId
        )
          return false;
        this.state(row.id, "sent", { messageId: message.id });
        return true;
      },
      prune(time = Date.now()) {
        // Originals live durably on the server. Keep local dedup/receipts 30 days;
        // unresolved deliveries and pending inbox items are never silently pruned.
        const cutoff = time - 30 * 86400000;
        db.prepare("DELETE FROM inbox WHERE state='done' AND received<?").run(
          cutoff,
        );
        db.prepare("DELETE FROM outbox WHERE state='done' AND created<?").run(
          cutoff,
        );
      },
      close() {
        db.close();
        lock.close();
      },
    };
  } catch (error) {
    db?.close();
    lock.close();
    throw error;
  }
}
