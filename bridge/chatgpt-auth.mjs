import { createServer } from "node:http";
import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

// Official public-client ChatGPT plan-usage flow. No Codex client ID or private API.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const CALLBACK_PATH = "/auth/callback";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const random = () => randomBytes(32).toString("base64url");
const nonempty = (value) => typeof value === "string" && value.length > 0;
const clientIdValid = (value) =>
  typeof value === "string" &&
  /^[A-Za-z0-9_.:-]{1,256}$/.test(value) &&
  value !== DYNAMIC_CLIENT;
const equal = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

async function jsonRequest(fetchImpl, url, options, signal, timeoutMs) {
  const requestSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const response = await fetchImpl(url, {
    ...options,
    redirect: "error",
    signal: requestSignal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    // Do not echo provider bodies: they can contain credentials or private data.
    throw new Error(
      `ChatGPT authentication request failed (HTTP ${response.status})`,
    );
  }
  // Bound bytes while streaming; a misleading Content-Length cannot exhaust memory.
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  let done = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(
      new Error("ChatGPT authentication request cancelled or timed out"),
    );
  requestSignal.addEventListener("abort", onAbort, { once: true });
  try {
    requestSignal.throwIfAborted();
    if (reader)
      for (;;) {
        const next = await Promise.race([reader.read(), aborted]);
        if (next.done) {
          done = true;
          break;
        }
        size += next.value.byteLength;
        if (size > 1024 * 1024)
          throw new Error("ChatGPT authentication response is too large");
        chunks.push(Buffer.from(next.value));
      }
  } finally {
    requestSignal.removeEventListener("abort", onAbort);
    if (reader && !done) void reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks, size).toString("utf8");
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error("ChatGPT authentication returned invalid JSON");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("ChatGPT authentication returned an invalid response");
  return result;
}

function jwtPart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid ChatGPT ID token encoding");
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid ChatGPT ID token encoding");
  }
}

async function validateIdToken(idToken, expected, context) {
  if (!nonempty(idToken) || idToken.length > 64 * 1024)
    throw new Error("Missing or invalid ChatGPT ID token");
  const parts = idToken.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2]))
    throw new Error("Invalid ChatGPT ID token encoding");
  const header = jwtPart(parts[0]);
  const claims = jwtPart(parts[1]);
  if (
    !header ||
    header.alg !== "RS256" ||
    !nonempty(header.kid) ||
    header.crit !== undefined ||
    !claims ||
    typeof claims !== "object" ||
    Array.isArray(claims)
  )
    throw new Error("Unsupported ChatGPT ID token");
  const keys = await jsonRequest(
    context.fetchImpl,
    JWKS,
    {},
    context.signal,
    context.requestTimeoutMs,
  );
  const matches = Array.isArray(keys.keys)
    ? keys.keys.filter(
        (key) =>
          key?.kid === header.kid &&
          key.kty === "RSA" &&
          (!key.alg || key.alg === "RS256") &&
          (!key.use || key.use === "sig") &&
          (!key.key_ops ||
            (Array.isArray(key.key_ops) && key.key_ops.includes("verify"))),
      )
    : [];
  if (matches.length !== 1)
    throw new Error("ChatGPT ID token signing key was not found");
  let key;
  try {
    key = createPublicKey({ key: matches[0], format: "jwk" });
  } catch {
    throw new Error("Invalid ChatGPT signing key");
  }
  if (
    key.asymmetricKeyDetails?.modulusLength < 2048 ||
    !verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2], "base64url"),
    )
  )
    throw new Error("ChatGPT ID token signature did not verify");
  const time = context.now() / 1000;
  const audience = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (
    claims.iss !== ISSUER ||
    !Array.isArray(audience) ||
    !audience.every(nonempty) ||
    !audience.includes(expected.clientId) ||
    (audience.length > 1 && claims.azp !== expected.clientId) ||
    (claims.azp !== undefined && claims.azp !== expected.clientId) ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= time ||
    (claims.nbf !== undefined &&
      (!Number.isFinite(claims.nbf) || claims.nbf > time + 60)) ||
    (claims.iat !== undefined &&
      (!Number.isFinite(claims.iat) || claims.iat > time + 60)) ||
    !nonempty(claims.sub) ||
    claims.sub.length > 1024 ||
    (expected.nonce !== undefined && !equal(claims.nonce, expected.nonce)) ||
    (expected.subject !== undefined && !equal(claims.sub, expected.subject))
  )
    throw new Error("ChatGPT ID token claims did not verify");
  return claims.sub;
}

function credentialFromToken(token, clientId, subject, now, previousScopes) {
  const scopes =
    typeof token.scope === "string"
      ? token.scope.trim().split(/\s+/).filter(Boolean)
      : previousScopes;
  if (
    !nonempty(token.access_token) ||
    !nonempty(token.refresh_token) ||
    typeof token.token_type !== "string" ||
    token.token_type.toLowerCase() !== "bearer" ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0 ||
    !Number.isFinite(now() + token.expires_in * 1000) ||
    !Array.isArray(scopes) ||
    !scopes.includes(DIRECT_SCOPE)
  )
    throw new Error(
      "ChatGPT token response is missing required credentials or permission",
    );
  return {
    type: "oauth",
    access: token.access_token,
    refresh: token.refresh_token,
    expires:
      now() +
      token.expires_in * 1000 -
      Math.min(60_000, token.expires_in * 100),
    clientId,
    subject,
    scopes,
  };
}

function parseCallback(input, redirectUri, state, registration) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Paste the full ChatGPT callback URL");
  }
  const expected = new URL(redirectUri);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash ||
    ["code", "state", "client_id", "error"].some(
      (name) => url.searchParams.getAll(name).length > 1,
    )
  )
    throw new Error("Unexpected ChatGPT callback URL");
  if (!equal(url.searchParams.get("state"), state))
    throw new Error("ChatGPT OAuth state mismatch");
  if (url.searchParams.has("error")) {
    const error = new Error("ChatGPT authorization was declined or failed");
    error.code = "AUTHORIZATION_DECLINED";
    throw error;
  }
  const code = url.searchParams.get("code");
  const returnedClient = url.searchParams.get("client_id");
  const clientId = returnedClient ?? registration?.clientId;
  if (
    !nonempty(code) ||
    code.length > 8192 ||
    !clientIdValid(clientId) ||
    (registration && clientId !== registration.clientId)
  )
    throw new Error("Invalid ChatGPT authorization callback");
  return { code, clientId };
}

/** A Pi OAuthAuth with validated OIDC identity and app-owned registration reuse. */
export function createChatGPTOAuth({
  getRegistration = async () => undefined,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  callbackPort = 1455,
  loginTimeoutMs = 10 * 60_000,
  requestTimeoutMs = 30_000,
} = {}) {
  if (
    !Number.isInteger(callbackPort) ||
    callbackPort < 0 ||
    callbackPort > 65535 ||
    !Number.isFinite(loginTimeoutMs) ||
    loginTimeoutMs <= 0 ||
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  )
    throw new Error("Invalid ChatGPT OAuth configuration");
  const context = (signal) => ({ fetchImpl, now, signal, requestTimeoutMs });
  const exchange = (body, signal) =>
    jsonRequest(
      fetchImpl,
      TOKEN,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams(body),
      },
      signal,
      requestTimeoutMs,
    );

  return {
    name: "OpenAI (ChatGPT subscription)",
    isSubscription: true,
    loginLabel: "Continue with ChatGPT",
    async login(interaction, options = {}) {
      const deviceId = options.getDeviceId?.();
      if (typeof deviceId !== "string" || !uuid.test(deviceId))
        throw new Error(
          "ChatGPT sign-in requires a stable installation UUIDv4",
        );
      const agentName = options.agentName ?? "Red";
      if (
        !nonempty(agentName) ||
        agentName.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(agentName)
      )
        throw new Error("Invalid app name for ChatGPT sign-in");
      const registration = await getRegistration();
      if (
        registration &&
        (!clientIdValid(registration.clientId) ||
          !nonempty(registration.subject))
      )
        throw new Error("Saved ChatGPT registration is invalid");
      const localAbort = new AbortController();
      const signal = AbortSignal.any([
        localAbort.signal,
        AbortSignal.timeout(loginTimeoutMs),
        ...(interaction.signal ? [interaction.signal] : []),
      ]);
      signal.throwIfAborted();
      const state = random();
      const nonce = random();
      const verifier = random();
      const challenge = createHash("sha256")
        .update(verifier)
        .digest("base64url");
      let redirectUri;
      let resolveCallback;
      let rejectCallback;
      let settled = false;
      const callback = new Promise((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
      });
      // Keep rejection handled even when abort happens while binding the listener.
      callback.catch(() => {});
      const server = createServer((request, response) => {
        const reply = (status, text) => {
          response.writeHead(status, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'",
            "x-content-type-options": "nosniff",
          });
          response.end(text);
        };
        if (settled) return reply(409, "This sign-in attempt has ended.");
        if (!redirectUri) return reply(503, "Callback listener is starting.");
        if (
          request.method !== "GET" ||
          request.headers.host !== new URL(redirectUri).host ||
          !request.url ||
          request.url.length > 16384
        )
          return reply(400, "Invalid callback request.");
        let parsed;
        try {
          parsed = parseCallback(
            new URL(request.url, redirectUri).href,
            redirectUri,
            state,
            registration,
          );
        } catch (error) {
          if (error.code === "AUTHORIZATION_DECLINED") {
            settled = true;
            reply(
              400,
              "ChatGPT authorization was declined or failed. Return to Red.",
            );
            rejectCallback(error);
            return;
          }
          // Invalid/unrelated loopback traffic never consumes or cancels a pending login.
          return reply(
            400,
            "Invalid callback. Return to Red to continue or cancel sign-in.",
          );
        }
        settled = true;
        reply(
          200,
          "Authorization received. Return to Red to check the connection.",
        );
        resolveCallback(parsed);
      });
      const onAbort = () =>
        rejectCallback(new Error("ChatGPT sign-in cancelled or timed out"));
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await new Promise((resolve, reject) => {
          server.once("error", reject);
          server.listen(callbackPort, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        }).catch(() => {
          throw new Error(
            "Could not start the ChatGPT callback listener. Close another pending sign-in and try again.",
          );
        });
        redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
        server.on("error", () =>
          rejectCallback(new Error("ChatGPT callback listener failed")),
        );
        signal.throwIfAborted();
        const authorization = new URL(AUTHORIZE);
        authorization.search = new URLSearchParams({
          client_id: registration?.clientId ?? DYNAMIC_CLIENT,
          ...(!registration ? { agent_name_hint: agentName } : {}),
          ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
          response_type: "code",
          redirect_uri: redirectUri,
          resource: RESOURCE,
          scope: SCOPES,
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString();
        interaction.notify({
          type: "auth_url",
          url: authorization.href,
          instructions:
            "Complete sign-in in your browser. If needed, paste the full final callback URL in Red.",
        });
        const manual = Promise.resolve()
          .then(() =>
            interaction.prompt({
              type: "manual_code",
              message:
                "Complete browser sign-in, or paste the full callback URL:",
              placeholder: redirectUri,
              signal,
            }),
          )
          .then((input) =>
            parseCallback(input, redirectUri, state, registration),
          );
        const result = await Promise.race([callback, manual]);
        settled = true;
        interaction.notify({
          type: "progress",
          message: "Verifying the ChatGPT connection...",
        });
        const token = await exchange(
          {
            grant_type: "authorization_code",
            client_id: result.clientId,
            code: result.code,
            code_verifier: verifier,
            redirect_uri: redirectUri,
            resource: RESOURCE,
          },
          signal,
        );
        const subject = await validateIdToken(
          token.id_token,
          { clientId: result.clientId, nonce, subject: registration?.subject },
          context(signal),
        );
        signal.throwIfAborted();
        // Profile/email and ID-token contents are not retained or returned to UI.
        return credentialFromToken(token, result.clientId, subject, now);
      } finally {
        settled = true;
        localAbort.abort();
        signal.removeEventListener("abort", onAbort);
        server.close();
        server.closeAllConnections();
      }
    },
    async refresh(credential, signal = new AbortController().signal) {
      if (
        !clientIdValid(credential.clientId) ||
        !nonempty(credential.subject) ||
        !nonempty(credential.refresh)
      )
        throw new Error("Reconnect ChatGPT to renew this session");
      const token = await exchange(
        {
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: RESOURCE,
        },
        signal,
      );
      if (token.id_token !== undefined)
        await validateIdToken(
          token.id_token,
          { clientId: credential.clientId, subject: credential.subject },
          context(signal),
        );
      return credentialFromToken(
        token,
        credential.clientId,
        credential.subject,
        now,
        credential.scopes,
      );
    },
    async toAuth(credential) {
      return { apiKey: credential.access };
    },
  };
}
