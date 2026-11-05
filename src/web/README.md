# Plexii in the browser

The desktop app, running in a tab, against the same account and the same synced
workspace. Not a viewer and not a rewrite: it builds the renderer that ships on
the desktop, unmodified, and gives it the data layer that ships on the desktop,
unmodified.

## Why it is shaped like Electron

The renderer reaches everything through `window.api` and has no Electron import
and no Node builtin anywhere in it. That one fact is what makes this possible,
and it decided the architecture:

| Electron | Browser |
| --- | --- |
| renderer process | the page |
| preload + IPC | `src/web/api/bridge.ts` over `postMessage` |
| main process | a dedicated Worker (`src/web/worker/`) |
| better-sqlite3 on a file in userData | SQLite-WASM on OPFS |

The Worker is not a detail that could be moved to the page later. SQLite's OPFS
backing needs `FileSystemSyncAccessHandle`, which exists only inside a Worker,
and the data layer's API is synchronous. Both point to the same place. Because
`window.api` was already asynchronous, the swap is invisible to the renderer.

## What is shared, and why it must be

`src/main/db/schema.ts` and `src/main/db/migrations.ts` are executed by **both**
runtimes. A workspace item's sync body is its table row minus the sync columns,
and `applyRemote` writes the intersection of the body and the local table -- so
two runtimes with different schemas do not fail loudly, they silently drop each
other's columns.

This is not hypothetical. A first version of the browser database ran
`db.exec(SCHEMA)` alone, on the reasonable-sounding argument that a database
created today is born current. It is not: 135 `ensureColumn` calls follow
SCHEMA, adding `widgets.trashed_at`, `widgets.pinned`, `nodes.org_id`,
`nodes.archived` and more -- every one of which travels in sync. The symptom
would have been widgets losing their pinned state and deletions not sticking,
visible only after a round trip, with no error anywhere.

## Running it

```
npm run web:build      # regenerates the channel map, then builds
npm run web:preview    # serves out/web on :5180
npm run web:dev        # vite dev server
```

`scripts/derive-web-channel-map.cjs` reads the preload and emits the
`window.api` path -> IPC channel map, so a channel renamed on the desktop cannot
silently stop working here.

## Many tabs, one database

OPFS access handles are exclusive: the tab that opens the workspace holds it,
and a second tab asking for the same file is refused. The tidy answer -- a
SharedWorker owning the single connection -- does not work, because
`createSyncAccessHandle` is dedicated-worker only and `SharedWorkerGlobalScope`
genuinely lacks it (measured, not assumed).

So exactly one tab holds a Web Lock, owns the Worker and therefore the database.
Every other tab sends its calls there over a `BroadcastChannel`. When the leader
closes, its lock releases, another tab wins it and opens the database itself.

The one edge that cannot be hidden is a call that was already running when the
leader vanished: its answer is lost, and re-sending it would be at-least-once
delivery on top of writes -- a closed tab could turn one `nodes:create` into two
desks. So a call that was merely *queued* is passed to the new leader, and a
call that was genuinely *in flight* fails with a message saying so. Losing a
call is recoverable; silently duplicating a write is not.
`tests/unit/dbClientLeadership.test.ts` pins that distinction.

## What works

Sign-in and sign-up against Signal (including a second factor), the full app
shell, the desk canvas, the New Desk flow, several tabs at once, the Drive with
real file bytes, provider keys held server-side, desk share links, and the
workspace sync loop in both directions. A desk created in a tab reaches the server and is applied by the
desktop's own `applyRemote` into real rows with every column intact -- proven by
`scripts/verify-cloud-roundtrip.mjs` feeding
`tests/unit/cloudDesktopRoundTrip.test.ts`.

## Sharing a desk with someone who is not here yet

This is the thing the cloud runtime made possible. Before it, "add this desk to
your account" meant "download a desktop app first", which is a brutal ask of
someone who has just clicked a link from a colleague.

There are three ways to share, and they answer different questions:

| | who it is for | what they get |
| --- | --- | --- |
| Public projection | anyone, no account | a rendered read-only view |
| Invite by email | someone whose address you know | live access, once they sign in |
| Claim link | someone you cannot name yet | live access, after they sign up |

A desk share link is the only way in. The owner mints one from the desktop; the
recipient opens it with no account, reads and rearranges their own copy, and is
told where that copy lives. A link lasts 48 hours by default, or a window the
owner picks, or never expires -- the standing link a sender gives to every
prospect. Signal stores "never" as a far-future sentinel and answers `expiresAt:
null`; the page then shows no countdown and wipes nothing on a timer (a revoked
link still takes the copy with it).

The owner can replace what a link shows without changing it ("Update link" in
the share sheet, `PUT /shares/ephemeral/:token`). A returning visitor whose copy
is older than the link's `updatedAt` gets the new version without being asked
if they never changed their copy, and a banner offering it if they did -- see
`api/shareVersion.ts` for how "changed" is known. Deciding that costs the sender
nothing: a returning visitor reads the offer (metadata, not counted as an open)
and downloads the bundle only to unpack it or to take a newer version. "Save
desk file" fetches it when it is clicked.

Four rules hold the visitor's copy, because it is the one thing here that
cannot be got back:

- **One record, and one desk, per link.** Every link opened in a browser
  unpacks into the same database, but each link keeps its own record
  (`fb.share.links[token]`: version, declined, edited, rootId, offer) and its
  own desk's rows. Replacing a link's desk removes that desk's rows first --
  the import is `INSERT OR IGNORE`, so rows left in place would keep the old
  version on screen -- and nothing else: other links' desks, and documents or
  files they also show, are not touched (`worker/shareCopy.ts`, served on the
  share page's own `shareCopy:*` channels). A desk on screen in another tab is
  never replaced under it (Web Locks, `api/shareDesk.ts`). A first visit to a
  link whose desk is already here -- from another link to the same desk, or
  from an older build -- replaces it only if it is known to be untouched, and
  otherwise keeps it and asks.
- **Only a link that is gone takes its copy, and only its own.** Signal's own
  404 `unknown` or 410 `revoked`/`expired` for a link this browser holds a desk
  from takes that desk: the whole store when nothing else is in it, otherwise
  just that desk (`share.whenRefused`, `shareDesk.dropLinkCopy`). A link this
  browser never unpacked takes nothing -- a bare visit, a mistyped or truncated
  token, somebody else's revoked link. A token is read exactly as Signal mints
  it (32 base64url characters) with anything a mail client stuck on the end
  ignored, so `/s/<token>.` and `/s/<token>)` open the link instead of looking
  like no link at all. A 503 `unavailable` (a live link whose bundle the server
  cannot read), a proxy page, a rate limit or a dropped connection keeps the
  copy: a returning visitor's copy opens as they left it, under a "temporarily
  unavailable" notice, and a new visitor is told to try again -- never that the
  link expired (`share.refusalFrom`). A new version is fetched before anything
  of the old desk is removed, and a version that would not import removes
  nothing.
- **Database first.** Emptying the whole store removes the SQLite pool
  (`.plexii`) before the file bytes; if the database will not go, nothing else
  is touched (`share.emptyOpfs`). A tab that has the database open never
  empties the store itself: it removes its desk's rows and leaves the rest to
  the start of the next load (`share.finishPendingWipe`).
- **Older builds' copies are kept.** What earlier builds stored (one marker
  for the whole browser) becomes that link's record on first load; desks those
  builds unpacked without a trace are treated as present until the database
  shows they are not (`shareVersion.migrateLegacyRecords`).

What a link can carry is fixed by Signal: 8 MiB of request body. The desktop
packs to 7.5 MiB measured as the bundle actually travels (a JSON string inside
the JSON body, so escaped twice, with files in base64), leaves the largest files
out first and names each one in the share sheet, and turns a 413 into a
sentence (`deskBundle.buildDeskBundle`, `ephemeralShareClient.linkRefusal`).

Desk share links replaced desk claim links, which minted a
permanent grant for a stranger who signed up -- a forwarded URL becoming lasting
access to a live desk.

Claiming converts the token into an ordinary `resource_acls` grant, and from
that moment nothing about the share is special. It appears in the access list,
rides `/workspace/shared/sync`, and is revoked like any other grant. A sharing
mechanism that keeps its own parallel notion of access is one that eventually
disagrees with the real one.

Revoking a link stops it being claimed again and does **not** touch the access
of people who already used it -- they are ordinary grantees now.

### How a link presents the desk

A sender chooses two things in the share sheet ("Anyone with the link" → "A desk
they can use"), and the link carries them in the bundle's optional
`presentation` field (`src/shared/sitePresentation.ts`). An older share page
ignores the field and shows the desk as it always did, so the format version
does not move.

**The view it opens in.** Canvas, Workcentre or Columns, and whether that is
the only view ("Let them switch to other views", off by default). Views and the
Columns setup are the sender's local preferences, so they travel in the bundle;
the share page makes them the visitor's starting point while unpacking
(`shareDesk.adoptLocalSetup`), and a locked view is held for the visit by the
renderer (`stores/deskView`'s `lock`, never persisted). The Workcentre
arrangement lives in `desk_layouts`, keyed by account -- and a visitor has none
(the renderer uses `'local'`), so the sender's row was never read: the
Workcentre came up auto-arranged with the tiles the sender hid showing. The
Worker now copies the sender's row to `'local'` when it unpacks
(`shareCopy.adoptPresentation`), keeping the arrangement but not the sender's
camera: the canvas opens on the top-left of the content. It also creates
`desk_layouts` before importing, because that table is made on first use and
`importDeskBundle` skips a table that does not exist -- on a first visit every
layout row was being dropped.

**What each website shows.** On the desktop a browser widget is a real browser;
here it can only be an iframe, and most sites refuse to be framed. Of the 11
sites on a real standing link, nine refused, and the visitor saw nine "refused
to connect" boxes -- worse, `EmbeddedSiteWidget` rendered without its
`WidgetFrame`, so on the canvas all of them were piled in the top-left corner,
and the Workcentre and Columns used the desktop `<webview>` (blank) for every
website. The sender's desktop now visits each site when the link is made
(`main/sitePreviewLoader.ts`): first framed exactly as this page frames it
(same sandbox, same referrer), then -- if the browser refuses -- on its own,
in a hidden window with a new in-memory session, so no account of the sender's
can appear. Each site becomes one of:

| | when | the visitor sees |
| --- | --- | --- |
| live | the framed look displayed | the site, framed |
| embed | the site has an official embed (YouTube, Vimeo, Loom, Spotify, TradingView), or -- when the site blocks frames -- a free TradingView widget does its job (a screener, a futures board, a crypto market list, an economic calendar, a news feed; `equivalentEmbedFor`) | that, live, labelled with what it is and opening the original site |
| picture | framing refused, the page answered | a picture labelled with when it was taken, opening the real site |
| link | no usable picture (a bot wall, a rate limit, or the sender's choice) | a card that opens the site |

Pictures travel inside the presentation, not as Drive files, and land in the
file store under an id derived from the widget (`sitepic-<widgetId>.jpg`), so a
desk's pictures go wherever its widgets go: replaced with a new version,
removed with the desk (`shareCopy.deskRows`). Nothing a bundle says is trusted:
`readPresentation` keeps only entries for widgets the bundle brings, http(s)
addresses, pictures under their own widget's id, and the Worker writes only
bytes that are a JPEG. The embed a visitor sees is worked out from the address,
never taken from the bundle -- which is also why a link sent before any of this
gets the official and TradingView embeds the moment the share page is deployed,
with no new bundle. Pictures are packed after the desk's own files,
smallest first, within the same link budget; one that does not fit becomes a
link card and the sender is told.

`node scripts/verify-site-pictures.mjs` drives the real loader in Electron
against local pages with known framing behaviour (including a page that only
refuses when requested as a frame, and one that refuses the share page's
referrer); `--live URL…` reports real sites as well.

### A read link that can be copied

A desk shared as "a snapshot they can read" lives at
`view.plexiidesk.com/share/<token>`: a frozen JSON snapshot (16-character token,
`lib/shareTokens.ts`). With scope `copy` the sender said anyone may have it, but
having it used to mean signing up there and installing the desktop app to find
it in an inbox -- a dead end for a prospect with no Plexii at all. The viewer's
"Open this desk in your browser" now sends them to `/share/c/<token>` here, and
this page opens it exactly as it opens a `use` link.

- **The token.** `/c/` plus exactly 16 letters of the alphabet the desktop
  mints with, followed by anything that cannot be part of a token
  (`readShare.readTokenFromUrl`). A `/s/` link and a `/c/` link can never be
  read as each other: different path, different length, different alphabet.
- **The routes.** `GET /share/<token>?meta=1` for the offer (kind, scope,
  title, expiry; not counted as a view), and `GET /share/<token>` for the
  snapshot, once, when the desk is unpacked. Signal answers both from the
  plexiidesk.com origins. It answers unknown, revoked and expired alike (404
  `{ ok: false }`), so the page says "no longer working" and no more.
- **The gate.** Only `scope: 'copy'` and `kind: 'task'`. A `view` link is
  refused for copying ("shared to be read, not copied") with a button back to
  the viewer, and so is anything that is not a desk. Neither removes anything.
- **The desk.** The snapshot is made into a desk bundle (`snapshotDesk.ts`) --
  the sender's ids kept, every field read as untrusted -- and from there it is a
  `use` link: `shareDesk.openLinkDesk` with the snapshot as its source, the same
  per-link record, the same duplicate checks, the same "a gone link takes only
  its own copy". The desk id is inside the snapshot, so a first visit fetches it
  before opening and hands that same text on (`readShare.resolveFirstVisit`); a
  return visit finds the desk from its record and downloads nothing.
- **What it does not have.** A snapshot carries no documents or files behind
  widgets that point at them, no connector wires, no view or Workcentre
  arrangement and no website pictures, so websites show their official or
  TradingView embed where there is one and a live frame otherwise. Tables keep
  their select choices only in snapshots made since they travel
  (`shareSnapshot.serializeColumn`); older ones show those cells empty, as the
  app shows any value whose choice it cannot find.

The marketing site serves `/share/c/*` with the share app
(`plexii-site/compose.mjs`), as it does `/share/s/*`.

### Two gates, and they are not the same gate

Signing up is open to anyone. Reaching a desk is not, and never by anything
other than the owner's own act of sharing. Those were briefly conflated, with
the second enforced by closing the first; that was wrong in both directions and
is gone.

The desk gate has a rule worth knowing about: **only someone who holds a desk
may share it.** Registering a desk root decides which bucket its rows live in
and who may share it, and it used to be first-come -- knowing a desk id was
enough to take one, which let a stranger permanently prevent the real owner from
ever sharing their own desk. Possession is now required, and the proof is the
personal bucket: a desk you have is a desk you have synced. Both sharing paths
therefore sync before they register, so a desk created moments ago can still be
shared. `focusbuddy-signal/tests/deskOwnershipFlow.mjs` holds this.

## What does not, and why

**Only Anthropic's key can be set from the browser.** The way to have BYOK in a
browser is for the key never to be in the browser: it goes from the input box to
Signal over HTTPS, is encrypted at rest (AES-256-GCM, master key in the server's
environment, never in the database), and is used in-process when Signal proxies
the call. Nothing reads it back -- the routes report only whether a key is
configured and its last four characters. A user's own key is not billed as
credits; without one, calls fall back to platform credits as before.

OpenAI, Tenor, Pexels and remove.bg still refuse, and will until each has a
proxy of its own. Storing a key the server cannot use on the caller's behalf
would move the risk somewhere new without buying anything.

**The Attention layer is off.** Not for want of tables --
`applySchemaAndMigrations` calls `ensureWorkItemSchema`, so a browser database
has `wi_local`, `wi_deliveries` and the `work_item` columns on `nodes`. What is
missing is the gate: the desktop reads it from a JSON file beside the database
and holds the per-org migration attestation there too, and a tab has neither.
Turning it on means porting both to server-held state.

**Context Engine events are not emitted.** The desktop's handlers emit them
alongside the write; these call the same db functions without that step. It does
not affect what is written or synced. The list is `PARITY` in
`src/web/worker/handlers.ts`.

**Onboarding persists.** `onboarding:record` is served, writing the same
`usage_counters` rows as the desktop. (`db/telemetry.ts` reads the app version
from the `__APP_VERSION__` define rather than Electron's `app`, which is what
lets it load here at all.)

**A share link needs somewhere to point.** `VITE_CLOUD_APP_URL` is the address
of the deployed browser app, and with it unset the sharing controls disable
themselves and say so. Minting a link that 404s for the recipient while looking
perfectly fine to the sender is the worst kind of broken, because the sender
never finds out.

## The Drive

Files work, bytes and all. `db/files.ts` -- folders, tags, smart folders, trash,
search, some 900 lines -- is the same code on both runtimes; only where the
bytes sit differs, and that is one swapped module. The desktop writes them into
userData; the browser writes them to OPFS under `plexii-files/`, named by the
same id + extension, so a file synced from one lands where the other looks.

That swap is why `FileBlobStore` is asynchronous on both. OPFS is navigated
through promises and no amount of pre-opening makes `getFileHandle` synchronous,
so the interface follows the constraint rather than pretending it away; the
desktop's implementation is synchronous underneath and resolves immediately.

Not present, and not a gap to close: `files:ingestPath`, `fileManager:importFolder`,
`pickAndIngest`, `open`, `reveal` and `thumbnail`. Each begins from a filesystem
path or hands one to the OS, and a tab is never given one -- it gets a File from
a picker or a drop, reads the bytes itself, and passes them to
`files:ingestBuffer`. Those functions live in `db/filesFromDisk.ts` now, kept out
of the shared module so a browser build cannot drag `fs` and `electron` back in.

OCR is the one real loss: scanned PDFs need page rasterisation through native
tooling. Everything whose text is already text -- plain files, markdown, JSON,
PDFs with a text layer, Word, spreadsheets -- extracts here as it does there.

## The parity gap, measured

A full boot, sign-up, desk creation and widget creation now reaches for exactly
**one** channel this runtime does not serve:

```
mail:getAccount
```

That one is not a gap to close: it opens an IMAP connection over TCP, which a
browser tab cannot do at all. Mail in the cloud would mean Signal holding the
mailbox connection, which is a different feature rather than a port.

It was 15 when the runtime first booted. The ones that went were not stubbed --
they are the same db modules the desktop calls, wired up: documents, templates,
shares, connected apps, model routing, credits, desk layout, canvas snapshots,
widget links, focus clusters, the activity trail, browsing history and the
change log. 107 channels are served.

A refused channel rejects with its own name rather than resolving `undefined`,
so this is measured from a session rather than estimated -- `plexiiUnserved()`
in the console, or `unservedChannels()` in `src/web/api/dbClient.ts`. Errors
thrown inside a handler are prefixed with the channel too, because both sides of
the boundary are minified in a build and a bare "Cannot read properties of
undefined" says nothing about which of a hundred calls produced it.

`tests/unit/webHandlerChannels.test.ts` holds the table to channels that really
exist. Both failure modes it guards against were real: serving `ai:status` when
the channel is `ai:getStatus` (dead code that looks like coverage), and passing
`snapshots:create` a label where it wanted the widgets to snapshot.
