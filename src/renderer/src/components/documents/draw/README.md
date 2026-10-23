# PlexiiDraw: how to add a tool, a command, a bar tab, a panel or a dialog

PlexiiDraw is built from registries. Every tool, command, top-bar tab, panel
and dialog is its own file, and the editor finds it on its own (Vite and Vitest
expand `import.meta.glob` at build time). **Adding a feature means adding
files.** You do not edit `DrawStudio.tsx`, the menu bar, the tool rail, the top
bar or a shared list.

The studio sits on the shared office shell (`components/office/shell`, spec
`docs/office-shell/SPEC.md` §6.2), like every office app:

- the **tool rail** on the left is the tool registry (`render/rail.tsx`):
  the toolbox's sections and order, each tool's LIVE key, flyouts, the
  overlay-panel buttons at the bottom and the fill/stroke chips under them;
- the **top bar** (ContextBar): the menu bar and the tabs on one row; Undo and
  Redo pinned left, the active tab's controls, and zoom, fit, grid, snap, the
  artboard size and the status at the right (`render/RightSlot.tsx`). Tabs are
  `bar/*.tab.tsx`: Home, Object and Align always, contextual ones (Type, Shape,
  Brush, Anchors, Path, Group, Image, Artboard) while their context holds;
- **overlay panels** (`panels/*.panel.tsx`: Layers F7, Artboards) float over
  the canvas beside the rail and can be pinned. **There is no right-hand
  inspector and no docked panel column** (owner ruling). A pinned panel insets
  the viewport (`StudioRefs.inset`), so ⌘0 and Paste use the part it leaves.
- Content panes (an AI or comments pane, anything read and typed in) would go
  in the shell's right `ShellSidePane`; Draw has none today.
- The shell adds **no key listener**: the editor's keymap is the only key
  handler. Arrows, Enter and Space on a focused bar or rail control stay with
  that control; tool letters and command chords still reach the keymap. The one shared file is `commands/keymap.ts`, and only when you add
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
| `AiSidePane.tsx`, `generate/*`, `commands/ai.commands.ts` | PlexiiAssist: describe it and the model draws it. Vector art comes back as a scene of named shapes (`@shared/draw/generate/scene.ts`), validated against hostile output and compiled to ordinary editable paths with the same geometry the tools use; paint comes back from OpenAI gpt-image-1 onto a paint layer framed on its artboard. The pane lives in the shared right `ShellSidePane` (owner D1) and PREVIEWS with `drawDocToSvg` before anything is applied; each apply is one `ctx.history.commit`. The model call is `src/main/ai/drawGenerate.ts`. |
| `tools/*.tool.ts(x)` | One tool per file, picked up automatically. |
| `commands/*.commands.ts` | Commands and their menu placement, picked up automatically. |
| `commands/keymap.ts` | Key bindings (Illustrator's defaults): one sorted line each, plus the keys reserved for features still to come. |
| `commands/illustratorKeys.ts` | Adobe's default-shortcut table, every row, and what each means here. |
| `commands/keys.ts` | Reading key presses, platform labels, per-profile remapping. |
| `bar/*.tab.tsx` | Top-bar tabs (Home, Object, Align and the contextual ones), picked up automatically. `bar/controls.tsx`: command-driven bar buttons and the Fill/Stroke paint popover. |
| `panels/*.panel.tsx` | Overlay panels (ShellPanel) with a rail button, picked up automatically. |
| `editor/shellPrefs.ts` | The chrome per profile: the bar's tab and collapse, pinned panels, the last tool of each flyout. |
| `tools/flyouts.ts` | Rail flyouts: a tool joins one with `flyout: '<id>'`. |
| `dialogs/*.dialog.tsx` | Modal dialogs a command can open, picked up automatically. |
| `render/*` | Rendering: `SceneView` (memoised per node), `Overlay`, `TextEditor`; the rail mapping (`rail.tsx`) and the bar's right slot (`RightSlot.tsx`). |
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
  group: 5,             // rail section; a divider is drawn between sections
  order: 170,           // position on the rail (existing tools use 10..160)
  // flyout: 'measure',  // optional: tools sharing a flyout show as ONE rail button
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
    // enabled AND disabledReason, both from one pure predicate (commands/gate.ts)
    ...gate(firstOf(notReadOnly, unless((ctx) => ctx.get().selection.length > 0, 'Select something to flip.'))),
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
- A command that cannot work must show as disabled, and say why (SPEC §9.5).
  Give it `...gate(why)` from `commands/gate.ts`: `why(ctx)` returns a short
  sentence ("Select two or more paths to combine them.") or null, and both
  `enabled` and `disabledReason` are read from it, so the grey state and the
  sentence under it cannot disagree. `firstOf(notReadOnly, …)` puts the
  read-only reason first; `unless(ok, 'sentence')` turns a check into a why.
  The menu bar, the right-click menu and the bar buttons show the sentence.
  `commandRegistryProblems()` fails on a menu command with `enabled` and no
  reason, and `tests/unit/drawTools/menuReasons.test.ts` sweeps the menus
  through blank, read-only, locked, selected and anchor states for a greyed
  item without one. It is never a no-op that looks like it worked. A command
  that runs and fails sets an honest `ctx.status(...)`.

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

## Add a top-bar tab: one new file

Settings of the selection or of the active tool go in a tab, never in a
panel. Create `bar/<id>.tab.tsx` and default-export a `DrawBarTab`:

```tsx
// bar/gradient.tab.tsx
import { BarGroup } from '../../../office/shell'
import type { DrawBarTab, EditorCtx } from '../editor/types'
import { CmdButton, useEditor } from './controls'

function GradientTab({ ctx }: { ctx: EditorCtx }): JSX.Element {
  useEditor(ctx) // re-render with the editor
  return (
    <BarGroup label="Gradient">
      <CmdButton ctx={ctx} id="paint.reverseGradient" icon="swap_horiz" testid="draw-gradient-reverse" />
    </BarGroup>
  )
}

const gradient: DrawBarTab = {
  id: 'gradient',
  label: 'Gradient',
  order: 125,                           // contextual tabs use 100+
  when: (s) => s.tool === 'gradient',   // leave out for an always-there tab
  component: GradientTab
}

export default gradient
```

- Use the shell's bar primitives (`BarButton`, `BarToggle`, `BarNumber`,
  `BarSelect`, `BarColor`, `BarMenu`, `BarDialogButton`, `BarCustom`) or
  `CmdButton` / `CmdToggle`, which take the command's label, its LIVE key for
  the tooltip, and its `enabled` state with the command's own `disabledReason`
  as the off tooltip: the bar and the menu say the same sentence, and a
  button has no reason of its own (`tests/unit/drawBarReasons.test.tsx`).
  Give the reason to the command (`gate`), not to the button.
- A contextual tab appears while `when` holds and never switches to itself
  (owner D3); when it vanishes while active, the bar falls back to Home.
- A read-only drawing greys every control without `readOnlySafe` and says why
  (the bar's `readOnly`); a `BarCustom` widget asks `useBarReadOnly()`.

## Add a panel: one new file

A panel is for things that are not settings of the selection: a list
(Layers, Artboards, later Swatches, Symbols, History). Create
`panels/<id>.panel.tsx`, default-export a `DrawPanel`, and add its toggle
command (`window.<id>`) to `commands/window.commands.ts`'s pattern (a
`panelCommand` line, plus its Illustrator key in `keymap.ts` if it has one):

```tsx
// panels/swatches.panel.tsx
import { useStore } from 'zustand'
import type { DrawPanel, EditorCtx } from '../editor/types'

function SwatchesPanel({ ctx }: { ctx: EditorCtx }): JSX.Element {
  const swatches = useStore(ctx.store, (s) => s.doc.swatches)
  return <div data-testid="draw-swatches-panel">{/* … calls ctx.run('…') … */}</div>
}

const swatches: DrawPanel = {
  id: 'swatches',
  title: 'Swatches',
  icon: 'palette',
  order: 30,                  // Layers 10, Artboards 20
  command: 'window.swatches', // toggles it; its key and menu item come from there
  component: SwatchesPanel
}

export default swatches
```

It shows as a `ShellPanel` (testid `draw-panel-<id>`) beside the rail, opened
from its rail button (`draw-rail-<id>`), its menu item or its key. Which are
open is editor state (`openPanels`), so all three agree. It closes on Esc or
an outside click unless pinned; pinned panels reopen with the editor. Panels
sit inside a read-only `fieldset`, so a read-only drawing turns their
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
- **The pasteboard** (4.3.41, `ops/pasteboard.ts`) is Illustrator's canvas: a
  16383-unit (about 227 in) square centred on the artboards, grown to take in
  every artboard, object and paint layer, so scrolling reaches everything.
  It is one empty element (`draw-pasteboard`) whose size gives the scroll
  range; the stage sits in it at `(frame - pasteboard) × zoom`, and a
  document point is at `(p - pasteboard) × zoom`, so when the pasteboard
  shifts the scroll shifts with it. The art's and the overlay's SVGs are
  sized to the visible part plus half a window each side
  (`viewport.ts renderWindow`), never to the pasteboard, and only move when
  the view leaves that window. Art outside every artboard stays in the
  drawing and is left out of export.
- **The active artboard** is `doc.activeArtboardId` (`primaryArtboard`). A
  press on a page makes it active (`editor/artboards.ts` `activateArtboard`):
  no undo step and no save of its own. New art, pastes, Paste in Place,
  ⌘0 and the Artboard size dialog all act on the active one.
- **Paint layers** lie in their own frame (`rasterLayerFrame`): a picture of
  exactly `frame.w` × `frame.h` pixels whose top-left is at `frame.x`,
  `frame.y` in document space. A layer with no `frame` is the FIRST page at
  the origin (`rasterFrame`), as every drawing before 4.3.41 has it -- on
  screen, in export, and when rasterizing. Do not size a paint canvas from
  the active artboard. The raster service takes points in document space
  and maps them to each layer's own pixels (`beginStroke(p, brush, layerId)`).
- **Paint follows its artboard** (4.3.41) by its own origin and extent, the
  rule vector art follows -- no artboard id on the layer. A paint layer is
  ON an artboard when its frame lies wholly inside it (`paintOnArtboard`);
  it is the artboard's page-sized paint when its frame IS the artboard.
  Moving artboards (the tool, Rearrange All; with Move/Copy Artwork on)
  moves the frames of the paint on them with the art, in the same step, and
  never touches pixels. Resizing an artboard (the tool's handles, the
  Artboard tab, the Options dialog, the panel, Fit to Artwork/Selected Art,
  Document › Artboard size) re-lays its page-sized paint onto the new size,
  unscaled -- growing adds transparent margin, shrinking crops, the pixels
  stay where they were in the document -- via `planPaintFollow` +
  `editor/artboards.ts` (`changeArtboardWithPaint`, `followResizeInPlace`),
  one undo step. Locked paint stays put; a picture that cannot be decoded is
  left as it was. Duplicating an artboard does not copy paint layers (a
  paint layer is a layer, not art on the page).
- **Operations** are pure, in `@shared/draw/ops` (`artboards.ts`): add,
  delete (the art stays), rename, patch, reorder, move (with the art on it),
  duplicate (with copies of that art), fit, Rearrange All. Commands are in
  `commands/artboards.commands.ts`; the tool is `tools/artboard.tool.tsx`
  (⇧O), with the contextual Artboard tab (`bar/artboard.tab.tsx`); the
  overlay panel `panels/artboards.panel.tsx` opens from the rail, Window ›
  Artboards or the tab's "Artboards…".
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

## Saving: the studio never saves

`DrawStudio` emits `onChange(body)` for every edit; its HOST persists. A
drawing's host (the document editor, a live session) writes each change, so
there is nothing to save, File › Save shows disabled ("drawings save as you
work") and ⌘S is left alone (`keyWhen`), as it always was.

A host that writes only when asked -- a saved snippet's edit session,
`components/snippets/SnippetEditSessionView.tsx` -- passes `onSaveRequest`.
File › Save and ⌘S (`file.save`, Illustrator's key, bound in `keymap.ts`) then
call it and prevent the key's default, from the canvas, a field of the studio
and the canvas text box alike (typing is already in the emitted body). It is
disabled on a read-only drawing. The editor reads it through
`ctx.host.saveRequest()` at call time. A session passes no `foldExternal`,
`liveUndo` or `v2Blocked`; it remounts the studio (a `key`) when it replaces
the body, since the studio reads `content` only on mount.

**A snippet is not a document.** `src/shared/draw/snippetBody.ts` converts
between them: `drawBodyFromSnippet(snip)` opens a `DrawSnippetBody` as a v2
drawing (one vector layer, the objects untouched, one transparent artboard
around their visible bounds plus a 32 px margin -- the artboard moves to the
art, never the art to the artboard, so open-and-save never creeps), and
`snippetFromDrawBody(body, prev)` writes the edited drawing back as
`{ body, lost }`, where `lost` is one sentence per thing the snippet cannot
hold as it was (a paint layer kept as a picture, extra artboards, layers,
a background, unused swatches). The host shows `lost` before it writes.

The session also passes `session={{ kind: 'snippet' }}`. Every command that
acts on a DOCUMENT is then disabled with the session's reason, on its key and
through `ctx.run` too (`editor/session.ts`): New, New from preset, Open SVG,
Make a copy, Rename, Version history, Move to trash, Meeting. Save, Export (a
file the person picks) and editing stay on.

## The document on screen: DocumentOps

Draw has no document id of its own. The HOST binds one: DocumentEditorView and
OfficeDocWidget (desks, the Workcentre, widgets embedded
in a document) build `createDocumentOps({ id, docType: 'draw', title, onOpen,
onTrashed, onRenamed })` (`documents/editor/documentOps.ts`) for the drawing
they loaded and pass it as DrawStudio's `documentOps`. The editor reads it as
`ctx.host.docOps()`.

The document commands above are written with `documentCommand`, whose run is
handed those ops -- `run: (ctx, ops) => ops.moveToTrash()` -- and they reach a
document no other way. No Draw command imports the documents store or reads
its `active` document: on a desk that is whatever Documents last had open, and
until 4.3.41 a Draw widget's Move to trash binned it. Where no host supplies
a document (a live drawing, headless runs), the commands are disabled with
"Not available here: this drawing is not stored in Documents." -- never a
fallback to `active`. `tests/unit/drawDocumentOps.test.tsx` is the tripwire
and the per-command proof; `tests/unit/drawSnippetSession.test.tsx` fails if a
new command reaches a document without `documentCommand`.

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
