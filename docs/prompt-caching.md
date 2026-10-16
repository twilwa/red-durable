# Provider-specific prefix caching

The trusted-host bridge now sends cache-friendly prompts and narrowly supported
provider hints. This is an optimization of inference requests, not a local answer
cache, a new provider, a memory replacement, or a guarantee of cache hits.
Subscription-only defaults, exact provider/model selection, explicit metered
approval, and no fallback remain unchanged. Go stays disabled for general
companion and memory traffic.

## Supported routes

| Route                                                                                                                                  | What red sends                                                                                         | Limits                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT sign-in, public OpenAI Responses                                                                                               | Stable opaque `prompt_cache_key` and deterministic prompt prefix                                       | Provider/model-managed caching. SIWC rejects `prompt_cache_retention`; explicit cache options and breakpoints are unverified for this route and are not sent. No claim about subscription quota savings.                                                    |
| OpenRouter Claude on Anthropic Messages, or a pinned Claude Chat Completions adapter that explicitly supports Anthropic cache controls | Stable `x-session-id` plus up to three `cache_control: {type: "ephemeral"}` system/archive breakpoints | Native short retention, normally five minutes. Eligibility, token minimums, eviction, upstream routing and prices are provider/model-dependent.                                                                                                             |
| Other supported OpenRouter models                                                                                                      | Stable `x-session-id` and stable prompt layout                                                         | Provider-managed caching only; no speculative model-specific flags. Sticky routing is best effort. Existing `allow_fallbacks: false` and `require_parameters: true` on the Chat Completions route remain; this does not globally pin one upstream endpoint. |
| OpenCode Zen Claude on Anthropic Messages                                                                                              | Stable `x-opencode-session`, genuine red client User-Agent, and native short Anthropic breakpoints     | Supported protocol/client behavior, not a live-verified cache-hit promise.                                                                                                                                                                                  |
| OpenCode Zen GPT on Responses                                                                                                          | Stable `x-opencode-session`, genuine red client User-Agent, and native `prompt_cache_key`              | No requested OpenAI retention, explicit cache mode, or breakpoint extension.                                                                                                                                                                                |
| Other supported OpenCode Zen models                                                                                                    | Stable session routing and prompt layout                                                               | Provider-managed only. No assumption that every open model supports caching.                                                                                                                                                                                |
| OpenCode Go                                                                                                                            | No requests                                                                                            | Remains unavailable until the companion enforces eligible coding-only sessions.                                                                                                                                                                             |

No forced OpenAI cache writes, premium one-hour Anthropic retention, new endpoint,
model fallback, extra warm-up call, or cache management API is enabled. Native
Anthropic cache creation can cost more than ordinary input (commonly 1.25× for
five-minute writes), while reads can cost less. The previous pinned Pi adapter
already sent short-retention markers; this change replaces its moving system,
last-tool and last-turn markers with bounded stable-prefix markers. Actual
charges, break-even reuse and subscription allowances are not inferred from
local tests or the model registry. Small or infrequently repeated prompts may
not benefit.

## Prompt layout and invalidation

Conversation requests preserve Pi's system-section and tool-declaration semantics:

1. Protected instructions, approved behavior suffix, approved charter and active
   skill triggers, with the existing ordered tool declarations
2. The deterministic OptMem archive view
3. Current continuity evidence and transport details, such as the Discord
   attachment count
4. The current conversation and tool rounds

The `red_archive` and `red_volatile` named sections are added only to the outgoing
request. No random request IDs, wall-clock text, cache keys, lease IDs or usage
counts are added to the prompt. Existing message timestamps remain protocol data;
the pinned serializers do not include them in provider text. Changing user input,
continuity or attachment counts therefore does not rewrite the preceding stable
archive prefix. Updating instructions, charter, active skills or tool schemas
correctly changes the corresponding prefix; cache routing keys are hints and
never bypass exact content matching.

Summary requests have a separate stable instruction and compact-view section
(`red_compact`) followed by the changing source as a user message. Related summary
jobs can reuse a matching compact prefix even though durable request IDs still
identify each exact summary operation and explicit retry.

Anthropic payloads split the verified serialized archive text into deterministic
4096-code-point blocks. Code-point boundaries preserve Unicode; block lengths are
not token estimates. Up to three short-lived breakpoints mark the stable base,
the preceding complete archive block and the current archive end. The volatile
section and current user message are never marked. Complete earlier blocks can
match after append; the final partial block, including the moving closing archive
tag, normally changes. These are wire-only blocks, not new memory nodes. If the
pinned serializer's output does not exactly match the reconstructed system text,
the adapter leaves the payload intact and skips explicit breakpoints.

OptMem's tree, merge scheduling, stable IDs, causal context and exact originals
are unchanged. Compaction or a newly available summary changes the affected
archive suffix and may make it cold again; an unchanged preceding prefix can
still be reused. The retained view and cache namespace survive durable restart.
Cache expiry or eviction is normal. No result or memory is taken from a local
response cache.

## Isolation and compatibility

Every Durable Object lazily persists an opaque UUID in its existing bridge config
table. New jobs carry only a validated version, this namespace and the purpose
(`conversation` or `summary`). The bridge hashes that namespace together with its
host ID, provider connection epoch, exact provider/API/model and purpose into a
63-character opaque routing key. New scoped keys never hash or embed credentials, account
names, prompt content, source hashes, clocks, run IDs or token counts.

Provider connection epochs live in the private `prompt-cache.json` beside the
existing bridge store. Reconnect/replacement and local disconnect rotate them;
ordinary OAuth token refresh does not. Durable jobs preserve their scope across
lease renewal and explicit retry. Different Durable Objects, providers, models,
API protocols and conversation/summary purposes receive different keys. Legacy
queued jobs without scope still run, with a conservative per-job identity rather
than the former host-wide shared key. This compatibility path hashes the existing
job ID, which can itself be a content digest; it cannot reuse a prefix across
different legacy jobs.

These keys improve routing isolation; they are not access controls. The provider
still enforces its own authenticated account and cache isolation. No cache key,
prompt hash, namespace, credential or prompt text is added to operational
telemetry or the result journal. Existing journaled assistant outputs and tool
calls retain their established behavior.

## Disable explicit hints

The default is `RED_PROMPT_CACHE=auto`. To omit explicit cache keys and breakpoints
on a trusted-host bridge:

```sh
RED_PROMPT_CACHE=off npm run bridge:dev
```

The same variable works with `bridge:run` and `bridge:serve`; the dev launcher also
accepts it in this checkout's private `.dev.vars`. Only `auto` and `off` are valid.
Stable session-routing headers and prompt layout remain. This switch cannot
purge or disable caching that a provider performs automatically. Pi's ambient
`PI_CACHE_RETENTION` is always overridden, so an inherited `long` setting cannot
silently enable extended retention.

## Observability and verification

Assistant `model_end` telemetry now includes bounded `cacheReadTokens` and
`cacheWriteTokens` from the provider adapter, and retained-event totals. The
adapter's `input` count is uncached input; cache reads/writes are separate. Current
summary usage is retained in its existing bridge result but is not included in
conversation `model_end` totals. No hit percentage, billed savings, cache lifetime
or subscription quota reduction is invented. A zero can mean no reported usage:
Pi substitutes zero when a provider omits cache counters.

Offline fixtures exercise actual pinned OpenAI Responses, Anthropic Messages and
Chat Completions serialization and synthetic streamed read/write usage. Real
SQLite tests cover namespace persistence, retries, reconnect isolation,
append/compaction and exact original recovery. The real workerd smoke checks
prompt-section order, durable scope and synthetic cache-token telemetry.

No real provider account, cache hit, quota effect, billing outcome or latency
improvement has been measured. A live comparison would require separate owner
participation and the same sufficiently long repeated prompt on an authorized
provider; it is not part of installation, tests or this delivery.

## Primary references

- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [ChatGPT token-sharing preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenCode model prompt caching](https://opencode.ai/v2/docs/models/#prompt-caching)
- [OpenCode Console models and protocol routes](https://opencode.ai/v2/docs/console/models/)
- [OpenCode first-party session request source](https://github.com/anomalyco/opencode/blob/bc5ebf00a4c169ece10f276e6ce02eaf18c326e6/packages/core/src/session/model-request.ts)
- [OpenCode Go usage restrictions](https://opencode.ai/v2/docs/console/go/)
