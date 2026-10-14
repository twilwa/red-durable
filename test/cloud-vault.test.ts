import test from "node:test";
import assert from "node:assert/strict";
import { SubscriptionVault } from "../optional/cloudflare/vault.ts";
class MemoryStorage {
  values = new Map<string, unknown>();
  gate = Promise.resolve();
  async get<T>(k: string): Promise<T | undefined> {
    return structuredClone(this.values.get(k)) as T | undefined;
  }
  async put(k: string, v: unknown) {
    this.values.set(k, structuredClone(v));
  }
  transaction<T>(fn: (tx: MemoryStorage) => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const before = structuredClone(this.values);
      try {
        return await fn(this);
      } catch (e) {
        this.values = before;
        throw e;
      }
    });
    this.gate = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}
const key = () => crypto.getRandomValues(new Uint8Array(32));
const cred = (token: string) => ({
  type: "oauth" as const,
  access: token,
  refresh: `refresh-${token}`,
});
test("vault persists host identity and encrypts credentials outside model state", async () => {
  const db = new MemoryStorage(),
    secret = key();
  const v = await SubscriptionVault.create(db, secret, "personal");
  const host = await v.hostId();
  await v.enroll(cred("secret-one"));
  assert.equal(JSON.stringify([...db.values]).includes("secret-one"), false);
  const restart = await SubscriptionVault.create(db, secret, "personal");
  assert.equal(await restart.hostId(), host);
  assert.deepEqual(await restart.readForInference(), cred("secret-one"));
  assert.deepEqual(await restart.status(), {
    connected: true,
    recoveryRequired: false,
  });
});
test("wrong key, scope substitution, and tampering fail closed", async () => {
  const db = new MemoryStorage(),
    secret = key();
  const v = await SubscriptionVault.create(db, secret, "a");
  await v.enroll(cred("x"));
  await assert.rejects(
    (await SubscriptionVault.create(db, key(), "a")).readForInference(),
    /integrity/,
  );
  await assert.rejects(
    (await SubscriptionVault.create(db, secret, "b")).readForInference(),
    /integrity/,
  );
  const e = await db.get<any>("subscription-vault-v1");
  e.ciphertext = (e.ciphertext[0] === "A" ? "B" : "A") + e.ciphertext.slice(1);
  await db.put("subscription-vault-v1", e);
  await assert.rejects(v.readForInference(), /integrity/);
});
test("exactly one concurrent refresh owner and atomic rotated credential", async () => {
  const db = new MemoryStorage(),
    secret = key();
  const v = await SubscriptionVault.create(db, secret, "a");
  await v.enroll(cred("old"));
  let enter!: () => void, finish!: () => void;
  const entered = new Promise<void>((r) => (enter = r)),
    wait = new Promise<void>((r) => (finish = r));
  let calls = 0;
  const first = v.refreshOnce(async (c) => {
    calls++;
    assert.equal(c.access, "old");
    enter();
    await wait;
    return cred("new");
  });
  await entered;
  const second = await SubscriptionVault.create(db, secret, "a");
  await assert.rejects(
    second.refreshOnce(async () => {
      calls++;
      return cred("bad");
    }),
    /recovery/,
  );
  await assert.rejects(v.readForInference(), /recovery/);
  finish();
  await first;
  assert.equal(calls, 1);
  assert.equal((await second.readForInference())?.access, "new");
});
test("ambiguous refresh survives restart and is never silently retried", async () => {
  const db = new MemoryStorage(),
    secret = key();
  const v = await SubscriptionVault.create(db, secret, "a");
  await v.enroll(cred("old"));
  const host = await v.hostId();
  await assert.rejects(
    v.refreshOnce(async () => {
      throw new Error("network after upstream rotation");
    }),
    /uncertain/,
  );
  const restart = await SubscriptionVault.create(db, secret, "a");
  assert.equal((await restart.status()).recoveryRequired, true);
  await assert.rejects(
    restart.refreshOnce(async () => cred("no")),
    /recovery/,
  );
  await assert.rejects(restart.enroll(cred("no")), /resolved/);
  await restart.forgetAfterOwnerStopped();
  await restart.enroll(cred("reconnected"));
  assert.equal(await restart.hostId(), host);
  assert.equal((await restart.readForInference())?.access, "reconnected");
});
test("failed rotated-token commit keeps durable lock and blocks old token reuse", async () => {
  const db = new MemoryStorage(),
    secret = key();
  const v = await SubscriptionVault.create(db, secret, "a");
  await v.enroll(cred("old"));
  const put = db.put.bind(db);
  let fail = false;
  db.put = async (k, val) => {
    if (fail) {
      fail = false;
      throw new Error("storage unavailable");
    }
    await put(k, val);
  };
  await assert.rejects(
    v.refreshOnce(async () => {
      fail = true;
      return cred("rotated-upstream");
    }),
    /storage unavailable/,
  );
  const restart = await SubscriptionVault.create(db, secret, "a");
  assert.equal((await restart.status()).recoveryRequired, true);
  await assert.rejects(restart.readForInference(), /recovery/);
});
