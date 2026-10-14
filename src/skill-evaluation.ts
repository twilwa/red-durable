/** Offline evaluator preparation. This is not wired to a model tool or credentials.
 * The host must independently curate labels and keep held-out runs out of proposal context. */
export interface RecordedAction {
  type: string;
  target: string;
  value?: string;
}
export interface HeldOutStep {
  observation: string;
  action: RecordedAction;
  scoreable: boolean;
}
export interface HeldOutTrajectory {
  runId: string;
  inferredGoal: string;
  steps: HeldOutStep[];
}
export interface PredictionInput {
  library: string;
  goal: string;
  observation: string;
  history: RecordedAction[];
}
export type ActionPredictor = (
  input: PredictionInput,
) => Promise<RecordedAction>;
export interface HeldOutDataset {
  id: string;
  source: string;
  trajectories: HeldOutTrajectory[];
  labelProvenance: "host-curated-recorded-actions";
}
function equivalent(a: RecordedAction, b: RecordedAction) {
  return (
    a.type === b.type &&
    a.target === b.target &&
    (a.value ?? "") === (b.value ?? "")
  );
}
/** Exact action matching is intentionally conservative. It is not TeleTune's fuzzy
 * target/value equivalence matcher and this helper does not independently attest labels. */
export async function evaluateHeldOut(input: {
  dataset: HeldOutDataset;
  proposalRunIds: string[];
  baseline: string;
  candidate: string;
  predict: ActionPredictor;
  signal?: AbortSignal;
}) {
  const dataset = structuredClone(input.dataset);
  if (
    !dataset.id ||
    dataset.labelProvenance !== "host-curated-recorded-actions" ||
    !dataset.trajectories.length ||
    dataset.trajectories.length > 100
  )
    throw new Error("Invalid held-out dataset");
  const seen = new Set<string>();
  let scored = 0;
  let total = 0;
  for (const trajectory of dataset.trajectories) {
    if (
      !trajectory.runId ||
      seen.has(trajectory.runId) ||
      input.proposalRunIds.includes(trajectory.runId)
    )
      throw new Error("Training and held-out runs must be unique and disjoint");
    seen.add(trajectory.runId);
    scored += trajectory.steps.filter((s) => s.scoreable).length;
    total += trajectory.steps.length;
    if (!trajectory.steps.some((s) => s.scoreable))
      throw new Error("Each held-out trajectory needs scoreable actions");
  }
  if (scored === 0 || total > 1000)
    throw new Error("Dataset must have 1–1000 bounded action steps");
  const score = async (library: string) => {
    const perTrajectory: number[] = [];
    for (const trajectory of dataset.trajectories) {
      const history: RecordedAction[] = [];
      let correct = 0;
      let n = 0;
      for (const step of trajectory.steps) {
        input.signal?.throwIfAborted();
        if (step.scoreable) {
          const prediction = await input.predict({
            library,
            goal: trajectory.inferredGoal,
            observation: step.observation,
            history: structuredClone(history),
          });
          if (equivalent(prediction, step.action)) correct++;
          n++;
        }
        // Always use the recorded action next, never allow a wrong prediction to derail later history.
        history.push(structuredClone(step.action));
      }
      perTrajectory.push(correct / n);
    }
    return perTrajectory.reduce((a, b) => a + b, 0) / perTrajectory.length;
  };
  const baseline = await score(input.baseline);
  const candidate = await score(input.candidate);
  return {
    kind: "held-out-next-action-prediction" as const,
    evaluatorVersion: "exact-action-v1",
    datasetId: dataset.id,
    datasetSource: dataset.source,
    labelProvenance: dataset.labelProvenance,
    labelsIndependentlyVerified: false,
    evaluatedAt: new Date().toISOString(),
    trajectoryCount: dataset.trajectories.length,
    scoreableActions: scored,
    baseline,
    candidate,
    improved: candidate > baseline,
    warning:
      "Host-provided labels and predictor. Exact-match offline proxy; no live task success or production activation established.",
  };
}
