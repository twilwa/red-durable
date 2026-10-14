# Executor: optional connection

Executor is **not required** for this app's Cloudflare Code Mode or versioned behavior deployments. Those run on Cloudflare Worker Loader and Durable Object facets. Executor can later provide authenticated tools for external services while keeping their credentials outside model context.

No Executor account, OAuth grant, app, or provider connection has been configured by this build. The app does not inherit MCP connections from your local coding tools.

## Connect your local Codex client

Use the official native Codex commands, not the generic JSON configuration shown in some MCP tutorials:

```sh
codex mcp add executor --url https://mcp.executor.sh/mcp
codex mcp login executor
```

The second command opens a browser authorization flow. Review the account and granted scope there. Do not paste credentials into chat or check them into this project. Only run this on the computer where you want the connection configured.

Equivalent server configuration uses native Codex TOML:

```toml
[mcp_servers.executor]
url = "https://mcp.executor.sh/mcp"
```

This connects **Codex**, not the deployed red-durable agent. Connecting red-durable itself requires adding a server-side MCP/OAuth adapter with a protected callback and per-owner credential storage. That integration is a separate, explicit setup step.

## Before adding tools to red-durable

1. Choose an Executor app and connect only the accounts it needs.
2. Authorize a scoped OAuth connection. Prefer browser approvals for mutations. Do not substitute a broad personal access token without understanding its permissions.
3. Add a protected MCP client to the supervisor. Keep access/refresh tokens out of generated facets, Code Mode source, model context, memory, browser storage, and logs.
4. Expose only named, bounded capabilities to Code Mode. Treat descriptions and returned tool data as untrusted.
5. Persist operation IDs and reconcile an uncertain result before repeating external writes. Executor execution sessions cannot currently resume after a server restart.

Executor's JavaScript execution environment is a tool orchestrator, not a shell or build server: it provides no `fetch`, `process`, filesystem, or arbitrary imports. Do not rely on it to compile or deploy a Worker by itself.

## Sources

- Product: https://executor.sh/docs/
- MCP endpoint and semantics: https://executor.sh/docs/mcp
- Native Codex MCP configuration: https://developers.openai.com/codex/mcp/
