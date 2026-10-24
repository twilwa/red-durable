import assert from "node:assert/strict";
import test from "node:test";
import {
  createKimiContinuationCache,
  kimiCodePayload,
  kimiCodeProvider,
} from "../bridge/kimi-code.mjs";

// Synthetic private-reasoning fixtures only. No provider request or real secret.
const raw = {
  role: "assistant",
  provider: "kimi-code",
  api: "openai-responses",
  model: "k3.1-pro",
  timestamp: 123,
  content: [
    {
      type: "thinking",
      thinking: "synthetic private reasoning",
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "rs_fixture",
        encrypted_content: "synthetic-opaque-content",
        summary: [],
      }),
    },
    {
      type: "toolCall",
      id: "call_fixture|fc_fixture",
      name: "inspect",
      arguments: { value: 1 },
    },
  ],
};
test("Kimi model has exact identity, local-only key resolution, and mandatory reasoning mapping", async () => {
  const provider = kimiCodeProvider();
  assert.deepEqual(
    provider.getModels().map(({ id }) => id),
    ["k3.1-pro"],
  );
  assert.equal(
    await provider.auth.apiKey.resolve({ credential: undefined }),
    undefined,
  );
  assert.equal(provider.auth.oauth, undefined);
  for (const [requested, expected] of [
    [undefined, "max"],
    ["xhigh", "max"],
    ["low", "low"],
    ["high", "high"],
    ["medium", "high"],
    ["minimal", "low"],
  ]) {
    const body = kimiCodePayload(
      {
        input: [],
        temperature: 0,
        previous_response_id: "x",
        conversation: "x",
        store: true,
      },
      requested,
    );
    assert.deepEqual(body.reasoning, { effort: expected });
    assert.equal(body.model, "k3.1-pro");
    assert.equal(body.store, false);
    assert.equal(body.temperature, undefined);
    assert.equal(body.previous_response_id, undefined);
    assert.equal(body.conversation, undefined);
  }
  assert.throws(
    () => kimiCodePayload({ input: [] }, "off"),
    /requires thinking/,
  );
});
test("Kimi continuations retain private reasoning in RAM only and isolate interleaved sessions", () => {
  const cache = createKimiContinuationCache();
  const visible = cache.remember(raw, "owner-chat");
  assert(!JSON.stringify(visible).includes("synthetic private reasoning"));
  assert(!JSON.stringify(visible).includes("synthetic-opaque-content"));
  const context = {
    messages: [
      {
        ...visible,
        provider: "red-subscription",
        api: "red-subscription",
        model: "kimi-code::k3.1-pro",
      },
    ],
  };
  cache.restore(
    { messages: [{ role: "user", content: "Separate experiment" }] },
    "experiment",
  );
  assert.deepEqual(cache.restore(context, "owner-chat").messages[0], raw);
  assert.throws(() => cache.restore(context, "another-owner"), /unavailable/);
  assert.throws(
    () => createKimiContinuationCache().restore(context, "owner-chat"),
    /unavailable/,
  );
  // Context objects cannot mutate the private cached copy.
  cache.restore(context, "owner-chat").messages[0].content[0].thinking =
    "changed";
  assert.equal(
    cache.restore(context, "owner-chat").messages[0].content[0].thinking,
    raw.content[0].thinking,
  );
  // A fresh turn in this scope forgets the previous turn's private state.
  cache.restore(
    { messages: [{ role: "user", content: "Fresh turn" }] },
    "owner-chat",
  );
  assert.throws(() => cache.restore(context, "owner-chat"), /unavailable/);
});
test("Kimi continuation storage is bounded and clears explicitly", () => {
  const cache = createKimiContinuationCache();
  for (let i = 0; i < 64; i++) cache.remember({ ...raw, timestamp: i });
  assert.throws(() => cache.remember({ ...raw, timestamp: 65 }), /unavailable/);
  cache.clear();
  assert.doesNotThrow(() => cache.remember(raw));
  assert.throws(
    () =>
      cache.remember({
        ...raw,
        content: [{ type: "thinking", thinking: "x".repeat(16 * 1024 * 1024) }],
      }),
    /unavailable/,
  );
});

test("a queued steer can replay a completed Kimi response before Pi resets", () => {
  const cache = createKimiContinuationCache();
  const complete = {
    ...raw,
    stopReason: "stop",
    content: [raw.content[0], { type: "text", text: "First answer" }],
  };
  const visible = cache.remember(complete, "owner-chat");
  const context = {
    messages: [
      visible,
      {
        role: "user",
        content: "Follow-up queued during generation",
        timestamp: 124,
      },
    ],
  };
  assert.deepEqual(cache.restore(context, "owner-chat").messages[0], complete);
});

test("completed experiment scopes are evicted whole instead of exhausting later chat", () => {
  const cache = createKimiContinuationCache();
  for (let i = 0; i < 64; i++) cache.remember(raw, `experiment-${i}`);
  cache.restore({ messages: [raw] }, "experiment-0");
  cache.remember(raw, "new-owner-chat");
  assert.deepEqual(
    cache.restore({ messages: [raw] }, "experiment-0").messages[0],
    raw,
  );
  assert.throws(
    () => cache.restore({ messages: [raw] }, "experiment-1"),
    /unavailable/,
  );
  assert.deepEqual(
    cache.restore({ messages: [raw] }, "new-owner-chat").messages[0],
    raw,
  );
  // Replacing a cached response does not incorrectly consume another slot.
  for (let i = 0; i < 100; i++) cache.remember(raw, "new-owner-chat");
});
