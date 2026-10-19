/* red's owner UI. Layout/draft patterns adapted from the MIT Durable Pi
 * playground; see third_party/DURABLE-PI-LICENSE.txt. Transport is red's own. */
const $ = (id) => document.getElementById(id);
const client = new RedClient();
const ui = {
  connected: false,
  connecting: false,
  submitting: false,
  timer: null,
  latest: null,
  companion: null,
  skills: [],
  refreshing: null,
  inspector: "continuity",
  navOpen: false,
  inspectorOpen: false,
  charterBaseline: "",
  charterVersion: 0,
  charterDirty: false,
  charterConflict: false,
  charterSaving: false,
  charterRemote: null,
  requestId: null,
  requestText: null,
  lastSubmission: null,
  sourceBaseline: "",
  historyKey: "",
  releaseKey: "",
  failuresKey: "",
  modelDirty: false,
  continuityRequest: 0,
  skillsRequest: 0,
  noticeTimer: null,
  providers: null,
  providerEpoch: 0,
  providerRequest: 0,
  providerLoading: null,
  providerBusy: false,
  providerTimer: null,
  providerKeyId: null,
  providerFlow: null,
  providerFlowStarting: false,
  providerPromptKey: "",
};
const panels = [
  "continuity",
  "commitmentPanel",
  "skills",
  "evolution",
  "connection",
];
const tabs = [
  "continuityTab",
  "commitmentsTab",
  "skillsTab",
  "releasesTab",
  "connectionTab",
];
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function setError(error) {
  if (error?.message === "Session changed") return;
  const message = error?.message || (typeof error === "string" ? error : "");
  $("error").textContent = message;
  $("errorBanner").hidden = !message;
}
function report(error, generation = client.generation) {
  if (generation !== client.generation || error?.message === "Session changed")
    return;
  if (error instanceof RedApiError && error.status === 401) {
    lock(false);
    setError(
      "Owner access was rejected. Reconnect with the token configured for this instance.",
    );
  } else setError(error);
}
function notice(text) {
  clearTimeout(ui.noticeTimer);
  $("notice").textContent = text;
  $("notice").hidden = !text;
  if (text)
    ui.noticeTimer = setTimeout(() => {
      $("notice").hidden = true;
    }, 4500);
}
function assertCurrentSession(generation) {
  if (generation !== client.generation) throw Error("Session changed");
}
async function action(fn, control) {
  if (control?.dataset.busy) return;
  const generation = client.generation;
  if (control) {
    control.dataset.busy = "true";
    control.disabled = true;
  }
  try {
    setError(null);
    // Transport validation happens before its promise settles. Another request
    // can lock the UI before our continuation runs, so every await that precedes
    // a UI change or follow-on request must check this action's session again.
    const result = await fn(() => assertCurrentSession(generation));
    assertCurrentSession(generation);
    return result;
  } catch (error) {
    report(error, generation);
  } finally {
    if (generation === client.generation && control) {
      delete control.dataset.busy;
      control.disabled = false;
      updateControls();
    }
  }
}
function button(label, fn, className = "secondary") {
  const node = element("button", label, className);
  node.type = "button";
  node.onclick = () => action((checkSession) => fn(node, checkSession), node);
  return node;
}
function reviewCard(title, text, controls = [], className = "") {
  const card = element("article", undefined, "revision " + className);
  card.append(element("strong", title), element("p", text), ...controls);
  return card;
}
function empty(container, text) {
  container.append(element("p", text, "empty-state"));
}
function dateText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
function syncLayout() {
  const mobile = window.matchMedia("(max-width: 850px)").matches;
  const focused = document.activeElement;
  if (mobile && ui.navOpen && ui.inspectorOpen) {
    // Desktop permits both panels. On resize keep the focused panel, preferring
    // the inspector when focus is elsewhere, rather than stacking two overlays.
    if ($("navigation").contains(focused)) {
      cleanupProviderView();
      ui.inspectorOpen = false;
    } else ui.navOpen = false;
  }
  $("navigation").hidden = !ui.navOpen;
  $("inspector").hidden = !ui.inspectorOpen;
  $("toggleNav").setAttribute("aria-expanded", String(ui.navOpen));
  $("toggleNav").setAttribute(
    "aria-label",
    ui.navOpen ? "Close navigation" : "Open navigation",
  );
  $("toggleInspector").setAttribute("aria-expanded", String(ui.inspectorOpen));
  $("chat").inert = mobile && (ui.navOpen || ui.inspectorOpen);
  if ($("chat").inert && $("chat").contains(focused))
    $(
      ui.inspectorOpen ? tabs[panels.indexOf(ui.inspector)] : "chatTab",
    ).focus();
}
function toggleNav() {
  ui.navOpen = !ui.navOpen;
  if (ui.navOpen && window.matchMedia("(max-width: 850px)").matches) {
    cleanupProviderView();
    ui.inspectorOpen = false;
  }
  syncLayout();
  if (ui.navOpen) $("chatTab").focus();
  else $("toggleNav").focus();
}
function closeInspector(focus = true) {
  cleanupProviderView();
  ui.inspectorOpen = false;
  syncLayout();
  if (focus) $("toggleInspector").focus();
}
function openInspector(id = ui.inspector, focus = true) {
  if (!panels.includes(id) || !ui.connected) return;
  if (ui.inspector === "connection" && id !== "connection")
    cleanupProviderView();
  ui.inspector = id;
  ui.inspectorOpen = true;
  if (window.matchMedia("(max-width: 850px)").matches) ui.navOpen = false;
  panels.forEach((name, i) => {
    $(name).hidden = name !== id;
    $(tabs[i]).setAttribute("aria-selected", String(name === id));
    $(tabs[i]).tabIndex = name === id ? 0 : -1;
  });
  $("panelStatus").textContent = "";
  syncLayout();
  if (focus) $(tabs[panels.indexOf(id)]).focus();
  if (id === "continuity" || id === "commitmentPanel")
    return action(loadContinuity);
  if (id === "skills") return action(loadSkills);
  if (id === "connection")
    return loadProviders().catch((error) => report(error));
  if (id === "evolution") {
    // Retain the prior Evolution entry point's skill loading, without hiding chat.
    return action(async (checkSession) => {
      await refresh();
      checkSession();
      await loadSkills();
    });
  }
}
function showTab(id) {
  if (id === "chat") {
    closeInspector(false);
    ui.navOpen = false;
    syncLayout();
    $("prompt").focus();
  } else return openInspector(id);
}
function composeDraft(text) {
  if (
    $("prompt").value.trim() &&
    !confirm("Replace the unsent conversation draft?")
  )
    return;
  $("prompt").value = text;
  promptChanged();
  showTab("chat");
  notice("Draft prepared. Review it, then send when you’re ready.");
}
function updateControls() {
  $("send").disabled =
    !ui.connected || ui.submitting || !$("prompt").value.trim();
  $("send").textContent = ui.submitting ? "Sending…" : "Send ↑";
  $("abort").disabled =
    !ui.connected || !ui.latest?.pending?.length || !!$("abort").dataset.busy;
  const models = ui.latest?.inference?.models || [];
  $("setModel").disabled =
    !models.length ||
    !$("modelSelect").value ||
    !!ui.latest?.pending?.length ||
    !!$("setModel").dataset.busy;
  $("modelSelect").disabled = !models.length || !!$("setModel").dataset.busy;
  $("saveCharter").disabled =
    !ui.charterDirty || ui.charterConflict || ui.charterSaving || !ui.companion;
  $("resetCharter").disabled = !ui.charterDirty || ui.charterSaving;
  $("charter").disabled = !ui.companion;
}
function setCharterStatus() {
  ui.charterDirty = $("charter").value !== ui.charterBaseline;
  $("charterStatus").textContent = ui.charterConflict
    ? "The charter changed elsewhere. Your draft is kept. Copy any edits you need before loading the saved version."
    : ui.charterDirty
      ? "Unsaved changes · kept while you move between panels"
      : ui.charterVersion
        ? "Saved · version " + ui.charterVersion
        : "No charter saved yet.";
  updateControls();
}
function adoptCharter(charter) {
  ui.charterVersion = charter?.version ?? 0;
  ui.charterBaseline = charter?.text ?? "";
  ui.charterRemote = charter;
  ui.charterConflict = false;
  $("charter").value = ui.charterBaseline;
  setCharterStatus();
}
function renderHistory(state) {
  const key = JSON.stringify([state.history, state.historyHasMore]);
  if (key === ui.historyKey) return;
  const scroll = $("chatScroll");
  const atBottom =
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
  const first = !ui.historyKey;
  ui.historyKey = key;
  $("messages").replaceChildren();
  if (state.historyHasMore)
    $("messages").append(
      element(
        "p",
        "Showing the latest 100 archived entries. Earlier originals remain in durable memory.",
        "history-note",
      ),
    );
  let count = 0;
  for (const entry of state.history) {
    let text = entry.text;
    if (entry.kind === "unii") {
      try {
        text = JSON.parse(entry.text)
          .flatMap((message) =>
            typeof message.content === "string"
              ? [message.content]
              : (message.content ?? [])
                  .filter((part) => part.type === "text")
                  .map((part) => part.text),
          )
          .join("\n");
      } catch {
        text = "[Unreadable archived reply]";
      }
    }
    if (!text) continue;
    const user = entry.kind === "user";
    const box = element(
      "article",
      undefined,
      "message " + (user ? "user" : "assistant"),
    );
    const label = element("div", undefined, "label");
    label.append(element("span", user ? "You" : "red"));
    const time = element("time", dateText(entry.date));
    time.dateTime = entry.date;
    label.append(time);
    box.append(label, document.createTextNode(text));
    $("messages").append(box);
    count++;
  }
  $("emptyChat").hidden = count > 0;
  if (first || atBottom) {
    scroll.scrollTop = scroll.scrollHeight;
    $("newMessages").hidden = true;
  } else $("newMessages").hidden = false;
}
const providerNames = {
  openai: "ChatGPT subscription",
  openrouter: "OpenRouter",
  "opencode-zen": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
};
function isPaidModel(id) {
  return id.startsWith("openrouter::") || id.startsWith("opencode-zen::");
}
function modelLabel(id) {
  const separator = id.indexOf("::");
  if (separator < 0)
    return (
      (ui.latest?.inference.mode === "paid-api"
        ? "Paid API · "
        : "ChatGPT · ") + id
    );
  const provider = id.slice(0, separator);
  return (
    (providerNames[provider] || provider) +
    " · " +
    id.slice(separator + 2) +
    " (metered)"
  );
}
function renderModelBilling() {
  const id = $("modelSelect").value;
  $("modelBilling").textContent =
    isPaidModel(id) || ui.latest?.inference.mode === "paid-api"
      ? "Metered API · selecting this model requires confirmation. Usage consumes your existing credits or bills your provider account."
      : id
        ? "Uses your ChatGPT subscription allowance. No automatic paid fallback."
        : "Choose a connected model explicitly. No paid model is selected automatically.";
}
function activeProviderFlow(flow = ui.providerFlow) {
  return (
    flow &&
    ["pending", "starting", "waiting", "exchanging", "saving"].includes(
      flow.status,
    )
  );
}
function providerViewCurrent(epoch, generation) {
  return (
    generation === client.generation &&
    epoch === ui.providerEpoch &&
    ui.connected &&
    ui.inspectorOpen &&
    ui.inspector === "connection"
  );
}
function stopProviderPolling() {
  clearInterval(ui.providerTimer);
  ui.providerTimer = null;
}
function wipeProviderInputs() {
  $("providerKey").value = "";
  $("providerResponse").value = "";
}
function cleanupProviderView() {
  if (activeProviderFlow() || ui.providerFlowStarting)
    void client.abandonProviderLogin(ui.providerFlow?.id ?? null);
  ++ui.providerEpoch;
  ++ui.providerRequest;
  stopProviderPolling();
  ui.providerLoading = null;
  ui.providerBusy = false;
  ui.providerKeyId = null;
  ui.providerFlow = null;
  ui.providerFlowStarting = false;
  ui.providerPromptKey = "";
  wipeProviderInputs();
  $("providerKeyForm").hidden = true;
  $("providerFlow").hidden = true;
  $("providerResponseForm").hidden = true;
  $("providerAuthLink").hidden = true;
  $("providerAuthLink").removeAttribute("href");
}
function updateProviderControls() {
  const blocked =
    ui.providerBusy || !!activeProviderFlow() || ui.providerFlowStarting;
  for (const node of $("providerCards").querySelectorAll(
    "[data-provider-action]",
  ))
    node.disabled = blocked || node.dataset.unsupported === "true";
  $("refreshProviders").disabled = ui.providerBusy || !!ui.providerLoading;
  $("saveProviderKey").disabled = ui.providerBusy;
  $("saveProviderKey").textContent = ui.providerBusy
    ? "Saving…"
    : "Save key on this host";
  $("cancelProviderKey").disabled = ui.providerBusy;
  $("providerKey").disabled = ui.providerBusy;
  $("submitProviderResponse").disabled = ui.providerBusy;
  $("providerResponse").disabled = ui.providerBusy;
}
function providerControl(label, callback) {
  const node = element("button", label, "secondary");
  node.type = "button";
  node.dataset.providerAction = "true";
  node.onclick = () => {
    if (!providerViewCurrent(ui.providerEpoch, client.generation)) return;
    return callback();
  };
  return node;
}
function renderProviders() {
  $("providerCards").replaceChildren();
  $("providerGuide").hidden = ui.providers?.available !== false;
  // A loopback link is useful only when this browser is already on this host.
  $("localBridgeLink").hidden = !["127.0.0.1", "localhost", "[::1]"].includes(
    window.location?.hostname,
  );
  if (!ui.providers?.available) {
    $("providerStatus").textContent =
      ui.providers?.message || "Checking the trusted inference host…";
    updateProviderControls();
    return;
  }
  $("providerStatus").textContent =
    "Connections are stored only on this trusted inference host.";
  for (const id of Object.keys(providerNames)) {
    const provider = ui.providers.providers.find((item) => item.id === id);
    if (!provider) continue;
    const card = element("article", undefined, "provider-card");
    card.dataset.provider = id;
    const heading = element("div", undefined, "provider-card-heading");
    heading.append(
      element("strong", providerNames[id]),
      element(
        "span",
        id === "opencode-go"
          ? "Coding only"
          : ["needs_attention", "auth_error", "quota", "error"].includes(
                provider.status,
              )
            ? "Needs attention"
            : provider.status === "no_models"
              ? "No models"
              : ["unverified", "saved_unverified"].includes(provider.status)
                ? "Saved · unverified"
                : provider.connected
                  ? "Connected"
                  : "Not connected",
        "provider-badge",
      ),
    );
    card.append(heading, element("p", provider.message));
    if (id === "opencode-go") {
      card.append(
        element(
          "p",
          "Go is limited to coding-agent use. red shares one harness across conversation, memory and self-coding, so it cannot isolate a Go coding session yet.",
          "hint",
        ),
      );
      const disabled = providerControl(
        "Scoped coding sessions not supported",
        () => {},
      );
      disabled.dataset.unsupported = "true";
      const docs = element("a", "OpenCode Go documentation ↗", "provider-docs");
      docs.setAttribute("href", "https://opencode.ai/v2/docs/console/go/");
      docs.setAttribute("target", "_blank");
      docs.setAttribute("rel", "noopener noreferrer");
      card.append(disabled, docs);
    } else {
      card.append(
        element(
          "span",
          id === "openai"
            ? "Subscription allowance"
            : "Metered API · existing credits / usage billing",
          "provider-cost",
        ),
      );
      if (id !== "openai" || !provider.connected)
        card.append(
          providerControl(
            id === "openai"
              ? "Sign in with ChatGPT"
              : provider.connected
                ? "Replace API key"
                : "Connect API key",
            () => {
              if (
                ui.providerBusy ||
                activeProviderFlow() ||
                ui.providerFlowStarting
              )
                return;
              if (id === "openai") return beginProviderSignIn();
              ui.providerKeyId = id;
              wipeProviderInputs();
              $("providerKeyTitle").textContent =
                "Connect " + providerNames[id];
              $("providerKeyForm").hidden = false;
              $("providerKey").focus();
            },
          ),
        );
      if (provider.connected) {
        if (id === "openai")
          card.append(
            element(
              "p",
              "To sign in again, first remove this local connection. Reauthorization uses the same ChatGPT account/workspace; a different account needs a separate private bridge directory.",
              "hint",
            ),
          );
        card.append(
          element("p", provider.models.length + " models discovered", "hint"),
        );
        card.append(
          providerControl("Remove local connection", () => {
            if (
              !confirm(
                "Remove the saved " +
                  providerNames[id] +
                  " connection from this host? New requests using it will stop. " +
                  (id === "openai"
                    ? "This does not revoke the OAuth grant. Revoke it separately in ChatGPT connected apps/settings if needed."
                    : "This does not revoke your API key. Revoke it separately on the provider’s account site if needed."),
              )
            )
              return;
            return providerAction(async (check) => {
              await client.disconnectProvider(id);
              check();
              await loadProviders();
              check();
              await refresh();
              check();
              notice(providerNames[id] + " disconnected from this host.");
            });
          }),
        );
      }
    }
    $("providerCards").append(card);
  }
  updateProviderControls();
}
function renderProviderFlow() {
  const flow = ui.providerFlow;
  $("providerFlow").hidden = !flow && !ui.providerFlowStarting;
  const link = $("providerAuthLink");
  link.hidden = true;
  link.removeAttribute("href");
  $("providerResponseForm").hidden = true;
  if (!flow) {
    $("providerFlowStatus").textContent = ui.providerFlowStarting
      ? "Preparing secure OpenAI sign-in…"
      : "";
    return;
  }
  $("providerFlowStatus").textContent =
    flow.message ||
    {
      pending: "Preparing sign-in…",
      starting: "Preparing sign-in…",
      exchanging: "Verifying ChatGPT authorization…",
      saving: "Saving authorization on this host…",
      expired: "Sign-in expired. Start again when you’re ready.",
      waiting: "Waiting for you to finish OpenAI sign-in…",
      connected: "ChatGPT connected. Choose a model below when you’re ready.",
      cancelled: "Sign-in cancelled.",
      error: "Sign-in could not finish. Try again.",
    }[flow.status];
  const active = activeProviderFlow(flow);
  if (active && flow.url) {
    try {
      const url = new URL(flow.url);
      if (
        url.origin !== "https://auth.openai.com" ||
        url.username ||
        url.password
      )
        throw Error("Unexpected sign-in address");
      link.setAttribute("href", url.href);
      link.hidden = false;
    } catch {
      $("providerFlowStatus").textContent =
        "The host returned an unexpected sign-in address. Cancel and check the bridge configuration.";
    }
  }
  const key = JSON.stringify([flow.id, flow.prompt]);
  if (key !== ui.providerPromptKey) {
    $("providerResponse").value = "";
    ui.providerPromptKey = key;
  }
  if (active && flow.prompt) {
    $("providerResponseForm").hidden = false;
    $("providerPromptLabel").textContent = flow.prompt.message;
  }
  if (!active) $("providerResponse").value = "";
  $("cancelProviderFlow").textContent = active ? "Cancel sign-in" : "Dismiss";
  updateProviderControls();
}
function scheduleProviderPolling() {
  stopProviderPolling();
  if (!activeProviderFlow()) return;
  const epoch = ui.providerEpoch,
    generation = client.generation;
  ui.providerTimer = setInterval(() => {
    if (!providerViewCurrent(epoch, generation)) return stopProviderPolling();
    if (activeProviderFlow() && ui.providerFlow.expiresAt <= Date.now()) {
      void client.abandonProviderLogin(ui.providerFlow.id);
      ui.providerFlow = {
        ...ui.providerFlow,
        status: "expired",
        message: "Sign-in expired. Start again when you’re ready.",
      };
      ++ui.providerRequest;
      stopProviderPolling();
      renderProviderFlow();
      return;
    }
    if (!ui.providerBusy && !ui.providerLoading) void loadProviders();
  }, 3000);
}
async function loadProviders() {
  const epoch = ui.providerEpoch,
    generation = client.generation;
  if (!providerViewCurrent(epoch, generation)) return;
  if (ui.providerLoading?.epoch === epoch) return ui.providerLoading.promise;
  const request = ++ui.providerRequest;
  const pending = { epoch, promise: null };
  ui.providerLoading = pending;
  updateProviderControls();
  pending.promise = (async () => {
    try {
      const data = await client.providers();
      if (
        !providerViewCurrent(epoch, generation) ||
        request !== ui.providerRequest
      )
        return;
      ui.providers = data;
      if (!data.available) {
        ui.providerKeyId = null;
        wipeProviderInputs();
        $("providerKeyForm").hidden = true;
      }
      const wasActive = activeProviderFlow();
      ui.providerFlow = data.available ? data.flow : null;
      if (activeProviderFlow() && ui.providerFlow.expiresAt <= Date.now()) {
        void client.abandonProviderLogin(ui.providerFlow.id);
        ui.providerFlow = {
          ...ui.providerFlow,
          status: "error",
          message: "Sign-in expired. Start again when you’re ready.",
        };
      }
      renderProviders();
      renderProviderFlow();
      scheduleProviderPolling();
      if (wasActive && ui.providerFlow?.status === "connected") {
        await refresh();
        if (!providerViewCurrent(epoch, generation)) return;
        notice("ChatGPT connected. Choose a model to use it.");
      }
    } catch (error) {
      if (
        providerViewCurrent(epoch, generation) &&
        request === ui.providerRequest
      ) {
        report(error, generation);
        if (providerViewCurrent(epoch, generation))
          $("providerStatus").textContent =
            "Couldn’t read provider status. Try Refresh.";
      }
    } finally {
      if (ui.providerLoading === pending) {
        ui.providerLoading = null;
        updateProviderControls();
      }
    }
  })();
  return pending.promise;
}
async function providerAction(operation) {
  const epoch = ui.providerEpoch,
    generation = client.generation;
  if (ui.providerBusy || !providerViewCurrent(epoch, generation)) return;
  ui.providerBusy = true;
  ++ui.providerRequest;
  ui.providerLoading = null;
  updateProviderControls();
  const check = () => {
    if (!providerViewCurrent(epoch, generation))
      throw Error("Provider view changed");
  };
  try {
    setError(null);
    await operation(check);
    check();
  } catch (error) {
    if (providerViewCurrent(epoch, generation)) report(error, generation);
  } finally {
    if (providerViewCurrent(epoch, generation)) {
      ui.providerBusy = false;
      updateProviderControls();
    }
  }
}
function beginProviderSignIn() {
  return providerAction(async (check) => {
    ui.providerKeyId = null;
    wipeProviderInputs();
    $("providerKeyForm").hidden = true;
    ui.providerFlowStarting = true;
    ui.providerFlow = null;
    renderProviderFlow();
    $("providerFlowStatus").focus();
    const generation = client.generation;
    try {
      const flow = await client.startProviderLogin();
      try {
        check();
      } catch (error) {
        if (generation === client.generation)
          void client.abandonProviderLogin(flow.id);
        throw error;
      }
      ui.providerFlow = flow;
      ui.providerFlowStarting = false;
      renderProviderFlow();
      scheduleProviderPolling();
    } catch (error) {
      check();
      ui.providerFlowStarting = false;
      renderProviderFlow();
      throw error;
    }
  });
}
function cancelProviderSignIn() {
  const id = ui.providerFlow?.id ?? null;
  const active = activeProviderFlow() || ui.providerFlowStarting;
  if (!active && ui.providerBusy) return;
  // Invalidate late login and poll responses before sending cancellation.
  ++ui.providerEpoch;
  ++ui.providerRequest;
  stopProviderPolling();
  ui.providerBusy = false;
  ui.providerLoading = null;
  ui.providerFlow = null;
  ui.providerFlowStarting = false;
  wipeProviderInputs();
  renderProviderFlow();
  updateProviderControls();
  if (!active) return;
  return providerAction(async (check) => {
    await client.cancelProviderLogin(id);
    check();
    await loadProviders();
    check();
    notice("Sign-in cancelled.");
  });
}

function renderConnection(state) {
  const inference = state.inference;
  const recent = inference.lastSeen && Date.now() - inference.lastSeen < 60000;
  const authFailure = inference.failures?.find(
    (failure) => failure.error?.kind === "auth",
  );
  const bridge =
    inference.mode === "paid-api"
      ? "Paid API explicitly enabled"
      : inference.mode === "metered-bridge"
        ? recent
          ? "Metered bridge online"
          : "Metered bridge offline"
        : recent
          ? "Inference bridge online"
          : "Inference bridge offline";
  $("bridgeStatus").textContent =
    bridge + (recent ? "" : " · queued work persists");
  $("connectionDetails").replaceChildren();
  const rows = [
    ["Owner access", "Connected to this session"],
    ["Inference", bridge],
    [
      "Provider sign-in",
      authFailure
        ? "A provider authentication error needs attention on the trusted host."
        : "Managed on the trusted host; bridge activity alone does not verify sign-in.",
    ],
    [
      "Last bridge contact",
      inference.lastSeen ? dateText(inference.lastSeen) : "No contact recorded",
    ],
    ["Active model", inference.selected || "Not selected"],
  ];
  const list = element("dl");
  for (const [name, value] of rows)
    list.append(element("dt", name), element("dd", value));
  $("connectionDetails").append(list);
  $("runtimeDetails").textContent = JSON.stringify(
    {
      session: $("sessionName").textContent,
      queue: inference.jobs,
      archive: state.memory,
      activeRevision: state.active?.revisionId ?? null,
    },
    null,
    2,
  );
  const select = $("modelSelect");
  const selected = select.value;
  const models = inference.models || [];
  const choices = models.some((id) => !isPaidModel(id))
    ? models
    : ["", ...models];
  const same =
    JSON.stringify([...select.options].map((option) => option.value)) ===
    JSON.stringify(choices);
  if (!same)
    select.replaceChildren(
      ...choices.map((id) => {
        const option = element(
          "option",
          id ? modelLabel(id) : "Choose a model",
        );
        option.value = id;
        return option;
      }),
    );
  if (ui.modelDirty && models.includes(selected)) select.value = selected;
  else {
    select.value = models.includes(inference.selected)
      ? inference.selected
      : models.find((id) => !isPaidModel(id)) || "";
    ui.modelDirty = false;
  }
  renderModelBilling();
  const pending = state.pending.length;
  const inferenceAvailable = recent || inference.mode === "paid-api";
  $("status").textContent = pending
    ? inferenceAvailable
      ? "Working · saved"
      : "Waiting for bridge"
    : "Connected";
  $("status").dataset.state = pending
    ? inferenceAvailable
      ? "working"
      : "offline"
    : "ready";
  $("activityNote").textContent = pending
    ? "Work is safely persisted. You can close this tab."
    : "Your conversation stays with red.";
  $("conversationSubtitle").textContent =
    (inference.selected || "Model not selected") +
    " · " +
    $("sessionName").textContent;
  $("memory").textContent = state.memory.messages + " archived messages";
}
function renderFailures(state) {
  const key = JSON.stringify([state.inference.failures, ui.lastSubmission]);
  if (key === ui.failuresKey) return;
  ui.failuresKey = key;
  $("inferenceErrors").replaceChildren();
  for (const failure of state.inference.failures || []) {
    if (!failure.error) continue;
    const controls = [];
    if (failure.summary)
      controls.push(
        button("Retry summary", async (_control, checkSession) => {
          if (
            !confirm(
              isPaidModel(ui.latest?.inference.selected || "") ||
                ui.latest?.inference.mode === "paid-api"
                ? "Retry this failed memory summary using your selected metered model? This consumes your existing provider credits or bills your provider account."
                : "Retry this failed summary using your subscription allowance?",
            )
          )
            return;
          await client.retrySummary(failure.id);
          checkSession();
          await refresh();
        }),
      );
    else if (ui.lastSubmission)
      controls.push(
        button("Restore last prompt", () => composeDraft(ui.lastSubmission)),
      );
    $("inferenceErrors").append(
      reviewCard(
        failure.summary
          ? "Memory summary needs attention"
          : "Inference needs attention",
        failure.error.message,
        controls,
      ),
    );
  }
}
function renderReleases(state) {
  const active = state.active?.revisionId ?? null;
  const key = JSON.stringify([active, state.releases]);
  if (key === ui.releaseKey) return;
  ui.releaseKey = key;
  $("revisions").replaceChildren();
  if (!state.releases.length)
    empty(
      $("revisions"),
      "No behavior revisions yet. Changes red proposes will be reviewed here.",
    );
  for (const revision of state.releases) {
    const isActive = revision.id === active;
    const card = reviewCard(
      revision.description || "Untitled revision",
      dateText(revision.createdAt) + " · " + revision.id.slice(0, 12),
      [],
      isActive ? "active-card" : "approval-card",
    );
    card.prepend(
      element("div", isActive ? "ACTIVE" : "REVIEW BEFORE ACTIVATION", "tag"),
    );
    const source = element("pre", "Open to load this revision.");
    const details = element("details", undefined, "raw");
    details.append(element("summary", "Review source"), source);
    let loaded = false,
      loading = false;
    details.ontoggle = () => {
      if (!details.open || loaded || loading) return;
      loading = true;
      return action(async (checkSession) => {
        try {
          source.textContent = "Loading…";
          const revisionSource = await client.revision(revision.id);
          checkSession();
          source.textContent = revisionSource.source;
          loaded = true;
        } finally {
          loading = false;
        }
      });
    };
    const test = button("Run smoke test", async (control, checkSession) => {
      await client.testRevision(revision.id);
      checkSession();
      control.textContent = "Smoke test passed";
      notice(
        "Contract smoke test passed. Review behavior and data changes before activation.",
      );
    });
    const activate = button(
      isActive ? "Active" : "Activate / roll back",
      async (_control, checkSession) => {
        if (
          !confirm(
            "Activate revision " +
              revision.id +
              "? This runs new behavior against the existing facet database. Data migrations are not rolled back.",
          )
        )
          return;
        await client.activateRevision(revision.id, active);
        checkSession();
        await refresh();
        checkSession();
        notice("Behavior revision activated.");
      },
      "primary",
    );
    activate.disabled = isActive;
    card.append(details, test, activate);
    $("revisions").append(card);
  }
}
async function refresh() {
  const generation = client.generation;
  if (ui.refreshing?.generation === generation) return ui.refreshing.promise;
  const pending = { generation, promise: null };
  ui.refreshing = pending;
  pending.promise = (async () => {
    const state = await client.state();
    assertCurrentSession(generation);
    ui.latest = state;
    renderConnection(state);
    renderHistory(state);
    renderFailures(state);
    renderReleases(state);
    updateControls();
    return state;
  })();
  try {
    return await pending.promise;
  } finally {
    if (ui.refreshing === pending) ui.refreshing = null;
  }
}
function renderBeliefs() {
  const beliefs = ui.companion?.beliefs || [];
  const query = $("memorySearch").value.toLocaleLowerCase().trim();
  $("beliefs").replaceChildren();
  const shown = beliefs.filter((belief) =>
    (belief.text + " " + belief.kind + " " + belief.status)
      .toLocaleLowerCase()
      .includes(query),
  );
  if (!shown.length)
    empty(
      $("beliefs"),
      query
        ? "No matching memories in this view."
        : "No memories to review yet. Attributed proposals will appear here.",
    );
  for (const belief of shown) {
    const controls = [];
    if (belief.status === "proposed")
      controls.push(
        button("Accept memory", async (_control, checkSession) => {
          await client.changeCompanion({
            action: "accept-belief",
            id: belief.id,
          });
          checkSession();
          await loadContinuity();
          checkSession();
          notice("Memory accepted.");
        }),
      );
    controls.push(
      button("Discuss correction", () =>
        composeDraft(
          "Please review memory #" +
            belief.id +
            " (" +
            belief.kind +
            "): “" +
            belief.text +
            "”. I want to correct it as follows: ",
        ),
      ),
    );
    const card = reviewCard(
      belief.kind + " · " + belief.status,
      belief.text,
      controls,
      belief.status === "proposed" ? "approval-card" : "",
    );
    const details = element("details", undefined, "raw");
    details.append(
      element("summary", "Attribution"),
      element(
        "p",
        "Source events: " +
          belief.sourceEventIds.join(", ") +
          "\nScope: " +
          belief.scope +
          "\nConfidence: " +
          Math.round(belief.confidence * 100) +
          "%" +
          (belief.supersedes ? "\nCorrects memory #" + belief.supersedes : "") +
          (belief.expiresAt ? "\nExpires: " + dateText(belief.expiresAt) : ""),
      ),
    );
    card.append(details);
    $("beliefs").append(card);
  }
}
function sourceEvidence(ids) {
  const request = ui.continuityRequest;
  const details = element("details", undefined, "raw");
  details.append(element("summary", "Source evidence"));
  for (const id of ids || []) {
    const source = element("div");
    let offset = 0;
    const read = button(
      "Read source event #" + id,
      async (control, checkSession) => {
        const page = await client.sourceEvent(id, offset);
        checkSession();
        // Dismissed or refreshed views must not be repopulated by a late read.
        if (
          request !== ui.continuityRequest ||
          !ui.inspectorOpen ||
          !source.isConnected ||
          !details.open ||
          ui.inspector !== "commitmentPanel"
        )
          return;
        if (offset === 0)
          source.append(
            element(
              "p",
              page.source +
                " · " +
                page.sourceRef +
                " · " +
                dateText(page.occurredAt),
              "card-meta",
            ),
          );
        source.append(element("pre", page.text));
        if (page.nextOffset === null) control.hidden = true;
        else {
          offset = page.nextOffset;
          control.textContent = "Read next part of source #" + id;
        }
      },
    );
    source.append(read);
    details.append(source);
  }
  return details;
}
function renderWorkJournal() {
  const container = $("workJournal");
  container.replaceChildren();
  const journal = ui.companion?.journal;
  if (!journal?.entries.length)
    return empty(container, "No recorded work yet.");
  for (const entry of journal.entries) {
    const card = reviewCard(
      "Commitment #" + entry.commitmentId + " · recorded " + entry.status,
      entry.text + (entry.textTruncated ? "…" : ""),
    );
    card.append(
      element("p", dateText(entry.recordedAt), "card-meta"),
      sourceEvidence(entry.evidenceEventIds),
    );
    container.append(card);
  }
  if (journal.omitted)
    container.append(
      element(
        "p",
        journal.omitted +
          " older journal entries omitted. Full transition history remains on each commitment.",
        "card-meta",
      ),
    );
}
function renderCommitments() {
  $("commitments").replaceChildren();
  const commitments = ui.companion?.commitments || [];
  const count = commitments.filter((item) =>
    ["open", "blocked"].includes(item.status),
  ).length;
  $("workCount").textContent =
    count + (count === 1 ? " open commitment" : " open commitments");
  if (!commitments.length)
    empty(
      $("commitments"),
      "Nothing waiting here. Accepted commitments will remain visible across visits.",
    );
  const order = {
    proposed: 0,
    blocked: 1,
    open: 2,
    completed: 3,
    cancelled: 4,
  };
  for (const commitment of [...commitments].sort(
    (a, b) => order[a.status] - order[b.status],
  )) {
    const controls = [];
    if (commitment.status === "proposed")
      controls.push(
        button("Accept commitment", async (_control, checkSession) => {
          await client.changeCompanion({
            action: "accept-commitment",
            id: commitment.id,
          });
          checkSession();
          await loadContinuity();
          checkSession();
          notice("Commitment accepted.");
        }),
      );
    if (["open", "blocked"].includes(commitment.status)) {
      controls.push(
        button("Mark completed", async (_control, checkSession) => {
          await client.changeCompanion({
            action: "complete-commitment",
            id: commitment.id,
          });
          checkSession();
          await loadContinuity();
        }),
      );
      controls.push(
        button("Cancel commitment", async (_control, checkSession) => {
          if (!confirm("Cancel this commitment?")) return;
          await client.changeCompanion({
            action: "cancel-commitment",
            id: commitment.id,
          });
          checkSession();
          await loadContinuity();
        }),
      );
    }
    const card = reviewCard(
      "Commitment · " + commitment.status,
      commitment.text,
      controls,
      commitment.status === "proposed" ? "approval-card" : "",
    );
    card.append(
      element(
        "p",
        "Commitment #" + commitment.id + " · " + (commitment.scope || ""),
        "card-meta",
      ),
    );
    if (commitment.status === "proposed")
      card.append(
        element(
          "p",
          "Awaiting your review. Accept records this commitment; it does not authorize tools or external actions.",
          "card-meta",
        ),
      );
    if (commitment.status === "blocked")
      card.append(
        element(
          "p",
          "Blocked. Inspect the latest transition evidence before choosing the next step.",
          "card-meta",
        ),
      );
    card.append(sourceEvidence(commitment.sourceEventIds));
    const history = element("details", undefined, "raw");
    history.append(element("summary", "Transition history"));
    for (const change of commitment.history || []) {
      const row = element("div");
      row.append(
        element(
          "p",
          "Recorded " + change.status + " · " + dateText(change.recordedAt),
        ),
        sourceEvidence(change.evidenceEventIds),
      );
      history.append(row);
    }
    card.append(history);
    if (commitment.dueAt)
      card.append(
        element("p", "Due " + dateText(commitment.dueAt), "card-meta"),
      );
    $("commitments").append(card);
  }
}
async function loadContinuity() {
  const request = ++ui.continuityRequest;
  const generation = client.generation;
  if (ui.inspector === "continuity" || ui.inspector === "commitmentPanel")
    $("panelStatus").textContent = "Loading saved continuity…";
  try {
    const data = await client.companion();
    assertCurrentSession(generation);
    if (request !== ui.continuityRequest) return;
    ui.companion = data;
    ui.charterRemote = data.charter;
    if (!ui.charterDirty && !ui.charterSaving) adoptCharter(data.charter);
    else if ((data.charter?.version ?? 0) !== ui.charterVersion) {
      ui.charterConflict = true;
      setCharterStatus();
    }
    renderBeliefs();
    renderCommitments();
    renderWorkJournal();
    updateControls();
  } finally {
    if (
      generation === client.generation &&
      request === ui.continuityRequest &&
      ["continuity", "commitmentPanel"].includes(ui.inspector)
    )
      $("panelStatus").textContent = "";
  }
}
function fullSkillView(full) {
  const body = element("div");
  for (const [title, value] of [
    ["Use when", full.whenToUse],
    ["Avoid when", full.whenNotToUse],
    ["Instructions", full.instructions],
    ["Positive examples", full.useExamples],
    ["Counterexamples", full.avoidExamples],
  ]) {
    body.append(
      element("h4", title),
      element("p", Array.isArray(value) ? value.join("\n• ") : value),
    );
  }
  if (full.evaluation)
    body.append(
      element(
        "p",
        "Trigger smoke test: " +
          full.evaluation.correct +
          "/" +
          full.evaluation.total +
          ". " +
          full.evaluation.warning,
        "callout",
      ),
    );
  body.append(
    element(
      "p",
      "Evidence runs: " + full.evidenceRunIds.join(", "),
      "card-meta",
    ),
  );
  const raw = element("details", undefined, "raw");
  raw.append(
    element("summary", "Full revision data"),
    element("pre", JSON.stringify(full, null, 2)),
  );
  body.append(raw);
  return body;
}
async function loadSkills() {
  const request = ++ui.skillsRequest;
  const generation = client.generation;
  if (ui.inspector === "skills")
    $("panelStatus").textContent = "Loading skills…";
  try {
    const data = await client.skills();
    assertCurrentSession(generation);
    if (request !== ui.skillsRequest) return;
    ui.skills = data.skills;
    $("skillPanel").replaceChildren();
    if (!data.skills.length)
      empty(
        $("skillPanel"),
        "No skills proposed yet. Ask red to develop a repeatable procedure from work you have done together.",
      );
    for (const skill of data.skills) {
      const card = reviewCard(
        skill.name + " · " + skill.status,
        skill.description,
        [],
        skill.status === "tested" ? "approval-card" : "",
      );
      let full = null;
      const read = button(
        "Read full revision",
        async (control, checkSession) => {
          if (full) {
            full.hidden = !full.hidden;
            control.textContent = full.hidden
              ? "Read full revision"
              : "Hide full revision";
            return;
          }
          const revision = await client.skill(skill.revisionId);
          checkSession();
          full = fullSkillView(revision);
          card.append(full);
          control.textContent = "Hide full revision";
        },
      );
      card.append(
        read,
        button("Ask red to revise", () =>
          composeDraft(
            "Please propose a revised version of skill “" +
              skill.name +
              "” (" +
              skill.revisionId +
              "). The change I want is: ",
          ),
        ),
      );
      if (skill.status === "active")
        card.append(
          button("Deactivate skill", async (_control, checkSession) => {
            if (!confirm("Deactivate skill “" + skill.name + "”?")) return;
            await client.deactivateSkill(skill.name, skill.revisionId);
            checkSession();
            await loadSkills();
            checkSession();
            notice("Skill deactivated.");
          }),
        );
      if (skill.status === "tested") {
        const current = data.skills.find(
          (item) => item.name === skill.name && item.status === "active",
        );
        card.append(
          button(
            "Activate skill",
            async (_control, checkSession) => {
              if (
                !confirm(
                  "Activate skill “" +
                    skill.name +
                    "”? Proposal-authored trigger smoke tests do not prove better performance.",
                )
              )
                return;
              await client.activateSkill(
                skill.revisionId,
                current?.revisionId ?? null,
              );
              checkSession();
              await loadSkills();
              checkSession();
              notice("Skill activated.");
            },
            "primary",
          ),
        );
      }
      $("skillPanel").append(card);
    }
  } finally {
    if (
      generation === client.generation &&
      request === ui.skillsRequest &&
      ui.inspector === "skills"
    )
      $("panelStatus").textContent = "";
  }
}
function clearPrivateView() {
  for (const id of [
    "messages",
    "beliefs",
    "commitments",
    "workJournal",
    "skillPanel",
    "revisions",
    "modelSelect",
    "inferenceErrors",
    "connectionDetails",
    "providerCards",
  ])
    $(id).replaceChildren();
  for (const id of [
    "token",
    "prompt",
    "charter",
    "source",
    "description",
    "memorySearch",
    "providerKey",
    "providerResponse",
  ])
    $(id).value = "";
  for (const id of [
    "memoryView",
    "runtimeDetails",
    "bridgeStatus",
    "panelStatus",
    "charterStatus",
    "connectStatus",
    "notice",
    "providerStatus",
    "providerFlowStatus",
    "providerPromptLabel",
    "modelBilling",
  ])
    $(id).textContent = "";
  $("providerGuide").hidden = true;
  $("sourceEditor").open = false;
  $("memoryDetails").open = false;
  $("status").textContent = "Locked";
  $("conversationSubtitle").textContent = "Private · durable memory";
  $("memory").textContent = "Durable memory";
  $("workCount").textContent = "Load when opened";
  $("sessionName").textContent = "";
  $("emptyChat").hidden = false;
  $("newMessages").hidden = true;
  $("notice").hidden = true;
}
function lock(focus = true) {
  cleanupProviderView();
  ui.providers = null;
  client.clear();
  clearInterval(ui.timer);
  clearTimeout(ui.noticeTimer);
  Object.assign(ui, {
    connected: false,
    connecting: false,
    submitting: false,
    timer: null,
    latest: null,
    companion: null,
    skills: [],
    refreshing: null,
    navOpen: false,
    inspectorOpen: false,
    charterBaseline: "",
    charterVersion: 0,
    charterDirty: false,
    charterConflict: false,
    charterSaving: false,
    charterRemote: null,
    requestId: null,
    requestText: null,
    lastSubmission: null,
    sourceBaseline: "",
    historyKey: "",
    releaseKey: "",
    failuresKey: "",
    modelDirty: false,
  });
  ui.continuityRequest++;
  ui.skillsRequest++;
  clearPrivateView();
  for (const node of document.querySelectorAll("[data-busy]")) {
    delete node.dataset.busy;
    node.disabled = false;
  }
  $("workspace").hidden = true;
  $("topActions").hidden = true;
  $("login").hidden = false;
  $("connectButton").disabled = false;
  $("connectButton").textContent = "Connect";
  syncLayout();
  updateControls();
  setError(null);
  if (focus) $("token").focus();
}
$("connect").onsubmit = (event) => {
  event.preventDefault();
  if (ui.connecting) return;
  ui.connecting = true;
  const token = $("token").value;
  const session = $("session").value;
  client.connect(token, session);
  const generation = client.generation;
  $("connectButton").disabled = true;
  $("connectButton").textContent = "Connecting…";
  $("connectStatus").textContent = "Checking owner access…";
  setError(null);
  return (async () => {
    try {
      $("sessionName").textContent = session;
      await refresh();
      assertCurrentSession(generation);
      ui.connected = true;
      $("token").value = "";
      $("login").hidden = true;
      $("workspace").hidden = false;
      $("topActions").hidden = false;
      ui.timer = setInterval(() => {
        if (ui.connected)
          refresh().catch((error) => {
            if (generation === client.generation) {
              $("status").textContent = "Connection interrupted";
              $("status").dataset.state = "offline";
              report(error, generation);
            }
          });
      }, 2500);
      updateControls();
      $("prompt").focus();
    } catch (error) {
      if (generation === client.generation) {
        lock(false);
        setError(error);
      }
    } finally {
      if (generation === client.generation) {
        ui.connecting = false;
        $("connectButton").disabled = false;
        $("connectButton").textContent = "Connect";
        $("connectStatus").textContent = "";
      }
    }
  })();
};
function promptChanged() {
  if ($("prompt").value !== ui.requestText) {
    ui.requestId = null;
    ui.requestText = null;
  }
  updateControls();
}
$("prompt").oninput = promptChanged;
$("composer").onsubmit = (event) => {
  event.preventDefault();
  const text = $("prompt").value;
  if (ui.submitting || !ui.connected || !text.trim()) return;
  ui.submitting = true;
  if (!ui.requestId || ui.requestText !== text) {
    ui.requestId = crypto.randomUUID();
    ui.requestText = text;
  }
  const id = ui.requestId;
  const generation = client.generation;
  updateControls();
  return action(async (checkSession) => {
    try {
      await client.chat(text, id);
      checkSession();
      ui.lastSubmission = text;
      if (ui.requestId === id) {
        ui.requestId = null;
        ui.requestText = null;
      }
      if ($("prompt").value === text) $("prompt").value = "";
      await refresh();
    } finally {
      if (generation === client.generation) {
        ui.submitting = false;
        updateControls();
      }
    }
  });
};
$("prompt").onkeydown = (event) => {
  if (
    event.key === "Enter" &&
    (event.ctrlKey || event.metaKey) &&
    !event.isComposing
  ) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};
$("disconnect").onclick = () => lock();
$("dismissError").onclick = () => setError(null);
$("refresh").onclick = () =>
  action(async (checkSession) => {
    await refresh();
    checkSession();
    if (
      ui.inspectorOpen &&
      ["continuity", "commitmentPanel"].includes(ui.inspector)
    ) {
      await loadContinuity();
      checkSession();
    }
    if (ui.inspectorOpen && ui.inspector === "skills") {
      await loadSkills();
      checkSession();
    }
    if (ui.inspectorOpen && ui.inspector === "connection") {
      await loadProviders();
      checkSession();
    }
    notice("Up to date.");
  }, $("refresh"));
$("abort").onclick = () =>
  action(async (checkSession) => {
    await client.abort();
    checkSession();
    await refresh();
    checkSession();
    notice("Stop requested.");
  }, $("abort"));
$("toggleNav").onclick = toggleNav;
$("closeNav").onclick = () => {
  ui.navOpen = false;
  syncLayout();
  $("toggleNav").focus();
};
$("toggleInspector").onclick = () =>
  ui.inspectorOpen ? closeInspector() : openInspector();
$("closeInspector").onclick = () => closeInspector();
$("chatTab").onclick = () => showTab("chat");
for (const [id, panel] of [
  ["workNav", "commitmentPanel"],
  ["memoryNav", "continuity"],
  ["skillsNav", "skills"],
  ["changesNav", "evolution"],
  ["connectionNav", "connection"],
  ["startCharter", "continuity"],
  ["reviewSkills", "skills"],
])
  $(id).onclick = () => openInspector(panel);
tabs.forEach((id, index) => {
  $(id).onclick = () => openInspector(panels[index], false);
  $(id).onkeydown = (event) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    return openInspector(panels[next]);
  };
});
$("memorySearch").oninput = renderBeliefs;
$("charter").oninput = setCharterStatus;
$("resetCharter").onclick = () => {
  if (
    !ui.charterDirty ||
    confirm(
      "Discard your unsaved charter draft and load the latest saved version?",
    )
  )
    adoptCharter(ui.charterRemote);
};
$("saveCharter").onclick = () => {
  if (ui.charterSaving || !ui.charterDirty || ui.charterConflict) return;
  const text = $("charter").value;
  const version = ui.charterVersion;
  const generation = client.generation;
  ui.charterSaving = true;
  updateControls();
  return action(async (checkSession) => {
    try {
      const saved = await client.changeCompanion({
        action: "charter",
        text,
        expectedVersion: version,
      });
      checkSession();
      ui.charterVersion = saved.version;
      ui.charterBaseline = saved.text;
      ui.charterRemote = saved;
      ui.charterConflict = false;
      setCharterStatus();
      notice("Charter saved.");
      // A new edit typed while saving is left in the editor.
      await loadContinuity();
    } catch (error) {
      if (
        generation === client.generation &&
        /stale charter/i.test(error?.message || "")
      ) {
        ui.charterConflict = true;
        setCharterStatus();
        await loadContinuity();
      }
      throw error;
    } finally {
      if (generation === client.generation) {
        ui.charterSaving = false;
        setCharterStatus();
      }
    }
  });
};
$("refreshProviders").onclick = () => {
  if (!ui.providers?.available) return loadProviders();
  return providerAction(async (check) => {
    await client.refreshProviders();
    check();
    await loadProviders();
    check();
    await refresh();
  });
};
$("cancelProviderKey").onclick = () => {
  ui.providerKeyId = null;
  $("providerKey").value = "";
  $("providerKeyForm").hidden = true;
};
$("providerKeyForm").onsubmit = (event) => {
  event.preventDefault();
  if (ui.providerBusy || !ui.providerKeyId) return;
  const id = ui.providerKeyId;
  let key = $("providerKey").value.trim();
  $("providerKey").value = "";
  if (!key) return;
  return providerAction(async (check) => {
    const request = client.storeProviderKey(id, key);
    key = "";
    await request;
    check();
    ui.providerKeyId = null;
    $("providerKeyForm").hidden = true;
    await loadProviders();
    check();
    await refresh();
    check();
    notice(
      "Key saved on this host. Choose a model separately to enable metered inference.",
    );
  });
};
$("cancelProviderFlow").onclick = cancelProviderSignIn;
$("providerResponseForm").onsubmit = (event) => {
  event.preventDefault();
  if (ui.providerBusy || !activeProviderFlow()) return;
  const id = ui.providerFlow.id;
  let value = $("providerResponse").value.trim();
  $("providerResponse").value = "";
  if (!value) return;
  return providerAction(async (check) => {
    const request = client.respondProviderLogin(id, value);
    value = "";
    await request;
    check();
    await loadProviders();
  });
};
$("modelSelect").onchange = () => {
  ui.modelDirty = true;
  renderModelBilling();
  updateControls();
};
$("setModel").onclick = () =>
  action(async (checkSession) => {
    const id = $("modelSelect").value;
    if (
      !id ||
      !ui.latest?.inference.models.includes(id) ||
      ui.latest.pending.length
    )
      return;
    const paid = isPaidModel(id);
    if (
      (paid || ui.latest.inference.mode === "paid-api") &&
      !confirm(
        "Use " +
          modelLabel(id) +
          "? Conversation and background memory summaries consume your existing provider credits or bill your provider account. This model choice persists for this named session until you change it. Continue?",
      )
    )
      return;
    await client.setModel(
      id,
      paid ? { confirmPaid: "USE_METERED_PROVIDER" } : {},
    );
    checkSession();
    ui.modelDirty = false;
    await refresh();
    checkSession();
    notice("Model selected.");
  }, $("setModel"));
$("loadMemory").onclick = () =>
  action(async (checkSession) => {
    const memory = await client.memory();
    checkSession();
    $("memoryView").textContent =
      typeof memory.view === "string"
        ? memory.view
        : JSON.stringify(memory.view, null, 2);
  }, $("loadMemory"));
$("proposeSkill").onclick = () =>
  composeDraft(
    "Please propose a reusable skill from our work together. Include when to use it, when not to, examples, evidence and a reviewable test. The procedure I have in mind is: ",
  );
$("loadTemplate").onclick = () =>
  action(async (checkSession) => {
    if (
      $("source").value.trim() &&
      !confirm("Replace the source draft with the starter template?")
    )
      return;
    const before = $("source").value;
    const template = await client.source();
    checkSession();
    if ($("source").value !== before) {
      notice(
        "Your source draft changed while loading. Load the starter again if you want to replace it.",
      );
      return;
    }
    $("source").value = template.source;
  }, $("loadTemplate"));
$("stage").onclick = () =>
  action(async (checkSession) => {
    if (!$("source").value.trim())
      throw Error("Add source before staging a revision.");
    const source = $("source").value;
    await client.stageRevision(
      source,
      $("description").value || "Owner-staged revision",
    );
    checkSession();
    ui.sourceBaseline = source;
    await refresh();
    checkSession();
    notice("Revision staged for review. Nothing was activated.");
  }, $("stage"));
$("newMessages").onclick = () => {
  $("chatScroll").scrollTop = $("chatScroll").scrollHeight;
  $("newMessages").hidden = true;
};
$("chatScroll").onscroll = () => {
  const scroller = $("chatScroll");
  if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100)
    $("newMessages").hidden = true;
};
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (ui.inspectorOpen) closeInspector();
  else if (ui.navOpen) {
    ui.navOpen = false;
    syncLayout();
    $("toggleNav").focus();
  }
});
window.addEventListener("resize", syncLayout);
window.addEventListener("pagehide", () => cleanupProviderView());
window.addEventListener("beforeunload", (event) => {
  if (
    ui.connected &&
    (ui.charterDirty ||
      $("prompt").value.trim() ||
      $("source").value !== ui.sourceBaseline)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
updateControls();
