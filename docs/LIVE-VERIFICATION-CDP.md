# Live verification over CDP

How to check renderer behaviour in the running Plexii dev app over the Chrome DevTools Protocol, and
the traps that have produced a confident but wrong "verified" before. The short form is §4 of
`planning/plexii-v1-beta/HANDOFF.md`; this is the full record.

Source: Claude memory, moved 2026-09-17 (notes written 2026-08-27 to 2026-09-08).

## Before you touch the app: it is usually someone else's

The dev app and its vite server in `~/focusbuddy-plexi` are usually owned by another concurrent
session, and Ryan uses the app between rounds. The working tree carries their in-flight edits (a stray
unrelated test failure is usually their mid-edit file, so re-run before believing it), and the app can
restart under you mid-measurement. Do not navigate, restart or switch views in their app without
asking. Rows changing hands in Attention between rounds are usually Ryan, not sync: check `updated_at`
before assuming.

## Starting the app with a debug port

`npm run dev` opens no debug port (`scripts/dev.cjs` passes only its subcommand through). From the repo
root:

```bash
env -u ELECTRON_RUN_AS_NODE npx electron-vite dev -- --remote-debugging-port=9223 > /tmp/plexii-dev.log 2>&1 &
curl -s http://127.0.0.1:9223/json/version   # poll until it answers, about 1 s after vite has built
```

The renderer is served by vite on `5173`. Renderer edits hot-swap; main and preload edits need a full
restart (`pkill -9 -f "focusbuddy-plexi/node_modules/electron/dist/Electron.app"`, then launch again).
An app launched this way gets a silent microphone: see "Running the dev app" in `CONTRIBUTING.md`.

## Reading the renderer

1. `GET http://127.0.0.1:9223/json/list`, take the target whose url starts with
   `http://localhost:5173`, and open its `webSocketDebuggerUrl`.
2. Console output: `Runtime.enable` + `Log.enable` + `Page.reload`, then collect
   `Runtime.consoleAPICalled` and `Log.entryAdded`. `consoleAPICalled` carries
   `stackTrace.callFrames`, which attributes a React warning to a source line.
3. To prove sync is live rather than inert: `window.api.account.load()` must return a session token
   (the session lives in main-process storage, not localStorage). Tally inbound traffic by wrapping
   `window.WebSocket` through `Page.addScriptToEvaluateOnNewDocument` before the reload; a real reload
   replayed about 1,644 CRDT events in 7 `crdtSync` frames (2026-08-27).
4. **`window.api.*` cannot be wrapped.** contextBridge exposes it as an immutable object, so
   `window.api.widgets.create = wrapper` fails silently in non-strict code: the wrapper's counters stay
   at zero while the real calls go past, which reads exactly like "nothing happened" and once sent a
   diagnosis down the wrong path. Wrap `window.WebSocket` (it is writable) and mine the frames, or read
   the main-process log.

## The two traps behind a false "verified"

On 2026-08-27 this setup confirmed a "Maximum update depth exceeded" fix that it had not proven.

1. **The first reload after a module hot-swap is contaminated.** Stashing and unstashing the file under
   test makes vite invalidate the module, and the swap-adjacent reload logs a burst of nested-update
   warnings whichever version is loaded. Measured that way, the pre-fix code showed 27 to 31 warnings
   and the fix 0; on a second, warm reload both showed 0. Discard the swap-adjacent reload and measure
   the next one. Better, first confirm which version is being served:
   `curl http://localhost:5173/src/lib/crdtSync.ts | grep -c <marker>`.
2. **A store-update storm only warns if a mounted view subscribes to that store.** Parked on Calendar
   or Attention, which do not subscribe to the node and widget stores a CRDT replay writes, 880 store
   writes cause no re-render and no warning, and any bug looks fixed. Check what is on screen
   (`document.body.innerText`) before trusting a null result, and reproduce on a view that subscribes.

One clean capture is weak evidence. Run several warm reloads per arm and compare the distributions,
because the signal is intermittent. Stash by path only (`git stash push -- <file>`), never the whole
tree.

## Scratch data

- **Create and remove it through the same path.** Work items filed through the renderer store are
  emitted over the sync substrate. Dismissing them over raw IPC (`window.api.workItems.setState`)
  emits nothing, the substrate's `open` copy comes back and wins on the next upsert, and Ryan sees test
  residue in Attention. Dismiss through the store (`useWorkItemStore.getState().setState(id,
  'dismissed')`), guard by title and source, and re-read the rows read-only after 20 to 30 s. Closing
  through the real door (the completion circle, `useCloseWorkItem`) is the same store path and survives
  the sync echo.
- Tag every scratch work item `test-seed` and title it `[TEST] …`, the house convention the seeds
  already use, so the residue can be dismissed by tag in one go.

## Probing without disturbing the app

- **Stale store instances after HMR.** Once a store file, or anything on its import chain, has been
  hot-swapped, a probe's `import('/src/stores/x.ts')` returns a different module instance from the
  app's (`open:false` while the overlay is on screen). Read the DOM
  (`[data-testid=assistant-overlay]`, `[role=tab][aria-selected=true]`, computed `display`) and press
  the real buttons; store imports are safe only for modules untouched since the last reload. For pure
  libraries, `import('/src/lib/x.ts?t=' + Date.now())` loads the live code. `Page.reload` restores a
  coherent module graph but lands the app on the desk sidebar.
- **Restore the whole view object.** Capture `useViewStore.getState().view` before navigating and
  restore it with the matching door (`goOffice(app)`, `goTask(id)`, …) or
  `useViewStore.setState({ view: saved })`. A finally block that only knew four view kinds once left
  Ryan on Home when he had been working in the Office view.
- The widget store holds only the current desk's widgets. To find a desk carrying a given widget kind,
  query the database read-only (`select task_id from widgets where kind='attention'`) and `goTask`
  there.
- Never strip the theme class the app set (`toggle('dark', had)`). An occluded window never fires
  `requestAnimationFrame`, so bound every wait. The Meet door lives in the Office sidebar.

## Hover and layout checks

- **Hover in an occluded window.** `Input.dispatchMouseEvent` does not register `:hover` there. Force
  it: `DOM.enable` + `CSS.enable`, `DOM.getDocument`, `DOM.querySelector`, then
  `CSS.forcePseudoState({nodeId, forcedPseudoClasses: ['hover']})`, and clear it with `[]` in the
  finally block. React state set from a native `mousedown` listener flushes on a microtask, so read the
  DOM after a short sleep, never in the same evaluation.
- **"Nothing clips" needs a page-wide sweep.** Ryan's rule (DEC-132 to DEC-134) is "either it stops
  before something is cut off mid-row, or it scrolls": every element with
  `scrollHeight > clientHeight + 3` must have `overflowY` auto or scroll.
- **Test a short window without touching Ryan's.** Call
  `Emulation.setDeviceMetricsOverride({width: 1400, height: 640, deviceScaleFactor: 0, mobile: false})`,
  measure, screenshot with a clip of the emulated size, then `Emulation.clearDeviceMetricsOverride` in
  the finally block. Measure against the view root's `getBoundingClientRect().bottom` (the footer bar
  sits below it), not `innerHeight`.
- **A `calc(100vh - N)` cap is a smell.** The pages that had one ran under the footer. The fix that
  held is the flex window: root `h-full flex flex-col`, header `shrink-0`, regions
  `flex-1 min-h-0 overflow-y-auto`, hugging cards `max-h-full min-h-0`.
