# PlexiiDraw: how to add a tool, a command, a panel or a dialog

PlexiiDraw is built from registries. Every tool, command, panel and dialog is
its own file, and the editor finds it on its own (Vite and Vitest expand
`import.meta.glob` at build time). **Adding a feature means adding files.** You
do not edit `DrawStudio.tsx`, the menu bar, the toolbox, the inspector or a
shared list. The one shared file is `commands/keymap.ts`, and only when you add
a keyboard shortcut. There, add one line per binding.

## Map

| Where | What |
|---|---|
| `src/shared/draw/model.ts` | The v2 document types (`DrawDoc`, `DrawNode`, artboards, assets, swatches, guides, settings, appearance, effects). |
| `src/shared/draw/ops/*.ts` | Every document edit as a pure function (`DrawDoc` in, `DrawDoc` out). Unchanged nodes keep their identity. Import from `@shared/draw/ops`. |
| `src/shared/draw/normalize.ts` | Untrusted JSON to a valid `DrawDoc`. |
| `src/shared/draw/fields/*.ts` | Field hooks a package adds (`fieldHooks.ts`), loaded automatically. |
| `src/shared/draw/svg.ts` | The serializer. Screen and export share its paint descriptions. |
| `src/shared/draw/compat.ts` | The forward-compatibility guard and the v2 write gate. |
| `editor/editor.ts` | The editor without React: the store, the context, and the pointer and keyboard dispatch. |
| `editor/types.ts` | The contracts: `EditorState`, `EditorCtx`, `DrawTool`, `Command`, `MenuSpec`, `DrawPanel`, `DrawDialog`, and the services. |
| `editor/anchorSelection.ts` | The anchor-level selection (Direct Selection and the anchor tools) and the anchor/handle/segment hit-test they share. Set `anchorTool: true` on a tool that edits anchors. |
| `src/shared/draw/geometry/{bezier,fit,pathEdit}.ts` | Bezier maths (split, nearest point, intersections), curve fitting (Simplify, Smooth, Curvature) and anchor-level path edits. |
| `editor/history.ts` | Undo: `commit`, `replace`, `begin` / `preview` / `commit` / `cancel`. |
| `editor/clipboard.ts` | Copy, Cut and the Paste family: the native clipboard payload, pasting between drawings, pictures and text from other apps, and `registerSvgPasteImporter`, the seam through which `commands/import.commands.ts` (WP-IMPORT) makes SVG on the clipboard paste as editable vectors (`pasteSvgImporter`). The system clipboard itself is `src/main/drawClipboard.ts`; tests swap it with `setDrawClipboardBackend`. |
| `editor/menuClipboard.ts` | The app menu bar's Edit › Cut / Copy / Paste (main/index.ts `editMenu`, which calls webContents.cut/copy/paste so the DOM clipboard event fires even with no text selected) run the same commands as ⌘X / ⌘C / ⌘V, never twice. Files copied in Finder paste through `registerFilePasteImporter` exactly as File › Place places them. A copy never puts the SVG source on text/plain (Edit › Copy As › SVG Code does). |
| `render/CanvasContextMenu.tsx` | The canvas right-click menu: registered commands only (`CANVAS_MENU`). |
| `tools/*.tool.ts(x)` | One tool per file, picked up automatically. |
| `commands/*.commands.ts` | Commands and their menu placement, picked up automatically. |
| `commands/keymap.ts` | Key bindings (Illustrator's defaults): one sorted line each, plus the keys reserved for features still to come. |
| `commands/illustratorKeys.ts` | Adobe's default-shortcut table, every row, and what each means here. |
| `commands/keys.ts` | Reading key presses, platform labels, per-profile remapping. |
| `panels/*.panel.tsx` | Right-dock panels, picked up automatically. |
| `dialogs/*.dialog.tsx` | Modal dialogs a command can open, picked up automatically. |
| `render/*` | Rendering: `SceneView` (memoised per node), `Overlay`, `Toolbox`, `OptionsBar`, `TextEditor`. |
| `src/shared/draw/import/*` | Import: `imageInfo.ts` (what a file is, its size and resolution) and `svg/` (the SVG importer, pure, with its import report). |
| `editor/importFiles.ts`, `editor/place.ts`, `editor/fileDrop.ts` | Place, Open/Import SVG, Replace and file drops. Side effects come in through `ImportDeps`. |
| `tests/unit/drawTools/harness.ts` | `ToolHarness`: drives the real editor headlessly. |

## Add a tool: one new file

Create `tools/<id>.tool.ts`, or `.tool.tsx` if it draws an overlay, and
default-export a `DrawTool`:

```ts
// tools/measure.tool.tsx: Measure (no letter yet), drag to read a distance.
import type { DrawTool } from '../editor/types'

const measure: DrawTool = {
  id: 'measure',
  label: 'Measure',
  icon: 'straighten',
  group: 5,             // toolbox section; a divider is drawn between sections
  order: 170,           // position in the toolbox (existing tools use 10..160)
  // key: 'Shift+W',    // optional: Illustrator's key for the tool ('M', 'Shift+W'); a unit test fails on a clash
  // onOptions(ctx) {},  // optional options dialog: Enter while active, or double-click the tool
  cursor: 'crosshair',
  onPointerDown(ctx, e) {
    // e.p is in ARTBOARD coordinates. Start a gesture: it routes the next moves
    // and the pointer-up back to this tool.
    ctx.set({ gesture: { toolId: 'measure', data: { from: e.p, to: e.p } } })
  },
  onPointerMove(ctx, e) {
    const g = ctx.get().gesture
    if (g?.toolId === 'measure') ctx.set({ gesture: { toolId: 'measure', data: { ...(g.data as object), to: e.p } } })
  },
  onPointerUp(ctx) {
    // Read state with ctx.get(), the document with ctx.doc(), and change it
    // through ctx.history (see "Undo" below).
  },
  Overlay({ state, k }) {
    // Optional: drawn in artboard units over the art; k = 1 / zoom keeps
    // strokes and handles a constant on-screen size.
    return null
  },
  overlayOrder: 60
}

export default measure
```

Rules:

- **Change the document only through `ctx.history`.**
  - Use `ctx.history.commit(next, 'Label')` for one step.
  - For a streamed gesture, call `const t = ctx.history.begin('Label')` on
    pointer-down, `t.preview(next)` on every move, and `t.commit()` on
    pointer-up. Call `t.cancel()` when nothing changed, which takes the step
    back off the stack.
  - Never mutate a document. Build new ones with the `@shared/draw/ops`
    functions.
- **Tool-private gesture state goes in `state.gesture`**, keyed by your tool id,
  as in the example. State that must outlive a gesture (a transform origin, a
  key object) goes in `state.toolState[<your id>]`. Shared state goes in its
  own `EditorState` field, which is an explicit change to `editor/types.ts`.
- **Transforms go through `transform/apply.ts`** (`applyTransform`,
  `planMatrix`), so they honour Scale Strokes & Effects and Scale Corners,
  refuse frame matrices on drawings that cannot hold them, and are remembered
  for Transform Again (⌘D).
- **Side effects go through services**: `ctx.raster` for paint-layer pixels,
  `ctx.text` for measuring type, `ctx.viewport` and `ctx.host`. That is what
  lets the harness drive your tool with fakes.
- **Read-only drawings:** the dispatcher sends input only to tools with
  `readOnlySafe: true` (Select and Pan), and `history` refuses to write. Do not
  work around either.
- A tool with `hidden: true` is a MODE a command switches to, not a toolbox
  button (the Place cursor, `tools/place.tool.tsx`). It has no letter.
- Shared geometry and snapping helpers live in `tools/helpers.ts`. The shape
  tools are built by `tools/shapeTool.tsx`, and the brush and eraser by
  `tools/paintTool.ts`, if your tool is a variant of one of those.

## Add a command: one new file (or one entry)

Create `commands/<area>.commands.ts` exporting `commands`, plus `menus` if it
adds a top-level menu or a submenu heading:

```ts
// commands/transform.commands.ts
import type { Command, MenuSpec } from '../editor/types'
import { editableIds, mapObjects } from '@shared/draw/ops'

export const menus: MenuSpec[] = [
  { path: 'object/Transform', label: 'Transform', icon: 'transform', order: 130 } // a submenu of Object
]

export const commands: Command[] = [
  {
    id: 'object.flipHorizontal',
    label: 'Flip horizontal',
    icon: 'flip',
    menu: { path: 'object/Transform', order: 0 },  // orders in different hundreds get a separator
    shortcut: '⇧⌘H',                                // the label shown in the menu
    enabled: (ctx) => !ctx.get().readOnly && ctx.get().selection.length > 0, // must be pure
    run: (ctx) => {
      const s = ctx.get()
      ctx.history.commit(mapObjects(s.doc, editableIds(s.doc, s.selection), (o) => /* … */ o), 'Flip horizontal')
    }
  }
]
```

- Menus and submenus: `edit`, `file`, `object`, `layer`, `document`, `view` and
  `help` exist. Add a top-level menu with `{ path: 'effect', label: 'Effect', order: 35 }`.
- A command runs from the menu (`menu`), from a key (see below), from any
  component (`ctx.run('object.flipHorizontal')`), and from any future caller
  (the command palette, the assistant, MCP). Panels call commands; they do not
  edit the document themselves.
- `keyWhen(ctx)` (optional) decides whether a KEY binding fires now. When it
  returns false, the key falls through to the tool letters, which is how arrows
  do nothing when no object is selected.
- A command that cannot work must show as disabled through `enabled`. It is
  never a no-op that looks like it worked. A command that runs and fails sets
  an honest `ctx.status(...)`.

**Keyboard shortcut:** PlexiiDraw uses Illustrator's default keys. Look your
command up in `commands/illustratorKeys.ts` (Adobe's whole table, row by row)
and in `RESERVED_KEYS` in `commands/keymap.ts`:

- If Illustrator has a key for it, it is probably reserved under the id your
  command should use (`'mod+g': ['object.group', ...]`). Register the command
  with that id and add ONE line to `KEYMAP`, keeping the file sorted:

  ```ts
  'mod+g': ['object.group', 'prevent'],
  ```

  The reserved line can stay: a reservation is fulfilled when its own id takes
  the key. Binding a reserved key to a different id fails the registry test.
- A tool takes its key on the tool itself: `key: 'R'`, or `key: 'Shift+W'`,
  with the tool id the reservation names (`'tool:rotate'`).
- Key strings: `mod` (⌘ on a Mac, Ctrl on Windows), then `alt`, then `shift`,
  then the key: a letter or digit, the unshifted US symbol on the key (`=`,
  `[`, `'`, `\\`, `` ` ``), or the lower-cased `KeyboardEvent.key` (`escape`,
  `arrowleft`, `f1`). `commands/keys.ts` reads events into this form on any
  layout and writes keys for the platform (⇧⌘Z / Shift+Ctrl+Z); do not write
  `shortcut:` text on a command whose key is in the keymap.
- A Shift chord with no binding of its own falls back to the plain key unless
  Illustrator reserves it (Shift+M is the Shape Builder, never the Rectangle's M).
- Delivering a feature another package owns the key for? Do not take its key.
  A stand-in command with `pending: 'arrives with …'` and `enabled: () => false`
  holds a key and a menu place until the real command (same id) replaces it.

`tests/unit/drawTools/registry.test.ts` and `illustratorKeys.test.ts` fail on a
key bound twice, a tool key that collides with a binding, an unsorted keymap,
a binding naming an unknown command, a reserved key given to the wrong thing,
or a keymap that no longer matches Adobe's table. People can remap keys in
Edit › Keyboard shortcuts…; that is stored per profile and never edits
`keymap.ts`.

## Add a panel: one new file

Create `panels/<id>.panel.tsx` and default-export a `DrawPanel`:

```tsx
// panels/transform.panel.tsx
import { useStore } from 'zustand'
import type { DrawPanel, EditorCtx } from '../editor/types'

function TransformPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const selection = useStore(ctx.store, (s) => s.selection) // subscribe to the slices you read
  return <div data-testid="draw-transform-panel">{/* … calls ctx.run('…') … */}</div>
}

const transform: DrawPanel = {
  id: 'transform',
  title: 'Transform',
  dock: 'right',
  order: 15,        // inspector is 10, layers 20
  height: 180,      // fixed height; leave out to take the remaining space
  when: (s) => s.selection.length > 0, // optional: hide when irrelevant
  component: TransformPanel
}

export default transform
```

Panels sit inside the read-only `fieldset`, so a read-only drawing turns their
controls off with no code of their own.

## Add a dialog: one new file

Create `dialogs/<id>.dialog.tsx` and default-export a `DrawDialog`
(`{ id, title, component }`). A command opens it with
`ctx.set({ dialog: { id: '<id>', props } })`, and the component receives
`{ ctx, props, close }`. `dialogs/artboardSize.dialog.tsx` is an example.

## Add a field to the document model

`src/shared/draw/model.ts` is the schema. Do not change what an existing field
means.

- A new **optional** field on a node, layer, artboard or the document is kept
  verbatim by every v2 reader, including older ones (unknown fields are
  preserved).
  - Register a normaliser for it in a new file, `src/shared/draw/fields/<package>.ts`.
    `normalize.ts` loads every file in that folder automatically, in the
    renderer, the main process and tests:

    ```ts
    // src/shared/draw/fields/stroke.ts
    import { registerDrawField } from '../fieldHooks'
    registerDrawField('node', 'arrows', (v) => /* a valid value, or undefined to drop it */ v)
    ```

  - A field that ever reaches markup MUST have a hook and a case in
    `tests/unit/drawSvgInjectionV2.test.ts`.
- A new **node type**, layer kind or effect kind is unknown to older builds,
  which open such drawings read-only (the guard).
  - Add it to `model.ts`, `normalize.ts`, `svg.ts`, `render/SceneView.tsx`, and
    `DRAW_NODE_TYPES` / `DRAW_EFFECT_KINDS`.
  - A drawing that uses it must also raise `minWriterVersion`, so older builds
    never write it back.
- Rendering effects and appearance belongs to WP-APPEAR and WP-EFFECTS. The
  model declares them; `svg.ts` draws appearance stacks and does not yet draw
  effects.

## Groups, masks and isolation mode (WP-OBJ)

- **Where things sit.** A layer's nodes are in artboard space; a group's
  members are in the group's space, which its `transform` maps outwards. Use
  `@shared/draw/ops` (`groups.ts`): `allPlaces`, `placeOf`, `parentMatrixOf`,
  `worldBounds` / `nodesWorldBounds`, and `moveNodesWorld`,
  `scaleNodesWorld`, `rotateNodesWorld` to act on a member wherever it is.
  `moveObjects` and `scaleObjects` already go through these, so a tool that
  uses them works inside groups for free.
- **Clipping groups** are `{ type: 'group', clip: true }`; the TOPMOST member
  is the clip path (a path, compound path or type). `clipGroupParts` (in
  `ops/masks.ts`) is the one description the canvas and the exporter both
  draw: the clip, the contents, the clip path's own fill (under) and stroke
  (over). `nodeBounds` of a clipping group is its clip path's box.
- **Hit-testing.** `ctx.hitTest(p)` returns the object at the current level
  (top level, or inside the isolated group), honouring masks, locks and
  hidden objects; `ctx.hitTestDeep(p)` returns the innermost object under the
  point (for tools that act on one path, like Direct Selection or the
  eyedropper).
- **Isolation mode** is `state.isolation` (group ids, outermost first). Never
  read it raw: `isolationChain(state)` (in `editor/isolation.ts`) drops any
  part an undo or a peer removed. New art committed while isolated is moved
  into the isolated group by the history's `adjust` hook, so a new tool needs
  no code for it.
- **The v2 gate.** Groups and masks are v2-only content. Their commands are
  disabled (and say why on their key) only where a drawing must stay v1 (a live
  session with someone on an older version); see `editor/v2gate.ts`.

## Artboards (WP-ARTBOARD)

- **Where things sit.** Every artboard is a rectangle in DOCUMENT space; art
  lives in the same space and belongs to whichever artboard it sits inside
  (`artOnArtboard`: wholly inside, unlocked). The stage shows the union of
  all artboards (`artboardsBounds`); its top-left is that union's top-left,
  so `ToolPointer.p` is always document space. The grey around the stage is
  pasteboard and takes presses too.
- **The active artboard** is `doc.activeArtboardId` (`primaryArtboard`). A
  press on a page makes it active (`editor/artboards.ts` `activateArtboard`):
  no undo step and no save of its own. New art, pastes, Paste in Place,
  ⌘0 and the Artboard size dialog all act on the active one.
- **Paint layers** are pictures of the FIRST page anchored at the origin
  (`rasterFrame`), whichever artboard is active -- on screen, in export, and
  when rasterizing or merging. Do not size a paint canvas from the active
  artboard.
- **Operations** are pure, in `@shared/draw/ops` (`artboards.ts`): add,
  delete (the art stays), rename, patch, reorder, move (with the art on it),
  duplicate (with copies of that art), fit, Rearrange All. Commands are in
  `commands/artboards.commands.ts`; the tool is `tools/artboard.tool.tsx`
  (⇧O); the panel `panels/artboards.panel.tsx` shows with several artboards
  or while the tool is active.
- **The gate.** Several, moved or named artboards are v2-only: commands ask
  `artboardsEditable(state)` and refuse with `artboardsBlockedReason`.
- **Export** with several artboards asks what to cover
  (`dialogs/exportArtboards.dialog.tsx`): PNG/SVG one artboard, each to its
  own file, or the whole canvas; PDF one page per artboard (named CSS @page
  sizes, `drawDocToPagesHtml`) or the active one.

## Writing v2

`DRAW_V2_WRITES` (`src/shared/draw/compat.ts`) is **on** from 4.3.39-local.8.

- A v1 drawing becomes v2 on its first edit and save (`minWriterVersion` 2).
  Opening one without editing never rewrites it: the editor only saves on a
  history step.
- Builds from 4.3.39-local.6 on open a v2 drawing read-only (the guard).
  4.3.33 and earlier have no guard: editing a v2 drawing there can drop what
  they do not understand. What's New says so.
- **Live co-editing:** every client of a live drawing advertises `drawV2: true`
  in its awareness state (`lib/drawLiveSchema.ts`). While anyone present does
  not, the session keeps a v1 drawing v1: `LiveDocEditorView` passes
  `v2Blocked` to `DrawStudio`, which turns the editor's `v2Writes` off, and the
  v2-only commands (Group, Make Clipping Mask, Place as template, reflecting or
  shearing text, images and work widgets, Reset Bounding Box, pasting v2-only
  art) show disabled and say why. A drawing that is already v2 stays v2.
- **One gate.** Every command that may create v2-only content asks
  `v2Writable(state)` (`editor/v2gate.ts`) and words its refusal with
  `v2BlockedReason(state)`. Do not test `DRAW_V2_WRITES` directly.
- Tests: `withOlderPeer(harness(...))` (`tests/unit/drawTools/harness.ts`) is
  the v1-only live session; a plain harness is a normal drawing. Test both.

## Test it

- **Headless, the bulk of it.** `tests/unit/drawTools/harness.ts` builds the
  real editor with fake pixels, text and viewport. Add a
  `tests/unit/drawTools/<id>.test.ts`:

  ```ts
  import { harness, blank, rect } from './harness'
  const h = harness(blank([rect('a', 10, 10, 40, 40)]))
  h.tool('measure'); h.drag([10, 10], [110, 10]); h.key('Escape')
  expect(h.doc()).toMatchObject(/* … */); expect(h.state().past).toHaveLength(1)
  ```

- **Pure operations:** a test per `src/shared/draw/ops/<domain>.ts`.
- **End to end:** one spec per package (`tests/e2e/draw<Package>.spec.ts`)
  using `tests/e2e/_drawHelpers.ts`: `seedDrawDoc`, `openDocument`,
  `readStored`, `runMenu`, `stagePoint` and `keepNoticesOutOfTheWay`.
  - Always use `launchApp()`. It gives a throwaway profile, so never pass a
    real one.
  - The suite has a known red baseline. Compare your failures against a run of
    the same specs at your base commit, and report only the difference.
- `npm run typecheck && npm run test:unit` before every commit.

## Repository rules

- Commit path-scoped (`git add <paths>`, never `-A`); the tree is shared.
- Never run `prettier --write` on an existing file (there is no prettier
  config). For a new file use `npx prettier --no-semi --single-quote --print-width 100`.
- No fakery. Show an honest empty state, an honest error, an honest "this
  drawing is read-only". An export that leaves something out says what it left
  out.
- User-facing words: "work widget(s)", and "Plexii" is spelled with two i's.
