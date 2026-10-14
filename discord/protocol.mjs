// Discord API v10, deliberately limited to one private guild text channel.
export const DISCORD_API = "https://discord.com/api/v10";
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_INBOX = 1000;
export class RelayError extends Error {
  constructor(code, fatal = false) {
    super(code);
    this.code = code;
    this.fatal = fatal;
  }
}
export const snowflake = (value) =>
  typeof value === "string" &&
  /^[1-9][0-9]{16,19}$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;
export function snowflakeTime(id) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}
export function readConfig(env = process.env) {
  if (!env.DISCORD_RELAY_ENABLED || env.DISCORD_RELAY_ENABLED === "false")
    return { enabled: false };
  if (env.DISCORD_RELAY_ENABLED !== "true")
    throw new RelayError("invalid_enabled_flag", true);
  const config = { enabled: true };
  for (const [field, key] of Object.entries({
    guildId: "DISCORD_GUILD_ID",
    channelId: "DISCORD_CHANNEL_ID",
    ownerId: "DISCORD_OWNER_ID",
    botId: "DISCORD_BOT_ID",
  })) {
    if (!snowflake(env[key])) throw new RelayError(`invalid_${key}`, true);
    config[field] = env[key];
  }
  if (
    new Set([config.guildId, config.channelId, config.ownerId, config.botId])
      .size !== 4
  )
    throw new RelayError("bindings_must_be_distinct", true);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(env.DISCORD_SESSION ?? ""))
    throw new RelayError("invalid_DISCORD_SESSION", true);
  config.session = env.DISCORD_SESSION;
  for (const [field, key] of Object.entries({
    redToken: "RED_DISCORD_TOKEN",
    botToken: "DISCORD_BOT_TOKEN",
  })) {
    if (typeof env[key] !== "string" || !/^[\x21-\x7e]{32,256}$/.test(env[key]))
      throw new RelayError(`invalid_${key}`, true);
    config[field] = env[key];
  }
  const secrets = [
    config.redToken,
    config.botToken,
    env.RED_OWNER_TOKEN,
    env.RED_BRIDGE_TOKEN,
    env.OWNER_TOKEN,
    env.BRIDGE_TOKEN,
  ].filter(Boolean);
  if (new Set(secrets).size !== secrets.length)
    throw new RelayError("credentials_must_be_distinct", true);
  let url;
  try {
    url = new URL(env.RED_URL);
  } catch {
    throw new RelayError("invalid_RED_URL", true);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    ![url.origin, `${url.origin}/`].includes(env.RED_URL) ||
    (url.protocol !== "https:" &&
      !(
        env.RED_DISCORD_ALLOW_HTTP_LOOPBACK === "true" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new RelayError("invalid_RED_URL", true);
  config.redUrl = url.origin;
  if (
    typeof env.RED_DISCORD_DIR !== "string" ||
    !env.RED_DISCORD_DIR.startsWith("/") ||
    env.RED_DISCORD_DIR === "/"
  )
    throw new RelayError("invalid_RED_DISCORD_DIR", true);
  config.directory = env.RED_DISCORD_DIR;
  return Object.freeze(config);
}
export function gatewayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError("invalid_gateway_url", true);
  }
  if (
    url.protocol !== "wss:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !(
      url.hostname === "gateway.discord.gg" ||
      /^gateway-[a-z0-9-]+\.discord\.gg$/.test(url.hostname) ||
      /^[a-z0-9-]+\.gateway\.discord\.gg$/.test(url.hostname)
    ) ||
    url.pathname !== "/"
  )
    throw new RelayError("invalid_gateway_url", true);
  url.search = "?v=10&encoding=json";
  return url.href;
}
export function validateChannel(channel, config) {
  if (
    !channel ||
    channel.id !== config.channelId ||
    channel.guild_id !== config.guildId ||
    channel.type !== 0
  )
    throw new RelayError("channel_binding_mismatch", true);
  const overwrites = channel.permission_overwrites;
  if (!Array.isArray(overwrites) || overwrites.length > 100)
    throw new RelayError("private_channel_required", true);
  const view = 1024n;
  let everyoneDenied = false;
  for (const rule of overwrites) {
    if (
      !snowflake(rule.id) ||
      ![0, 1].includes(rule.type) ||
      !/^[0-9]{1,24}$/.test(rule.allow) ||
      !/^[0-9]{1,24}$/.test(rule.deny)
    )
      throw new RelayError("invalid_channel_permissions", true);
    if (
      rule.id === config.guildId &&
      rule.type === 0 &&
      BigInt(rule.deny) & view
    )
      everyoneDenied = true;
    if (
      BigInt(rule.allow) & view &&
      !(rule.type === 1 && [config.ownerId, config.botId].includes(rule.id))
    )
      throw new RelayError("private_channel_required", true);
  }
  if (!everyoneDenied) throw new RelayError("private_channel_required", true);
  return channel;
}
export function inboundMessage(message, config, watermark) {
  if (
    !message ||
    message.guild_id !== config.guildId ||
    message.channel_id !== config.channelId ||
    message.author?.id !== config.ownerId ||
    (message.author.bot !== undefined && message.author.bot !== false) ||
    message.webhook_id != null ||
    ![0, 19].includes(message.type) ||
    !snowflake(message.id) ||
    snowflakeTime(message.id) < watermark ||
    typeof message.content !== "string" ||
    message.content.length > 4000 ||
    (message.attachments !== undefined &&
      (!Array.isArray(message.attachments) || message.attachments.length > 10))
  )
    return null;
  const attachments = [];
  for (const item of message.attachments ?? []) {
    if (
      !snowflake(item.id) ||
      typeof item.filename !== "string" ||
      item.filename.length > 256 ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      item.size > 1024 * 1024 * 1024 ||
      (item.content_type !== undefined &&
        (typeof item.content_type !== "string" ||
          item.content_type.length > 128))
    )
      return null;
    attachments.push({
      id: item.id,
      filename: item.filename,
      size: item.size,
      ...(item.content_type ? { content_type: item.content_type } : {}),
    });
  }
  if (!message.content.trim() && !attachments.length) return null;
  return {
    id: message.id,
    guild_id: message.guild_id,
    channel_id: message.channel_id,
    author: { id: message.author.id, bot: false },
    type: message.type,
    content: message.content,
    ...(attachments.length ? { attachments } : {}),
  };
}
export function validateDelivery(value, config, now = Date.now()) {
  if (
    !value ||
    typeof value !== "object" ||
    !/^[A-Za-z0-9_:-]{1,128}$/.test(value.id ?? "") ||
    value.channelId !== config.channelId ||
    !snowflake(value.replyToMessageId) ||
    typeof value.content !== "string" ||
    !value.content.trim() ||
    value.content.length > 2000 ||
    !/^[A-Za-z0-9_-]{1,25}$/.test(value.nonce ?? "") ||
    typeof value.leaseToken !== "string" ||
    !/^[\x21-\x7e]{1,256}$/.test(value.leaseToken) ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now + 15000 ||
    value.expiresAt > now + 600000
  )
    throw new RelayError("invalid_delivery", true);
  return {
    id: value.id,
    channelId: value.channelId,
    replyToMessageId: value.replyToMessageId,
    content: value.content,
    nonce: value.nonce,
    leaseToken: value.leaseToken,
    expiresAt: value.expiresAt,
  };
}
export function discordPayload(delivery) {
  return {
    content: delivery.content,
    nonce: delivery.nonce,
    enforce_nonce: true,
    allowed_mentions: { parse: [], replied_user: false },
    message_reference: {
      message_id: delivery.replyToMessageId,
      channel_id: delivery.channelId,
      fail_if_not_exists: true,
    },
  };
}
export async function readBounded(response, max = MAX_RESPONSE_BYTES) {
  if (!response.body) throw new RelayError("missing_response_body");
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) throw new RelayError("response_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new RelayError("invalid_response_json");
  }
}
export function retryDelay(response, body, now = Date.now()) {
  const delays = [];
  if (typeof body?.retry_after === "number")
    delays.push(body.retry_after * 1000);
  for (const name of ["retry-after", "x-ratelimit-reset-after"]) {
    const value = response.headers.get(name);
    if (value !== null) {
      const seconds = Number(value);
      delays.push(
        Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now,
      );
    }
  }
  if (!delays.length) return 5000;
  if (
    delays.some(
      (delay) => !Number.isFinite(delay) || delay < 0 || delay > 86400000,
    )
  )
    throw new RelayError("invalid_rate_limit", true);
  return Math.min(
    86400000,
    Math.max(250, Math.ceil(Math.max(...delays)) + 100),
  );
}
export const backoff = (attempt, random = Math.random) =>
  Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)) +
  Math.floor(random() * 1000);
