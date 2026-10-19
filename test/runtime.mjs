// Real workerd smoke test. No model credential, Cloudflare login, or deployment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("..", import.meta.url).pathname;
const temp = await mkdtemp(join(tmpdir(), "red-runtime-"));
const token = "test-owner-" + crypto.randomUUID();
const port = Number(process.env.TEST_PORT || 8791);
const base = `http://127.0.0.1:${port}`;
const session = "runtime-" + crypto.randomUUID();
let child,
  logs = "";
let bridgeEnabled = false,
  discordEnabled = false;
const bridgeToken = "test-bridge-" + crypto.randomUUID();
const discordToken = "test-discord-" + crypto.randomUUID();
const discordBinding = {
  guildId: "111111111111111111",
  channelId: "222222222222222222",
  ownerId: "333333333333333333",
  botId: "444444444444444444",
};
const env = {
  ...process.env,
  HOME: temp,
  XDG_CONFIG_HOME: temp,
  WRANGLER_SEND_METRICS: "false",
};
if (process.env.TEST_LOOPBACK_ONLY === "true") {
  const shim = join(temp, "loopback.cjs");
  await writeFile(
    shim,
    `const os=require('node:os');os.networkInterfaces=()=>({lo:[{address:'127.0.0.1',netmask:'255.0.0.0',family:'IPv4',mac:'00:00:00:00:00:00',internal:true,cidr:'127.0.0.1/8'}]});require('node:module').syncBuiltinESMExports();`,
  );
  env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --require=${shim}`;
}
async function start() {
  logs = "";
  child = spawn(
    process.execPath,
    [
      "node_modules/wrangler/bin/wrangler.js",
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--var",
      `OWNER_TOKEN:${token}`,
      "--persist-to",
      join(temp, "state"),
      ...(bridgeEnabled ? ["--var", `BRIDGE_TOKEN:${bridgeToken}`] : []),
      ...(discordEnabled
        ? Object.entries({
            DISCORD_ENABLED: "true",
            DISCORD_RELAY_TOKEN: discordToken,
            DISCORD_GUILD_ID: discordBinding.guildId,
            DISCORD_CHANNEL_ID: discordBinding.channelId,
            DISCORD_OWNER_ID: discordBinding.ownerId,
            DISCORD_BOT_ID: discordBinding.botId,
            DISCORD_SESSION: session,
          }).flatMap(([key, value]) => ["--var", `${key}:${value}`])
        : []),
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  child.stdout.on("data", (b) => {
    logs += b;
  });
  child.stderr.on("data", (b) => {
    logs += b;
  });
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error(`workerd exited ${child.exitCode}\n${logs}`);
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("workerd startup timeout\n" + logs);
}
async function stop() {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
  child = undefined;
}
async function api(path, data, options = {}) {
  const r = await fetch(base + "/api/" + path, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Session": session,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await r.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  if (options.status !== undefined)
    assert.equal(r.status, options.status, JSON.stringify(value));
  else assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(value)}`);
  return value;
}
try {
  await start();
  console.log("PASS real workerd starts");
  assert.equal((await fetch(base + "/api/state")).status, 401);
  assert.equal((await fetch(base + "/api/companion/event?id=1")).status, 401);
  await api("state", undefined, {
    status: 401,
    headers: { Origin: "https://attacker.invalid" },
  });
  console.log("PASS absent credentials and cross-origin access denied");
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.match(await page.text(), /red/i);
  console.log("PASS private app shell and CSP");
  const initial = await api("state");
  assert.equal(initial.active, null);
  await api("chat", { id: "no-model", text: "hello" }, { status: 503 });
  console.log("PASS no implicit paid inference");
  const template = (await api("source")).source;
  const a = await api("revisions", {
    source: template,
    description: "Smoke revision A",
  });
  const repeat = await api("revisions", {
    source: template,
    description: "Same source",
  });
  assert.equal(a.id, repeat.id);
  await api(
    "activate",
    { id: a.id, expectedActiveRevisionId: null, confirm: "ACTIVATE" },
    { status: 400 },
  );
  await api("test", { id: a.id });
  await api("activate", {
    id: a.id,
    expectedActiveRevisionId: null,
    confirm: "ACTIVATE",
  });
  assert.equal(
    (await api("behavior", { name: "counter_increment", args: { amount: 7 } }))
      .value,
    7,
  );
  const b = await api("revisions", {
    source: template.replace(
      "persistent behavior counter",
      "durable behavior counter",
    ),
    description: "Smoke revision B",
  });
  await api("test", { id: b.id });
  await api("activate", {
    id: b.id,
    expectedActiveRevisionId: a.id,
    confirm: "ACTIVATE",
  });
  assert.equal(
    (await api("behavior", { name: "counter_get", args: {} })).value,
    7,
  );
  await api(
    "activate",
    { id: a.id, expectedActiveRevisionId: a.id, confirm: "ACTIVATE" },
    { status: 400 },
  );
  await api("activate", {
    id: a.id,
    expectedActiveRevisionId: b.id,
    confirm: "ACTIVATE",
  });
  assert.equal(
    (await api("behavior", { name: "counter_get", args: {} })).value,
    7,
  );
  console.log(
    "PASS real facet stage, validate, promote, stale approval rejection, rollback, preserved SQLite",
  );
  const code = await api("codemode", {
    code: "async () => { return await self.list({}); }",
  });
  assert.ok(JSON.stringify(code).includes(a.id), JSON.stringify(code));
  console.log("PASS real Code Mode connector access");
  const denied = await api("codemode", {
    code: 'async () => { try { await fetch("https://example.com/"); return "NETWORK_ALLOWED"; } catch { return "NETWORK_BLOCKED"; } }',
  });
  assert.ok(
    JSON.stringify(denied).includes("NETWORK_BLOCKED"),
    JSON.stringify(denied),
  );
  console.log("PASS Code Mode ambient network denied");
  assert.equal((await api("autonomy")).explorationEnabled, false);
  assert.equal((await api("autonomy")).stopped, true);
  assert.equal((await fetch(base + "/api/autonomy")).status, 401);
  await api(
    "autonomy/stop",
    {},
    { status: 401, headers: { Origin: "https://attacker.invalid" } },
  );
  const configureBootstrap = async (revisionId, maxAttempts = 1) => {
    const current = await api("autonomy");
    return api("autonomy/configure", {
      expectedVersion: current.version,
      confirm: "CONFIGURE_BOOTSTRAP",
      policy: {
        revisionId,
        sandbox: "disposable-candidate-v1",
        maxAttempts,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        paidInferenceBudgetUsd: 0,
        externalAccess: false,
      },
    });
  };
  let bootstrap = await configureBootstrap(a.id);
  assert.equal(bootstrap.stopped, true);
  await api(
    "autonomy/start",
    { expectedVersion: bootstrap.version - 1, confirm: "START_BOOTSTRAP" },
    { status: 409 },
  );
  bootstrap = await api("autonomy/start", {
    expectedVersion: bootstrap.version,
    confirm: "START_BOOTSTRAP",
  });
  const request = {
    id: "bootstrap-one",
    revisionId: a.id,
    policyVersion: bootstrap.policyVersion,
  };
  bootstrap = await api("autonomy/validate", request);
  assert.equal(bootstrap.attempts[0].status, "passed");
  assert.equal((await api("autonomy/validate", request)).reservedAttempts, 1);
  await api(
    "autonomy/validate",
    { ...request, id: "bootstrap-two" },
    { status: 409 },
  );
  assert.equal(bootstrap.paidInferenceRequests, 0);
  assert.equal(bootstrap.externalRequests, 0);
  const slow = await api("revisions", {
    source: template.replace(
      "if (path === '/health') return",
      "if (path === '/health') await new Promise(resolve => setTimeout(resolve, 4000)); if (path === '/health') return",
    ),
    description: "Synthetic slow bootstrap stop fixture",
  });
  bootstrap = await configureBootstrap(slow.id, 2);
  bootstrap = await api("autonomy/start", {
    expectedVersion: bootstrap.version,
    confirm: "START_BOOTSTRAP",
  });
  const slowRun = api("autonomy/validate", {
    id: "slow-bootstrap",
    revisionId: slow.id,
    policyVersion: bootstrap.policyVersion,
  });
  for (let i = 0; i < 100; i++) {
    if ((await api("autonomy")).attempts.some((a) => a.status === "running"))
      break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await api("autonomy")).attempts[0].status, "running");
  const stopped = await api("autonomy/stop", {});
  assert.equal(stopped.stopped, true);
  assert.equal((await slowRun).attempts[0].status, "stopped");
  assert.equal((await api("autonomy/stop", {})).version, stopped.version);
  assert.equal((await api("state")).active.revisionId, a.id);
  assert.equal(
    (await api("autonomy/history")).events.some(
      (e) => e.event === "owner-stopped-bootstrap",
    ),
    true,
  );
  console.log(
    "PASS owner-only bounded bootstrap, exact quota, idempotency and in-flight facet stop; no inference or promotion",
  );
  await stop();
  await start();
  assert.equal((await api("autonomy")).stopped, true);
  assert.equal((await api("autonomy")).attempts[0].status, "stopped");
  assert.equal((await api("autonomy")).explorationRunning, false);
  console.log(
    "PASS bootstrap policy, stop latch and attempt history survive real runtime restart",
  );
  assert.equal((await api("state")).active.revisionId, a.id);
  assert.equal(
    (await api("behavior", { name: "counter_get", args: {} })).value,
    7,
  );
  console.log("PASS state and active revision survive runtime restart");
  await stop();
  bridgeEnabled = true;
  await start();
  const bridge = (path, data) =>
    api("bridge/" + path, data, {
      headers: { Authorization: `Bearer ${bridgeToken}` },
    });
  await api("state", undefined, {
    status: 401,
    headers: { Authorization: `Bearer ${bridgeToken}` },
  });
  await api(
    "autonomy/stop",
    {},
    { status: 401, headers: { Authorization: `Bearer ${bridgeToken}` } },
  );
  await api(
    "autonomy/configure",
    {},
    { status: 401, headers: { Authorization: `Bearer ${bridgeToken}` } },
  );
  await api("bridge/poll", { modelIds: ["gpt-4.1-mini"] }, { status: 401 });
  await bridge("poll", {
    modelIds: ["gpt-4.1-mini", "openrouter::fixture/model"],
  });
  const providerSetup = await api("providers");
  assert.equal(providerSetup.available, false);
  await api(
    "providers/key",
    {
      providerId: "openrouter",
      apiKey: "fixture-never-real",
      confirm: "STORE_METERED_KEY",
    },
    { status: 409 },
  );
  await api("providers", undefined, {
    status: 401,
    headers: { Authorization: `Bearer ${bridgeToken}` },
  });
  await api("model", { id: "openrouter::fixture/model" }, { status: 400 });
  await api("model", {
    id: "openrouter::fixture/model",
    confirmPaid: "USE_METERED_PROVIDER",
  });
  const paidState = await api("state");
  assert.equal(paidState.inference.mode, "metered-bridge");
  assert.equal(paidState.inference.providerId, "openrouter");
  assert.equal(paidState.inference.selected, "openrouter::fixture/model");
  await api("model", { id: "opencode-go::fixture" }, { status: 400 });
  await bridge("poll", { modelIds: ["gpt-4.1-mini"] });
  await api("model", { id: "gpt-4.1-mini" });
  console.log(
    "PASS provider credential isolation, explicit metered selection and coding-only exclusion",
  );
  const text =
    "Remember our lighthouse project. Inspect your source revisions before answering.";
  await api("chat", { id: "bridge-roundtrip", text }, { status: 202 });
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let cacheNamespace;
  const assertCacheJob = (job) => {
    assert.equal(job.cache.version, 1);
    assert.match(job.cache.namespace, /^[0-9a-f-]{36}$/);
    cacheNamespace ??= job.cache.namespace;
    assert.equal(job.cache.namespace, cacheNamespace);
    assert.equal(job.cache.purpose, job.summary ? "summary" : "conversation");
    const sections = Object.keys(job.context.messages[0].sections ?? {});
    if (job.summary) assert.ok(sections.includes("red_compact"));
    else {
      assert.ok(sections.indexOf("red") >= 0);
      assert.ok(sections.indexOf("red_archive") > sections.indexOf("red"));
      assert.ok(
        sections.indexOf("red_volatile") > sections.indexOf("red_archive"),
      );
    }
  };
  let usedTool = false,
    completed = false;
  for (let i = 0; i < 120; i++) {
    const { job } = await bridge("poll", { modelIds: ["gpt-4.1-mini"] });
    if (job) {
      assertCacheJob(job);
      const isSummary = job.summary === true;
      const tool = !isSummary && !usedTool;
      if (tool) usedTool = true;
      const message = {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: job.modelId,
        usage: tool
          ? {
              ...zero,
              input: 30,
              output: 5,
              cacheRead: 60,
              cacheWrite: 10,
              totalTokens: 105,
            }
          : zero,
        timestamp: Date.now(),
        stopReason: tool ? "toolUse" : "stop",
        content: tool
          ? [
              {
                type: "toolCall",
                id: "runtime-tool-1",
                name: "codemode",
                arguments: { code: "async () => await self.list({})" },
              },
            ]
          : [
              {
                type: "text",
                text: isSummary
                  ? "user requested lighthouse project; assistant inspected source revisions."
                  : "I inspected my revisions and remember the lighthouse project.",
              },
            ],
      };
      await bridge("result", {
        jobId: job.id,
        leaseToken: job.leaseToken,
        message,
      });
    }
    const state = await api("state");
    if (
      !state.pending.length &&
      JSON.stringify(state.history).includes("I inspected my revisions")
    ) {
      completed = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(completed, "Mock subscription turn did not complete");
  assert.ok(usedTool);
  const cacheMetrics = (await api("skills")).telemetry.metrics;
  assert.equal(cacheMetrics.cacheReadTokens, 60);
  assert.equal(cacheMetrics.cacheWriteTokens, 10);
  console.log(
    "PASS stable prompt sections, durable cache identity and synthetic cache-token telemetry",
  );
  const historyBefore = (await api("state")).history;
  await api("chat", { id: "bridge-roundtrip", text }, { status: 202 });
  await api(
    "chat",
    { id: "bridge-roundtrip", text: "different" },
    { status: 400 },
  );
  assert.equal(
    (await api("state")).history.filter((m) => m.kind === "user").length,
    historyBefore.filter((m) => m.kind === "user").length,
  );
  console.log(
    "PASS real Pi deferred subscription → Code Mode tool → assistant, credential separation and input idempotency",
  );
  await stop();
  await start();
  const restored = await api("state");
  assert.ok(JSON.stringify(restored.history).includes("lighthouse project"));
  console.log(
    "PASS companion conversation and archive survive runtime restart (mock inference only)",
  );
  const codeCall = async (code) => {
    const r = await api("codemode", { code });
    assert.equal(r.status, "completed", JSON.stringify(r));
    return r.result;
  };
  const evidence = await codeCall(
    'async () => await learning.observe({text:"Project lighthouse needs a release checklist.",source:"owner"})',
  );
  assert.equal(evidence.source, "assistant");
  const belief = await codeCall(
    `async () => await learning.belief_propose(${JSON.stringify({ kind: "hypothesis", text: "The lighthouse project needs a release checklist.", scope: "project", confidence: 0.7, sourceEventIds: [evidence.id] })})`,
  );
  const commitment = await codeCall(
    `async () => await learning.commitment_propose(${JSON.stringify({ text: "Draft the lighthouse release checklist.", scope: "project", sourceEventIds: [evidence.id] })})`,
  );
  assert.equal(belief.status, "proposed");
  assert.equal(commitment.status, "proposed");
  await api("companion", { action: "accept-belief", id: belief.id });
  await api("companion", { action: "accept-commitment", id: commitment.id });
  await api("companion", {
    action: "charter",
    text: "Be curious, candid, and evidence-driven.",
    expectedVersion: 0,
  });
  const event2 = await codeCall(
    'async () => await learning.observe({text:"Correction: checklist is for the harbor project."})',
  );
  const corrected = await codeCall(
    `async () => await learning.belief_propose(${JSON.stringify({ kind: "hypothesis", text: "The harbor project needs a release checklist.", scope: "project", confidence: 0.8, sourceEventIds: [event2.id], supersedes: belief.id })})`,
  );
  await api("companion", { action: "accept-belief", id: corrected.id });
  const continuity = await api("companion");
  assert.equal(
    continuity.beliefs.find((b) => b.id === belief.id).status,
    "superseded",
  );
  assert.equal(
    continuity.commitments.find((c) => c.id === commitment.id).status,
    "open",
  );
  assert.equal(continuity.charter.version, 1);
  const workEntry = continuity.journal.entries.find(
    (e) => e.commitmentId === commitment.id && e.status === "open",
  );
  assert.ok(workEntry);
  const journalSource = await api(
    `companion/event?id=${workEntry.evidenceEventIds[0]}`,
  );
  assert.equal(journalSource.source, "owner");
  await api(
    `companion/event?id=${workEntry.evidenceEventIds[0]}&offset=-1`,
    undefined,
    { status: 400 },
  );
  await api("companion/event?id=0", undefined, { status: 400 });
  assert.equal(JSON.parse(journalSource.text).action, "accept-commitment");
  assert.match(continuity.journal.notice, /not independently verified/);
  console.log(
    "PASS real continuity proposals, attribution, owner acceptance, correction lineage, and charter",
  );
  const telem = await codeCall(
    "async () => await learning.telemetry({limit:10})",
  );
  assert.ok(telem.events.length);
  const proposal = {
    name: "verify-sources",
    description:
      "Use when asked to verify a source. Avoid when casual chat needs no verification.",
    whenToUse: ["Verifying a factual source"],
    whenNotToUse: ["Casual conversation"],
    instructions: "Retrieve the original source and preserve attribution.",
    useExamples: ["verify source"],
    avoidExamples: ["casual chat"],
    evidenceRunIds: [telem.events[0].runId],
    sources: ["https://developers.cloudflare.com/agents/harnesses/pi/"],
    trigger: { any: ["verify source"], none: ["casual chat"] },
    cases: [
      { text: "please verify source", expected: true },
      { text: "casual chat", expected: false },
    ],
  };
  const skill = await codeCall(
    `async () => await learning.skill_propose(${JSON.stringify(proposal)})`,
  );
  const evaluation = await codeCall(
    `async () => await learning.skill_evaluate({id:${JSON.stringify(skill.revisionId)}})`,
  );
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.independentEvidence, false);
  await api("skills/activate", {
    id: skill.revisionId,
    expectedActiveRevisionId: null,
    confirm: "ACTIVATE",
  });
  assert.equal(
    (await api("skills")).skills.find((s) => s.revisionId === skill.revisionId)
      .status,
    "active",
  );
  const docs = await codeCall("async () => await learning.docs_list({})");
  assert.ok(docs.length);
  console.log(
    "PASS own telemetry, pinned docs, evidence-led skill proposal, routing smoke evaluation, owner activation",
  );
  await stop();
  await start();
  assert.equal(
    (await api("companion")).commitments.find((c) => c.id === commitment.id)
      .status,
    "open",
  );
  assert.equal(
    (await api("skills")).skills.find((s) => s.revisionId === skill.revisionId)
      .status,
    "active",
  );
  console.log(
    "PASS charter, commitments, corrected beliefs, and skills survive restart",
  );
  assert.deepEqual((await api("companion")).journal, continuity.journal);
  assert.deepEqual(
    await api(`companion/event?id=${workEntry.evidenceEventIds[0]}`),
    journalSource,
  );
  console.log(
    "PASS source-linked work journal and evidence survive real runtime restart",
  );
  // Discord fixtures use fake relay credentials, event IDs and model responses.
  // No connection is made to Discord, OpenAI or a real subscription account.
  const discord = (path, data, options = {}) =>
    api("discord/" + path, data, {
      ...options,
      headers: {
        Authorization: `Bearer ${discordToken}`,
        ...options.headers,
      },
    });
  const discordEvent = {
    id: "555555555555555555",
    guild_id: discordBinding.guildId,
    channel_id: discordBinding.channelId,
    author: { id: discordBinding.ownerId, bot: false },
    type: 0,
    content:
      "Synthetic private Discord request: inspect your source revisions.",
    attachments: [],
  };
  for (const path of ["message", "poll", "ack", "retry"])
    await discord(path, {}, { status: 404 });
  console.log("PASS disabled Discord routes expose no transport availability");
  await stop();
  discordEnabled = true;
  await start();
  const relayHeaders = { Authorization: `Bearer ${discordToken}` };
  for (const path of [
    "state",
    "chat",
    "abort",
    "activate",
    "codemode",
    "companion",
    "skills/activate",
    "bridge/poll",
    "bridge/result",
  ])
    await api(path, path === "state" ? undefined : {}, {
      status: 401,
      headers: relayHeaders,
    });
  for (const credential of [token, bridgeToken])
    await discord(
      "poll",
      {},
      {
        status: 401,
        headers: { Authorization: `Bearer ${credential}` },
      },
    );
  await discord(
    "poll",
    {},
    {
      status: 401,
      headers: { "X-Session": session + "-other" },
    },
  );
  await discord(
    "poll",
    {},
    {
      status: 401,
      headers: { Origin: "https://attacker.invalid" },
    },
  );
  await discord("poll", undefined, { status: 404 });
  assert.equal((await discord("poll", {})).delivery, null);
  assert.deepEqual((await api("state")).discord.inbox, []);
  console.log(
    "PASS fixed Discord session and owner/bridge/relay credential isolation",
  );
  for (const invalid of [
    { id: "not-a-snowflake" },
    { guild_id: "666666666666666666" },
    { channel_id: "666666666666666666" },
    { author: { id: "666666666666666666", bot: false } },
    { author: { id: discordBinding.ownerId, bot: true } },
    { author: { id: discordBinding.botId, bot: true } },
    { webhook_id: "666666666666666666" },
    { type: 7 },
    { type: "0" },
  ])
    await discord("message", { ...discordEvent, ...invalid }, { status: 403 });
  for (const invalid of [
    { content: "" },
    { content: "x".repeat(32001) },
    { content: 123 },
    { attachments: {} },
    { attachments: Array.from({ length: 11 }, () => ({})) },
  ])
    await discord("message", { ...discordEvent, ...invalid }, { status: 400 });
  assert.deepEqual((await api("state")).discord.inbox, []);
  console.log(
    "PASS Discord owner/channel binding, bot/webhook/type and malformed-content rejection",
  );
  const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
  const isSummary = (job) => job.summary === true;
  const respond = (job, reply, tool = false) =>
    bridge("result", {
      jobId: job.id,
      leaseToken: job.leaseToken,
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: job.modelId,
        usage: zero,
        timestamp: Date.now(),
        stopReason: tool ? "toolUse" : "stop",
        content: [
          { type: "text", text: reply },
          ...(tool
            ? [
                {
                  type: "toolCall",
                  id: "runtime-discord-tool",
                  name: "codemode",
                  arguments: { code: "async () => await self.list({})" },
                },
              ]
            : []),
        ],
      },
    });
  const pollInference = async () => {
    const { job } = await bridge("poll", { modelIds: ["gpt-4.1-mini"] });
    if (job) assertCacheJob(job);
    if (job && isSummary(job)) {
      await respond(
        job,
        "Synthetic archive summary for runtime transport isolation.",
      );
      return null;
    }
    return job;
  };
  const nextInference = async (label) => {
    for (let i = 0; i < 240; i++) {
      const job = await pollInference();
      if (job) return job;
      await pause();
    }
    throw new Error(`Timed out waiting for ${label} inference`);
  };
  const browserOnly = "SYNTHETIC_BROWSER_REPLY_MUST_NEVER_REACH_DISCORD";
  await api(
    "chat",
    {
      id: "browser-before-discord",
      text: "Synthetic unrelated browser request before Discord.",
    },
    { status: 202 },
  );
  const browserJob = await nextInference("browser before Discord");
  assert.ok(
    JSON.stringify(browserJob.context).includes(
      "Synthetic unrelated browser request before Discord.",
    ),
  );
  const ingress = await discord("message", discordEvent, { status: 202 });
  assert.equal(ingress.duplicate, false);
  assert.equal(
    (
      await discord(
        "message",
        {
          ...discordEvent,
          type: 19,
          author: { id: discordBinding.ownerId },
        },
        { status: 202 },
      )
    ).duplicate,
    true,
  );
  assert.equal(
    (await discord("message", discordEvent, { status: 202 })).duplicate,
    true,
  );
  await discord(
    "message",
    { ...discordEvent, content: "Conflicting duplicate" },
    { status: 409 },
  );
  assert.deepEqual((await api("state")).discord.inbox, [
    { state: "queued", count: 1 },
  ]);
  assert.equal((await discord("poll", {})).delivery, null);
  await stop();
  await start();
  const durableIngress = await discord("message", discordEvent, {
    status: 202,
  });
  assert.equal(durableIngress.duplicate, true);
  assert.equal(durableIngress.state, "queued");
  assert.equal((await discord("poll", {})).delivery, null);
  assert.equal(
    await pollInference(),
    null,
    "Busy browser inference must not admit Discord",
  );
  await respond(browserJob, browserOnly);
  console.log(
    "PASS Discord inbox survives restart and duplicate/conflicting admission while browser inference is busy",
  );
  const discordJob = await nextInference("queued Discord");
  assert.ok(JSON.stringify(discordJob.context).includes(discordEvent.content));
  const blockedSteer = "SYNTHETIC_BROWSER_STEER_MUST_NOT_ENTER_DISCORD_TURN";
  await api(
    "chat",
    { id: "browser-during-discord", text: blockedSteer },
    { status: 409 },
  );
  assert.equal(
    (await discord("poll", {})).delivery,
    null,
    "Prior browser replies must not enter the Discord outbox",
  );
  const toolProgress = "SYNTHETIC_TOOL_PROGRESS_MUST_NOT_REACH_DISCORD";
  await respond(discordJob, toolProgress, true);
  const discordFinalJob = await nextInference(
    "Discord after real Code Mode tool",
  );
  assert.ok(
    JSON.stringify(discordFinalJob.context).includes("runtime-discord-tool"),
  );
  assert.ok(!JSON.stringify(discordFinalJob.context).includes(blockedSteer));
  assert.equal(
    (await discord("poll", {})).delivery,
    null,
    "Tool-progress text is not a final Discord reply",
  );
  const discordReply =
    "Synthetic final Discord reply @everyone <@333333333333333333>.";
  await respond(discordFinalJob, discordReply);
  let delivery;
  for (let i = 0; i < 240; i++) {
    assert.equal(
      await pollInference(),
      null,
      "Unexpected additional conversational inference",
    );
    delivery = (await discord("poll", {})).delivery;
    if (delivery) break;
    await pause();
  }
  assert.ok(delivery, "Final Discord reply did not reach the durable outbox");
  assert.equal(delivery.content, discordReply.replace(/@/g, "@\u200b"));
  assert.equal(delivery.replyToMessageId, discordEvent.id);
  assert.equal(delivery.channelId, discordBinding.channelId);
  assert.ok(delivery.leaseToken);
  assert.ok(delivery.nonce);
  assert.ok(!delivery.content.includes(browserOnly));
  assert.ok(!delivery.content.includes(toolProgress));
  console.log(
    "PASS real Pi Discord → Code Mode → final outbox, safe mentions, no browser or tool-progress leakage",
  );
  const receipt = {
    id: delivery.id,
    leaseToken: delivery.leaseToken,
    messageId: "777777777777777777",
  };
  await discord(
    "ack",
    { ...receipt, leaseToken: "stale-lease" },
    { status: 409 },
  );
  await discord(
    "ack",
    { ...receipt, messageId: "unsafe/message-id" },
    { status: 400 },
  );
  assert.equal(
    (await discord("poll", {})).delivery,
    null,
    "Delivery lease is exclusive",
  );
  assert.equal(
    (
      await discord("retry", {
        id: delivery.id,
        leaseToken: delivery.leaseToken,
        kind: "transient",
        retryAfterMs: 1000,
      })
    ).state,
    "queued",
  );
  await discord("ack", receipt, { status: 409 });
  await stop();
  await start();
  const redelivery = (await discord("poll", {})).delivery;
  assert.ok(redelivery, "Retried outbox delivery must survive restart");
  assert.equal(redelivery.id, delivery.id);
  assert.equal(redelivery.nonce, delivery.nonce);
  assert.equal(redelivery.content, delivery.content);
  assert.notEqual(redelivery.leaseToken, delivery.leaseToken);
  await discord("ack", receipt, { status: 409 });
  const freshReceipt = { ...receipt, leaseToken: redelivery.leaseToken };
  assert.equal((await discord("ack", freshReceipt)).accepted, true);
  assert.equal((await discord("ack", freshReceipt)).accepted, false);
  await discord(
    "ack",
    { ...freshReceipt, messageId: "888888888888888888" },
    { status: 409 },
  );
  assert.equal(
    (await discord("message", discordEvent, { status: 202 })).duplicate,
    true,
  );
  assert.equal((await discord("poll", {})).delivery, null);
  console.log(
    "PASS durable Discord retry, stable nonce, stale-lease rejection and idempotent safe delivery acknowledgement",
  );
  await api(
    "chat",
    {
      id: "browser-after-discord",
      text: "Synthetic unrelated browser request after Discord.",
    },
    { status: 202 },
  );
  const afterJob = await nextInference("browser after Discord");
  assert.ok(
    JSON.stringify(afterJob.context).includes(
      "Synthetic unrelated browser request after Discord.",
    ),
  );
  await respond(
    afterJob,
    "SYNTHETIC_LATER_BROWSER_REPLY_MUST_NOT_REACH_DISCORD",
  );
  let browserFinished = false;
  for (let i = 0; i < 240; i++) {
    assert.equal(await pollInference(), null);
    assert.equal((await discord("poll", {})).delivery, null);
    const state = await api("state");
    if (!state.pending.length) {
      assert.deepEqual(state.discord.inbox, [{ state: "done", count: 1 }]);
      assert.deepEqual(state.discord.outbox, [{ state: "sent", count: 1 }]);
      assert.ok(!JSON.stringify(state.history).includes(blockedSteer));
      browserFinished = true;
      break;
    }
    await pause();
  }
  assert.ok(browserFinished, "Unrelated browser turn did not finish");
  console.log(
    "PASS completed Discord input produces one reply; later browser turns stay out of its outbox",
  );
  if (process.env.TEST_BROWSER === "true") {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      headless: true,
      args: ["--no-sandbox", "--disable-background-networking"],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 900 },
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.route("**/*", (r) =>
        new URL(r.request().url()).hostname === "127.0.0.1"
          ? r.continue()
          : r.abort(),
      );
      await page.goto(base);
      await page.fill("#token", token);
      if (!(await page.locator("#session").isVisible()))
        await page.locator("details.session-options > summary").click();
      await page.waitForSelector("#session", { state: "visible" });
      await page.fill("#session", session);
      await page.click("#connect button");
      await page.waitForSelector("#workspace:not([hidden])");
      await page.click("#toggleInspector");
      await page.click("#continuityTab");
      await page.waitForFunction(() =>
        document
          .querySelector("#commitments")
          .textContent.includes("lighthouse"),
      );
      assert.match(await page.inputValue("#charter"), /curious/);
      await page.click("#commitmentsTab");
      await page.waitForSelector("#workJournal article");
      const journalEvidence = page.locator("#workJournal details").first();
      await journalEvidence.locator("summary").click();
      await journalEvidence.locator("button").first().click();
      await journalEvidence.locator("pre").waitFor();
      assert.match(await page.textContent("#workJournal"), /owner-action:/);
      await mkdir(join(root, "artifacts"), { recursive: true });
      await page.screenshot({
        path: join(root, "artifacts/ui-work-journal.png"),
        fullPage: true,
      });
      await page.click("#releasesTab");
      await page.waitForFunction(() =>
        document
          .querySelector("#skillPanel")
          .textContent.includes("verify-sources"),
      );
      await page.click("#continuityTab");
      await page.fill("#charter", "A synthetic unsaved charter draft.");
      await page.click("#skillsTab");
      await page.click("#continuityTab");
      assert.equal(
        await page.inputValue("#charter"),
        "A synthetic unsaved charter draft.",
      );
      page.once("dialog", (dialog) => dialog.accept());
      await page.click("#resetCharter");
      await page.click("#toggleNav");
      await mkdir(join(root, "artifacts"), { recursive: true });
      await page.screenshot({
        path: join(root, "artifacts/ui-desktop.png"),
        fullPage: true,
      });
      await page.click("#closeNav");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click("#closeInspector");
      await page.screenshot({
        path: join(root, "artifacts/ui-mobile.png"),
        fullPage: true,
      });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        "Mobile horizontal overflow",
      );
      await page.click("#toggleInspector");
      assert.equal(
        await page.getAttribute("#toggleInspector", "aria-expanded"),
        "true",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await page.getAttribute("#toggleInspector", "aria-expanded"),
        "false",
      );
      await page.click("#disconnect");
      await page.waitForSelector("#login:not([hidden])");
      assert.equal(await page.textContent("#messages"), "");
      assert.equal(await page.textContent("#workJournal"), "");
      assert.deepEqual(
        await page.evaluate(() => ({
          local: localStorage.length,
          session: sessionStorage.length,
        })),
        { local: 0, session: 0 },
      );
      assert.deepEqual(errors, []);
      console.log(
        "PASS Chromium desktop/mobile UI, navigation, lock cleanup, no persisted browser credentials",
      );
    } finally {
      await browser.close();
    }
  }
} catch (e) {
  console.error(logs);
  throw e;
} finally {
  await stop();
  await rm(temp, { recursive: true, force: true });
}
