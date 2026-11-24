# AI Space + Connections: design decisions

Companion to `SPEC-AI-SPACE.md` and `SPEC-CONNECTIONS.md`. Each decision says
what was chosen and why, so a reviewer can disagree with the reason.

## Where it lives

- **Projects live on Desks.** A project is a row keyed by `desk_id`; the Desk
  gets a new view mode, **AI Space** (beside Canvas, Columns, Workcentre…). The
  canvas stays mounted underneath, exactly like Columns. Existing navigation
  is untouched; two rows were added beside Home: **AI Space** (the
  cross-project home) and **Runs**. Home's own "Home" row is unchanged.
- **Desktop only.** `aiSpaceAvailable()` hides every entry point in the browser
  runtime and in share windows, and the share window refuses every `aispace:*`
  channel first (`PRIVATE_NAMESPACES` in `src/web/api/readOnly.ts`), reads
  included. Test: `aispaceBoundaries.test.ts`.

## Data

- **Local-only `ais_*` tables** (`src/main/aispace/schema.ts`). Not in
  workspace sync, no sync columns, no foreign keys into `nodes` (deleting a Desk
  leaves the project's history intact; `ciDeleteSiteLock` stays at 13). The UI
  says so: "Stored on this Mac only."
- **Append-only where history matters.** Output versions and the activity log
  refuse UPDATE and DELETE by trigger, like the event store. Pointers (latest,
  approved, published) move; versions never change.
- **Own activity log, not the `events` table.** The event store grows forever
  and is spec-bound (PLX-EVT); AI Space writes many small events (run steps,
  invocations) that belong to this feature.
- **One transaction per change.** Every mutation writes its record and its
  event together, so the log can be replayed to rebuild any moment (`stateAsOf`).

## Impact

- Pure functions over a project snapshot (`src/shared/aispace/impact.ts`). The
  current view and "As of" call the same code on the same records.
- **Recorded vs inferred, never blurred.** Recorded = a run's manifest says it
  consumed that version ("Used this version"). Inferred = the old value's text
  appears in an output with no recorded link ("Possible match"), always shown
  with the exact excerpt and never acted on automatically. A person can confirm
  (it becomes recorded) or dismiss (it disappears); the judgement is a resolved
  suggestion, so it is on the record.
- **Ordering by consequence:** decisions due → material conflicts (an approved
  or published output still on the old input; a run due within two days on an
  old input) → revisions ready → possible matches → completed work.

## Automation (the spec's "first decision to revisit")

- Automatic draft fixes only for **recorded** dependants, only when the
  project's authority allows drafts, within budget, at most
  `maxAutoFollowUps` per change (default 3). They create **draft versions**;
  approving, publishing and sending always need a person. A second
  disagreement on a topic stops automatic follow-ups on that topic.
- Only a person approves a decision (`approveDecision` refuses agents).

## Runs

- **Durable and idempotent.** Each run has a unique idempotency key; a repeat
  returns the existing run. One run can add at most one version per output.
- **Background (OpenAI Responses, `background: true`)** is the trackable
  background agent: the external id is saved, polled, cancellable, and picked
  up after a restart. Runs Plexii itself was executing when it closed are
  marked interrupted with their verified progress, and are **never re-sent
  automatically** (that would bill twice).
- **Stale writes are held.** If the target output changed while a run worked,
  the draft is kept on the run and a person decides.
- **Retry and hand over are new runs** linked by `handover_of`; a hand-over
  carries the action history. Choosing the new connection is the approval for
  a different provider, payer or destination.

## Branches and requests

- **Branches** start from a named snapshot (approved brief + current output
  versions). The Desk header picks Main or a branch; new tasks and runs land
  there and Outputs filters by it. "Compare branches" shows two directions side
  by side (outputs, the sources they rest on, tasks left) and brings a selection
  back to main with a diff. If main moved during the review, the store refuses
  the write (stale-write rule) and the person resolves it first.
- **Agent needs information:** a model's `NEEDS INFO: <question>` line becomes
  an open request (up to three per run) and is stripped from the saved draft.
  A later source matching at least two of its topic words (or its only one) is
  supplied and delivered once; the requester drafts a revision citing what the
  source supports. A run that only asks waits instead of saving an empty
  version. The line only records a question: it can't grant or start anything.

## Connections

- **One connection = one credential/identity**, grouped visually by provider.
  Multiple identities per provider are normal ("Personal Claude", "SaaSMouth
  Claude").
- **Vault:** `userData/connection-secrets.json`, safeStorage (Keychain key),
  atomic writes, one entry per connection (MCP OAuth tokens as one JSON value so
  a rotation lands atomically). Only the broker reads it, at call time. No IPC
  returns a secret; the renderer sees a last-four hint.
- **Verify read-only before storing.** Anthropic and OpenAI keys are checked by
  listing models (free). A failing key is never stored. Rotation and reconnect
  verify the replacement first and refuse a different account (it becomes a
  separate connection).
- **Capability labels only after a check passed** on that connection.
  Catalogue entries carry an honest certification basis: model APIs, MCP and
  Notion are "conformance-tested" against local servers speaking the documented
  protocols; none is "certified" until a live check on a real account passes.
- **Grants** name the project, agents, exact operations (read vs write kept
  separate), data filters, approval (writes ask each time by default) and
  expiry. A grant never crosses workspaces. Policy is checked for every call,
  including calls a model asked for, so untrusted text can't widen access.
- **Budget:** estimate reserved before dispatch, settled with reported usage.
  Claude estimates use the verified table in `src/main/ai/aiCost.ts`; OpenAI has
  no verified table here, so its amount shows **Unavailable** (tokens still
  Reported) and a project with a budget asks before an un-estimable run.
- **Egress:** one gate (`src/main/aispace/net.ts`): https only, origin-pinned
  credentials, DNS check against private ranges, no cross-origin redirects,
  timeouts. Loopback MCP only for an address the person typed ("On this Mac").
- **MCP:** hand-written client (no SDK), Streamable HTTP, MCP authorisation
  2025-06-18 (protected resource metadata, AS metadata, dynamic registration,
  PKCE S256, `resource` on authorize and token, state bound to user, workspace
  and attempt). Tools are snapshotted per connection; a changed schema or
  endpoint goes back to review; a server's read-only hint is advisory only.
  Sampling, elicitation and roots are refused.
- **Direct app API:** declarative operations (schemas, read/write, scope, one
  destination, rate limit, timeout, retry rule). Notion is first. A write whose
  outcome is unknown is recorded **uncertain** and blocks an identical retry
  until a person reconciles it.

## Known limits (stated, not hidden)

- Nothing has run against the real providers yet: every adapter is tested
  against local servers built from the documentation. A live check needs keys.
- Local MCP (stdio) and webhooks are Release 2.
- AI Space data does not sync between devices yet.
- The DNS check and the connection are two lookups; the origin pin still keeps
  credentials on the approved hostname.
