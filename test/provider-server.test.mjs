import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startSetupServer } from "../bridge/server.mjs";
const ownerToken = "test-owner-" + "x".repeat(40);
const bridgeToken = "test-bridge-" + "y".repeat(40);
async function fixture() {
  const calls = [],
    upstream = [];
  const manager = Object.fromEntries(
    [
      "connectKey",
      "startLogin",
      "cancelLogin",
      "respondLogin",
      "disconnect",
      "refresh",
    ].map((name) => [
      name,
      async (...args) => {
        calls.push({ name, args });
        return { id: "flow", status: "pending" };
      },
    ]),
  );
  manager.status = async () => ({ providers: [], flow: null });
  const server = await startSetupServer({
    manager,
    upstream: "http://127.0.0.1:8787",
    ownerToken,
    bridgeToken,
    session: "test",
    port: 0,
    fetcher: async (url, options) => {
      upstream.push({ url, options });
      return Response.json({ ok: true });
    },
  });
  const send = async (path, body, headers = {}) =>
    fetch(server.origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Session": "test",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { server, manager, calls, upstream, send };
}
test("local provider setup binds owner, session, origin and exact loopback Host", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send("/api/providers")).status, 200);
    for (const headers of [
      { Authorization: "" },
      { Authorization: `Bearer ${bridgeToken}` },
      { "X-Session": "other" },
      { Origin: "https://evil.test" },
      { "Sec-Fetch-Site": "cross-site" },
      { Origin: "null" },
    ]) {
      assert.ok(
        [401, 403].includes(
          (await f.send("/api/providers", undefined, headers)).status,
        ),
      );
    }
    const response = await new Promise((resolve, reject) => {
      const req = request(
        f.server.origin + "/",
        { headers: { Host: "evil.test" } },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, 403);
    response.resume();
    assert.equal(f.calls.length, 0);
  } finally {
    await f.server.close();
  }
});
test("provider key terminates on host and needs explicit metered save acknowledgement", async () => {
  const f = await fixture();
  const key = "fixture-key-never-real";
  try {
    assert.equal(
      (
        await f.send("/api/providers/key", {
          providerId: "openrouter",
          apiKey: key,
        })
      ).status,
      400,
    );
    const response = await f.send("/api/providers/key", {
      providerId: "openrouter",
      apiKey: key,
      confirm: "STORE_METERED_KEY",
    });
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].name, "connectKey");
    assert.deepEqual(f.calls[0].args, ["openrouter", key]);
    assert.ok(!(await response.text()).includes(key));
    assert.equal(f.upstream.length, 0);
    assert.equal(
      (await f.send("/api/providers/key?apiKey=" + key, {})).status,
      400,
    );
    assert.equal(
      (await f.send("/api/providers/key", {}, { "Content-Type": "text/plain" }))
        .status,
      415,
    );
  } finally {
    await f.server.close();
  }
});
test("loopback proxy preserves narrow owner API and cannot lend transport credentials", async () => {
  const f = await fixture();
  try {
    await f.send("/api/state");
    assert.equal(f.upstream[0].url, "http://127.0.0.1:8787/api/state");
    assert.equal(
      f.upstream[0].options.headers.Authorization,
      `Bearer ${ownerToken}`,
    );
    assert.equal(f.upstream[0].options.headers.Origin, "http://127.0.0.1:8787");
    assert.equal(f.upstream[0].options.redirect, "error");
    for (const route of ["/api/bridge/poll", "/api/discord/ingress"])
      assert.equal((await f.send(route, {})).status, 403);
    assert.equal(f.upstream.length, 1);
    const page = await f.send("/");
    assert.match(
      page.headers.get("content-security-policy"),
      /connect-src 'self'/,
    );
    assert.match(await page.text(), /red/);
    assert.equal((await f.send("/bridge/store.mjs")).status, 404);
  } finally {
    await f.server.close();
  }
});
test("flow lifecycle routes are bounded and sanitized, including cancel before ID arrives", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.send("/api/providers/login", { providerId: "openai" })).status,
      200,
    );
    assert.equal(
      (await f.send("/api/providers/cancel", { id: null })).status,
      200,
    );
    assert.equal(
      (
        await f.send("/api/providers/respond", {
          id: "flow",
          value: "fixture-callback",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.send("/api/providers/disconnect", { providerId: "openai" }))
        .status,
      400,
    );
    await f.send("/api/providers/disconnect", {
      providerId: "openai",
      confirm: "DISCONNECT",
    });
    assert.deepEqual(
      f.calls.map((c) => c.name),
      ["startLogin", "cancelLogin", "respondLogin", "disconnect"],
    );
    f.manager.connectKey = async () => {
      throw Error("fixture-secret-in-exception");
    };
    const response = await f.send("/api/providers/key", {
      providerId: "openrouter",
      apiKey: "fixture",
      confirm: "STORE_METERED_KEY",
    });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("fixture"));
    assert.equal(
      (
        await f.send("/api/providers/login", {
          providerId: "openai",
          padding: "x".repeat(17000),
        })
      ).status,
      400,
    );
  } finally {
    await f.server.close();
  }
});
test("setup refuses owner/bridge credential equality and insecure upstreams", async () => {
  const options = {
    manager: {},
    upstream: "https://example.com",
    ownerToken,
    bridgeToken: ownerToken,
    port: 0,
  };
  await assert.rejects(startSetupServer(options));
  await assert.rejects(
    startSetupServer({
      ...options,
      bridgeToken,
      upstream: "http://remote.test",
    }),
  );
});

test("Kimi key requires subscription storage consent, not metered consent or OAuth", async () => {
  const f = await fixture();
  try {
    for (const confirm of [undefined, "STORE_METERED_KEY"]) {
      assert.equal(
        (
          await f.send("/api/providers/key", {
            providerId: "kimi-code",
            apiKey: "synthetic-kimi-key",
            confirm,
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await f.send("/api/providers/key", {
          providerId: "kimi-code",
          apiKey: "synthetic-kimi-key",
          confirm: "STORE_SUBSCRIPTION_KEY",
        })
      ).status,
      200,
    );
    assert.deepEqual(f.calls[0], {
      name: "connectKey",
      args: ["kimi-code", "synthetic-kimi-key"],
    });
    assert.equal(
      (await f.send("/api/providers/login", { providerId: "kimi-code" }))
        .status,
      400,
    );
    assert.equal(f.upstream.length, 0);
  } finally {
    await f.server.close();
  }
});
