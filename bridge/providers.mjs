import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { createChatGPTOAuth } from "./chatgpt-auth.mjs";
import { validateJob } from "./protocol.mjs";
import {
  cacheCapability,
  cacheIdentity,
  cachePayload,
} from "./prompt-cache.mjs";
import {
  kimiCodeProvider,
  kimiCodePayload,
  createKimiContinuationCache,
  KIMI_CODE_BASE,
  KIMI_CODE_MODEL,
  KIMI_CODE_USER_AGENT,
} from "./kimi-code.mjs";

const LOGIN_MS = 10 * 60 * 1000;
const CATALOG_MS = 5 * 60 * 1000;
const MAX_MODELS = 200;
const DESCRIPTIONS = [
  { id: "openai", name: "ChatGPT", kind: "oauth", piId: "openai" },
  { id: "openrouter", name: "OpenRouter", kind: "api_key", piId: "openrouter" },
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    kind: "api_key",
    piId: "opencode",
  },
  { id: "kimi-code", name: "Kimi Code", kind: "api_key", piId: "kimi-code" },
];
const ENDPOINTS = {
  "kimi-code": `${KIMI_CODE_BASE}/models`,
  openai: "https://api.openai.com/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
  "opencode-zen": "https://opencode.ai/inference/v1/models",
};
const ZEN_BASES = {
  "openai-completions": "https://opencode.ai/inference/openai/v1",
  "openai-responses": "https://opencode.ai/inference/openai/v1",
  // Anthropic's SDK appends /v1/messages itself. The pinned Google adapter
  // rejects custom fetch, so it cannot use this bridge's redirect-denying
  // transport and is deliberately not advertised.
  "anthropic-messages": "https://opencode.ai/inference/anthropic",
};
const ACTIVE_FLOW = new Set(["starting", "waiting", "exchanging", "saving"]);
const SAFE_MESSAGES = {
  auth: "Provider authentication needs attention. Reconnect this provider locally.",
  quota:
    "Provider quota, rate limit, or credit balance needs attention. No other provider was used.",
  model: "Requested model is unavailable on the selected provider.",
  transient:
    "Provider request failed or was interrupted. No other provider was used.",
  busy: "A provider operation is already running. Wait for it to finish or cancel sign-in.",
  invalid: "Invalid provider setup request.",
  closed: "Provider manager is closed.",
  continuation:
    "Kimi continuation state is unavailable on this host. Stop the interrupted turn and send a new message. No other provider was used.",
  thinking:
    "K3.1 Pro requires thinking. Choose a reasoning level other than off.",
  recovery:
    "Credential recovery is required. Stop the bridge and follow the documented reconnect procedure.",
};

export class ProviderError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.transient);
    this.name = "ProviderError";
    this.code = code === "recovery" ? "CREDENTIAL_RECOVERY_REQUIRED" : code;
    this.kind =
      code === "recovery"
        ? "auth"
        : ["continuation", "thinking"].includes(code)
          ? "invalid"
          : code;
  }
}

// Inspect errors only to categorize them. Never return their text, cause,
// provider payload, request headers, or credentials to the UI/journal/logger.
export function sanitizeProviderError(error) {
  if (error instanceof ProviderError) return error;
  let value = error;
  let text = "";
  for (let i = 0; value && i < 4; i++, value = value.cause) {
    if (value.code === "CREDENTIAL_RECOVERY_REQUIRED")
      return new ProviderError("recovery");
    text += ` ${String(value.code ?? "")} ${String(value.status ?? "")} ${String(value.message ?? "").slice(0, 4096)}`;
  }
  if (
    /quota|rate.?limit|usage.limit|credit|budget|\b40[2]\b|\b429\b/i.test(text)
  )
    return new ProviderError("quota");
  if (
    /oauth|refresh|unauthori|credential|invalid_grant|\bauth\b|\b401\b|\b403\b/i.test(
      text,
    )
  )
    return new ProviderError("auth");
  if (/model.*(unavailable|not found|unsupported)|unknown model/i.test(text))
    return new ProviderError("model");
  return new ProviderError("transient");
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(new ProviderError("auth"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new ProviderError("auth"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function descriptor(id) {
  const value = DESCRIPTIONS.find((entry) => entry.id === id);
  if (!value) throw new ProviderError("invalid");
  return value;
}
function publicId(piId) {
  return piId === "opencode" ? "opencode-zen" : piId;
}
function qualified(id, modelId) {
  return id === "openai" ? modelId : `${id}::${modelId}`;
}
function credentialValid(entry, value) {
  if (entry.kind === "oauth")
    return (
      value?.type === "oauth" &&
      typeof value.access === "string" &&
      value.access.length > 0 &&
      typeof value.refresh === "string" &&
      value.refresh.length > 0 &&
      Number.isFinite(value.expires) &&
      typeof value.clientId === "string" &&
      value.clientId.length > 0 &&
      typeof value.subject === "string" &&
      value.subject.length > 0 &&
      Array.isArray(value.scopes) &&
      value.scopes.includes("chatgpt.tokens.use.direct")
    );
  return (
    value?.type === "api_key" &&
    typeof value.key === "string" &&
    value.key.length > 0
  );
}
function validModelId(value) {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9/_.:@+-]{0,110}$/.test(value)
  );
}

async function boundedJson(response, limit = 4 * 1024 * 1024) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError(
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 402 || response.status === 429
          ? "quota"
          : "transient",
    );
  }
  if (!response.body) throw new ProviderError("transient");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ProviderError("transient");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function knownToolModel(entry, item, model) {
  if (
    !model ||
    (model.type && model.type !== "chat") ||
    !model.input?.includes("text")
  )
    return false;
  if (entry.id === "openrouter")
    return (
      Array.isArray(item.supported_parameters) &&
      item.supported_parameters.includes("tools")
    );
  if (entry.id === "opencode-zen") {
    // Zen's public catalog has IDs only, no tool capability metadata. Use a
    // conservative set of tool-capable families in Pi's pinned chat registry;
    // unknown/free preview aliases are deliberately excluded.
    return (
      Boolean(ZEN_BASES[model.api]) &&
      /^(claude-(?:fable|haiku|opus|sonnet)-|gpt-(?:5|6)(?:[.-]|$)|deepseek-v4|glm-5|grok-4|kimi-k[23]|minimax-m[23]|qwen3[.])/i.test(
        model.id,
      )
    );
  }
  if (entry.id === "kimi-code")
    return (
      model.id === KIMI_CODE_MODEL &&
      item.supports_tool_use !== false &&
      model.api === "openai-responses"
    );
  return model.api === "openai-responses";
}

// Pi 1.1.0 predates the current SIWC tool envelope. This adapter only changes
// the request representation; every executable tool still runs in the DO.
// https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
export function chatGPTPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.input))
    throw new ProviderError("invalid");
  const result = { ...payload, store: false, stream: true };
  for (const field of [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "prompt_cache_options",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ])
    delete result[field];
  result.input = payload.input.map((item) => {
    if (
      item?.type === "tool_search_call" ||
      item?.type === "tool_search_output"
    )
      throw new ProviderError("invalid");
    if (
      item?.type === "additional_tools" &&
      (!Array.isArray(item.tools) ||
        item.tools.some((tool) => !["function", "custom"].includes(tool?.type)))
    )
      throw new ProviderError("invalid");
    return item?.role === "system" ? { ...item, role: "developer" } : item;
  });
  if (payload.tools !== undefined) {
    if (
      !Array.isArray(payload.tools) ||
      payload.tools.some((tool) => !["function", "custom"].includes(tool?.type))
    )
      throw new ProviderError("invalid");
    if (payload.tools.length)
      result.input.unshift({
        type: "additional_tools",
        role: "developer",
        tools: payload.tools,
      });
    delete result.tools;
  }
  return result;
}

// Pi 1.1.0 does not expose SDK logger options. This module runs in the
// dedicated bridge process, where raw SDK request/response diagnostics must
// stay disabled even when the launching shell requests debug logging.
function hardenSDKEnvironment() {
  process.env.OPENAI_LOG = "off";
  process.env.ANTHROPIC_LOG = "off";
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  delete process.env.OPENAI_CUSTOM_HEADERS;
  delete process.env.OPENAI_ADMIN_KEY;
}

/**
 * Trusted-host provider lifecycle. Provider options are injection seams for
 * offline tests, never settings accepted from an HTTP request or inference job.
 * Credentials and all effective provider URLs stay entirely on this host.
 */
export function createProviderManager({
  store,
  fetcher = fetch,
  clock = Date.now,
  providers,
  modelsFactory = createModels,
  loginTimeoutMs = LOGIN_MS,
  cachePolicy = "auto",
} = {}) {
  if (!store?.credentials || !["auto", "off"].includes(cachePolicy))
    throw new ProviderError("invalid");
  hardenSDKEnvironment();
  const lifecycle = new AbortController();
  const kimiContinuation = createKimiContinuationCache();
  let closed = false;
  let mutation = false;
  let mutationDone = null;
  let inference = null;
  let flow = null;
  let refreshPromise = null;
  let catalogAt = -Infinity;
  let cacheNamespaces;
  async function cacheNamespace(provider, rotate = false) {
    if (!cacheNamespaces) {
      const stored = await store.read?.("prompt-cache.json");
      if (
        stored !== undefined &&
        (!stored ||
          stored.version !== 1 ||
          !stored.providers ||
          typeof stored.providers !== "object" ||
          Array.isArray(stored.providers))
      )
        throw new ProviderError("invalid");
      cacheNamespaces = { ...(stored?.providers ?? {}) };
    }
    if (
      cacheNamespaces[provider] !== undefined &&
      (typeof cacheNamespaces[provider] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          cacheNamespaces[provider],
        ))
    )
      throw new ProviderError("invalid");
    if (rotate || !cacheNamespaces[provider]) {
      const next = { ...cacheNamespaces, [provider]: randomUUID() };
      // openStore always supplies read/write. Minimal injected offline stores
      // fall back to process-local isolation, never a shared global namespace.
      await store.write?.("prompt-cache.json", { version: 1, providers: next });
      cacheNamespaces = next;
    }
    return cacheNamespaces[provider];
  }
  const state = new Map(
    DESCRIPTIONS.map((entry) => [
      entry.id,
      {
        connected: false,
        status: "disconnected",
        message: "Not connected.",
        models: [],
        generation: 0,
      },
    ]),
  );
  // Pi's provider id differs from the public UI identifier. Ambient keys/files
  // are deliberately inaccessible, and credential environment overrides are
  // never accepted, so a failed subscription cannot become a paid API call.
  const piCredentials = {
    read: async (id, options) => {
      const entry = descriptor(publicId(id));
      const credential = await store.credentials.read(entry.id, options);
      if (!credential) return undefined;
      if (!credentialValid(entry, credential)) throw new ProviderError("auth");
      return entry.kind === "api_key"
        ? { type: "api_key", key: credential.key }
        : credential;
    },
    list: async () =>
      (await store.credentials.list()).map((entry) => ({
        ...entry,
        providerId:
          entry.providerId === "opencode-zen" ? "opencode" : entry.providerId,
      })),
    modify: (id, fn, options) =>
      store.credentials.modify(descriptor(publicId(id)).id, fn, options),
    delete: (id, options) =>
      store.credentials.delete(descriptor(publicId(id)).id, options),
  };
  const models = modelsFactory({
    credentials: piCredentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  if (!providers) {
    const openai = openaiProvider();
    providers = [
      {
        ...openai,
        auth: {
          oauth: createChatGPTOAuth({
            getRegistration: () => store.read("openai-registration.json"),
            fetchImpl: fetcher,
            now: clock,
            loginTimeoutMs,
          }),
        },
      },
      openrouterProvider(),
      opencodeProvider(),
      kimiCodeProvider(),
    ];
  }
  for (const provider of providers) models.setProvider(provider);

  function beginMutation() {
    mutation = true;
    let resolve;
    mutationDone = new Promise((done) => {
      resolve = done;
    });
    return () => {
      mutation = false;
      mutationDone = null;
      resolve();
    };
  }
  function inferenceFetch(entry, model) {
    const paths =
      entry.id === "openai"
        ? { "openai-responses": "https://api.openai.com/v1/responses" }
        : entry.id === "kimi-code"
          ? { "openai-responses": `${KIMI_CODE_BASE}/responses` }
          : entry.id === "openrouter"
            ? {
                "openai-completions":
                  "https://openrouter.ai/api/v1/chat/completions",
                "anthropic-messages": "https://openrouter.ai/api/v1/messages",
              }
            : {
                "openai-completions":
                  "https://opencode.ai/inference/openai/v1/chat/completions",
                "openai-responses":
                  "https://opencode.ai/inference/openai/v1/responses",
                "anthropic-messages":
                  "https://opencode.ai/inference/anthropic/v1/messages",
              };
    return (input, init) => {
      let url;
      try {
        url = new URL(
          typeof input === "string" || input instanceof URL ? input : input.url,
        );
      } catch {
        throw new ProviderError("model");
      }
      const method = String(
        init?.method ?? input?.method ?? "GET",
      ).toUpperCase();
      if (
        method !== "POST" ||
        url.origin + url.pathname !== paths[model.api] ||
        url.username ||
        url.password ||
        url.hash ||
        [...url.searchParams].some(
          ([key, value]) =>
            model.api !== "anthropic-messages" ||
            key !== "beta" ||
            value !== "true",
        )
      )
        throw new ProviderError("model");
      const headers = new Headers(init?.headers ?? input?.headers);
      headers.delete("openai-organization");
      headers.delete("openai-project");
      if (entry.id === "kimi-code")
        headers.set("User-Agent", KIMI_CODE_USER_AGENT);
      return fetcher(input, { ...init, headers, redirect: "error" });
    };
  }
  function assertOpen() {
    if (closed) throw new ProviderError("closed");
    expireFlow();
  }
  function pending() {
    return flow && ACTIVE_FLOW.has(flow.status);
  }
  function assertIdle() {
    assertOpen();
    if (mutation || inference || refreshPromise || pending() || flow?.settling)
      throw new ProviderError("busy");
  }
  function publicFlow() {
    if (!flow) return null;
    return {
      id: flow.id,
      providerId: "openai",
      status: flow.status,
      ...(flow.url ? { url: flow.url } : {}),
      ...(flow.prompt ? { prompt: { ...flow.prompt } } : {}),
      ...(flow.message ? { message: flow.message } : {}),
      expiresAt: flow.expiresAt,
    };
  }
  function finishFlow(current, status, message) {
    current.status = status;
    current.message = message;
    delete current.url;
    delete current.prompt;
    clearTimeout(current.timer);
  }
  function cancelCurrent(current, status = "cancelled") {
    if (!current || !ACTIVE_FLOW.has(current.status)) return;
    finishFlow(
      current,
      status,
      status === "expired"
        ? "Sign-in expired. Start again when ready."
        : "Sign-in cancelled.",
    );
    current.controller.abort();
    current.rejectPrompt?.(new ProviderError("auth"));
    current.rejectPrompt = null;
    current.resolvePrompt = null;
  }
  function expireFlow() {
    if (pending() && clock() >= flow.expiresAt) cancelCurrent(flow, "expired");
  }
  function active(current) {
    expireFlow();
    return (
      !closed &&
      flow === current &&
      ACTIVE_FLOW.has(current.status) &&
      !current.controller.signal.aborted
    );
  }
  function safeStateError(id, error) {
    const safe = sanitizeProviderError(error);
    const current = state.get(id);
    current.status =
      safe.kind === "auth"
        ? "auth_error"
        : safe.kind === "quota"
          ? "quota"
          : "error";
    current.message = safe.message;
    current.models = [];
    return safe;
  }
  function advertised() {
    const catalogs = DESCRIPTIONS.map((entry) => state.get(entry.id).models);
    const result = [];
    // Round-robin preserves each provider's published order without letting a
    // large aggregator catalog hide every model from another connected provider.
    for (let index = 0; result.length < MAX_MODELS; index++) {
      let added = false;
      for (const catalog of catalogs) {
        if (catalog[index] && result.length < MAX_MODELS) {
          result.push(catalog[index]);
          added = true;
        }
      }
      if (!added) break;
    }
    return result;
  }
  async function readCredential(entry) {
    const value = await store.credentials.read(entry.id);
    if (!value) return undefined;
    if (!credentialValid(entry, value)) throw new ProviderError("auth");
    return value;
  }
  async function requestJson(url, key, signal, limit) {
    return boundedJson(
      await fetcher(url, {
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          Accept: "application/json",
          ...(url === ENDPOINTS["kimi-code"]
            ? { "User-Agent": KIMI_CODE_USER_AGENT }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.any([
          lifecycle.signal,
          signal ?? lifecycle.signal,
          AbortSignal.timeout(15000),
        ]),
      }),
      limit,
    );
  }
  async function validateOpenRouterKey(key, signal) {
    const value = await requestJson(
      "https://openrouter.ai/api/v1/key",
      key,
      signal,
      64 * 1024,
    );
    if (
      !value ||
      typeof value.data !== "object" ||
      !value.data ||
      Array.isArray(value.data)
    )
      throw new ProviderError("auth");
  }
  async function refreshOne(entry) {
    const current = state.get(entry.id);
    const generation = current.generation;
    try {
      const credential = await readCredential(entry);
      if (!credential) {
        Object.assign(current, {
          connected: false,
          status: "disconnected",
          message: "Not connected.",
          models: [],
        });
        return;
      }
      current.connected = true;
      let key;
      if (entry.id === "openai") {
        const auth = await models.getAuth(entry.piId, {
          signal: lifecycle.signal,
        });
        if (!auth?.auth?.apiKey || auth.auth.baseUrl || auth.auth.headers)
          throw new ProviderError("auth");
        key = auth.auth.apiKey;
      } else if (entry.id === "kimi-code") {
        key = credential.key;
      } else if (entry.id === "openrouter") {
        await validateOpenRouterKey(credential.key, lifecycle.signal);
      }
      // Zen's catalog is public. Do not transmit its saved key to a catalog
      // endpoint or call a charged model merely to test credentials.
      const catalog = await requestJson(ENDPOINTS[entry.id], key);
      const items = entry.id === "openai" ? catalog?.models : catalog?.data;
      if (!Array.isArray(items)) throw new ProviderError("model");
      const seen = new Set();
      const available = [];
      for (const item of items) {
        const id = entry.id === "openai" ? item?.slug : item?.id;
        if (
          !validModelId(id) ||
          seen.has(id) ||
          (entry.id === "openai" && item.visibility !== "list")
        )
          continue;
        const model = models.getModel(entry.piId, id);
        if (!knownToolModel(entry, item, model)) continue;
        const qid = qualified(entry.id, id);
        if (qid.length > 128) continue;
        seen.add(id);
        available.push({
          id: qid,
          name: model.name,
          modelId: id,
          providerId: entry.id,
        });
        if (available.length >= MAX_MODELS) break;
      }
      if (closed || current.generation !== generation) return;
      current.models = available;
      if (entry.id === "opencode-zen" && current.status !== "connected") {
        current.status = "unverified";
        current.message = available.length
          ? "Key saved locally. It will be verified by your first requested inference; API usage may be billed."
          : "Key saved locally, but no supported tool-capable models were found.";
      } else {
        current.status = available.length ? "connected" : "no_models";
        current.message = available.length
          ? entry.kind === "oauth"
            ? "ChatGPT connected. Account models refreshed."
            : entry.id === "kimi-code"
              ? "Kimi Code key verified. K3.1 Pro uses your membership allowance for conversation and memory jobs; plan restrictions apply."
              : "Key verified. API usage may be billed."
          : "No supported tool-capable models were found.";
      }
    } catch (error) {
      if (!closed && current.generation === generation)
        safeStateError(entry.id, error);
    }
  }
  async function performRefresh(entries = DESCRIPTIONS) {
    await Promise.all(entries.map(refreshOne));
    catalogAt = clock();
  }

  async function status() {
    assertOpen();
    const allowed = new Set(advertised().map((model) => model.id));
    const result = [];
    for (const entry of DESCRIPTIONS) {
      const current = state.get(entry.id);
      try {
        const stored = await store.credentials.read(entry.id);
        current.connected = Boolean(stored);
        if (stored && !credentialValid(entry, stored))
          throw new ProviderError("auth");
        if (!current.connected && !pending())
          Object.assign(current, {
            status: "disconnected",
            message: "Not connected.",
            models: [],
          });
        if (current.connected && current.status === "disconnected")
          Object.assign(current, {
            status: "unverified",
            message:
              "Credential stored locally. Refresh models to check availability.",
          });
      } catch (error) {
        safeStateError(entry.id, error);
      }
      result.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        connected: current.connected,
        status: current.status,
        message: current.message,
        models: current.models
          .filter((model) => allowed.has(model.id))
          .map(({ id, name }) => ({ id, name })),
      });
    }
    result.push({
      id: "opencode-go",
      name: "OpenCode Go",
      kind: "subscription",
      connected: false,
      status: "disabled",
      message:
        "Go is restricted to eligible coding use. This general companion does not enforce that boundary, so Go is unavailable.",
      models: [],
    });
    return { providers: result, flow: publicFlow() };
  }

  async function startLogin(providerId = "openai") {
    assertOpen();
    if (providerId !== "openai") throw new ProviderError("invalid");
    if (pending()) return publicFlow();
    assertIdle();
    if (state.get("openai").connected) throw new ProviderError("busy");
    const oauth = models.getProvider("openai")?.auth?.oauth;
    if (!oauth?.login) throw new ProviderError("auth");
    const current = {
      id: randomUUID(),
      providerId: "openai",
      status: "starting",
      expiresAt: clock() + loginTimeoutMs,
      controller: new AbortController(),
      settling: true,
      message: "Preparing secure ChatGPT sign-in.",
    };
    flow = current;
    current.timer = setTimeout(
      () => cancelCurrent(current, "expired"),
      loginTimeoutMs,
    );
    current.timer.unref?.();
    const interaction = {
      signal: AbortSignal.any([lifecycle.signal, current.controller.signal]),
      notify: (event) => {
        if (!active(current)) return;
        if (event.type === "auth_url") {
          const url = new URL(event.url);
          if (
            url.origin !== "https://auth.openai.com" ||
            url.pathname !== "/api/accounts/authorize" ||
            url.username ||
            url.password ||
            url.hash
          )
            throw new ProviderError("auth");
          current.url = url.href;
          current.status = "waiting";
          current.message =
            "Open ChatGPT sign-in and review the requested access yourself.";
        } else if (event.type === "progress") {
          current.status = "exchanging";
          current.message = "Verifying ChatGPT authorization.";
        }
      },
      prompt: (prompt) => {
        if (!active(current) || prompt.type !== "manual_code")
          return Promise.reject(new ProviderError("auth"));
        const signal = AbortSignal.any([
          interaction.signal,
          prompt.signal ?? interaction.signal,
        ]);
        if (signal.aborted) return Promise.reject(new ProviderError("auth"));
        current.prompt = {
          type: "manual_code",
          message:
            "If sign-in does not finish automatically, paste the final localhost callback URL here.",
        };
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            signal.removeEventListener("abort", abort);
            current.resolvePrompt = null;
            current.rejectPrompt = null;
            delete current.prompt;
          };
          const abort = () => {
            cleanup();
            reject(new ProviderError("auth"));
          };
          current.resolvePrompt = (value) => {
            cleanup();
            resolve(value);
          };
          current.rejectPrompt = (error) => {
            cleanup();
            reject(error);
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      },
    };
    current.task = (async () => {
      try {
        const existing = await raceAbort(
          store.credentials.read("openai"),
          interaction.signal,
        );
        if (!active(current)) return;
        if (existing) throw new ProviderError("busy");
        const credential = await raceAbort(
          oauth.login(interaction, {
            getDeviceId: () => store.hostId,
            agentName: "Red Durable Personal Bridge",
          }),
          interaction.signal,
        );
        if (!active(current)) return;
        if (
          !credentialValid(DESCRIPTIONS[0], credential) ||
          typeof credential.clientId !== "string" ||
          typeof credential.subject !== "string"
        )
          throw new ProviderError("auth");
        current.status = "saving";
        // Store registration identity separately so disconnecting does not cause
        // a new dynamic client registration on every later login.
        await store.write("openai-registration.json", {
          clientId: credential.clientId,
          subject: credential.subject,
        });
        if (!active(current)) return;
        await cacheNamespace("openai", true);
        if (!active(current)) return;
        let wrote = false;
        await store.credentials.modify("openai", async () => {
          if (!active(current)) return undefined;
          wrote = true;
          return credential;
        });
        if (!active(current)) {
          // A cancel arriving during an atomic disk write must not leave the
          // just-authorized session active. Serialize deletion after the write.
          if (wrote) await store.credentials.delete("openai");
          return;
        }
        state.get("openai").generation++;
        finishFlow(
          current,
          "connected",
          "ChatGPT authorization saved locally.",
        );
        const endMutation = beginMutation();
        try {
          await performRefresh([DESCRIPTIONS[0]]);
        } finally {
          endMutation();
        }
      } catch (error) {
        if (active(current)) {
          const safe = safeStateError("openai", error);
          finishFlow(current, "error", safe.message);
        }
      } finally {
        clearTimeout(current.timer);
        current.controller.abort();
        current.settling = false;
      }
    })();
    return publicFlow();
  }

  async function cancelLogin(id = null) {
    assertOpen();
    if (!flow && id === null) return null;
    if (!flow || (id !== null && id !== flow.id))
      throw new ProviderError("invalid");
    const current = flow;
    cancelCurrent(current);
    await current.task;
    return publicFlow();
  }
  async function respondLogin(id, value) {
    assertOpen();
    if (
      !pending() ||
      id !== flow.id ||
      !flow.resolvePrompt ||
      typeof value !== "string" ||
      value.length > 8192 ||
      !value.trim()
    )
      throw new ProviderError("invalid");
    const resolver = flow.resolvePrompt;
    flow.status = "exchanging";
    flow.message = "Verifying ChatGPT authorization.";
    resolver(value.trim());
    return publicFlow();
  }
  async function connectKey(providerId, key) {
    const entry = descriptor(providerId);
    if (
      entry.kind !== "api_key" ||
      typeof key !== "string" ||
      key.length < 8 ||
      key.length > 4096 ||
      /\s|[\u0000-\u001f\u007f]/.test(key)
    )
      throw new ProviderError("invalid");
    assertIdle();
    const endMutation = beginMutation();
    try {
      if (providerId === "openrouter")
        await validateOpenRouterKey(key, lifecycle.signal);
      if (providerId === "kimi-code") {
        const catalog = await requestJson(
          ENDPOINTS[providerId],
          key,
          lifecycle.signal,
        );
        if (!Array.isArray(catalog?.data)) throw new ProviderError("model");
      }
      assertOpen();
      await cacheNamespace(providerId, true);
      assertOpen();
      await store.credentials.modify(providerId, async () =>
        lifecycle.signal.aborted
          ? undefined
          : {
              type: "api_key",
              key,
            },
      );
      assertOpen();
      const current = state.get(providerId);
      current.generation++;
      if (providerId === "kimi-code") kimiContinuation.clear();
      current.status = "unverified";
      current.models = [];
      await performRefresh([entry]);
      return await status();
    } catch (error) {
      throw sanitizeProviderError(error);
    } finally {
      endMutation();
    }
  }
  async function disconnect(providerId) {
    const entry = descriptor(providerId);
    assertIdle();
    const endMutation = beginMutation();
    try {
      if (
        providerId === "openai" &&
        !(await store.read("openai-registration.json"))
      ) {
        const existing = await store.credentials.read("openai");
        if (
          typeof existing?.clientId === "string" &&
          typeof existing?.subject === "string"
        )
          await store.write("openai-registration.json", {
            clientId: existing.clientId,
            subject: existing.subject,
          });
      }
      await store.credentials.delete(providerId);
      await cacheNamespace(providerId, true);
      if (providerId === "kimi-code") kimiContinuation.clear();
      const current = state.get(providerId);
      current.generation++;
      Object.assign(current, {
        connected: false,
        status: "disconnected",
        message:
          entry.kind === "oauth"
            ? "Disconnected locally. Revoke access in ChatGPT settings if desired."
            : "Disconnected locally.",
        models: [],
      });
      return await status();
    } catch (error) {
      throw sanitizeProviderError(error);
    } finally {
      endMutation();
    }
  }
  async function refresh() {
    assertOpen();
    if (refreshPromise) {
      await refreshPromise;
      return status();
    }
    if (mutation || inference || pending() || flow?.settling)
      throw new ProviderError("busy");
    refreshPromise = performRefresh();
    try {
      await refreshPromise;
      return await status();
    } finally {
      refreshPromise = null;
    }
  }
  async function catalog() {
    assertOpen();
    if (
      clock() - catalogAt >= CATALOG_MS &&
      !mutation &&
      !inference &&
      !pending() &&
      !flow?.settling
    )
      await refresh();
    return advertised().map((model) => model.id);
  }
  async function infer(job, { signal } = {}) {
    assertOpen();
    try {
      validateJob(job, clock());
    } catch {
      throw new ProviderError("invalid");
    }
    await catalog();
    assertIdle();
    const selected = advertised().find((model) => model.id === job.modelId);
    if (!selected) throw new ProviderError("model");
    const entry = descriptor(selected.providerId);
    const known = models.getModel(entry.piId, selected.modelId);
    if (!known) throw new ProviderError("model");
    const model = { ...known };
    if (entry.id === "kimi-code") model.baseUrl = KIMI_CODE_BASE;
    if (entry.id === "openai")
      model.compat = {
        ...model.compat,
        supportsToolSearch: false,
        supportsAdditionalTools: true,
        supportsDeveloperRole: true,
      };
    if (entry.id === "opencode-zen") model.baseUrl = ZEN_BASES[model.api];
    if (entry.id === "openrouter" && model.api === "openai-completions")
      model.compat = {
        ...model.compat,
        openRouterRouting: { allow_fallbacks: false, require_parameters: true },
      };
    const deadline = Math.min(120000, job.expiresAt - clock() - 5000);
    if (deadline < 1) throw new ProviderError("invalid");
    const controller = new AbortController();
    inference = controller;
    try {
      const credential = await readCredential(entry);
      if (!credential) throw new ProviderError("auth");
      hardenSDKEnvironment();
      const key = cacheIdentity({
        hostId: store.hostId,
        accountNamespace: await cacheNamespace(entry.id),
        provider: entry.id,
        model,
        job,
      });
      const capability = cacheCapability(entry.id, model);
      let context = job.context;
      if (entry.id === "kimi-code") {
        if (job.options?.reasoning === "off")
          throw new ProviderError("thinking");
        if (!job.summary) {
          try {
            context = kimiContinuation.restore(context, key);
          } catch {
            throw new ProviderError("continuation");
          }
        }
      }
      const message = await models.completeSimple(model, context, {
        ...(job.options?.reasoning !== undefined
          ? { reasoning: job.options.reasoning }
          : {}),
        ...(job.options?.maxTokens !== undefined
          ? { maxTokens: job.options.maxTokens }
          : {}),
        headers: {
          ...(entry.id === "opencode-zen"
            ? {
                Authorization: `Bearer ${credential.key}`,
                "User-Agent": "red-durable/0.1.0",
              }
            : {}),
          ...(capability.header ? { [capability.header]: key } : {}),
        },
        // Suppress ambient PI_CACHE_RETENTION and Pi's moving last-turn
        // breakpoints. Only this explicit, model-scoped policy adds hints.
        cacheRetention: "none",
        onPayload: (payload) =>
          cachePayload(
            entry.id === "openai"
              ? chatGPTPayload(payload)
              : entry.id === "kimi-code"
                ? kimiCodePayload(payload, job.options?.reasoning)
                : payload,
            {
              provider: entry.id,
              model,
              context,
              key,
              enabled: cachePolicy !== "off",
            },
          ),
        fetch: inferenceFetch(entry, model),
        maxRetries: 0,
        timeoutMs: deadline,
        sessionId: key,
        signal: AbortSignal.any([
          lifecycle.signal,
          controller.signal,
          signal ?? controller.signal,
          AbortSignal.timeout(deadline),
        ]),
      });
      if (message?.stopReason === "error" || message?.stopReason === "aborted")
        throw sanitizeProviderError(
          new Error(message.errorMessage ?? "interrupted"),
        );
      if (
        !message ||
        message.role !== "assistant" ||
        !Array.isArray(message.content)
      )
        throw new ProviderError("transient");
      if (entry.id === "opencode-zen") {
        state.get(entry.id).status = "connected";
        state.get(entry.id).message =
          "Key verified by the requested inference. API usage may be billed.";
      }
      if (entry.id === "kimi-code" && !job.summary) {
        try {
          return kimiContinuation.remember(message, key);
        } catch {
          throw new ProviderError("continuation");
        }
      }
      return message;
    } catch (error) {
      const safe = safeStateError(entry.id, error);
      throw safe;
    } finally {
      inference = null;
    }
  }
  async function close() {
    if (closed) return;
    cancelCurrent(flow);
    closed = true;
    lifecycle.abort();
    kimiContinuation.clear();
    inference?.abort();
    await mutationDone?.catch(() => {});
    await refreshPromise?.catch(() => {});
    await flow?.task?.catch(() => {});
  }
  return {
    status,
    startLogin,
    cancelLogin,
    respondLogin,
    connectKey,
    disconnect,
    refresh,
    catalog,
    infer,
    close,
  };
}
