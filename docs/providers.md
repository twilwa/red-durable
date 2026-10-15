# Provider connections on the trusted host

The private UI can connect ChatGPT, OpenRouter and OpenCode Zen through a local
Node bridge. Credentials stay in the bridge's owner-only files, never in the
Worker/Durable Object, browser storage, model context, telemetry or repository.
No installation/test performs sign-in, purchases credits or calls a live model.

## Start alongside the existing development server

Keep the existing `npm run dev` terminal running. In a second terminal, from the
same project checkout, run:

```sh
npm run bridge:dev
```

That is enough when this project's `.dev.vars` already contains its two distinct
`OWNER_TOKEN` and `BRIDGE_TOKEN` values. The launcher reads the file privately,
maps those values to the bridge in memory, and starts the separate setup UI at
`http://127.0.0.1:8788`. Open that address, unlock with the existing owner token
and session name, then open **About red → Providers**. Saving a provider key
does not select a model.

The launcher does not print the tokens, copy them to another file, rewrite
`.dev.vars`, import other apps' credentials, or stop/reconfigure Wrangler. It
uses Node's dotenv parser without evaluating shell text or applying `NODE_OPTIONS`
from the file. Unrelated API keys and Discord settings in `.dev.vars` are ignored.
Blank, short or identical owner/bridge tokens fail before the bridge starts.
Keep `.dev.vars` private and outside Git. Node 24 is required as elsewhere in this
project.

Defaults are `RED_URL=http://127.0.0.1:8787`, `RED_SESSION=default` and setup
port 8788. If the existing dev server uses another port or session, override only
those non-secret values, for example:

```sh
RED_URL=http://127.0.0.1:8790 RED_SESSION=my-session npm run bridge:dev
```

Explicit process `RED_*` values take priority. Process `OWNER_TOKEN` and
`BRIDGE_TOKEN` aliases come next; file `RED_*` values and then file worker-token
aliases follow. An explicitly blank override fails rather than falling back.
`RED_SETUP_PORT` chooses another setup port (`0` selects a free port).
`RED_BRIDGE_DIR` optionally selects an existing private provider-store directory;
a relative path resolves from the project root. The `.dev.vars` file also always
resolves from the launcher's checkout, not from the calling shell's directory.
The launcher neither searches parent directories nor loads another checkout's
configuration. The owner and bridge credentials must be distinct and at least
32 characters.

### Explicit production/trusted-host configuration

The existing `npm run bridge:serve` and `bridge:run` commands are unchanged. They
do not load `.dev.vars` automatically. For an explicitly configured trusted host,
supply `RED_URL`, `RED_SESSION`, `RED_OWNER_TOKEN` (serve only) and
`RED_BRIDGE_TOKEN` privately through its existing process environment or a
separate owner-only runner environment file. For example:

```sh
node --env-file="$HOME/.config/red-durable-bridge/runner.env" bridge/cli.mjs serve
```

That advanced file is optional for local development; there is no need to
re-enter the tokens already present in `.dev.vars`. Do not put secrets into shell
commands/history, chat or Git. The local-dev launcher deliberately does not
support auth-host bootstrap; use the documented explicit login procedure for
that separate operation.

`serve` hosts the same interface and forwards ordinary owner API requests to
`RED_URL`. Provider setup requests terminate locally. Exact Host, Origin, owner
credential and session checks guard the local API; it exposes no CORS interface,
remote bind address or bridge/Discord capability to the browser. Do not expose
this port with a tunnel or public reverse proxy.

## ChatGPT

Choose **Continue with ChatGPT**, then open the displayed official OpenAI link
and review the access yourself. The callback listener binds 127.0.0.1:1455. If the
browser does not return automatically, paste its complete final localhost
callback URL into the local form. Cancel interrupts the pending flow. Close/Lock/page dismissal sends best-effort
cancellation; an unreachable bridge cannot acknowledge it, so orphaned flows
also have a server-side expiry. A cancelled or expired flow cannot activate
credentials later. Retry creates
fresh PKCE/state/nonce values. Sign-in expires after ten minutes.

The bridge uses public dynamic registration and the official Responses endpoint,
not a borrowed Codex client ID or private backend API. It validates the signed
ID token against OpenAI's fixed JWKS endpoint, issuer, audience, nonce, expiry
and subject; saves the issued client ID; and serializes rotating refresh tokens.
The ID token and profile/email claims are not retained. The app's owner token
remains the authority for the private UI, separate from provider identity.

A registration is tied to one ChatGPT account/workspace. Reauthorization reuses
that registration and verifies the same subject. Removing the local connection
preserves the registration. Connecting a different account/workspace is not yet
an in-place UI flow; use a separate new private bridge directory after stopping
the current runner and reviewing the intended account. Existing Pi credentials
without validated subject metadata must be removed/reconnected explicitly; they
are never upgraded or migrated silently.

Models come from the signed-in account's catalog, intersected with the pinned
Pi model registry. Plan allowance and model availability belong to the account.
Review ChatGPT Usage settings and any optional credit spending yourself; the app
cannot guarantee subscription requests never use optional account credits.

## OpenRouter

Create/copy an API key yourself from the official OpenRouter account page, enter
it in the password field and approve local storage. The bridge verifies the key
with the read-only `/api/v1/key` endpoint, then lists tool-capable models from
the public catalog that the pinned Pi version supports. No generation is used
for validation. This release supports key entry; OpenRouter OAuth is not exposed. Red never
switches the selected service or model on failure. OpenRouter itself can route a
selected model among its serving providers; where the pinned Pi transport does
not expose routing controls, OpenRouter's defaults still apply. This is not a
promise of vendor-level routing isolation inside OpenRouter.

Selecting an OpenRouter model requires a separate explicit acknowledgement that
conversation and background memory summaries use metered credits. This selection
persists for the named session until changed. The app does not buy credits,
enable auto-top-up, set an account budget or silently select a paid model.

## OpenCode Zen and Go

Zen uses an API key and metered credits. Its current public catalog does not
validate an account key, so the UI honestly shows a saved but unverified key
until the first user-requested inference succeeds. No paid verification request
is sent. A conservative set of known tool-capable models is supported through
OpenCode's documented family-specific inference endpoints; unrecognized models
are omitted rather than guessed. Zen Gemini models are excluded because the
pinned Pi Google adapter cannot use the bridge's redirect-denying transport.
OpenAI-compatible and Anthropic-family Zen transports are supported.

Go is displayed separately but disabled for this general companion. Its
subscription is for eligible coding-agent traffic. This harness shares
conversation, self-coding tools and background memory summaries; a UI mode label
would not enforce a true coding-only boundary. Dedicated bounded coding sessions
would require additional routing/purpose isolation before Go can be enabled.
There is no Go-to-Zen metered fallback.

## Storage, failures and removal

- Store directory 0700, files 0600, atomic fsync/rename and one exclusive runner
  lock. Provider records remain separate. The subscription credential format
  stays OAuth-only; OpenRouter/Zen accept only API-key records.
- Keys and callback codes exist briefly in form/request memory, are cleared on
  submit/cancel/lock and are never returned in status. Public state exposes
  provider names, non-secret flow status and model names only.
- Connecting, removing or refreshing providers cannot race active inference.
  Model switching is rejected during an active turn. Existing inference leases,
  durable request IDs, explicit retry and unknown-outcome journals remain intact.
- Provider error bodies and credential-bearing metadata are not logged, returned
  or journaled. Private reasoning/opaque provider signatures are omitted. The
  dedicated bridge process forces OpenAI/Anthropic SDK diagnostic logging off,
  ignores ambient custom-header/admin-key overrides, and strips unrelated
  organization/project headers. Do not embed this runtime into an application
  that expects those SDK environment settings to remain unchanged.
- A durable uncertain-credential-update marker fails closed after restart. See
  [subscription-bridge.md](subscription-bridge.md) for manual recovery; do not
  remove the marker and reuse an old rotating refresh token.
- **Remove local connection** deletes only that local credential. It does not
  revoke a provider grant or API key. Revoke separately in the provider account
  if desired. Removing a provider does not silently select a replacement model.

## Hosted limits and verification

A directly opened Worker page shows local setup instructions and rejects
provider-key/auth writes. Cloudflare deployment, remote hosted onboarding,
authenticated tunnels, credential transfer and the disabled Container scaffold
are outside this implementation. A private trusted VM can still run outbound
inference with separately owner-provisioned credentials; do not assume hosted
multiuser ChatGPT eligibility.

Offline fixtures test protocol and state handling, not real account access,
subscription eligibility, quotas, provider model quality or live browser consent.
See [VALIDATION.md](VALIDATION.md) for the checks actually run.

Official references:

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://openrouter.ai/docs/api-reference/authentication
- https://openrouter.ai/docs/api-reference/limits
- https://opencode.ai/v2/docs/console/api/inference/
- https://opencode.ai/v2/docs/console/go/

## Isolated browser QA without touching a running dev server

In a separate source checkout, install the pinned packages with `npm ci`, then
run `npm run test:provider-browser`. On macOS the harness defaults to Google
Chrome's standard application path; set `CHROMIUM_PATH` to another installed
Chromium executable if needed. It starts its own loopback server on an ephemeral
port and supplies only in-memory fake upstream/provider data. It neither starts
Wrangler nor accesses existing `.wrangler`, `.dev.vars` or provider credentials.

The harness covers desktop/mobile layouts, local provider cards, API-key wiping,
explicit metered selection, cancelled/interrupted/expired login, lock cleanup,
unsafe authorization links, literal prompt rendering and empty browser storage.
Screenshots are written under `artifacts/provider-browser` (or the explicit
`PROVIDER_BROWSER_ARTIFACT_DIR`). A browser launch failure is reported as failure;
this harness has not established a visual pass on the restricted cloud host.
