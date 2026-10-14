import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  lstat,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const CREDENTIAL_RECOVERY_MESSAGE =
  "Credential update outcome is uncertain. Stop this runner and reconnect in a NEW staging directory using the preserved host ID. Review/revoke the old ChatGPT connection and deliberately replace the credential file; do not just delete the update marker or reuse the old refresh token.";
export class CredentialRecoveryError extends Error {
  constructor() {
    super(CREDENTIAL_RECOVERY_MESSAGE);
    this.code = "CREDENTIAL_RECOVERY_REQUIRED";
  }
}

// A process-wide exclusive lease prevents separate runners racing rotating OAuth tokens.
// Crash locks deliberately require operator review; never guess that another runner is dead.
export async function openStore(directory, { bootstrapHostId } = {}) {
  if (bootstrapHostId !== undefined) {
    if (
      typeof bootstrapHostId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        bootstrapHostId,
      )
    )
      throw new Error(
        "RED_AUTH_HOST_ID must be a UUIDv4 from the target host-info command",
      );
    // Refuse any existing directory, including previously used staging directories.
    await mkdir(directory, { mode: 0o700 });
  } else await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink())
    throw new Error("Credential directory must be a real private directory");
  await chmod(directory, 0o700);
  const lock = await open(join(directory, "runner.lock"), "wx", 0o600).catch(
    () => {
      throw new Error(
        "Bridge storage is locked. Stop the other runner; after a crash, verify it stopped before removing runner.lock.",
      );
    },
  );
  await lock.writeFile(String(process.pid));
  const read = async (name) => {
    try {
      const p = join(directory, name);
      const s = await lstat(p);
      if (s.isSymbolicLink() || !s.isFile() || s.mode & 0o077)
        throw new Error("Unsafe local storage permissions");
      return JSON.parse(await readFile(p, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return undefined;
      throw e;
    }
  };
  const write = async (name, value) => {
    const temp = join(directory, `.${name}.${randomUUID()}.tmp`);
    const f = await open(temp, "wx", 0o600);
    try {
      await f.writeFile(JSON.stringify(value));
      await f.sync();
    } finally {
      await f.close();
    }
    await rename(temp, join(directory, name));
    const d = await open(directory, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  };
  const assertCredentialReady = async () => {
    if ((await read("credential-update.json")) !== undefined)
      throw new CredentialRecoveryError();
  };
  const clearCredentialMarker = async () => {
    await unlink(join(directory, "credential-update.json"));
    const d = await open(directory, "r");
    try {
      await d.sync();
    } finally {
      await d.close();
    }
  };
  let gate = Promise.resolve();
  const serial = (fn) => {
    const p = gate.then(fn);
    gate = p.catch(() => {});
    return p;
  };
  const readCredential = async (provider) => {
    await assertCredentialReady();
    if (!["openai", "openrouter", "opencode-zen"].includes(provider))
      return undefined;
    return (await read("credentials.json"))?.[provider];
  };
  const credentials = {
    // Public reads queue behind a live refresh rather than mistaking its marker
    // for a crashed update. A persisted marker still fails closed on reopen.
    read: (provider) => serial(() => readCredential(provider)),
    list: () =>
      serial(async () => {
        await assertCredentialReady();
        const values = (await read("credentials.json")) ?? {};
        return ["openai", "openrouter", "opencode-zen"]
          .filter((id) => values[id])
          .map((providerId) => ({ providerId, type: values[providerId].type }));
      }),
    modify: (provider, fn) =>
      serial(async () => {
        if (!["openai", "openrouter", "opencode-zen"].includes(provider))
          throw new Error("Unsupported credential provider");
        const current = await readCredential(provider);
        // Persist before calling a function that may consume a rotating refresh token.
        // The marker contains no token material. Any uncertain exception leaves it intact.
        await write("credential-update.json", {
          version: 1,
          state: "in-flight",
        });
        try {
          const next = await fn(current);
          if (next !== undefined) {
            if (next.type !== (provider === "openai" ? "oauth" : "api_key"))
              throw new Error("Unsupported credential type");
            const all = (await read("credentials.json")) ?? {};
            await write("credentials.json", { ...all, [provider]: next });
          }
          // Undefined is the CredentialStore contract's confirmed no-change outcome.
          await clearCredentialMarker();
          return next ?? current;
        } catch {
          throw new CredentialRecoveryError();
        }
      }),
    delete: (provider = "openai") =>
      serial(async () => {
        await assertCredentialReady();
        if (!["openai", "openrouter", "opencode-zen"].includes(provider))
          throw new Error("Unsupported credential provider");
        const all = (await read("credentials.json")) ?? {};
        delete all[provider];
        await write("credentials.json", all);
      }),
  };
  let host;
  try {
    host = await read("host.json");
    if (!host) {
      host = { id: bootstrapHostId?.toLowerCase() ?? randomUUID() };
      await write("host.json", host);
    }
  } catch (error) {
    await lock.close();
    await unlink(join(directory, "runner.lock"));
    throw error;
  }
  return {
    credentials,
    hostId: host.id,
    read,
    write,
    close: async () => {
      await gate;
      await lock.close();
      await unlink(join(directory, "runner.lock"));
    },
  };
}
