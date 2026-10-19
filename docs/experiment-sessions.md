# Bounded agent-owned experiments

Disabled by default. The separate **Bounded experiment session** controls configure
an owner goal, starting source revision, advertised subscription model, expiration,
and fixed limits. One explicit Start permits the agent to read starter/session
source, propose source and validate disposable candidates until it reports or hits
a limit. Individual in-budget tool calls do not need another owner approval.
Manual bootstrap validation remains a separate control.

The trusted supervisor runs an isolated durable loop and transcript, not the owner
conversation or its Pi registry. Available tools are exactly starter, read, propose,
validate and report. It cannot invoke active behavior, arbitrary Code Mode,
learning/memory writes, credentials, external effects, promotion or deployment.
Validation checks only the candidate health contract; it is not held-out evidence
of useful behavior and does not create the owner's activation eligibility marker.

## Accounting and recovery

Generation dispatch, proposal and test reservations are durable before effects.
They are never refunded after errors, stop, crashes or uncertain outcomes. A
leased experiment inference is not redispatched after lease expiry. Starting
again keeps the configured policy's consumed budget; configuring a new budget
requires owner confirmation. Restart interrupts an armed session and never resumes
it automatically. This includes Durable Object eviction while awaiting inference;
unattended continuity through eviction is not implemented. Stable session/epoch
operation identities reject replay/conflicts.

The output-token field is a requested/reserved planning allowance, **not a physical
provider or billing cap**. ChatGPT's subscription request translation does not
support an enforced output cap. Reported output usage is recorded separately and
exceeding the allowance stops subsequent work; already generated tokens cannot be
undone. Missing usage is unknown. Subscription quota and platform hosting costs
are outside these local counters; no metered inference fallback exists.

Stop persists the stop first, then cancels only that experiment's queued/leased
inference and in-flight candidate. Dispatched provider work may finish, but its
late result cannot continue tools or create another generation. The owner chat,
Discord work and manual bootstrap remain independent. Revocation/expiry is checked
at generation/tool boundaries and synchronously at bridge dispatch. Proposals
already saved remain reviewable; stop does not erase them.

## Verification boundary

Tests use synthetic model replies, real SQLite reopen and local workerd. They
exercise orchestration and containment, not autonomous research quality or live
subscription accounts. No login, credential grant, activation, deployment, paid
provider or visual browser QA is implied by this source implementation.
