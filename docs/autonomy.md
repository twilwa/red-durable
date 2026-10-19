# Staged autonomy: bootstrap experiment controls

This is the first experiment-control foundation, **not self-directed exploration
or the mostly-Allow phase**. Exploration is explicitly unsupported and reports
`explorationEnabled: false` and `explorationRunning: false`. No scheduler,
background proposal generator or inference loop is added. Default state is
unconfigured and stopped. Nothing is activated by installing this change.

## Implemented boundary

An authenticated owner may configure one exact existing candidate revision,
allow a limited bootstrap session, and request its health validation. The
supervisor checks admission before starting the existing disposable candidate
facet. The model's Code Mode connectors have no bootstrap control methods.

- Fixed `disposable-candidate-v1` sandbox; `globalOutbound: null`, empty candidate
  bindings, 1,000 ms CPU per invocation and 10 subrequest runtime limit. Candidate
  health validation has a five-second wall timeout and bounded response.
- One exact staged revision; 1–20 validation attempts per owner configuration;
  expiration no more than 24 hours away. The UI selects a one-hour expiration.
- Zero paid inference requests and no external access. There is no provider call,
  credential, host filesystem, arbitrary shell or promotion in this runner.
  **This is not a total dollar cost meter:** platform hosting/CPU costs are not
  measured or capped. No paid-inference allowance can be configured.
- Configuration requires the current state version, an explicit confirmation and
  a strictly validated policy. It always returns to stopped. Start requires the
  current state version and a separate explicit owner confirmation.
- Admission matches policy version and exact candidate. Each new request reserves
  one attempt before execution. Failures, stops and interruptions consume their
  reservation. Same request ID in the same policy returns its recorded state,
  even after stopping; it never retries execution. IDs are scoped to a policy
  version. A new owner configuration resets that policy's attempt limit but does
  not reset lifetime reserved-attempt accounting.
- Single-flight admission is persisted. There is no automatic retry or resume.
  On process restart, in-flight attempts become interrupted and the stop latch
  is set. Idle state and an existing stop latch persist.
- State changes and audit history are one append-only SQLite snapshot insert,
  guarded by state-version compare-and-swap. Each policy has at most 20 attempts.
  History is paginated in exact 20-event pages; retention/compaction is not yet
  implemented. It is an operational record, not a tamper-proof audit system.

## Stop semantics

The Connection panel has a visible **Stop bootstrap only** control. It immediately
persists the stop latch and stopped attempt outcome, then signals cancellation.
The validator disposes of the candidate facet in its cleanup. A stop during the
revision lookup prevents facet creation. A late result cannot overwrite a stopped
outcome. Stop is idempotent and does not wait behind the general supervisor work
gate. It is not a host/process emergency shutdown and cannot undo an already
completed validation or its validation marker.

**Stop and these limits apply only to the bootstrap validation path.** Existing
chat, summaries, Discord, manual Code Mode, manual revision tests, and active
behavior calls continue under their existing controls. They do not consume this
quota. Existing activation still requires the authenticated owner path. An owner
may choose to activate a successfully validated candidate through that existing
separate review flow; bootstrap never activates it automatically.

## Owner API

All routes require the existing owner bearer authentication (including origin
checks) both at the Worker and Durable Object. Bridge/relay credentials cannot
use them. Model memory and observations cannot configure or start bootstrap.

- `GET /api/autonomy`: current policy, readiness blockers, scoped counters and
  attempt outcomes. `bootstrapReady` means another owner-triggered validation can
  be admitted, not that an autonomous agent is running.
- `GET /api/autonomy/history?afterVersion=0`: paginated transitions with an exact
  `nextAfterVersion` cursor.
- `POST /api/autonomy/configure`: `{expectedVersion, confirm:
"CONFIGURE_BOOTSTRAP", policy: {revisionId, sandbox:
"disposable-candidate-v1", maxAttempts, expiresAt,
paidInferenceBudgetUsd: 0, externalAccess: false}}`.
- `POST /api/autonomy/start`: `{expectedVersion, confirm: "START_BOOTSTRAP"}`.
- `POST /api/autonomy/validate`: `{id, revisionId, policyVersion}`. The ID must be
  1–64 alphanumeric, underscore or hyphen characters. Duplicate requests return
  current state; they do not wait on or restart the original attempt.
- `POST /api/autonomy/stop`: no revision precondition, so a stale owner screen can
  always stop the current bootstrap. It grants nothing.

The UI deliberately says “Allow bounded bootstrap,” then “Validate candidate
once.” Allowing bootstrap does not start work. Validation failures return an
attempt outcome of `failed`; an HTTP success alone is not a passing candidate.
The history view and readiness fields must be checked for the actual outcome.

## Next stages, not implemented

1. Owner-approved bounded experiment session: the agent can choose, propose and
   validate multiple new revisions within an approved sandbox, time/attempt and
   inference budget without per-test confirmation. This needs a trusted admission
   hook for every agent-owned experiment, durable scheduler/leases, cancellation,
   conservative accounting and recovery tests before it can report running.
2. Independent behavioral evaluation and owner-visible evidence: health-contract
   success alone is not evidence of a better companion. Define objective,
   held-out checks and quarantine weak or unsafe proposals.
3. Optional promotion policy: separate owner-selected gates for activation,
   rollback and scope changes. No revision may grant itself powers, increase its
   budget or rewrite the supervisor policy. New capabilities remain owner choices.

No production account, live provider, persistent credential, deployment, service
installation, actual paid inference or real external activity is configured or
exercised by this change. Tests use synthetic local candidates and credentials.

## Local verification checkpoint

- Real SQLite file close/reopen: interrupted reservations stay consumed and
  bootstrap stays stopped; repeated stop is idempotent.
- Unit tests cover strict policy rejection, stale versions, revision scope,
  expiration, quota boundary, failure accounting, deduplication, cancellation,
  late results, pagination and zero-credential state.
- Release-manager regressions check stop during revision lookup (no candidate
  startup) and stop during health fetch (candidate disposal; no validation marker).
- UI event/state regressions check exhausted/armed controls after action cleanup,
  lock disabling and clearing, and late history responses. These synthetic DOM
  tests are not browser layout or accessibility certification.
- Real local workerd exercises owner/origin and bridge separation, bounded
  candidate execution, stop during in-flight validation, persistent state across
  process restart, unchanged active revision and existing conversation/Discord
  regressions. No live model/account or visual browser QA was performed.
- Aggregate TypeScript, Node/Vitest, formatting and Wrangler dry-run build checks
  pass. Dry-run bundling does not deploy a service.
