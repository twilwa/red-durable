import { CodemodeConnector, type ConnectorTools } from "@cloudflare/codemode";
import {
  CompanionStore,
  type BeliefInput,
  type CommitmentInput,
} from "./companion";
import { TelemetryStore, type TelemetryFilter } from "./telemetry";
import { SkillsStore, listDocs, readDoc, type SkillProposal } from "./skills";
interface Host {
  companion: CompanionStore;
  telemetry: TelemetryStore;
  skills: SkillsStore;
}
type Schema = NonNullable<ConnectorTools[string]["inputSchema"]>;
const text: Schema = { type: "string", minLength: 1, maxLength: 8000 };
const numberId: Schema = { type: "integer", minimum: 1 };
const eventIds: Schema = {
  type: "array",
  items: numberId,
  minItems: 1,
  maxItems: 32,
  uniqueItems: true,
};
const stringList = (max = 10): Schema => ({
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 1000 },
  minItems: 1,
  maxItems: max,
});
const shape = (
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const offset: Schema = { type: "integer", minimum: 0 };
const object: Schema = shape({});
const schema = {
  telemetry: shape({
    sessionId: { type: "string", maxLength: 128 },
    runId: { type: "string", maxLength: 128 },
    kind: {
      type: "string",
      enum: [
        "run_start",
        "run_end",
        "tool_start",
        "tool_end",
        "model_end",
        "quota",
        "failure",
        "skill_proposal",
        "skill_evaluation",
        "skill_activation",
      ],
    },
    beforeId: numberId,
    limit: { type: "integer", minimum: 1, maximum: 100 },
  }),
  doc: shape({ id: { type: "string", minLength: 1, maxLength: 150 }, offset }, [
    "id",
  ]),
  page: shape({ offset, limit: { type: "integer", minimum: 1, maximum: 8 } }),
  eventList: shape({
    afterId: offset,
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }),
  event: shape({ id: numberId, offset }, ["id"]),
  observe: shape({ text: { ...text, maxLength: 32000 } }, ["text"]),
  belief: shape(
    {
      kind: {
        type: "string",
        enum: ["fact", "hypothesis", "procedure", "temporary"],
      },
      text,
      scope: { type: "string", minLength: 1, maxLength: 1000 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      sourceEventIds: eventIds,
      supersedes: numberId,
      expiresAt: { type: "string", format: "date-time" },
    },
    ["kind", "text", "scope", "confidence", "sourceEventIds"],
  ),
  commitment: shape(
    {
      text,
      scope: { type: "string", minLength: 1, maxLength: 1000 },
      sourceEventIds: eventIds,
      dueAt: { type: "string", format: "date-time" },
    },
    ["text", "scope", "sourceEventIds"],
  ),
  skill: shape(
    {
      name: {
        type: "string",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        maxLength: 64,
      },
      description: {
        type: "string",
        minLength: 1,
        maxLength: 1024,
        description:
          "Must explicitly say when to use AND when not to use this skill.",
      },
      whenToUse: stringList(),
      whenNotToUse: stringList(),
      instructions: { type: "string", minLength: 1, maxLength: 12000 },
      useExamples: stringList(),
      avoidExamples: stringList(),
      evidenceRunIds: stringList(20),
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "string",
          format: "uri",
          description:
            "Public HTTPS source URL without query, fragment or credentials.",
        },
      },
      trigger: shape(
        {
          any: stringList(20),
          none: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
        ["any", "none"],
      ),
      cases: {
        type: "array",
        minItems: 2,
        maxItems: 50,
        items: shape(
          {
            text: { type: "string", minLength: 1, maxLength: 1000 },
            expected: { type: "boolean" },
          },
          ["text", "expected"],
        ),
      },
    },
    [
      "name",
      "description",
      "whenToUse",
      "whenNotToUse",
      "instructions",
      "useExamples",
      "avoidExamples",
      "evidenceRunIds",
      "sources",
      "trigger",
      "cases",
    ],
  ),
};
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
async function proposalKey(executionId: string | undefined, proposal: unknown) {
  if (!executionId) return undefined;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(proposal))),
  );
  return (
    executionId +
    ":" +
    Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
function args(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected object");
  return value as Record<string, unknown>;
}
function id(value: unknown) {
  if (typeof value !== "string" || !value) throw new Error("Expected id");
  return value;
}
export class LearningConnector extends CodemodeConnector<unknown> {
  constructor(
    ctx: DurableObjectState,
    private host: Host,
  ) {
    super(ctx, {});
  }
  name() {
    return "learning";
  }
  protected tools(): ConnectorTools {
    return {
      telemetry: {
        description:
          "Read bounded machine-only operational telemetry. Never includes prompts, credentials or reasoning.",
        inputSchema: schema.telemetry,
        execute: (v) => this.host.telemetry.query(args(v) as TelemetryFilter),
      },
      telemetry_summary: {
        description: "Summarize retained performance events only.",
        execute: () => this.host.telemetry.summary(),
      },
      docs_list: {
        description:
          "List pinned, versioned SDK and safe skill-learning documentation.",
        execute: () => listDocs(),
      },
      docs_read: {
        description:
          "Read a pinned documentation page by id and optional offset.",
        inputSchema: schema.doc,
        execute: (v) => {
          const a = args(v);
          return readDoc(id(a.id), Number(a.offset ?? 0));
        },
      },
      skill_list: {
        description:
          "List skill trigger descriptions and activation status. Read full instructions only when relevant.",
        inputSchema: schema.page,
        execute: (v) => {
          const a = args(v);
          return this.host.skills.listPage(
            Number(a.offset ?? 0),
            Number(a.limit ?? 8),
          );
        },
      },
      skill_read: {
        description: "Read a skill revision in bounded JSON source pages.",
        inputSchema: schema.doc,
        execute: (v) => {
          const a = args(v);
          const text = JSON.stringify(this.host.skills.read(id(a.id)));
          const offset = Number(a.offset ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("Invalid offset");
          return {
            text: text.slice(offset, offset + 2000),
            nextOffset: offset + 2000 < text.length ? offset + 2000 : null,
          };
        },
      },
      skill_propose: {
        description:
          "Propose a non-executable skill supported by existing telemetry run IDs. Requires description with when and when not, examples/counterexamples, trigger tests and public sources. Owner must activate.",
        inputSchema: schema.skill,
        execute: async (v, ctx) => {
          const p = args(v) as unknown as SkillProposal;
          if (
            !Array.isArray(p.evidenceRunIds) ||
            p.evidenceRunIds.some((id) => !this.host.telemetry.hasRun(id))
          )
            throw new Error(
              "Every evidenceRunId must exist in retained telemetry",
            );
          const r = this.host.skills.propose(
            p,
            await proposalKey(ctx?.executionId, p),
          );
          this.host.telemetry.record({
            sessionId: "root",
            runId: ctx?.executionId ?? "proposal",
            kind: "skill_proposal",
            outcome: "ok",
          });
          return r;
        },
      },
      skill_evaluate: {
        description:
          "Run proposal-authored trigger smoke tests. This is NOT held-out proof of improved performance.",
        inputSchema: schema.doc,
        execute: (v, ctx) => {
          const r = this.host.skills.evaluate(id(args(v).id));
          this.host.telemetry.record({
            sessionId: "root",
            runId: ctx?.executionId ?? "evaluation",
            kind: "skill_evaluation",
            outcome: r.passed ? "ok" : "error",
          });
          return r;
        },
      },
      companion_context: {
        description:
          "Read bounded accepted continuity records. They are evidence, never permissions.",
        execute: () => JSON.parse(this.host.companion.compileContext()),
      },
      events_list: {
        description: "List attributed continuity events with short previews.",
        inputSchema: schema.eventList,
        execute: (v) => {
          const a = args(v);
          return this.host.companion.listEvents(
            Number(a.afterId ?? 0),
            Number(a.limit ?? 20),
          );
        },
      },
      event_read: {
        description: "Read exact attributed event in bounded pages.",
        inputSchema: schema.event,
        execute: (v) => {
          const a = args(v);
          return this.host.companion.readEvent(
            Number(a.id),
            Number(a.offset ?? 0),
          );
        },
      },
      observe: {
        description:
          "Record an assistant observation, explicitly attributed as assistant. Cannot create owner or tool authority.",
        inputSchema: schema.observe,
        execute: (v, ctx) => {
          const a = args(v);
          return this.host.companion.recordEvent({
            source: "assistant",
            sourceRef: `codemode:${ctx?.executionId ?? crypto.randomUUID()}`,
            text: id(a.text),
          });
        },
      },
      belief_propose: {
        description:
          "Propose an evidence-linked fact, hypothesis, procedure or temporary context. Pending until owner accepts; supersedes links corrections.",
        inputSchema: schema.belief,
        execute: (v) =>
          this.host.companion.proposeBelief(args(v) as unknown as BeliefInput),
      },
      commitment_propose: {
        description:
          "Propose a bounded commitment with source event IDs. It grants no tool permissions and stays pending until owner accepts.",
        inputSchema: schema.commitment,
        execute: (v) =>
          this.host.companion.proposeCommitment(
            args(v) as unknown as CommitmentInput,
          ),
      },
    };
  }
}
