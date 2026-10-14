export const MAX_BYTES = 512 * 1024;
export function bridgeEndpoint(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "RED_URL must be an origin without a path, credentials, query, or fragment",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error(
      "RED_URL requires HTTPS (HTTP loopback is allowed for development)",
    );
  return url.origin;
}
export async function readBounded(response) {
  if (!response.body) throw new Error("Missing bridge response");
  const reader = response.body.getReader();
  let size = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Bridge response exceeded limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function validateJob(job, now = Date.now()) {
  if (
    !job ||
    typeof job !== "object" ||
    typeof job.id !== "string" ||
    job.id.length > 128 ||
    !job.id ||
    typeof job.leaseToken !== "string" ||
    job.leaseToken.length > 256 ||
    !job.leaseToken ||
    typeof job.modelId !== "string" ||
    job.modelId.length > 150 ||
    !Number.isFinite(job.expiresAt) ||
    job.expiresAt < now + 6000 ||
    job.expiresAt > now + 600000
  )
    throw new Error("Invalid or expired bridge job");
  if (
    !job.context ||
    !Array.isArray(job.context.messages) ||
    job.context.messages.length > 2000
  )
    throw new Error("Invalid bridge context");
  if (JSON.stringify(job).length > MAX_BYTES)
    throw new Error("Bridge job exceeded limit");
  const options = job.options ?? {};
  if (
    Object.keys(options).some((k) => !["reasoning", "maxTokens"].includes(k)) ||
    (options.maxTokens !== undefined &&
      (!Number.isInteger(options.maxTokens) ||
        options.maxTokens < 1 ||
        options.maxTokens > 16000)) ||
    (options.reasoning !== undefined &&
      !["off", "minimal", "low", "medium", "high", "xhigh"].includes(
        options.reasoning,
      ))
  )
    throw new Error("Unsupported bridge options");
  return job;
}
export function classifyError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /subscription_sharing_usage_limit_exceeded|usage limit|quota|rate.?limit|429/i.test(
      message,
    )
  )
    return {
      kind: "quota",
      message:
        "Provider usage or credit limit reached. Review the selected provider before explicitly retrying.",
      retryAfterMs: 300000,
    };
  if (
    /oauth|authentication|sign.?in|refresh|unauthori|credential|401|403|invalid_grant/i.test(
      message,
    )
  )
    return {
      kind: "auth",
      message:
        "Provider credentials need attention. Reconnect on the trusted host.",
    };
  if (/model.*(unavailable|not found|unsupported)|unknown model/i.test(message))
    return {
      kind: "model",
      message: "Requested model is unavailable to this provider connection.",
    };
  return {
    kind: "transient",
    message:
      "Inference failed or was interrupted. No provider fallback was used.",
    retryAfterMs: 60000,
  };
}
export async function exchange(
  origin,
  session,
  token,
  path,
  payload,
  fetcher = fetch,
) {
  if (!["poll", "result"].includes(path))
    throw new Error("Unknown bridge route");
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_BYTES)
    throw new Error("Bridge payload exceeded limit");
  return fetcher(`${origin}/api/bridge/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Session": session,
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
}
// Journal first, infer once, then persist the exact result. A crash mid-inference does not
// silently repeat a potentially charged generation. Expired leases are rejected server-side.
export async function executeJob(job, store, infer) {
  validateJob(job);
  const old = await store.read("journal.json");
  if (old?.jobId === job.id) {
    if (old.result) {
      const result = { ...old.result, leaseToken: job.leaseToken };
      await store.write("journal.json", {
        jobId: job.id,
        state: "completed",
        result,
      });
      return result;
    }
    const result = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      error: {
        kind: "invalid",
        message:
          "Previous inference outcome is unknown after interruption; review and retry explicitly.",
      },
    };
    await store.write("journal.json", {
      jobId: job.id,
      state: "completed",
      result,
    });
    return result;
  }
  await store.write("journal.json", { jobId: job.id, state: "running" });
  let result;
  try {
    const message = await infer(job);
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw new Error(message.errorMessage ?? message.stopReason);
    // Keep only the Pi protocol fields required by the supervisor. Provider
    // metadata, opaque signatures and private reasoning never enter the journal.
    const content = message.content
      .filter((block) => block.type !== "thinking")
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string")
          return { type: "text", text: block.text };
        if (
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string" &&
          block.arguments &&
          typeof block.arguments === "object" &&
          !Array.isArray(block.arguments)
        )
          return {
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          };
        throw new Error("Invalid model content block");
      });
    const usage = message.usage && {
      ...Object.fromEntries(
        [
          "input",
          "output",
          "cacheRead",
          "cacheWrite",
          "totalTokens",
          "reasoning",
          "cacheWrite1h",
        ]
          .filter((k) => message.usage[k] !== undefined)
          .map((k) => [k, message.usage[k]]),
      ),
      cost: Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite", "total"].map((k) => [
          k,
          message.usage.cost?.[k],
        ]),
      ),
    };
    if (
      usage &&
      [
        ...Object.values(usage).filter((v) => typeof v !== "object"),
        ...Object.values(usage.cost),
      ].some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
    )
      throw new Error("Invalid model usage");
    const safeMessage = {
      role: "assistant",
      content,
      provider: "red-subscription",
      api: "red-subscription",
      model: job.modelId,
      stopReason: message.stopReason,
      timestamp: Number.isSafeInteger(message.timestamp)
        ? message.timestamp
        : Date.now(),
      ...(usage ? { usage } : {}),
    };
    result = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      message: safeMessage,
    };
  } catch (e) {
    result = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      error: classifyError(e),
    };
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 250000)
    result = {
      jobId: job.id,
      leaseToken: job.leaseToken,
      error: {
        kind: "invalid",
        message: "Model result exceeded bridge size limit.",
      },
    };
  await store.write("journal.json", {
    jobId: job.id,
    state: "completed",
    result,
  });
  return result;
}
