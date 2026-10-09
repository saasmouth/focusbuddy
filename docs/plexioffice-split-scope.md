# Scoping: splitting PlexiOffice into its own product

Status: scoped, direction chosen, not started. Date: 2026-06-21.

## Decision (locked 2026-06-21)

- **Architecture: Option B — real split.** A monorepo with a shared `@plexi/core`
  platform package and a `@plexi/office` editors package, consumed by two app
  shells (`apps/plexidesk`, `apps/plexioffice`). Two genuinely independent,
  separately-shippable apps that share one platform.
- **Document data model: cloud documents.** Documents move server-side on the
  signal server; both apps (and later the web) sync to them. This is what lets the
  two separate apps stay tightly integrated, including embedding a live office doc
  on a PlexiDesk canvas.

The concrete execution plan for this chosen direction is below; the option
analysis that led here is retained further down as the rationale of record.

## The idea

Make **PlexiOffice** (the document, spreadsheet, and slides suite) a distinct,
installable desktop product that **integrates tightly with PlexiDesk**, with the
two shipping as **two separate apps**. PlexiDesk stays the spatial canvas /
focus workspace; PlexiOffice becomes a focused "Word + Excel + PowerPoint" app
for people who mainly want the editors.

This document scopes what that takes, the realistic options, the effort, and the
decisions that have to be made before any code moves.

## What's actually there today (measured)

The Office suite is already a cohesive slice of the code, but it sits on top of a
large shared platform.

**Office-exclusive — cleanly separable (~16K LOC, ~65 files):**
- Editors: `components/documents/` (DocEditor, SheetEditor, SlidesEditor + their
  `editor/`, `sheet/`, `slides/` subtrees) ≈ 5,800 LOC.
- Office libs: `lib/sheetFormula.ts` (760), `sheetFill`, `sheetBody`, `sheetFormat`,
  `docHtml`, `docFind`, `docCollabClient` ≈ 1,400 LOC. The formula engine is used
  **only** by the sheet editor.
- Main process: `officeDocx.ts`, `sheetIo.ts`, `slidesIo.ts`, `db/documents.ts`,
  `ai/sheetParse.ts` ≈ 760 LOC, plus 7 office AI functions in `ai/anthropic.ts`
  (`generateDocument`, `suggestDocContent`, `rewriteSelection`, `suggestSheetColumns`,
  `suggestFormula`, `fillSheetRange`, `generateSlideElements`) ≈ 610 LOC.
- Shared types/data: office types in `shared/types.ts` plus `slideThemes`,
  `slideTemplates`, `slidesMigrate` ≈ 600 LOC.
- The Documents views (`DocumentsView`, `DocumentEditorView`, `LiveDocEditorView`).
- ~20 office test files (~6K LOC of tests).

**Genuinely shared with the Desk (~850 LOC):** `tableSelection`, `tableFilter`,
`tableImport`, `tableAiBuild`, `gridClipboard`. Note the **TableWidget is a Desk
canvas component, not Office** — it just reuses these grid utilities.

**The platform layer both products need (the real work):**
- One SQLite DB (`focusbuddy.db`) holds documents alongside desks, widgets, tables,
  files, focus sessions, collaboration.
- The AI client + credit proxy + model routing (one Anthropic client, account-level
  credit balance) in `ai/*`.
- Auth/account + tier capabilities (signal server `focusbuddy-signal.fly.dev`,
  encrypted session token in main).
- Real-time collaboration (live docs, messaging) over the same signal server.
- The file manager (documents can be "filed" into folders via `fb_files`).
- Theme, settings, auto-update, the Electron shell (single window, client-side view
  routing), and the `@shared` types.

**Architecture facts that help:** it's a **single-window** app with clean
client-side view routing (`stores/view.ts` → `MainPane`), and **documents are
global/standalone** — an `FbDocument` has no `taskId`. A widget embeds a doc by
storing the document id in `widget.content`. Only **5 desk-side files** import from
`components/documents/` (the `OfficeDocWidget`, the add-dialog, the two editor
views, and one helper). So the editors are loosely wired into the desk.

**The one integration that must survive:** `OfficeDocWidget` renders a full office
editor **inline on the canvas**, backed by the shared document store, with edits
syncing. That "lightweight office docs live on your desk" behaviour is the core of
the tight integration.

## Progress log

**Round 1 (2026-06-21) — Phase 0 started, server side complete.**
- Signal server (`projects/focusbuddy-signal`): new `cloud_documents` table
  (`db.ts`), a `CloudDocumentsStore` (`cloudDocuments.ts`) with last-write-wins
  sync, a strictly-monotonic server clock so no change is ever missed/duplicated,
  optimistic-concurrency via per-doc `rev`, and tombstone deletes. REST routes in
  `server.ts`: `GET /documents`, `GET /documents/sync?since=`, `GET/PUT/DELETE
  /documents/:id`, all account-scoped via the existing bearer-token auth. Full
  flow test (`tests/cloudDocumentsFlow.mjs`) added to the suite — all green.
- PlexiDesk (`projects/focusbuddy`): typed wire client `lib/cloudDocsClient.ts`
  (list / sync / get / put-with-conflict / delete). Not yet wired into the
  document store — that's next.

**Round 2 (2026-06-21) — direction confirmed (LEAN split), Phase 0 complete.**
Decision refined: do the **lean** split — extract only what the standalone app needs
(`@plexi/office` editors + a minimal `@plexi/runtime`: auth/AI/theme/signal) and use
the cloud-documents API as the integration contract, rather than a big-bang
`@plexi/core` extraction of the whole platform. PlexiDesk keeps bundling the editors
to embed docs on the canvas; the desk's DB / file manager / collaboration stay put.
- Signal server **deployed** (additive); live endpoints verified (401 = auth-gated).
- `upsertDocument` (insert-or-replace by explicit id) + `documents:upsert` IPC +
  preload, so cloud docs land locally under their own id (id alignment).
- `lib/cloudDocsSync.ts`: pull on refresh, push on save/create/rename, delete
  propagation, server-wins on rev conflict — all behind a **default-off** feature
  flag (`fb.clouddocs.enabled`), so today's behaviour is unchanged. Local SQLite is
  the offline source of truth.
- Wired into `stores/documents.ts`. Pure merge seam unit-tested
  (`cloudDocsSync.test.ts`); documents e2e green (no regression).

**Round 3 (2026-06-21) — freeze used; boundaries + standalone app shell.**
- `@office` / `@runtime` boundaries established in place (barrels + vite/tsconfig
  aliases); every cross-boundary consumer (canvas embed, add dialog, doc + live-doc
  views) rerouted through `@office`. The desk now touches Office only through this
  surface, so the physical package extraction is just moving the alias targets.
- Standalone **PlexiOffice app shell**: a second renderer entry (`plexioffice.html`
  + `officeApp.tsx` + `PlexiOfficeApp`) — a focused Documents experience reusing the
  same editors (`@office`) + theme (`@runtime`) + documents store. Multi-entry build
  emits both `index.html` and `plexioffice.html`; the main process loads the office
  entry when `app.getName()` is PlexiOffice (or `PLEXI_APP=office` in dev).
- Second product identity: `electron-builder.plexioffice.yml` (appId
  `app.plexioffice.desktop`, productName PlexiOffice, own artifact/output) +
  `dev:office` / `dist:office:zip` scripts.
- Verified: typecheck + hooks + build (both entries) green; PlexiDesk documents e2e
  green (no regression). Commits `3226b57` (boundaries), `cea65ba` (app shell).

**Round 4 (2026-06-21) — standalone app proven + packaged; sync toggle shipped.**
- e2e `plexiOffice.spec.ts`: boots the build with `PLEXI_APP=office`, asserts the
  PlexiOffice shell renders (not the desk — no canvas), and creates/opens a sheet
  via the shared editor. `launchApp` gained an optional `env` override. Both green.
- Packaged the second product: `dist:office:zip` →
  `release-office/PlexiOffice-2.5.70-mac-arm64.zip` (ad-hoc signed). Output dir
  gitignored.
- Settings: a "Documents sync (beta)" toggle (`DocumentsSyncSection`) flips the
  cloud-docs flag. Commit `08ee833`.

**Round 5 (2026-06-21) — PlexiOffice can sign in and sync; release channel wired.**
The standalone app was a viewer of the local DB only; this round closes the
integration loop so it is genuinely the same account's documents as PlexiDesk.
- Sign-in surface: `OfficeAccountBar` (in `components/officeApp/`) is a minimal,
  self-contained email/password sign-in + create-account control that talks to the
  runtime account store directly (it does not reuse the desk's sign-in modal, which
  pulls in desk-only infrastructure). Signed in, it shows the account and a sign-out.
- `PlexiOfficeApp` now boots the account session (`useAccountStore.init()`) and turns
  cloud-docs sync ON by default on mount (PlexiOffice is cloud-first), and re-pulls
  whenever the signed-in account changes. So signing in on PlexiOffice surfaces that
  account's PlexiDesk documents, and edits push back.
- Release channel: `electron-builder.plexioffice.yml` gained a `publish` block on the
  same `saasmouth/focusbuddy` repo but `channel: office`, so electron-builder writes
  `office-mac.yml` / `office.yml` (never colliding with PlexiDesk's `latest-*`). The
  per-product `app-update.yml` electron-builder bakes in carries that channel, so the
  packaged office app's updater reads its own manifests with no code change.
- Verified: typecheck + hooks (406 files) + build (both entries) green; office e2e now
  3 specs (boot, create-sheet, and PO-3 asserting the sign-in surface) all green.

**Round 6 (2026-06-21) — first published office release, mac arm64.**
- Built on the office channel (`dist:office:zip`) and uploaded the three office
  assets (`PlexiOffice-2.5.70-mac-arm64.zip` + `.blockmap` + `office-mac.yml`) to the
  existing `v2.5.70` GitHub release. PlexiDesk's `latest-mac.yml` / `latest.yml` were
  left untouched; the office assets coexist by distinct names + channel.
- New repeatable gate `scripts/verify-office-release.sh` (+ `release:verify:office`):
  asserts every office asset is reachable (200) and the served `office-mac.yml`
  sha512 matches the served binary. Ran GREEN against the live release. Added
  `dist:office:release` (build + `--publish always` on the office config) for future
  cuts.
- Also installed the local build to `/Applications/PlexiOffice.app` for this machine.

**Round 7 (2026-06-21) — fixed: PlexiOffice quit on launch (shared lock).**
The first published build crashed within ~0.5s of opening. Root cause: the packaged
bundle embeds package.json `name: "plexii"` with no `productName`, so
`app.getName()` returned "plexii" for the office build too. PlexiOffice therefore
defaulted to PlexiDesk's userData directory and shared its single-instance lock, so
launching it while PlexiDesk was open made `requestSingleInstanceLock()` fail and the
app `app.quit()` immediately. The same root cause meant the renderer-selection check
(`app.getName().includes('office')`) was also broken.
- Fix in `src/main/index.ts` + new pure helper `src/main/appMode.ts`
  (`detectOfficeBuild`): identify the office build from `PLEXI_APP` (dev) or the
  executable path (packaged bundle is PlexiOffice.app / .exe), not `app.getName()`.
  For the office build, call `app.setName('PlexiOffice')` and pin userData to its own
  `…/Application Support/PlexiOffice` directory BEFORE the single-instance lock.
- `src/main/authProtocol.ts`: `registerHaptyxAuthProtocol({ claimProtocol })` so
  PlexiOffice no longer hijacks the `haptyx://` scheme from PlexiDesk (it still takes
  its own single-instance lock, now on its own userData).
- Verified by running the built main under the dev Electron with the live PlexiDesk
  open: the office process stayed alive (gotLock=true, userData=…/PlexiOffice) instead
  of quitting. New unit test `tests/unit/appMode.test.ts` (6 cases) guards the
  detection; office e2e still green. Rebuilt, reinstalled to /Applications, and the
  fixed assets re-published + `release:verify:office` GREEN.
- Consequence of the separate userData: PlexiOffice starts with an empty LOCAL cache
  and shows your documents only after you sign in AND cloud sync is on in both apps.
  PlexiOffice turns sync on by default; in PlexiDesk enable Settings → "Documents sync
  (beta)". This is by design — the apps share documents via the cloud, not a shared
  local DB.

**Still open (next rounds):**
- Windows office build: there is no `.exe` / `office.yml` yet (mac arm64 only). Needs a
  Windows CI build (pinned to windows-2022 per the node-gyp/Electron-37 constraint),
  then extend `verify-office-release.sh` REQUIRED with the win assets.
- Intel mac build (the published zip is arm64 only).
- Auth handoff convenience: a deep-link/shared-token so signing in on one app carries
  to the other without re-entering credentials (two apps can't both own `haptyx://` —
  add a `plexioffice://` handback). Today each app signs in to the same account
  independently, which already shares documents — this is a convenience, not a blocker.
- Two-machine cloud-docs round-trip proof with a real signed-in account (genuinely
  external; cannot be self-verified in this environment — must be done on two devices).
- A PlexiOffice app icon (the packaged build currently uses the default Electron
  icon).
- Optional: promote the `@office`/`@runtime` aliases to real workspace packages —
  mechanical now thanks to the boundary.

**Earlier next-round note (superseded by Round 3 above):** turn the flag on end-to-end, then start the lean extraction.
1. Add a Settings toggle for the cloud-docs flag; sign in on two clients and prove a
   doc round-trips (create/edit/delete) between them against the live endpoints.
2. Begin the **lean** package extraction (this is the step that needs the freeze):
   carve `@plexi/office` (editors + office IO + office AI + cloud-docs client) and a
   minimal `@plexi/runtime` (auth, AI client, theme, signalConfig). Define the
   boundary barrels, then move files.
3. Stand up `apps/plexioffice` on those packages + cloud documents; new identity +
   updater. Do NOT move the desk DB / file manager / collaboration.

## Execution plan (chosen direction: real split + cloud documents)

Sequenced so PlexiDesk stays green and shippable at every step; the big-bang
refactor is broken into reversible slices. Each phase ends on a verifiable gate
(typecheck + build + unit + e2e + `plexidesk-tester`).

**Phase 0 — Cloud document service (server-first, no app refactor yet).**
Add a documents service to the signal server: `documents` table + CRUD + a sync
endpoint, scoped to the account, with the live-doc collaboration model reused.
Wire the existing PlexiDesk document store to read/write it behind a flag (local
DB stays the fallback). This de-risks the hardest piece (data) before touching the
build structure, and ships value to today's single app immediately.
Milestone: a document created in PlexiDesk persists to the cloud and round-trips.

**Phase 1 — Monorepo skeleton.** Introduce a workspace (pnpm/npm workspaces) with
empty `packages/core`, `packages/office`, and move the current app to
`apps/plexidesk`, keeping it building byte-for-byte the same. No logic moves yet.
Milestone: `apps/plexidesk` builds and releases exactly as before from the new
layout.

**Phase 2 — Extract `@plexi/core`.** Move the platform into the package behind a
stable API: DB layer, AI client + credits + routing, auth/account, capabilities,
signal/collab client, file manager, theme, settings, updater plumbing, `@shared`
types. PlexiDesk imports it; stays green throughout. This is the bulk of the work
and risk.
Milestone: PlexiDesk runs entirely on `@plexi/core`; no platform code left in the
app shell.

**Phase 3 — Extract `@plexi/office`.** Move the editors, office main-process IO
(`officeDocx`/`sheetIo`/`slidesIo`), and the office AI functions into the package.
PlexiDesk imports it so `OfficeDocWidget` keeps embedding editors inline.
Milestone: the office e2e suites pass with editors served from `@plexi/office`.

**Phase 4 — Stand up `apps/plexioffice`.** New shell that boots into the Documents
experience, built on `@plexi/core` + `@plexi/office`. New identity
(`app.plexioffice.desktop`, product name, icons), its own GitHub release repo,
`latest-mac.yml`/`latest.yml`, and a `release:verify`-style gate.
Milestone: a signed PlexiOffice build installs, signs in to the same account, and
opens cloud documents.

**Phase 5 — Tight-integration polish.** Bidirectional deep links over the existing
`haptyx://` protocol ("open on desk" / "open in PlexiOffice"), shared session
handoff so one sign-in covers both, one AI-credits pool, and federated Cmd-K search
across the cloud documents. Decide PlexiOffice's SKU/tier here.
Milestone: from a PlexiDesk canvas you can open a doc in PlexiOffice and back, with
one login and one credit balance.

**Phase 6 — Verify + dual release.** Per-package unit + e2e, `plexidesk-tester` on
both apps, gated releases for both products.

### First safe slice to start with
Phase 0 (cloud document service) and Phase 1 (monorepo skeleton) are both low-risk,
reversible, and independently valuable. Phase 0 ships an improvement to the current
app even if the split paused; Phase 1 is pure restructure with no behaviour change.
Start with whichever you prefer; Phase 0 first is recommended because the data model
is the make-or-break dependency for everything after.

### Coordination requirement
Phase 2 (the `@plexi/core` extraction) is a tree-wide move that will collide with
other chats committing to this repo in parallel. It needs a short freeze window or
tightly-sequenced ownership. Phases 0, 1, 4, 5 are mostly additive and safer to
interleave.

---

## Option analysis (rationale of record)

## Three ways to be "two separate apps"

### Option A — Two builds from one codebase (fastest, lowest risk)
One repo, one codebase, **two electron-builder targets**: PlexiDesk and PlexiOffice,
each with its own `appId`, product name, icon, and GitHub release stream /
auto-updater. A launch-mode flag makes PlexiOffice boot straight into the Documents
experience (desk nav hidden); PlexiDesk boots into the canvas with Office embedded
as today. Everything (DB schema, AI, auth, collaboration) is the same code,
configured differently.
- Effort: small — roughly a few days.
- Pro: real, separately-branded installable apps now; zero risk to shared logic.
- Con: it's the *same program* wearing two coats. Two installs don't share data at
  runtime unless pointed at the same userData dir; it isn't a truly independent
  product line, and you can't evolve the two apps' platforms apart.

### Option B — Monorepo with a shared core, two real apps (recommended)
Restructure into packages: `@plexi/core` (the platform: DB layer, AI client +
credits + routing, auth, capabilities, signal/collab, file manager, theme, updater
plumbing, shared types), `@plexi/office` (the editors + office main-process IO + AI
functions), and two thin app shells (`apps/plexidesk`, `apps/plexioffice`). Both
apps depend on `@plexi/core`; PlexiDesk also depends on `@plexi/office` so it can
keep embedding editors inline; PlexiOffice is the standalone office app.
- Effort: substantial — roughly 3–6 weeks, plus the data-sharing model below.
- Pro: two genuinely independent apps that still share one platform; the embed-on-
  canvas integration is preserved because both pull the editors from one package;
  you can ship, version, and price them separately.
- Con: a real refactor touching the whole tree — risky in a repo several chats
  commit to in parallel; needs a freeze or careful sequencing.

### Option C — Full duplicate (not recommended)
Fork the office code into a brand-new app and re-implement/duplicate the platform.
Permanent divergence and double maintenance. Only sensible if PlexiOffice is meant
to leave the PlexiDesk platform entirely.

## The harder question: how do the two apps share documents?

Two separate apps means two userData dirs by default. "Tight integration" requires
a shared document store so a doc created in one shows up in the other and can be
embedded on a PlexiDesk canvas. Three models:

1. **Cloud documents (recommended for true cross-app + cross-device).** Documents
   live on the signal server; both apps sync. Cleanest integration story, also
   unlocks web access later. Adds backend work (document service + sync/conflict),
   roughly 1–2 weeks on top of Option B.
2. **Shared local store.** Both apps point at one on-disk document DB (or a small
   local "documents service" one app exposes). Avoids backend work but two
   processes on one SQLite file needs careful WAL/locking, and only works same-
   machine.
3. **Handoff only (loosest).** Each app owns its own docs; PlexiDesk shows a doc
   and an "Open in PlexiOffice" deep link (the `haptyx://` protocol already exists
   for auth and can carry a document id). PlexiDesk would embed a **preview** plus
   the deep link rather than the live inline editor. Lowest effort, but it weakens
   the "office docs live on your desk" promise.

## Cross-cutting work either real-split option needs

- **New identity + release pipeline for PlexiOffice:** its own `appId`
  (`app.plexioffice.desktop`), product name, icon set, GitHub release repo,
  `latest-mac.yml` / `latest.yml`, and a `release:verify`-style gate. (PlexiDesk's
  is in `electron-builder.yml` + `RELEASE.md`.)
- **Auth/capabilities sharing:** both apps authenticate against the same account.
  Either share the session token via the existing deep-link handoff, or add a
  per-app sign-in. Decide whether PlexiOffice is its own tier/SKU or rides the
  PlexiDesk subscription.
- **AI credits:** one account-level balance. The office AI (formulas, generate,
  rewrite) must draw from the same pool — straightforward if both apps use
  `@plexi/core`'s AI client against the same account.
- **Collaboration:** live docs already run on the signal server; PlexiOffice owns
  the live-doc session for documents, PlexiDesk keeps live canvas/folders.
- **Search:** PlexiDesk's Cmd-K indexes document bodies today. If docs move to a
  cloud/separate store, search federates via the document service or an IPC/deep
  link into PlexiOffice.

## Recommended path + phases (Option B + cloud documents)

1. **Decide + freeze the interface.** Lock the product split, the data model
   (recommend cloud documents), tiers/pricing, and identities. No code yet.
2. **Carve `@plexi/core`.** Move the platform layer into a package with a stable
   API; keep PlexiDesk building against it green the whole way (this is the bulk
   of the risk and the work).
3. **Carve `@plexi/office`.** Move the editors + office main IO + office AI into a
   package; PlexiDesk imports it for `OfficeDocWidget` (embed preserved).
4. **Stand up `apps/plexioffice`.** New shell, new identity, boots into Documents;
   reuses `@plexi/core` + `@plexi/office`. New release pipeline + updater.
5. **Document service + sync** (if cloud model): documents move server-side; both
   apps sync; search + file-manager federate.
6. **Integration polish:** deep links both directions ("open on desk" / "open in
   PlexiOffice"), shared auth handoff, capability gating, one credits pool.
7. **Verify + ship:** unit + e2e per package, `plexidesk-tester` on both apps,
   gated releases for both.

## Honest effort summary

- Option A (two builds, one codebase): **days.** Real separate installs, but a
  cosmetic split.
- Option B (shared core, two real apps): **~3–6 weeks** of focused work for the
  refactor, **+1–2 weeks** if documents go cloud-backed. This is the path that
  yields two genuinely independent products that stay tightly integrated.
- Option C (full duplicate): not recommended.

## Risks / honest caveats

- This repo is committed by several chats in parallel; a tree-wide package refactor
  (Option B) needs a coordination freeze or it will thrash. See
  [[plexii-concurrent-chats]].
- The DB is the deepest coupling. Splitting document data cleanly (especially the
  file-manager `fb_files` doc-references and standalone tables) is the make-or-break
  detail.
- Auto-update for a *renamed* bundle is the historical footgun here; a new product
  needs a correct manifest set from day one, gated by a verify step.
- "Tight integration" and "two separate apps" pull in opposite directions — the
  cloud-document model is what reconciles them; the handoff-only model is cheaper
  but loosens the embed-on-canvas promise.

## Decisions needed before starting

1. Architecture: Option A (fast, cosmetic) vs Option B (real split, recommended).
2. Document data model: cloud documents (recommended) vs shared-local vs handoff.
3. Does PlexiDesk keep embedding office editors inline on the canvas, or move to a
   preview + "Open in PlexiOffice"?
4. Commercial: is PlexiOffice its own SKU/tier, or bundled into PlexiDesk plans?
