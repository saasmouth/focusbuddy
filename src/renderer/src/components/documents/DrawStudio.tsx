import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import type { LiveUndo } from '../../lib/yjsKeyedJson'
import { loadGoogleFont, familyLabel } from '../../lib/googleFonts'
import DrawStudioMenuBar from './editor/DrawStudioMenuBar'
import { MenuModal } from './editor/menuBarKit'
import * as raster from './draw/raster'
import { scrollToKeepPoint, wheelZoom } from './draw/viewport'
import { drawId } from '@shared/draw'
import { assetSrc } from '@shared/draw/assets'
import { DRAW_V2_WRITES } from '@shared/draw/compat'
import { docPaintToCss } from '@shared/draw/svg'
import type { DrawWidgetNode } from '@shared/draw/model'
import { addObject, artboardsBounds, primaryArtboard, rasterFrame, targetLayerId } from '@shared/draw/ops'
import { walkNodes } from '@shared/draw/tree'
import { createDrawEditor, type DrawEditor } from './draw/editor/editor'
import { clipboardEventInfo, handleClipboardEvent, type ClipboardEventKind } from './draw/editor/menuClipboard'
import { createDomServices } from './draw/editor/domServices'
import { dragHasFiles, placeDroppedFiles, readDroppedFiles } from './draw/editor/fileDrop'
import type { KeyInput, ToolPointer } from './draw/editor/types'
import { dialogById } from './draw/dialogs/registry'
import { drawPanels } from './draw/panels/registry'
import { toolById } from './draw/tools/registry'
import IsolationBar from './draw/render/IsolationBar'
import OptionsBar from './draw/render/OptionsBar'
import Overlay from './draw/render/Overlay'
import ReadOnlyBanner from './draw/render/ReadOnlyBanner'
import CanvasContextMenu from './draw/render/CanvasContextMenu'
import KeysNotice from './draw/render/KeysNotice'
import ScratchView from './draw/render/ScratchView'
import TextEditor from './draw/render/TextEditor'
import Toolbox from './draw/render/Toolbox'
import ArtboardsView from './draw/render/ArtboardsView'
import { VectorLayerView } from './draw/render/SceneView'

// PlexiiDraw -- the vector + painting studio. This file is only the SHELL: it
// mounts the editor (documents/draw/editor), wires real services into it
// (canvases, the font engine, the scroll viewport, the host), and lays out
// the toolbox, canvas, panels, menu bar and dialogs. Tools, commands, panels
// and dialogs are registered by their own files -- see documents/draw/README.md.

interface Props {
  content: unknown
  title: string
  onChange: (body: unknown) => void
  /** Live co-editing only: fold a peer's merged body back in. */
  foldExternal?: boolean
  /**
   * Live co-editing only: an undo stack of THIS person's changes (see
   * yjsKeyedJson.createLiveUndo). When present, undo and redo go through it
   * instead of restoring whole snapshots -- a snapshot would also roll back
   * whatever a collaborator changed since it was taken.
   */
  liveUndo?: LiveUndo
  /**
   * Live co-editing only: why this drawing must stay in the older (v1) format
   * for this session -- someone present cannot read v2 -- or null/absent when
   * it may become v2. v2-only commands then show disabled with this reason.
   */
  v2Blocked?: string | null
}

function keyInput(e: KeyboardEvent): KeyInput {
  const el = e.target as HTMLElement | null
  const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  return {
    key: e.key,
    code: e.code,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    shiftKey: e.shiftKey,
    altKey: e.altKey,
    inField,
    // The canvas text box is a field of the studio too, but typing on the
    // canvas is guarded separately (editingText), so it keeps every key.
    inStudioField: inField && !!el?.closest('[data-testid="draw-studio"]') && !el.closest('[data-text-editing="1"]'),
    preventDefault: () => e.preventDefault()
  }
}

export default function DrawStudio({ content, title, onChange, foldExternal = false, liveUndo, v2Blocked = null }: Props): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvases = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const loaded = useRef<Map<string, string>>(new Map())
  const scratch = useRef<HTMLCanvasElement | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const titleRef = useRef(title)
  titleRef.current = title
  const liveUndoRef = useRef(liveUndo)
  liveUndoRef.current = liveUndo

  // One editor per mounted studio. Services read through refs, so they always
  // see the current DOM and props.
  const editorRef = useRef<DrawEditor | null>(null)
  if (!editorRef.current) {
    const refs = { canvases: canvases.current, loaded: loaded.current, scratch, scroll: scrollRef, onChange: onChangeRef, title: titleRef, liveUndo: liveUndoRef }
    editorRef.current = createDrawEditor(content, createDomServices(refs, () => editorRef.current!.store))
    // Before anything can be edited: a live session with an older participant keeps the drawing v1.
    if (v2Blocked) editorRef.current.store.setState({ v2Writes: false, v2Blocked })
  }
  const editor = editorRef.current
  const { ctx, store } = editor
  const state = useStore(store)
  const { doc, zoom, tool } = state
  const board = primaryArtboard(doc)
  // The stage shows every artboard: its top-left is the top-left of their
  // union (with one artboard, exactly that artboard, as always).
  const frame = artboardsBounds(doc)
  const multi = doc.artboards.length > 1

  // Fold a peer's merge (or an own-change undo coming back) in live co-editing.
  // Never pushed onto undo -- another person's edit is not ours to take back.
  const firstFold = useRef(true)
  useEffect(() => {
    if (!foldExternal) return
    if (firstFold.current) {
      firstFold.current = false
      return
    }
    editor.fold(content)
  }, [content, foldExternal, editor])

  // A participant joining or leaving a live session can turn v2 writes off or back on.
  useEffect(() => {
    store.setState(v2Blocked ? { v2Writes: false, v2Blocked } : { v2Writes: DRAW_V2_WRITES, v2Blocked: null })
  }, [v2Blocked, store])

  // Re-render when the live own-change stack changes, so Undo enables correctly.
  useEffect(() => (liveUndo ? liveUndo.subscribe(() => store.setState((s) => ({ liveUndoTick: s.liveUndoTick + 1 }))) : undefined), [liveUndo, store])

  // ── Paint layers ───────────────────────────────────────────────────────────

  /**
   * A STABLE ref callback per layer id. An inline ref would detach (null) and
   * reattach on every render: a stroke started in that window found no canvas,
   * and the detach dropped the "already loaded" marker, so the layer reloaded
   * mid-stroke. One cached callback per id attaches once and detaches only on a
   * real unmount.
   */
  const refCallbacks = useRef<Map<string, (el: HTMLCanvasElement | null) => void>>(new Map())
  function rasterRefFor(id: string): (el: HTMLCanvasElement | null) => void {
    let fn = refCallbacks.current.get(id)
    if (!fn) {
      fn = (el): void => {
        if (el) canvases.current.set(id, el)
        else {
          canvases.current.delete(id)
          // A genuinely unmounted canvas comes back blank, so the layer must be
          // re-loaded from its stored pixels when it remounts.
          loaded.current.delete(id)
          refCallbacks.current.delete(id)
        }
      }
      refCallbacks.current.set(id, fn)
    }
    return fn
  }

  // Paint each layer's stored pixels into its canvas whenever they change. The
  // `loaded` map stops a re-render mid-stroke from wiping live brush work.
  useEffect(() => {
    for (const layer of doc.layers) {
      if (layer.kind !== 'raster') continue
      const canvas = canvases.current.get(layer.id)
      if (!canvas) continue
      const src = assetSrc(doc.assets, layer.assetId) ?? ''
      if (loaded.current.get(layer.id) === src) continue
      loaded.current.set(layer.id, src)
      void raster.loadIntoCanvas(canvas, src)
    }
  }, [doc])

  // ── Fonts ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    for (const l of doc.layers) {
      if (l.kind !== 'vector') continue
      walkNodes(l.objects, (o) => {
        if (o.type === 'text' && o.fontFamily) loadGoogleFont(familyLabel(o.fontFamily))
      })
    }
  }, [doc.layers])

  // ── Keyboard ───────────────────────────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      const k = keyInput(e)
      // Escape leaves a field (the text box, an inspector input).
      if (k.inField && e.code !== 'Space' && e.key === 'Escape') (e.target as HTMLElement).blur()
      editor.keyDown(k)
    }
    function onKeyUp(e: KeyboardEvent): void {
      editor.keyUp(e)
    }
    // The app menu's Edit › Cut / Copy / Paste (Electron roles) arrive as DOM
    // clipboard events; see editor/menuClipboard.ts for why keys never double up.
    function onClipboard(e: ClipboardEvent): void {
      handleClipboardEvent(editor.ctx, e.type as ClipboardEventKind, clipboardEventInfo(e))
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('cut', onClipboard)
    document.addEventListener('copy', onClipboard)
    document.addEventListener('paste', onClipboard)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('cut', onClipboard)
      document.removeEventListener('copy', onClipboard)
      document.removeEventListener('paste', onClipboard)
    }
  }, [editor])

  // ── Zoom ───────────────────────────────────────────────────────────────────

  // Cmd/Ctrl + wheel zooms about the pointer: the artboard point under it is
  // remembered before the zoom and the view is scrolled after layout so the
  // same point is under the pointer again.
  const zoomAnchor = useRef<{ docX: number; docY: number; clientX: number; clientY: number } | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onWheel(e: WheelEvent): void {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const r = stageRef.current?.getBoundingClientRect()
      if (r) {
        const z = store.getState().zoom
        zoomAnchor.current = { docX: (e.clientX - r.left) / z, docY: (e.clientY - r.top) / z, clientX: e.clientX, clientY: e.clientY }
      }
      store.setState((s) => ({ zoom: wheelZoom(s.zoom, e.deltaY) }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [store])
  useLayoutEffect(() => {
    const a = zoomAnchor.current
    zoomAnchor.current = null
    const sc = scrollRef.current
    const r = stageRef.current?.getBoundingClientRect()
    if (!a || !sc || !r) return
    const next = scrollToKeepPoint({ ...a, stageLeft: r.left, stageTop: r.top, zoom, scrollLeft: sc.scrollLeft, scrollTop: sc.scrollTop })
    sc.scrollLeft = next.scrollLeft
    sc.scrollTop = next.scrollTop
  }, [zoom])

  // Fit the artboard on first paint so a 4K canvas is not opened at 1:1.
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current) return
    fitted.current = true
    ctx.viewport.fit()
  }, [ctx])

  // ── Pointer ────────────────────────────────────────────────────────────────

  function toolPointer(e: React.PointerEvent | React.MouseEvent): ToolPointer {
    const r = stageRef.current?.getBoundingClientRect()
    const z = store.getState().zoom
    const f = artboardsBounds(store.getState().doc)
    const p = r ? { x: (e.clientX - r.left) / z + f.x, y: (e.clientY - r.top) / z + f.y } : { x: 0, y: 0 }
    const pe = e as React.PointerEvent
    return {
      p,
      clientX: e.clientX,
      clientY: e.clientY,
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      pressure: typeof pe.pressure === 'number' ? pe.pressure : 0,
      detail: e.detail
    }
  }

  function onPointerDown(e: React.PointerEvent): void {
    if (e.button === 2) return
    // The text box is a child of the stage, so its own clicks bubble here. They
    // belong to the textarea: capturing the pointer would start dragging the
    // object and make the box impossible to type in.
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'TEXTAREA' || target.closest('[data-text-editing="1"]'))) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    editor.pointerDown(toolPointer(e))
  }

  // ── Right-click ────────────────────────────────────────────────────────────

  // The canvas context menu runs the registered commands (Copy is edit.copy).
  // As in Illustrator, right-clicking an object that is not selected selects
  // it first; right-clicking empty canvas keeps the selection.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  function onContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'TEXTAREA' || target.closest('[data-text-editing="1"]'))) return
    const s = store.getState()
    if (!s.gesture && !s.pen) {
      const hit = ctx.hitTest(toolPointer(e).p)
      if (hit && !s.selection.includes(hit.id)) ctx.select([hit.id])
    }
    setMenuAt({ x: e.clientX, y: e.clientY })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const stageW = frame.w * zoom
  const stageH = frame.h * zoom
  // Paint layers are pictures of the first page, anchored at the origin.
  const rf = rasterFrame(doc)
  const rasterStyle = { left: (rf.x - frame.x) * zoom, top: (rf.y - frame.y) * zoom, width: rf.w * zoom, height: rf.h * zoom }
  const cursor = tool === 'hand' || state.spaceDown ? 'grab' : (toolById(tool)?.cursor ?? 'default')
  const panels = useMemo(() => drawPanels(), [])
  const dialog = state.dialog ? dialogById(state.dialog.id) : undefined
  const closeDialog = (): void => store.setState({ dialog: null })
  // One artboard: the stage IS the page (its background). Several: the stage
  // is pasteboard, and each artboard draws its own page (ArtboardsView).
  const bgNone = !multi && board.background.type === 'none'

  return (
    <div
      className="h-full flex flex-col text-[13px]"
      data-testid="draw-studio"
      onDragOver={(e) => {
        // Files from the desktop are placed where they are dropped (WP-IMPORT).
        if (dragHasFiles(e.dataTransfer)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = state.readOnly ? 'none' : 'copy'
          return
        }
        if (!acceptsWidgetDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        if (dragHasFiles(e.dataTransfer) && e.dataTransfer.files.length) {
          e.preventDefault()
          const at = toolPointer(e).p
          void readDroppedFiles(e.dataTransfer.files).then((files) => placeDroppedFiles(ctx, files, at))
          return
        }
        if (!acceptsWidgetDrag(e.dataTransfer)) return
        e.preventDefault()
        void widgetIdFromDrop(e.dataTransfer).then((widgetId) => {
          if (!widgetId) return
          // Placed like any other object, on the active layer, so it moves,
          // scales, reorders and deletes with the rest of the drawing.
          const d = ctx.doc()
          // On the active artboard, a quarter of the way in.
          const b = primaryArtboard(d)
          const obj: DrawWidgetNode = {
            id: drawId('obj'),
            type: 'widget',
            widgetId,
            x: Math.round(b.x + b.w * 0.25),
            y: Math.round(b.y + b.h * 0.25),
            w: Math.round(b.w * 0.4),
            h: Math.round(b.w * 0.28)
          }
          ctx.history.commit(addObject(d, obj, targetLayerId(d)), 'Place work widget')
          ctx.select([obj.id])
        })
      }}
    >
      <DrawStudioMenuBar ctx={ctx} />

      {state.readOnly && <ReadOnlyBanner compat={state.compat} />}

      <KeysNotice ctx={ctx} />

      <OptionsBar ctx={ctx} />

      <IsolationBar ctx={ctx} />

      <div className="flex-1 min-h-0 flex">
        <Toolbox ctx={ctx} />

        {/* Canvas */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-auto bg-stone-200/60 dark:bg-black/40 p-6" data-testid="draw-canvas-scroll">
          <div
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={(e) => editor.pointerMove(toolPointer(e))}
            onPointerUp={(e) => editor.pointerUp(toolPointer(e))}
            onPointerCancel={(e) => editor.pointerUp(toolPointer(e))}
            onPointerLeave={() => editor.pointerLeave()}
            onDoubleClick={(e) => editor.doubleClick(toolPointer(e).p)}
            onContextMenu={onContextMenu}
            data-testid="draw-stage"
            className="relative mx-auto touch-none select-none shadow-lg"
            style={{
              width: stageW,
              height: stageH,
              cursor,
              // A checkerboard shows through a transparent artboard, so "no
              // background" reads as genuinely transparent rather than white.
              backgroundImage: bgNone
                ? 'linear-gradient(45deg,#d6d3d1 25%,transparent 25%),linear-gradient(-45deg,#d6d3d1 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#d6d3d1 75%),linear-gradient(-45deg,transparent 75%,#d6d3d1 75%)'
                : undefined,
              backgroundSize: bgNone ? '16px 16px' : undefined,
              backgroundPosition: bgNone ? '0 0,0 8px,8px -8px,-8px 0' : undefined,
              background: multi ? 'transparent' : bgNone ? undefined : docPaintToCss(doc, board.background)
            }}
          >
            {multi && <ArtboardsView doc={doc} frame={frame} zoom={zoom} />}

            {doc.layers.map((l) =>
              !l.visible ? null : l.kind === 'raster' ? (
                <canvas
                  key={l.id}
                  ref={rasterRefFor(l.id)}
                  width={rf.w}
                  height={rf.h}
                  data-testid={`draw-raster-${l.id}`}
                  className="absolute pointer-events-none"
                  style={{ ...rasterStyle, opacity: l.opacity, mixBlendMode: l.blend as never }}
                />
              ) : (
                <VectorLayerView
                  key={l.id}
                  layer={l}
                  board={frame}
                  stageW={stageW}
                  stageH={stageH}
                  assets={doc.assets}
                  swatches={doc.swatches}
                  hiddenId={state.editingText}
                />
              )
            )}

            {state.scratchVisible && scratch.current && (
              <ScratchView canvas={scratch.current} box={rasterStyle} opacity={state.brush.opacity} blend={tool === 'eraser' ? 'normal' : state.brush.blend} />
            )}

            <Overlay state={state} board={board} frame={frame} stageW={stageW} stageH={stageH} />

            <TextEditor ctx={ctx} />
          </div>
        </div>

        {/* Right column: the panel dock. A disabled fieldset turns every
            control inside it off natively, which is what read-only needs. */}
        <div className="shrink-0 flex flex-col border-l border-[var(--edge-soft)]" style={{ width: 240 }}>
          <fieldset disabled={state.readOnly} className="contents">
            {panels
              .filter((p) => !p.when || p.when(state))
              .map((p) => {
                const Panel = p.component
                return p.height ? (
                  <div key={p.id} className="shrink-0 border-t border-[var(--edge-soft)]" style={{ height: p.height }}>
                    <Panel ctx={ctx} />
                  </div>
                ) : (
                  <div key={p.id} className="flex-1 min-h-0 overflow-auto">
                    <Panel ctx={ctx} />
                  </div>
                )
              })}
          </fieldset>
        </div>
      </div>

      {menuAt && <CanvasContextMenu ctx={ctx} at={menuAt} onClose={closeMenu} />}

      {dialog && (
        <MenuModal title={dialog.title} onClose={closeDialog} width={dialog.width}>
          <dialog.component ctx={ctx} props={state.dialog?.props} close={closeDialog} />
        </MenuModal>
      )}
    </div>
  )
}
