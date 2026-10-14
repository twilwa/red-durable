import test from "node:test";
import assert from "node:assert/strict";
import {
  modelProvider,
  validBridgeModel,
  requireModelBillingApproval,
} from "../shared/providers.ts";
test("qualified models encode only explicit supported provider routing", () => {
  assert.equal(modelProvider("gpt-4.1"), "openai");
  assert.equal(
    modelProvider("openrouter::anthropic/claude-test"),
    "openrouter",
  );
  assert.equal(validBridgeModel("opencode-zen::claude-test"), true);
  for (const value of [
    "",
    null,
    "opencode-go::test",
    "unknown::test",
    "openrouter::",
    "openrouter::a::b",
    " x",
    "https://bad?key=secret",
    "x".repeat(151),
  ])
    assert.equal(validBridgeModel(value), false, String(value));
});
test("metered models require owner billing approval, including background summaries", () => {
  requireModelBillingApproval("gpt-test", undefined);
  for (const id of ["openrouter::vendor/model", "opencode-zen::model"]) {
    assert.throws(
      () => requireModelBillingApproval(id, undefined),
      /memory summaries/,
    );
    assert.throws(() => requireModelBillingApproval(id, "true"));
    requireModelBillingApproval(id, "USE_METERED_PROVIDER");
  }
});
