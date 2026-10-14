import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderManager } from "../bridge/providers.mjs";
import { openStore } from "../bridge/store.mjs";
import { startSetupServer } from "../bridge/server.mjs";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { format } from "node:util";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Synthetic local fixtures only: no live credentials, provider fetch or sign-in.
test("cancellation before the login ID arrives cancels the admitted startup", async () => {
  const reading = deferred();
  const release = deferred();
  let firstRead = true;
  let loginCalls = 0;
  const providers = new Map();
  const manager = createProviderManager({
    store: {
      hostId: "12345678-1234-4123-8123-123456789abc",
      credentials: {
        async read() {
          if (firstRead) {
            firstRead = false;
            reading.resolve();
            await release.promise;
          }
          return undefined;
        },
        async list() {
          return [];
        },
      },
    },
    providers: [
      {
        id: "openai",
        auth: {
          oauth: {
            async login({ signal }) {
              loginCalls++;
              return new Promise((resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => reject(new Error("Synthetic cancellation")),
                  { once: true },
                );
              });
            },
          },
        },
      },
    ],
    modelsFactory: () => ({
      setProvider(provider) {
        providers.set(provider.id, provider);
      },
      getProvider(id) {
        return providers.get(id);
      },
    }),
  });
  try {
    const login = manager.startLogin();
    await reading.promise;
    const cancel = manager.cancelLogin(null);
    // Do not leave an intentionally rejected promise unhandled on the old code.
    cancel.catch(() => {});
    release.resolve();
    await Promise.all([login, cancel]);
    assert.equal(loginCalls, 0, "cancelled startup must never launch OAuth");
    assert.equal((await manager.status()).flow?.status, "cancelled");
  } finally {
    release.resolve();
    await manager.close();
  }
});

test("runner recovery check waits for a live credential update instead of stopping the bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "red-review-store-"));
  const store = await openStore(directory);
  const entered = deferred();
  const release = deferred();
  let update;
  try {
    update = store.credentials.modify("openrouter", async () => {
      entered.resolve();
      await release.promise;
      return { type: "api_key", key: "synthetic-review-key" };
    });
    await entered.promise;
    const listed = store.credentials.list();
    listed.catch(() => {});
    // Give the independent list operation time to observe an in-flight marker.
    await new Promise((resolve) => setTimeout(resolve, 25));
    release.resolve();
    await update;
    assert.deepEqual(await listed, [
      { providerId: "openrouter", type: "api_key" },
    ]);
  } finally {
    release.resolve();
    await update;
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy OAuth metadata requires reconnect without manufacturing an uncertain-refresh marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "red-review-legacy-"));
  const store = await openStore(directory);
  let networkCalls = 0;
  let manager;
  try {
    await store.credentials.modify("openai", async () => ({
      type: "oauth",
      access: "synthetic-legacy-access",
      refresh: "synthetic-legacy-refresh",
      clientId: "synthetic-legacy-client",
      expires: 1,
      scopes: ["chatgpt.tokens.use.direct"],
      // Old pinned Pi records had no verified ID-token subject metadata.
    }));
    manager = createProviderManager({
      store,
      fetcher: async () => {
        networkCalls++;
        throw new Error("Unexpected synthetic fixture network request");
      },
    });
    assert.deepEqual(await manager.catalog(), []);
    assert.equal(networkCalls, 0);
    assert.equal(await store.read("credential-update.json"), undefined);
    const openai = (await manager.status()).providers.find(
      ({ id }) => id === "openai",
    );
    assert.equal(
      openai.connected,
      true,
      "stored connection must remain removable",
    );
    assert.equal(openai.status, "auth_error");
    await manager.disconnect("openai");
    assert.equal(await store.credentials.read("openai"), undefined);
  } finally {
    await manager?.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a large OpenRouter catalog cannot make a connected Zen provider disappear", async () => {
  const openrouterModels = openrouterProvider().getModels().slice(0, 200);
  const credentials = new Map([
    ["openrouter", { type: "api_key", key: "synthetic-router-key" }],
    ["opencode-zen", { type: "api_key", key: "synthetic-zen-key" }],
  ]);
  const manager = createProviderManager({
    store: {
      hostId: "12345678-1234-4123-8123-123456789abc",
      read: async () => undefined,
      credentials: {
        read: async (id) => credentials.get(id),
        list: async () => [],
      },
    },
    fetcher: async (url) => {
      if (url === "https://openrouter.ai/api/v1/key")
        return Response.json({ data: {} });
      if (url === "https://openrouter.ai/api/v1/models")
        return Response.json({
          data: openrouterModels.map(({ id }) => ({
            id,
            supported_parameters: ["tools"],
          })),
        });
      assert.equal(url, "https://opencode.ai/inference/v1/models");
      return Response.json({ data: [{ id: "gpt-5.4" }] });
    },
  });
  try {
    const catalog = await manager.catalog();
    assert.ok(catalog.length <= 200);
    assert.ok(catalog.includes("opencode-zen::gpt-5.4"));
    assert.ok(catalog.some((id) => id.startsWith("openrouter::")));
  } finally {
    await manager.close();
  }
});

for (const [sdk, modelId] of [
  ["OPENAI_LOG", "openai/gpt-4.1"],
  ["ANTHROPIC_LOG", "anthropic/claude-sonnet-4.6"],
]) {
  test(`ambient ${sdk} cannot log provider secrets or private request bodies`, async () => {
    const originalLevel = process.env[sdk];
    const originalConsole = Object.fromEntries(
      ["debug", "info", "warn", "error"].map((name) => [name, console[name]]),
    );
    const logs = [];
    const secret = "synthetic-review-provider-secret";
    const privateText = "synthetic-private-conversation-marker";
    let manager;
    try {
      process.env[sdk] = "debug";
      for (const name of Object.keys(originalConsole))
        console[name] = (...args) => logs.push(format(...args));
      manager = createProviderManager({
        store: {
          hostId: "12345678-1234-4123-8123-123456789abc",
          credentials: {
            read: async (id) =>
              id === "openrouter"
                ? { type: "api_key", key: secret }
                : undefined,
            list: async () => [],
          },
        },
        fetcher: async (url) => {
          if (String(url).endsWith("/key")) return Response.json({ data: {} });
          if (String(url).endsWith("/models"))
            return Response.json({
              data: [{ id: modelId, supported_parameters: ["tools"] }],
            });
          return new Response("Provider rejected credential " + secret, {
            status: 401,
          });
        },
      });
      await assert.rejects(
        manager.infer({
          id: "synthetic-review-job",
          leaseToken: "synthetic-lease",
          modelId: `openrouter::${modelId}`,
          expiresAt: Date.now() + 90000,
          context: {
            messages: [
              { role: "user", content: privateText, timestamp: Date.now() },
            ],
          },
        }),
        (error) => !error.message.includes(secret),
      );
      assert.equal(
        logs.some((line) => line.includes(secret)),
        false,
        "SDK logging must not bypass provider error sanitization",
      );
      assert.equal(
        logs.some((line) => line.includes(privateText)),
        false,
        "SDK logging must not expose the conversation body",
      );
    } finally {
      await manager?.close();
      Object.assign(console, originalConsole);
      if (originalLevel === undefined) delete process.env[sdk];
      else process.env[sdk] = originalLevel;
    }
  });
}

async function proxyFixture(fetcher) {
  const ownerToken = "synthetic-owner-" + "x".repeat(40);
  const server = await startSetupServer({
    manager: {},
    upstream: "http://127.0.0.1:8787",
    ownerToken,
    bridgeToken: "synthetic-bridge-" + "y".repeat(40),
    port: 0,
    fetcher,
  });
  return {
    server,
    state: () =>
      fetch(server.origin + "/api/state", {
        headers: { Authorization: `Bearer ${ownerToken}` },
      }),
  };
}

test("setup proxy preserves a legitimate history larger than two megabytes", async () => {
  // Worker state returns up to100 messages, each permitted to contain32KB text.
  const history = Array.from({ length: 100 }, (_, id) => ({
    id,
    kind: "user",
    text: "Synthetic local history. ".padEnd(30000, "x"),
  }));
  const f = await proxyFixture(async () => Response.json({ history }));
  try {
    const response = await f.state();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).history, history);
  } finally {
    await f.server.close();
  }
});

test("setup proxy cancels an oversized response stream before buffering it all", async () => {
  let chunksRead = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(120);
  const f = await proxyFixture(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            // A finite fixture still catches response.text buffering without hanging.
            if (chunksRead === 40) return controller.close();
            chunksRead++;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  try {
    const response = await f.state();
    assert.equal(response.status, 400);
    assert.equal(cancelled, true);
    assert.ok(chunksRead < 40, "stream must stop at the byte cap");
    assert.match((await response.json()).error, /request could not complete/);
  } finally {
    await f.server.close();
  }
});
