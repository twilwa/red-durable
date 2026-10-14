/** The Discord transport carries conversation only, never owner control authority. */
export interface DiscordBinding {
  guildId: string;
  channelId: string;
  ownerId: string;
  botId: string;
  session: string;
}
export interface DiscordEnvironment {
  DISCORD_ENABLED?: string;
  DISCORD_RELAY_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_CHANNEL_ID?: string;
  DISCORD_OWNER_ID?: string;
  DISCORD_BOT_ID?: string;
  DISCORD_SESSION?: string;
  OWNER_TOKEN?: string;
  BRIDGE_TOKEN?: string;
}
export class DiscordError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function snowflake(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{16,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
export function discordBinding(env: DiscordEnvironment): DiscordBinding | null {
  if (env.DISCORD_ENABLED !== "true") return null;
  const token = env.DISCORD_RELAY_TOKEN;
  if (
    !token ||
    token.length < 32 ||
    token === env.OWNER_TOKEN ||
    token === env.BRIDGE_TOKEN
  )
    throw new DiscordError(
      "Discord relay credential is missing or not distinct",
      503,
    );
  const binding = {
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID,
    ownerId: env.DISCORD_OWNER_ID,
    botId: env.DISCORD_BOT_ID,
    session: env.DISCORD_SESSION,
  };
  if (
    ![binding.guildId, binding.channelId, binding.ownerId, binding.botId].every(
      snowflake,
    ) ||
    new Set([
      binding.guildId,
      binding.channelId,
      binding.ownerId,
      binding.botId,
    ]).size !== 4 ||
    typeof binding.session !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(binding.session)
  )
    throw new DiscordError("Discord fixed binding is incomplete", 503);
  return binding as DiscordBinding;
}
export interface DiscordInput {
  id: string;
  text: string;
  attachmentCount: number;
  guildId: string;
  channelId: string;
  authorId: string;
}
export function normalizeDiscordInput(
  value: Record<string, unknown>,
  binding: DiscordBinding,
): DiscordInput {
  const author = value.author as Record<string, unknown> | undefined;
  if (
    !snowflake(value.id) ||
    value.guild_id !== binding.guildId ||
    value.channel_id !== binding.channelId ||
    !author ||
    author.id !== binding.ownerId ||
    (author.bot !== undefined && author.bot !== false) ||
    author.id === binding.botId ||
    (value.webhook_id !== undefined && value.webhook_id !== null) ||
    ![0, 19].includes(Number(value.type)) ||
    typeof value.type !== "number"
  )
    throw new DiscordError(
      "Discord message is outside the fixed owner/channel binding",
      403,
    );
  if (
    typeof value.content !== "string" ||
    new TextEncoder().encode(value.content).length > 32000 ||
    (value.attachments !== undefined &&
      (!Array.isArray(value.attachments) || value.attachments.length > 10))
  )
    throw new DiscordError("Invalid Discord message content");
  const attachmentCount = Array.isArray(value.attachments)
    ? value.attachments.length
    : 0;
  if (!value.content.trim() && !attachmentCount)
    throw new DiscordError("Empty Discord message");
  return {
    id: value.id,
    text: value.content,
    attachmentCount,
    guildId: binding.guildId,
    channelId: binding.channelId,
    authorId: binding.ownerId,
  };
}
export interface DiscordDelivery {
  id: string;
  channelId: string;
  replyToMessageId: string;
  content: string;
  nonce: string;
  leaseToken: string;
  expiresAt: number;
}
/** Safe literal mention rendering supplements REST allowed_mentions on every send. */
export function discordChunks(text: string): string[] {
  const safe = text.replace(/@/g, "@\u200b");
  const chunks: string[] = [];
  let current = "";
  for (const char of safe) {
    if (current.length + char.length > 1900) {
      chunks.push(current);
      current = "";
    }
    current += char;
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.trim().length > 0);
}
