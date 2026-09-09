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

**Provider keys are absent.** On the desktop these live in the OS keychain via
`safeStorage`. `localStorage` is readable by any script that reaches the page,
so BYOK stays a desktop capability until keys are held server-side against the
account and used by Signal on the user's behalf. Features needing a key say so.

**No Drive file bytes.** There is no disk, and OPFS is not a substitute for the
paths the desktop hands to native tooling. Chunk retrieval therefore covers
widgets, documents, tables and chats, but not file contents.

**The Attention layer is off.** `ensureWorkItemSchema` needs preferences and an
active org that the browser has not wired yet; claiming it were on would send
`nodes.ts` down work-item paths against tables that do not exist here.

**Context Engine events are not emitted.** The desktop's handlers emit them
alongside the write; these call the same db functions without that step. It does
not affect what is written or synced. The list is `PARITY` in
`src/web/worker/handlers.ts`.

**Onboarding does not persist**, because the channel that stores its completion
is not served yet -- so it reappears on reload.

## The parity gap, measured

A full boot, sign-up, desk creation and widget creation reaches for **15**
channels this runtime does not serve:

```
model:set              app:setZoomFactor      liveDesk:note
connectedApps:list     shares:listAll         update:get-state
mail:getAccount        auth:get-pending       share:get-pending
meet:get-pending       mdext:get-pending      templates:list
vault:meta             documents:list         ai:refreshCredits
```

Some are desktop-only by nature (`app:setZoomFactor`, `mail:getAccount`,
`mdext:get-pending`, `update:get-state`). The rest are the work queue.

A refused channel rejects with its own name rather than resolving `undefined`,
so the gap is measurable from a session rather than estimated -- see
`unservedChannels()` in `src/web/api/bridge.ts`.
