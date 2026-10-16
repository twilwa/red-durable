import {
  modelProvider,
  isMeteredModel,
  requireModelBillingApproval,
} from "../shared/providers.ts";
import { Agent } from "agents";
import { CompanionStore } from "./companion";
import { TelemetryStore } from "./telemetry";
import { SkillsStore } from "./skills";
import { LearningConnector } from "./learning-connector";
import {
  BridgeQueue,
  BridgeLeaseError,
  type BridgeResult,
} from "./bridge-queue";
import { subscriptionProvider } from "./bridge-provider";
import { DiscordQueue } from "./discord-queue";
import {
  discordBinding,
  DiscordError,
  type DiscordEnvironment,
  type DiscordInput,
  type DiscordBinding,
} from "../shared/discord";
import {
  LifecycleCapability,
  type LifecycleJobOutcome,
} from "agents/lifecycle";
import { facetJson } from "./facet";
import { PiHarness } from "agents/harness/pi";
import {
  Type,
  InMemoryCredentialStore,
  createModels,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  hook,
  GenerationTask,
  ToolTask,
  section,
} from "@earendil-works/pi-durable";
import {
  CodemodeConnector,
  createCodemodeRuntime,
  DynamicWorkerExecutor,
  truncateResult,
  type ConnectorTools,
} from "@cloudflare/codemode";
import { DurableMemory } from "./memory";
import {
  supervisorPrompt,
  withConversationMemory,
  summaryContext,
} from "./prompt-context";
import { ReleaseManager, DEFAULT_BEHAVIOR_SOURCE } from "./releases";
import { authorized, body, json, string } from "./security";
export { CodemodeRuntime } from "@cloudflare/codemode";

interface Env extends DiscordEnvironment {
  RED: DurableObjectNamespace<RedAgent>;
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
  OWNER_TOKEN?: string;
  BRIDGE_TOKEN?: string;
  OPENAI_API_KEY?: string;
  ALLOW_PAID_API?: string;
  MODEL_ID: string;
  SUMMARY_MODEL_ID?: string;
}
const output = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(truncateResult(value, { maxChars: 16000 })),
    },
  ],
});

class SelfConnector extends CodemodeConnector<Env> {
  constructor(
    ctx: DurableObjectState,
    env: Env,
    private releases: ReleaseManager,
    private memory: DurableMemory,
  ) {
    super(ctx, env);
  }
  name() {
    return "self";
  }
  protected tools(): ConnectorTools {
    return {
      starter: {
        description:
          "Read the trusted starter MutableAgent source and HTTP contract for your first revision.",
        execute: () => ({
          source: DEFAULT_BEHAVIOR_SOURCE,
          contract:
            "Export MutableAgent extending DurableObject. GET /health -> {ok:true,contractVersion:1}; GET /behavior -> {systemPromptSuffix:string,tools?:array}; POST /tool {name,args} -> bounded JSON. Imports limited to bundled JavaScript and cloudflare:workers; no network or credentials.",
        }),
      },
      list: {
        description:
          "List source revision metadata (no source) and active revision, newest first; page with offset.",
        inputSchema: {
          type: "object",
          properties: { offset: { type: "integer", minimum: 0 } },
        },
        execute: async (a) => {
          const offset = (a as { offset?: number })?.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("Invalid offset");
          const all = await this.releases.list();
          return {
            active: await this.releases.active(),
            revisions: all
              .slice(offset, offset + 4)
              .map(({ source, ...r }) => ({
                ...r,
                description: r.description.slice(0, 300),
                sourceLength: source.length,
              })),
            nextOffset: offset + 4 < all.length ? offset + 4 : null,
          };
        },
      },
      read: {
        description:
          "Read exact source in 2,000-character pages. Follow nextOffset until null before editing.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["id"],
        },
        execute: async (a) => {
          const v = a as { id: unknown; offset?: number };
          const offset = v.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error("Invalid offset");
          const r = await this.releases.get(string(v.id));
          return {
            id: r.id,
            source: r.source.slice(offset, offset + 2000),
            offset,
            nextOffset: offset + 2000 < r.source.length ? offset + 2000 : null,
            total: r.source.length,
          };
        },
      },
      stage: {
        description:
          "Stage executable JS exporting MutableAgent. No credentials or network. Owner must activate.",
        inputSchema: {
          type: "object",
          properties: {
            source: { type: "string" },
            description: { type: "string" },
          },
          required: ["source", "description"],
        },
        execute: (a) => {
          const v = a as Record<string, unknown>;
          return this.releases.propose({
            source: string(v.source, 128000),
            description: string(v.description, 2000),
          });
        },
      },
      test: {
        description:
          "Validate a staged revision in an isolated candidate facet.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        execute: (a) =>
          this.releases.validate(string((a as { id: unknown }).id)),
      },
      zoom: {
        description: "Recover exact archived messages or finer memory tiles.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "integer" },
            count: { type: "integer" },
            offset: { type: "integer" },
          },
          required: ["id", "count"],
        },
        execute: (a) => {
          const v = a as { id: number; count: number; offset?: number };
          return this.memory.zoom(v.id, v.count, v.offset);
        },
      },
    };
  }
}

class Maintenance extends LifecycleCapability {
  constructor(private owner: RedAgent) {
    super("red-maintenance");
  }
  async wake() {
    await this.lifecycle.jobs.push({
      id: "maintain",
      fn: "maintain",
      time: Date.now(),
      singleflight: true,
      hungTimeoutSeconds: 180,
    });
  }
  async onJob(): Promise<LifecycleJobOutcome> {
    await this.owner.recoverAdmissions();
    await this.owner.exclusive(() => this.owner.reconcileArchive());
    await this.owner.exclusive(() => this.owner.reconcileOperations());
    await this.owner.processDiscord();
    const result = await this.owner.summarize();
    if (
      (await this.owner.harness.pending()).length ||
      result?.pending ||
      this.owner.discordPending()
    )
      return { rescheduleAt: Date.now() + (result?.failed ? 60000 : 5000) };
  }
}
export class RedAgent extends Agent<Env> {
  inference: BridgeQueue;
  discord: DiscordQueue;
  companion: CompanionStore;
  telemetry: TelemetryStore;
  skills: SkillsStore;
  memory: DurableMemory;
  releases: ReleaseManager;
  models?: MutableModels;
  registry = createRegistry();
  maintenance: Maintenance;
  private gate: Promise<unknown> = Promise.resolve();
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.gate.then(fn);
    this.gate = task.catch(() => {});
    return task;
  }
  harness: PiHarness;
  code: ReturnType<typeof createCodemodeRuntime>;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.companion = new CompanionStore(ctx.storage.sql);
    this.telemetry = new TelemetryStore(ctx.storage.sql);
    this.skills = new SkillsStore(ctx.storage.sql);
    this.memory = new DurableMemory(ctx.storage.sql);
    this.inference = new BridgeQueue(ctx.storage.sql);
    this.discord = new DiscordQueue(ctx.storage.sql);
    this.releases = new ReleaseManager({
      storage: ctx.storage,
      loader: env.LOADER,
      facets: ctx.facets,
    });
    this.code = createCodemodeRuntime({
      ctx,
      connectors: [
        new SelfConnector(ctx, env, this.releases, this.memory),
        new LearningConnector(ctx, this),
      ],
      executor: new DynamicWorkerExecutor({
        loader: env.LOADER,
        globalOutbound: null,
        timeout: 15000,
      }),
      transformResult: (r) => truncateResult(r, { maxChars: 16000 }),
    });
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_operations (id TEXT PRIMARY KEY, text TEXT NOT NULL, snapshot TEXT NOT NULL, admitted INTEGER NOT NULL DEFAULT 0)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_archived (key TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_archive_links (key TEXT PRIMARY KEY,memory_id INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_finished (id TEXT PRIMARY KEY)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_run_ids (id TEXT PRIMARY KEY,machine_id TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS red_run_active (id INTEGER PRIMARY KEY,machine_id TEXT NOT NULL)",
    );
    this.registry.install(
      defineExtension({
        name: "red",
        sections: [
          section(
            "red",
            async () => {
              let suffix = "";
              if (await this.releases.active()) {
                const facet = await this.releases.getFacet();
                const r = (await facetJson(facet, "/behavior")) as {
                  systemPromptSuffix?: unknown;
                };
                if (typeof r.systemPromptSuffix !== "string")
                  throw new Error("Invalid behavior contract");
                suffix = r.systemPromptSuffix.slice(0, 8000);
              }
              return supervisorPrompt({
                suffix,
                charter: this.companion.charter()?.text,
                activeSkills: this.skills
                  .list()
                  .filter((s) => s.status === "active")
                  .slice(0, 12)
                  .map((s) => ({
                    id: s.revisionId,
                    name: s.name,
                    description: s.description,
                  })),
              });
            },
            { tag: false },
          ),
        ],
        tools: [
          defineTool({
            name: "codemode_search",
            description:
              "Discover available self-modification, telemetry, skill-learning and companion memory tools by keyword.",
            parameters: Type.Object({ query: Type.String() }),
            replay: "safe",
            execute: async ({ query }) => output(await this.code.search(query)),
          }),
          defineTool({
            name: "codemode_describe",
            description:
              "Get exact TypeScript documentation for a connector or method before use.",
            parameters: Type.Object({ target: Type.String() }),
            replay: "safe",
            execute: async ({ target }) =>
              output(await this.code.describe(target)),
          }),
          defineTool({
            name: "codemode",
            description:
              "Run an async JavaScript function in an isolated Worker. API: self.list({offset?}), self.read({id,offset?}), self.stage({source,description}), self.test({id}), self.zoom({id,count,offset}). Return the result. Also use learning.* for telemetry, pinned docs, proposed skills, attributed observations and proposed commitments; discover exact methods with codemode_search/describe. Cannot activate releases, skills or memories.",
            parameters: Type.Object({
              code: Type.String({ maxLength: 64000 }),
            }),
            execute: async ({ code }) =>
              output(await this.code.execute({ code })),
          }),
          defineTool({
            name: "memory_zoom",
            description:
              "Inspect exact immutable memory. count=1 returns raw paginated message; power-of-two count returns aligned child summaries.",
            parameters: Type.Object({
              id: Type.Integer({ minimum: 0 }),
              count: Type.Integer({ minimum: 1 }),
              offset: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            replay: "safe",
            execute: async ({ id, count, offset }) =>
              output(this.memory.zoom(id, count, offset)),
          }),
          defineTool({
            name: "memory_date",
            description: "Read archived message timestamp.",
            parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
            replay: "safe",
            execute: async ({ id }) => output(this.memory.date(id)),
          }),
          defineTool({
            name: "behavior_call",
            description:
              "Invoke a tool in your active self-modifiable facet. Default tools: counter_get, counter_increment({amount:integer 1..100}). Read active source to inspect customized API. Facet has private durable SQLite and no network.",
            parameters: Type.Object({
              name: Type.String(),
              args: Type.Record(Type.String(), Type.Unknown()),
            }),
            execute: async (args) => {
              const facet = await this.releases.getFacet();
              return output(await facetJson(facet, "/tool", args));
            },
          }),
        ],
        hooks: [
          hook(GenerationTask, {
            beforeRequest: async (request) => {
              const snapshot =
                (await ctx.storage.get<string>("red_memory_snapshot")) ?? "";
              const messages = withConversationMemory(request.messages, {
                archive: snapshot,
                continuity: this.companion.compileContext(10000),
                discordAttachmentCount:
                  this.discord.active()?.input.attachmentCount,
              });
              if (
                new TextEncoder().encode(JSON.stringify(messages)).length >
                256000
              )
                throw new Error(
                  "Current turn exceeded the bounded context budget. Start a shorter turn.",
                );
              // Pi resets only between idle runs. Its active transcript includes all current tool rounds and steers.
              return { messages };
            },
          }),
        ],
      }),
    );
    this.harness = new PiHarness({
      harness: async ({ storage, context }) => {
        const credentials = new InMemoryCredentialStore();
        if (env.ALLOW_PAID_API === "true" && env.OPENAI_API_KEY)
          await credentials.modify("openai", async () => ({
            type: "api_key",
            key: env.OPENAI_API_KEY,
          }));
        const models = createModels({ credentials });
        if (env.ALLOW_PAID_API === "true") models.setProvider(openaiProvider());
        else
          models.setProvider(
            subscriptionProvider(this.inference, () => [
              ...new Set([
                env.MODEL_ID,
                env.SUMMARY_MODEL_ID ?? env.MODEL_ID,
                ...this.inference.models(),
              ]),
            ]),
          );
        this.models = models;
        return Harness.open(
          storage,
          {
            models,
            registry: this.registry,
            settings: { compaction: { enabled: false }, contextRetentionMs: 0 },
          },
          context,
        );
      },
      defaults: {
        model: {
          provider:
            env.ALLOW_PAID_API === "true" ? "openai" : "red-subscription",
          id: env.MODEL_ID,
        },
      },
    });
    this.lifecycle.use(this.harness);
    this.maintenance = new Maintenance(this);
    this.lifecycle.use(this.maintenance);
  }
  async onStart() {
    if (
      this.memory.stats().pending ||
      this.discordPending() ||
      this.ctx.storage.sql
        .exec("SELECT id FROM red_operations WHERE admitted=0 LIMIT 1")
        .toArray().length
    )
      await this.maintenance.wake();
  }
  async recoverAdmissions() {
    await this.exclusive(() => this.recoverAdmissionsLocked());
  }
  async recoverAdmissionsLocked() {
    for (const row of this.ctx.storage.sql
      .exec<{ id: string; text: string }>(
        "SELECT id,text FROM red_operations WHERE admitted=0 ORDER BY rowid",
      )
      .toArray()) {
      await this.harness.submit(row.text, {
        operationId: row.id,
        whenBusy: "steer",
      });
      this.ctx.storage.sql.exec(
        "UPDATE red_operations SET admitted=1 WHERE id=?",
        row.id,
      );
    }
  }
  async reconcileArchive() {
    for (const entry of await this.harness.messages()) {
      if (entry.kind !== "pi.assistant" && entry.kind !== "pi.tool-result")
        continue;
      const model = entry.model?.map((message) => ({
        ...message,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.filter((c) => c.type !== "thinking"),
      }));
      const text = JSON.stringify(model);
      const key = `entry:${entry.id}`;
      const existed =
        this.ctx.storage.sql
          .exec("SELECT key FROM red_archived WHERE key=?", key)
          .toArray().length > 0;
      const discordRun = this.discord.active();
      if (!existed && entry.kind === "pi.assistant" && discordRun) {
        const activeRun = this.ctx.storage.sql
          .exec<{ machine_id: string }>(
            "SELECT machine_id FROM red_run_active WHERE id=1",
          )
          .toArray()[0]?.machine_id;
        if (activeRun !== discordRun.runId)
          throw new Error("Discord run routing mismatch");
        const reply = (entry.model ?? [])
          .filter(
            (m) =>
              m.role === "assistant" &&
              (m.stopReason === "stop" || m.stopReason === "length"),
          )
          .flatMap((m) =>
            typeof m.content === "string"
              ? [m.content]
              : m.content
                  .filter((c) => c.type === "text")
                  .map((c) => (c as { text: string }).text),
          )
          .join("\n");
        this.ctx.storage.transactionSync(() =>
          this.discord.enqueue(
            discordRun.input.id,
            String(entry.id),
            reply,
            discordRun.binding,
          ),
        );
      }
      const archiveMessageId = this.archiveOnce(
        key,
        entry.kind === "pi.assistant" ? "unii" : "tool",
        text,
      );
      if (!existed) {
        const m = entry.model?.[0];
        this.telemetry.record({
          sessionId: "root",
          runId: String(
            this.ctx.storage.sql
              .exec<{ machine_id: string }>(
                "SELECT machine_id FROM red_run_active WHERE id=1",
              )
              .toArray()[0]?.machine_id ?? `entry-${entry.id}`,
          ),
          sourceEntryId: String(entry.id),
          archiveMessageId,
          kind: entry.kind === "pi.assistant" ? "model_end" : "tool_end",
          outcome:
            m?.role === "toolResult"
              ? m.isError
                ? "error"
                : "ok"
              : m?.role === "assistant"
                ? m.stopReason === "error"
                  ? "error"
                  : "ok"
                : "ok",
          ...(m?.role === "assistant"
            ? {
                inputTokens: m.usage.input,
                outputTokens: m.usage.output,
                cacheReadTokens: m.usage.cacheRead,
                cacheWriteTokens: m.usage.cacheWrite,
                durationMs: m.durationMs,
              }
            : {}),
          ...(m?.role === "toolResult"
            ? { tool: m.toolName, durationMs: m.durationMs }
            : {}),
        });
      }
    }
  }
  async reconcileOperations() {
    const pending = new Set(
      (await this.harness.pending()).map((p) => p.operationId),
    );
    for (const row of this.ctx.storage.sql
      .exec<{ id: string; machine_id: string }>(
        "SELECT o.id,r.machine_id FROM red_operations o LEFT JOIN red_finished f ON o.id=f.id LEFT JOIN red_run_ids r ON r.id=o.id WHERE o.admitted=1 AND f.id IS NULL LIMIT 100",
      )
      .toArray()) {
      if (pending.has(row.id)) continue;
      const result = await this.harness.wait(row.id);
      // Pi can finish between a prior archive scan and this completion check.
      // Flush the now-terminal transcript before removing its transport route.
      if (this.discord.active()?.input.id === row.id.replace(/^discord:/, ""))
        await this.reconcileArchive();
      this.ctx.storage.transactionSync(() => {
        this.telemetry.record({
          sessionId: "root",
          runId: row.machine_id ?? crypto.randomUUID(),
          kind: "run_end",
          outcome: result.status === "done" ? "ok" : "error",
        });
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO red_finished(id) VALUES (?)",
          row.id,
        );
        const discordRun = this.discord.active();
        if (discordRun && row.id === `discord:${discordRun.input.id}`) {
          if (result.status !== "done")
            this.discord.enqueue(
              discordRun.input.id,
              "ended",
              "This turn ended before a complete reply. Check red's private interface before retrying.",
              discordRun.binding,
            );
          this.discord.complete(discordRun.input.id);
        }
      });
    }
  }
  archiveOnce(key: string, kind: string, text: string): number | undefined {
    if (
      this.ctx.storage.sql
        .exec("SELECT key FROM red_archived WHERE key=?", key)
        .toArray().length
    ) {
      const row = this.ctx.storage.sql
        .exec<{ memory_id: number }>(
          "SELECT memory_id FROM red_archive_links WHERE key=?",
          key,
        )
        .toArray()[0];
      return row?.memory_id;
    }
    return this.ctx.storage.transactionSync(() => {
      const id = this.memory.append(kind, text);
      this.ctx.storage.sql.exec(
        "INSERT INTO red_archived(key) VALUES (?)",
        key,
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO red_archive_links(key,memory_id) VALUES (?,?)",
        key,
        id,
      );
      return id;
    });
  }

  async summarize() {
    if (!this.models) return;
    const model = this.models.getModel(
      this.env.ALLOW_PAID_API === "true" ? "openai" : "red-subscription",
      this.env.ALLOW_PAID_API === "true"
        ? (this.env.SUMMARY_MODEL_ID ?? this.env.MODEL_ID)
        : ((await this.ctx.storage.get<string>("bridge:model")) ??
            this.env.MODEL_ID),
    );
    if (!model) return;
    return this.memory.settle(async ({ source, context, id, count, kind }) => {
      const sourceDigest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(source),
      );
      const sourceId = Array.from(new Uint8Array(sourceDigest), (x) =>
        x.toString(16).padStart(2, "0"),
      ).join("");
      const r = await this.models!.completeSimple(
        model,
        summaryContext({ context, source }),
        {
          maxTokens: 180,
          sessionId: `red-memory:${kind}:${id}:${count}:${sourceId}`,
          signal: AbortSignal.timeout(15000),
        },
      );
      if (r.stopReason === "error" || r.stopReason === "deferred")
        throw new Error("Summary inference pending or unavailable");
      return r.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
    }, 16);
  }
  discordPending(): boolean {
    try {
      const binding = discordBinding(this.env);
      return Boolean(binding && this.discord.hasQueued(binding));
    } catch {
      return false;
    }
  }
  async processDiscord() {
    let binding: DiscordBinding | null;
    try {
      binding = discordBinding(this.env);
    } catch {
      return;
    }
    if (
      !binding ||
      this.discord.active() ||
      (await this.harness.session().busy())
    )
      return;
    const input = this.discord.next(binding);
    if (!input) return;
    if (!input.text.trim()) {
      await this.exclusive(async () =>
        this.ctx.storage.transactionSync(() => {
          this.discord.enqueue(
            input.id,
            "attachments",
            "Attachments aren't supported by this text-only connection yet. Please send the question as text.",
            binding,
          );
          this.discord.complete(input.id);
        }),
      );
      return;
    }
    try {
      await this.admitChat(
        { id: `discord:${input.id}`, text: input.text },
        { input, binding },
      );
    } catch (error) {
      if (!(error instanceof DiscordError && error.status === 409)) throw error;
    }
  }
  async admitChat(
    input: Record<string, unknown>,
    transport?: { input: DiscordInput; binding: DiscordBinding },
  ): Promise<Response> {
    if (
      this.env.ALLOW_PAID_API === "true"
        ? !this.env.OPENAI_API_KEY
        : !this.env.BRIDGE_TOKEN ||
          this.env.BRIDGE_TOKEN.length < 32 ||
          this.env.BRIDGE_TOKEN === this.env.OWNER_TOKEN
    )
      return json(
        {
          error:
            "Inference bridge is not connected; no automatic provider fallback is enabled.",
        },
        503,
      );
    if (this.env.ALLOW_PAID_API !== "true") {
      const selected =
        (await this.ctx.storage.get<string>("bridge:model")) ??
        this.env.MODEL_ID;
      if (!this.inference.models().includes(selected))
        return json(
          {
            error:
              "Connect a provider through the trusted bridge and explicitly choose an available model before starting the first turn.",
          },
          503,
        );
    }
    const id = string(input.id, 100),
      text = string(input.text, 32000);
    if (new TextEncoder().encode(text).length > 32000)
      throw new Error("Message exceeds32KB UTF-8 limit");
    let receipt: unknown;
    await this.exclusive(async () => {
      await this.recoverAdmissionsLocked();
      await this.reconcileArchive();
      await this.reconcileOperations();
      const activeDiscord = this.discord.active();
      if (activeDiscord && !transport)
        throw new DiscordError(
          "A private Discord turn is active; wait for it to finish or stop it before browser chat",
          409,
        );
      if (transport && (await this.harness.session().busy()))
        throw new DiscordError(
          "Discord message remains queued while another turn is active",
          409,
        );
      const existing = this.ctx.storage.sql
        .exec<{ text: string }>(
          "SELECT text FROM red_operations WHERE id=?",
          id,
        )
        .toArray()[0];
      if (existing && existing.text !== text)
        throw new Error("Operation id already used for different input");
      if (!existing) {
        const freshRun = !(await this.harness.session().busy());
        if (freshRun) {
          await this.reconcileArchive();
          const view = this.memory.renderView();
          if (new TextEncoder().encode(view).length > 128000)
            throw new Error(
              "Memory summaries are catching up. Please retry shortly.",
            );
          await this.harness.session().reset();
          await this.ctx.storage.put(
            "red_memory_snapshot",
            this.memory.renderView(),
          );
        }
        const snapshot =
          (await this.ctx.storage.get<string>("red_memory_snapshot")) ?? "";
        const machineRunId = freshRun
          ? crypto.randomUUID()
          : (this.ctx.storage.sql
              .exec<{ machine_id: string }>(
                "SELECT machine_id FROM red_run_active WHERE id=1",
              )
              .toArray()[0]?.machine_id ?? crypto.randomUUID());
        await this.maintenance.wake();
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec(
            "INSERT INTO red_operations(id,text,snapshot) VALUES (?,?,?)",
            id,
            text,
            snapshot,
          );
          if (transport)
            this.discord.admitted(transport.input.id, machineRunId);
          this.archiveOnce(`input:${id}`, "user", text);
          this.companion.recordEvent({
            source: transport ? "import" : "owner",
            sourceRef: transport
              ? `discord:${transport.binding.guildId}:${transport.binding.channelId}:${transport.input.id}:${transport.binding.ownerId}`
              : `input:${id}`,
            text,
          });
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO red_run_active(id,machine_id) VALUES (1,?)",
            machineRunId,
          );
          this.ctx.storage.sql.exec(
            "INSERT INTO red_run_ids(id,machine_id) VALUES (?,?)",
            id,
            machineRunId,
          );
          this.telemetry.record({
            sessionId: "root",
            runId: machineRunId,
            kind: "run_start",
          });
        });
      }
      await this.maintenance.wake();
      receipt = await this.harness.submit(text, {
        operationId: id,
        whenBusy: "steer",
      });
      this.ctx.storage.sql.exec(
        "UPDATE red_operations SET admitted=1 WHERE id=?",
        id,
      );
    });
    return json(receipt, 202);
  }
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/discord/")) {
      try {
        const binding = discordBinding(this.env);
        if (!binding)
          return json({ error: "Discord transport is disabled" }, 404);
        if (
          !(await authorized(request, this.env.DISCORD_RELAY_TOKEN)) ||
          request.headers.get("X-Session") !== binding.session
        )
          return json({ error: "Unauthorized Discord transport" }, 401);
        if (request.method !== "POST") return json({ error: "Not found" }, 404);
        const value = await body(request);
        if (path === "/api/discord/message") {
          const receipt = await this.exclusive(async () =>
            this.discord.receive(value, binding),
          );
          await this.maintenance.wake();
          return json(receipt, 202);
        }
        if (path === "/api/discord/poll") {
          await this.maintenance.wake();
          return json({
            delivery: await this.exclusive(async () =>
              this.discord.poll(binding),
            ),
          });
        }
        if (path === "/api/discord/ack")
          return json(
            await this.exclusive(async () => this.discord.ack(value, binding)),
          );
        if (path === "/api/discord/retry")
          return json(
            await this.exclusive(async () =>
              this.discord.retry(value, binding),
            ),
          );
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Discord request failed",
          },
          error instanceof DiscordError ? error.status : 400,
        );
      }
    }
    if (path.startsWith("/api/bridge/")) {
      if (
        !this.env.BRIDGE_TOKEN ||
        this.env.BRIDGE_TOKEN === this.env.OWNER_TOKEN ||
        !(await authorized(request, this.env.BRIDGE_TOKEN))
      )
        return json({ error: "Unauthorized bridge" }, 401);
      try {
        if (request.method === "POST" && path === "/api/bridge/poll") {
          const b = await body(request);
          this.inference.setModels(b.modelIds ?? []);
          await this.ctx.storage.put("bridge:lastSeen", Date.now());
          return json({ job: this.inference.poll() });
        }
        if (request.method === "POST" && path === "/api/bridge/result") {
          const b = await body(request);
          const result = this.inference.finish(b as unknown as BridgeResult);
          if (result.accepted && b.error) {
            const kind = (b.error as { kind?: string }).kind;
            this.telemetry.record({
              sessionId: "root",
              runId: String(b.jobId),
              kind: kind === "quota" ? "quota" : "failure",
              outcome: "error",
              errorCode: kind === "quota" || kind === "auth" ? kind : "unknown",
            });
          }
          await this.maintenance.wake();
          return json(result);
        }
        return json({ error: "Not found" }, 404);
      } catch (error) {
        return json(
          {
            error:
              error instanceof Error ? error.message : "Bridge request failed",
          },
          error instanceof BridgeLeaseError ? 409 : 400,
        );
      }
    }
    if (!(await authorized(request, this.env.OWNER_TOKEN)))
      return json({ error: "Unauthorized" }, 401);
    try {
      if (path === "/api/providers" || path.startsWith("/api/providers/")) {
        if (request.method === "GET" && path === "/api/providers")
          return json({
            available: false,
            message:
              "Provider setup requires the trusted local bridge UI. Start npm run bridge:serve on the same computer as your browser. Hosted Worker pages never receive provider credentials.",
          });
        return json(
          {
            error:
              "Provider credentials must be entered only in the trusted local bridge UI",
          },
          409,
        );
      }
      if (request.method === "GET" && path === "/api/state") {
        await this.exclusive(() => this.reconcileArchive());
        const rows = this.ctx.storage.sql
          .exec<{ id: number; kind: string; text: string; date: string }>(
            "SELECT id,kind,text,date FROM mem_log WHERE kind IN ('user','unii') ORDER BY id DESC LIMIT 101",
          )
          .toArray();
        return json({
          discord: {
            enabled: this.env.DISCORD_ENABLED === "true",
            ...this.discord.status(),
          },
          inference: {
            mode:
              this.env.ALLOW_PAID_API === "true"
                ? "paid-api"
                : isMeteredModel(
                      (await this.ctx.storage.get<string>("bridge:model")) ??
                        this.env.MODEL_ID,
                    )
                  ? "metered-bridge"
                  : "subscription",
            providerId: modelProvider(
              (await this.ctx.storage.get<string>("bridge:model")) ??
                this.env.MODEL_ID,
            ),
            models: this.inference.models(),
            lastSeen: (await this.ctx.storage.get("bridge:lastSeen")) ?? null,
            jobs: this.inference.stats(),
            failures: this.inference.failures(),
            selected:
              (await this.ctx.storage.get("bridge:model")) ?? this.env.MODEL_ID,
          },
          history: rows.slice(0, 100).reverse(),
          historyHasMore: rows.length > 100,
          pending: await this.harness.pending(),
          memory: this.memory.stats(),
          releases: (await this.releases.list()).map(({ source, ...r }) => ({
            ...r,
            sourceLength: source.length,
          })),
          active: await this.releases.active(),
        });
      }
      if (request.method === "GET" && path === "/api/companion")
        return json(this.companion.inspect());
      if (request.method === "GET" && path === "/api/skill")
        return json(
          this.skills.read(string(new URL(request.url).searchParams.get("id"))),
        );
      if (request.method === "GET" && path === "/api/skills")
        return json({
          skills: this.skills.list(),
          telemetry: this.telemetry.summary(),
        });
      if (request.method === "POST" && path === "/api/companion") {
        const b = await body(request);
        return await this.exclusive(async () => {
          const event = this.companion.recordEvent({
            source: "owner",
            sourceRef: `owner-action:${crypto.randomUUID()}`,
            text: JSON.stringify(b),
          });
          if (b.action === "charter")
            return json(
              this.companion.ownerSetCharter(
                string(b.text, 4000),
                event.id,
                Number(b.expectedVersion),
              ),
            );
          if (b.action === "accept-belief")
            return json(
              this.companion.ownerAcceptBelief(Number(b.id), event.id),
            );
          if (b.action === "accept-commitment")
            return json(
              this.companion.ownerAcceptCommitment(Number(b.id), event.id),
            );
          if (b.action === "complete-commitment")
            return json(
              this.companion.transitionCommitment(Number(b.id), "completed", [
                event.id,
              ]),
            );
          if (b.action === "cancel-commitment")
            return json(
              this.companion.transitionCommitment(Number(b.id), "cancelled", [
                event.id,
              ]),
            );
          throw new Error("Unknown companion action");
        });
      }
      if (request.method === "POST" && path === "/api/skills/deactivate") {
        const b = await body(request);
        if (b.confirm !== "DEACTIVATE")
          throw new Error("Explicit skill deactivation required");
        return await this.exclusive(async () => {
          if (await this.harness.session().busy())
            return json({ error: "Wait for the active turn" }, 409);
          return json(
            this.skills.rollback(
              string(b.name),
              null,
              string(b.expectedActiveRevisionId),
            ),
          );
        });
      }
      if (request.method === "POST" && path === "/api/skills/activate") {
        const b = await body(request);
        if (b.confirm !== "ACTIVATE")
          throw new Error("Explicit skill approval required");
        return await this.exclusive(async () => {
          if (await this.harness.session().busy())
            return json({ error: "Wait for the active turn" }, 409);
          const r = this.skills.activate(
            string(b.id),
            b.expectedActiveRevisionId === null
              ? null
              : string(b.expectedActiveRevisionId),
          );
          this.telemetry.record({
            sessionId: "root",
            runId: crypto.randomUUID(),
            kind: "skill_activation",
            outcome: "ok",
          });
          return json(r);
        });
      }
      if (request.method === "GET" && path === "/api/revision")
        return json(
          await this.releases.get(
            string(new URL(request.url).searchParams.get("id")),
          ),
        );
      if (request.method === "GET" && path === "/api/source")
        return json({ source: DEFAULT_BEHAVIOR_SOURCE });
      if (request.method === "GET" && path === "/api/memory")
        return json({
          view: this.memory.renderView(),
          stats: this.memory.stats(),
        });
      if (request.method === "POST" && path === "/api/inference/retry") {
        const b = await body(request);
        if (b.confirm !== "RETRY")
          throw new Error("Explicit retry confirmation required");
        const result = this.inference.retrySummary(string(b.id));
        await this.maintenance.wake();
        return json(result);
      }
      if (request.method === "POST" && path === "/api/model") {
        const b = await body(request);
        const id = string(b.id, 150);
        requireModelBillingApproval(id, b.confirmPaid);
        return await this.exclusive(async () => {
          if (await this.harness.session().busy())
            return json(
              { error: "Stop the active turn before switching models" },
              409,
            );
          if (!this.inference.models().includes(id))
            throw new Error(
              "Model was not advertised by the trusted inference bridge",
            );
          await this.harness
            .session()
            .setModel({ provider: "red-subscription", id });
          await this.ctx.storage.put("bridge:model", id);
          return json({ ok: true, id });
        });
      }
      if (request.method === "POST" && path === "/api/chat") {
        const input = await body(request);
        if (typeof input.id === "string" && input.id.startsWith("discord:"))
          throw new DiscordError("Reserved transport operation ID");
        return await this.admitChat(input);
      }
      if (request.method === "POST" && path === "/api/behavior") {
        const b = await body(request);
        return await this.exclusive(async () =>
          json(
            await facetJson(await this.releases.getFacet(), "/tool", {
              name: string(b.name, 100),
              args: b.args ?? {},
            }),
          ),
        );
      }
      if (request.method === "POST" && path === "/api/codemode") {
        const b = await body(request);
        return json(await this.code.execute({ code: string(b.code, 64000) }));
      }
      if (request.method === "POST" && path === "/api/abort") {
        await this.harness.abort();
        return json({ ok: true });
      }
      if (request.method === "POST" && path === "/api/revisions") {
        const b = await body(request);
        return json(
          await this.releases.propose({
            source: string(b.source, 128000),
            description: string(b.description, 2000),
          }),
        );
      }
      if (request.method === "POST" && path === "/api/test") {
        const b = await body(request);
        return json(await this.releases.validate(string(b.id)));
      }
      if (request.method === "POST" && path === "/api/activate") {
        const b = await body(request);
        if (b.confirm !== "ACTIVATE")
          return json({ error: "Explicit owner confirmation required" }, 400);
        return await this.exclusive(async () => {
          if (await this.harness.session().busy())
            return json(
              { error: "Wait for or abort the active turn before activation" },
              409,
            );
          return json(
            await this.releases.activate({
              revisionId: string(b.id),
              expectedActiveRevisionId:
                b.expectedActiveRevisionId === null
                  ? null
                  : string(b.expectedActiveRevisionId),
              ownerApproved: true,
            }),
          );
        });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : "Request failed" },
        error instanceof DiscordError ? error.status : 400,
      );
    }
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health")
      return json({ ok: true, service: "red-durable" });
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname.startsWith("/api/discord/")) {
        try {
          const binding = discordBinding(env);
          if (!binding)
            return json({ error: "Discord transport is disabled" }, 404);
          if (
            !(await authorized(request, env.DISCORD_RELAY_TOKEN)) ||
            request.headers.get("X-Session") !== binding.session
          )
            return json({ error: "Unauthorized Discord transport" }, 401);
          return env.RED.get(env.RED.idFromName(binding.session)).fetch(
            request,
          );
        } catch {
          return json({ error: "Discord configuration is unavailable" }, 503);
        }
      }
      const bridge = url.pathname.startsWith("/api/bridge/");
      if (bridge && (!env.BRIDGE_TOKEN || env.BRIDGE_TOKEN === env.OWNER_TOKEN))
        return json({ error: "Unauthorized bridge" }, 401);
      if (
        !(await authorized(
          request,
          bridge ? env.BRIDGE_TOKEN : env.OWNER_TOKEN,
        ))
      )
        return json({ error: "Unauthorized" }, 401);
      const session = request.headers.get("X-Session") ?? "default";
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session))
        return json({ error: "Invalid session" }, 400);
      return env.RED.get(env.RED.idFromName(session)).fetch(request);
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(response.body, { status: response.status, headers });
  },
} satisfies ExportedHandler<Env>;
