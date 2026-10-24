# red-durable

A personal, persistent AI companion built on Pi Durable and Cloudflare Durable Objects. It has a recoverable conversation, an evidence-linked memory tree, a versioned persona charter, commitments, operational self-inspection, and a bounded ability to rewrite its executable behavior.

**Status: locally tested development prototype. Not deployed, signed in, or production-certified.** The subscription bridge has been tested using simulated model responses; no live subscription inference has been claimed. The optional Cloudflare Container target is an explicitly disabled integration scaffold.

## Architecture

```text
Private browser UI
        │ owner authentication
        ▼
Cloudflare Worker → one RedAgent Durable Object per personal session
                       ├─ Pi Durable harness / alarm recovery
                       ├─ append-only originals + OptMem summary tree
                       ├─ persona charter, evidence, beliefs, commitments
                       ├─ bounded telemetry + proposed/active skill versions
                       ├─ isolated Code Mode → named capabilities only
                       ├─ versioned MutableAgent facet, its own SQLite
                       └─ durable inference queue
                                      ▲
                       outbound HTTPS poll/result
                                      │
                       personal Node/Pi subscription bridge
                       Mac or self-hosted cloud VM
                       OAuth session stays on that host
```

The bridge calls the model. Tools execute in the Durable Object under separate capability controls. The bridge credential cannot use owner activation routes. A laptop is not required during operation when the bridge runs on a personal cloud VM.

## Browser interface

A conversation-first desktop/mobile interface is included. Optional navigation
and an **About red** inspector expose personality, attributed memories,
commitments, learned skills, behavior-revision review and connection details.
The same session name returns to the same Durable Object on every device.

Its layout and interaction patterns adapt IndyDevDan's MIT-licensed Durable Pi
playground, with attribution retained. red keeps its own protected owner API and
in-memory-only token handling. See [interface.md](docs/interface.md) for the
adaptation boundary, interaction guarantees and remaining limitations.

## Current capabilities

- **Pi Durable:** persisted submissions, deferred inference, tools, resumable work and background maintenance. Operation IDs deduplicate repeated chat submissions.
- **OptMem/UniiChat memory:** exact stored originals, contextual binary summaries, stable IDs, `zoom` and `date`, persisted 128 KB → 64 KB view, and separate compactor view. The model sees bounded context and can retrieve finer evidence.
- **Companion continuity:** an owner-versioned charter; attributed observations; facts versus hypotheses; correction lineage; explicit commitments with evidence and state. A remembered claim or commitment never grants new tool permission.
- **Self-inspection:** bounded operational telemetry with no raw credentials, prompts, or private reasoning. Pinned Pi documentation is available through paged tools.
- **Skill learning:** descriptions specify when and when not to invoke a skill. Proposals include evidence, positive/negative routing examples, immutable revisions, smoke tests, owner review and reversible activation. Full instructions load on demand. The offline held-out evaluator is a preparation tool; real-model improvement has not been measured.
- **Self-modification:** the agent can read, write and validate executable JavaScript revisions for its `MutableAgent` facet. The owner reviews and activates them. The facet database survives promotion and code rollback.
- **Provider-specific prefix caching:** deterministic instruction/archive prefixes, isolated conversation/summary routing keys, native short-lived Claude breakpoints and truthful cache-token telemetry. Hits, retention and billing remain provider/model-dependent; see [prompt-caching.md](docs/prompt-caching.md).
- **Explicit provider choice:** ChatGPT remains the default. Kimi Code offers K3.1 Pro through an owner-supplied membership key, alongside owner-opted-in OpenRouter and OpenCode Zen keys on the trusted host. Metered model selection requires an explicit acknowledgement. Missing sign-in, quota problems, and offline inference never trigger provider fallback.

- **Bounded agent-owned experiments:** owner-armed, disabled-by-default isolated source proposal/test loops with durable dispatch/tool budgets and scoped stop. No automatic activation; see [experiment sessions](docs/experiment-sessions.md).

### The self-update boundary

The mutable facet contains executable custom tools and behavior instructions. It has its own database, no ambient network, and no account credentials. The supervisor keeps authentication, Pi, memory, release controls and recovery outside that mutable code.

This is a real runtime facet replacement, **not a deployment of a new supervisor Worker or Pi package**. Updating those requires a normal reviewed build/deploy. Code rollback does not undo data migrations. An untrusted revision's health response is a contract smoke test, not proof that all of its behavior is correct.

## Run without connecting an account

Requires Node 24 and npm. From this directory:

```sh
npm ci
npm run check
npm run test:runtime
npm run dev
```

No test signs in, invokes a paid model, or deploys resources. `build` is a Wrangler dry run. The runtime smoke test launches local workerd, uses disposable fake owner/bridge credentials, exercises actual facets and Code Mode, and simulates model replies.

Some restricted Linux hosts cannot enumerate network interfaces. For that specific test-host limitation, use `TEST_LOOPBACK_ONLY=true npm run test:runtime`; the test helper declares only the loopback interface for Wrangler and binds locally. This is not required on a normal workstation.

For an authenticated local UI, copy `.dev.vars.example` to `.dev.vars` and privately fill two **different**, random credentials of at least 32 characters. Blank values intentionally fail closed. The owner token stays in the browser tab's memory rather than persistent browser storage. Never paste credentials into chat or commit them. Without a subscription bridge, model execution remains unavailable; local tests remain runnable.

## Connect providers in the local UI

Keep `npm run dev` running. In a second terminal, run `npm run bridge:dev`.
It privately reuses the two tokens already in this project's `.dev.vars`, without
copying or printing them. Open its printed loopback URL and
**About red → Providers**. ChatGPT uses
owner-operated browser sign-in; Kimi Code, OpenRouter and OpenCode Zen use locally stored
API keys. Kimi Code offers `k3.1-pro` and keeps conversation and background jobs
on the selected subscription route. Review its usage restrictions before enabling it. Saving a key does not choose a model. Go remains unavailable until
coding-only sessions can be isolated from general companion/memory traffic.

See [providers.md](docs/providers.md) for exact setup, billing acknowledgements,
security boundaries and cloud-host limitations. No credentials are created,
imported, transferred or used by installation or automated tests.

## Connect the outbound inference process

Read [subscription-bridge.md](docs/subscription-bridge.md). It documents interactive owner consent, fixed provider selection, protected credential storage, model discovery, single refresh ownership, quota handling, and a personal VM/Docker setup.

1. Prepare the Worker and separate owner/bridge credentials privately.
2. Complete ChatGPT sign-in yourself on the trusted subscription host using the documented process.
3. Run the outbound bridge for the desired session.
4. In the private UI, choose a model advertised by the signed-in account.
5. Send a small test message, then verify a restart before enabling longer work.

The model catalog and plan allowance belong to the actual account. Subscription-backed does not mean unlimited or zero infrastructure cost. The application does not enable credit purchases or top-ups. OpenRouter and Zen are explicit model choices only, never fallback routes.

A personal self-hosted VM is the documented cloud runtime path. [cloud-subscription-host.md](docs/cloud-subscription-host.md) explains the optional all-Cloudflare Container design, its costs, and unfinished onboarding/storage integration. **Do not deploy that scaffold expecting a working subscription host.**

## Optional private Discord conversation

A disabled-by-default text transport can connect the existing MarkOne bot
identity to a single owner-only Discord channel. A separate Node relay on the
trusted host uses a narrow third credential, a durable inbox/outbox, isolated
conversation turns and explicit delivery receipts. Public Hermes remains a
separate bot. See [discord-transport.md](docs/discord-transport.md) for the
security boundary, staged setup and unverified live cutover steps. No Discord
account or channel has been connected by this source change.

## Deployment preparation

The default target is `wrangler.jsonc`: one SQLite-backed Durable Object class, static assets and Worker Loader. No Cloudflare account ID or credentials are included. Review the name, account, resource availability and costs before deployment.

The owner must configure secrets and authorize deployment in their own account. Existing Wrangler authentication on another computer is not automatically available here. The optional container configuration is separate and is not enabled by the default target.

There is no public repository push, infrastructure purchase, OAuth grant, secret provisioning, or production deployment bundled into this source delivery.

## Review and recovery

- Use **About red → Memory** to edit the charter and review proposed beliefs;
  **Work** holds commitments.
- Use **Changes** to inspect source, test a revision, then explicitly activate or roll back.
- Use **Skills** to review trigger descriptions, examples and evaluation provenance before activation.
- Stop a running turn before changing its model or behavior revision.
- A failed summary can require explicit retry after sign-in or quota recovery; do not assume an interrupted inference did not run.
- Keep exactly one bridge process responsible for a renewable OAuth session. Do not duplicate running credential directories.

## Important limits

- “Infinite memory” means an expanding stored history with bounded working context. Storage quotas, cost and retrieval quality remain finite. Summaries are lossy indexes; use originals to verify details.
- Summary generation is eventually consistent. A backlog can temporarily block new work rather than silently discard history.
- Prefix caching depends on the selected provider/model, matching content, token thresholds, retention and routing. No live cache-hit, latency, billing or subscription-quota improvement has been measured.
- There is no per-item erasure/retention UI yet. Corrections preserve history; they do not delete originals from Pi or memory storage. Do not import data you cannot retain under this limitation.
- No production backup/restore workflow, external messaging channels, voice, arbitrary shell, or autonomous outbound action permissions are configured.
- The starter facet offers a small persistent counter as a demonstrable extension contract. Useful custom tools are authored through the same tested revision mechanism.
- Live provider sign-in/inference remains untested. The bridge wraps Pi with an official JWT-validated ChatGPT OAuth flow; see provider documentation for the remaining account/host limitations.
- The app is single-owner with separate named sessions, not a multi-tenant identity system.
- Executor is optional and not connected. See [EXECUTOR.md](docs/EXECUTOR.md); local Codex MCP configuration does not connect the deployed agent.

## Sources and design

- [Victor Taelin's OptMem/UniiChat gist](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449)
- [Cloudflare Pi harness](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)
- [Code Mode](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
- [Pi source](https://github.com/earendil-works/pi)
- [TeleTune paper](https://arxiv.org/abs/2610.05437)
- [ChatGPT plan usage](https://developers.openai.com/siwc/token-sharing-open-source)

The companion continuity model also draws on the owner's supplied design research, especially separating events, interpretations, commitments, and authority. That research is not included as personal history. The linked inspiration tweet could not be independently retrieved; its contents are not claimed as verified.
