// Optional real-browser UI QA against the actual loopback setup server and
// in-memory fake providers/upstream. No account, credential store, external
// provider, OAuth grant, inference or deployment is used.
//
// Run on a browser-capable host:
//   CHROMIUM_PATH=/path/to/chrome npm run test:provider-browser
// Or directly: node test/provider-browser.mjs
// macOS defaults to the standard Google Chrome application path. Linux defaults
// to /usr/bin/chromium. Chromium launch failure is a failure, never a visual pass.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright-core";
import { startSetupServer } from "../bridge/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = process.env.PROVIDER_BROWSER_ARTIFACT_DIR
  ? resolve(process.env.PROVIDER_BROWSER_ARTIFACT_DIR)
  : join(root, "artifacts", "provider-browser");
const ownerToken = "fixture-owner-" + randomUUID();
const bridgeToken = "fixture-bridge-" + randomUUID();
const session = "provider-browser-fixture";
const fakeUpstream = "http://127.0.0.1:1";
const subscriptionModel = "fixture-chatgpt-model";
const paidModel = "openrouter::fixture/model";
const safeAuthUrl =
  "https://auth.openai.com/api/accounts/authorize?state=fixture-only";
const activeStates = new Set(["starting", "waiting", "exchanging", "saving"]);

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}
async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw Error("Timed out: " + label);
    await pause(25);
  }
}
function createFixture() {
  const entries = [
    { id: "openai", name: "ChatGPT", kind: "oauth" },
    { id: "openrouter", name: "OpenRouter", kind: "api_key" },
    { id: "opencode-zen", name: "OpenCode Zen", kind: "api_key" },
    { id: "opencode-go", name: "OpenCode Go", kind: "subscription" },
  ].map((entry) => ({
    ...entry,
    connected: false,
    status: entry.id === "opencode-go" ? "disabled" : "disconnected",
    message:
      entry.id === "opencode-go"
        ? "Synthetic coding-only provider; unavailable for the shared companion harness."
        : "Not connected. Synthetic browser fixture.",
    models: [],
  }));
  const calls = {
    login: 0,
    cancel: [],
    key: 0,
    respond: 0,
    remove: 0,
    models: [],
  };
  let flow = null;
  let selected = subscriptionModel;
  const controls = {
    loginGate: null,
    keyGate: null,
    nextUrl: safeAuthUrl,
    nextPrompt: null,
  };
  const entry = (id) => {
    const found = entries.find((item) => item.id === id);
    assert.ok(found, "Unknown synthetic provider");
    return found;
  };
  const snapshot = () => {
    if (flow && activeStates.has(flow.status) && flow.expiresAt <= Date.now())
      Object.assign(flow, {
        status: "expired",
        message: "Sign-in expired. Start again when ready.",
        url: undefined,
        prompt: undefined,
      });
    return structuredClone({ providers: entries, flow });
  };
  const manager = {
    async status() {
      return snapshot();
    },
    async refresh() {
      return snapshot();
    },
    async connectKey(id, key) {
      assert.ok(["openrouter", "opencode-zen"].includes(id));
      assert.equal(key, "fixture-api-key-never-a-real-credential");
      calls.key++;
      await controls.keyGate?.promise;
      const item = entry(id);
      Object.assign(item, {
        connected: true,
        status: id === "opencode-zen" ? "unverified" : "connected",
        message: "Synthetic key stored locally. No provider request was made.",
        models: [
          {
            id: id === "openrouter" ? paidModel : "opencode-zen::fixture-model",
            name: "Synthetic metered model",
          },
        ],
      });
      return snapshot();
    },
    async startLogin(id) {
      assert.equal(id, "openai");
      assert.equal(entry(id).connected, false);
      calls.login++;
      const current = {
        id: "fixture-flow-" + calls.login,
        providerId: "openai",
        status: controls.loginGate ? "starting" : "waiting",
        expiresAt: Date.now() + 600000,
        message: "Synthetic sign-in. No external account is contacted.",
        url: controls.loginGate ? undefined : controls.nextUrl,
        prompt: controls.nextPrompt
          ? { type: "manual_code", message: controls.nextPrompt }
          : undefined,
      };
      flow = current;
      await controls.loginGate?.promise;
      if (current.status === "starting")
        Object.assign(current, { status: "waiting", url: controls.nextUrl });
      return structuredClone(current);
    },
    async cancelLogin(id) {
      calls.cancel.push(id);
      if (
        flow &&
        (id === null || id === flow.id) &&
        activeStates.has(flow.status)
      )
        Object.assign(flow, {
          status: "cancelled",
          message: "Sign-in cancelled.",
          url: undefined,
          prompt: undefined,
        });
      return snapshot();
    },
    async respondLogin(id, value) {
      assert.equal(id, flow?.id);
      assert.equal(
        value,
        "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state",
      );
      calls.respond++;
      Object.assign(entry("openai"), {
        connected: true,
        status: "connected",
        message: "Synthetic ChatGPT connection. No real sign-in occurred.",
        models: [{ id: subscriptionModel, name: "Synthetic ChatGPT model" }],
      });
      Object.assign(flow, {
        status: "connected",
        message: "Synthetic ChatGPT connected.",
        url: undefined,
        prompt: undefined,
      });
      return snapshot();
    },
    async disconnect(id) {
      calls.remove++;
      Object.assign(entry(id), {
        connected: false,
        status: "disconnected",
        message: "Synthetic local connection removed.",
        models: [],
      });
      return snapshot();
    },
  };
  const fetcher = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, fakeUpstream);
    assert.equal(options.headers.Authorization, "Bearer " + ownerToken);
    assert.equal(options.headers["X-Session"], session);
    assert.ok(
      !String(options.body || "").includes("fixture-api-key"),
      "Provider key leaked to fake upstream",
    );
    if (url.pathname === "/api/state")
      return Response.json({
        inference: {
          mode: selected.includes("::") ? "metered-bridge" : "subscription",
          models: [
            subscriptionModel,
            ...entries
              .filter((item) => item.id !== "openai")
              .flatMap((item) => item.models.map((model) => model.id)),
          ],
          selected,
          lastSeen: Date.now(),
          jobs: [],
          failures: [],
        },
        history: [],
        historyHasMore: false,
        pending: [],
        memory: { messages: 0, viewBytes: 0 },
        releases: [],
        active: null,
      });
    if (url.pathname === "/api/model") {
      const body = JSON.parse(options.body);
      if (body.id.includes("::"))
        assert.equal(body.confirmPaid, "USE_METERED_PROVIDER");
      calls.models.push(body);
      selected = body.id;
      return Response.json({ selected });
    }
    if (url.pathname === "/api/companion")
      return Response.json({
        charter: null,
        beliefs: [],
        commitments: [],
        authorization: "Synthetic evidence is not authority.",
      });
    if (url.pathname === "/api/skills")
      return Response.json({ skills: [], telemetry: {} });
    return Response.json(
      { error: "Unexpected fake upstream route" },
      { status: 404 },
    );
  };
  return {
    manager,
    fetcher,
    calls,
    controls,
    setMessage: (id, message) => {
      entry(id).message = message;
    },
    expireFlow: () => {
      assert.ok(flow);
      flow.expiresAt = Date.now() - 1;
    },
    releaseAll: () => {
      controls.keyGate?.resolve();
      controls.loginGate?.resolve();
    },
  };
}

const fixture = createFixture();
let server, browser, context, page;
const pageErrors = [],
  blockedExternal = [];
try {
  server = await startSetupServer({
    manager: fixture.manager,
    fetcher: fixture.fetcher,
    upstream: fakeUpstream,
    ownerToken,
    bridgeToken,
    session,
    port: 0,
  });
  browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "/usr/bin/chromium"),
    headless: true,
    args: ["--no-sandbox", "--disable-background-networking"],
  });
  context = await browser.newContext({
    viewport: { width: 1280, height: 960 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === server.origin) return route.continue();
    blockedExternal.push(url.origin);
    return route.abort("blockedbyclient");
  });
  page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(server.origin);
  await page.locator("#token").fill(ownerToken);
  if (!(await page.locator("#session").isVisible()))
    await page.locator("details.session-options > summary").click();
  await page.locator("#session").fill(session);
  await page.locator("#connectButton").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  assert.equal(await page.locator("#token").inputValue(), "");
  await page.locator("#toggleInspector").click();
  await page.locator("#connectionTab").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".provider-card").length === 4,
  );
  const card = (id) => page.locator('[data-provider="' + id + '"]');
  assert.equal(
    await card("opencode-go").getByRole("button").isDisabled(),
    true,
  );
  assert.match(
    await card("opencode-go").textContent(),
    /cannot isolate a Go coding session/,
  );

  fixture.setMessage(
    "openrouter",
    "Synthetic <img src=x onerror=alert(1)> provider status",
  );
  await page.locator("#refreshProviders").click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-provider="openrouter"]')
      .textContent.includes("<img src=x"),
  );
  assert.equal(await card("openrouter").locator("img").count(), 0);
  await card("openrouter")
    .getByRole("button", { name: "Connect API key", exact: true })
    .click();
  await page.locator("#providerKey").fill("fixture-unsaved-key");
  await page.locator("#cancelProviderKey").click();
  assert.equal(await page.locator("#providerKey").inputValue(), "");
  assert.equal(await page.locator("#providerKeyForm").isHidden(), true);
  assert.equal(fixture.calls.key, 0);

  fixture.controls.keyGate = deferred();
  await card("openrouter")
    .getByRole("button", { name: "Connect API key", exact: true })
    .click();
  await page
    .locator("#providerKey")
    .fill("fixture-api-key-never-a-real-credential");
  await page.locator("#saveProviderKey").click();
  await page.waitForFunction(
    () => document.querySelector("#providerKey").value === "",
  );
  await until(() => fixture.calls.key === 1, "key submission");
  await page
    .locator("#providerKeyForm")
    .evaluate((form) => form.requestSubmit());
  assert.equal(fixture.calls.key, 1);
  fixture.controls.keyGate.resolve();
  fixture.controls.keyGate = null;
  await page.locator("#providerKeyForm").waitFor({ state: "hidden" });
  await page.waitForFunction(
    (id) =>
      [...document.querySelector("#modelSelect").options].some(
        (option) => option.value === id,
      ),
    paidModel,
  );
  assert.equal(
    await page.locator("#modelSelect").inputValue(),
    subscriptionModel,
  );
  assert.equal(fixture.calls.models.length, 0);

  await page.locator("#modelSelect").selectOption(paidModel);
  let billingPrompt = "";
  page.once("dialog", async (dialog) => {
    billingPrompt = dialog.message();
    await dialog.dismiss();
  });
  await page.locator("#setModel").click();
  assert.match(billingPrompt, /Conversation and background memory summaries/);
  assert.match(billingPrompt, /persists for this named session/);
  assert.equal(fixture.calls.models.length, 0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#setModel").click();
  await until(
    () => fixture.calls.models.length === 1,
    "explicit paid model selection",
  );
  assert.deepEqual(fixture.calls.models[0], {
    id: paidModel,
    confirmPaid: "USE_METERED_PROVIDER",
  });
  await page.locator("#setModel").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => !document.querySelector("#modelSelect").disabled,
  );
  await page.locator("#modelSelect").selectOption(subscriptionModel);
  await page.locator("#setModel").click();
  await until(
    () => fixture.calls.models.length === 2,
    "return to subscription model",
  );

  fixture.controls.loginGate = deferred();
  const signIn = () =>
    card("openai").getByRole("button", {
      name: "Sign in with ChatGPT",
      exact: true,
    });
  await signIn().click();
  await until(() => fixture.calls.login === 1, "login creation");
  await signIn().dispatchEvent("click");
  assert.equal(fixture.calls.login, 1);
  await page.locator("#cancelProviderFlow").click();
  await until(
    () => fixture.calls.cancel.length > 0,
    "cancel before login ID arrives",
  );
  assert.equal(fixture.calls.cancel[0], null);
  fixture.controls.loginGate.resolve();
  fixture.controls.loginGate = null;
  await page.waitForFunction(
    () => document.querySelector("#providerAuthLink").hidden,
  );
  await page.waitForFunction(
    () => !document.querySelector('[data-provider="openai"] button').disabled,
  );
  if (await page.locator("#providerFlow").isVisible())
    await page.locator("#cancelProviderFlow").click();

  fixture.controls.nextUrl = "https://untrusted.invalid/sign-in";
  await signIn().click();
  await page.waitForFunction(() =>
    document
      .querySelector("#providerFlowStatus")
      .textContent.includes("unexpected sign-in address"),
  );
  assert.equal(
    await page.locator("#providerAuthLink").getAttribute("href"),
    null,
  );
  await page.locator("#cancelProviderFlow").click();
  await page.waitForFunction(
    () => !document.querySelector('[data-provider="openai"] button').disabled,
  );
  if (await page.locator("#providerFlow").isVisible())
    await page.locator("#cancelProviderFlow").click();

  fixture.controls.nextUrl = safeAuthUrl;
  await signIn().click();
  await page.locator("#providerAuthLink").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#providerAuthLink").getAttribute("href"),
    safeAuthUrl,
  );
  assert.equal(
    await page.locator("#providerAuthLink").getAttribute("target"),
    "_blank",
  );
  // Never click the external sign-in link. All external navigation is blocked.
  fixture.expireFlow();
  await page.waitForFunction(() =>
    /expired/i.test(document.querySelector("#providerFlowStatus").textContent),
  );
  assert.equal(await page.locator("#providerAuthLink").isHidden(), true);
  await page.locator("#cancelProviderFlow").click();

  fixture.controls.nextPrompt =
    "Synthetic <img src=x> callback URL; no account is contacted";
  await signIn().click();
  await page.locator("#providerResponseForm").waitFor({ state: "visible" });
  assert.equal(await page.locator("#providerPromptLabel img").count(), 0);
  await page
    .locator("#providerResponse")
    .fill(
      "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state",
    );
  await page.locator("#submitProviderResponse").click();
  await page.waitForFunction(
    () => document.querySelector("#providerResponse").value === "",
  );
  await until(() => fixture.calls.respond === 1, "synthetic OAuth response");
  await page.waitForFunction(
    () =>
      document.querySelector('[data-provider="openai"] .provider-badge')
        .textContent === "Connected",
  );
  assert.equal(await signIn().count(), 0);
  assert.equal(
    await page.locator("#providerAuthLink").getAttribute("href"),
    null,
  );

  await mkdir(artifacts, { recursive: true });
  await page.locator(".inspector-body").evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.screenshot({
    path: join(artifacts, "providers-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".inspector-body").evaluate((node) => {
    node.scrollTop = 0;
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "Mobile horizontal overflow",
  );
  assert.equal(
    await page.locator("#chat").evaluate((node) => node.inert),
    true,
  );
  await page.screenshot({
    path: join(artifacts, "providers-mobile.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#inspector").isHidden(), true);
  assert.equal(
    await page.locator("#chat").evaluate((node) => node.inert),
    false,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "toggleInspector",
  );
  await page.locator("#toggleInspector").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".provider-card").length === 4,
  );

  let removalPrompt = "";
  page.once("dialog", async (dialog) => {
    removalPrompt = dialog.message();
    await dialog.accept();
  });
  await card("openai")
    .getByRole("button", { name: "Remove local connection", exact: true })
    .click();
  await until(() => fixture.calls.remove === 1, "local credential removal");
  assert.match(removalPrompt, /does not revoke the OAuth grant/);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-provider="openai"] .provider-badge')
        .textContent === "Not connected",
  );

  await card("opencode-zen")
    .getByRole("button", { name: "Connect API key", exact: true })
    .click();
  await page.locator("#providerKey").fill("fixture-unsaved-key-at-lock");
  await page.locator("#disconnect").click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(await page.locator("#providerKey").inputValue(), "");
  assert.equal(await page.locator("#providerResponse").inputValue(), "");
  assert.equal(await page.locator("#providerCards").textContent(), "");
  assert.equal(
    await page.locator("#providerAuthLink").getAttribute("href"),
    null,
  );
  assert.deepEqual(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    })),
    { local: 0, session: 0, databases: 0, caches: 0 },
  );
  assert.deepEqual(await context.cookies(), []);
  assert.deepEqual(
    blockedExternal,
    [],
    "Unexpected external browser request was blocked",
  );
  assert.deepEqual(pageErrors, [], "Browser script errors");
  console.log(
    "PASS provider browser fixtures: cards, literal status, key clearing/cancel, metered approval, interrupted/expired OAuth, local removal, mobile navigation, lock and empty browser storage.",
  );
  console.log("Screenshots: " + artifacts);
  console.log(
    "Fake providers only. No live account access, provider request, grant, credential storage or inference was tested.",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await mkdir(artifacts, { recursive: true });
    await page
      .screenshot({
        path: join(artifacts, "providers-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  fixture.releaseAll();
  try {
    await context?.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      await server?.close();
    }
  }
}
