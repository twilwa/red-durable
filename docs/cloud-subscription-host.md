# Cloud-only subscription host: architecture and verification

Reviewed 2026-10-09. The durable companion can live in the cloud without an always-on laptop. A personal Linux VM running `bridge/Dockerfile` is the simpler deployment path. Cloudflare-only hosting is technically plausible, but the optional target in this repository is an intentionally disabled **integration scaffold**, not a working authenticated companion.

## Architecture choices

1. **Cloudflare durable agent + personal cloud VM bridge:** existing outbound polling bridge; VM owns OAuth refreshes, encrypted persistent disk, stable host ID, and private credential directory. No inbound bridge port is needed during ordinary inference. This keeps the laptop out of ongoing operation. Operator provisioning, actual login, and restart/inference verification are still required.
2. **All Cloudflare:** main Red Durable Object owns conversations, memory and job queue. A separate private `SubscriptionHost` DO controls exactly one Linux Container and encrypted credential vault. The trusted Node bridge runs in that Container. This replaces the VM, not the durable agent. Generated facets never receive vault bindings or credentials.

OpenAI explicitly documents remote self-hosted VMs. Its published onboarding procedure completes OAuth locally and securely transfers the selected registration, preserving the VM's own host ID. It assigns subsequent refresh ownership to that VM. That is evidence for a cloud runtime, not evidence that copying laptop credentials is necessary for every possible implementation. This project does not copy credentials. A direct cloud-host login requires a separately verified protected authorization flow. The docs do not clearly classify a personally controlled Cloudflare Container; neither express approval nor a blanket prohibition is established here. [Official VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)

Cloudflare's Container runs in a Linux VM controlled by a DO. Durable state can reside in DO storage; an ephemeral Container filesystem must not be the only credential store. [Container guide](https://developers.cloudflare.com/containers/get-started/) · [Lifecycle and limitations](https://developers.cloudflare.com/containers/faq/)

## What is implemented

- `optional/cloudflare/wrangler.jsonc`: isolated worker/container target, one `lite` instance maximum, no public workers.dev/preview URL, no logs. Default agent configuration is untouched.
- `optional/cloudflare/Dockerfile`: separate image packaging pinned by the project's package lock; no secrets, host identity, agent memories or generated facets copied. Node image tag should be digest-pinned before a production release.
- `optional/cloudflare/controller.ts`: protected, read-only `/status`; separate admin secret; encrypted-vault health; no token upload, login, refresh, arbitrary exec or container start route.
- `optional/cloudflare/vault.ts`: AES-256-GCM encrypted storage with fresh nonces and DO-ID scope binding; durable host identity; atomic refresh ownership and rotated credentials. No upstream network requests inside retried storage transactions. A failed/ambiguous refresh or failed final commit keeps a persistent recovery marker. A timer never silently releases ownership.
- `container-entry.mjs`: deliberately exits without inference. This prevents accidental use of ephemeral credential files or misleading apparent deployment success.

The vault is a trusted control-plane library, **not yet wired into the bridge's Pi CredentialStore interface**. It must not be installed as a model-callable tool. Its credential reader and refresh callback are trusted code only. At-rest encryption limits storage/snapshot disclosure; it does not protect against full compromise of the Cloudflare account, deployed trusted code, or the runtime that legitimately decrypts credentials.

## Required integration before activating the all-Cloudflare target

1. Build owner-only cloud-host OAuth onboarding: fresh registration/session on this host, PKCE, exact state/issuer/audience/nonce validation as applicable, cryptographic ID-token verification where used as identity, bounded callback lifetime, and no callback codes/tokens in logs. Do not add a public token-import endpoint. The existing bridge's interactive CLI is not a browser onboarding service.
2. Implement a private Container-to-controller store transport. Authenticate the exact singleton process, fence superseded generations, and never make vault operations reachable from the public agent router. Keep the vault encryption key only in the trusted DO secret binding. Initial cloud-host login and ongoing refresh must use the same persisted host identity.
3. Adapt Pi's `credentials.modify()` to the vault's single durable refresh owner. An uncertain upstream outcome must require operator reconnect; never automatically retry the old refresh token. Stop the old process before recovery. A failed store commit after upstream token rotation is not recoverable by replay.
4. Store the inference journal durably as well. Do not repeat an inference with an uncertain outcome on restart. Encrypt journal contents if stored in the credential controller, under a distinct purpose-bound namespace.
5. Wake on queued work or a durable alarm, drain a bounded batch, and allow the Container to sleep. The current bridge polls every 3 seconds and is a continuous-runtime process; it cannot simply be described as scale-to-zero. Establish startup readiness, capacity limits, pause/resume, cancel, process death and upgrade behavior.
6. Add explicit stop/disconnect controls and account-usage visibility. Retain no paid-API fallback. Model availability and quota depend on the actual signed-in account and require live validation.
7. Provision only after the owner approves the infrastructure cost and persistent account access. Have the owner complete authentication. Never paste tokens or vault/admin secrets into an agent chat.

The exported `runBridge({command, store, env})` in `bridge/cli.mjs` supplies the intended runtime seam. An injected store needs `credentials`, `hostId`, `read`, `write`, and `close`. Do not use the local file store inside an ephemeral Container as a production substitute.

## Cost model, not a free-tier claim

Cloudflare Containers require Workers Paid ($5/month). Published included usage: 25 GiB-hours memory, 375 vCPU-minutes, and 200 GB-hours disk. Extra rates are $0.0000025/GiB-second, $0.000020/active-vCPU-second, and $0.00000007/GB-second. Memory/disk use provisioned size while running. Lite provides 0.0625 vCPU, 0.25 GiB RAM and 2 GB disk. For a 30-day, continuously running lite host, derived memory+disk overage is $1.71; active CPU adds $0–$2.79. Thus approximately **$6.71–$9.50/month** including the plan, before DO/Worker overages, taxes and other services. At one running hour/day, these container dimensions fit included quotas if otherwise unused. Basic continuous runtime is roughly **$11.93–$24.44/month** by the same method; use it if lite's RAM proves inadequate. Egress is separately metered after regional included quotas. These are modeled bounds, not measured application consumption or a spending cap. [Container pricing](https://developers.cloudflare.com/containers/platform/pricing/)

DO billing is separate: Paid includes 1 million requests and 400,000 GB-seconds/month; excess duration is $12.50 per million GB-seconds, rounded upward. Two always-active 128-MB DOs over a 30-day month can exceed that allocation and add approximately $12.50; avoid assuming a cheap Container implies negligible DO cost. Three-second polling produces 864,000 polling requests in 30 days before user messages, results and control-plane work. Shared account usage consumes the same allocations. SQLite storage/operations, Worker CPU/requests, build infrastructure and any VM provider are additional dimensions. Use actual account billing and measured duty cycle to set alerts. [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Verified versus unverified

Verified locally:

- Five vault tests: encrypted restart persistence and stable host ID; wrong key/scope/tampering rejection; concurrent refresh exclusion; uncertain-refresh recovery lock; failed final token commit blocks stale reuse.
- Separate TypeScript check for the optional controller and vault.
- Wrangler worker/config dry-run with container rollout disabled.

Not verified:

- Docker image build/run: Docker CLI/daemon is unavailable in this executor; normal container dry-run reports that blocker.
- Cloudflare deployment, Container startup, DO transaction behavior under real process failure, private store transport, cloud-host OAuth, refresh against a real account, account model catalog, actual inference, billing or quota behavior.
- Full end-to-end all-Cloudflare hosting. Deploying this scaffold does not complete it.

Local checks from repository root:

    node --experimental-strip-types --test test/cloud-vault.test.ts
    npx tsc -p optional/cloudflare/tsconfig.json
    XDG_CONFIG_HOME=/tmp/red-cloud-xdg WRANGLER_SEND_METRICS=false npx wrangler deploy --config optional/cloudflare/wrangler.jsonc --dry-run --containers-rollout=none --outdir /tmp/red-cloud-container-dry-run

No account, credential, grant, secret, deployment, purchase or external resource was created during this work.
