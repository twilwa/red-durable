import {
  evaluateHeldOut,
  type HeldOutDataset,
  type ActionPredictor,
} from "./skill-evaluation.ts";
import type { MemorySql } from "./memory.ts";
export interface SkillProposal {
  name: string;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  instructions: string;
  useExamples: string[];
  avoidExamples: string[];
  evidenceRunIds: string[];
  sources: string[];
  trigger: { any: string[]; none: string[] };
  cases: { text: string; expected: boolean }[];
}
export interface SkillRevision extends SkillProposal {
  revisionId: string;
  createdAt: string;
  status: "proposal" | "tested" | "active";
  evaluation: SkillEvaluation | null;
}
export interface SkillEvaluation {
  passed: boolean;
  correct: number;
  total: number;
  positive: number;
  negative: number;
  kind: "deterministic-trigger-smoke-test";
  independentEvidence: false;
  evaluatedAt: string;
  evaluatorVersion: "trigger-substring-v1";
  labelsSource: "proposal-authored";
  warning: string;
}
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const secretPattern =
  /(?:sk-[a-zA-Z0-9_-]{10,}|Bearer\s+\S+|(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+|-----BEGIN .*PRIVATE KEY-----)/i;
function text(v: unknown, max: number, label: string) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    secretPattern.test(v)
  )
    throw new Error(`Invalid or secret-bearing ${label}`);
  return v.trim();
}
function strings(v: unknown, max: number, label: string) {
  if (!Array.isArray(v) || v.length < 1 || v.length > max)
    throw new Error(`Invalid ${label}`);
  return v.map((x) => text(x, 1000, label));
}
export function validateSkill(input: SkillProposal): SkillProposal {
  const name = text(input.name, 64, "name");
  if (!idPattern.test(name)) throw new Error("Invalid skill name");
  const description = text(input.description, 1024, "description");
  if (
    !/\b(use when|when|use for)\b/i.test(description) ||
    !/\b(not|avoid|exclude|except)\b/i.test(description)
  )
    throw new Error(
      "Description must state when and when not to use the skill",
    );
  const cases = input.cases;
  if (
    !Array.isArray(cases) ||
    cases.length < 2 ||
    cases.length > 50 ||
    !cases.some((c) => c.expected === true) ||
    !cases.some((c) => c.expected === false)
  )
    throw new Error("Positive and negative trigger cases required");
  const trigger = input.trigger;
  if (!trigger || !Array.isArray(trigger.none) || trigger.none.length > 20)
    throw new Error("Invalid trigger");
  const sources = strings(input.sources, 10, "sources");
  for (const source of sources) {
    const url = new URL(source);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Source must use HTTPS URL syntax without query, fragment or credentials; reachability is not verified",
      );
  }
  return {
    name,
    description,
    whenToUse: strings(input.whenToUse, 10, "whenToUse"),
    whenNotToUse: strings(input.whenNotToUse, 10, "whenNotToUse"),
    instructions: text(input.instructions, 12000, "instructions"),
    useExamples: strings(input.useExamples, 10, "useExamples"),
    avoidExamples: strings(input.avoidExamples, 10, "avoidExamples"),
    evidenceRunIds: strings(input.evidenceRunIds, 20, "evidenceRunIds"),
    sources,
    trigger: {
      any: strings(trigger.any, 20, "trigger.any"),
      none: trigger.none.map((x) => text(x, 100, "trigger.none")),
    },
    cases: cases.map((c) => {
      if (typeof c.expected !== "boolean")
        throw new Error("Invalid expectation");
      return { text: text(c.text, 1000, "case"), expected: c.expected };
    }),
  };
}
export function matchesSkill(
  skill: Pick<SkillProposal, "trigger">,
  query: string,
) {
  const q = query.toLowerCase();
  return (
    skill.trigger.any.some((x) => q.includes(x.toLowerCase())) &&
    !skill.trigger.none.some((x) => q.includes(x.toLowerCase()))
  );
}
/** Non-executable, immutable proposals; owner authorization belongs to the HTTP boundary.
 * Smoke tests validate declared routing only. They never constitute held-out improvement. */
export class SkillsStore {
  private readonly sql: MemorySql;
  constructor(sql: MemorySql) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_skills (id TEXT PRIMARY KEY,name TEXT NOT NULL,data TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_skill_active (name TEXT PRIMARY KEY, revision_id TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_skill_requests (request_id TEXT PRIMARY KEY,revision_id TEXT NOT NULL,input TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS red_skill_evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT,revision_id TEXT NOT NULL,data TEXT NOT NULL)",
    );
  }
  propose(input: SkillProposal, requestId?: string) {
    const clean = validateSkill(input);
    if (requestId !== undefined) {
      text(requestId, 160, "requestId");
      const previous = this.sql
        .exec(
          "SELECT revision_id,input FROM red_skill_requests WHERE request_id=?",
          requestId,
        )
        .toArray()[0];
      if (previous) {
        if (String(previous.input) !== JSON.stringify(clean))
          throw new Error("Skill request ID reused with different input");
        return this.read(String(previous.revision_id));
      }
    }
    if (
      Number(
        this.sql.exec("SELECT COUNT(*) AS n FROM red_skills").toArray()[0].n,
      ) >= 200
    )
      throw new Error("Skill revision capacity reached");
    const revision: SkillRevision = {
      ...clean,
      revisionId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: "proposal",
      evaluation: null,
    };
    this.sql.exec(
      "INSERT INTO red_skills(id,name,data) VALUES (?,?,?)",
      revision.revisionId,
      revision.name,
      JSON.stringify(revision),
    );
    if (requestId !== undefined)
      this.sql.exec(
        "INSERT INTO red_skill_requests(request_id,revision_id,input) VALUES (?,?,?)",
        requestId,
        revision.revisionId,
        JSON.stringify(clean),
      );
    return revision;
  }
  private active(name: string): string | null {
    const r = this.sql
      .exec("SELECT revision_id FROM red_skill_active WHERE name=?", name)
      .toArray()[0];
    return r ? String(r.revision_id) : null;
  }
  read(revisionId: string): SkillRevision {
    const r = this.sql
      .exec("SELECT data FROM red_skills WHERE id=?", revisionId)
      .toArray()[0];
    if (!r) throw new Error("Skill revision not found");
    const skill = JSON.parse(String(r.data)) as SkillRevision;
    return {
      ...skill,
      status:
        this.active(skill.name) === revisionId
          ? "active"
          : skill.evaluation?.passed
            ? "tested"
            : "proposal",
    };
  }
  list() {
    return this.sql
      .exec("SELECT id FROM red_skills ORDER BY rowid DESC LIMIT 200")
      .toArray()
      .map((r) => {
        const s = this.read(String(r.id));
        return {
          name: s.name,
          revisionId: s.revisionId,
          description: s.description,
          status: s.status,
          createdAt: s.createdAt,
        };
      });
  }
  listPage(offset = 0, limit = 8) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid skill list offset");
    const count = Math.max(1, Math.min(8, Math.floor(limit) || 8));
    const all = this.list();
    const items: ReturnType<SkillsStore["list"]> = [];
    let size = 0;
    for (const item of all.slice(offset, offset + count)) {
      const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
      if (size + bytes > 12000) break;
      items.push(item);
      size += bytes;
    }
    return {
      items,
      nextOffset:
        offset + items.length < all.length ? offset + items.length : null,
    };
  }
  evaluate(revisionId: string): SkillEvaluation {
    const s = this.read(revisionId);
    const correct = s.cases.filter(
      (c) => matchesSkill(s, c.text) === c.expected,
    ).length;
    const evaluation: SkillEvaluation = {
      passed: correct === s.cases.length,
      correct,
      total: s.cases.length,
      positive: s.cases.filter((c) => c.expected).length,
      negative: s.cases.filter((c) => !c.expected).length,
      kind: "deterministic-trigger-smoke-test",
      independentEvidence: false,
      evaluatedAt: new Date().toISOString(),
      evaluatorVersion: "trigger-substring-v1",
      labelsSource: "proposal-authored",
      warning:
        "Proposal-authored cases only. Owner review and independent held-out task evaluation are still required to establish improvement.",
    };
    this.sql.exec(
      "UPDATE red_skills SET data=? WHERE id=?",
      JSON.stringify({
        ...s,
        status: evaluation.passed ? "tested" : "proposal",
        evaluation,
      }),
      revisionId,
    );
    return evaluation;
  }
  /** Host-only evaluation: callers provide a predictor, never a self-declared result.
   * This stores honest provenance and does not automatically activate a revision. */
  async evaluateRecordedActions(
    revisionId: string,
    dataset: HeldOutDataset,
    predict: ActionPredictor,
    signal?: AbortSignal,
  ) {
    const candidate = this.read(revisionId);
    const baselineId = this.active(candidate.name);
    const baseline = baselineId ? this.read(baselineId) : null;
    const context = (s: SkillRevision) =>
      JSON.stringify({
        name: s.name,
        description: s.description,
        whenToUse: s.whenToUse,
        whenNotToUse: s.whenNotToUse,
        instructions: s.instructions,
        useExamples: s.useExamples,
        avoidExamples: s.avoidExamples,
      });
    const result = await evaluateHeldOut({
      dataset,
      proposalRunIds: [
        ...candidate.evidenceRunIds,
        ...(baseline?.evidenceRunIds ?? []),
      ],
      baseline: baseline ? context(baseline) : "",
      candidate: context(candidate),
      predict,
      signal,
    });
    const record = { ...result, revisionId, baselineRevisionId: baselineId };
    this.sql.exec(
      "INSERT INTO red_skill_evaluations(revision_id,data) VALUES (?,?)",
      revisionId,
      JSON.stringify(record),
    );
    this.sql.exec(
      "DELETE FROM red_skill_evaluations WHERE id <= (SELECT COALESCE(MAX(id),0)-2000 FROM red_skill_evaluations)",
    );
    return record;
  }
  evaluations(revisionId: string) {
    this.read(revisionId);
    return this.sql
      .exec(
        "SELECT data FROM red_skill_evaluations WHERE revision_id=? ORDER BY id DESC LIMIT 20",
        revisionId,
      )
      .toArray()
      .map((r) => JSON.parse(String(r.data)));
  }
  activate(revisionId: string, expectedActiveRevisionId: string | null) {
    const s = this.read(revisionId);
    if (!s.evaluation?.passed)
      throw new Error("Passing trigger smoke tests required");
    if (this.active(s.name) !== expectedActiveRevisionId)
      throw new Error("Active skill changed; refresh before activating");
    this.sql.exec(
      "INSERT INTO red_skill_active(name,revision_id) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET revision_id=excluded.revision_id",
      s.name,
      revisionId,
    );
    return {
      name: s.name,
      activeRevisionId: revisionId,
      previousRevisionId: expectedActiveRevisionId,
    };
  }
  rollback(
    name: string,
    revisionId: string | null,
    expectedActiveRevisionId: string | null,
  ) {
    if (revisionId === null) {
      if (this.active(name) !== expectedActiveRevisionId)
        throw new Error("Active skill changed; refresh before deactivating");
      this.sql.exec("DELETE FROM red_skill_active WHERE name=?", name);
      return {
        name,
        activeRevisionId: null,
        previousRevisionId: expectedActiveRevisionId,
      };
    }
    const s = this.read(revisionId);
    if (s.name !== name) throw new Error("Wrong skill name");
    return this.activate(revisionId, expectedActiveRevisionId);
  }
}

import { PINNED_DOCS } from "./skill-docs.ts";
export function listDocs() {
  return PINNED_DOCS.map(({ content, ...metadata }) => ({
    ...metadata,
    characters: content.length,
  }));
}
export function readDoc(id: string, offset = 0) {
  const doc = PINNED_DOCS.find((d) => d.id === id);
  if (!doc) throw new Error("Unknown pinned document");
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid documentation offset");
  const { content, ...metadata } = doc;
  return {
    ...metadata,
    text: content.slice(offset, offset + 2000),
    nextOffset: offset + 2000 < content.length ? offset + 2000 : null,
  };
}
