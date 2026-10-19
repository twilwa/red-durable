import { describe, expect, it } from "vitest";
import {
  DEFAULT_BEHAVIOR_SOURCE,
  FACET_NAME,
  MAX_SOURCE_BYTES,
  ReleaseManager,
  revisionId,
  validateRevisionInput,
} from "../src/releases";
import type { ReleaseStorage, ReleaseStore } from "../src/releases";

class MemoryStorage implements ReleaseStorage {
  data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.data.entries()].filter(([key]) => key.startsWith(prefix)),
    ) as Map<string, T>;
  }
  async transaction<T>(
    callback: (storage: ReleaseStore) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

function fixture() {
  const storage = new MemoryStorage();
  const loaded: Array<{ id: string; code: WorkerLoaderWorkerCode }> = [];
  const deletes: string[] = [];
  const aborts: string[] = [];
  let health = { ok: true, contractVersion: 1 };
  const instances = new Map<string, unknown>();
  const loader = {
    get(id: string, getCode: () => Promise<WorkerLoaderWorkerCode>) {
      return {
        getDurableObjectClass(exportName: string) {
          return { id, getCode, exportName };
        },
      };
    },
  } as unknown as WorkerLoader;
  const facets = {
    get(
      name: string,
      startup: () => Promise<{ class: unknown }> | { class: unknown },
    ) {
      return {
        async fetch() {
          if (!instances.has(name)) {
            const options = await startup();
            const cls = options.class as {
              id: string;
              getCode: () => Promise<WorkerLoaderWorkerCode>;
              exportName: string;
            };
            expect(cls.exportName).toBe("MutableAgent");
            loaded.push({ id: cls.id, code: await cls.getCode() });
            instances.set(name, cls);
          }
          return Response.json(health);
        },
      };
    },
    abort(name: string) {
      aborts.push(name);
      instances.delete(name);
    },
    delete(name: string) {
      deletes.push(name);
      instances.delete(name);
    },
  } as unknown as DurableObjectFacets;
  const manager = new ReleaseManager({
    storage,
    loader,
    facets,
    bindings: { HOST: "narrow-capability" },
  });
  return {
    manager,
    storage,
    loaded,
    deletes,
    aborts,
    setHealth: (value: typeof health) => {
      health = value;
    },
  };
}

async function checked(manager: ReleaseManager, suffix = "") {
  const revision = await manager.propose({
    source: DEFAULT_BEHAVIOR_SOURCE + suffix,
    description: "test",
  });
  await manager.validate(revision.id);
  return revision;
}

describe("immutable revisions", () => {
  it("hashes runtime identity and exact source deterministically", async () => {
    const a = await revisionId("one");
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(await revisionId("one")).toBe(a);
    expect(await revisionId("two")).not.toBe(a);
  });
  it("rejects empty, oversized and invalid descriptions", () => {
    expect(() => validateRevisionInput({ source: "" })).toThrow("required");
    expect(() =>
      validateRevisionInput({ source: "é".repeat(MAX_SOURCE_BYTES) }),
    ).toThrow("128 KiB");
    expect(() =>
      validateRevisionInput({ source: "x", description: "x".repeat(2001) }),
    ).toThrow("2000");
  });
  it("retains the original immutable revision including description", async () => {
    const { manager } = fixture();
    const first = await manager.propose({
      source: "source",
      description: "original",
    });
    const second = await manager.propose({
      source: "source",
      description: "replacement",
    });
    expect(second).toEqual(first);
    expect(await manager.list()).toHaveLength(1);
    await expect(manager.get("bad")).rejects.toThrow("Invalid revision");
    await expect(manager.get("0".repeat(64))).rejects.toThrow(
      "Unknown revision",
    );
  });
});

describe("isolated candidate validation", () => {
  it("loads with no network or capabilities and deletes only disposable storage", async () => {
    const f = fixture();
    const rev = await checked(f.manager);
    expect(f.loaded[0].id).toContain(`candidate:${rev.id}`);
    expect(f.loaded[0].code.globalOutbound).toBeNull();
    expect(f.loaded[0].code.env).toEqual({});
    expect(f.loaded[0].code.limits).toEqual({ cpuMs: 1000, subRequests: 10 });
    expect(f.deletes).toHaveLength(1);
    expect(f.deletes[0]).toMatch(/^candidate:/);
    expect(f.deletes).not.toContain(FACET_NAME);
    expect(await f.manager.active()).toBeNull();
  });
  it("does not mark failed contracts validated and cleans up", async () => {
    const f = fixture();
    f.setHealth({ ok: true, contractVersion: 2 });
    const rev = await f.manager.propose({ source: "bad contract" });
    await expect(f.manager.validate(rev.id)).rejects.toThrow("contract v1");
    await expect(
      f.manager.activate({
        revisionId: rev.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
    ).rejects.toThrow("Validate");
    expect(f.deletes).toHaveLength(1);
  });
});

describe("owner-approved promotion and rollback", () => {
  it("requires approval and validation", async () => {
    const f = fixture();
    const rev = await f.manager.propose({ source: DEFAULT_BEHAVIOR_SOURCE });
    await expect(
      f.manager.activate({
        revisionId: rev.id,
        expectedActiveRevisionId: null,
        ownerApproved: false,
      }),
    ).rejects.toThrow("owner approval");
    await expect(
      f.manager.activate({
        revisionId: rev.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
    ).rejects.toThrow("Validate");
    expect(f.aborts).toEqual([]);
  });
  it("preserves stable facet storage on update and rollback with a revision audit trail", async () => {
    const f = fixture();
    const one = await checked(f.manager);
    const two = await checked(f.manager, "\n// next");
    await f.manager.activate({
      revisionId: one.id,
      expectedActiveRevisionId: null,
      ownerApproved: true,
    });
    await (await f.manager.getFacet()).fetch("https://facet.internal/behavior");
    await f.manager.activate({
      revisionId: two.id,
      expectedActiveRevisionId: one.id,
      ownerApproved: true,
    });
    await (await f.manager.getFacet()).fetch("https://facet.internal/behavior");
    await f.manager.rollback({
      revisionId: one.id,
      expectedActiveRevisionId: two.id,
      ownerApproved: true,
    });
    await (await f.manager.getFacet()).fetch("https://facet.internal/behavior");
    expect((await f.manager.active())?.revisionId).toBe(one.id);
    expect((await f.manager.history()).map((r) => r.revisionId)).toEqual([
      one.id,
      two.id,
      one.id,
    ]);
    expect(f.aborts).toEqual([FACET_NAME, FACET_NAME, FACET_NAME]);
    expect(f.deletes).not.toContain(FACET_NAME);
    const activeLoads = f.loaded.filter(({ id }) => id.includes(":active:"));
    expect(activeLoads).toHaveLength(3);
    expect(activeLoads[0].code.env).toEqual({ HOST: "narrow-capability" });
    expect(activeLoads.every(({ code }) => code.globalOutbound === null)).toBe(
      true,
    );
  });
  it("rejects stale approval and rollback to a never-active revision", async () => {
    const f = fixture();
    const one = await checked(f.manager);
    const two = await checked(f.manager, "\n// two");
    await f.manager.activate({
      revisionId: one.id,
      expectedActiveRevisionId: null,
      ownerApproved: true,
    });
    await expect(
      f.manager.activate({
        revisionId: two.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
    ).rejects.toThrow("changed");
    await expect(
      f.manager.rollback({
        revisionId: two.id,
        expectedActiveRevisionId: one.id,
        ownerApproved: true,
      }),
    ).rejects.toThrow("never active");
    expect((await f.manager.active())?.revisionId).toBe(one.id);
  });
  it("serializes two approvals based on the same old revision", async () => {
    const f = fixture();
    const one = await checked(f.manager);
    const two = await checked(f.manager, "\n// two");
    const results = await Promise.allSettled([
      f.manager.activate({
        revisionId: one.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
      f.manager.activate({
        revisionId: two.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(await f.manager.history()).toHaveLength(1);
  });
});

it("stop while revision lookup is pending never starts a candidate", async () => {
  const f = fixture();
  const revision = await f.manager.propose({ source: DEFAULT_BEHAVIOR_SOURCE });
  const original = f.storage.get.bind(f.storage);
  let resume!: () => void;
  f.storage.get = async <T>(key: string): Promise<T | undefined> => {
    if (key === "release:revision:" + revision.id)
      await new Promise<void>((r) => (resume = r));
    return original<T>(key);
  };
  const controller = new AbortController();
  const result = f.manager.validate(revision.id, controller.signal);
  controller.abort();
  resume();
  await expect(result).rejects.toThrow();
  expect(f.loaded).toHaveLength(0);
  expect(f.deletes).toHaveLength(0);
  expect(await original("release:validated:" + revision.id)).toBeUndefined();
});

it("in-flight stop disposes the candidate and never records validation", async () => {
  const storage = new MemoryStorage();
  const names: string[] = [];
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const manager = new ReleaseManager({
    storage,
    loader: {} as WorkerLoader,
    facets: {
      get(name: string) {
        return {
          fetch: () => {
            names.push(name);
            entered();
            return new Promise<Response>(() => {});
          },
        };
      },
      delete(name: string) {
        names.push("deleted:" + name);
      },
    } as unknown as DurableObjectFacets,
  });
  const revision = await manager.propose({ source: DEFAULT_BEHAVIOR_SOURCE });
  const controller = new AbortController();
  const pending = manager.validate(revision.id, controller.signal);
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow("stopped");
  expect(names).toHaveLength(2);
  expect(names[1]).toBe("deleted:" + names[0]);
  expect(await storage.get("release:validated:" + revision.id)).toBeUndefined();
});

describe("experiment capability fences", () => {
  it("does not grant promotion eligibility for evidence-only validation", async () => {
    const f = fixture();
    const revision = await f.manager.propose({
      source: DEFAULT_BEHAVIOR_SOURCE,
    });
    const result = await f.manager.validate(revision.id, undefined, {
      evidenceOnly: true,
    });
    expect(result.revisionId).toBe(revision.id);
    expect(f.deletes).toHaveLength(1);
    expect(
      await f.storage.get("release:validated:" + revision.id),
    ).toBeUndefined();
    await expect(
      f.manager.activate({
        revisionId: revision.id,
        expectedActiveRevisionId: null,
        ownerApproved: true,
      }),
    ).rejects.toThrow("Validate");
    // An explicit normal validation retains the existing owner workflow.
    await f.manager.validate(revision.id);
    expect(
      await f.storage.get("release:validated:" + revision.id),
    ).toBeDefined();
  });

  it("checks revocation after hashing and before staging", async () => {
    const f = fixture();
    let allowed = true;
    const pending = f.manager.propose(
      { source: DEFAULT_BEHAVIOR_SOURCE },
      () => {
        if (!allowed) throw new Error("revoked");
      },
    );
    allowed = false;
    await expect(pending).rejects.toThrow("revoked");
    expect(await f.manager.list()).toEqual([]);
  });

  it("checks revocation inside the proposal transaction after lookup", async () => {
    const f = fixture();
    const original = f.storage.get.bind(f.storage);
    let allowed = true;
    f.storage.get = async <T>(key: string): Promise<T | undefined> => {
      const result = await original<T>(key);
      allowed = false;
      return result;
    };
    await expect(
      f.manager.propose({ source: DEFAULT_BEHAVIOR_SOURCE }, () => {
        if (!allowed) throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(await f.manager.list()).toEqual([]);
  });

  it("fences validation completion before recording eligibility", async () => {
    const f = fixture();
    const revision = await f.manager.propose({
      source: DEFAULT_BEHAVIOR_SOURCE,
    });
    await expect(
      f.manager.validate(revision.id, undefined, {
        guard: () => {
          if (f.loaded.length) throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.loaded).toHaveLength(1);
    expect(f.deletes).toHaveLength(1);
    expect(
      await f.storage.get("release:validated:" + revision.id),
    ).toBeUndefined();
  });

  it("checks guard again after revision lookup before starting a candidate", async () => {
    const f = fixture();
    const revision = await f.manager.propose({
      source: DEFAULT_BEHAVIOR_SOURCE,
    });
    const original = f.storage.get.bind(f.storage);
    let allowed = true;
    f.storage.get = async <T>(key: string): Promise<T | undefined> => {
      const result = await original<T>(key);
      allowed = false;
      return result;
    };
    await expect(
      f.manager.validate(revision.id, undefined, {
        guard: () => {
          if (!allowed) throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.loaded).toHaveLength(0);
    expect(f.deletes).toHaveLength(0);
  });
});
