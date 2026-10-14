import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type Provider,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { BridgeQueue } from "./bridge-queue.ts";
const providerId = "red-subscription",
  api = "red-subscription";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost,
};
export function subscriptionProvider(
  queue: BridgeQueue,
  modelIds: () => string[],
): Provider {
  const models = (): Model<string>[] =>
    modelIds().map((id) => ({
      id,
      name: id,
      provider: providerId,
      api,
      baseUrl: "",
      input: ["text"],
      cost,
      contextWindow: 128000,
      maxTokens: 16000,
      reasoning: true,
    }));
  const message = (model: Model<string>, id: string): AssistantMessage => {
    const state = queue.read(id);
    if (state.message)
      return { ...state.message, provider: providerId, api, model: model.id };
    if (state.error || state.state === "cancelled")
      return {
        role: "assistant",
        content: [],
        provider: providerId,
        api,
        model: model.id,
        usage,
        stopReason: state.state === "cancelled" ? "aborted" : "error",
        errorMessage: state.error
          ? `${state.error.kind}: ${state.error.message}`
          : "Inference cancelled",
        timestamp: Date.now(),
      };
    return {
      role: "assistant",
      content: [],
      provider: providerId,
      api,
      model: model.id,
      usage,
      stopReason: "deferred",
      deferred: {
        provider: providerId,
        api,
        modelId: model.id,
        id,
        pollAfterMs: 5000,
      },
      timestamp: Date.now(),
    };
  };
  const emit = (model: Model<string>, run: () => Promise<AssistantMessage>) => {
    const stream = createAssistantMessageEventStream();
    void run()
      .then((result) => {
        stream.push({ type: "start", partial: result });
        if (result.stopReason === "error" || result.stopReason === "aborted")
          stream.push({
            type: "error",
            reason: result.stopReason,
            error: result,
          });
        else if (result.stopReason !== "pending")
          stream.push({
            type: "done",
            reason: result.stopReason,
            message: result,
          });
        else throw new Error("Unexpected pending bridge result");
        stream.end(result);
      })
      .catch((error) => {
        const result: AssistantMessage = {
          role: "assistant",
          content: [],
          provider: providerId,
          api,
          model: model.id,
          usage,
          stopReason: "error",
          errorMessage:
            error instanceof Error ? error.message : "Bridge failed",
          timestamp: Date.now(),
        };
        stream.push({ type: "error", reason: "error", error: result });
        stream.end(result);
      });
    return stream;
  };
  const start = (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ) =>
    emit(model, async () =>
      message(
        model,
        await queue.enqueue(
          model.id,
          context,
          {
            ...(options?.reasoning ? { reasoning: options.reasoning } : {}),
            ...(options?.maxTokens
              ? {
                  maxTokens: Math.min(
                    16000,
                    Math.max(1, Math.floor(options.maxTokens)),
                  ),
                }
              : {}),
          },
          options?.sessionId?.startsWith("red-memory:")
            ? options.sessionId
            : undefined,
        ),
      ),
    );
  return {
    id: providerId,
    name: "Trusted provider bridge",
    auth: {
      apiKey: {
        name: "Local bridge capability",
        resolve: async () => ({
          auth: {},
          source: "Trusted bridge; credentials remain on its host",
        }),
      },
    },
    getModels: models,
    stream: (model, context) => start(model, context),
    streamSimple: start,
    fetchDeferred: (model, handle) =>
      emit(model, async () => message(model, handle.id)),
    cancelDeferred: async (_model, handle) => {
      queue.cancel(handle.id);
    },
  };
}
