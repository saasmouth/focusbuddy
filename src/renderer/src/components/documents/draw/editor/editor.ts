// The PlexiiDraw editor, minus React.
//
// One store holds every piece of editor state; tools, commands and panels get
// an EditorCtx over it plus a few services (pixels, text measuring, the
// viewport, the host). The pointer and keyboard dispatchers route input to the
// active tool and the keymap. None of this touches the DOM, which is what lets
// tests/unit/drawTools drive every tool headlessly; the React shell
// (DrawStudio.tsx) supplies real services and renders the state.

import { createStore, type StoreApi } from 'zustand/vanilla'
import { solid } from '@shared/draw'
import type { Pt } from '@shared/drawGeometry'
import { putAsset } from '@shared/draw/assets'
import { drawDocCompatibility, drawDocForStorage } from '@shared/draw/compat'
import type { DrawDoc, DrawNode } from '@shared/draw/model'
import { declaredSchema, normalizeDrawDoc } from '@shared/draw/normalize'
import { hitNode, patchLayer, selectableObjectIds } from '@shared/draw/ops'
import { vectorLayersOf } from '@shared/draw/tree'
import { DEFAULT_BRUSH } from '../brushes'
import { commandById, keyBinding } from '../commands/registry'
import { drawTools, toolById } from '../tools/registry'
import { createHistory } from './history'
import type { EditorCtx, EditorState, History, HostService, KeyInput, RasterService, TextService, ToolPointer, ViewportService } from './types'

export interface EditorServices {
  raster: RasterService
  text: TextService
  viewport: ViewportService
  host: HostService
}

export interface DrawEditor {
  store: StoreApi<EditorState>
  ctx: EditorCtx
  history: History
  pointerDown(e: ToolPointer): void
  pointerMove(e: ToolPointer): void
  pointerUp(e: ToolPointer): void
  pointerLeave(): void
  doubleClick(): void
  keyDown(e: KeyInput): void
  keyUp(e: { code: string }): void
  /** Fold a document that changed underneath the editor (a co-editing peer, an own-change undo). */
  fold(content: unknown): void
}

/** The editor's starting state for stored content (v1 or v2, trusted or not). */
export function initialEditorState(content: unknown): EditorState {
  const compat = drawDocCompatibility(content)
  return {
    doc: normalizeDrawDoc(content),
    past: [],
    future: [],
    tool: 'select',
    selection: [],
    zoom: 1,
    fill: solid('#6d5dfc'),
    stroke: undefined,
    brush: DEFAULT_BRUSH,
    gesture: null,
    pen: null,
    cursorPt: null,
    editingText: null,
    guides: [],
    status: null,
    busy: null,
    showGrid: false,
    snapOn: true,
    spaceDown: false,
    scratchVisible: false,
    readOnly: compat.readOnly,
    compat,
    storedSchema: declaredSchema(content),
    dialog: null,
    liveUndoTick: 0
  }
}

/** Topmost node under a point, honouring layer order, lock and visibility. */
export function hitTestDoc(doc: DrawDoc, p: Pt, zoom: number): DrawNode | null {
  const layers = doc.layers
  for (let li = layers.length - 1; li >= 0; li--) {
    const l = layers[li]
    if (l.kind !== 'vector' || !l.visible || l.locked) continue
    for (let oi = l.objects.length - 1; oi >= 0; oi--) {
      const o = l.objects[oi]
      if (o.hidden || o.locked) continue
      // Rotation-aware; groups hit through their members; opaque never.
      if (hitNode(o, p, 4 / zoom)) return o
    }
  }
  return null
}

export function createDrawEditor(content: unknown, services: EditorServices): DrawEditor {
  const store = createStore<EditorState>(() => initialEditorState(content))

  /** Hand the document to the host in storage form -- never when read-only. */
  function emit(doc: DrawDoc): void {
    const s = store.getState()
    if (s.readOnly) return
    services.host.emit(drawDocForStorage(doc, { stored: s.storedSchema }))
  }

  const history = createHistory(store, { emit, host: services.host, onRestore: () => services.raster.invalidate() })

  const ctx: EditorCtx = {
    store,
    get: () => store.getState(),
    set: (patch) => store.setState(patch as Partial<EditorState>),
    doc: () => store.getState().doc,
    history,
    raster: services.raster,
    text: services.text,
    viewport: services.viewport,
    host: services.host,
    status: (msg) => store.setState({ status: msg }),
    busy: (msg) => store.setState({ busy: msg }),
    select: (ids) => store.setState({ selection: ids }),
    setTool: (id) => store.setState({ tool: id }),
    run: (id, args) => {
      const c = commandById(id)
      if (c) void c.run(ctx, args)
    },
    commitRaster: (layerId) => {
      if (!services.raster.hasSurface(layerId)) return
      const src = services.raster.snapshot(layerId)
      const doc = store.getState().doc
      const put = putAsset(doc.assets, src)
      history.commit(patchLayer({ ...doc, assets: put.assets }, layerId, { assetId: put.id }), 'Paint')
    },
    hitTest: (p) => hitTestDoc(store.getState().doc, p, store.getState().zoom)
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  function pointerDown(e: ToolPointer): void {
    if (e.button === 2) return
    const s = store.getState()
    // Pan wins over every tool while Space is held or the middle button is used.
    if (s.tool === 'hand' || s.spaceDown || e.button === 1) {
      toolById('hand')?.onPointerDown?.(ctx, e)
      return
    }
    // Read-only: look, select and pan -- the select tool knows how.
    if (s.readOnly) {
      toolById('select')?.onPointerDown?.(ctx, e)
      return
    }
    toolById(s.tool)?.onPointerDown?.(ctx, e)
  }

  function pointerMove(e: ToolPointer): void {
    store.setState({ cursorPt: e.p })
    const g = store.getState().gesture
    if (!g) return
    toolById(g.toolId)?.onPointerMove?.(ctx, e)
  }

  function pointerUp(e: ToolPointer): void {
    store.setState({ guides: [] })
    const g = store.getState().gesture
    if (!g) return
    toolById(g.toolId)?.onPointerUp?.(ctx, e)
    store.setState({ gesture: null })
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  function keyDown(e: KeyInput): void {
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space' && !e.inField) {
      store.setState({ spaceDown: true })
      e.preventDefault()
      return
    }
    // A field (the text box, an inspector input) keeps its own keys.
    if (e.inField) return
    const key = e.key.toLowerCase()
    const s = store.getState()
    if (s.readOnly) {
      // Selection, Escape and the two tools that cannot edit.
      if (mod && key === 'a') {
        e.preventDefault()
        store.setState({ selection: selectableObjectIds(s.doc) })
      } else if (!mod && e.key === 'Escape') store.setState({ selection: [] })
      else if (!mod && (key === 'v' || key === 'h')) store.setState({ tool: key === 'v' ? 'select' : 'hand' })
      return
    }
    const binding = keyBinding(e)
    if (binding) {
      const c = commandById(binding.command)
      if (c && (!c.keyWhen || c.keyWhen(ctx))) {
        if (binding.preventDefault) e.preventDefault()
        void c.run(ctx, e)
        return
      }
    }
    if (mod) return
    const match = drawTools().find((t) => t.key && t.key.toLowerCase() === key)
    if (match) store.setState({ tool: match.id })
  }

  function keyUp(e: { code: string }): void {
    if (e.code === 'Space') store.setState({ spaceDown: false })
  }

  return {
    store,
    ctx,
    history,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerLeave: () => store.setState({ cursorPt: null }),
    doubleClick: () => {
      // Double-click finishes a pen path in progress, whatever tool is active.
      if (store.getState().pen) ctx.run('pen.finish', { close: false })
    },
    keyDown,
    keyUp,
    fold(next) {
      // Another person's edit (or an own-change undo coming back) is never
      // pushed onto the local undo stack.
      const compat = drawDocCompatibility(next)
      store.setState({ doc: normalizeDrawDoc(next), compat, readOnly: compat.readOnly, storedSchema: Math.max(store.getState().storedSchema, declaredSchema(next)) })
      services.raster.invalidate()
    }
  }
}

/** Every vector-layer node id, for tests and the debug hook. */
export function allNodeIds(doc: DrawDoc): string[] {
  return vectorLayersOf(doc).flatMap((l) => l.objects.map((o) => o.id))
}
