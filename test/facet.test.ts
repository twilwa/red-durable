import { test } from "node:test";
import assert from "node:assert/strict";
import { facetJson } from "../src/facet.ts";
test("facet response size bounded and valid JSON returned", async () => {
  assert.deepEqual(
    await facetJson(
      { fetch: async () => Response.json({ ok: true }) } as never,
      "/health",
    ),
    { ok: true },
  );
  await assert.rejects(
    () =>
      facetJson(
        { fetch: async () => Response.json({ x: "x".repeat(16000) }) } as never,
        "/health",
      ),
    /16KB/,
  );
});
test("facet status and invalid JSON fail closed", async () => {
  await assert.rejects(
    () =>
      facetJson(
        { fetch: async () => new Response("", { status: 500 }) } as never,
        "/health",
      ),
    /500/,
  );
  await assert.rejects(() =>
    facetJson(
      { fetch: async () => new Response("not json") } as never,
      "/health",
    ),
  );
});
