import { createHash } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

export const KIMI_CODE_BASE = "https://api.kimi.ai/coding/v1";
export const KIMI_CODE_MODEL = "k3.1-pro";
// Identify this application, never impersonate Kimi CLI or another approved app.
export const KIMI_CODE_USER_AGENT = `red-durable/0.1.0 (${process.platform}; ${process.arch})`;

export function kimiCodeProvider() {
  return createProvider({
    id: "kimi-code",
    name: "Kimi Code",
    baseUrl: KIMI_CODE_BASE,
    auth: {
      apiKey: {
        name: "Kimi Code membership key",
        resolve: async ({ credential }) =>
          credential?.type === "api_key"
            ? {
                auth: { apiKey: credential.key },
                source: "Local Kimi Code key",
              }
            : undefined,
      },
    },
    models: [
      {
        id: KIMI_CODE_MODEL,
        name: "K3.1 Pro",
        provider: "kimi-code",
        api: "openai-responses",
        baseUrl: KIMI_CODE_BASE,
        input: ["text"],
        reasoning: true,
        // Red's own bridge/context limits remain below the entry-plan 256K window.
        contextWindow: 262144,
        maxTokens: 16000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsLongCacheRetention: false,
        },
      },
    ],
    api: openAIResponsesApi(),
  });
}

// K3.1 Pro requires thinking. Map Pi's generic levels to documented Kimi levels;
// "off" must not silently disable thinking or select a different model.
export function kimiCodePayload(payload, reasoning) {
  if (!payload || !Array.isArray(payload.input) || reasoning === "off")
    throw new Error("Kimi Code requires thinking");
  const effort =
    reasoning === "low" || reasoning === "minimal"
      ? "low"
      : reasoning === "high" || reasoning === "medium"
        ? "high"
        : "max";
  const result = {
    ...payload,
    model: KIMI_CODE_MODEL,
    store: false,
    reasoning: { effort },
    include: ["reasoning.encrypted_content"],
  };
  for (const field of [
    "temperature",
    "top_p",
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "previous_response_id",
    "conversation",
  ])
    delete result[field];
  return result;
}

function visibleContent(message) {
  return message.content
    .filter((block) => block.type !== "thinking")
    .map((block) => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "toolCall")
        return {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        };
      throw new Error("Unsupported Kimi response content");
    });
}
function fingerprint(message) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        timestamp: message.timestamp,
        content: visibleContent(message),
      }),
    )
    .digest("hex");
}

// Responses requires complete prior output, including opaque reasoning. Keep it
// only in bounded host RAM for an active turn, never in the Worker or journal.
// Red starts fresh Pi context for each new owner turn. Interrupted continuations
// without their RAM state fail closed rather than sending incomplete reasoning.
export function createKimiContinuationCache() {
  const messages = new Map();
  const recency = new Map();
  let serial = 0;
  let bytes = 0;
  return {
    clear(scope) {
      for (const [key, entry] of messages) {
        if (scope === undefined || entry.scope === scope) {
          bytes -= entry.bytes;
          messages.delete(key);
        }
      }
      if (scope === undefined) recency.clear();
      else recency.delete(scope);
    },
    restore(context, scope = "legacy") {
      const assistants = context.messages.filter(
        (message) => message.role === "assistant",
      );
      if (!assistants.length) this.clear(scope);
      const restored = {
        ...context,
        messages: context.messages.map((message) => {
          if (message.role !== "assistant") return message;
          const original = messages.get(`${scope}:${fingerprint(message)}`);
          if (!original) throw new Error("Kimi continuation unavailable");
          return structuredClone(original.message);
        }),
      };
      if (assistants.length) recency.set(scope, ++serial);
      return restored;
    },
    remember(message, scope = "legacy") {
      const size = Buffer.byteLength(JSON.stringify(message));
      const limit = 16 * 1024 * 1024;
      if (size > limit) throw new Error("Kimi continuation unavailable");
      const key = `${scope}:${fingerprint(message)}`;
      const previous = messages.get(key);
      // Retire whole least-recently-used scopes, never part of a current turn.
      // An evicted scope cannot be resumed with incomplete native reasoning.
      while (
        messages.size + (previous ? 0 : 1) > 64 ||
        bytes - (previous?.bytes ?? 0) + size > limit
      ) {
        const oldest = [...recency]
          .filter(([id]) => id !== scope)
          .sort((a, b) => a[1] - b[1])[0]?.[0];
        if (oldest === undefined)
          throw new Error("Kimi continuation unavailable");
        this.clear(oldest);
      }
      messages.set(key, {
        scope,
        bytes: size,
        message: structuredClone(message),
      });
      bytes += size - (previous?.bytes ?? 0);
      recency.set(scope, ++serial);
      return { ...message, content: visibleContent(message) };
    },
  };
}
