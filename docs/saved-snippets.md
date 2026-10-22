# Saved snippets

A snippet is one saved component — a pricing table, a payment-terms clause, a
sign-off block, a KPI widget — that a user keeps and re-inserts wherever it is
relevant. Two things make it more than copy-paste: how an inserted copy relates
to the saved original, and who is allowed to use it.

## The two link modes

Inserting a snippet is either a **duplicate** or a **live instance**, and the
difference is the feature.

| | Duplicate | Live |
|---|---|---|
| What is inserted | the snippet's content, as ordinary editable blocks | a reference holding only the snippet's id |
| Later edits to the master | never reach it | appear everywhere it was inserted |
| In the host's stored body | the content itself | `{ snippetId }` and nothing else |
| When the master is deleted | unaffected — it is just content now | renders an explicit "no longer exists" |

A duplicate deliberately creates **no node**. A copy that has stopped tracking
its origin needs no reference, so it gets none; only a live instance does. This
is why `insertSnippetDuplicate` takes the *content* and `insertSnippetLive`
takes an *id* — the signatures make the difference impossible to blur.

A live instance resolves on every mount, which is the same rule
`WidgetEmbedNode` already states for embedded widgets: *the node stores only the
id, so the host never carries a stale copy*. Editing the snippet in the library
is therefore how you update every document that uses it.

`revision` is bumped on a body change and surfaced on the rendered node as
`data-snippet-revision`, so a host can tell that what it drew is current. A
rename does **not** bump it: a rename changes nothing a live instance renders,
and treating it as new content would look like a change to every host.

## Personal and organisational

There is **no separate permission system**, deliberately.

- Snippets are stored with an `org_id`, like documents and every other
  tenancy-bound row. Switching workspace switches library.
- `PERSONAL_ORG_ID` (`'personal'`) is the reserved private workspace.
- A user only has an org they were invited into and switched to. **Being able to
  see an org's library is the invitation.**

Within a real org, `scope` separates the two things the user asked for:

- `personal` — the user's own reusable assets. `authorId` records who saved it
  (the signed-in email, which is the only stable identifier the main process
  has locally; null in an anonymous workspace, which is the normal local-first
  case).
- `org` — shared with everyone in that workspace, so a team keeps one real
  pricing table instead of nine drifting ones.

An org-scoped save **in the personal workspace is stored as personal**. There is
nobody to share with there, so labelling it "org" would be a claim the workspace
cannot honour. The library's Organisation tab says so outright rather than
showing an empty list, because "this org has nothing shared" and "there is no
org here" are different statements and an empty list would assert the wrong one.

`fork` copies an org snippet into the caller's personal library, so someone can
diverge from the shared version without editing it for everyone.

### Org scope does not reach teammates yet, and says so

**`ORG_SNIPPETS_SYNC` is `false` as of 4.3.41.** An org snippet is marked
organisation-wide and the library filters on it, but it **stays on the computer
that saved it**.

Workspace sync carries a closed set of item types and the gate is server-side:

```ts
// focusbuddy-signal/src/workspaceSync.ts
export type WorkspaceItemType = 'node' | 'widget' | 'timeblock' | 'table' | 'row' | 'file'
if (!WORKSPACE_ITEM_TYPES.includes(input.itemType))
  return { ok: false, conflict: false, error: 'Invalid itemType.' }
```

`snippet` is not in that list, so adding it is a server change and a deploy, not
a client edit. Until then the UI must not imply sharing, so:

- the save dialog's org button reads **"Mark as organisation-wide"**, not
  "Everyone in this organisation";
- selecting it shows `ORG_SNIPPET_REACH_NOTE` — *"Saved on this computer.
  Sharing with your organisation arrives with sync."*;
- the library's Organisation tab shows the same note above its list.

All of that wording derives from the one flag, so flipping
`ORG_SNIPPETS_SYNC` in the same change that adds `snippet` to both whitelists
updates every string at once and no copy goes stale.
`tests/unit/snippets.test.ts` asserts the two stay in step.

The scope was kept rather than hidden because it records the user's intent, it
is what the library filters on, and it is what will travel unchanged once sync
carries snippets — hiding it would mean rebuilding it later and losing the
intent meanwhile. What is not acceptable is telling someone their colleagues
can see something they cannot.

The precedent sits in the server's own comment beside that union: a sync that
accepted only what it recognised "had faithfully carried everything it was
willing to accept" while reporting success throughout, and an image arrived as
a blank widget. Silent partial sync reads as success, which is why this is a
constant and a test rather than a comment.

## Where snippets can go

A snippet is typed by what it holds, and each surface declares what it accepts.

```ts
interface SnippetTarget {
  id: string                    // the MOUNTED SURFACE, not the document
  label: string                 // "This document", "Marketing desk"
  accepts: SnippetKind[]
  supports: SnippetLink[]       // only modes it can really honour
  insert: (s: Snippet, link: SnippetLink) => Promise<boolean> | boolean
}
```

Three properties of this contract matter:

**Targets are mounted surfaces.** A document that is open can take a doc
snippet; the same document closed cannot. Surfaces register on mount and
withdraw on unmount, so the picker offers exactly what is really on screen and
the user is never offered a destination that would quietly do nothing.

**`supports` is honest.** A surface that cannot resolve a reference at render
time lists `['duplicate']`, and the picker then offers Duplicate alone. Showing
a Live option that silently became a copy would be a lie about what was asked
for.

**`insert` returns false when it declined.** A sheet with no selection, a
read-only document. The store reports that refusal rather than counting a use
that did not happen, which is why `usageCount` means something.

### Surfaces today

| Kind | Body | Wired |
|---|---|---|
| `doc` | TipTap nodes + plain text | **yes** — duplicate and live |
| `widget` | kind, title, content, size, colour | **yes** — duplicate only, see below |
| `sheet` | row-major values + per-cell formats | modelled, not wired |
| `slide` | slide elements | modelled, not wired |
| `design` | canvas elements | modelled, not wired |
| `diagram` | nodes + edges | **yes**: duplicate only, see below |
| `draw` | PlexiiDraw objects + the assets and swatches they use | **yes**: duplicate only, see below |

The document surface is first because it is the one that needs both link modes
and because the live-embed mechanism already existed there to build on. The
kinds still marked "not wired" are typed end to end but **no surface registers
them yet** — a kind with no target simply offers no destination, which is why
the picker says "nothing open can take this" instead of failing.

### Why a desk offers Duplicate only

Not a limitation — a deliberate refusal to build a second mechanism for
something that already has one.

A work widget is already a file, and a file "can be placed on any number of
desks as a **linked instance** whose edits flow both ways"
(`docs/widget-files.md`). That IS live. A "live widget snippet" would be a
second way to do the same thing, competing with the first, so the desk target
declares `supports: ['duplicate']` and the library offers Duplicate alone.

So the division is:

- a widget **snippet** is a template for making new widgets of a shape you use
  often — each one independent from the moment it lands;
- a widget **file** is one widget that appears in several places at once.

Both are real wants, they are not the same want, and the same widget can do
both: `Save as snippet` and `Save as file` sit beside each other in the widget
menu for exactly that reason.

A widget snippet carries its SIZE but not its POSITION: shape is part of what
makes a widget reusable, while where it sat on one desk is not. The destination
desk decides where the new widget lands.

### Why a drawing offers Duplicate only

PlexiiDraw registers `supports: ['duplicate']`. A live Draw snippet would need
a node type holding only `{ snippetId }`, resolved on every render, and that
cannot be built honestly today:

- **It breaks file compatibility.** An unknown node type opens the drawing
  read-only in every build that predates it and has to raise
  `minWriterVersion` (`shared/draw/compat.ts`, `documents/draw/README.md`);
  4.3.33 and earlier have no guard at all and would drop it on save. Inserting
  a snippet would quietly lock the drawing for anyone on an older version.
- **Export cannot resolve it.** The serialiser (`shared/draw/svg.ts`) is pure
  and synchronous over the document, and the same paint descriptions draw the
  screen, the clipboard and PNG/SVG/PDF export. A reference to a row in the
  library cannot be resolved there, so an exported file would carry a hole or a
  stale copy, which is exactly what a live instance must never be.
- **Draw already has a place for live reuse.** Illustrator's Symbols are
  reserved (WP-SYMBOLS: F8 and ⇧⌘F11 in `commands/keymap.ts`). A symbol lives
  inside the drawing, so it exports and syncs with it. A live snippet would be
  a second, competing mechanism for the same want, the desk's reasoning again.

So a Draw snippet is a reusable block of art: each insertion an independent
copy from the moment it lands.

**Capture** is Draw's Copy: `drawBodyFromSelection` takes what `copiedNodes`
takes (a member picked out of a transformed group keeps that transform, objects
a newer PlexiiDraw made are left out), moves it so the block's top-left is the
origin, and carries **exactly** the assets and swatches those objects use. An
image node holds only an asset id, so without its bytes it would land as a
broken picture. Edit › Save selection as snippet… and the canvas context menu
open the save dialog with it; with nothing selected the item is disabled and
says why, as Draw's other selection commands do.

**Insertion** is Draw's Paste: the body goes through the clipboard's own parser
(`parseClipboardValue`, the stored-drawing normaliser), `landPayload` gives every
node and group member a fresh id and merges assets and swatches, and
`placeIncoming(…, 'paste')` puts it where Edit › Paste would: centred in the
window, at the front of the active layer, selected, as one undo step ("Insert
snippet"). Unlike a document, insertion does **not** replace the selection; it
adds beside it and selects the copy, as a paste does in Draw. It declines (and
says why on the status line) on a read-only drawing, a hidden target layer, a
live request, a body of another kind, and v2-only art (a group) in a drawing a
live session keeps in the older format.

### Why a diagram offers Duplicate only

PlexiiDiagrams (`documents/diagram/diagramSnippets.ts`) captures a selection
with `copySelection`, so a diagram snippet is exactly what Copy would take: the
selected shapes, everything inside a selected container or swimlane, and only
the connectors whose **both** ends are in the fragment. Positions are moved so
the fragment's top-left is 0,0. A child picked without its container drops the
dangling `parentId`, and locks are dropped, as a paste drops them.

Insertion goes through `pasteClip`, so it is a paste in every way that counts:
the stored body is normalised like a loaded diagram, then placed with fresh
node, connector and group ids, connectors and containers remapped onto the new
shapes, deep copies so the page never shares an object with the snippet, one
undo step, and the new shapes selected. The block is centred in the visible
canvas (a snippet's own positions are relative, so there is no "original spot"
to offset from) and nudged while it would sit exactly on shapes already there.
A layer is page-local, so a shape whose layer is not on the destination page
goes to Base. Data bindings and work widget links are kept: they name a table
or a widget, which is just as valid in another diagram. A read-only diagram
registers no target, and its `insert` refuses as well.

Live is not offered, because a diagram cannot honour it without a second
mechanism or a silent copy:

- **Co-editing.** A shared diagram's body reaches collaborators, but snippets
  do not sync (`ORG_SNIPPETS_SYNC` is false and `snippet` is not a workspace
  item type), so every peer would see the reference as missing.
- **Export.** Mermaid, draw.io, Visio, JSON, SVG and PNG are all written from
  the `MapBody` alone. A reference node would either be dropped, or be frozen
  into a copy at export time, which is a duplicate under another name.
- **Connectors.** Edges join node ids on the page. Shapes resolved inside a
  live block would not be page nodes, so nothing could connect to them, and
  routing, containers and layers would treat the block as one opaque box.

So the target declares `supports: ['duplicate']`, and the library shows one
button. The menu items are Edit › "Save selection as snippet…" (also on a
shape's right-click menu) and Insert › "Insert snippet…" (also on the canvas
right-click menu). The target id is the mounted editor's `useId`, so the same
diagram open in the document view and in a work widget is two destinations.
Tests: `tests/unit/diagramSnippets.test.ts` (capture, insertion, the
target's contract), `tests/unit/diagramSnippetsTarget.test.tsx` (registers on
mount, withdraws on unmount and when read-only) and
`tests/e2e/snippetsDiagram.spec.ts` (the round trip in the app).

Adding a surface is a registration, not a change to the core:

```ts
useEffect(() => registerSnippetTarget({
  id: `sheet:${instanceId}`,
  label: 'This spreadsheet',
  accepts: ['sheet'],
  supports: ['duplicate'],      // a sheet cannot resolve a reference per-cell
  insert: (s, link) => pasteBlockAtSelection(s.body)
}), [instanceId])
```

## Adding a snippet target

Written for whoever wires Cells, Deck, Design, Draw or Diagrams. A target is a
registration, not a change to the core: nothing in `shared/snippets.ts`, the
store, the library or the save dialog needs editing to add one.

There are two halves, and they are independent — a surface can do either alone.
**Capture** turns a selection into a snippet. **Insertion** puts one back.

### 1. Capture: a selection becomes a body

Write a pure function from your editor's selection to a body of your kind.
Return `null` when there is nothing selected, rather than an empty body: the
caller needs to tell "nothing to save" from "saved something empty".

```ts
// documents/editor/docSnippets.ts — the doc example
export function docBodyFromSelection(editor: Editor): DocSnippetBody | null {
  const { from, to, empty } = editor.state.selection
  if (empty || to <= from) return null
  const content = editor.state.doc.slice(from, to).content.toJSON() as unknown[]
  if (!content.length) return null
  // Store plain text alongside the nodes: it is what the library searches and
  // what gives an honest preview without rendering anything.
  return { kind: 'doc', content, text: editor.state.doc.textBetween(from, to, '\n', ' ') }
}
```

```ts
// desk/deskSnippets.ts — the widget example. Size travels, POSITION does not:
// shape is part of what makes a widget reusable; where it sat is not.
export function widgetBodyFromWidget(w: Widget): WidgetSnippetBody {
  return { kind: 'widget', widgetKind: w.kind, title: w.title ?? '', content: w.content ?? '',
           width: w.width ?? 2, height: w.height ?? 2, color: w.color ?? null }
}
```

Then open `SaveSnippetDialog` with it. Pass an EMPTY body rather than skipping
the dialog when nothing is selected — it already says "There is nothing in the
selection to save", which beats a menu item that appears to do nothing:

```tsx
const [draft, setDraft] = useState<SheetSnippetBody | null>(null)
// …menu item:
onSaveSnippet: () => setDraft(sheetBodyFromSelection(grid) ?? { kind: 'sheet', rows: [] })
// …render:
{draft && <SaveSnippetDialog body={draft} suggestedName={…} onClose={() => setDraft(null)} />}
```

Where the menu item goes: a widget uses `FrameCallbacks.onSaveAsSnippet`
(`lib/contextMenu/types.ts`, rendered in `universal.ts` beside "Save as file").
A document uses its own menu bar. Put it wherever that surface's other
"do something with this selection" actions already live.

### 2. Insertion: register a target

```ts
export function useSheetSnippetTarget(instanceId: string, hasSelection: boolean): void {
  useEffect(() => {
    return registerSnippetTarget({
      id: `sheet:${instanceId}`,
      label: 'This spreadsheet',
      accepts: ['sheet'],
      supports: ['duplicate'],
      insert: (snippet) => pasteBlockAtSelection(snippet.body)
    })
  }, [instanceId, hasSelection])
}
```

Five rules, each learned from something that would otherwise be wrong:

**`id` identifies the MOUNTED SURFACE, not the document.** The same document
open twice is two destinations; closed, it is none. `DocEditor` passes its React
`useId` scope, because it has no document id at all. `registerSnippetTarget`
returns its own unregister function, so returning it from `useEffect` is the
whole lifecycle.

**Depend on everything `insert` closes over.** Otherwise the registry holds a
stale closure writing into an editor that has been replaced.

**`supports` must be honest.** List `'live'` only if you resolve the snippet at
render time, every render. If you cannot, list `'duplicate'` alone — the library
then shows one button. A Live option that silently produced a copy would be a
lie about what the user asked for. See "Why a desk offers Duplicate only" for a
case where Duplicate-only is the right answer even though live was possible.

**`insert` returns false when you decline.** No selection, read-only, wrong
kind. The store reports the refusal instead of counting a use, which is why
`usageCount` means anything.

**Open the library scoped to your kinds.** `<SnippetLibrary kinds={['sheet']}
targetId={…} />`. The kind filter already hides kinds nothing can hold, but
passing `kinds` is what stops a user picking a snippet your surface will refuse.

### 3. Live instances, if you support them

Only needed for `'live'`. Store the id and nothing else, then resolve on every
render — the host must never carry a copy of the body:

- a node/element type holding `{ snippetId }`, resolved on mount;
- registered in the **shared schema** if your app round-trips through a
  converter, or an exported file loses the reference. `SnippetEmbedNode` is in
  `buildDocExtensions` for exactly that reason;
- a **missing state** when the master is gone. A dangling reference must look
  dangling: see `SnippetEmbed`'s `snippet-embed-missing`. Blankness, or a cached
  copy of what it used to say, are both worse than an honest gap.

A duplicate creates **no** reference. That is why `insertSnippetDuplicate` takes
the content and `insertSnippetLive` takes an id.

### 4. The six kinds and their bodies

```ts
DocSnippetBody     { kind: 'doc',     content: unknown[], text: string }
WidgetSnippetBody  { kind: 'widget',  widgetKind, title, content, width, height, color }
SheetSnippetBody   { kind: 'sheet',   rows: string[][], formats?: Record<string, unknown> }
SlideSnippetBody   { kind: 'slide',   elements: unknown[] }
DesignSnippetBody  { kind: 'design',  elements: unknown[] }
DiagramSnippetBody { kind: 'diagram', nodes: unknown[], edges: unknown[] }
DrawSnippetBody    { kind: 'draw',    objects: unknown[], assets?, swatches? }
```

`draw` is its own kind rather than `design`: PlexiiDraw's objects
(`shared/draw/model.ts`) and PlexiiDesign's elements are different models, and the
kind/body agreement check is what keeps one app's objects out of the other.

`doc`, `widget`, `draw` and `diagram` are wired. `sheet`, `slide` and `design`
are typed and stored but register no target yet.

If a shape does not fit, change it in `shared/snippets.ts` and add its case to
`snippetSummary` and `snippetBodyIsEmpty` — the compiler will name both, because
they switch exhaustively on the union. Do not widen a body to `unknown`: the
kind/body agreement check is what stops a slide surface being handed an object
a document wrote.

Positions inside a body are **relative to the block's top-left**. The
destination decides where the block lands.

### 5. The tests a target needs

Three, mirroring what the doc and desk surfaces have:

1. **Capture is pure** — a unit test that a selection becomes the right body and
   that an empty selection returns `null`. No app needed.
2. **The link modes are what you claim** — assert `linkModesFor(target, kind)`.
   One line, and it catches a `supports` list that drifts from the code.
3. **The round trip, in the app** — save a selection, insert it back, and assert
   it arrived. If you support live, also: edit the master and prove the live
   instance changed *and the duplicate did not*, then delete the master and
   prove the instance shows as missing. Those two are the whole feature and are
   invisible unless something checks them (`tests/e2e/snippets.spec.ts` SN-3 and
   SN-4).

Two traps that cost real time in the document surface, both of which will hit
any new surface:

- **Insertion replaces the selection**, the way a paste does. A test that saves
  a selection and then inserts without collapsing it first will see the copy
  *replace* the original and count one occurrence, not two.
- **The first-run corner cards eat clicks.** `local-ai-intro` is fixed
  bottom-centre at `z-225`; anything your panel puts in that band gets its
  clicks swallowed while Playwright reports the target visible, enabled and
  stable for the full timeout. Call `chooseCloudAiSource(window)` after
  `waitForReady`, and `suppressFeatureSpotlights` for the bottom-right card.

### A worked skeleton

```
src/renderer/src/components/<app>/<app>Snippets.ts
  ├─ <kind>BodyFromSelection(...)   → body | null      (capture, pure)
  ├─ insertSnippetInto<App>(...)    → boolean          (insertion, false = declined)
  ├─ use<App>SnippetTarget(...)     → registers while mounted
  └─ <app>SnippetTargetId(id)       → one place both host and picker agree on
```

Then: a menu item calling the save dialog, a menu item opening
`<SnippetLibrary kinds={[…]}>`, and the three tests. Nothing else.

## Honest failure states

Each of these is a case where the plausible-looking behaviour is the wrong one.

- **A deleted master** renders "this live snippet no longer exists", naming what
  to do about it. A live instance is a reference, so a dangling reference should
  look dangling and be fixable — not blank, and not a cached copy of what it
  used to say.
- **A corrupt body** reads back as an empty body *of the declared kind*, and the
  row stays listed. One bad row must not take out the library, and a snippet the
  user can see and delete beats one that silently vanished.
- **A body whose kind disagrees with its row** is treated as unreadable rather
  than handed over, so a slide surface can never be given an object a document
  wrote.
- **An empty selection** is refused on save, in the dialog and again in the
  store. An empty library entry cannot be told apart from any other one.
- **An unreadable library** is reported as empty *and errored*, never as an
  empty library that looks fine.

## Where the code is

| Path | What |
|---|---|
| `src/shared/snippets.ts` | the model, the target contract, and the pure rules both sides run |
| `src/main/db/snippets.ts` | the store and its DDL (`ensureSnippetSchema`, registered in `migrations.ts`) |
| `src/main/ipc/index.ts` | seven `snippets:*` handlers |
| `src/preload/index.ts` | `window.api.snippets` |
| `src/renderer/src/stores/snippets.ts` | the library state and the target registry |
| `src/renderer/src/components/snippets/` | `SnippetLibrary`, `SaveSnippetDialog` |
| `.../documents/embed/SnippetEmbedNode.tsx` | the live node, in the shared schema |
| `.../documents/embed/SnippetEmbed.tsx` | resolves a live instance; owns the missing state |
| `.../documents/editor/docSnippets.ts` | the document as a snippet surface |
| `.../desk/deskSnippets.ts` | the desk as a snippet surface (duplicate only) |
| `.../documents/draw/editor/drawSnippets.ts` | PlexiiDraw as a snippet surface (duplicate only) |
| `.../documents/draw/commands/snippets.commands.ts` | Edit › Save selection as snippet… and Insert snippet… (also on the canvas context menu) |
| `.../documents/draw/dialogs/{saveSnippet,snippetLibrary}.dialog.tsx` | the app's dialogs, shown `frameless` by the studio |
| `lib/contextMenu/` | `FrameCallbacks.onSaveAsSnippet`, beside `onSaveAsFile` |

The DDL lives in its own module rather than in `schema.ts` for the reason
`migrations.ts` documents: the cloud runtime builds its database from `SCHEMA`
alone, and a table added only there would drop every snippet row arriving in a
sync body.

## Tests

- `tests/unit/snippets.test.ts` — the shared rules: what a target accepts, link
  modes, search (including inside body text), emptiness per kind, kind/body
  agreement, summaries.
- `tests/unit/snippetsDb.test.ts` — the store: scope coercion in the personal
  workspace, org isolation on list, revision bumped on a body change but not on
  a rename, refusing to empty a snippet, corrupt and wrong-kind bodies, usage
  counting, forking.
- `tests/unit/drawTools/snippets.test.ts`: Draw: capture is pure and keeps
  groups, masks, compound paths, text and image/swatch references; insertion
  makes fresh ids where a paste lands, never touches the snippet, and declines
  read-only, hidden-layer, live and older-format cases; the target claims
  Duplicate only; the menu items.
- `tests/e2e/snippetsDraw.spec.ts`: Draw in the real app: save a selection
  from the Edit menu, insert it back as a duplicate, and read two copies with
  distinct ids and identical geometry back from the stored drawing.
- `tests/e2e/snippets.spec.ts` — the round trip in the real app: save a
  selection, insert a duplicate, insert a live instance, edit the master and
  prove the live instance changed while the duplicate did not, delete the master
  and prove the live instance shows as missing, and the personal-workspace
  Organisation tab.

SN-3 and SN-4 are the ones worth keeping: the duplicate/live difference and the
dangling-reference state are both invisible unless something checks them.
