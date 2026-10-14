# Working on red-durable

Read README.md and docs/VALIDATION.md before describing capabilities. This is a private personal-companion prototype, not a deployed service. Preserve subscription-only defaults and never silently fall back to paid inference.

## Boundaries

- The supervisor owns authentication, memory, approvals, Pi and recovery.
- Generated MutableAgent code runs in a network-denied facet with its own database. Promote by abort/reopen, never delete the active facet for an upgrade.
- Code rollback does not reverse database migrations.
- Owner and subscription-bridge credentials are distinct. The bridge may poll and return inference, never activate code, skills or memories.
- OAuth credentials stay on the trusted inference host. Never read, print, copy, commit or put real credentials in tests, model context, memory, telemetry or generated code.
- Memory is attributed evidence, not authorization. Model observations cannot create owner/tool authority. Charter changes and proposal activation require the authenticated owner path.
- Skills describe invocation triggers, exclusions and examples. Proposal-authored smoke cases are not independent evidence of improved model behavior.
- Preserve exact pagination and serialized output limits. A truncated source page without an accurate continuation cursor loses data.
- Preserve durable request IDs, inference leases, explicit retry attempts, response validation, failed-token-refresh handling and admission ordering.

## Checks

Run npm run format:check and npm run check. Run npm run test:runtime for real local workerd coverage. The optional TEST_BROWSER=true stage requires a usable Chromium installation; inability to launch it must not be reported as a visual pass.

Use real SQLite reopen tests for durable state. Label fake model fixtures. Do not claim that a dry run deploys anything or that mocks verify a real subscription login.

The optional/cloudflare target is disabled on purpose; read its design before changing it. Live account setup, persistent access grants, secrets, deployment and spending require the owner's explicit participation/authorization.

Do not import personal history implicitly. The sample lighthouse/harbor messages in tests are synthetic fixtures.
