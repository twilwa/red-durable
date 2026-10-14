# Companion continuity

`src/companion.ts` adds an evidence-based continuity index alongside Pi's session state and the raw summary-tree memory. It starts empty. It imports no transcript, notes, inferred preferences, or fictional shared experiences.

## What persists

- **Owner charter:** immutable versions, owner-source event, timestamp, and optimistic expected version. The host can express a curious, candid, warm persona here; no persona is silently installed by the model.
- **Attributed events:** immutable source (`owner`, `assistant`, `tool`, `import`), external/source reference, original occurrence time, recording time, and original text. Imported conversations remain attributed accounts, never the current companion's lived experiences.
- **Revisable beliefs:** facts, hypotheses, procedures, and expiring temporary context retain confidence, scope, source event IDs, creation time, owner acceptance, and correction lineage. Acceptance does not turn a hypothesis into a fact. A correction only supersedes its predecessor after acceptance. The old statement and its evidence remain retrievable. Competing corrections fail rather than silently overwriting one another.
- **Commitments:** proposed → open ↔ blocked → completed/cancelled. Each change retains timestamp and evidence IDs. Accepting a commitment requires an owner event. Completion requires owner or host-tool evidence; cancellation requires owner evidence. Terminal records cannot silently reopen. Create a new commitment if the work changes.

A commitment is actionable state, but never an authorization grant. An owner can ask the companion to track a task without granting every tool action necessary to finish it. The dispatcher must check current permissions independently.

## Integration contract

Construct `new CompanionStore(sql)` using the Durable Object's synchronous SQL interface. The `companion_*` tables are separate from `pi_*` and `mem_*`.

Only authenticated owner handlers can call `ownerSetCharter`, `ownerAcceptBelief`, or `ownerAcceptCommitment`. Only those handlers can create `source: 'owner'` events. Host-created tool results can create `source: 'tool'` events. A model observation must force `source: 'assistant'` in host code; never pass through a model-provided source. Method names and database fields are not authentication. Keep SQL inaccessible to the model and serialize these synchronous store operations in the Durable Object.

The host must tie acceptance to the specific currently reviewed proposal, and use an actual owner request as its event evidence. A historical owner event's mere existence does not authorize a new charter change, acceptance, cancellation, or external action. Similarly, a tool event indicates attributed evidence, not a blanket proof of successful completion: the host/model must verify that its contents actually establish the particular outcome before recording completion.

Model-facing safe operations are proposals, bounded inspection/source retrieval, and progress recording subject to the evidence checks. Do not expose owner methods through code-mode capabilities. Model-controlled `sourceRef`, text, scope, confidence, and source IDs must never be interpreted as permissions. Even an accepted procedure is descriptive memory, not executable code.

- `listEvents(afterId, limit)` discovers source metadata with previews, max 50 rows.
- `readEvent(id, offset, limit)` reads original text in bounded pages, max 2,000 characters.
- `getEvent(id)` is the complete internal retrieval method; tool adapters should use `readEvent` instead.
- `inspect()` gives owner review data including pending proposals; HTTP/tool adapters must enforce their response budgets.
- `compileContext(maxBytes)` returns valid UTF-8-bounded JSON with whole records and an explicit omission count. Defaults to 12 KB, range 1–64 KB. The minimum is 1,024 bytes. Prioritizes the charter, open commitments, and recent accepted active beliefs. Proposed, expired, completed, cancelled, and superseded records remain available for inspection but are omitted from active context. Large records may be skipped; inspect/retrieve when needed. Commitment context includes only the last three transitions; full history remains stored.

All compiled records are quoted data and accompanied by a warning that memory is not instruction or authority. JSON quoting is useful delimitation, not a prompt-injection security boundary. Tool/permission enforcement must remain outside the model. The host may read `charter()` separately for trusted owner persona instructions if desired, subject to higher-priority application safety rules.

## Retention limits

This milestone has no per-item deletion, suppression, or forgetting API. Original source records and correction history remain stored, as do independent Pi session/raw-memory backups. Do not claim that editing a belief erases those originals. Memory corruption detection, semantic evidence verification, large-index retrieval ranking, retention controls, and recurrent proactive scheduling remain separate work.

## Verification

`node --experimental-strip-types --test test/companion.test.ts` covers real SQLite close/reopen, source retrieval, correction lineage and conflicts, owner-only charter updates, acceptance separate from permissions, commitment lifecycle/evidence, imported attribution, expiry, input validation, and UTF-8-bounded context. `npm run typecheck` verifies integration types.
