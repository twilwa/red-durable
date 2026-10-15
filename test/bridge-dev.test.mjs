import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadDevEnvironment,
  runDevBridge,
  devFailureMessage,
  DevConfigurationError,
} from "../bridge/dev.mjs";
const owner = "fixture-owner-" + "a".repeat(40);
const bridge = "fixture-bridge-" + "b".repeat(40);
const dotenv = `# Synthetic credentials only\nOWNER_TOKEN="${owner}"\nBRIDGE_TOKEN='${bridge}'\n`;
async function fixture(content = dotenv) {
  const root = await mkdtemp(join(tmpdir(), "red-dev-launcher-"));
  if (content !== null)
    await writeFile(join(root, ".dev.vars"), content, { mode: 0o600 });
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}
test("dev launcher loads existing project tokens privately without copying or changing process environment", async () => {
  const f = await fixture();
  const before = JSON.stringify({ ...process.env });
  const snapshot = await readFile(join(f.root, ".dev.vars"));
  try {
    const config = await loadDevEnvironment({ projectRoot: f.root, env: {} });
    assert.deepEqual(config, {
      RED_OWNER_TOKEN: owner,
      RED_BRIDGE_TOKEN: bridge,
      RED_URL: "http://127.0.0.1:8787",
      RED_SESSION: "default",
      RED_SETUP_PORT: "8788",
    });
    assert.ok(
      JSON.stringify({ ...process.env }) === before,
      "Loader must not change process environment",
    );
    assert.deepEqual(await readFile(join(f.root, ".dev.vars")), snapshot);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(f.root), [".dev.vars"]);
  } finally {
    await f.close();
  }
});
test("explicit RED overrides win, including alternate URL/session/port/storage", async () => {
  const f = await fixture(
    dotenv + "RED_SESSION=file-session\nRED_URL=http://127.0.0.1:8000\n",
  );
  try {
    const config = await loadDevEnvironment({
      projectRoot: f.root,
      env: {
        RED_OWNER_TOKEN: bridge,
        RED_BRIDGE_TOKEN: owner,
        OWNER_TOKEN: "ignored-" + owner,
        RED_URL: "https://example.test",
        RED_SESSION: "chosen",
        RED_SETUP_PORT: "0",
        RED_BRIDGE_DIR: "private-fixture",
      },
    });
    assert.equal(config.RED_OWNER_TOKEN, bridge);
    assert.equal(config.RED_BRIDGE_TOKEN, owner);
    assert.equal(config.RED_URL, "https://example.test");
    assert.equal(config.RED_SESSION, "chosen");
    assert.equal(config.RED_SETUP_PORT, "0");
    assert.equal(config.RED_BRIDGE_DIR, resolve(f.root, "private-fixture"));
  } finally {
    await f.close();
  }
});
test("process worker aliases override file values while empty explicit values fail closed", async () => {
  const f = await fixture();
  try {
    const config = await loadDevEnvironment({
      projectRoot: f.root,
      env: {
        OWNER_TOKEN: owner + "override",
        BRIDGE_TOKEN: bridge + "override",
      },
    });
    assert.equal(config.RED_OWNER_TOKEN, owner + "override");
    await assert.rejects(
      loadDevEnvironment({ projectRoot: f.root, env: { RED_OWNER_TOKEN: "" } }),
      (error) => error.code === "invalid",
    );
  } finally {
    await f.close();
  }
});
test("missing file can use explicit overrides but missing/short/equal tokens never start a runner", async () => {
  const f = await fixture(null);
  let calls = 0;
  try {
    await assert.rejects(
      runDevBridge({
        projectRoot: f.root,
        env: {},
        runner: async () => calls++,
      }),
      (error) => error.code === "missing",
    );
    for (const env of [
      { RED_OWNER_TOKEN: owner, RED_BRIDGE_TOKEN: owner },
      { RED_OWNER_TOKEN: "short", RED_BRIDGE_TOKEN: bridge },
      { RED_OWNER_TOKEN: owner + "\nsecret", RED_BRIDGE_TOKEN: bridge },
    ])
      await assert.rejects(
        runDevBridge({ projectRoot: f.root, env, runner: async () => calls++ }),
      );
    assert.equal(calls, 0);
    await runDevBridge({
      projectRoot: f.root,
      env: { RED_OWNER_TOKEN: owner, RED_BRIDGE_TOKEN: bridge },
      runner: async () => calls++,
    });
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
test("dotenv is parsed as data and unrelated keys never reach bridge configuration", async () => {
  const f = await fixture(
    dotenv +
      'NODE_OPTIONS=--require=evil.mjs\nOPENAI_API_KEY=fixture-api\nDISCORD_ENABLED=true\nUNUSED=$(touch unsafe)\nexport RED_SESSION="quoted-session" # comment\n',
  );
  try {
    const config = await loadDevEnvironment({ projectRoot: f.root, env: {} });
    assert.equal(config.RED_SESSION, "quoted-session");
    for (const key of [
      "NODE_OPTIONS",
      "OPENAI_API_KEY",
      "DISCORD_ENABLED",
      "UNUSED",
      "OWNER_TOKEN",
      "BRIDGE_TOKEN",
    ])
      assert.equal(Object.hasOwn(config, key), false);
  } finally {
    await f.close();
  }
});
test("invalid URL/session/port/bootstrap and unreadable oversized files fail with redacted messages", async () => {
  const f = await fixture();
  try {
    for (const overrides of [
      { RED_URL: "http://remote.invalid" },
      { RED_URL: "https://example.test/?token=" + owner },
      { RED_SESSION: "../private" },
      { RED_SETUP_PORT: "8787" },
      { RED_URL: "http://localhost:8788" },
      { RED_SETUP_PORT: "-1" },
      { RED_SETUP_PORT: "65536" },
      { RED_BRIDGE_DIR: "" },
      { RED_AUTH_HOST_ID: "fixture-host" },
    ]) {
      await assert.rejects(
        loadDevEnvironment({ projectRoot: f.root, env: overrides }),
        (error) => {
          const message = devFailureMessage(error);
          assert.ok(!message.includes(owner));
          assert.ok(!message.includes(bridge));
          return true;
        },
      );
    }
    await assert.rejects(
      loadDevEnvironment({
        projectRoot: f.root,
        env: {},
        read: async () => {
          throw Error(owner);
        },
      }),
      (error) => !devFailureMessage(error).includes(owner),
    );
    await assert.rejects(
      loadDevEnvironment({
        projectRoot: f.root,
        env: {},
        read: async () => "x".repeat(65537),
      }),
      (error) => error.code === "unreadable",
    );
    assert.ok(!devFailureMessage(new Error(owner)).includes(owner));
    assert.ok(
      !devFailureMessage({ code: owner, message: bridge }).includes(bridge),
    );
  } finally {
    await f.close();
  }
});
test("startup calls production serve with validated in-memory config only", async () => {
  const f = await fixture();
  const calls = [];
  try {
    await runDevBridge({
      projectRoot: f.root,
      env: {},
      runner: async (value) => {
        calls.push(value);
        return "fixture-started";
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "serve");
    assert.equal(calls[0].env.RED_OWNER_TOKEN, owner);
  } finally {
    await f.close();
  }
});
test("project-relative dotenv and storage semantics do not change with the caller's cwd", async () => {
  const f = await fixture(dotenv + "RED_BRIDGE_DIR=fixture-storage\n");
  const elsewhere = await fixture("OWNER_TOKEN=wrong\nBRIDGE_TOKEN=wrong\n");
  try {
    const moduleUrl = new URL("../bridge/dev.mjs", import.meta.url).href;
    const script = `import {loadDevEnvironment} from ${JSON.stringify(moduleUrl)}; const config=await loadDevEnvironment({projectRoot:${JSON.stringify(f.root)},env:{}}); console.log(JSON.stringify({matched:config.RED_OWNER_TOKEN===${JSON.stringify(owner)},directory:config.RED_BRIDGE_DIR}));`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: elsewhere.root, encoding: "utf8", env: {} },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      matched: true,
      directory: join(f.root, "fixture-storage"),
    });
    assert.ok(!child.stdout.includes(owner));
    assert.ok(!child.stderr.includes(owner));
  } finally {
    await f.close();
    await elsewhere.close();
  }
});
test("module-default project root is anchored to the launcher rather than the current directory", async () => {
  const expected = resolve(
    new URL("..", import.meta.url).pathname,
    ".dev.vars",
  );
  let requested;
  await loadDevEnvironment({
    env: {},
    read: async (path) => {
      requested = path;
      return dotenv;
    },
  });
  assert.equal(requested, expected);
});
