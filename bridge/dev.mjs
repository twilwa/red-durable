#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { runBridge } from "./cli.mjs";
import { bridgeEndpoint } from "./protocol.mjs";
import { CREDENTIAL_RECOVERY_MESSAGE } from "./store.mjs";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ENV_BYTES = 64 * 1024;
const messages = {
  missing:
    "Local bridge setup needs OWNER_TOKEN and BRIDGE_TOKEN in this project's .dev.vars, or explicit RED_OWNER_TOKEN and RED_BRIDGE_TOKEN overrides.",
  unreadable:
    "This project's .dev.vars could not be read safely. Check the file and its permissions; no values were logged.",
  invalid:
    "Local bridge credentials must be nonempty, single-line values of at least 32 characters. Check .dev.vars or the explicit overrides.",
  conflict:
    "The owner and bridge credentials must be different. No bridge was started.",
  target:
    "RED_URL must be a valid HTTPS origin or HTTP loopback origin without a path, query or credentials.",
  session:
    "RED_SESSION must contain 1–64 letters, numbers, underscores or hyphens.",
  port: "RED_SETUP_PORT must be an integer from 0 to 65535 and differ from the local upstream port. Zero chooses a free port.",
  directory: "RED_BRIDGE_DIR must be a nonempty local path.",
  cache: "RED_PROMPT_CACHE must be auto or off.",
  bootstrap:
    "The local dev launcher cannot bootstrap another auth host. Use the explicit login procedure instead.",
};
export class DevConfigurationError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.invalid);
    this.name = "DevConfigurationError";
    this.code = code;
  }
}
const has = (value, key) =>
  Object.hasOwn(value, key) && value[key] !== undefined;

/** Read only the checkout's dotenv file. Never evaluate shell syntax, load
 * NODE_OPTIONS, mutate process.env, copy credentials, or discover another cwd's
 * file. Explicit process RED_* overrides win, followed by process worker-token
 * aliases, file RED_* values, then file worker-token aliases.
 */
export async function loadDevEnvironment({
  env = process.env,
  projectRoot = PROJECT_ROOT,
  read = readFile,
} = {}) {
  const root = resolve(projectRoot);
  let file = {};
  try {
    const raw = await read(resolve(root, ".dev.vars"));
    if (Buffer.byteLength(raw) > MAX_ENV_BYTES)
      throw new DevConfigurationError("unreadable");
    file = parseEnv(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new DevConfigurationError("unreadable");
  }
  const value = (name, alias, fallback) => {
    for (const [source, key] of [
      [env, name],
      ...(alias ? [[env, alias]] : []),
      [file, name],
      ...(alias ? [[file, alias]] : []),
    ])
      if (has(source, key)) return source[key];
    return fallback;
  };
  const owner = value("RED_OWNER_TOKEN", "OWNER_TOKEN");
  const bridge = value("RED_BRIDGE_TOKEN", "BRIDGE_TOKEN");
  if (owner === undefined || bridge === undefined)
    throw new DevConfigurationError("missing");
  for (const token of [owner, bridge])
    if (
      typeof token !== "string" ||
      token.length < 32 ||
      token.length > 8192 ||
      /[\s\u0000-\u001f\u007f]/.test(token)
    )
      throw new DevConfigurationError("invalid");
  if (owner === bridge) throw new DevConfigurationError("conflict");
  let origin;
  try {
    origin = bridgeEndpoint(
      value("RED_URL", undefined, "http://127.0.0.1:8787"),
    );
  } catch {
    throw new DevConfigurationError("target");
  }
  const session = value("RED_SESSION", undefined, "default");
  if (typeof session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(session))
    throw new DevConfigurationError("session");
  const rawPort = value("RED_SETUP_PORT", undefined, "8788");
  const port =
    typeof rawPort === "string" && /^\d{1,5}$/.test(rawPort)
      ? Number(rawPort)
      : NaN;
  const upstream = new URL(origin);
  const upstreamPort = Number(
    upstream.port || (upstream.protocol === "https:" ? 443 : 80),
  );
  if (
    !Number.isInteger(port) ||
    port > 65535 ||
    (port !== 0 &&
      ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) &&
      upstreamPort === port)
  )
    throw new DevConfigurationError("port");
  const cachePolicy = value("RED_PROMPT_CACHE");
  if (cachePolicy !== undefined && !["auto", "off"].includes(cachePolicy))
    throw new DevConfigurationError("cache");
  const directory = value("RED_BRIDGE_DIR");
  if (
    directory !== undefined &&
    (typeof directory !== "string" ||
      !directory.trim() ||
      /[\u0000-\u001f\u007f]/.test(directory))
  )
    throw new DevConfigurationError("directory");
  if (value("RED_AUTH_HOST_ID") !== undefined)
    throw new DevConfigurationError("bootstrap");
  return {
    RED_OWNER_TOKEN: owner,
    RED_BRIDGE_TOKEN: bridge,
    RED_URL: origin,
    RED_SESSION: session,
    RED_SETUP_PORT: String(port),
    ...(cachePolicy === undefined ? {} : { RED_PROMPT_CACHE: cachePolicy }),
    ...(directory === undefined
      ? {}
      : {
          RED_BRIDGE_DIR: isAbsolute(directory)
            ? directory
            : resolve(root, directory),
        }),
  };
}

export async function runDevBridge({ runner = runBridge, ...options } = {}) {
  const env = await loadDevEnvironment(options);
  return runner({ command: "serve", env });
}

export function devFailureMessage(error) {
  if (error instanceof DevConfigurationError)
    return messages[error.code] ?? messages.invalid;
  if (error?.code === "CREDENTIAL_RECOVERY_REQUIRED")
    return CREDENTIAL_RECOVERY_MESSAGE;
  return "Local development bridge stopped. Check configuration, local credentials and runner.lock; secrets were not logged.";
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  runDevBridge().catch((error) => {
    console.error(devFailureMessage(error));
    process.exitCode = 1;
  });
