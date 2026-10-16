import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  cacheCapability,
  cacheIdentity,
  cachePayload,
  cacheSystemSegments,
} from "../bridge/prompt-cache.mjs";
import { createProviderManager } from "../bridge/providers.mjs";
import { validateJob, executeJob } from "../bridge/protocol.mjs";
import { openStore } from "../bridge/store.mjs";
import { BridgeQueue } from "../src/bridge-queue.ts";
import {
  withConversationMemory,
  summaryContext,
} from "../src/prompt-context.ts";

// Entirely synthetic credentials, prompts, usage, models and provider streams.
// These fixtures verify actual pinned serialization, not live cache hits or prices.
const HOST = "1da7c34c-dca0-4799-8262-d8cf4260ed1a";
const SCOPE = "2da7c34c-dca0-4799-8262-d8cf4260ed1a";
const ACCOUNT = "3da7c34c-dca0-4799-8262-d8cf4260ed1a";
const KEY = "synthetic-cache-key-never-real";
const oauth = {
  type: "oauth",
  access: "synthetic-cache-access",
  refresh: "synthetic-cache-refresh",
  expires: Date.now() + 3600000,
  clientId: "synthetic-client",
  subject: "synthetic-subject",
  scopes: ["chatgpt.tokens.use.direct"],
};
function context(
  archive = "<chat>\n" +
    "0+1|日本語🙂 Synthetic memory. ".repeat(700) +
    "\n</chat>",
  continuity = "Synthetic evidence.",
) {
  return {
    messages: withConversationMemory(
      [
        {
          role: "system",
          content: "Protected synthetic instructions.",
          sections: { red: "Approved synthetic charter." },
          toolsAdded: [
            {
              name: "inspect",
              description: "Synthetic tool.",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
              },
            },
          ],
          timestamp: 111,
        },
        { role: "user", content: "Synthetic current request.", timestamp: 222 },
      ],
      { archive, continuity },
    ),
  };
}
function job(modelId = "gpt-6.1-sol", changes = {}) {
  return {
    id: "synthetic-job-1",
    leaseToken: "synthetic-lease",
    expiresAt: Date.now() + 120000,
    modelId,
    context: context(),
    summary: false,
    cache: { version: 1, namespace: SCOPE, purpose: "conversation" },
    ...changes,
  };
}
const model = (id, api = "anthropic-messages") => ({ id, api });
function payload(m, c = context()) {
  return {
    model: m.id,
    system: [{ type: "text", text: cacheSystemSegments(c, m).text }],
    messages: [{ role: "user", content: "Changing question." }],
  };
}
function cacheControls(value) {
  if (!value || typeof value !== "object") return [];
  return [
    ...(value.cache_control ? [value.cache_control] : []),
    ...Object.values(value).flatMap(cacheControls),
  ];
}

test("capability matrix never stamps unsupported routes or enables Go", () => {
  assert.equal(
    cacheCapability("openai", model("gpt-6.1-sol", "openai-responses"))
      .promptKey,
    true,
  );
  assert.equal(
    cacheCapability("openrouter", model("anthropic/claude-sonnet-4.6")).mode,
    "anthropic-breakpoints",
  );
  assert.equal(
    cacheCapability("openrouter", {
      ...model("anthropic/claude-sonnet-4.6:batch", "openai-completions"),
      compat: { cacheControlFormat: "anthropic" },
    }).mode,
    "anthropic-breakpoints",
  );
  for (const [provider, m] of [
    ["openrouter", model("other/claude-clone")],
    ["openrouter", model("anthropic/claude-sonnet-4.6", "unknown")],
    ["opencode-zen", model("glm-5", "openai-completions")],
  ]) {
    const cap = cacheCapability(provider, m);
    assert.equal(cap.mode, "provider-managed");
    assert.ok(!cap.promptKey);
  }
  assert.equal(
    cacheCapability("opencode-zen", model("gpt-5.4", "openai-responses"))
      .promptKey,
    true,
  );
  assert.equal(
    cacheCapability("opencode-zen", model("claude-sonnet-4-6")).mode,
    "anthropic-breakpoints",
  );
  assert.deepEqual(cacheCapability("opencode-go", model("glm-5")), {
    mode: "disabled",
  });
});

test("routing identity isolates host, account epoch, conversation, provider/model/API and purpose without prompt data", () => {
  const input = {
    hostId: HOST,
    accountNamespace: ACCOUNT,
    provider: "openai",
    model: model("gpt-6.1-sol", "openai-responses"),
    job: job(),
  };
  const original = cacheIdentity(input);
  assert.match(original, /^red-v1-[0-9a-f]{56}$/);
  assert.ok(original.length <= 64);
  assert.equal(
    cacheIdentity({
      ...input,
      job: job(undefined, {
        id: "new-job",
        leaseToken: "new-lease",
        context: context("New source", "New evidence"),
        expiresAt: 9999999999999,
      }),
    }),
    original,
  );
  for (const change of [
    { hostId: "another-host" },
    { accountNamespace: "another-account-epoch" },
    { provider: "opencode-zen" },
    { model: model("gpt-5.4", "openai-responses") },
    { model: model("gpt-6.1-sol", "other-api") },
    {
      job: job(undefined, {
        cache: { version: 1, namespace: HOST, purpose: "conversation" },
      }),
    },
    {
      job: job(undefined, {
        summary: true,
        cache: { version: 1, namespace: SCOPE, purpose: "summary" },
      }),
    },
  ])
    assert.notEqual(cacheIdentity({ ...input, ...change }), original);
  const legacy = { ...input, job: job(undefined, { cache: undefined }) };
  assert.notEqual(
    cacheIdentity(legacy),
    cacheIdentity({
      ...legacy,
      job: { ...legacy.job, id: "another-legacy-job" },
    }),
  );
  assert.ok(!original.includes(KEY));
});

test("explicit stable blocks preserve all Unicode text, cap breakpoints and exclude volatile/user tails", () => {
  const m = model("claude-sonnet-4-6");
  const c = context();
  const original = payload(m, c);
  const copy = structuredClone(original);
  const result = cachePayload(original, {
    provider: "opencode-zen",
    model: m,
    context: c,
    key: "opaque",
  });
  assert.deepEqual(original, copy);
  assert.equal(
    result.system.map((b) => b.text).join(""),
    original.system[0].text,
  );
  assert.equal(cacheControls(result).length, 3);
  assert.ok(
    cacheControls(result).every(
      (control) => JSON.stringify(control) === '{"type":"ephemeral"}',
    ),
  );
  assert.match(result.system.at(-1).text, /Continuity evidence/);
  assert.equal(result.system.at(-1).cache_control, undefined);
  assert.deepEqual(result.messages, original.messages);
  assert.ok(
    result.system.every(
      (b) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(b.text),
    ),
  );
  assert.equal(result.prompt_cache_key, undefined);
});

test("completed archive blocks stay exact on append; volatility cannot invalidate them; compaction/charter changes do", () => {
  const m = model("anthropic/claude-sonnet-4.6");
  const render = (c) =>
    cachePayload(payload(m, c), {
      provider: "openrouter",
      model: m,
      context: c,
      key: "opaque",
    }).system;
  const archive = "<chat>\n" + "Old stable row. ".repeat(1000) + "\n</chat>";
  const before = render(context(archive));
  const changed = render(
    context(archive, "Changed continuity + 4 attachments."),
  );
  assert.deepEqual(before.slice(0, -1), changed.slice(0, -1));
  const appended = render(
    context(archive.slice(0, -8) + "\nNew row.\n</chat>"),
  );
  // Compare text rather than moving breakpoint placement; the actual prefix
  // bytes through complete preceding blocks are unchanged.
  assert.deepEqual(
    before.slice(0, -2).map((b) => b.text),
    appended.slice(0, -2).map((b) => b.text),
  );
  const compacted = render(context("<chat>\n0+64|Compacted fixture.\n</chat>"));
  assert.equal(compacted[0].text, before[0].text);
  assert.notEqual(compacted[1].text, before[1].text);
  const charter = context(archive);
  charter.messages[0].sections.red = "New approved charter.";
  assert.notEqual(render(charter)[0].text, before[0].text);
});

test("summary jobs share compact prefix across changing sources but serialize source intact", () => {
  const m = model("claude-sonnet-4-6");
  const a = summaryContext({
    context: "<chat>\n" + "Older context. ".repeat(500) + "\n</chat>",
    source: 'Synthetic original "quoted"\n🙂',
  });
  const b = summaryContext({
    context: JSON.parse(a.messages[0].sections.red_compact.split("\n")[1])
      .context,
    source: "Different sibling source.",
  });
  const render = (c) =>
    cachePayload(payload(m, c), {
      provider: "opencode-zen",
      model: m,
      context: c,
      key: "opaque",
    });
  assert.deepEqual(render(a).system, render(b).system);
  assert.equal(
    JSON.parse(a.messages[1].content).source,
    'Synthetic original "quoted"\n🙂',
  );
});

test("serializer mismatch, malformed section ordering, unknown route and off switch never invent breakpoints", () => {
  const m = model("claude-sonnet-4-6");
  const c = context();
  const original = payload(m, c);
  const args = {
    provider: "opencode-zen",
    model: m,
    context: c,
    key: "opaque",
  };
  assert.deepEqual(
    cachePayload(
      {
        ...original,
        system: [{ type: "text", text: "Different serialization" }],
      },
      args,
    ).system,
    [{ type: "text", text: "Different serialization" }],
  );
  for (const change of [
    { enabled: false },
    { provider: "opencode-go" },
    { model: model("unknown-model") },
  ])
    assert.equal(
      cacheControls(cachePayload(original, { ...args, ...change })).length,
      0,
    );
  c.messages[0].sections.late = "A later unexpected section.";
  assert.equal(cacheSystemSegments(c, m), null);
  const fake = {
    ...original,
    prompt_cache_key: "unexpected",
    prompt_cache_retention: "24h",
    prompt_cache_options: { mode: "write" },
  };
  const off = cachePayload(fake, { ...args, enabled: false });
  for (const key of [
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
  ])
    assert.equal(off[key], undefined);
});

test("bridge protocol rejects untrusted cache policies and accepts legacy scope absence", () => {
  assert.doesNotThrow(() => validateJob(job()));
  assert.doesNotThrow(() => validateJob(job(undefined, { cache: undefined })));
  for (const cache of [
    null,
    [],
    {},
    { version: 2, namespace: SCOPE, purpose: "conversation" },
    { version: 1, namespace: "secret", purpose: "conversation" },
    { version: 1, namespace: SCOPE, purpose: "summary" },
    { version: 1, namespace: SCOPE, purpose: "conversation", retention: "24h" },
  ])
    assert.throws(() => validateJob(job(undefined, { cache })), /cache/);
});

function sqlFor(db) {
  return {
    exec(q, ...args) {
      const s = db.prepare(q);
      const rows = s.columns().length ? s.all(...args) : (s.run(...args), []);
      return { toArray: () => rows };
    },
  };
}
test("real durable queue namespace survives close/reopen and retries, but differs across sessions and purposes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-cache-scope-"));
  let db = new DatabaseSync(join(dir, "queue.sqlite"));
  try {
    let q = new BridgeQueue(sqlFor(db));
    const c = context("Short synthetic archive");
    const id = await q.enqueue("gpt-6.1-sol", c);
    const first = q.poll();
    assert.equal(first.cache.purpose, "conversation");
    assert.equal(first.id, id);
    db.close();
    db = new DatabaseSync(join(dir, "queue.sqlite"));
    q = new BridgeQueue(sqlFor(db));
    assert.equal(await q.enqueue("gpt-6.1-sol", c), id);
    const retry = q.poll(first.expiresAt + 1);
    assert.deepEqual(retry.cache, first.cache);
    assert.notEqual(retry.leaseToken, first.leaseToken);
    q.cancel(id);
    await q.enqueue(
      "gpt-6.1-sol",
      summaryContext({ context: "Compact", source: "Source" }),
      {},
      "red-memory:leaf:fixture",
    );
    const summary = q.poll();
    assert.equal(summary.cache.namespace, first.cache.namespace);
    assert.equal(summary.cache.purpose, "summary");
    const otherDb = new DatabaseSync(":memory:");
    try {
      const other = new BridgeQueue(sqlFor(otherDb));
      await other.enqueue("gpt-6.1-sol", c);
      assert.notEqual(other.poll().cache.namespace, first.cache.namespace);
    } finally {
      otherDb.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function stream(api) {
  const events =
    api === "anthropic-messages"
      ? [
          {
            type: "message_start",
            message: {
              id: "synthetic-message",
              type: "message",
              role: "assistant",
              content: [],
              model: "fixture",
              usage: {
                input_tokens: 30,
                output_tokens: 0,
                cache_read_input_tokens: 60,
                cache_creation_input_tokens: 10,
              },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Synthetic reply." },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: "message_stop" },
        ]
      : api === "openai-responses"
        ? [
            {
              type: "response.completed",
              response: {
                id: "synthetic-response",
                status: "completed",
                output: [],
                usage: {
                  input_tokens: 100,
                  output_tokens: 5,
                  total_tokens: 105,
                  input_tokens_details: {
                    cached_tokens: 60,
                    cache_write_tokens: 10,
                  },
                },
              },
            },
          ]
        : [
            {
              id: "synthetic-chat",
              choices: [
                {
                  index: 0,
                  delta: { content: "Synthetic reply." },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "synthetic-chat",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 100,
                completion_tokens: 5,
                total_tokens: 105,
                prompt_tokens_details: {
                  cached_tokens: 60,
                  cache_write_tokens: 10,
                },
              },
            },
          ];
  return new Response(
    events
      .map(
        (e) =>
          (e.type ? `event: ${e.type}\n` : "") +
          `data: ${JSON.stringify(e)}\n\n`,
      )
      .join("") + (api === "openai-completions" ? "data: [DONE]\n\n" : ""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function managerFixture({ cachePolicy = "auto", store: supplied } = {}) {
  const files = new Map();
  const credentials = new Map([
    ["openai", oauth],
    ["openrouter", { type: "api_key", key: KEY }],
    ["opencode-zen", { type: "api_key", key: KEY }],
  ]);
  const store = supplied ?? {
    hostId: HOST,
    read: async (name) => files.get(name),
    write: async (name, value) => files.set(name, structuredClone(value)),
    credentials: {
      read: async (id) => credentials.get(id),
      list: async () => [],
      modify: async (id, fn) =>
        credentials.set(id, await fn(credentials.get(id))),
      delete: async (id) => credentials.delete(id),
    },
  };
  const requests = [];
  const manager = createProviderManager({
    store,
    cachePolicy,
    fetcher: async (url, init) => {
      url = String(url);
      if (url.endsWith("/key")) return Response.json({ data: {} });
      if (url === "https://api.openai.com/v1/models")
        return Response.json({
          models: [{ slug: "gpt-6.1-sol", visibility: "list" }],
        });
      if (url === "https://openrouter.ai/api/v1/models")
        return Response.json({
          data: [
            "anthropic/claude-sonnet-4.6",
            "anthropic/claude-sonnet-4.6:batch",
            "openai/gpt-4.1",
          ].map((id) => ({
            id,
            supported_parameters: ["tools"],
          })),
        });
      if (url === "https://opencode.ai/inference/v1/models")
        return Response.json({
          data: [{ id: "claude-sonnet-4-6" }, { id: "gpt-5.4" }],
        });
      const body = JSON.parse(init.body);
      requests.push({ url, headers: new Headers(init.headers), body });
      return stream(
        url.includes("/messages")
          ? "anthropic-messages"
          : url.endsWith("/responses")
            ? "openai-responses"
            : "openai-completions",
      );
    },
  });
  return { manager, requests, store, files };
}

for (const [id, kind, header] of [
  ["gpt-6.1-sol", "key", null],
  ["openrouter::anthropic/claude-sonnet-4.6", "explicit", "x-session-id"],
  ["openrouter::anthropic/claude-sonnet-4.6:batch", "explicit", "x-session-id"],
  ["openrouter::openai/gpt-4.1", "managed", "x-session-id"],
  ["opencode-zen::claude-sonnet-4-6", "explicit", "x-opencode-session"],
  ["opencode-zen::gpt-5.4", "key", "x-opencode-session"],
])
  test(`real pinned ${id} serialization has only allowed cache controls and accurate usage`, async () => {
    const f = managerFixture();
    try {
      const a = await f.manager.infer(job(id));
      const first = f.requests.at(-1);
      assert.equal(a.usage.input, 30);
      assert.equal(a.usage.cacheRead, 60);
      assert.equal(a.usage.cacheWrite, 10);
      assert.equal(a.usage.output, 5);
      assert.equal(a.usage.totalTokens, 105);
      if (kind === "key")
        assert.match(first.body.prompt_cache_key, /^red-v1-[0-9a-f]{56}$/);
      else assert.equal(first.body.prompt_cache_key, undefined);
      assert.equal(
        cacheControls(first.body).length,
        kind === "explicit" ? 3 : 0,
      );
      assert.equal(first.body.prompt_cache_retention, undefined);
      assert.equal(first.body.prompt_cache_options, undefined);
      if (header)
        assert.match(first.headers.get(header), /^red-v1-[0-9a-f]{56}$/);
      if (id.startsWith("opencode-zen"))
        assert.equal(first.headers.get("user-agent"), "red-durable/0.1.0");
      if (id === "openrouter::openai/gpt-4.1")
        assert.deepEqual(first.body.provider, {
          allow_fallbacks: false,
          require_parameters: true,
        });
      const c = context(undefined, "Changed volatile evidence.");
      c.messages[0].timestamp = 9999;
      c.messages[1].timestamp = 9999;
      c.messages[1].content = "Second synthetic request.";
      await f.manager.infer(job(id, { id: "synthetic-job-2", context: c }));
      const next = f.requests.at(-1);
      assert.equal(first.body.prompt_cache_key, next.body.prompt_cache_key);
      if (header)
        assert.equal(first.headers.get(header), next.headers.get(header));
      if (kind === "explicit")
        assert.deepEqual(
          (first.body.system ?? first.body.messages[0].content).slice(0, -1),
          (next.body.system ?? next.body.messages[0].content).slice(0, -1),
        );
      if (id === "gpt-6.1-sol") {
        assert.equal(first.url, "https://api.openai.com/v1/responses");
        assert.equal(first.body.store, false);
        assert.equal(first.body.input[0].type, "additional_tools");
        assert.equal(first.body.input[1].role, "developer");
        assert.ok(
          !JSON.stringify(first.body).includes("synthetic-cache-access"),
        );
      }
    } finally {
      await f.manager.close();
    }
  });

test("provider cache namespaces persist across actual store reopen and rotate on reconnect without credential-derived keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-cache-store-"));
  let store = await openStore(dir);
  let f;
  try {
    await store.credentials.modify("openrouter", async () => ({
      type: "api_key",
      key: KEY,
    }));
    f = managerFixture({ store });
    await f.manager.infer(job("openrouter::openai/gpt-4.1"));
    const first = f.requests.at(-1).headers.get("x-session-id");
    const disk = JSON.stringify(await store.read("prompt-cache.json"));
    assert.ok(!disk.includes(KEY));
    assert.ok(!disk.includes("Synthetic"));
    await f.manager.close();
    await store.close();
    store = await openStore(dir);
    f = managerFixture({ store });
    await f.manager.infer(job("openrouter::openai/gpt-4.1"));
    assert.equal(f.requests.at(-1).headers.get("x-session-id"), first);
    await f.manager.disconnect("openrouter");
    await f.manager.connectKey("openrouter", "synthetic-replacement-cache-key");
    await f.manager.infer(job("openrouter::openai/gpt-4.1"));
    assert.notEqual(f.requests.at(-1).headers.get("x-session-id"), first);
  } finally {
    await f?.manager.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("off switch and ambient long retention cannot enable cache fields or leak state into journal", async () => {
  const previous = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";
  const f = managerFixture({ cachePolicy: "off" });
  try {
    for (const id of [
      "gpt-6.1-sol",
      "openrouter::anthropic/claude-sonnet-4.6",
      "opencode-zen::gpt-5.4",
    ]) {
      const j = job(id, { id: `synthetic-${id}` });
      const result = await executeJob(j, f.store, (input) =>
        f.manager.infer(input),
      );
      assert.ok(result.message);
      const body = f.requests.at(-1).body;
      assert.equal(cacheControls(body).length, 0);
      assert.equal(body.prompt_cache_key, undefined);
      assert.equal(body.prompt_cache_retention, undefined);
      assert.equal(body.prompt_cache_options, undefined);
      assert.equal(result.message.usage.cacheRead, 60);
      const stored = JSON.stringify(await f.store.read("journal.json"));
      for (const secret of [
        KEY,
        SCOPE,
        "red-v1-",
        "prompt_cache",
        "cache_control",
        "Synthetic memory",
      ])
        assert.ok(!stored.includes(secret));
    }
  } finally {
    await f.manager.close();
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
  }
});

test("cache namespace storage failures stop before inference without exposing storage text", async () => {
  for (const mode of ["corrupt", "write-failure"]) {
    const f = managerFixture();
    if (mode === "corrupt")
      f.files.set("prompt-cache.json", {
        version: 1,
        providers: { openai: "synthetic-sensitive-storage-text" },
      });
    else
      f.store.write = async () => {
        throw new Error("synthetic-sensitive-storage-text");
      };
    try {
      await assert.rejects(
        f.manager.infer(job()),
        (error) => !error.message.includes("synthetic-sensitive-storage-text"),
      );
      assert.equal(f.requests.length, 0);
    } finally {
      await f.manager.close();
    }
  }
});

test("real subscription serializer preserves stable cache key across tool rounds and separates summary purpose", async () => {
  const f = managerFixture();
  try {
    await f.manager.infer(job());
    const first = f.requests.at(-1).body;
    const next = context();
    next.messages.push(
      {
        role: "assistant",
        api: "red-subscription",
        provider: "red-subscription",
        model: "gpt-6.1-sol",
        stopReason: "toolUse",
        timestamp: 333,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        content: [
          {
            type: "toolCall",
            id: "synthetic-tool-call",
            name: "inspect",
            arguments: { value: "fixture" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "synthetic-tool-call",
        toolName: "inspect",
        content: [{ type: "text", text: "Synthetic tool result" }],
        isError: false,
        timestamp: 444,
      },
    );
    await f.manager.infer(
      job(undefined, { id: "tool-round-job", context: next }),
    );
    const round = f.requests.at(-1).body;
    assert.equal(round.prompt_cache_key, first.prompt_cache_key);
    assert.deepEqual(round.input.slice(0, first.input.length), first.input);
    assert.ok(round.input.some((item) => item.type === "function_call_output"));
    await f.manager.infer(
      job(undefined, {
        id: "summary-job",
        summary: true,
        cache: { version: 1, namespace: SCOPE, purpose: "summary" },
        context: summaryContext({
          context: "Compact fixture.",
          source: "Source fixture.",
        }),
      }),
    );
    assert.notEqual(
      f.requests.at(-1).body.prompt_cache_key,
      first.prompt_cache_key,
    );
  } finally {
    await f.manager.close();
  }
});
