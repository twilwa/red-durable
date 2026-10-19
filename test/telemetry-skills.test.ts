import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { TelemetryStore } from "../src/telemetry.ts";
import {
  SkillsStore,
  readDoc,
  listDocs,
  validateSkill,
  type SkillProposal,
} from "../src/skills.ts";
import type { MemorySql } from "../src/memory.ts";
function setup() {
  const db = new DatabaseSync(":memory:");
  const sql: MemorySql = {
    exec(q, ...args) {
      const s = db.prepare(q);
      const rows = s.columns().length
        ? (s.all(...args) as Record<string, unknown>[])
        : (s.run(...args), []);
      return { toArray: () => rows };
    },
  };
  return { db, sql };
}
function proposal(): SkillProposal {
  return {
    name: "quota-recovery",
    description:
      "Use when a run hits a quota limit; avoid unrelated authentication failures.",
    whenToUse: ["Quota-limited inference"],
    whenNotToUse: ["Authentication failure"],
    instructions:
      "Read quota telemetry and wait for the reset before retrying.",
    useExamples: ["The run hit quota"],
    avoidExamples: ["Authentication failed"],
    evidenceRunIds: ["run-1"],
    sources: ["https://arxiv.org/abs/2610.05437"],
    trigger: { any: ["quota"], none: ["authentication"] },
    cases: [
      { text: "Run hit quota", expected: true },
      { text: "Authentication failed", expected: false },
    ],
  };
}
test("telemetry drops all raw payload fields, arbitrary errors, and secret-shaped identifiers", () => {
  const { db, sql } = setup();
  const t = new TelemetryStore(sql);
  t.record({
    sessionId: "session-1",
    runId: "run-1",
    kind: "tool_end",
    tool: "read",
    outcome: "error",
    durationMs: 3,
    apiKey: "never-store",
    arguments: { secret: "never-store" },
    thinking: "never-store",
    result: "never-store",
    errorCode: "exception containing never-store",
  } as never);
  const event = t.record({
    sessionId: "sk-this-is-a-long-api-key",
    runId: "Bearer private",
    kind: "failure",
    tool: "password",
    durationMs: NaN,
  });
  assert.equal(event.sessionId, "[redacted]");
  assert.equal(event.runId, "[redacted]");
  const raw = JSON.stringify(sql.exec("SELECT * FROM red_telemetry").toArray());
  assert.ok(!raw.includes("never-store"));
  assert.ok(!raw.includes("sk-this"));
  assert.ok(!raw.includes("thinking"));
  assert.throws(() =>
    t.record({ sessionId: "a", runId: "b", kind: "thinking" } as never),
  );
  db.close();
});
test("telemetry retention, pagination, run attribution, summaries survive reopen", () => {
  const { db, sql } = setup();
  const t = new TelemetryStore(sql, 10);
  for (let n = 0; n < 15; n++)
    t.record({
      sessionId: "s",
      runId: "run-" + n,
      kind: "run_end",
      outcome: "ok",
    });
  const reopened = new TelemetryStore(sql, 10);
  assert.equal(reopened.summary().counts.run_end, 10);
  const page = reopened.query({ limit: 3 });
  assert.equal(page.events.length, 3);
  assert.equal(
    reopened.query({ beforeId: page.nextBeforeId!, limit: 100 }).events.length,
    7,
  );
  assert.equal(reopened.hasRun("run-0"), false);
  assert.equal(reopened.query({ runId: "run-14" }).events.length, 1);
  assert.throws(() => reopened.query({ beforeId: NaN }));
  db.close();
});
test("skills require trigger-led descriptions, positive/negative tests and reject credentials", () => {
  const p = proposal();
  assert.throws(() =>
    validateSkill({ ...p, description: "Useful instructions" }),
  );
  assert.throws(() =>
    validateSkill({ ...p, cases: [{ text: "x", expected: true }] }),
  );
  assert.throws(() =>
    validateSkill({ ...p, instructions: "api_key=super-secret" }),
  );
  assert.throws(() =>
    validateSkill({ ...p, sources: ["https://example.com/?token=abc"] }),
  );
});
test("proposals are inert, tests honest, owner activation CAS and rollback reversible", () => {
  const { db, sql } = setup();
  const store = new SkillsStore(sql);
  const a = store.propose(proposal());
  assert.equal(a.status, "proposal");
  assert.throws(() => store.activate(a.revisionId, null), /tests/);
  const result = store.evaluate(a.revisionId);
  assert.equal(result.passed, true);
  assert.equal(result.independentEvidence, false);
  store.activate(a.revisionId, null);
  const b = store.propose({
    ...proposal(),
    instructions: "Read the quota reset timestamp first.",
  });
  store.evaluate(b.revisionId);
  assert.throws(() => store.activate(b.revisionId, null), /changed/);
  store.activate(b.revisionId, a.revisionId);
  assert.equal(store.read(a.revisionId).status, "tested");
  store.rollback(a.name, a.revisionId, b.revisionId);
  assert.equal(new SkillsStore(sql).read(a.revisionId).status, "active");
  assert.throws(() => store.rollback("other", a.revisionId, a.revisionId));
  db.close();
});
test("failing routing cases cannot activate; docs strictly pinned and paginated", () => {
  const { db, sql } = setup();
  const store = new SkillsStore(sql);
  const s = store.propose({
    ...proposal(),
    trigger: { any: ["never-match"], none: [] },
  });
  assert.equal(store.evaluate(s.revisionId).passed, false);
  assert.throws(() => store.activate(s.revisionId, null));
  const docs = listDocs();
  assert.equal(docs.length, 3);
  assert.equal(docs[0].version, "1.3.0");
  assert.equal(readDoc(docs[0].id).text.length, 2000);
  assert.ok(readDoc(docs[0].id).nextOffset);
  assert.throws(() => readDoc("https://attacker.example"));
  assert.throws(() => readDoc(docs[0].id, -1));
  db.close();
});
test("skill proposals are retry-idempotent and first activation can be deactivated", () => {
  const { db, sql } = setup();
  const store = new SkillsStore(sql);
  const p = proposal();
  const a = store.propose(p, "task-1");
  assert.equal(store.propose(p, "task-1").revisionId, a.revisionId);
  assert.equal(store.list().length, 1);
  assert.throws(
    () => store.propose({ ...p, instructions: "Changed procedure." }, "task-1"),
    /different input/,
  );
  store.evaluate(a.revisionId);
  store.activate(a.revisionId, null);
  store.rollback(a.name, null, a.revisionId);
  assert.equal(store.read(a.revisionId).status, "tested");
  db.close();
});
test("host evaluation stores attributed provenance without promoting skill state", async () => {
  const { db, sql } = setup();
  const store = new SkillsStore(sql);
  const s = store.propose(proposal());
  const result = await store.evaluateRecordedActions(
    s.revisionId,
    {
      id: "held-out-fixture",
      source: "local:test-fixture",
      labelProvenance: "host-curated-recorded-actions",
      trajectories: [
        {
          runId: "held-out-1",
          inferredGoal: "Recover quota",
          steps: [
            {
              observation: "quota limit",
              scoreable: true,
              action: { type: "wait", target: "quota-reset" },
            },
          ],
        },
      ],
    },
    async (input) => ({
      type: input.library ? "wait" : "retry",
      target: "quota-reset",
    }),
  );
  assert.equal(result.improved, true);
  assert.equal(result.labelsIndependentlyVerified, false);
  assert.equal(store.read(s.revisionId).status, "proposal");
  assert.equal(store.evaluations(s.revisionId).length, 1);
  assert.throws(() => store.activate(s.revisionId, null));
  db.close();
});
test("telemetry links to archives with generated IDs, numeric validation and byte-bounded pages", () => {
  const { db, sql } = setup();
  const t = new TelemetryStore(sql);
  const first = t.record({
    sessionId: "session",
    runId: "run",
    kind: "failure",
    sourceEntryId: "entry-1",
    archiveMessageId: 42,
  });
  assert.equal(first.archiveMessageId, 42);
  assert.equal(first.sourceEntryId, "entry-1");
  const invalid = t.record({
    sessionId: "session",
    runId: "run",
    kind: "failure",
    archiveMessageId: -1,
    sourceEntryId: "Bearer credentials",
  });
  assert.equal(invalid.archiveMessageId, undefined);
  assert.equal(invalid.sourceEntryId, "[redacted]");
  for (let n = 0; n < 100; n++)
    t.record({
      sessionId: "s".repeat(128),
      runId: "r".repeat(128),
      kind: "tool_end",
      sourceEntryId: "e".repeat(128),
      tool: "t".repeat(128),
      archiveMessageId: n,
    });
  const page = t.query({ limit: 100 });
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < 13000);
  assert.ok(page.nextBeforeId);
  db.close();
});
test("skill metadata pages keep older revisions discoverable", () => {
  const { db, sql } = setup();
  const s = new SkillsStore(sql);
  for (let n = 0; n < 10; n++)
    s.propose({
      ...proposal(),
      description:
        "Use when " + "quota ".repeat(150) + "; avoid authentication.",
    });
  const page = s.listPage();
  assert.equal(page.items.length, 8);
  assert.equal(s.listPage(page.nextOffset!).items.length, 2);
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < 12000);
  assert.throws(() => s.listPage(-1));
  db.close();
});
test("skill list pages account for JSON escape expansion", () => {
  const { db, sql } = setup();
  const s = new SkillsStore(sql);
  for (let n = 0; n < 8; n++)
    s.propose({
      ...proposal(),
      description:
        "Use when " + "\u0001".repeat(900) + "; avoid authentication.",
    });
  const page = s.listPage();
  assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < 13000);
  assert.ok(page.nextOffset);
  db.close();
});

import { PINNED_DOCS } from "../src/skill-docs.ts";
test("documentation pages are bounded after JSON encoding and reconstruct exactly", () => {
  for (const doc of PINNED_DOCS) {
    let offset: number | null = 0;
    let reconstructed = "";
    while (offset !== null) {
      const page = readDoc(doc.id, offset);
      assert.ok(new TextEncoder().encode(JSON.stringify(page)).length < 14000);
      assert.ok(page.text.length <= 2000);
      reconstructed += page.text;
      if (page.nextOffset !== null)
        assert.equal(page.nextOffset, offset + page.text.length);
      offset = page.nextOffset;
    }
    assert.equal(reconstructed, doc.content);
  }
});
