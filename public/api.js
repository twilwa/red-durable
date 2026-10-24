// @ts-check
/**
 * Same-origin owner transport for red. Credentials remain in this object's
 * memory only. No upstream DPI hub, SDK, SSE endpoint or credential storage.
 */
class RedApiError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
class RedClient {
  #token = "";
  #session = "default";
  #generation = 0;
  /** @type {Set<AbortController>} */
  #requests = new Set();
  get generation() {
    return this.#generation;
  }
  /** @param {string} token @param {string} session */
  connect(token, session) {
    this.clear();
    this.#token = token;
    this.#session = session;
  }
  clear() {
    this.#generation++;
    this.#token = "";
    this.#session = "default";
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
  }
  /** @template T @param {string} path @param {object} [data] @returns {Promise<T>} */
  async request(path, data) {
    const generation = this.#generation;
    const controller = new AbortController();
    this.#requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch("/api/" + path, {
        method: data === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + this.#token,
          "X-Session": this.#session,
          ...(data === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: controller.signal,
        cache: "no-store",
      });
      let value;
      try {
        value = await response.json();
      } catch {
        throw new RedApiError(
          "The server returned an unreadable response. Try again.",
          response.status,
        );
      }
      if (generation !== this.#generation) throw Error("Session changed");
      if (!response.ok)
        throw new RedApiError(value.error || "Request failed", response.status);
      return /** @type {T} */ (value);
    } catch (error) {
      if (generation !== this.#generation) throw Error("Session changed");
      if (error instanceof Error && error.name === "AbortError")
        throw Error(
          "The request timed out. Your draft is still here; check connection and retry.",
        );
      throw error;
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(controller);
    }
  }
  /** @returns {Promise<import('../ui/contracts').State>} */
  state() {
    return this.request("state");
  }
  /** @returns {Promise<import('../ui/contracts').Companion>} */
  companion() {
    return this.request("companion");
  }
  /** @param {number} id @param {number} [offset] @returns {Promise<import('../ui/contracts').SourceEventPage>} */
  sourceEvent(id, offset = 0) {
    return this.request("companion/event?id=" + id + "&offset=" + offset);
  }
  /** @returns {Promise<{skills: import('../ui/contracts').Skill[], telemetry: unknown}>} */
  skills() {
    return this.request("skills");
  }
  /** @param {string} id @returns {Promise<import('../ui/contracts').FullSkill>} */
  skill(id) {
    return this.request("skill?id=" + encodeURIComponent(id));
  }
  /** @param {string} id @returns {Promise<import('../ui/contracts').Revision & {source: string}>} */
  revision(id) {
    return this.request("revision?id=" + encodeURIComponent(id));
  }
  /** @returns {Promise<{source: string}>} */
  source() {
    return this.request("source");
  }
  /** @returns {Promise<{view: string, stats: unknown}>} */
  memory() {
    return this.request("memory");
  }
  /** @param {string} text @param {string} id */
  chat(text, id) {
    return this.request("chat", { text, id });
  }
  abort() {
    return this.request("abort", {});
  }
  /** @param {string} id @param {{confirmPaid?: "USE_METERED_PROVIDER"}} [approval] */
  setModel(id, approval = {}) {
    return this.request("model", { id, ...approval });
  }
  /** @returns {Promise<import('../ui/contracts').Providers>} */
  providers() {
    return this.request("providers");
  }
  /** @param {import('../ui/contracts').ProviderId} providerId @param {string} apiKey */
  storeProviderKey(providerId, apiKey) {
    return this.request("providers/key", {
      providerId,
      apiKey,
      confirm:
        providerId === "kimi-code"
          ? "STORE_SUBSCRIPTION_KEY"
          : "STORE_METERED_KEY",
    });
  }
  /** @returns {Promise<import('../ui/contracts').ProviderFlow>} */
  startProviderLogin() {
    return this.request("providers/login", { providerId: "openai" });
  }
  /** @param {string} id @param {string} value @returns {Promise<import('../ui/contracts').Providers>} */
  respondProviderLogin(id, value) {
    return this.request("providers/respond", { id, value });
  }
  /** @param {string | null} id */
  cancelProviderLogin(id) {
    return this.request("providers/cancel", { id });
  }
  /** Cancel only; no response data or UI continuation survives locking. @param {string | null} id */
  abandonProviderLogin(id) {
    return fetch("/api/providers/cancel", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + this.#token,
        "X-Session": this.#session,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
      cache: "no-store",
      keepalive: true,
    }).then(
      () => undefined,
      () => undefined,
    );
  }
  /** @param {import('../ui/contracts').ProviderId} providerId */
  disconnectProvider(providerId) {
    return this.request("providers/disconnect", {
      providerId,
      confirm: "DISCONNECT",
    });
  }
  refreshProviders() {
    return this.request("providers/refresh", {});
  }
  /** @param {import('../ui/contracts').CompanionAction} data @returns {Promise<import('../ui/contracts').Charter | import('../ui/contracts').Belief | import('../ui/contracts').Commitment>} */
  changeCompanion(data) {
    return this.request("companion", data);
  }
  /** @param {string} source @param {string} description */
  stageRevision(source, description) {
    return this.request("revisions", { source, description });
  }
  /** @param {string} id */
  testRevision(id) {
    return this.request("test", { id });
  }
  /** @param {string} id @param {string | null} expectedActiveRevisionId */
  activateRevision(id, expectedActiveRevisionId) {
    return this.request("activate", {
      id,
      expectedActiveRevisionId,
      confirm: "ACTIVATE",
    });
  }
  /** @param {string} id @param {string | null} expectedActiveRevisionId */
  activateSkill(id, expectedActiveRevisionId) {
    return this.request("skills/activate", {
      id,
      expectedActiveRevisionId,
      confirm: "ACTIVATE",
    });
  }
  /** @param {string} name @param {string} expectedActiveRevisionId */
  deactivateSkill(name, expectedActiveRevisionId) {
    return this.request("skills/deactivate", {
      name,
      expectedActiveRevisionId,
      confirm: "DEACTIVATE",
    });
  }
  /** @param {string} id */
  retrySummary(id) {
    return this.request("inference/retry", { id, confirm: "RETRY" });
  }
}
