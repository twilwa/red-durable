import { createHash } from "node:crypto";
import {
  normalizeContext,
  getInitialSystemMessage,
  resolveTranscript,
} from "@earendil-works/pi-ai/utils/transcript";
import {
  contentText,
  getSystemMessageText,
} from "@earendil-works/pi-ai/utils/text";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";

const ARCHIVE_SECTIONS = new Set(["red_archive", "red_compact"]);
const BLOCK_CHARS = 4096;
const ephemeral = () => ({ type: "ephemeral" });

/** A deliberately conservative transport capability matrix, not a cache-hit
 * promise. Unknown models keep provider-managed caching with no speculative
 * controls. Go cannot enter the general companion inference path. */
export function cacheCapability(provider, model) {
  if (provider === "openai" && model.api === "openai-responses")
    return { mode: "implicit", promptKey: true };
  if (provider === "openrouter")
    return {
      mode:
        /^anthropic\/claude-/.test(model.id) &&
        (model.api === "anthropic-messages" ||
          (model.api === "openai-completions" &&
            model.compat?.cacheControlFormat === "anthropic"))
          ? "anthropic-breakpoints"
          : "provider-managed",
      header: "x-session-id",
    };
  if (provider === "opencode-zen")
    return {
      mode:
        /^claude-/.test(model.id) && model.api === "anthropic-messages"
          ? "anthropic-breakpoints"
          : /^gpt-/.test(model.id) && model.api === "openai-responses"
            ? "implicit"
            : "provider-managed",
      promptKey: /^gpt-/.test(model.id) && model.api === "openai-responses",
      header: "x-opencode-session",
    };
  return { mode: "disabled" };
}

/** The key is an opaque routing hint, never an authorization boundary. Provider
 * account isolation is still enforced by its authenticated API. No prompt,
 * account name, credential, lease, clock, or token count enters new scoped keys.
 * Legacy jobs hash their existing (possibly content-derived) job ID solely to
 * avoid the previous host-wide shared identity. */
export function cacheIdentity({
  hostId,
  accountNamespace,
  provider,
  model,
  job,
}) {
  return (
    "red-v1-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          hostId,
          accountNamespace,
          provider,
          model.api,
          model.id,
          job.cache?.namespace ?? `legacy-job:${job.id}`,
          job.cache?.purpose ?? (job.summary ? "summary" : "conversation"),
        ]),
      )
      .digest("hex")
      .slice(0, 56)
  );
}

/** Reconstruct Pi's exact leading text, including section replay on adapters
 * without native mid-conversation system support. Never locate boundaries by
 * searching untrusted archive strings. If pinned serialization changes, skip
 * breakpoints rather than mislabeling text or reordering instructions. */
export function cacheSystemSegments(context, model) {
  const normalized = resolveTranscript(
    normalizeContext(context),
    model.compat?.supportsMidConvoSystemMessages === true,
  );
  const head = getInitialSystemMessage(normalized.messages);
  if (!head) return null;
  const parts = [];
  const base = contentText(head.content);
  if (base) parts.push({ text: base, kind: "base" });
  let archiveSeen = false;
  let volatileSeen = false;
  for (const [name, value] of Object.entries(head.sections ?? {})) {
    if (value === null || value.length === 0) continue;
    const archive = ARCHIVE_SECTIONS.has(name);
    if (
      (archive && (archiveSeen || volatileSeen)) ||
      (!archive && name !== "red_volatile" && archiveSeen)
    )
      return null;
    archiveSeen ||= archive;
    volatileSeen ||= name === "red_volatile";
    parts.push({
      text: value,
      kind: archive ? "archive" : volatileSeen ? "volatile" : "base",
    });
  }
  if (!archiveSeen) return null;
  const result = { base: "", archive: "", tail: "" };
  for (const [index, part] of parts.entries()) {
    const key = part.kind === "volatile" ? "tail" : part.kind;
    result[key] += (index ? "\n\n" : "") + part.text;
  }
  for (const key of Object.keys(result))
    result[key] = sanitizeSurrogates(result[key]);
  const text = sanitizeSurrogates(getSystemMessageText(head));
  if (result.base + result.archive + result.tail !== text) return null;
  return { ...result, text };
}

function splitStableText(text) {
  // Code-point boundaries preserve supplementary Unicode. Earlier full chunks
  // stay byte-identical on append; only the last partial chunk changes. This is
  // a wire representation only: originals and OptMem nodes are never edited.
  const chars = Array.from(text);
  const blocks = [];
  for (let i = 0; i < chars.length; i += BLOCK_CHARS)
    blocks.push({
      type: "text",
      text: chars.slice(i, i + BLOCK_CHARS).join(""),
    });
  return blocks;
}

function explicitSystemBlocks(segments) {
  const blocks = [];
  if (segments.base)
    blocks.push({
      type: "text",
      text: segments.base,
      cache_control: ephemeral(),
    });
  const archive = splitStableText(segments.archive);
  // At most three breakpoints (base, preceding full chunk, current archive).
  // Anthropic's lookback can reuse older matching block boundaries on append.
  for (const index of new Set([archive.length - 2, archive.length - 1]))
    if (index >= 0) archive[index].cache_control = ephemeral();
  blocks.push(...archive);
  if (segments.tail) blocks.push({ type: "text", text: segments.tail });
  return blocks;
}

/** Called after Pi's serializer. Retention is pinned to "none" in Pi so no
 * ambient cache settings, tool breakpoint or last-user marker competes with
 * this explicit provider-specific policy. No TTL override/extended write tier. */
export function cachePayload(
  payload,
  { provider, model, context, key, enabled = true },
) {
  const result = structuredClone(payload);
  // Never let pinned SDK defaults request unverified/extended caching controls.
  delete result.prompt_cache_key;
  delete result.prompt_cache_retention;
  delete result.prompt_cache_options;
  const capability = cacheCapability(provider, model);
  if (!enabled || capability.mode === "disabled") return result;
  if (capability.promptKey) result.prompt_cache_key = key;
  if (capability.mode !== "anthropic-breakpoints") return result;
  const segments = cacheSystemSegments(context, model);
  if (!segments) return result;
  if (model.api === "anthropic-messages") {
    if (
      result.system?.length === 1 &&
      result.system[0]?.type === "text" &&
      result.system[0].text === segments.text
    )
      result.system = explicitSystemBlocks(segments);
  } else {
    const first = result.messages?.[0];
    if (
      ["system", "developer"].includes(first?.role) &&
      first.content === segments.text
    )
      first.content = explicitSystemBlocks(segments);
  }
  return result;
}
