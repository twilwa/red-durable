import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateHeldOut,
  type HeldOutDataset,
} from "../src/skill-evaluation.ts";
const dataset = (): HeldOutDataset => ({
  id: "fixture-v1",
  source: "local:test-fixture",
  labelProvenance: "host-curated-recorded-actions",
  trajectories: [
    {
      runId: "held-out-1",
      inferredGoal: "Find a record",
      steps: [
        {
          observation: "list",
          action: { type: "click", target: "Filter" },
          scoreable: true,
        },
        {
          observation: "filter",
          action: { type: "click", target: "Run" },
          scoreable: true,
        },
      ],
    },
  ],
});
test("offline helper teacher-forces recorded actions and compares same held-out data", async () => {
  const calls: any[] = [];
  const result = await evaluateHeldOut({
    dataset: dataset(),
    proposalRunIds: ["train-1"],
    baseline: "old",
    candidate: "new",
    predict: async (input) => {
      calls.push(input);
      return input.library === "new"
        ? { type: "click", target: input.history.length ? "Run" : "Filter" }
        : { type: "click", target: "Wrong" };
    },
  });
  assert.equal(result.baseline, 0);
  assert.equal(result.candidate, 1);
  assert.equal(result.improved, true);
  assert.deepEqual(calls[1].history, [{ type: "click", target: "Filter" }]);
  assert.equal(result.labelsIndependentlyVerified, false);
  assert.ok(!("action" in calls[0]));
});
test("offline helper rejects contamination and empty labels before any inference", async () => {
  let calls = 0;
  const predict = async () => {
    calls++;
    return { type: "click", target: "x" };
  };
  await assert.rejects(
    evaluateHeldOut({
      dataset: dataset(),
      proposalRunIds: ["held-out-1"],
      baseline: "a",
      candidate: "b",
      predict,
    }),
    /disjoint/,
  );
  const d = dataset();
  d.trajectories[0].steps.forEach((s) => (s.scoreable = false));
  await assert.rejects(
    evaluateHeldOut({
      dataset: d,
      proposalRunIds: [],
      baseline: "a",
      candidate: "b",
      predict,
    }),
    /scoreable/,
  );
  assert.equal(calls, 0);
});
