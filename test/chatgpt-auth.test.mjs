import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { createChatGPTOAuth } from "../bridge/chatgpt-auth.mjs";

// Synthetic keys, tokens, identities and responses only. No provider request or account sign-in.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "synthetic-key",
  alg: "RS256",
  use: "sig",
};
const NOW = 1800000000000;
const CLIENT = "oaiapp_synthetic";
const SUBJECT = "synthetic-owner";
const DEVICE = "12345678-1234-4123-8123-123456789abc";
const jwt = (claims, header = {}) => {
  const input = [{ alg: "RS256", kid: jwk.kid, ...header }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
};
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
function fixture(options = {}) {
  let authorization;
  const requests = [];
  const abort = new AbortController();
  const getClaims = () => ({
    iss: "https://auth.openai.com",
    aud: CLIENT,
    sub: SUBJECT,
    exp: NOW / 1000 + 3600,
    iat: NOW / 1000,
    nonce: authorization?.searchParams.get("nonce"),
    ...options.claims,
  });
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    assert.equal(init.redirect, "error");
    const override = await options.fetchHook?.({ url, init, abort });
    if (override !== undefined) return override;
    if (url.endsWith("/.well-known/jwks.json"))
      return response({ keys: options.keys ?? [jwk] });
    assert.equal(url, "https://auth.openai.com/api/accounts/oauth/token");
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("resource"), "https://api.openai.com/v1");
    assert.equal(body.has("client_secret"), false);
    assert.equal(body.get("client_id"), CLIENT);
    if (body.get("grant_type") === "authorization_code") {
      assert.equal(
        body.get("redirect_uri"),
        authorization.searchParams.get("redirect_uri"),
      );
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier"))
          .digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
    } else {
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("scope"), null);
    }
    return response(
      {
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh-new",
        token_type: "Bearer",
        expires_in: 3600,
        scope:
          "openid offline_access resource.invoke chatgpt.tokens.use.direct",
        id_token: jwt(getClaims(), options.header),
        ...options.token,
      },
      options.status ?? 200,
    );
  };
  const callback = (patch = {}) => {
    const url = new URL(authorization.searchParams.get("redirect_uri"));
    url.search = new URLSearchParams({
      code: "synthetic-code",
      state: authorization.searchParams.get("state"),
      client_id: CLIENT,
      ...patch,
    }).toString();
    return url.href;
  };
  const auth = createChatGPTOAuth({
    getRegistration: async () => options.registration,
    fetchImpl,
    now: () => NOW,
    callbackPort: 0,
    loginTimeoutMs: options.timeout ?? 2000,
  });
  const interaction = {
    signal: abort.signal,
    notify(event) {
      if (event.type === "auth_url") authorization = new URL(event.url);
    },
    async prompt(prompt) {
      return options.prompt
        ? options.prompt({ prompt, callback, authorization, abort })
        : callback(options.callbackPatch);
    },
  };
  return {
    auth,
    requests,
    abort,
    get authorization() {
      return authorization;
    },
    login: () =>
      auth.login(interaction, { getDeviceId: () => DEVICE, agentName: "Red" }),
  };
}

test("official ChatGPT flow validates signed identity, PKCE and issued registration", async () => {
  const f = fixture();
  const credential = await f.login();
  assert.equal(credential.type, "oauth");
  assert.equal(credential.clientId, CLIENT);
  assert.equal(credential.subject, SUBJECT);
  assert.equal(credential.access, "synthetic-access");
  assert.equal(credential.refresh, "synthetic-refresh-new");
  assert.ok(credential.expires > NOW);
  assert.equal(credential.idToken, undefined);
  assert.equal(credential.email, undefined);
  assert.equal(f.authorization.origin, "https://auth.openai.com");
  assert.equal(f.authorization.pathname, "/api/accounts/authorize");
  assert.equal(
    f.authorization.searchParams.get("client_id"),
    "dynamic_agent_client",
  );
  assert.equal(f.authorization.searchParams.get("agent_name_hint"), "Red");
  assert.equal(
    f.authorization.searchParams.get("ext_agent_host_id"),
    `urn:uuid:${DEVICE}`,
  );
  assert.equal(
    f.authorization.searchParams.get("code_challenge_method"),
    "S256",
  );
  assert.deepEqual(await f.auth.toAuth(credential), {
    apiKey: "synthetic-access",
  });
});

test("reauthorization reuses client and host with fresh state, nonce and PKCE", async () => {
  const f = fixture({ registration: { clientId: CLIENT, subject: SUBJECT } });
  await f.login();
  const first = f.authorization;
  await f.login();
  assert.equal(f.authorization.searchParams.get("client_id"), CLIENT);
  assert.equal(f.authorization.searchParams.has("agent_name_hint"), false);
  for (const name of ["state", "nonce", "code_challenge"])
    assert.notEqual(
      f.authorization.searchParams.get(name),
      first.searchParams.get(name),
    );
});

test("returning callback may omit issued client ID", async () => {
  const f = fixture({
    registration: { clientId: CLIENT, subject: SUBJECT },
    prompt: ({ callback }) => {
      const url = new URL(callback());
      url.searchParams.delete("client_id");
      return url.href;
    },
  });
  assert.equal((await f.login()).clientId, CLIENT);
});

for (const [name, changes] of [
  ["issuer", { iss: "https://attacker.invalid" }],
  ["audience", { aud: "other-client" }],
  ["authorized party", { aud: [CLIENT, "other"], azp: "other" }],
  ["expiry", { exp: NOW / 1000 - 1 }],
  ["nonce", { nonce: "wrong-nonce" }],
  ["future validity", { nbf: NOW / 1000 + 600 }],
])
  test(`rejects invalid ID-token ${name}`, async () => {
    await assert.rejects(
      fixture({ claims: changes }).login(),
      /claims did not verify/,
    );
  });

test("rejects identity replacement for saved registration", async () => {
  await assert.rejects(
    fixture({
      registration: { clientId: CLIENT, subject: "different-owner" },
    }).login(),
    /claims did not verify/,
  );
});

test("rejects unsupported signature algorithm and missing signing key", async () => {
  await assert.rejects(
    fixture({ header: { alg: "none" } }).login(),
    /Unsupported ChatGPT ID token/,
  );
  await assert.rejects(
    fixture({ keys: [] }).login(),
    /signing key was not found/,
  );
});

test("rejects a forged ID-token signature", async () => {
  const f = fixture({
    token: {
      id_token: `${jwt({ iss: "https://auth.openai.com" }).split(".").slice(0, 2).join(".")}.ZmFrZQ`,
    },
  });
  await assert.rejects(f.login(), /signature did not verify/);
});

test("rejects invalid callback state, client replacement, duplicate parameters and redirect", async () => {
  await assert.rejects(
    fixture({ callbackPatch: { state: "wrong" } }).login(),
    /state mismatch/,
  );
  await assert.rejects(
    fixture({
      registration: { clientId: CLIENT, subject: SUBJECT },
      callbackPatch: { client_id: "oaiapp_other" },
    }).login(),
    /Invalid ChatGPT authorization callback/,
  );
  await assert.rejects(
    fixture({ prompt: ({ callback }) => `${callback()}&state=extra` }).login(),
    /Unexpected ChatGPT callback/,
  );
  await assert.rejects(
    fixture({
      prompt: ({ callback }) => callback().replace("127.0.0.1", "localhost"),
    }).login(),
    /Unexpected ChatGPT callback/,
  );
});

test("missing plan scope or refresh token cannot become a credential", async () => {
  await assert.rejects(
    fixture({ token: { scope: "openid" } }).login(),
    /missing required/,
  );
  await assert.rejects(
    fixture({ token: { refresh_token: "" } }).login(),
    /missing required/,
  );
});

test("unrelated loopback requests do not poison valid pending login", async () => {
  const f = fixture({
    prompt: async ({ callback }) => {
      const invalid = await fetch(callback({ state: "unrelated-state" }));
      assert.equal(invalid.status, 400);
      const wrongPath = new URL(callback());
      wrongPath.pathname = "/not-callback";
      assert.equal((await fetch(wrongPath)).status, 400);
      assert.equal((await fetch(callback())).status, 200);
      return new Promise(() => {});
    },
  });
  assert.equal((await f.login()).clientId, CLIENT);
});

test("valid-state authorization denial terminates the pending flow", async () => {
  const f = fixture({
    prompt: async ({ callback }) => {
      const url = new URL(callback());
      url.searchParams.set("error", "access_denied");
      await fetch(url);
      return new Promise(() => {});
    },
  });
  await assert.rejects(f.login(), /declined or failed/);
});

test("timeout and cancellation close the callback listener", async () => {
  for (const cancelled of [false, true]) {
    const f = fixture({
      timeout: 50,
      prompt: ({ abort }) => {
        if (cancelled) setTimeout(() => abort.abort(), 5);
        return new Promise(() => {});
      },
    });
    await assert.rejects(f.login(), /cancelled or timed out/);
    await assert.rejects(
      fetch(f.authorization.searchParams.get("redirect_uri")),
    );
  }
});

test("refresh preserves verified registration and rotates credentials", async () => {
  const f = fixture();
  const original = await f.login();
  const renewed = await f.auth.refresh(original, new AbortController().signal);
  assert.equal(renewed.clientId, CLIENT);
  assert.equal(renewed.subject, SUBJECT);
  assert.equal(renewed.refresh, "synthetic-refresh-new");
  assert.equal(
    new URLSearchParams(f.requests.at(-2).init.body).get("refresh_token"),
    original.refresh,
  );
});

test("token endpoint errors never echo provider bodies", async () => {
  const f = fixture({
    status: 400,
    token: { error_description: "secret-private-token" },
  });
  await assert.rejects(
    f.login(),
    (error) =>
      /HTTP 400/.test(error.message) &&
      !error.message.includes("secret-private-token"),
  );
});

for (const phase of ["oauth/token", "jwks.json"]) {
  test(`cancellation during ${phase} cannot return a credential`, async () => {
    const f = fixture({
      fetchHook: ({ url, init, abort }) => {
        if (!url.endsWith(phase)) return undefined;
        setTimeout(() => abort.abort(), 5);
        return new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new Error("Synthetic request aborted")),
            { once: true },
          );
        });
      },
    });
    await assert.rejects(f.login(), /aborted/);
    await assert.rejects(
      fetch(f.authorization.searchParams.get("redirect_uri")),
    );
  });
}

test("oversized authentication response is cancelled before buffering it fully", async () => {
  let pulls = 0;
  let cancelled = false;
  const f = fixture({
    fetchHook: ({ url }) => {
      if (!url.endsWith("oauth/token")) return undefined;
      return new Response(
        new ReadableStream({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(256 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  await assert.rejects(f.login(), /response is too large/);
  assert.equal(cancelled, true);
  assert.ok(pulls <= 7);
});

test("cancellation while reading an authentication body stops the reader", async () => {
  let cancelled = false;
  const f = fixture({
    fetchHook: ({ url, abort }) => {
      if (!url.endsWith("oauth/token")) return undefined;
      setTimeout(() => abort.abort(), 5);
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  await assert.rejects(f.login(), /cancelled or timed out/);
  assert.equal(cancelled, true);
});
