#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore, CREDENTIAL_RECOVERY_MESSAGE } from "./store.mjs";
import {
  bridgeEndpoint,
  exchange,
  readBounded,
  executeJob,
} from "./protocol.mjs";
import { createProviderManager } from "./providers.mjs";
import { startSetupServer } from "./server.mjs";

export async function runBridge({
  command = process.argv[2],
  store: providedStore,
  env = process.env,
} = {}) {
  if (!["login", "run", "serve", "status", "host-info"].includes(command)) {
    console.log(
      "Usage: node bridge/cli.mjs login|run|serve|status|host-info\nrun/serve require RED_URL, RED_SESSION, RED_BRIDGE_TOKEN. serve also requires a distinct RED_OWNER_TOKEN. Optional RED_BRIDGE_DIR and RED_SETUP_PORT (default 8788). Credentials stay on this machine.",
    );
    return;
  }
  if (
    env.RED_AUTH_HOST_ID !== undefined &&
    (command !== "login" || !env.RED_BRIDGE_DIR || providedStore)
  )
    throw new Error(
      "RED_AUTH_HOST_ID requires login with an explicit new RED_BRIDGE_DIR and filesystem storage",
    );
  const store =
    providedStore ??
    (await openStore(
      env.RED_BRIDGE_DIR ?? join(homedir(), ".config", "red-durable-bridge"),
      { bootstrapHostId: env.RED_AUTH_HOST_ID },
    ));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let manager, server;
  try {
    if (command === "host-info") {
      console.log(
        JSON.stringify({
          hostId: store.hostId,
          agentHostId: `urn:uuid:${store.hostId}`,
        }),
      );
      return;
    }
    manager = createProviderManager({ store });
    if (command === "status") {
      // Only the manager's deliberately non-secret public view may be printed.
      console.log(JSON.stringify(await manager.status(), null, 2));
      return;
    }
    if (command === "login") {
      if (!process.stdin.isTTY)
        throw new Error("Login requires an interactive terminal");
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      let lastUrl = "",
        answered = "",
        question;
      const promptAbort = new AbortController();
      try {
        let flow = await manager.startLogin("openai");
        while (!abort.signal.aborted) {
          flow = (await manager.status()).flow;
          if (!flow || ["error", "cancelled", "expired"].includes(flow.status))
            throw new Error("Sign-in did not complete");
          if (flow.status === "connected") {
            console.log(
              "Connected. Credentials saved locally with owner-only permissions.",
            );
            return;
          }
          if (flow.url && flow.url !== lastUrl) {
            lastUrl = flow.url;
            console.log(`Open on this machine and review consent: ${flow.url}`);
          }
          if (flow.prompt && answered !== flow.id) {
            answered = flow.id;
            const id = flow.id;
            // A normal browser callback must be able to complete while the
            // optional manual-input prompt is waiting for terminal input.
            question = rl
              .question(`${flow.prompt.message}\n`, {
                signal: AbortSignal.any([abort.signal, promptAbort.signal]),
              })
              .then((value) => manager.respondLogin(id, value))
              .catch(() => {});
          }
          await sleep(300, undefined, { signal: abort.signal });
        }
      } finally {
        promptAbort.abort();
        await question;
        await manager.cancelLogin(null);
        rl.close();
      }
      return;
    }
    const origin = bridgeEndpoint(env.RED_URL ?? "");
    const session = env.RED_SESSION ?? "default";
    const token = env.RED_BRIDGE_TOKEN;
    if (
      !/^[a-zA-Z0-9_-]{1,64}$/.test(session) ||
      !token ||
      token.length < 32 ||
      /[\r\n]/.test(token)
    )
      throw new Error(
        "Set RED_SESSION and a distinct RED_BRIDGE_TOKEN of at least 32 characters",
      );
    if (command === "serve") {
      server = await startSetupServer({
        manager,
        upstream: origin,
        ownerToken: env.RED_OWNER_TOKEN,
        bridgeToken: token,
        session,
        port: Number(env.RED_SETUP_PORT ?? 8788),
      });
      console.log(
        `Provider setup and conversation: ${server.origin}\nUnlock with the owner token and configured session. Provider credentials stay on this host. The existing dev server is unchanged.`,
      );
    }
    console.log(
      "Inference bridge running. Only explicitly selected connected providers are used; no fallback or automatic top-up.",
    );
    while (!abort.signal.aborted) {
      try {
        // A durable uncertain-refresh marker stops all provider use, including
        // after a restart. Never let a catalog error hide credential recovery.
        await store.credentials.list();
        const pending = await store.read("journal.json");
        if (pending?.state === "completed" && pending.result) {
          const posted = await exchange(
            origin,
            session,
            token,
            "result",
            pending.result,
          );
          if (posted.status === 401 || posted.status === 403)
            throw new Error("Bridge authorization rejected");
          if (!posted.ok && posted.status !== 409 && posted.status !== 410)
            throw new Error("Bridge result acknowledgement unavailable");
          await store.write("journal.json", {
            ...pending,
            state: "acknowledged",
          });
        }
        const modelIds = await manager.catalog();
        const response = await exchange(origin, session, token, "poll", {
          modelIds,
        });
        if (response.status === 401 || response.status === 403)
          throw new Error("Bridge authorization rejected");
        if (!response.ok) throw new Error("Bridge polling unavailable");
        const data = await readBounded(response);
        if (data.job) {
          await executeJob(data.job, store, (job) =>
            manager.infer(job, { signal: abort.signal }),
          );
          continue;
        }
        await sleep(3000, undefined, { signal: abort.signal });
      } catch (error) {
        if (abort.signal.aborted) break;
        if (error?.code === "CREDENTIAL_RECOVERY_REQUIRED") {
          console.error(CREDENTIAL_RECOVERY_MESSAGE);
          break;
        }
        // Never print exception bodies, which may contain credentials or content.
        console.error(
          "Bridge connection or provider needs attention. Retrying polling in 30 seconds; inference is never switched or replayed automatically.",
        );
        await sleep(30000, undefined, { signal: abort.signal }).catch(() => {});
      }
    }
  } finally {
    await server?.close();
    await manager?.close();
    await store.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runBridge().catch((error) => {
    console.error(
      error?.code === "CREDENTIAL_RECOVERY_REQUIRED"
        ? CREDENTIAL_RECOVERY_MESSAGE
        : "Bridge stopped. Check configuration, local credentials, and runner.lock; secrets were not logged.",
    );
    process.exitCode = 1;
  });
