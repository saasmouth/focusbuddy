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
shell, the desk canvas, the New Desk flow, several tabs at once, and the
workspace sync loop in both directions. A desk created in a tab reaches the server and is applied by the
desktop's own `applyRemote` into real rows with every column intact -- proven by
`scripts/verify-cloud-roundtrip.mjs` feeding
`tests/unit/cloudDesktopRoundTrip.test.ts`.

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

**The Attention layer is off.** `ensureWorkItemSchema` needs preferences and an
active org that the browser has not wired yet; claiming it were on would send
`nodes.ts` down work-item paths against tables that do not exist here.

**Context Engine events are not emitted.** The desktop's handlers emit them
alongside the write; these call the same db functions without that step. It does
not affect what is written or synced. The list is `PARITY` in
`src/web/worker/handlers.ts`.

**Onboarding does not persist**, because the channel that stores its completion
is not served yet -- so it reappears on reload.

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
