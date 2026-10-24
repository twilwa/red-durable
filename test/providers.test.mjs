import assert from "node:assert/strict";
import test from "node:test";
import {
  createProviderManager,
  sanitizeProviderError,
  chatGPTPayload,
} from "../bridge/providers.mjs";

// All tokens, model replies, and provider requests in this file are synthetic.
// No test signs in, calls a real model, or verifies live provider entitlement.
const HOST = "9da7c34c-dca0-4799-8262-d8cf4260ed1a";
const NOW = 1800000000000;
const KEY = "synthetic-key-never-a-real-secret";
const OAUTH = {
  type: "oauth",
  access: "synthetic-access",
  refresh: "synthetic-refresh",
  expires: NOW + 3600000,
  clientId: "synthetic-client",
  subject: "synthetic-subject",
  scopes: ["chatgpt.tokens.use.direct"],
};
const model = (id, provider, api = "openai-responses") => ({
  id,
  name: id,
  provider,
  api,
  baseUrl: "https://wrong-fixture-endpoint.invalid",
  input: ["text"],
  type: "chat",
  reasoning: true,
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });
function fixture(options = {}) {
  const credentials = new Map(Object.entries(options.credentials ?? {}));
  const files = new Map();
  const fetches = [];
  const calls = [];
  let now = NOW;
  let gate = Promise.resolve();
  const store = {
    hostId: HOST,
    read: async (name) => files.get(name),
    write: async (name, value) => {
      files.set(name, structuredClone(value));
    },
    credentials: {
      read: async (id) => {
        await options.beforeRead?.(id);
        if (options.readError) throw options.readError;
        return credentials.get(id);
      },
      list: async () =>
        [...credentials].map(([providerId, value]) => ({
          providerId,
          type: value.type,
        })),
      modify: (id, fn) => {
        const result = gate.then(async () => {
          const next = await fn(credentials.get(id));
          if (next !== undefined) {
            await options.beforeCommit?.(id, next);
            credentials.set(id, next);
          }
          return credentials.get(id);
        });
        gate = result.catch(() => {});
        return result;
      },
      delete: (id) => {
        const result = gate.then(() => {
          credentials.delete(id);
        });
        gate = result.catch(() => {});
        return result;
      },
    },
  };
  const providerModels = {
    openai: [model("gpt-5.4", "openai"), model("hidden-model", "openai")],
    openrouter: [
      model("vendor/tool-model", "openrouter", "openai-completions"),
      model("vendor/text-only", "openrouter", "openai-completions"),
    ],
    opencode: [
      model("gpt-5.4", "opencode"),
      model("claude-sonnet-4-6", "opencode", "anthropic-messages"),
      model("gemini-3.5-flash", "opencode", "google-generative-ai"),
      model("mystery-preview-free", "opencode"),
    ],
    "kimi-code": [model("k3.1-pro", "kimi-code")],
    ...options.providerModels,
  };
  const providers = Object.entries(providerModels).map(([id, list]) => ({
    id,
    auth:
      id === "openai"
        ? { oauth: { login: options.login ?? (async () => OAUTH) } }
        : {},
    getModels: () => list,
  }));
  let modelOptions;
  const manager = createProviderManager({
    store,
    providers,
    clock: () => now,
    loginTimeoutMs: options.loginTimeoutMs ?? 600000,
    modelsFactory: (config) => {
      modelOptions = config;
      const registered = new Map();
      return {
        setProvider: (provider) => registered.set(provider.id, provider),
        getProvider: (id) => registered.get(id),
        getModel: (id, name) =>
          registered
            .get(id)
            ?.getModels()
            .find((value) => value.id === name),
        getAuth: async (id) => {
          if (options.authError) throw options.authError;
          const credential = await config.credentials.read(id);
          return credential
            ? { auth: { apiKey: credential.access ?? credential.key } }
            : undefined;
        },
        completeSimple: async (chosen, context, callOptions) => {
          const credential = await config.credentials.read(chosen.provider);
          calls.push({
            model: chosen,
            context,
            options: callOptions,
            credential,
          });
          if (options.complete)
            return options.complete(chosen, context, callOptions);
          return {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "fake-call",
                name: "inspect",
                arguments: { value: 1 },
              },
            ],
            stopReason: "toolUse",
            model: chosen.id,
            provider: chosen.provider,
          };
        },
      };
    },
    fetcher: async (url, init) => {
      fetches.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      if (url.endsWith("/key")) return json({ data: { limit: 5 } });
      if (url.includes("api.openai.com"))
        return json({
          models: [
            { slug: "gpt-5.4", visibility: "list" },
            { slug: "hidden-model", visibility: "hide" },
            { slug: "unknown", visibility: "list" },
          ],
        });
      if (url.includes("api.kimi.ai"))
        return json({ data: [{ id: "k3.1-pro", supports_tool_use: true }] });
      if (url.includes("openrouter"))
        return json({
          data: [
            { id: "vendor/tool-model", supported_parameters: ["tools"] },
            { id: "vendor/text-only", supported_parameters: ["temperature"] },
            { id: "unknown", supported_parameters: ["tools"] },
          ],
        });
      return json({
        data: providerModels.opencode.map((value) => ({ id: value.id })),
      });
    },
  });
  return {
    store,
    manager,
    credentials,
    files,
    fetches,
    calls,
    modelOptions,
    setNow: (value) => {
      now = value;
    },
  };
}
function job(modelId = "gpt-5.4") {
  return {
    id: "synthetic-job",
    leaseToken: "synthetic-lease",
    modelId,
    expiresAt: NOW + 60000,
    context: {
      messages: [],
      tools: [
        {
          name: "inspect",
          description: "Synthetic fixture",
          parameters: { type: "object" },
        },
      ],
    },
    options: { reasoning: "low", maxTokens: 1000 },
  };
}
async function loginDone(manager) {
  for (let i = 0; i < 20; i++) {
    await tick();
    const state = await manager.status();
    if (
      ["connected", "error", "cancelled", "expired"].includes(
        state.flow?.status,
      )
    )
      return state;
  }
  throw new Error("Synthetic login did not settle");
}

test("provider setup starts disconnected and does not read ambient credentials or fetch", async () => {
  const f = fixture();
  const status = await f.manager.status();
  assert.equal(status.providers.length, 5);
  assert(status.providers.every((entry) => !entry.connected));
  assert.equal(status.providers[4].status, "disabled");
  assert.equal(status.flow, null);
  assert.equal(
    await f.modelOptions.authContext.env("OPENAI_API_KEY"),
    undefined,
  );
  assert.equal(
    await f.modelOptions.authContext.fileExists("~/.config/secret"),
    false,
  );
  assert.deepEqual(await f.manager.catalog(), []);
  assert.equal(f.fetches.length, 0);
  await f.manager.close();
});

test("catalog intersects known tool models, scopes IDs, uses fixed URLs and stays cached", async () => {
  const f = fixture({
    credentials: {
      openai: OAUTH,
      openrouter: { type: "api_key", key: KEY },
      "opencode-zen": { type: "api_key", key: KEY },
    },
  });
  const ids = await f.manager.catalog();
  assert.deepEqual(ids, [
    "gpt-5.4",
    "openrouter::vendor/tool-model",
    "opencode-zen::gpt-5.4",
    "opencode-zen::claude-sonnet-4-6",
  ]);
  const count = f.fetches.length;
  await f.manager.catalog();
  assert.equal(f.fetches.length, count);
  assert(
    f.fetches.every(
      ({ init }) =>
        init.redirect === "error" && init.signal instanceof AbortSignal,
    ),
  );
  const zen = f.fetches.find(({ url }) => url.includes("opencode.ai"));
  assert.equal(zen.url, "https://opencode.ai/inference/v1/models");
  assert.equal(zen.init.headers.Authorization, undefined);
  const status = await f.manager.status();
  assert.equal(status.providers[0].status, "connected");
  assert.equal(status.providers[2].status, "unverified");
  assert(!JSON.stringify(status).includes(KEY));
  assert(!JSON.stringify(status).includes(OAUTH.access));
  f.setNow(NOW + 300001);
  await f.manager.catalog();
  assert(f.fetches.length > count);
  await f.manager.close();
});

test("total advertised model count is capped at 200 across providers", async () => {
  const list = Array.from({ length: 250 }, (_, i) =>
    model(`vendor/model-${i}`, "openrouter", "openai-completions"),
  );
  const f = fixture({
    credentials: { openai: OAUTH, openrouter: { type: "api_key", key: KEY } },
    providerModels: { openrouter: list },
    fetch: (url) =>
      url.endsWith("/key")
        ? json({ data: {} })
        : url.includes("openai.com")
          ? json({ models: [{ slug: "gpt-5.4", visibility: "list" }] })
          : json({
              data: list.map(({ id }) => ({
                id,
                supported_parameters: ["tools"],
              })),
            }),
  });
  assert.equal((await f.manager.catalog()).length, 200);
  assert.equal(
    (await f.manager.status()).providers.reduce(
      (n, p) => n + p.models.length,
      0,
    ),
    200,
  );
  await f.manager.close();
});

test("key connect validates OpenRouter read-only and rejects invalid replacement without storing", async () => {
  const f = fixture({
    credentials: { openrouter: { type: "api_key", key: KEY } },
    fetch: () => json({ error: `401 ${KEY}` }, 401),
  });
  await assert.rejects(
    f.manager.connectKey("openrouter", "synthetic-replacement"),
    (error) => error.code === "auth" && !error.message.includes(KEY),
  );
  assert.equal(f.credentials.get("openrouter").key, KEY);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.manager.connectKey("openai", KEY));
  await assert.rejects(f.manager.connectKey("opencode-go", KEY));
  await assert.rejects(f.manager.connectKey("openrouter", "bad\nkey"));
  await f.manager.close();
});

test("Zen key save does not infer or send the key to a public catalog", async () => {
  const f = fixture();
  await f.manager.connectKey("opencode-zen", KEY);
  assert.deepEqual(f.credentials.get("opencode-zen"), {
    type: "api_key",
    key: KEY,
  });
  assert.equal(f.calls.length, 0);
  assert(f.fetches.every(({ init }) => !init.headers.Authorization));
  assert.equal((await f.manager.status()).providers[2].status, "unverified");
  await f.manager.disconnect("opencode-zen");
  assert.equal(f.credentials.has("opencode-zen"), false);
  assert.deepEqual(await f.manager.catalog(), []);
  await f.manager.close();
});

test("OAuth flow is immediate, idempotent, manual-code capable, and only persists validated output", async () => {
  let interaction;
  const f = fixture({
    login: async (value, options) => {
      interaction = value;
      assert.equal(options.getDeviceId(), HOST);
      value.notify({
        type: "auth_url",
        url: "https://auth.openai.com/api/accounts/authorize?state=synthetic-state",
      });
      assert.equal(
        await value.prompt({
          type: "manual_code",
          message: "Raw provider text is not displayed",
        }),
        "http://127.0.0.1:1455/auth/callback?code=synthetic",
      );
      return OAUTH;
    },
  });
  const flow = await f.manager.startLogin();
  await tick();
  assert.equal((await f.manager.status()).flow.status, "waiting");
  assert.equal((await f.manager.startLogin()).id, flow.id);
  assert.equal((await f.manager.status()).flow.prompt.type, "manual_code");
  await assert.rejects(f.manager.respondLogin("wrong", "callback"));
  await f.manager.respondLogin(
    flow.id,
    "http://127.0.0.1:1455/auth/callback?code=synthetic",
  );
  const status = await loginDone(f.manager);
  assert.equal(status.flow.status, "connected");
  assert.equal(status.flow.url, undefined);
  assert.equal(status.flow.prompt, undefined);
  assert.deepEqual(f.credentials.get("openai"), OAUTH);
  assert.deepEqual(f.files.get("openai-registration.json"), {
    clientId: OAUTH.clientId,
    subject: OAUTH.subject,
  });
  assert(!JSON.stringify(status).includes("synthetic-access"));
  assert.equal(interaction.signal.aborted, true);
  await assert.rejects(
    f.manager.startLogin(),
    (error) => error.code === "busy",
  );
  await f.manager.disconnect("openai");
  assert(f.files.has("openai-registration.json"));
  await f.manager.close();
});

test("cancel without an ID suppresses a provider's late ignored-abort credential", async () => {
  const delayed = deferred();
  const f = fixture({ login: async () => delayed.promise });
  const first = await f.manager.startLogin();
  assert.equal(first.status, "starting");
  await f.manager.cancelLogin();
  delayed.resolve(OAUTH);
  await tick();
  assert.equal(f.credentials.has("openai"), false);
  assert.equal((await f.manager.status()).flow.status, "cancelled");
  assert.equal(f.files.has("openai-registration.json"), false);
  await f.manager.close();
});

test("cancel during atomic credential commit serializes deletion and blocks a competing login", async () => {
  const committing = deferred();
  const finish = deferred();
  const f = fixture({
    beforeCommit: async () => {
      committing.resolve();
      await finish.promise;
    },
  });
  await f.manager.startLogin();
  await committing.promise;
  const cancel = f.manager.cancelLogin();
  await assert.rejects(
    f.manager.startLogin(),
    (error) => error.code === "busy",
  );
  finish.resolve();
  await cancel;
  assert.equal(f.credentials.has("openai"), false);
  assert.equal((await f.manager.status()).flow.status, "cancelled");
  await f.manager.close();
});

test("OAuth timeout and rejected authorization expose no provider text or secret", async () => {
  const f = fixture({
    login: async (interaction) =>
      interaction.prompt({ type: "manual_code", message: KEY }),
  });
  await f.manager.startLogin();
  f.setNow(NOW + 600001);
  assert.equal((await f.manager.status()).flow.status, "expired");
  await tick();
  assert.equal(f.credentials.has("openai"), false);
  assert(!JSON.stringify(await f.manager.status()).includes(KEY));
  await f.manager.close();
  const g = fixture({
    login: async () => {
      throw new Error(`OAuth failed with ${KEY}`);
    },
  });
  await g.manager.startLogin();
  const status = await loginDone(g.manager);
  assert.equal(status.flow.status, "error");
  assert(!JSON.stringify(status).includes(KEY));
  await g.manager.close();
});

test("untrusted OAuth links and non-manual prompts cannot escape through setup status", async () => {
  const f = fixture({
    login: async (interaction) => {
      interaction.notify({
        type: "auth_url",
        url: "https://evil.example/auth?token=secret",
      });
      return OAUTH;
    },
  });
  await f.manager.startLogin();
  const status = await loginDone(f.manager);
  assert.equal(status.flow.status, "error");
  assert.equal(status.flow.url, undefined);
  assert.equal(f.credentials.size, 0);
  await f.manager.close();
});

test("exact selected provider handles tool calls, options, deadlines and qualified model IDs", async () => {
  const f = fixture({
    credentials: {
      openrouter: { type: "api_key", key: KEY },
      "opencode-zen": { type: "api_key", key: KEY },
    },
  });
  const output = await f.manager.infer(job("openrouter::vendor/tool-model"));
  assert.equal(output.stopReason, "toolUse");
  assert.deepEqual(output.content[0].arguments, { value: 1 });
  assert.equal(f.calls[0].model.provider, "openrouter");
  assert.equal(f.calls[0].options.maxTokens, 1000);
  assert.equal(f.calls[0].options.reasoning, "low");
  assert.match(f.calls[0].options.sessionId, /^red-v1-[0-9a-f]{56}$/);
  assert.equal(f.calls[0].options.cacheRetention, "none");
  assert.equal(
    f.calls[0].model.compat.openRouterRouting.allow_fallbacks,
    false,
  );
  assert(f.calls[0].options.signal instanceof AbortSignal);
  assert.equal(f.calls[0].context.tools[0].name, "inspect");
  await f.manager.infer(job("opencode-zen::gpt-5.4"));
  assert.equal(f.calls[1].model.provider, "opencode");
  assert.equal(f.calls[1].credential.key, KEY);
  assert.equal(
    f.calls[1].model.baseUrl,
    "https://opencode.ai/inference/openai/v1",
  );
  await f.manager.infer(job("opencode-zen::claude-sonnet-4-6"));
  assert.equal(
    f.calls[2].model.baseUrl,
    "https://opencode.ai/inference/anthropic",
  );
  await assert.rejects(
    f.manager.infer(job("opencode-zen::gemini-3.5-flash")),
    (error) => error.kind === "model",
  );
  assert.equal((await f.manager.status()).providers[2].status, "connected");
  await assert.rejects(
    f.manager.infer(job("gpt-5.4")),
    (error) => error.kind === "model",
  );
  assert.equal(f.calls.length, 3);
  await f.manager.close();
});

test("inference does not accept job-supplied auth, URLs, or unsupported options", async () => {
  const f = fixture({ credentials: { openai: OAUTH } });
  for (const injected of [
    { apiKey: KEY },
    { baseUrl: "https://evil.example" },
    { headers: { Authorization: KEY } },
    { maxTokens: 99999 },
  ]) {
    await assert.rejects(
      f.manager.infer({ ...job(), options: injected }),
      (error) => error.code === "invalid",
    );
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.fetches.length, 0);
  await f.manager.close();
});

test("credential mutations and refresh are rejected while inference is active", async () => {
  const entered = deferred();
  const finish = deferred();
  const f = fixture({
    credentials: { openai: OAUTH },
    complete: async () => {
      entered.resolve();
      return finish.promise;
    },
  });
  const infer = f.manager.infer(job());
  await entered.promise;
  await assert.rejects(
    f.manager.disconnect("openai"),
    (error) => error.code === "busy",
  );
  await assert.rejects(
    f.manager.connectKey("openrouter", KEY),
    (error) => error.code === "busy",
  );
  await assert.rejects(f.manager.refresh(), (error) => error.code === "busy");
  finish.resolve({ role: "assistant", content: [], stopReason: "stop" });
  await infer;
  await f.manager.disconnect("openai");
  await f.manager.close();
});

test("quota and auth failures are sanitized and never fall back to another configured provider", async () => {
  for (const raw of [`429 quota ${KEY}`, `401 invalid credential ${KEY}`]) {
    const f = fixture({
      credentials: { openai: OAUTH, openrouter: { type: "api_key", key: KEY } },
      complete: async () => ({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: raw,
      }),
    });
    await assert.rejects(
      f.manager.infer(job()),
      (error) =>
        !error.message.includes(KEY) && ["quota", "auth"].includes(error.kind),
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].model.provider, "openai");
    const status = await f.manager.status();
    assert(!JSON.stringify(status).includes(KEY));
    assert.equal(status.providers[0].models.length, 0);
    assert.deepEqual(await f.manager.catalog(), [
      "openrouter::vendor/tool-model",
    ]);
    await f.manager.close();
  }
});

test("catalog and credential-store errors remain bounded, fail closed, and suppress raw text", async () => {
  const f = fixture({
    credentials: { openai: OAUTH },
    authError: new Error(`refresh token ${KEY}`),
  });
  assert.deepEqual(await f.manager.catalog(), []);
  assert.equal((await f.manager.status()).providers[0].status, "auth_error");
  assert.equal(f.fetches.length, 0);
  await f.manager.close();
  const recovery = new Error(KEY);
  recovery.code = "CREDENTIAL_RECOVERY_REQUIRED";
  const safe = sanitizeProviderError({ cause: recovery, message: KEY });
  assert.equal(safe.code, "CREDENTIAL_RECOVERY_REQUIRED");
  assert(!safe.message.includes(KEY));
  const g = fixture({
    credentials: { openai: OAUTH },
    fetch: () => json({ models: "malformed" }),
  });
  assert.deepEqual(await g.manager.catalog(), []);
  await g.manager.close();
});

test("close cancels OAuth and rejects all later setup/inference operations", async () => {
  const f = fixture({
    login: async (interaction) =>
      interaction.prompt({ type: "manual_code", message: "Synthetic" }),
  });
  await f.manager.startLogin();
  await f.manager.close();
  await f.manager.close();
  await assert.rejects(f.manager.status(), (error) => error.code === "closed");
  await assert.rejects(
    f.manager.startLogin(),
    (error) => error.code === "closed",
  );
  assert.equal(f.credentials.size, 0);
});

test("cancel during initial credential read prevents later OAuth start", async () => {
  const reading = deferred();
  const finish = deferred();
  let started = 0;
  const f = fixture({
    beforeRead: async () => {
      reading.resolve();
      await finish.promise;
    },
    login: async () => {
      started++;
      return OAUTH;
    },
  });
  const flow = await f.manager.startLogin();
  assert.equal(flow.status, "starting");
  await reading.promise;
  await f.manager.cancelLogin(null);
  finish.resolve();
  await tick();
  assert.equal(started, 0);
  assert.equal(f.credentials.size, 0);
  assert.equal((await f.manager.status()).flow.status, "cancelled");
  await f.manager.close();
});

function toolSse() {
  const item = {
    type: "function_call",
    id: "fc_synthetic",
    call_id: "call_synthetic",
    name: "inspect",
    arguments: '{"value":1}',
  };
  const events = [
    { type: "response.created", response: { id: "resp_synthetic" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      delta: '{"value":1}',
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_synthetic",
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("real pinned Pi builds compliant SIWC payloads and parses streamed function calls", async () => {
  const f = fixture({
    credentials: { openai: { ...OAUTH, expires: Date.now() + 3600000 } },
  });
  await f.manager.close();
  const requests = [];
  const manager = createProviderManager({
    store: f.store,
    fetcher: async (url, init) => {
      if (String(url).endsWith("/models"))
        return json({
          models: ["gpt-6.1-sol", "gpt-4o"].map((slug) => ({
            slug,
            visibility: "list",
          })),
        });
      requests.push({ url: String(url), init, payload: JSON.parse(init.body) });
      return toolSse();
    },
  });
  try {
    for (const modelId of ["gpt-6.1-sol", "gpt-4o"]) {
      const context = {
        ...job().context,
        systemPrompt: "Synthetic system instruction",
        messages: [
          {
            role: "user",
            content: "Use the fixture tool.",
            timestamp: Date.now(),
          },
        ],
      };
      const output = await manager.infer({
        ...job(modelId),
        expiresAt: Date.now() + 60000,
        context,
      });
      assert.equal(output.stopReason, "toolUse");
      assert.deepEqual(output.content[0].arguments, { value: 1 });
      assert.equal(output.content[0].name, "inspect");
      const request = requests.at(-1);
      assert.equal(request.url, "https://api.openai.com/v1/responses");
      assert.equal(request.init.redirect, "error");
      assert.equal(request.payload.stream, true);
      assert.equal(request.payload.store, false);
      assert.equal(request.payload.max_output_tokens, undefined);
      assert.equal(request.payload.tools, undefined);
      assert.equal(request.payload.input[0].type, "additional_tools");
      assert.equal(request.payload.input[0].tools[0].name, "inspect");
      assert(request.payload.input.every((item) => item.role !== "system"));
      assert(!JSON.stringify(request.payload).includes("tool_search"));
      const followup = {
        ...context,
        messages: [
          ...context.messages,
          {
            ...output,
            provider: "red-subscription",
            api: "red-subscription",
            model: modelId,
          },
          {
            role: "toolResult",
            toolCallId: output.content[0].id,
            toolName: "inspect",
            content: [{ type: "text", text: "Synthetic tool output" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      };
      await manager.infer({
        ...job(modelId),
        expiresAt: Date.now() + 60000,
        context: followup,
      });
      const input = requests.at(-1).payload.input;
      assert(
        input.some(
          (item) => item.type === "function_call" && item.name === "inspect",
        ),
      );
      assert(
        input.some(
          (item) =>
            item.type === "function_call_output" &&
            item.output.includes("Synthetic tool output"),
        ),
      );
    }
    assert.equal(requests.length, 4);
  } finally {
    await manager.close();
  }
});

test("SIWC adapter preserves later tool additions and rejects hosted or tool-search execution", () => {
  const tool = {
    type: "function",
    name: "inspect",
    parameters: { type: "object" },
  };
  const later = {
    type: "additional_tools",
    role: "developer",
    tools: [{ ...tool, name: "later" }],
  };
  const payload = chatGPTPayload({
    input: [{ role: "system", type: "message", content: "Synthetic" }, later],
    tools: [tool],
    temperature: 1,
    max_output_tokens: 10,
    previous_response_id: "old",
  });
  assert.equal(payload.input[0].tools[0].name, "inspect");
  assert.equal(payload.input[1].role, "developer");
  assert.deepEqual(payload.input[2], later);
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.previous_response_id, undefined);
  for (const type of [
    "web_search",
    "file_search",
    "code_interpreter",
    "tool_search",
    "programmatic_tool_calling",
  ])
    assert.throws(() => chatGPTPayload({ input: [], tools: [{ type }] }));
  assert.throws(() =>
    chatGPTPayload({ input: [{ type: "tool_search_call" }] }),
  );
});

test("real pinned Pi uses current fixed Zen endpoints and bearer auth without retry or cross-provider fallback", async () => {
  for (const [modelId, expectedUrl] of [
    ["gpt-5.4", "https://opencode.ai/inference/openai/v1/responses"],
    [
      "claude-sonnet-4-6",
      "https://opencode.ai/inference/anthropic/v1/messages",
    ],
  ]) {
    const f = fixture({
      credentials: { "opencode-zen": { type: "api_key", key: KEY } },
    });
    await f.manager.close();
    const requests = [];
    const manager = createProviderManager({
      store: f.store,
      fetcher: async (url, init) => {
        if (String(url).endsWith("/models"))
          return json({ data: [{ id: modelId }] });
        requests.push({
          url: String(url),
          init,
          payload: JSON.parse(init.body),
        });
        return json(
          { error: { message: `Synthetic authorization rejection ${KEY}` } },
          401,
        );
      },
    });
    try {
      await assert.rejects(
        manager.infer({
          ...job(`opencode-zen::${modelId}`),
          expiresAt: Date.now() + 60000,
        }),
        (error) => error.kind === "auth" && !error.message.includes(KEY),
      );
      assert.equal(requests.length, 1);
      const actualUrl = new URL(requests[0].url);
      assert.equal(actualUrl.origin + actualUrl.pathname, expectedUrl);
      assert(
        [...actualUrl.searchParams.keys()].every((name) => name === "beta"),
      );
      assert.equal(
        new Headers(requests[0].init.headers).get("authorization"),
        `Bearer ${KEY}`,
      );
      assert.equal(requests[0].init.redirect, "error");
      assert.equal(requests[0].payload.model, modelId);
      assert(
        requests[0].payload.tools.some(
          (tool) => (tool.name ?? tool.function?.name) === "inspect",
        ),
      );
    } finally {
      await manager.close();
    }
  }
});

test("inference transport rejects registry drift to an unapproved origin, path, or query", async () => {
  for (const url of [
    "https://evil.example/responses",
    "https://api.openai.com/v1/other",
    "https://api.openai.com/v1/responses?token=synthetic",
  ]) {
    const f = fixture({
      credentials: { openai: OAUTH },
      complete: async (_model, _context, options) =>
        options.fetch(url, { method: "POST" }),
    });
    await assert.rejects(
      f.manager.infer(job()),
      (error) => error.kind === "model",
    );
    assert(f.fetches.every((request) => request.url.endsWith("/models")));
    await f.manager.close();
  }
});

test("closing during key validation waits for mutation and does not save a late key", async () => {
  const entered = deferred();
  const finish = deferred();
  const f = fixture({
    fetch: async () => {
      entered.resolve();
      await finish.promise;
      return json({ data: {} });
    },
  });
  const connect = f.manager.connectKey("openrouter", KEY);
  await entered.promise;
  let closed = false;
  const closing = f.manager.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  finish.resolve();
  await assert.rejects(connect, (error) => error.code === "closed");
  await closing;
  assert.equal(f.credentials.size, 0);
});

test("legacy unverified ChatGPT credential is removable without refresh or a recovery marker", async () => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { openStore } = await import("../bridge/store.mjs");
  const directory = await mkdtemp(join(tmpdir(), "red-provider-legacy-"));
  const store = await openStore(directory);
  const { subject: _subject, ...legacy } = {
    ...OAUTH,
    expires: Date.now() - 1000,
  };
  await store.credentials.modify("openai", async () => legacy);
  let requests = 0;
  const manager = createProviderManager({
    store,
    fetcher: async () => {
      requests++;
      throw new Error("Synthetic unexpected request");
    },
  });
  try {
    assert.deepEqual(await manager.catalog(), []);
    const status = await manager.status();
    assert.equal(status.providers[0].connected, true);
    assert.equal(status.providers[0].status, "auth_error");
    assert.equal(requests, 0);
    await assert.rejects(
      readFile(join(directory, "credential-update.json")),
      (error) => error.code === "ENOENT",
    );
    await manager.disconnect("openai");
    assert.equal(await store.credentials.read("openai"), undefined);
  } finally {
    await manager.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a large aggregator catalog cannot hide another connected provider", async () => {
  const list = Array.from({ length: 230 }, (_, i) =>
    model(`vendor/model-${i}`, "openrouter", "openai-completions"),
  );
  const f = fixture({
    credentials: {
      openai: OAUTH,
      openrouter: { type: "api_key", key: KEY },
      "opencode-zen": { type: "api_key", key: KEY },
    },
    providerModels: { openrouter: list },
    fetch: (url) => {
      if (url.endsWith("/key")) return json({ data: {} });
      if (url.includes("api.openai.com"))
        return json({ models: [{ slug: "gpt-5.4", visibility: "list" }] });
      if (url.includes("opencode.ai"))
        return json({ data: [{ id: "gpt-5.4" }, { id: "claude-sonnet-4-6" }] });
      return json({
        data: list.map(({ id }) => ({ id, supported_parameters: ["tools"] })),
      });
    },
  });
  const ids = await f.manager.catalog();
  assert.equal(ids.length, 200);
  assert(ids.includes("gpt-5.4"));
  assert(ids.includes("opencode-zen::gpt-5.4"));
  assert(ids.includes("opencode-zen::claude-sonnet-4-6"));
  assert.equal((await f.manager.status()).providers[2].models.length, 2);
  await f.manager.close();
});

test("ambient SDK debug settings cannot log provider bodies or forward unrelated account headers", async () => {
  const previousOpenAILog = process.env.OPENAI_LOG;
  const previousAnthropicLog = process.env.ANTHROPIC_LOG;
  const captured = [];
  const original = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((name) => [name, console[name]]),
  );
  for (const name of Object.keys(original))
    console[name] = (...values) => captured.push(values);
  try {
    for (const modelId of ["gpt-5.4", "claude-sonnet-4-6"]) {
      const f = fixture({
        credentials: { "opencode-zen": { type: "api_key", key: KEY } },
      });
      await f.manager.close();
      const requests = [];
      const manager = createProviderManager({
        store: f.store,
        fetcher: async (url, init) => {
          if (String(url).endsWith("/models"))
            return json({ data: [{ id: modelId }] });
          requests.push(init);
          return json(
            { error: { message: `Synthetic response echo ${KEY}` } },
            401,
          );
        },
      });
      // Flip these after construction as well: inference must enforce the policy
      // immediately before Pi lazily constructs either provider SDK client.
      process.env.OPENAI_LOG = "debug";
      process.env.ANTHROPIC_LOG = "debug";
      process.env.OPENAI_ORG_ID = "synthetic-unrelated-org";
      process.env.OPENAI_PROJECT_ID = "synthetic-unrelated-project";
      process.env.OPENAI_CUSTOM_HEADERS =
        "x-openai-foreign-secret: synthetic-ambient-secret";
      process.env.ANTHROPIC_CUSTOM_HEADERS =
        "x-foreign-secret: synthetic-ambient-secret";
      try {
        await assert.rejects(
          manager.infer({
            ...job(`opencode-zen::${modelId}`),
            expiresAt: Date.now() + 60000,
          }),
        );
        assert.equal(requests.length, 1);
        const headers = new Headers(requests[0].headers);
        assert.equal(headers.get("openai-organization"), null);
        assert.equal(headers.get("openai-project"), null);
        assert.equal(headers.get("x-foreign-secret"), null);
        assert.equal(headers.get("x-openai-foreign-secret"), null);
      } finally {
        await manager.close();
      }
    }
    assert.deepEqual(captured, []);
  } finally {
    for (const [name, fn] of Object.entries(original)) console[name] = fn;
    if (previousOpenAILog === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previousOpenAILog;
    if (previousAnthropicLog === undefined) delete process.env.ANTHROPIC_LOG;
    else process.env.ANTHROPIC_LOG = previousAnthropicLog;
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    delete process.env.OPENAI_CUSTOM_HEADERS;
  }
});

test("Kimi key validates only its fixed authenticated catalog and advertises exact K3.1 Pro", async () => {
  const f = fixture();
  await f.manager.connectKey("kimi-code", KEY);
  assert.deepEqual(await f.manager.catalog(), ["kimi-code::k3.1-pro"]);
  assert.equal(f.credentials.get("kimi-code").type, "api_key");
  assert.equal(f.calls.length, 0);
  for (const request of f.fetches) {
    assert.equal(request.url, "https://api.kimi.ai/coding/v1/models");
    assert.equal(request.init.headers.Authorization, `Bearer ${KEY}`);
    assert.match(request.init.headers["User-Agent"], /^red-durable\/0\.1\.0 /);
    assert.equal(request.init.redirect, "error");
  }
  const status = await f.manager.status();
  const kimi = status.providers.find(({ id }) => id === "kimi-code");
  assert.equal(kimi.status, "connected");
  assert.match(kimi.message, /membership allowance/);
  assert(!JSON.stringify(status).includes(KEY));
  await assert.rejects(f.manager.startLogin("kimi-code"));
  await f.manager.disconnect("kimi-code");
  assert(!f.credentials.has("kimi-code"));
  await f.manager.close();
});

test("Kimi key rejection and missing K3.1 entitlement never select another model", async () => {
  const rejected = fixture({ fetch: async () => json({ error: KEY }, 401) });
  await assert.rejects(
    rejected.manager.connectKey("kimi-code", KEY),
    /authentication/,
  );
  assert(!rejected.credentials.has("kimi-code"));
  await rejected.manager.close();
  const missing = fixture({
    credentials: { "kimi-code": { type: "api_key", key: KEY } },
    fetch: async () =>
      json({ data: [{ id: "kimi-for-coding" }, { id: "k3" }] }),
  });
  assert.deepEqual(await missing.manager.catalog(), []);
  await assert.rejects(
    missing.manager.infer(job("kimi-code::k3.1-pro")),
    /unavailable/,
  );
  assert.equal(missing.calls.length, 0);
  await missing.manager.close();
});

test("real pinned Pi sends Kimi Responses with mandatory thinking and truthful identity", async () => {
  const f = fixture({
    credentials: { "kimi-code": { type: "api_key", key: KEY } },
  });
  await f.manager.close();
  const requests = [];
  const manager = createProviderManager({
    store: f.store,
    clock: () => NOW,
    fetcher: async (url, init) => {
      if (String(url).endsWith("/models"))
        return json({ data: [{ id: "k3.1-pro" }] });
      requests.push({ url: String(url), init, payload: JSON.parse(init.body) });
      const response = toolSse();
      const text = await response.text();
      const reasoning = {
        type: "reasoning",
        id: "rs_kimi_fixture",
        encrypted_content: "synthetic-private-kimi-state",
        summary: [],
      };
      const added = {
        type: "response.output_item.added",
        output_index: 1,
        item: reasoning,
      };
      const done = {
        type: "response.output_item.done",
        output_index: 1,
        item: reasoning,
      };
      return new Response(
        text.replace(
          "event: response.completed",
          `event: ${added.type}\ndata: ${JSON.stringify(added)}\n\nevent: ${done.type}\ndata: ${JSON.stringify(done)}\n\nevent: response.completed`,
        ),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const cache = { version: 1, namespace: HOST, purpose: "conversation" };
    const first = await manager.infer({
      ...job("kimi-code::k3.1-pro"),
      cache,
      options: {},
    });
    assert.equal(first.stopReason, "toolUse");
    assert.equal(first.content[0].type, "toolCall");
    const request = requests[0];
    assert.equal(request.url, "https://api.kimi.ai/coding/v1/responses");
    assert.equal(
      new Headers(request.init.headers).get("authorization"),
      `Bearer ${KEY}`,
    );
    assert.match(
      new Headers(request.init.headers).get("user-agent"),
      /^red-durable\/0\.1\.0 /,
    );
    assert.equal(request.payload.model, "k3.1-pro");
    assert.deepEqual(request.payload.reasoning, { effort: "max" });
    assert.equal(request.payload.store, false);
    assert.deepEqual(request.payload.include, ["reasoning.encrypted_content"]);
    assert.equal(request.payload.prompt_cache_key, undefined);
    assert.equal(request.init.redirect, "error");
    // Explicit owner request leaves background summaries on this same route.
    const background = { ...job("kimi-code::k3.1-pro"), summary: true };
    assert(!JSON.stringify(first).includes("synthetic-private-kimi-state"));
    await manager.infer(background);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].payload.model, "k3.1-pro");
    const tool = first.content.find((block) => block.type === "toolCall");
    await manager.infer({
      ...job("kimi-code::k3.1-pro"),
      cache,
      context: {
        messages: [
          {
            ...first,
            provider: "red-subscription",
            api: "red-subscription",
            model: "kimi-code::k3.1-pro",
          },
          {
            role: "toolResult",
            toolCallId: tool.id,
            toolName: tool.name,
            content: [{ type: "text", text: "synthetic tool result" }],
            isError: false,
            timestamp: NOW,
          },
        ],
      },
    });
    assert.equal(requests.length, 3);
    assert(
      requests[2].payload.input.some(
        (item) => item.encrypted_content === "synthetic-private-kimi-state",
      ),
    );
    assert(
      !JSON.stringify([...f.files.values()]).includes(
        "synthetic-private-kimi-state",
      ),
    );
    await assert.rejects(
      manager.infer({ ...background, options: { reasoning: "off" } }),
      /requires thinking/,
    );
    assert.equal(requests.length, 3);
  } finally {
    await manager.close();
  }
});
