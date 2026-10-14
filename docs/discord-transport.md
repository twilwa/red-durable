# Private Discord transport (disabled by default)

This is a staged, single-owner text transport. It has not connected to Discord,
used a real bot token, changed channel permissions, or been deployed. Local fake
Discord/model tests establish implementation behavior, not production readiness.

## Boundary and hosting

Use the existing MarkOne bot identity for red, with one private guild text
channel. Public Hermes remains a separate bot and process with its own tools and
Modal credentials. This transport neither imports Hermes history nor configures
Modal.

A separate Node 24 relay on the trusted subscription host maintains Discord's
Gateway connection. It receives messages and makes outbound HTTPS calls to the
Worker, polls a durable outbox, and sends replies through Discord's REST API.
It needs no incoming port or tunnel. Run it as a separate OS user with its own
private state directory. Sharing a physical VM does not mean sharing OAuth
storage or credentials. The existing subscription bridge remains the sole owner
of its renewable account session.

The Durable Object still owns red's conversation, memory, isolated tools and
reviewed behavior revisions. The relay has a third credential,
`DISCORD_RELAY_TOKEN`, distinct from `OWNER_TOKEN` and `BRIDGE_TOKEN`. It can only
admit chat to the configured session, claim replies, and report delivery results.
It cannot use owner or inference-bridge APIs. No owner token, subscription OAuth
credential, Modal credential or Cloudflare credential belongs in the relay.

Ordinary channel conversation uses `GUILDS`, `GUILD_MESSAGES` and
`MESSAGE_CONTENT` intents, without requiring a mention or slash command. Message
Content must be enabled in the app's Developer Portal and may require Discord
review depending on the app's reach. See [Gateway documentation](https://docs.discord.com/developers/events/gateway).
Ordinary guild messages are absent from Discord's supported [webhook event list](https://docs.discord.com/developers/events/webhook-events).
The Node host is deliberate: Cloudflare's [WebSocket hibernation](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
does not cover outbound Gateway sockets. The optional Cloudflare Container
scaffold remains disabled.

## Fixed identity and privacy

Both sides must configure the same guild, channel, owner user, bot user and red
session. IDs are exact snowflake strings, never display names. Incoming guild,
channel and author must match; bots, webhooks, system messages, DMs and threads
are rejected. The only accepted message types are ordinary messages and replies.
The supervisor uses its configured session rather than trusting arbitrary relay
routing. The relay also validates outgoing destinations against its own binding.

Configure a private guild text channel that denies `View Channel` to `@everyone`
and grants access to the owner and MarkOne. The bot needs `View Channel`, `Send
Messages`, and `Read Message History`. It does not need Administrator, Manage
Channels, Manage Messages, Manage Webhooks, Attach Files or Mention Everyone.
Server owners and Administrators bypass channel overwrites; this setup cannot
promise privacy from them or from Discord itself. See [Discord permissions](https://docs.discord.com/developers/topics/permissions).

Select the session deliberately. Using the browser's existing session shares
red's retained memory with this conversation; selecting a fresh session starts a
separate memory. Neither selection imports historical Discord messages. Quoted
material and attachments are untrusted data, not authority. Discord provenance
is recorded separately from the protected owner-control path, and chat cannot
activate code, change the charter or accept memory proposals directly.

## Durable processing and isolation

The relay journals allowed inputs before attempting ingress. The DO validates
the binding again and commits an inbox record before returning an admission
receipt. Repeated IDs with identical normalized input return the same receipt;
conflicting reuse is rejected. An HTTP receipt means durably queued, not that
inference or delivery succeeded. Missing subscription inference leaves input
queued and never enables a paid fallback.

Discord messages take isolated turns, one at a time. They wait while browser
work is active. Browser chat returns an explicit conflict while a Discord turn
is active; the owner can still inspect or stop it. Discord does not steer a
browser run, and browser messages do not steer a Discord run. Old transcripts
are reconciled before another run starts. This prevents accidental mirroring of
unrelated browser output. Other existing owner controls retain their authority.

Final assistant text is copied to an outbox using the active run and stable
assistant-entry identity. Tool output, reasoning and prior history are not
published. Polling `/api/state` and guessing new history entries is not used.
The same durable admission/reconciliation lifecycle handles recovery. No second
raw DO alarm is installed: [Durable Objects have one alarm](https://developers.cloudflare.com/durable-objects/api/alarms/),
already coordinated by Pi's lifecycle scheduler.

The outbox stores immutable chunks, nonces, leases and Discord delivery IDs.
Chunks preserve Unicode characters, escape mention triggers and are at most
1,900 UTF-16 code units. Every Discord send additionally sets
`allowed_mentions: {parse: [], replied_user: false}` and `enforce_nonce: true`.
Discord's [nonce deduplication window](https://docs.discord.com/developers/resources/message#create-message)
is only a few minutes, so this is not an exactly-once delivery claim.

A confirmed delivery receipt can be acknowledged repeatedly. Reclaiming an
expired lease fences stale acknowledgements. Rate limits defer the same item
without overtaking it. Uncertain or permanent delivery outcomes are parked for
review and block subsequent replies in that binding; a later proven matching
receipt can resolve a parked item. The relay persists a send attempt before
network transmission and the returned message ID before acknowledgment. Never
discard that journal to clear an uncertain send. Follow dynamic [rate-limit
headers and retry delays](https://docs.discord.com/developers/topics/rate-limits),
not hard-coded request-per-second assumptions.

The inbox permits at most 100 queued/admitted inputs and 10,000 retained inputs.
The outbox permits at most 1,000 unsent chunks and 20,000 retained chunks.
Capacity exhaustion rejects or pauses new work instead of deleting receipts or
silently dropping replies. There is no automatic retention cleanup or review UI
yet. Completed input/output records remain private durable data, and the
existing companion memory may retain their contents independently. A tested
owner-controlled archive/recovery workflow is required before prolonged use.

The Node journal uses a local-disk SQLite lock that releases when its process
exits; it refuses nonprivate or symlinked files/directories. Keep one store per
fixed binding. Local confirmed receipts/dedup rows are pruned after 30 days,
while unresolved work is retained; this does not erase the DO's retained
conversation. The local database has a 128 MiB page limit. Its pending inbox and
outbox each cap at 1,000 rows. A delayed inbox head blocks later inputs, so
network backoff cannot reverse an owner's correction and original request.

`npm run discord:check` validates supplied configuration offline without opening
the journal or contacting a service. `npm run discord:run` is the explicit live
entrypoint and still exits inertly unless its enable flag is true. The service
file is a template only; installing/enabling it is a separate owner action.

## Deliberately limited v1

- Text only. Attachment-only messages receive an explanatory response. Mixed
  text/attachment messages process the text with an explicit model instruction
  that attachments were not read. No attachment URL is downloaded.
- No initial history import, message edit replay, reaction commands, voice,
  threads, arbitrary recipients or autonomous outbound messaging tool.
- Discord deletion does not delete retained companion history.
- Gateway resume can replay recoverable missed events. If the Gateway session
  cannot resume, this relay does not silently import channel history. A gap may
  require the owner to resend their message; monitoring must report the gap.
- One active relay process/host per bot. A local lock cannot fence a separately
  deployed old MarkOne process: stop and verify that consumer before cutover.
- Review/uncertain outcomes require operator attention. There is no unsafe
  automatic resend or bypass control.

## Owner-assisted cutover, not performed by this change

1. Confirm MarkOne's existing application/bot identity, guild, private channel,
   owner user ID, target session and trusted always-on host. Confirm that other
   administrators' access is acceptable. Review infrastructure costs.
2. Stop the old MarkOne consumer deliberately and verify it is stopped. Do not
   affect the separate public Hermes bot. Do not duplicate subscription OAuth
   directories or runners.
3. Have the owner configure/verify the channel permissions and Message Content
   intent. Installation, new grants and permission changes require approval;
   none are performed by these source files.
4. The owner securely provisions the existing Discord bot token on the relay
   host and a new distinct relay credential on the Worker and relay. Never
   paste tokens into chat, commit them, log them, or enter them in model context.
   The relay credential is `DISCORD_RELAY_TOKEN` on the Worker and
   `RED_DISCORD_TOKEN` on Node. Use the private example files as templates, not
   real credential storage in the checkout.
5. Set fixed `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_OWNER_ID`,
   `DISCORD_BOT_ID`, and `DISCORD_SESSION` on both sides. The Worker additionally
   requires `DISCORD_ENABLED=true`; the relay requires
   `DISCORD_RELAY_ENABLED=true`. Leave both off until the owner approves a live
   connection. `RED_URL` must be the exact approved HTTPS Worker origin.
6. Separately approve and deploy the Worker; configure the subscription bridge
   and select a real available model through the owner interface. Then start
   exactly one relay using the documented private host/service setup. Source
   delivery and a dry-run build do not authorize or establish deployment.
7. Verify one owner message/reply, rejection of another author, credential
   separation, restart deduplication, inference-outage recovery, permission
   revocation and a controlled Discord rate-limit scenario. Check retained
   pending/review counts in the owner API before enabling longer work.

No real Discord behavior, token validity, private-channel permissions, message
content entitlement, account inference or live delivery has been validated by
the offline test suite.
