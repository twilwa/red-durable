/** Public model identifiers carry routing intent, never credentials/endpoints. */
export function modelProvider(
  id: string,
): "openai" | "openrouter" | "opencode-zen" {
  if (id.startsWith("openrouter::")) return "openrouter";
  if (id.startsWith("opencode-zen::")) return "opencode-zen";
  return "openai";
}
export function isMeteredModel(id: string): boolean {
  return modelProvider(id) !== "openai";
}
export function validBridgeModel(id: unknown): id is string {
  if (
    typeof id !== "string" ||
    id.length > 150 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:@+/-]*$/.test(id)
  )
    return false;
  if (!id.includes("::")) return true;
  const [provider, model, extra] = id.split("::");
  return (
    ["openrouter", "opencode-zen"].includes(provider) &&
    Boolean(model) &&
    extra === undefined &&
    /^[A-Za-z0-9][A-Za-z0-9_.:@+/-]*$/.test(model)
  );
}
export function requireModelBillingApproval(
  id: string,
  confirmation: unknown,
): void {
  if (!validBridgeModel(id)) throw new Error("Invalid provider model");
  if (isMeteredModel(id) && confirmation !== "USE_METERED_PROVIDER")
    throw new Error(
      "Explicit approval is required: this model uses metered credits for conversation and memory summaries",
    );
}
