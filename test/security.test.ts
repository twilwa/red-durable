import { test } from "node:test";
import assert from "node:assert/strict";
import { authorized, body } from "../src/security.ts";
const token = "test-only-owner-token-that-is-long-enough";
test("auth fails closed and checks exact bearer", async () => {
  assert.equal(
    await authorized(new Request("https://red.test/api/state")),
    false,
  );
  assert.equal(
    await authorized(new Request("https://red.test/api/state"), token),
    false,
  );
  assert.equal(
    await authorized(
      new Request("https://red.test/api/state", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      token,
    ),
    true,
  );
});
test("cross-origin denied even with matching token", async () => {
  assert.equal(
    await authorized(
      new Request("https://red.test/api/state", {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://evil.test",
        },
      }),
      token,
    ),
    false,
  );
});
test("JSON body bounded and must be object", async () => {
  await assert.rejects(() =>
    body(new Request("https://red.test", { method: "POST", body: "[]" })),
  );
  await assert.rejects(() =>
    body(
      new Request("https://red.test", {
        method: "POST",
        body: JSON.stringify({ x: "x".repeat(260000) }),
      }),
    ),
  );
});
