import { createServer } from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { bridgeEndpoint } from "./protocol.mjs";

const MAX_BODY = 256000;
// The existing state endpoint can legitimately contain 100 messages up to 250KB
// each. Bound the proxy without breaking those supported conversation histories.
const MAX_UPSTREAM = 32 * 1024 * 1024;
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/api.js", ["api.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function secretEqual(a, b) {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
function reply(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}
async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function readUpstream(response) {
  if (!response.body) throw new Error("Missing upstream response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM) throw new Error("Upstream response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function object(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected JSON object");
  return value;
}

/** Loopback-only owner UI. Provider secrets terminate here, never at the Worker.
 * No CORS, remote bind, arbitrary proxy destination, or browser credential storage.
 */
export async function startSetupServer({
  manager,
  upstream,
  ownerToken,
  bridgeToken,
  session = "default",
  port = 8788,
  fetcher = fetch,
}) {
  const target = bridgeEndpoint(upstream);
  if (
    typeof ownerToken !== "string" ||
    ownerToken.length < 32 ||
    /[\r\n]/.test(ownerToken) ||
    ownerToken === bridgeToken ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(session) ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("Invalid owner-bound local setup configuration");
  let origin;
  const server = createServer(async (req, res) => {
    res.on("error", () => {});
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] &&
          !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
      )
        return reply(res, 403, {
          error: "Only same-origin loopback access is allowed",
        });
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.username || url.password)
        return reply(res, 400, { error: "Invalid request target" });
      if (
        ["GET", "HEAD"].includes(req.method) &&
        staticFiles.has(url.pathname) &&
        !url.search
      ) {
        const [filename, contentType] = staticFiles.get(url.pathname);
        const file = await readFile(
          new URL(`../public/${filename}`, import.meta.url),
        );
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "Content-Security-Policy": csp,
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        });
        return res.end(req.method === "HEAD" ? undefined : file);
      }
      if (!url.pathname.startsWith("/api/"))
        return reply(res, 404, { error: "Not found" });
      const supplied = String(req.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      if (
        !secretEqual(supplied, ownerToken) ||
        (req.headers["x-session"] ?? "default") !== session
      )
        return reply(res, 401, {
          error: "Owner access or configured session was rejected",
        });
      if (!["GET", "POST"].includes(req.method))
        return reply(res, 405, { error: "Method not allowed" });
      if (
        req.method === "POST" &&
        !String(req.headers["content-type"] ?? "")
          .toLowerCase()
          .startsWith("application/json")
      )
        return reply(res, 415, { error: "JSON requests required" });
      // The local owner proxy never lends the bridge/relay identity to the browser.
      if (
        url.pathname.startsWith("/api/bridge/") ||
        url.pathname.startsWith("/api/discord/")
      )
        return reply(res, 403, {
          error: "Transport capability is not available here",
        });
      if (
        url.pathname === "/api/providers" ||
        url.pathname.startsWith("/api/providers/")
      ) {
        if (url.search)
          return reply(res, 400, {
            error: "Provider parameters must not appear in URLs",
          });
        if (req.method === "GET" && url.pathname === "/api/providers")
          return reply(res, 200, {
            available: true,
            ...(await manager.status()),
          });
        if (req.method !== "POST")
          return reply(res, 405, { error: "Method not allowed" });
        const value = object(await readBody(req, 16000));
        const providerId = value.providerId;
        switch (url.pathname) {
          case "/api/providers/key":
            if (
              value.confirm !==
              (providerId === "kimi-code"
                ? "STORE_SUBSCRIPTION_KEY"
                : "STORE_METERED_KEY")
            )
              return reply(res, 400, {
                error: "Confirm storing this provider key on the trusted host",
              });
            await manager.connectKey(providerId, value.apiKey);
            break;
          case "/api/providers/login":
            if (providerId !== "openai")
              return reply(res, 400, {
                error: "This provider does not support ChatGPT sign-in",
              });
            return reply(res, 200, await manager.startLogin(providerId));
          case "/api/providers/cancel":
            if (value.id !== null && typeof value.id !== "string")
              return reply(res, 400, { error: "A login flow ID is required" });
            await manager.cancelLogin(value.id);
            break;
          case "/api/providers/respond":
            if (
              typeof value.id !== "string" ||
              typeof value.value !== "string" ||
              value.value.length > 8000
            )
              return reply(res, 400, { error: "Invalid login response" });
            await manager.respondLogin(value.id, value.value);
            break;
          case "/api/providers/disconnect":
            if (value.confirm !== "DISCONNECT")
              return reply(res, 400, {
                error: "Confirm disconnecting this provider",
              });
            await manager.disconnect(providerId);
            break;
          case "/api/providers/refresh":
            await manager.refresh();
            break;
          default:
            return reply(res, 404, { error: "Not found" });
        }
        return reply(res, 200, {
          available: true,
          ...(await manager.status()),
        });
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      const upstreamResponse = await fetcher(
        target + url.pathname + url.search,
        {
          method: req.method,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "X-Session": session,
            Origin: target,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      // Never forward upstream cookies, auth headers, redirects, or arbitrary HTML.
      reply(res, upstreamResponse.status, await readUpstream(upstreamResponse));
    } catch (error) {
      // Provider exceptions can contain a submitted key or OAuth response. No raw
      // exception is returned or logged, even for malformed requests.
      if (!res.headersSent) {
        const errors = {
          busy: "A provider operation is running. Wait for it to finish or cancel sign-in.",
          auth: "Provider credentials need attention. Check the connection status.",
          quota:
            "The selected provider's usage or credit limit needs attention.",
          invalid: "Invalid provider setup request.",
          CREDENTIAL_RECOVERY_REQUIRED:
            "Credential recovery is required. Stop the bridge and follow the documented reconnect procedure.",
        };
        reply(res, error?.code === "busy" ? 409 : 400, {
          error:
            errors[error?.code] ??
            "Provider or connection request could not complete. Check its status and retry explicitly.",
        });
      } else res.end();
    }
  });
  server.requestTimeout = 35000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  if (origin === target) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error("Setup server cannot proxy to itself");
  }
  return {
    origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
