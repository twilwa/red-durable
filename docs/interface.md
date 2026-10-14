# red's browser interface

The interface is a window into the same owner-authenticated Durable Object
session. It does not own red's persona, memory, subscription credentials or
permissions. Open the deployed app in a browser on a computer or phone and use
the same session name to return to the same stored conversation. Separate names
have separate Durable Object state; the UI does not invent a device fleet or
claim cross-session memory.

## Design and source

The responsive shell, warm dark palette, optional navigation, inspector panels,
composer and guarded state-editor patterns adapt the actual
[Durable Pi playground](https://github.com/disler/durable-pi/tree/37165c619573dbaf425463038bbffecfe576beec/apps/dpi-playground/apps/dpi-playground-fe)
shown in the user-supplied demo. Attribution is pinned to commit
`37165c619573dbaf425463038bbffecfe576beec`; the MIT notice is retained in
`third_party/DURABLE-PI-LICENSE.txt` and `third_party/NOTICE.txt`.

The upstream Vue app imports an Express hub, network registry, SDK and stream
store that do not match red's API. This adaptation keeps the small static UI and
ports its useful layout/interaction patterns rather than importing that runtime.
No third-party build scripts were executed, new dependencies added, remote fonts
loaded or external scripts embedded. `public/api.js` provides a typed same-origin
owner API adapter, checked against `ui/contracts.d.ts` with `tsconfig.ui.json`.

## Everyday use

- Conversation remains the home screen. Navigation and the inspector can be
  opened independently on desktop. On narrow screens, either panel takes the
  available space and Escape or its close button returns to the conversation.
- **Memory:** edit the versioned charter, filter attributed beliefs, accept
  proposals and load the current bounded working-memory view. Discuss correction
  prepares an unsent prompt; it does not alter a memory or grant a permission.
- **Work:** review proposed/open/blocked/completed/cancelled commitments, accept a
  proposal, mark completion or confirm cancellation.
- **Skills:** read triggers, exclusions, instructions, examples and evaluation
  provenance. Revision requests prepare a draft in the conversation. Activating
  or deactivating still uses the explicit owner confirmation path.
- **Changes:** review source, run contract smoke tests, explicitly activate or
  roll back an existing revision, or stage source under an advanced disclosure.
  Staging and testing do not activate code. Rollback does not reverse data.
- **Link:** distinguish owner access from inference-host contact and provider
  sign-in, choose an advertised model, and inspect bounded queue/memory status.
  No provider credential is returned to the browser.

## Interaction and privacy guarantees

- Owner credentials remain only in memory. No local/session browser storage,
  cookies or saved draft persistence is introduced. Lock clears private DOM,
  drafts, state and credentials, and invalidates/aborts old requests.
- Duplicate sends share an admission guard; retrying unchanged text after a
  failed request reuses its durable request ID. A new draft typed during an
  admission is not cleared by the prior response.
- Only one state poll is active at a time. Continuity and skill reads have
  request ordering guards. Response handlers recheck the session before changing
  private state or starting another request, even when a response already
  fulfilled before Lock. Older session responses cannot restore private data.
- Charter drafts survive tab changes. A version conflict keeps the draft and
  requires explicitly loading the saved charter before a new save. Edits typed
  during a save are retained.
- Dynamic content is rendered as text, including model output, source and skill
  instructions. Existing CSP, same-origin checks, bearer authentication and
  approval endpoints are unchanged.
- Resizing from desktop to a narrow screen keeps only one panel open: the
  focused panel, or the inspector if focus is elsewhere. Focus moves out of the
  covered conversation, and Escape returns to it.

## Remaining limits

This does not add a new owner identity/login system, provider sign-in, API
billing fallback, autonomous activation, full historical chat search, per-item
memory erasure, source-event browser, direct belief editing, charter history,
backup/restore, native mobile installation or deployment. Bridge contact alone
is not proof of a valid provider login. Live sign-in and production checks remain
separate owner-authorized work.

Run `npm run format:check`, `npm run check` and `npm run test:runtime`. The optional
`TEST_BROWSER=true` stage exercises the real browser and saves desktop/mobile
screenshots when Chromium can launch. A DOM fixture test is not visual QA.
