# Do Computer: what Red should borrow

Research date: 2026-10-19. Read-only source review; no upstream installation, execution,
live provider calls, account setup, deployment, or application implementation.

## Recommendation

Keep Red's durable supervisor, attributed memory and owner-reviewed mutable facet.
Borrow Do Computer's product patterns around them: durable schedules, actionable approval
cards, a concise work journal, and clearer waiting/blocked states. Do not port its app wholesale.

**Source pin:** [SawyerHood/do-computer at 6532a73](https://github.com/SawyerHood/do-computer/tree/6532a738308813f32eead7d0fdc7a4aa42f1246f),
inspected in a local research checkout; upstream source is not included in this repository.
Red baseline: `26798b594affe1964e7340fe54656a3c1433f5b8`, equal to GitHub main when checked.
All upstream paths below are relative to that pinned submodule; all Red paths are relative
to this repository. Findings refer to implementation, not roadmap claims in `PLAN*` or `HANDOFF.md`.

## Architecture fit and mismatch

Both projects use Pi Durable and SQLite-backed Cloudflare actors. Do Computer layers a
large multi-app product on a portable `ActorHost` interface: web (TanStack/React), desktop
(Electron), mobile (Expo), paired-computer daemon, library, connectors, schedules and teams.
Its `packages/runtime/src/index.ts`, `node/index.ts`, `cloudflare/index.ts` and `testing.ts`
define the host and shared conformance surface. `packages/agent/src/actor.ts` wires the agent.

Red instead deliberately keeps auth, releases, memory and inference orchestration in its
trusted `src/index.ts` supervisor, with no-network generated code behind `src/facet.ts`
and `src/releases.ts`. Provider credentials remain on the separate trusted Node bridge.
Do Computer's model credentials are managed by a workspace model-access actor
(`packages/agent/src/model-access.ts`); that is not a drop-in replacement for Red's bridge.

Version mismatch matters: upstream pins Pi/Chord **1.3.0** in `pnpm-workspace.yaml`;
Red pins Pi **1.1.0** in `package.json`. Copy design and test cases first. Direct imports
would pull a newer harness, workspace packages and unrelated infrastructure into Red.

## Ranked borrow list

### 1. ADAPT: durable schedules with explicit run and delivery state

**Upstream:** `packages/agent/src/schedule.ts`, `schedules.ts`, `docs.ts`;
`packages/agent/test/schedule.test.ts`, `schedules.test.ts`;
`apps/web/src/routes/_app.a.$agentId.automations.tsx`.

The parser supports one-shot relative/absolute times, intervals and timezone-aware cron.
`Scheduler` records a fire/pending run and advances the schedule in one harness commit;
submission uses `schedule:<id>:<firedAt>` and report delivery uses a separate stable key.
It prevents overlapping pending runs and collapses missed interval/cron backlog rather than
bursting every missed occurrence. Optional read-only checks can skip model invocation when
nothing changed. A check can run twice after a crash, so it must truly have no side effects.

**Red landing points:** `src/companion.ts` already stores commitment `dueAt`, but that is not
an executable reminder. `Maintenance` in `src/index.ts` recovers admissions, archives,
operations, Discord and summaries; it is not a user schedule manager. Reuse that trusted
lifecycle and the operation/queue discipline in `src/bridge-queue.ts` and `src/discord-queue.ts`.

**Small first slice:** owner-created one-shot reminders with timezone, next run, enabled
state, pending execution, terminal outcome and delivery receipt. Link to a commitment
without treating the commitment as permission. Add recurring schedules only after this works.
Use explicit structured suppression/delivery state rather than relying on `[SILENT]` text.
Do not bring arbitrary shell-based checks into Red's no-network facet.

**Acceptance:** real SQLite/workerd restart between fire, admission, completion and delivery;
no double admission/delivery, correct DST behavior, cancellation while pending, offline bridge,
quota failure, and explicit failed/unknown outcomes. Persist the approved action and target.

### 2. ADAPT: approvals that explain the exact action and originating work

**Upstream:** `packages/agent/src/approvals.ts` and `packages/agent/test/approvals.test.ts`;
`apps/web/src/components/chat/approvals.tsx`.

Useful mechanics: persisted pending requests, duplicate-call suppression, Allow once /
Always / Deny concepts, 15-minute grants, action-oriented abilities spanning equivalent
tools, and a card that shows arguments plus the originating chat/subagent task. This makes
cross-task approval much easier to understand.

**Red landing points:** explicit owner activation in `src/releases.ts`, `src/skills.ts` and
`src/index.ts`; source/skill review in `public/app.js` and owner API in `public/api.js`.
Add consistent pending-review cards to existing release/skill/commitment flows before adding
an ambient tool-permission system. Preserve revision hashes and stale-review rejection.

**Important adaptation:** upstream `Grant.binding` is optional; a generic one-use grant can
be matched by chat and subjects. Red should bind consequential approval to authenticated
owner, exact operation ID, canonical payload/target, revision and expiry, then consume it
atomically. A remembered preference, model output or child report cannot create authority.
Never offer “Always” where Red requires per-action approval.

**Acceptance:** altered arguments, cross-session reuse, double click, expired/revoked grants,
restart, rejection and UI lock must not execute or leak a stale action.

### 3. ADOPT THE PATTERN: a short work journal, distinct from telemetry

**Upstream:** `packages/agent/src/log.ts`, `journal.ts`,
`packages/protocol/src/runs.ts`, `apps/web/src/components/chat/agent-aside.tsx`.

The agent explicitly records a short title and outcome for substantial work; the journal
bounds retained notes and exposes only a small recent subset to other chats. It avoids a
noisy feed of every read/tool call. This would make Red's ongoing work legible.

**Red landing points:** commitments and their transitions in `src/companion.ts`,
`public/app.js` Work panel, and source-linked observations. Add a bounded user-facing
projection with source IDs and verified status. A model's “done” claim is attributed text,
not proof an external action succeeded. Do not store titles/outcome prose in `src/telemetry.ts`,
whose contract excludes prompts, arguments, outputs and private reasoning.

**Acceptance:** reopen persistence, source links, bounded pagination, cancellation and
uncertain-delivery states; no credentials or private reasoning in the projection.

### 4. ADAPT: distinguish blocked work, waiting work and progress messages

**Upstream:** `packages/agent/src/live.ts`, `keep-going.ts`, `bus.ts`,
`packages/agent/test/keep-going.test.ts`, `bus.test.ts`;
`apps/web/src/components/chat/bus-events.tsx`.

`liveWork()` excludes tasks blocked by missing task definitions, including dependents,
from work that merits another wake. This is a useful defense against endless alarm churn
after rollback. The progress tool separates a user update from ending an agent turn;
the optional bus separates internal events from explicit user-facing sends.

**Red landing points:** `Maintenance` and harness lifecycle in `src/index.ts`, durable
bridge states, `src/telemetry.ts`, and `public/app.js`. Start with an explicit blocked/waiting
status and a bounded progress event. Keep a reviewable operational trail even if ordinary
chat omits internal events. Inspect Pi 1.1 capabilities before attempting to port 1.3 hooks.

**Do not copy:** `keep-going.ts` can call a separately billed OpenRouter judge to decide
whether to resume, and its three-nudge counter is process-local. Red must not introduce
hidden metered inference, a new provider, or non-durable continuation budgets. Persist task
state, respect stop/approval waits, and keep any future classifier owner-opted-in.

### 5. ADAPT LATER: UI composition and live-state ownership

**Upstream:** `apps/web/src/components/chat/chat-view.tsx`, `agent-aside.tsx`,
`approvals.tsx`, `subagents.tsx`; `apps/web/src/lib/use-live-chat.ts`;
`packages/protocol/src/chat.ts`, `diff.ts`.

Useful ideas are task-linked cards, a side inspector, a concise work list and one shared
live subscription per chat with stale-callback rejection. These are interaction patterns,
not a reason to replace Red's vanilla UI with TanStack/React/Jotai.

**Red landing points:** `public/app.js`, `public/api.js`, `ui/contracts.d.ts`,
`test/ui.test.ts`, `docs/interface.md`. Red already has session-generation invalidation,
lock cleanup and stable retry IDs. Keep those protections and add narrow presentation
improvements. Validate real desktop/mobile layout separately; this review is source-only.

## Keep Red's stronger boundaries

- **Memory:** upstream `persona.ts` stores editable 6,000-character notes and a 4,000-character
  profile, while `journal.ts` adds compact cross-chat context. Useful as a bounded projection,
  not a replacement for Red's exact originals and summary tree (`src/memory.ts`), attributed
  evidence/corrections (`src/companion.ts`), and owner-controlled charter. Do not silently
  promote extracted notes to accepted beliefs or consent.
- **Self-modification and skills:** upstream `skills.ts`, `skill-format.ts`, `skill-fetch.ts`
  support skill files, provenance and bounded prompt catalogs. No equivalent of Red's
  owner-reviewed, executable, no-network facet promotion was identified in the reviewed
  runtime. Keep `src/releases.ts` activation/rollback and `src/skills.ts` evidence/evaluation
  gates. Skill instructions are not executable supervisor updates or proof of improvement.
- **Permissions:** upstream `docs/reference/security.md` explicitly describes mostly Allow
  defaults and prompt-injection exposure. It also says agents sharing a machine are not
  isolated. Do not adopt these defaults or shared-shell trust assumptions. Red currently
  exposes named bounded capabilities; a new connector/executor remains a separate design
  (`docs/EXECUTOR.md`).
- **Authentication:** upstream `apps/web/src/server/auth.ts` uses Better Auth, accounts,
  cookies and team membership, including a five-minute cookie cache. Red's `src/security.ts`
  and bridge/provider server intentionally distinguish owner, bridge and relay credentials.
  Do not change those principals or migrate credentials for a research/UI improvement.
  A future session-based login deserves its own revocation/CSRF/identity threat model.
- **Telemetry:** upstream work/usage views are useful inspiration, but Red's bounded,
  enumerated, credential-free `src/telemetry.ts` stays authoritative. Do not log tool payloads
  or infer a cache hit/cost saving from an estimated provider lifetime.
- **Caching:** upstream `idle-compaction.ts` opportunistically summarizes while an estimated
  long-lived provider cache may exist. Red already has isolated conversation/summary routing
  (`src/prompt-context.ts`, `bridge/prompt-cache.mjs`, `docs/prompt-caching.md`). Do not merge
  those routes or switch to long-retention caching automatically. Evaluate later with real
  provider measurements, explicit cost/privacy decisions and preserved source evidence.
- **Scope:** desktop daemon, mobile, team auth, arbitrary connectors, secrets vault, mascot
  gamification and deployment-provider integrations are substantial separate products.
  Defer them; none is needed to improve Red's durable companion loop.

## Suggested implementation order

### Product direction: autonomy and self-evolution

Red's goal extends beyond a request-driven assistant: persistent interests, self-directed
experiments and changes to her own behavior. The intended direction is a constrained
bootstrap followed by mostly-allow operation within explicitly approved capabilities,
budgets and environments. The prototype's current owner-review requirements are the
implemented baseline, not a decision to keep all behavior approval-heavy forever.

An autonomy policy still needs concrete scope and acceptance criteria. Identity maturity
alone should not unlock access: evaluate stop compliance, bounded spending, recovery,
change explanations and rollback behavior. Isolated proposal/build/test can be more
permissive than activation or external action. Any future automatic promotion must define
eligible changes, independent checks, limits and recovery before it is enabled; it should
not let generated code silently expand its own permissions. No such policy is enabled by
the research, Pi upgrade or journal work.

1. Approval/review cards and a source-linked Work journal: visible utility with no new
   external capabilities. Preserve current API semantics and UI regression protections.
2. Owner-created one-shot reminders with durable delivery receipts. Prove crash recovery
   before recurring schedules or notifications outside the existing conversation.
3. Blocked/waiting diagnostics and explicit progress messages, with restart-safe budgets.
4. Only then consider scoped external executors and richer multi-chat orchestration.

These recommendations describe the reviewed baseline; implementation work is tracked separately.

## License and reproducibility

Upstream is MIT, Copyright (c) 2026 Sawyer Hood. Preserve its copyright and permission
notice with copied code or substantial portions. Its `THIRD_PARTY_NOTICES.md` separately
covers shadcn/ui, simplex-noise shaders, OFL fonts, desktop Cua/Electron/Chromium and
MPL-2.0-derived runtime components; npm dependencies have their own terms. Review the
specific component before copying or distributing it. The original upstream checkout retains these notices. Red's package is marked `private` and `UNLICENSED`; this research changes neither its
license nor repository visibility.

This document is the only research artifact published to Red. No submodule, upstream
source tree or upstream dependency is included in the repository or application build.
The source pin above is sufficient to reproduce the reviewed checkout separately.
No upstream test suite was run; code and test sources are evidence of design, not an
independent functional/security audit or verification of upstream's product claims.

### Red regression check for this research addition

- `npm run format:check`: passed; research README separately checked with Prettier.
- `npm run check`: passed, including both TypeScript checks, 281 Node tests, 9 Vitest tests
  and Wrangler dry-run bundling. Dry run used a disposable HOME and no account credentials.
- `TEST_LOOPBACK_ONLY=true npm run test:runtime`: passed, including actual workerd/facet
  restarts, queue recovery and simulated provider/Discord flows.
- Git diff whitespace, explicit source paths and clean pinned upstream checkout checked.
- No real-browser visual test, live inference, Docker execution or deployment performed.
