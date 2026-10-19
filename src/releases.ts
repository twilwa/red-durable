/**
 * The supervisor owns this manager. Never expose activate()/rollback() to the LLM.
 * A matching, authenticated owner request is required before setting ownerApproved.
 * Facet promotion preserves its database; it does NOT reverse data migrations.
 */
export const FACET_NAME = "agent";
export const CONTRACT_VERSION = 1;
export const MAX_SOURCE_BYTES = 128 * 1024;
const PREFIX = "release:revision:";
const ACTIVE = "release:active";
const HISTORY = "release:history";
const COMPATIBILITY_DATE = "2026-10-09";

export interface Revision {
  id: string;
  source: string;
  description: string;
  createdAt: string;
}
export interface Validation {
  revisionId: string;
  checkedAt: string;
  contractVersion: 1;
}
export interface ReleaseState {
  revisionId: string;
  previousRevisionId: string | null;
  activatedAt: string;
}
export interface ActivationRequest {
  revisionId: string;
  expectedActiveRevisionId: string | null;
  ownerApproved: boolean;
}
export interface ReleaseStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export interface ReleaseStorage extends ReleaseStore {
  transaction<T>(closure: (storage: ReleaseStore) => Promise<T>): Promise<T>;
}
export interface ReleaseManagerOptions {
  storage: ReleaseStorage;
  loader: WorkerLoader;
  facets: DurableObjectFacets;
  /** Only individually reviewed capabilities, never the supervisor's env object. */
  bindings?: Record<string, unknown>;
}

export function validateRevisionInput(input: {
  source: string;
  description?: string;
}): void {
  if (typeof input.source !== "string" || !input.source.trim())
    throw new Error("Source is required");
  if (new TextEncoder().encode(input.source).length > MAX_SOURCE_BYTES)
    throw new Error("Source exceeds 128 KiB");
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 2000)
  ) {
    throw new Error("Description must be at most 2000 characters");
  }
  // This is an input check, not a sandbox or a JavaScript parser. workerd validates
  // syntax/exports during candidate startup; capabilities enforce the boundary.
}

export async function revisionId(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      source,
      compatibilityDate: COMPATIBILITY_DATE,
      contractVersion: CONTRACT_VERSION,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export class ReleaseManager {
  private readonly options: ReleaseManagerOptions;
  private transition: Promise<unknown> = Promise.resolve();
  constructor(options: ReleaseManagerOptions) {
    this.options = options;
  }

  async propose(input: {
    source: string;
    description?: string;
  }): Promise<Revision> {
    validateRevisionInput(input);
    const id = await revisionId(input.source);
    return this.options.storage.transaction(async (storage) => {
      const existing = await storage.get<Revision>(PREFIX + id);
      if (existing) return existing;
      const revision: Revision = {
        id,
        source: input.source,
        description: input.description ?? "",
        createdAt: new Date().toISOString(),
      };
      await storage.put(PREFIX + id, revision);
      return revision;
    });
  }

  async get(id: string): Promise<Revision> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid revision ID");
    const revision = await this.options.storage.get<Revision>(PREFIX + id);
    if (!revision) throw new Error("Unknown revision");
    return revision;
  }

  async list(): Promise<Revision[]> {
    return [
      ...(
        await this.options.storage.list<Revision>({ prefix: PREFIX })
      ).values(),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async active(): Promise<ReleaseState | null> {
    return (await this.options.storage.get<ReleaseState>(ACTIVE)) ?? null;
  }

  async history(): Promise<ReleaseState[]> {
    return (await this.options.storage.get<ReleaseState[]>(HISTORY)) ?? [];
  }

  private dynamicClass(revision: Revision, mode: "candidate" | "active") {
    // Mode is part of the cache identity because capabilities differ. Source and
    // fixed runtime settings are immutable for an ID; change this prefix whenever
    // the capability contract or runtime settings change in a supervisor release.
    const worker = this.options.loader.get(
      `behavior-v1:${mode}:${revision.id}`,
      async () => ({
        compatibilityDate: COMPATIBILITY_DATE,
        mainModule: "agent.js",
        modules: { "agent.js": revision.source },
        globalOutbound: null,
        limits: { cpuMs: 1000, subRequests: 10 },
        env: mode === "candidate" ? {} : { ...(this.options.bindings ?? {}) },
      }),
    );
    return worker.getDurableObjectClass("MutableAgent");
  }

  async validate(id: string, signal?: AbortSignal): Promise<Validation> {
    signal?.throwIfAborted();
    const revision = await this.get(id);
    signal?.throwIfAborted();
    // Unique test database: cannot modify production state or reuse a warm test.
    const name = `candidate:${id}:${crypto.randomUUID()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const facet = this.options.facets.get(name, () => ({
        class: this.dynamicClass(revision, "candidate"),
      }));
      await Promise.race([
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error("Candidate validation stopped"));
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
        }),
        (async () => {
          const response = await facet.fetch(
            new Request("https://facet.internal/health"),
          );
          if (!response.ok)
            throw new Error(
              `Candidate health check returned ${response.status}`,
            );
          if (!response.body)
            throw new Error("Empty candidate health response");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 4096)
                throw new Error("Candidate health response too large");
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const health = JSON.parse(new TextDecoder().decode(bytes)) as {
            ok?: boolean;
            contractVersion?: number;
          };
          if (health.ok !== true || health.contractVersion !== CONTRACT_VERSION)
            throw new Error(
              "Candidate does not implement behavior contract v1",
            );
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Candidate health check timed out")),
            5000,
          );
        }),
      ]);
      const validation: Validation = {
        revisionId: id,
        checkedAt: new Date().toISOString(),
        contractVersion: 1,
      };
      await this.options.storage.put(`release:validated:${id}`, validation);
      return validation;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      // Only the disposable candidate's database is deleted. Never FACET_NAME.
      this.options.facets.delete(name);
    }
  }

  async activate(request: ActivationRequest): Promise<ReleaseState> {
    if (request.ownerApproved !== true)
      throw new Error("Explicit authenticated owner approval required");
    // Serialize promotions in this DO instance. Storage transaction additionally
    // makes compare-and-swap + audit history atomic across object restarts.
    const task = this.transition.then(async () => {
      await this.get(request.revisionId);
      const validation = await this.options.storage.get<Validation>(
        `release:validated:${request.revisionId}`,
      );
      if (!validation)
        throw new Error("Validate the candidate before activation");
      const state = await this.options.storage.transaction(async (storage) => {
        const active = await storage.get<ReleaseState>(ACTIVE);
        if ((active?.revisionId ?? null) !== request.expectedActiveRevisionId)
          throw new Error("Active revision changed; review and approve again");
        if (active?.revisionId === request.revisionId) return active;
        const next: ReleaseState = {
          revisionId: request.revisionId,
          previousRevisionId: active?.revisionId ?? null,
          activatedAt: new Date().toISOString(),
        };
        const history = (await storage.get<ReleaseState[]>(HISTORY)) ?? [];
        await storage.put(ACTIVE, next);
        await storage.put(HISTORY, [...history, next].slice(-100));
        return next;
      });
      // Commit first. If the object is interrupted now, its facet dies with it and
      // the next startup reads the committed revision. Existing stubs are invalid.
      this.options.facets.abort(
        FACET_NAME,
        new Error("Behavior revision changed"),
      );
      return state;
    });
    this.transition = task.catch(() => undefined);
    return task;
  }

  async rollback(request: ActivationRequest): Promise<ReleaseState> {
    // Deliberately the same approval and compare-and-swap path. Code rollback is
    // not a database rollback; only backward-compatible schemas are safe.
    const history = await this.history();
    if (!history.some((item) => item.revisionId === request.revisionId))
      throw new Error("Rollback target was never active");
    return this.activate(request);
  }

  async getFacet(): Promise<Fetcher> {
    await this.transition;
    return this.options.facets.get(FACET_NAME, async () => {
      const active = await this.active();
      if (!active) throw new Error("No active behavior revision");
      return {
        class: this.dynamicClass(await this.get(active.revisionId), "active"),
      };
    });
  }
}

export const DEFAULT_BEHAVIOR_SOURCE = `import { DurableObject } from 'cloudflare:workers';
export class MutableAgent extends DurableObject {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ ok: true, contractVersion: 1 });
    if (path === '/behavior') return Response.json({
      systemPromptSuffix: 'You can use the persistent counter tools supplied by your current behavior revision.',
      tools: [
        { name: 'counter_get', description: 'Read the persistent behavior counter', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'counter_increment', description: 'Increment the persistent behavior counter', parameters: { type: 'object', properties: { amount: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } }
      ]
    });
    if (path === '/tool' && request.method === 'POST') {
      const { name, args = {} } = await request.json();
      if (name === 'counter_get') return Response.json({ value: await this.ctx.storage.get('counter') ?? 0 });
      if (name === 'counter_increment') {
        const amount = args.amount ?? 1;
        if (!Number.isInteger(amount) || amount < 1 || amount > 100) return new Response('Invalid increment', { status: 400 });
        const value = await this.ctx.storage.transaction(async (tx) => {
          const next = (await tx.get('counter') ?? 0) + amount;
          await tx.put('counter', next);
          return next;
        });
        return Response.json({ value });
      }
      return new Response('Unknown tool', { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  }
}`;
