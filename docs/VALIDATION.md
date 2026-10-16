# Validation checkpoint — 2026-10-09

This is a development checkpoint, not a production-readiness certification.

## Passed

- TypeScript check for the main app.
- 67 automated tests: 58 Node tests and 9 Vitest release tests.
- Prettier formatting check.
- Wrangler **dry-run** bundling: approximately 4,680 KiB raw / 872 KiB gzip, with the expected SQLite DO, static assets and Worker Loader bindings.
- Separate TypeScript check and disabled-rollout dry run for the optional container controller.

### Actual local workerd tests

`test/runtime.mjs` ran the real Cloudflare local runtime, real Pi harness, actual Code Mode isolates and actual Durable Object facets. It verified:

1. Runtime startup and public health.
2. Missing-credential and cross-origin rejection.
3. Static app delivery and content-security policy.
4. No implicit paid inference when the subscription backend is absent.
5. Source staging, candidate validation, activation, stale-approval rejection and rollback; the facet's SQLite counter remains intact.
6. Code Mode calls a real capability connector.
7. Ambient outbound `fetch` from Code Mode is denied.
8. The active revision and facet database survive a stopped/restarted workerd process.
9. A simulated subscription result drives a real Pi tool call through Code Mode to a final assistant message; distinct owner/bridge credentials and chat request deduplication hold.
10. Conversation and archived messages survive a second process restart.
11. Attributed observations, proposed beliefs/commitments, owner acceptance, correction lineage and a persona charter work through the real HTTP/Code Mode routes.
12. The agent can inspect telemetry and pinned documentation, propose an evidence-linked skill, smoke-test its trigger, and have the owner activate it.
13. Charter, open commitments, corrected beliefs and active skills survive another process restart.

The model replies in these tests are deterministic fixtures. They establish protocol/runtime wiring, not model quality, real account access or autonomous task performance.

## Blocked or not performed

- **Visual browser QA:** automated Chromium launch is blocked by this execution host's socket permissions, including after an approved unsandboxed attempt. The separate cloud browser cannot reach the isolated local dev server; its URL policy disallows local file previews. No screenshot or desktop/mobile visual-pass claim is made. The optional `TEST_BROWSER=true` smoke remains available for a normal development machine.
- **Real ChatGPT sign-in/inference:** not attempted. No OAuth grants or credentials were created or transferred. Account model availability, subscription quota behavior, and fresh/rotated-session behavior need owner-authorized live checks.
- **Production Cloudflare deployment:** not performed. Dry-run output is not a deployed service.
- **Docker image execution:** unavailable here; the optional Cloudflare Container target remains a disabled integration scaffold.
- **Real held-out skill evaluation:** the evaluator is implemented and tested with fake predictors. It has not run against a real recorded dataset/model, and no TeleTune results have been reproduced.
- **Privacy retention/erasure:** no per-item erase or production backup/restore workflow exists yet. Corrections do not delete original history.
- **Whole-host self-redeployment:** the implemented update boundary is executable behavior/custom tools in a facet. It does not rewrite the protected Pi/authentication/memory supervisor.

## Reproduce

```sh
npm ci
npm run format:check
npm run check
npm run test:runtime
```

For browser-capable Linux hosts with Chromium installed:

```sh
TEST_BROWSER=true CHROMIUM_PATH=/usr/bin/chromium npm run test:runtime
```

For this restricted test host only, `TEST_LOOPBACK_ONLY=true` avoids unsupported network-interface enumeration while still binding workerd to 127.0.0.1. Runtime tests use fresh temporary storage and locally generated fake credentials. They do not use the owner's account.

## UI adaptation checkpoint — 2026-10-12

The browser interface now adapts the actual MIT-licensed Durable Pi playground
shell and interaction patterns, pinned to
`37165c619573dbaf425463038bbffecfe576beec`. The upstream Express/SDK runtime is not
imported. See [interface.md](interface.md) for the implementation boundary.

Verified against the updated source:

- Main app TypeScript and the new typed browser owner API adapter passed.
- **97 automated tests passed:** 88 Node tests and 9 Vitest release tests.
  This includes **32 UI event/state regression tests**, replacing the original
  two. They cover session isolation, abort/stale responses, lock cleanup,
  duplicate admissions and stable retry IDs, interrupted login, owner rejection,
  drafts typed during requests, charter conflicts, tab/keyboard/mobile panel
  state, safe literal rendering and explicit source/skill approval payloads.
  Post-review cases also lock after a transport or nested helper has fulfilled
  but before its caller resumes: private views, drafts, notices and approvals
  stay cleared, and old actions cannot start follow-on requests. Desktop-to-mobile
  resize cases preserve one panel and valid focus, with Escape restoring chat.
- Full Prettier check passed.
- Wrangler dry-run bundle passed, including all four static UI assets. No
  production resources were deployed. The host's default Wrangler log directory
  is unavailable; a disposable writable HOME/config directory was used for the
  dry run without loading any account credentials.
- The real local workerd test passed all 13 runtime checkpoints again, including
  durable restarts, actual facets/Code Mode, source promotion/rollback, simulated
  subscription inference, attributed continuity and skill activation.

Browser QA was attempted again with `TEST_BROWSER=true`. Chromium cannot create
its process-singleton socket on this execution host (`Operation not permitted`)
and closes before any page loads. The browser test now includes the new panel
navigation, charter-draft preservation, desktop/mobile views and Escape/Lock
cleanup, but these browser assertions and screenshots have **not run here**.
The synthetic DOM tests do not establish CSS layout, accessibility behavior in a
real browser or a desktop/mobile visual pass. No screenshot is claimed.

The changes do not add or bypass authentication, provision secrets, sign into a
provider, enable automatic activation, push a repository or deploy a service.

Host-compatible aggregate check used:

```sh
npm run format:check
HOME=/tmp/red-ui-build-home XDG_CONFIG_HOME=/tmp/red-ui-build-home \
  WRANGLER_SEND_METRICS=false npm run check
TEST_LOOPBACK_ONLY=true npm run test:runtime
```

## Private Discord transport checkpoint — 2026-10-12

The optional Discord text transport is implemented and **disabled by default**.
See [discord-transport.md](discord-transport.md) for its boundaries and the
owner-assisted live cutover. The existing UI checkpoint above remains valid.

Verified against the final reviewed source:

- Main and browser-adapter TypeScript checks passed.
- **160 automated tests passed:** 151 Node tests and 9 Vitest release tests.
  The new transport coverage comprises **39 queue/protocol tests** and
  **24 relay tests**, including actual SQLite file close/reopen, interrupted
  writes, fixed identity/credential validation, bounded queues, immutable retry
  payloads, safe chunking/mentions, stale leases, offline-by-default behavior,
  fake Gateway heartbeat/resume, rate limits and conservative send uncertainty.
- All **20 real-workerd checkpoints** passed. The original 13 remain; seven
  additional checkpoints exercise disabled routes, owner/bridge/relay privilege
  isolation, invalid sender/channel input, durable ingress while browser
  inference is busy, restart recovery, real Code Mode execution within the
  Discord turn, final-text-only outbox routing, stable-nonce delivery receipts
  and later-browser output isolation. Model outputs remain synthetic fixtures.
- Independent review reproduced and verified fixes for three availability/
  correctness bugs: whitespace-only chunks rejected by the relay, a Gateway
  receipt racing a pending retry response, and a delayed inbox head allowing
  later conversation messages to overtake it. All 63 focused transport tests
  and the original race/reopen reproductions passed independently afterward.
- Full formatting, Node relay syntax checks and `git diff --check` passed.
  Wrangler dry-run bundling passed at approximately 4,698 KiB raw / 876 KiB
  gzip. No new package dependencies were added.
- `npm run discord:check` with the default environment exits with a disabled
  status and performs no service request or journal creation.

No real Discord token, account, Gateway, channel permission, Message Content
grant, production Worker, subscription inference, host service or message
delivery has been tested or configured. No service installation, secret
provisioning, push or deployment occurred. The all-Cloudflare Container target
remains disabled. This is not an exactly-once delivery or production-readiness
certification. Browser visual QA remains blocked/unclaimed as described above;
the optional Chromium stage was not rerun for this backend-only change.

Host-compatible final aggregate:

```sh
npm run format:check
HOME=/tmp/red-discord-build-home XDG_CONFIG_HOME=/tmp/red-discord-build-home \
  WRANGLER_SEND_METRICS=false npm run check
TEST_LOOPBACK_ONLY=true npm run test:runtime
git diff --check
```

## Setup portability follow-up — 2026-10-12

- The optional Playwright stage now opens the login form's **Session settings**
  disclosure when the session field is hidden, waits for visibility, then fills
  the session. This corrects the collapsed-field timeout observed on the Mac.
- Both project formatting scripts now pass `--no-editorconfig`, preventing a
  parent/home EditorConfig from changing the project's expected indentation.
  A temporary parent configuration requiring tabs reproduced the failure without
  the flag; the same unchanged, space-indented probe passed with the flag.
- Only `package.json`, the browser section of `test/runtime.mjs`, and this note
  changed for this follow-up. A before/after source hash comparison confirmed no
  app-source formatting churn. The full 160-test suite, both typechecks,
  formatting and dry-run bundle passed again.

The optional Chromium stage itself was not run on this cloud host. The harness
fix still needs a browser-capable Mac rerun before claiming that stage passed.
No application, authentication, credentials or live Mac state changed here.

## Trusted-host provider setup checkpoint — 2026-10-14

Provider onboarding is implemented in a separate loopback bridge UI, leaving the
existing Wrangler dev process and runtime state alone. ChatGPT uses the official
public OAuth/Responses flow with signed ID-token validation and saved client
registration. OpenRouter and OpenCode Zen use owner-entered API keys; metered
selection requires explicit approval for conversation and background memory use.
Go is displayed but unavailable because this companion does not yet isolate
coding-only sessions. See [providers.md](providers.md).

Verified on the final source:

- Both main-app and typed browser API TypeScript checks passed.
- **246 automated tests passed: 237 Node tests and 9 Vitest tests.** This includes
  52 UI event/state tests, 23 signed OAuth tests, 25 provider runtime tests and eight
  independent review regressions. All account credentials and model replies are
  synthetic fixtures.
- Official OAuth tests cover PKCE/state/nonce, signature/issuer/audience/expiry,
  registration reuse and subject pinning, denial, timeout/cancel at callback,
  token exchange/JWKS/body reads, rotating refresh and bounded responses.
- Provider tests exercise exact service/model routing, no ambient credentials,
  fixed inference URL allowlists, current Zen endpoints, fair bounded catalogs,
  API-key validation without a paid generation, cancellation before flow-ID
  creation and during persistence, reconnect/removal, expiry and error redaction.
  Actual pinned Pi adapters consume synthetic streamed Responses/function-call
  fixtures and replay tool results through the public ChatGPT payload format.
- Independent review reproduced and fixed early-login cancellation, status reads
  during live credential rotation, legacy OAuth metadata mistakenly creating an
  uncertain-refresh marker, large-history proxy rejection and one provider
  starving another from the bounded catalog. It also verifies oversized proxy
  bodies are cancelled while streaming. Actual OpenAI/Anthropic SDK regressions
  also verify that inherited debug logging cannot expose provider response
  bodies or conversation content; ambient custom/admin credentials are ignored
  and unrelated organization/project headers are stripped.
- All **21 real-workerd checkpoints passed**, including the existing 20 and a new
  provider boundary checkpoint: hosted credential writes reject, bridge tokens
  cannot access owner provider state, metered model selection requires explicit
  consent, and Go model IDs reject. Real Pi/Code Mode/facets, durable restarts,
  owner/bridge/relay separation and disabled-by-default Discord behavior remain
  covered with simulated model output.
- Full Prettier checks, bridge/harness syntax checks and `git diff --check` passed.
  Wrangler dry-run bundling passed at approximately 4700 KiB raw/876 KiB gzip.
  No production deployment, account grant, secret import or spend occurred.

**Browser QA remains blocked here.** The actual new
`npm run test:provider-browser` harness was attempted; installed Chromium failed
before any page loaded because its process-singleton socket was not permitted
(`Operation not permitted`). No provider screenshot or desktop/mobile visual
pass is claimed. The harness is ready for a browser-capable machine: it uses a
fresh browser context, actual local setup server on an ephemeral port, injected
fake providers/upstream, and blocks every external browser request. It does not
read local credentials, start Wrangler or touch an existing dev server.

**Live provider verification remains unperformed.** No real ChatGPT sign-in,
renewal, account entitlement, live inference, OpenRouter key, Zen key, provider
quota or billing outcome has been tested. OpenRouter OAuth is not exposed by this
release. Zen Gemini is excluded because the pinned Google adapter cannot use
the required redirect-denying transport. Local removal does not revoke remote
provider grants. Hosted onboarding/Cloudflare Container deployment remains out
of scope and disabled.

Reproduce offline validation:

```sh
npm run format:check
HOME=/tmp/red-provider-build-home XDG_CONFIG_HOME=/tmp/red-provider-build-home \
  WRANGLER_SEND_METRICS=false npm run check
TEST_LOOPBACK_ONLY=true npm run test:runtime
git diff --check
```

On a normal browser-capable machine in an isolated checkout:

```sh
npm ci
npm run test:provider-browser
```

Set `CHROMIUM_PATH` if the installed Chromium/Chrome is not in the harness's
standard macOS/Linux location. Successful synthetic browser QA still does not
establish a real subscription or API-key connection.

## Local development launcher follow-up — 2026-10-15

`npm run bridge:dev` now reads this checkout's existing `.dev.vars` privately and
maps `OWNER_TOKEN`/`BRIDGE_TOKEN` into the bridge's in-memory configuration. It
defaults to the local Wrangler origin, default session and separate setup port;
explicit overrides remain supported. There is no second credential file,
credential migration, printed token, shell evaluation or change to production
`bridge:serve`. Relative paths are anchored to the checkout rather than the
calling shell's directory. Setup documentation now uses the visible **Providers**
tab label.

Nine additional synthetic launcher tests cover defaults, explicit precedence,
blank/missing/short/equal credentials, target/session/port conflicts, inert dotenv
content, redacted failures, no environment/file mutation and working-directory
independence. The final aggregate is **255 tests: 246 Node and 9 Vitest**; both
TypeScript checks, full formatting and dry-run bundling pass. Independent review
also reran the launcher, server and provider-security boundary fixtures. No real
`.dev.vars` values were loaded or used during these tests.

Separate isolated Mac browser QA passed for source commit
`931859da500c384c2e1779ba6d1c5183d5f5da9c`, using desktop 1280×960 and
mobile 390×844 Chrome views. It covered repeated clicks, cancellation, expiration,
unsafe auth URL rejection, secret clearing, metered approval/model switches,
local removal, focus/mobile behavior, empty browser storage and no external
requests or page errors. The UI, browser transport and fake-provider harness
files are byte-identical in this launcher follow-up, so that browser evidence
carries forward. The cloud host's Chromium launch restriction described above
remains; real account consent and provider inference remain untested. The Mac's
existing development process and live source were left untouched during that
isolated QA.

## Provider prefix-cache checkpoint — 2026-10-16

The trusted-host bridge now has explicit, conservative cache capabilities for
ChatGPT public Responses, OpenRouter, and supported OpenCode Zen routes. Go
remains disabled. See [prompt-caching.md](prompt-caching.md) for exact controls,
cache-write pricing caveats, isolation, the off switch, and limits.

Verified against this checkpoint:

- **289 automated tests passed: 280 Node tests and nine Vitest release tests.**
  New tests cover actual pinned provider request serialization, allowed/omitted
  cache fields and routing headers, tool-round replay, synthetic streamed cache
  counters, namespace isolation and reconnect, legacy jobs, malformed scopes,
  failed/corrupt namespace storage, ambient retention suppression, and the off
  switch. Prompt tests cover Pi section/tool semantics, byte-stable prefixes,
  Unicode, appends, compaction invalidation, exact originals, and real SQLite
  close/reopen. Telemetry tests cover legacy rows, bounded numeric allowlists,
  retention, exact totals, reopen and no prompt/key leakage.
- Independent review found no blocking correctness or security defects and
  passed 75 focused/provider-security regressions. Its additional actual Pi
  Claude Chat Completions serialization case was added to the permanent tests.
- Both TypeScript checks, full Prettier and `git diff --check` passed. Pinned
  dependencies remain unchanged. Wrangler dry-run bundling passed at approximately
  4754 KiB raw / 879 KiB gzip. No deployment occurred.
- **All 22 real-workerd checkpoints passed.** The new checkpoint verifies actual
  Pi prompt-section ordering, durable cache scope and synthetic read/write token
  telemetry. Existing real Pi deferred calls, Code Mode isolation, facets,
  lifecycle restarts, exact archive continuity, approvals, provider selection and
  private Discord boundaries still pass. A runtime test-only assertion initially
  queried telemetry from the wrong owner endpoint; it was corrected to the
  existing `/api/skills` endpoint, then the entire runtime harness passed.

The stable prompt layout changes only outgoing requests. The stored originals,
OptMem merge algorithm, charter authority, approved skills/facet activation,
credential separation, metered acknowledgement and no-fallback policy remain.
Cache routing identity is distinct from durable job idempotency and leases;
conversation and background summary identities are separated.

**Not verified live:** provider cache hits, token thresholds, TTL/eviction,
upstream affinity, real subscription quota savings, billing or latency. All
provider streams and account records in these tests are synthetic. No sign-in,
credential import, real inference, paid generation, remote push or production
change was performed. No browser/UI files changed; optional browser visual QA
was not rerun for this backend/prompt-only checkpoint.

Reproduce:

```sh
npm run format:check
HOME=/tmp/red-prefix-build-home XDG_CONFIG_HOME=/tmp/red-prefix-build-home \
  WRANGLER_SEND_METRICS=false npm run check
TEST_LOOPBACK_ONLY=true npm run test:runtime
git diff --check
```
