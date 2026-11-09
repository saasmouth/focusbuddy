# Handoff: "Open This Room in Plexii" (branch `lite-room-import`, from v4.3.47)

PlexiiLite (the free folders-as-rooms app) can now hand the room someone is
looking at to Plexii, which makes a NEW desk named after the folder holding its
own copy of the room's files, laid out as they were. This branch is Plexii's half.
PlexiiLite's half is branch `plexii-room` in the PlexiiLite repo. Not released,
not version-bumped, not merged.

The contract both apps share is `docs/PLEXIILITE-ROOM-HANDOFF.md` (identical in
both repos) with its example `tests/fixtures/plexiilite-room-v1.json`.

## What changed

| Where | What |
|---|---|
| `src/shared/liteRoom.ts` (new) | The link (`plexii://lite-room?id=<v4 uuid>`), the strict schema check (`parseLiteRoom`: refuses the whole file on any broken rule), Plexii's limits (200 files, 1 GB per room), the plan (what comes in, what is left out and why), the words (the question, the summary, every refusal), and the layout mapping (Desk → canvas, Workcentre → Workcentre). Pure. |
| `src/main/liteRoomFiles.ts` (new) | Reading the handoff (only `<PlexiiLite data>/handoff/<id>.json`; real path must be exactly that; not a link; `O_NOFOLLOW`; ≤ 1 MiB) and checking each file before it is copied (directly in the folder, a regular file, a link only to a file inside the folder, not only in iCloud: `SF_DATALESS` read by `/usr/bin/stat`, never by reading the file). No Electron. |
| `src/main/liteRoomReceiver.ts` (new) | Keeps the id on disk (`userData/lite-room.json`, 24 h) until someone is signed in; `beginLiteRoom` reads, ASKS (native sheet, in main), and on yes imports: files through `ingestFromPath` (the drop pipeline's copy and image shrinking, the same `fb_files` row) into a Files folder named after the room, a desk via `createNode`, each file a `file` widget and each PlexiiLite browser window a `webview` widget via `createWidget`, with the same `DeskCreated` / `WidgetCreated` events and review marks the IPC creates emit. Same link twice: brought in once. |
| `src/main/authProtocol.ts` | Routes `lite-room` links to the receiver. |
| `src/shared/deepLink.ts` `claimsDeepLinks`, `src/main/index.ts` | **A test run (NODE_ENV=test / FB_TEST_USER_DATA) and an unpackaged run on macOS no longer register as the plexii:// handler.** Before, every e2e launch and every `npm run dev` called `setAsDefaultProtocolClient`, which on macOS names the running bundle (the bare Electron.app) and takes the installed app's links. `PLEXII_DEV_CLAIM_LINKS=1` lets a developer opt back in. Office and preview unchanged. |
| `src/main/ipc/index.ts`, `src/preload/index.ts` | `liteRoom:pending`, `liteRoom:clear`, `liteRoom:begin`, event `liteRoom:incoming`. Contracts and web channel map regenerated. **Not served in the browser runtime** (`src/web/worker/handlers.ts` untouched, deliberately): the cloud runtime has no PlexiiLite and no local folders; `LiteRoomEffects` returns early there, as `DeskHandoffEffects` does. |
| `src/renderer/src/components/LiteRoomEffects.tsx` (new), `App.tsx` | Waits for a signed-in account, holds the free plan's desk limit (the same `canCreateMore` / `promptUpgrade` as `stores/nodes.ts`), calls `begin`, tells the sync engine (`crdtEmitNodeCreate`, `crdtEmitWidgetCreate`, `nudgeSync`), keeps the Workcentre with this person's layout (`deskLayout.saveWorkcentre`), sets the desk's view, opens it, says the summary. |
| `electron-builder.cjs` `mac.extendInfo` | `PlexiiTakesLiteRooms: 1` (PlexiiLite offers the action only when the app macOS opens plexii:// with has this), and `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` (the reason macOS shows when it asks; see TCC below). |
| `src/renderer/src/components/widgets/FileWidget.tsx`, `lib/fileWidgetFit.ts` (new) | An image file widget is fitted to its picture only while it is still at a drop's size (the catalogue's 320 × 240). Before, the fit ran on EVERY mount, so any resized picture sprang back each time its desk opened (the widget's own comment said that must never happen), and a room brought in from PlexiiLite would have had every picture re-sized over its neighbours. Every existing creator of file widgets uses the catalogue size, so drops still fit as before. |

## The design, in short

- **Link:** only an id. A link alone never imports: a web page can open plexii:// links.
- **Pending until signed in:** like `plexii://desk?handoff=`, the id waits on disk; the question is asked once someone is signed in.
- **Validation before reading any of the person's files:** id is a v4 UUID; the handoff is exactly where it should be (three independent layers against links); ≤ 1 MiB; the schema in full (normalised absolute folder; `name` = its last part; every `relPath` equals its `name`, so nothing nests or climbs; sizes, places, cells, page URLs (http/https only) all bounded; names unique; ≤ 1 day old, ≤ 5 min in the future; a newer version is refused with "update Plexii").
- **The question** (native sheet on the window): "Bring “Launch” into Plexii?" — Plexii will make a new desk, “Launch”, with its own copy of N files (size) and M browser windows from ~/…/Launch, laid out as they are in PlexiiLite. The folder and its files aren't changed: Plexii keeps its own copy. Left out (k): each group with why (only in iCloud, so not downloaded; folders: only the files directly in the room come in; over the 200-file / 1 GB limit; more than PlexiiLite lists). Buttons: Bring In / Cancel. Nothing to bring: said instead of asked.
- **After yes, per file:** re-checked (real path inside the folder, regular, not dataless, the size limit on the files as they are now); anything that fails is left out and named in the summary ("4 files and 1 browser window brought in from “Launch”; 2 left out: talk.mov (only in iCloud), Ideas (a folder).").
- **Layout:** Desk world px → canvas px 1:1, moved together so the arrangement starts at (60, 60), sizes kept (createWidget raises any below the kind minimum), created back to front so the stacking order holds; never-placed tiles in rows below. Workcentre cells → Plexii Workcentre cells (same grid), keyed by the new widget ids, reflowed by Plexii to its own column count. View: Desk → canvas, Workcentre → workcentre, List → list, Focus → canvas.
- **Sub-folders:** left out in version 1, named in the question and the summary. Bringing them would mean walking folders PlexiiLite only listed one level of (and files only in iCloud deep inside, which a walk would download).

## How to test

```bash
npm run build
npx playwright test tests/e2e/liteRoom.spec.ts       # 4 tests, background harness
npx vitest run tests/unit/liteRoom.test.ts tests/unit/liteRoomFiles.test.ts tests/unit/liteRoomReceiver.test.ts tests/unit/fileWidgetFit.test.ts
```

The e2e spec points Plexii at a throwaway PlexiiLite data folder with
`FB_TEST_LITE_DATA` (honoured only when unpackaged, NODE_ENV=test and
FB_TEST_USER_DATA are all set), delivers the link as macOS does (an `open-url`
event), and stands in for the native sheet. By hand with a real PlexiiLite: build
and install this branch, open PlexiiLite's `plexii-room` build, and choose File ›
Open This Room in Plexii….

## Risks and things to know

- **TCC (macOS privacy).** The first time Plexii reads files in Desktop, Documents
  or Downloads, macOS asks the person whether "PlexiDesk" may access that folder.
  Plexii asks its own question FIRST and touches nothing in the folder before the
  yes, so macOS's prompt comes after. If it is refused, the folder check fails with
  EPERM and the person is told where to allow it (System Settings › Privacy &
  Security › Files and Folders); nothing is imported. Not verifiable headless.
- **The real link launching a real installed Plexii** (LaunchServices routing
  `plexii://lite-room` from PlexiiLite to this build) is not tested: the e2e run
  never registers for the scheme and never opens a link. It needs this branch
  installed (it then registers at launch, as every release does).
- **Files over 50 MB** come in like a dropped one and, like it, don't sync
  (`MAX_SYNCED_FILE_BYTES`); the Files panel already says so per file.
- **The protocol-registration change** affects dev: on macOS `npm run dev` no
  longer takes plexii:// links unless `PLEXII_DEV_CLAIM_LINKS=1`.
- **The FileWidget change** is a behaviour change for existing desks: a picture
  someone resized now keeps that size on reopen (before, it snapped back).
- The desk is created in main (as the MCP server and the desk handoff do), so the
  window's per-widget undo entries, trail entries and sounds aren't recorded for
  an import; the sync engine is told by the renderer exactly as for its own creates.

## Gates run on this branch (code unchanged since)

- `node scripts/pre-handover.mjs --specs tests/e2e/liteRoom.spec.ts`: all pass
  (typecheck:node, typecheck:web, typecheck:webruntime, lint:hooks; 4 tests in the
  named spec; 2,085 across the whole e2e suite collected).
- `node scripts/test-changed.mjs v4.3.47`: 140 files, 2,654 passed (3 skipped);
  guards 253 files, 4,547 passed (2 skipped).
- One full `npx vitest run`: 14,336 passed, 2 failed, 9 skipped, 1 expected fail
  (971 files). The 2 were 30 s timeouts at load 47 to 53 (other agents' work):
  `renderWidgetFramed.test.tsx` and `xlsxDropSheet.test.ts`; rerun alone, 17/17 pass.
- e2e (background harness): `liteRoom.spec.ts` 4/4. Affected specs run with it
  (deskHandoff, authDeepLinkConfirm, fileWidget, filesDeskDrop, attachmentDrop):
  24 passed and attachmentDrop AD-5 red once under load ("Focus tiled" grid not
  visible in 8 s); AD-5 alone passes, the whole attachmentDrop spec passes 8/8 on
  this branch and 8/8 at v4.3.47 (detached baseline worktree, since removed).
- New unit tests: liteRoom 63, liteRoomFiles 21, liteRoomReceiver 15,
  fileWidgetFit 2. Every new guard was mutated and seen to fail its tests (31 unit
  mutations, 3 e2e mutations); the handoff's three link layers (real path, lstat is
  a regular file, O_NOFOLLOW) each hold the link test alone, and only removing all
  three turns it red.
- The owner's plexii:// handler (LaunchServices) was unchanged by every e2e run of
  THIS branch (checked before and after). The v4.3.47 baseline run, which has no
  guard, DID take it: at 11:35:06 on 2026-11-09 plexii:// and haptyx:// pointed at
  the test Electron (com.github.Electron, from node_modules). Restored the same
  minute to app.haptyx.desktop with LSSetDefaultHandlerForURLScheme (nothing opened)
  and verified through LaunchServices and its stored preferences.
- **Until this branch lands, any Plexii e2e run from another worktree or the
  aggregator (all are v4.3.47 or older) does the same.** Check with
  `plexiilite-helper url-handler plexii` (PlexiiLite's helper) or the
  LaunchServices plist, and restore `app.haptyx.desktop` after such a run; the
  owner's Plexii also takes the links back the next time it is opened.
