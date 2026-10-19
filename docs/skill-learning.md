# Telemetry-driven skill learning

## Runtime surface

- `TelemetryStore` retains up to 2,000 host-generated events by default (hard maximum 10,000). Events have session/run attribution, outcome, tool identity, latency, token counts, and enumerated failure category. Querying uses allowlisted filters and bounded cursor pages, never caller SQL.
- Raw prompts, tool arguments, tool outputs, exception strings, credentials, and private reasoning are deliberately absent. Identifier pattern filtering is defense in depth. It cannot detect every arbitrary secret; callers must provide trusted generated IDs, never untrusted names or payloads.
- `SkillsStore` stores immutable revision bodies, a separate active pointer, and evaluation evidence. Proposals require concrete when/when-not descriptions, positive/negative examples, evidence run IDs, source URLs, and routing cases. Source URL syntax is checked, not external reachability or public accessibility.
- Model tools can inspect telemetry/docs/skills and propose/evaluate routing cases. Only authenticated owner actions activate, deactivate, or roll back. Compare-and-swap prevents stale activation. A request ID makes proposal retries idempotent.
- Active descriptions belong in the prompt; detailed instructions load on demand. Instructions are guidance, never permission grants or executable host code.

## Two distinct evaluation paths

`evaluate(revisionId)` runs deterministic substring-trigger cases. Its persisted report says `independentEvidence: false`, identifies proposal-authored labels and the evaluator version, and records the evaluation time. Passing this check establishes routing-fixture consistency, not LLM selection accuracy or task improvement.

`evaluateRecordedActions(revisionId, dataset, predictor)` is a host-only offline evaluation adapter. It compares baseline and candidate on the same recorded-action trajectories, restores the recorded action after each prediction, averages accuracy per trajectory, and rejects overlap with either revision's evidence runs. It uses exact action type/target/value matching. Dataset ID/source, label provenance, baseline revision, evaluator version, timestamp and scores are stored separately. No caller-supplied score can mark a revision independently validated. These results do not activate skills or replace owner review.

The host must curate labels independently and keep held-out records out of optimization inputs. Run-ID disjointness is a useful check, not proof of semantic independence. The adapter is tested with fake predictors only. No real model inference, benchmark dataset evaluation, performance gain, or live success has been established.

## Documentation

`listDocs` and `readDoc` expose bounded pages of build-time snapshots, with source URL, version and SHA-256. The complete installed Pi Durable README is pinned to 1.3.0. Authoring guidance is a dated summary of official Pi skills documentation. There is no arbitrary runtime URL fetching or executable documentation.

## Research connection

[TeleTune v2](https://arxiv.org/html/2610.05437v2) learns textual skills from offline successful trajectories using held-out action-prediction improvement to retain edits. Its workflow-based retrieval favors demonstrations covering different subgoals. Our versioning and offline evaluator draw on that design, but are not a replication of its benchmarks or fuzzy matcher.

[Official Pi skills guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) explains progressive loading: names and routing descriptions are advertised before the body is read. The companion keeps that distinction explicit, including when not to load a skill.
