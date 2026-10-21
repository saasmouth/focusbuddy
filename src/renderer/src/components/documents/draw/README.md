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
| `editor/history.ts` | Undo: `commit`, `replace`, `begin` / `preview` / `commit` / `cancel`. |
| `tools/*.tool.ts(x)` | One tool per file, picked up automatically. |
| `commands/*.commands.ts` | Commands and their menu placement, picked up automatically. |
| `commands/keymap.ts` | Key bindings: one sorted line each. |
| `panels/*.panel.tsx` | Right-dock panels, picked up automatically. |
| `dialogs/*.dialog.tsx` | Modal dialogs a command can open, picked up automatically. |
| `render/*` | Rendering: `SceneView` (memoised per node), `Overlay`, `Toolbox`, `OptionsBar`, `TextEditor`. |
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
  // key: 'K',          // optional shortcut letter, or 'Shift+K'; a unit test fails on a clash
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

**Keyboard shortcut:** add ONE line to `commands/keymap.ts`, keeping the file
sorted:

```ts
'mod+shift+h': ['object.flipHorizontal', 'prevent'],
```

`mod` is ⌘ or Ctrl. A Shift chord with no binding of its own falls back to the
plain key. Tool letters live on the tools. `tests/unit/drawTools/registry.test.ts`
fails on a key bound twice, a letter that collides with a binding, an unsorted
keymap, or a binding naming an unknown command.

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

## Writing v2

`DRAW_V2_WRITES` (`src/shared/draw/compat.ts`) is **off**. While it is off:

- a drawing that uses nothing v1 lacks is written as v1, byte-identical to the
  v1 writer, so every older app can still edit it;
- a drawing that is already v2 stays v2.

**Turning on v2 writes:** do this only once the guard release (the first build
that opens newer drawings read-only instead of dropping what it does not know)
has been out long enough that users no longer run older builds. It is a
one-line change, and `tests/unit/drawMigrate.test.ts` documents what changes.

Two more rules while writes are off:

- Do not ship a feature that creates v2-only content (groups, several
  artboards, swatches) before writes are on. `drawDocForStorage` would then
  write v2 for that drawing, which pre-guard builds cannot open safely.
- Live co-editing upgrades a room to v2 only when every participant can read
  v2. Advertising that is future work in `LiveDocEditorView`.

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
