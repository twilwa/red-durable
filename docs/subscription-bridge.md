# Personal subscription inference bridge

The Durable Object owns conversation state, orchestration, archives and tools. A Node 24 process on your own machine or personal self-hosted VM makes outbound HTTPS polls, performs Pi model inference, and posts results. No incoming port, tunnel, shell execution or OAuth credential transfer to Cloudflare is required. All companion tools execute under the DO's existing policy; the bridge only calls the model.

## What is supported, and what remains unverified

Installed Pi 1.3.0 has `openai` → “Sign in with ChatGPT.” OpenAI documents eligible plan usage for open-source/local clients and a self-hosted VM credential-transfer procedure. Its overview directs developers offering paid or remotely hosted apps to an interest form. It does not explicitly classify a private Cloudflare Container/Durable Object deployment. A personal self-hosted VM is the documented cloud option; a hosted multiuser product or Cloudflare Container must not be assumed covered without clarification.

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions

This code has automated local protocol/store tests. Real OAuth, real account entitlement, end-to-end subscription inference, VM deployment and Cloudflare Container compatibility have not been exercised. No sign-in or grant is performed by installation or tests.

The trusted bridge now supplies its own official ChatGPT OAuth adapter around
Pi's inference provider. It validates ID-token signatures/nonce/issuer/audience
and account subject, reuses the saved client registration, and retains no ID
token or profile/email claims. The original Pi 1.1.0 helper is not used for new
sign-ins. See [providers.md](providers.md) for the browser connection UI,
OpenRouter/Zen keys, metered-model approval and explicit limitations.

## Configure manually

1. Create a separate random bridge credential of at least 32 characters for this installation. Configure the same value as the Worker's `BRIDGE_TOKEN` and the runner's `RED_BRIDGE_TOKEN`. Never use the owner credential. Configure `RED_URL` as the exact HTTPS Worker origin and `RED_SESSION` as the agent's session name.
2. On your chosen trusted machine, run `node bridge/cli.mjs login` interactively. Review and complete OpenAI's consent yourself. Credentials are stored under `~/.config/red-durable-bridge` (override with `RED_BRIDGE_DIR`). The callback requires access to the browser machine's loopback port 1455.
3. Run `node bridge/cli.mjs run` with those environment variables. Ambient API keys and other apps' credentials are ignored. Only explicitly stored provider connections can be used; existing ChatGPT-only installations keep their subscription route.
4. `node bridge/cli.mjs status` reports only local credential presence, without displaying secrets or claiming live account availability.

Review ChatGPT Settings > Usage yourself and keep optional credit spending and automatic credit purchases disabled if you want to stay within included usage. The bridge cannot verify or enforce these account settings; OAuth requests can consume credits if your account allows them. This bridge has no automatic OpenRouter or paid API fallback; choosing a metered model explicitly is a separate owner action. Cloudflare/VM infrastructure charges remain separate. Quota/auth failures clear the affected provider catalog and surface an error; failed inference is not automatically repeated. Refresh/reconnect and retry deliberately after resolving the condition. Network outages back off. An expired lease cannot replace a newer result.

## Always-on personal VM

This is an owner-driven setup procedure. No command below has been run against an account or remote host by the assistant. The VM's stable, non-secret host identity must be the identity used in the new authorization request. Do not reuse a laptop's existing registration/session for this flow.

1. On the VM, stop any runner/service. From the installed project, run:

   ```sh
   node bridge/cli.mjs host-info
   ```

   This initializes the default private directory if needed, then prints only `hostId` (UUID) and `agentHostId` (`urn:uuid:` URI). Save the UUID. Repeating this command preserves the same ID. Check `node bridge/cli.mjs status`; if the VM already has credentials, stop and review the existing connection rather than overwriting it.

2. On the local browser computer, use the same project/Pi version. Choose a NEW staging directory that does not yet exist; its parent must exist. Set the VM UUID as shown (replace the placeholder):

   ```sh
   mkdir -p "$HOME/.config"
   STAGING="$HOME/.config/red-durable-vm-auth-$(date +%s)"
   RED_BRIDGE_DIR="$STAGING" RED_AUTH_HOST_ID="PASTE-VM-HOST-ID-UUID" node bridge/cli.mjs login
   ```

   Complete OpenAI login/consent yourself in the browser, checking the intended account/workspace and subscription-sharing settings. The auth adapter adds the `urn:uuid:` prefix itself. The override is permitted only for `login`, only with an explicit new filesystem directory. Any existing directory is rejected, even with the same host ID, so existing credentials or identities cannot be repurposed. If an attempt fails, inspect/remove that unused staging directory or choose another new one before trying again. Do not run the local bridge using this staged session.

3. Confirm the staged identity without revealing tokens:

   ```sh
   RED_BRIDGE_DIR="$STAGING" node bridge/cli.mjs host-info
   RED_BRIDGE_DIR="$STAGING" node bridge/cli.mjs status
   ```

   Its UUID must equal the VM UUID. `status` only confirms local presence, not a live entitlement check.

4. Manually transfer only `$STAGING/credentials.json` over your trusted SSH/SFTP connection to the stopped VM's private directory as `credentials.import.json`. The directory must be owned by the runner user and have mode 0700; the imported file must have mode 0600. Do not put tokens in a command, URL, chat, email or log. On the VM, verify the existing `host.json` is unchanged and that no `credentials.json` already exists, then rename the import to `credentials.json`. Never copy local `host.json`, `runner.lock`, journals or the entire staging directory over the VM installation.

5. Check `node bridge/cli.mjs host-info` and `node bridge/cli.mjs status` on the VM. Only after verifying the UUID and import, remove the local staging credentials and staging directory using your normal secure local file-management process. From then on, let only the VM use and refresh this session. Configure its bridge environment and start `run` or the service. The browser computer can be closed afterward; it is not part of inference.

Keep the VM host ID across restarts and reauthorization. A subsequent login uses another new local staging directory with that same target UUID. Replacing an existing grant requires a deliberate maintenance window and review; this bootstrap does not silently overwrite it. For this new-directory VM bootstrap, authorization creates a fresh registration for the target host. Normal same-directory reconnection reuses its validated registration. All OAuth permissions, credential transfers, service installation and deployment are owner actions; these instructions are not evidence they occurred.

Installation templates:

- systemd: adapt `bridge/red-durable-bridge.service` to your Node binary and project path. Store the three runner variables in owner-only `~/.config/red-durable-bridge/runner.env`. Enable it as a user service; configure user lingering separately if you want it to survive logout.
- Docker: build using `docker build -f bridge/Dockerfile -t red-durable-bridge .`. Mount a dedicated, owner-only persistent credential directory at `/home/node/.config/red-durable-bridge`; ensure the image's `node` user owns it. Supply an owner-only env file with the runner variables. Do not bake credentials into the image or copy them into the build context. Run one replica only.

The Docker recipe is a portable packaging starting point, not a tested Cloudflare Containers deployment. Cloudflare-managed container lifecycle, persistent credential storage and its eligibility under SIWC need separate verification.

## Operational safety

Storage is owner-only (directory 0700, files 0600). Atomic writes fsync the file and directory. One process-wide exclusive lock plus serialized read/modify/write prevents token-refresh races. A crash leaves `runner.lock`: confirm the old process is stopped before removing it. Before a credential-update callback runs, the store fsyncs a `credential-update.json` marker containing only a version and an in-flight state, never tokens. It removes the marker only after the replacement credentials are atomically committed and synced, or after the callback explicitly reports no change. An uncertain callback or file-commit failure preserves the marker and blocks credential reads, updates and deletion after restart. Removing a stale `runner.lock` does not clear this protection. The CLI stops with explicit reconnect guidance instead of reusing a possibly consumed refresh token.

Recovery is deliberately manual: stop the runner, use `host-info` to recover the unchanged non-secret UUID, review/revoke the previous registration in ChatGPT, then authorize a fresh registration in a NEW staging directory with that target UUID. Securely import the new credential file during the maintenance window. Only after that fresh replacement is confirmed should the owner remove the in-flight marker and any abandoned temporary credential files. Do not merely delete the marker and retry the old file; do not treat a saved token-looking file as proof of a completed refresh. A failed initial sign-in/storage attempt likewise needs a new staging directory; the implementation never silently retries an uncertain exchange. This is conservative fail-closed recovery, not an exactly-once guarantee.

Never copy or share credentials while another process refreshes them. On logout, stop this bridge and disconnect the registration in ChatGPT Settings; deleting a local file alone does not revoke remote access.

A local journal records an inference start before the network call and saves its result before submission. Interrupted outcomes are not silently re-run; duplicate leases resend the saved result. Keep the journal private because it contains model output. For a stale/expired lease the server may reject the result; inspect the durable job status before explicitly retrying. Exactly-once execution across an arbitrary machine failure is not promised.

ChatGPT inference uses the fixed public OpenAI provider endpoint. Explicitly selected OpenRouter/Zen models use their own fixed allowlisted provider endpoints. Remote jobs cannot supply request headers, auth, arbitrary endpoints or executable tools. Only reasoning and an integer maxTokens hint from 1 to 16000 are accepted. Pi omits the unsupported max_output_tokens field for Sign in with ChatGPT, so this hint is not a hard output cap on the subscription route; response-size and execution-time limits still apply. Account model availability is checked on the official models endpoint. Bridge messages have bounded sizes, bounded lease lifetimes and inference deadlines. Logs suppress raw provider error bodies.
