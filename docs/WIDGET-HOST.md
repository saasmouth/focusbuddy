# The widget host

One Plexii widget or Office document from a `.plexii-*` file, shown inside
PlexiiLite with Plexii's own widget code. It is F2 of the PlexiiLite widget-files
plan (plexii-lite `docs/plans/widget-files.md`). This note is the contract
PlexiiLite builds against. Read it before changing anything in `src/web/widgetHost/`.

## What it is

A second entry of the browser build (`vite.widgethost.config.ts`, output
`out/widget-host/`). The page:

- is handed one file's text;
- imports it with Plexii's importer into a database that lives in memory, for
  this page only;
- draws it with the same component a desk uses;
- hands the text back when the person changes something.

It never signs in, never touches a disk, and reaches the network only where a
widget itself does: the place map (see "The network" below).

PlexiiLite owns the file: atomic writes, the check for changes made outside, and
Undo. The page is a view and an editor of the text it was given, nothing more.

## Building and vendoring

PlexiiLite ships the host in its resources, built from a pinned focusbuddy
commit, never from a checkout:

```sh
# in the ecosystem repo, haptyx-web/
node scripts/build-widget-host.mjs --commit <sha> --out <PlexiiLite>/resources/widget-host \
  [--node-modules-from <a focusbuddy worktree with the same package-lock.json>]
```

The script works like this:

- It builds in a temporary worktree at the commit, then removes it, whatever happened.
- It swaps the output in whole.
- It completes `manifest.json`, PlexiiLite's manifest (1a's contract):

  ```json
  { "protocol": 1, "pin": "<full commit>", "kinds": ["sticky", "note", "…"],
    "documents": { "doc": { "ext": ".plexii-doc", "label": "Document" }, "…": {} },
    "builtAt": "…", "files": [{ "path": "…", "bytes": 0, "sha256": "…" }], "totalBytes": 0 }
  ```

  The build writes `protocol`, `kinds` and `documents` from the lists the page
  loads (`src/web/widgetHost/capabilities.ts`). The script adds `pin`, `builtAt`,
  `files` and `totalBytes`. It refuses a build that wrote no manifest, or one
  whose protocol is not the source's.

PlexiiLite refuses a host whose `protocol` it does not speak, and makes and shows
only what `kinds` and `documents` list.

In focusbuddy, `npm run widget-host:build` builds `out/widget-host/` and
`npm run test:widget-host` tests that build in Chromium.

## Embedding

The page is `index.html`. PlexiiLite shows it in a `<webview>` with its own
partition and its own preload. It makes new files in a hidden window it opens
itself (`?via=window`). The page can also run in an `<iframe>`, which is how
its tests run.

- **Read-only:** `?readonly=1` on the address (also a field of `load`).
- **Messages:** the page posts to `window.parent` and reads only messages whose
  source is `window.parent`. In a webview the page is top-level, so that is the
  page itself. PlexiiLite's preload listens for `message` on the window:
  - it forwards the host→PlexiiLite types below with `ipcRenderer.sendToHost`;
  - it delivers PlexiiLite→host messages with `window.postMessage(msg, '*')`.

  Each direction has its own types, so the page ignores its own posts.

## Messages, protocol 1

Every host→PlexiiLite message carries `protocol: 1`. All types are prefixed
`plexii-widget-host:`.

| Type | Direction | Body | When |
|---|---|---|---|
| `ready` | host → Lite | — | The page is listening. Sent once. |
| `load` | Lite → host | `{ text, readOnly? }` | The file's text. One per page; open a new page for another file. |
| `create` | Lite → host | `{ kind }` | Make a new file of this kind with Plexii's own code and answer with `save` (see "Making new files"). Needs no `load`, shows nothing. |
| `loaded` | host → Lite | `{ family: 'widget' \| 'document', kind, title, readOnly }` | The file was accepted and is being drawn. |
| `save` | host → Lite | `{ text }` | The file's new text, as `JSON.stringify(…, null, 2)`. See "Saving". |
| `flush` | Lite → host | — | Post any pending save now. Send it before a tile closes, a room switches, or the app quits. |
| `flushed` | host → Lite | — | The answer to `flush`, after the pending save (if any) was posted. |
| `error` | host → Lite | `{ code, message }` | `message` is a sentence to show as is. The page shows the same sentence. |
| `open-link` | host → Lite | `{ url }` | Open this http(s) or mailto address in the person's browser. Links never navigate the page. |

Error codes:

| Code | Meaning |
|---|---|
| `not-a-plexii-file` | Not JSON, or not a Plexii file. |
| `newer-than-host` | A Plexii file of a kind this build does not know. |
| `needs-plexii` | A real Plexii widget that works only in Plexii (a voice note, a gallery, an inbox…). The message names it. |
| `import-failed` | The importer refused the file, with its reason. |
| `database-unavailable` | The page's database did not start. |
| `render-failed` | The widget threw while drawing, with the error. |
| `save-failed` | The page could not write the file out after a change. Sent once per distinct reason. |
| `already-loaded` | A second `load` arrived. |
| `cannot-create` | A `create` for a kind the host does not make, or one that failed, with its reason. It never replaces what the page shows. |

## Saving

A `save` is posted only when both of these hold:

1. The text differs from the last text PlexiiLite has: what it loaded, then each
   save. The comparison ignores `exportedAt` (restamped on every export), key
   order and indentation.
2. The person has done something in the page since it loaded: a key, a pointer,
   a paste or a drop.

So opening and closing a file never writes it, even for kinds that tidy their own
content on mount (card, shape, custom-block). Such a tidy-up goes out with the
person's first real edit.

- **When:** saves are debounced (300 ms after the last write).
- **What:** the text comes from Plexii's own exporter, so a table's rows and an
  Office document's body travel in it.
- **On `flush`:** the Office editors' pending bodies are written. Then, if the
  person did something since the last flush, the page waits until nothing has
  been written for 750 ms (3 s at most) and exports.
  - 750 ms is longer than any shown kind's save debounce: sticky, note and
    markdown wait 600 ms, Office 500, the rest 400 or less. So the write the
    last edit left pending fires and lands first.
  - The widget is never remounted to force its writes. Page, Card, Calculator,
    Colour, Shape and Form block clear a pending save when they unmount, so a
    remount would drop the very edit a flush is for.
  - A flush with nothing done since the last one answers at once.

**Read-only never posts a save.** Every editing gesture is refused before any
widget sees it: keys, clicks, pastes, drops and menus. Scrolling, Tab and
following a link still work, and so does a **reading control** (below).

## Read-only: what a tile shows

A read-only tile shows what the file holds and **no control that would change
it**. A control there could only be refused, so it would be a dead button. The
host provides `WidgetReadOnlyContext` (`lib/widgetSurface.ts`), and each widget
and editor draws its viewer form:

- **Documents:** the page, sheet, deck, diagram, design or drawing only. There is
  no menu bar, ribbon, tool rail, overlay panel or side pane
  (`OfficeShellLayout`), and no add page, sheet or row, formula bar, or empty
  speaker notes.
- **Widgets:** the content as text. A card's title and body, a field's value
  (`lib/fieldValueText.ts`), a table's columns and every row, a task list's
  tasks with which are done and when they are due, a form block's filled-in
  values, a calculator's sum without its keypad, a timer's time without its
  buttons. There are no toolbars, colour dots, pickers, "Add" buttons or
  placeholders inviting typing.

**Reading controls** still work. They are marked `data-reading-control`
(`readingControl` in `lib/widgetSurface.ts`), and the input guard lets a click
or Enter/Space on one through:

- copying (a colour's hex, Copy as markdown);
- moving around what is there: a deck's slides, a sheet's tabs, a design's or
  diagram's pages, a mind map's breadcrumb, a stat card's series, a task list's
  Active / Done / All, the place map's pan, zoom and "Open in OpenStreetMap".

Whatever they change stays in the page. Read-only never saves.

`tests/widget-host/readOnly.spec.ts` loads every kind read-only and fails on
any visible control that is not a reading control, any field that is not
read-only, and any placeholder. It then clicks every reading control (nothing
may break or save) and proves that copy, a task list's tabs and a deck's slides
still work.

## Making new files

`create { kind }` makes the file with the same calls the app makes for a new one,
then answers with `save` at once. Asking for a file is the person's action, so it
waits for no touch.

- **A widget:** `widgetFiles.create` with the kind's catalog default. For a file,
  `createWidgetFile` itself puts a task list in its own-list mode.
- **A table:** also its backing table, with the starter columns the desk's table
  widget gives a new one, Name and Done (`lib/tableStarter.ts`, which both use).
- **An Office document:** `documents.create`, which gives it the blank body
  Plexii gives a new document.

The text is the exporter's, exactly what a later save carries.

## The database

Each page starts its own Worker, named `plexii-widget-host`
(`src/web/worker/hostMode.ts`), whose SQLite database lives in memory.

- No OPFS: nothing is kept in the browser's storage.
- No Web Lock and no BroadcastChannel: no page shares a database with another.

The share app's single-workspace-per-origin election would otherwise have made
two tiles share one database. `tests/widget-host` checks that the storage is
empty and that no lock is held after an edit.

## What it shows

**Widgets** (the plan's "New ▸ Plexii widget"): sticky, note, markdown, page,
card, scratchpad, calculator, colour, timer, shape, field, task list (its own
list), metrics, stat card, mind map, form block, table, chart, place
(`location-map`).

**Documents:** doc, sheet, slides, map (diagram), design, draw.

Each kind's code is loaded on its own (`kinds.ts`), not as renderWidget's single
chunk. `tests/unit/widgetHostKinds.test.ts` fails if the host and the desk ever
draw a kind with different components.

Any other widget file gets `needs-plexii` or `newer-than-host`, never a broken
widget.

## What it hides, and why

d0's rule: hide anything that needs Plexii itself. Never leave a dead button, and
never show anything that implies a Plexii feature works when it doesn't. Each
hidden thing asks `inWidgetHost()` or `offeredHere()` (`lib/widgetHost.ts`)
where it is drawn.

- **Desk chrome:** the title bar, drag, resize and remove. The tile is the frame.
- **The widget menu** (right-click on a widget): make a task, share, duplicate,
  archive, and AI.
- **Plexii's AI:**
  - the "Set up with AI" chip;
  - Expand with AI and Ask AI;
  - the AI side panes (`SidePane.ai`);
  - rail items with `role: 'ai'`;
  - AI commands in ribbons and the palette.
- **Saved snippets:** Plexii's library, shared across desks, never in a file.
- **Document comments:** stored beside the document, not in its body.
- **Desktop file operations:** a note's HTML and PDF export, and a sheet's
  .xlsx and .csv import and export. PlexiiLite owns the file, and the desktop
  dialogs these need are not here.
- **A page's living mode:** it summarises a canvas the file does not have.
- **Embeds of another Plexii object by id:** a desk's work widget or another
  Office file (Insert, the "/" menu, the palette). The file would keep a
  reference to something that is not in it.
- **A mind map's desk actions:** explore a node as a canvas, convert it to a
  task, attach a tool, find agents.
- **AI in prompts and empty states:** a new Document says 'Write something, or
  press "/" for commands…', and a page's "/" menu has no AI prompt.
  `tests/widget-host/emptyStates.spec.ts` makes every kind (as New does) and
  reads its placeholders, empty states and "/" menus.

## The network

The page asks nothing of any server except what a widget itself does, and only
one widget does: the **place map** (`location-map`, a `.plexii-place` file).

- **Tiles** from `tile.openstreetmap.org`, whenever the map is shown.
- **Search** on `nominatim.openstreetmap.org`, only when the person looks a place
  up (an explicit search, never a keystroke or a pan). Read-only never searches.

That is expected, and PlexiiLite discloses it.

**No local AI.** Until 2026-11-20 the host asked `http://localhost:11434/api/tags`
(an Ollama server) on every page that showed a calculator, a chart, a task list
and ten other kinds (1a found it). The search index did it: opening a file
saves it into the page's database, and a save embeds the document for search,
which with no key asks for a model on this computer. The host build now swaps
`src/main/ai/localModel.ts` for `src/web/worker/main/hostLocalModel.ts`
(`HOST_MODULE_SWAPS` in `vite.widgethost.config.ts`), which has no model and
nowhere to ask, so the host carries no local-model client at all. Search keeps
to keywords; nothing is faked. The share app keeps its client.

`tests/widget-host/network.spec.ts` checks this:

- It opens and saves each kind's example file, watching every request the page
  and its Worker make.
- It refuses everything that is not for the test server, so the tests reach no
  other server.
- It fails on any request to port 11434, and on any request off the page other
  than the place map's OpenStreetMap hosts.
- It fails if the built host contains an Ollama address.

## What it does instead of failing

- **Insert image** (Write, Deck, Design) and **Place** (Draw) use a file input in
  place of the desktop's dialog. They return the same result shapes, and the
  image is stored inside the document as a data URL, so it travels with the
  file. Place does not offer PDF or Illustrator files, because those need the
  desktop's PDF renderer.
- **Links,** `window.open` and the map's "Open in OpenStreetMap" become
  `open-link`.

`tests/widget-host/controls.spec.ts` checks every visible control of every kind
(every ribbon tab included): clicking it must reach nothing the host does not
serve. The right-click menu must offer nothing that needs Plexii.

## Size

Measured on the build of 2026-11-20 in headless Chromium, from a local server.
"Per page" counts every response the page and its Worker received.

| | Spike (1a, 39945593) | This build |
|---|---|---|
| Whole output | 16 MB | 13 MB (JS 7.2, fonts 2.6, wasm 0.8, icons 0.7, CSS 0.3) |
| A sticky, per page | 10.7 MB, ready in 0.85 s | 4.6 MB, drawn in 0.27 s |
| A widget, per page (19 kinds) | about 10.7 MB | 4.1 to 4.7 MB, drawn in 0.26 to 0.32 s |
| An Office document, per page | 10.7 MB | 6.6 MB, drawn in 0.31 to 0.38 s |

Where it went:

- **The 4.6 MB renderWidget chunk is gone.** Each kind loads its own component.
  What every widget page shares:
  - the frame and its stores (1.8 MB);
  - React and the page (0.65 MB);
  - the Worker and SQLite (0.7 MB of JS and 0.8 MB of wasm).
- **The icon font is 0.5 MB, not 3.9 MB.** Material Symbols is pinned to the one
  style the host draws (wght 500, GRAD 0, opsz 24; fill kept), with all 6,589
  icons. It is made by `scripts/widget-host-icon-font.py`, and
  `tests/unit/widgetHostIconFont.test.ts` fails if the package changes until the
  font is made again.
- **Inter** (0.2 MB, variable, every language subset) and the **document fonts**
  (1.9 MB, regular and bold Latin of each family the Office font pickers offer)
  are kept. A page downloads only the fonts it draws with.
- **Plexii's own icon images** (0.7 MB, 444 files) ship as files and are
  downloaded only when one is shown. Leaving them out would mean changing the
  desktop's generated icon map.

## Until F1 lands

The two channels the host reads and writes files through,
`widgetFiles:import { text }` and `widgetFiles:exportText { fileId | documentId }`,
are F1's (9e). Until F1 is merged:

- `src/web/worker/widgetHostInterim.ts` serves them with F1's contract, in host
  Workers only.
- The host's test fixtures (`tests/widget-host/fixtures`) are generated by
  `tests/unit/_makeWidgetHostFixtures.test.ts`.

When F1 lands:

1. Delete the interim handlers.
2. Point `tests/unit/widgetHostF1Channels.test.ts` at F1's handlers. It must
   pass unchanged.
3. Switch the fixtures to F1's `tests/fixtures/widget-files/`.
