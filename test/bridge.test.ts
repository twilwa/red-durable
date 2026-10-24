import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../bridge/store.mjs";
import {
  bridgeEndpoint,
  exchange,
  readBounded,
  validateJob,
  executeJob,
  classifyError,
} from "../bridge/protocol.mjs";
const job = () => ({
  id: "job-1",
  leaseToken: "lease-1",
  expiresAt: Date.now() + 180000,
  modelId: "gpt-test",
  context: { messages: [] },
  options: { reasoning: "low" },
});
test("bridge limits destinations, options and response sizes", async () => {
  assert.equal(bridgeEndpoint("https://example.com"), "https://example.com");
  for (const u of [
    "http://example.com",
    "https://x/y",
    "https://u:p@x",
    "https://x/?token=x",
  ])
    assert.throws(() => bridgeEndpoint(u));
  assert.throws(() =>
    validateJob({ ...job(), options: { apiKey: "injection" } }),
  );
  assert.throws(() => validateJob({ ...job(), expiresAt: 0 }));
  await assert.rejects(readBounded(new Response("x".repeat(600000))));
  let captured;
  await exchange(
    "https://example.com",
    "a",
    "test",
    "poll",
    {},
    async (url, options) => {
      captured = { url, options };
      return new Response("{}");
    },
  );
  assert.equal(captured.url, "https://example.com/api/bridge/poll");
  assert.equal(captured.options.redirect, "error");
});
test("private store locks runners and serializes atomic rotations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-bridge-"));
  const store = await openStore(dir);
  try {
    await assert.rejects(openStore(dir));
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      n: 0,
    }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.credentials.modify("openai", async (c) => ({ ...c, n: c.n + 1 })),
      ),
    );
    assert.equal((await store.credentials.read("openai")).n, 20);
    assert.equal(
      (await stat(join(dir, "credentials.json"))).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      store.credentials.modify("openai", async () => ({
        type: "api_key",
        key: "never",
      })),
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("bridge journals exactly one inference and replays completed results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-journal-"));
  const store = await openStore(dir);
  let calls = 0;
  try {
    const j = job();
    const infer = async () => {
      calls++;
      return { role: "assistant", content: [], stopReason: "stop" };
    };
    const a = await executeJob(j, store, infer);
    const b = await executeJob({ ...j, leaseToken: "new" }, store, infer);
    assert.equal(calls, 1);
    assert.deepEqual(a.message, b.message);
    assert.equal(b.leaseToken, "new");
    await store.write("journal.json", { jobId: j.id, state: "running" });
    const c = await executeJob(j, store, infer);
    assert.equal(c.error.kind, "invalid");
    assert.equal(calls, 1);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("quota and authentication errors are sanitized", () => {
  assert.equal(
    classifyError(new Error("subscription_sharing_usage_limit_exceeded secret"))
      .kind,
    "quota",
  );
  const e = classifyError(new Error("oauth refresh secret"));
  assert.equal(e.kind, "auth");
  assert.equal(
    classifyError(
      new Error(
        "Provider authentication needs attention. Reconnect this provider locally.",
      ),
    ).kind,
    "auth",
  );
  assert.ok(!e.message.includes("secret"));
});
test("real outbound HTTP protocol posts a bounded inference result without OAuth", async () => {
  const { createServer } = await import("node:http");
  const received = [];
  const server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    received.push({
      url: req.url,
      authorization: req.headers.authorization,
      session: req.headers["x-session"],
      data: JSON.parse(data),
    });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(req.url.endsWith("/poll") ? { job: job() } : { ok: true }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "red-http-"));
  const store = await openStore(dir);
  try {
    const origin = bridgeEndpoint(`http://127.0.0.1:${server.address().port}`);
    const polled = await readBounded(
      await exchange(origin, "session-a", "bridge-only", "poll", {
        modelIds: ["gpt-test"],
      }),
    );
    const result = await executeJob(polled.job, store, async () => ({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "do not persist" },
        { type: "text", text: "Hello" },
      ],
      stopReason: "stop",
    }));
    assert.deepEqual(result.message.content, [{ type: "text", text: "Hello" }]);
    const posted = await exchange(
      origin,
      "session-a",
      "bridge-only",
      "result",
      result,
    );
    assert.equal(posted.status, 200);
    assert.equal(received[1].authorization, "Bearer bridge-only");
    assert.equal(received[1].session, "session-a");
    assert.equal(received[1].data.jobId, "job-1");
    assert.ok(!JSON.stringify(received).includes("do not persist"));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});
test("VM bootstrap preserves target identity and refuses existing staging directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "red-bootstrap-"));
  const target = join(root, "vm");
  const stage = join(root, "new-stage");
  const vm = await openStore(target);
  const id = vm.hostId;
  await vm.close();
  try {
    const local = await openStore(stage, { bootstrapHostId: id });
    assert.equal(local.hostId, id);
    assert.equal(await local.credentials.read("openai"), undefined);
    await local.close();
    await assert.rejects(openStore(stage, { bootstrapHostId: id }));
    await assert.rejects(
      openStore(target, {
        bootstrapHostId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    );
    await assert.rejects(
      openStore(join(root, "bad"), { bootstrapHostId: "not-a-uuid" }),
    );
    const reopened = await openStore(target);
    assert.equal(reopened.hostId, id);
    await reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("bridge only accepts bounded integer token hints", () => {
  assert.equal(
    validateJob({ ...job(), options: { maxTokens: 180 } }).options.maxTokens,
    180,
  );
  for (const value of [0, -1, 16001, 1.5, "180", null])
    assert.throws(() =>
      validateJob({ ...job(), options: { maxTokens: value } }),
    );
});
test("host-info CLI exposes only stable non-secret identity without OAuth", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "red-host-info-"));
  const directory = join(root, "runtime");
  try {
    const invoke = () =>
      spawnSync(process.execPath, ["bridge/cli.mjs", "host-info"], {
        cwd: new URL("..", import.meta.url),
        env: {
          ...process.env,
          RED_BRIDGE_DIR: directory,
          RED_AUTH_HOST_ID: undefined,
        },
        encoding: "utf8",
      });
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    const second = invoke();
    assert.equal(second.status, 0, second.stderr);
    const info = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(info).sort(), ["agentHostId", "hostId"]);
    assert.equal(info.agentHostId, `urn:uuid:${info.hostId}`);
    assert.equal(first.stdout, second.stdout);
    await assert.rejects(stat(join(directory, "credentials.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("credential rotation commit failure leaves a durable no-token marker and blocks reopen", async () => {
  const { mkdir, readFile, unlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "red-rotation-fail-"));
  let store = await openStore(dir);
  const id = store.hostId;
  let calls = 0;
  try {
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      refresh: "old-test-only",
      access: "old-test-only",
    }));
    await assert.rejects(
      store.credentials.modify("openai", async () => {
        calls++;
        // Simulate successful upstream rotation, followed by a failed atomic file commit.
        await unlink(join(dir, "credentials.json"));
        await mkdir(join(dir, "credentials.json"));
        return {
          type: "oauth",
          refresh: "new-test-only",
          access: "new-test-only",
        };
      }),
      (error) => error.code === "CREDENTIAL_RECOVERY_REQUIRED",
    );
    const marker = await readFile(join(dir, "credential-update.json"), "utf8");
    assert.deepEqual(JSON.parse(marker), { version: 1, state: "in-flight" });
    assert.ok(!marker.includes("test-only"));
    await store.close();
    store = await openStore(dir);
    assert.equal(store.hostId, id);
    await assert.rejects(
      store.credentials.read("openai"),
      (error) => error.code === "CREDENTIAL_RECOVERY_REQUIRED",
    );
    await assert.rejects(
      store.credentials.modify("openai", async () => {
        calls++;
      }),
      (error) => error.code === "CREDENTIAL_RECOVERY_REQUIRED",
    );
    assert.equal(calls, 1);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("uncertain callback blocks recovery; successful commit and confirmed nochange clear marker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-update-marker-"));
  const store = await openStore(dir);
  try {
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      access: "fixture",
    }));
    assert.equal(await store.read("credential-update.json"), undefined);
    await store.credentials.modify("openai", async () => undefined);
    assert.equal(await store.read("credential-update.json"), undefined);
    await assert.rejects(
      store.credentials.modify("openai", async () => {
        throw new Error("uncertain provider response");
      }),
      (error) => error.code === "CREDENTIAL_RECOVERY_REQUIRED",
    );
    await assert.rejects(
      store.credentials.delete(),
      (error) => error.code === "CREDENTIAL_RECOVERY_REQUIRED",
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider credentials stay separate and deleting one preserves others across reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-provider-store-"));
  let store = await openStore(dir);
  try {
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      access: "fixture-oauth",
    }));
    await store.credentials.modify("openrouter", async () => ({
      type: "api_key",
      key: "fixture-router",
    }));
    await store.credentials.modify("opencode-zen", async () => ({
      type: "api_key",
      key: "fixture-zen",
    }));
    await store.credentials.modify("kimi-code", async () => ({
      type: "api_key",
      key: "fixture-kimi",
    }));
    assert.deepEqual(await store.credentials.list(), [
      { providerId: "openai", type: "oauth" },
      { providerId: "openrouter", type: "api_key" },
      { providerId: "opencode-zen", type: "api_key" },
      { providerId: "kimi-code", type: "api_key" },
    ]);
    await store.credentials.delete("openrouter");
    await store.close();
    store = await openStore(dir);
    assert.equal(await store.credentials.read("openrouter"), undefined);
    assert.equal(
      (await store.credentials.read("openai")).access,
      "fixture-oauth",
    );
    assert.equal(
      (await store.credentials.read("opencode-zen")).key,
      "fixture-zen",
    );
    assert.equal(
      (await store.credentials.read("kimi-code")).key,
      "fixture-kimi",
    );
    await store.credentials.delete("kimi-code");
    assert.equal(await store.credentials.read("kimi-code"), undefined);
    assert.equal(
      (await store.credentials.read("opencode-zen")).key,
      "fixture-zen",
    );
    assert.equal(await store.credentials.read("opencode-go"), undefined);
    await assert.rejects(
      store.credentials.modify("opencode-go", async () => ({
        type: "api_key",
        key: "fixture",
      })),
    );
    assert.equal(
      (await stat(join(dir, "credentials.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("bridge journal drops provider metadata and opaque content signatures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-result-redaction-"));
  const store = await openStore(dir);
  try {
    const result = await executeJob(job(), store, async () => ({
      role: "assistant",
      content: [
        { type: "text", text: "safe", textSignature: "fixture-secret" },
        {
          type: "toolCall",
          id: "call",
          name: "counter_get",
          arguments: {},
          metadata: "fixture-secret",
        },
      ],
      stopReason: "toolUse",
      provider: "fixture-secret",
      api: "fixture-secret",
      raw: { Authorization: "fixture-secret" },
      timestamp: 10,
    }));
    assert.ok(!JSON.stringify(result).includes("fixture-secret"));
    assert.ok(
      !JSON.stringify(await store.read("journal.json")).includes(
        "fixture-secret",
      ),
    );
    assert.equal(result.message.content[1].type, "toolCall");
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("status reads wait for a live credential rotation rather than misreporting recovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-live-refresh-"));
  const store = await openStore(dir);
  try {
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      access: "old-fixture",
    }));
    let enter!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      wait = new Promise<void>((r) => (finish = r));
    const rotation = store.credentials.modify("openai", async () => {
      enter();
      await wait;
      return { type: "oauth", access: "new-fixture" };
    });
    await entered;
    const read = store.credentials.read("openai");
    const list = store.credentials.list();
    finish();
    await rotation;
    assert.equal((await read).access, "new-fixture");
    assert.deepEqual(await list, [{ providerId: "openai", type: "oauth" }]);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
