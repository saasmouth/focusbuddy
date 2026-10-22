import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { acceptsWidgetDrag, widgetIdFromDrop } from '../../lib/widgetDropInsert'
import { claimZoomCommands } from '../../lib/zoomCommands'
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
import { toolById } from './draw/tools/registry'
import IsolationBar from './draw/render/IsolationBar'
import Overlay from './draw/render/Overlay'
import ReadOnlyBanner from './draw/render/ReadOnlyBanner'
import CanvasContextMenu from './draw/render/CanvasContextMenu'
import KeysNotice from './draw/render/KeysNotice'
import ScratchView from './draw/render/ScratchView'
import TextEditor from './draw/render/TextEditor'
import ArtboardsView from './draw/render/ArtboardsView'
import { VectorLayerView } from './draw/render/SceneView'
import RightSlot from './draw/render/RightSlot'
import { RailFooter, activeRailId, drawRailItems, withBadges, type RailCtx } from './draw/render/rail'
import { CmdButton } from './draw/bar/controls'
import { drawBarTabs } from './draw/bar/registry'
import { panelById } from './draw/panels/registry'
import { rememberFlyoutTool, setShellPrefs, shellPrefs } from './draw/editor/shellPrefs'
import { fieldKeepsKey, subscribeKeyOverrides } from './draw/commands/keys'
import { ContextBar, OfficeShellLayout, ShellPanel, ToolRail, type BarTab, type ContextBarHandle } from '../office/shell'

// PlexiiDraw -- the vector + painting studio. This file is only the HOST: it
// mounts the editor (documents/draw/editor), wires real services into it
// (canvases, the font engine, the scroll viewport, the host), and lays it out
// on the shared office shell (components/office/shell): the menu bar and the
// tabbed top bar (ContextBar), the tool rail (ToolRail), the canvas, and the
// overlay panels (ShellPanel) -- no right-hand inspector or docked column.
// Tools, commands, bar tabs, panels and dialogs are registered by their own
// files -- see documents/draw/README.md. The shell adds no key listener: the
// editor's keymap (below) is the only key handler.

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

/** Focus is on a control of the studio's chrome (the top bar, the rail, a panel), not the canvas. */
function inChrome(el: HTMLElement | null): boolean {
  // A key sent to the window or the document has no element target.
  if (!el || typeof el.closest !== 'function' || el === document.body) return false
  return !!el.closest('[data-testid="draw-shell"]') && !el.closest('[data-testid="draw-canvas-scroll"]')
}

/**
 * Keys a focused control of the chrome handles itself (the rail and the bar
 * move focus with the arrows; Enter and Space press the focused button), so
 * they must not also nudge, open tool options or start panning. Tool letters
 * and command chords still reach the keymap, as in Illustrator.
 */
const CHROME_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Home', 'End', 'Tab'])

function keyInput(e: KeyboardEvent): KeyInput {
  const el = e.target as HTMLElement | null
  const inField = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
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
  const rootRef = useRef<HTMLDivElement | null>(null)
  const barHandle = useRef<ContextBarHandle | null>(null)
  /** Screen px of the viewport's left edge that pinned overlay panels cover (domServices: Fit, Paste). */
  const insetRef = useRef(0)
  const focusCanvas = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), [])

  // One editor per mounted studio. Services read through refs, so they always
  // see the current DOM and props.
  const editorRef = useRef<DrawEditor | null>(null)
  if (!editorRef.current) {
    const refs = { canvases: canvases.current, loaded: loaded.current, scratch, scroll: scrollRef, onChange: onChangeRef, title: titleRef, liveUndo: liveUndoRef, inset: insetRef }
    // ⌥F6 (window.focusNext): the canvas, then the top bar, then the tool rail.
    const ui = {
      cycleFocus: (): void => {
        const root = rootRef.current
        const el = document.activeElement as HTMLElement | null
        const bar = root?.querySelector<HTMLElement>('[data-testid="draw-bar"]')
        const rail = root?.querySelector<HTMLElement>('[data-testid="draw-toolbox"]')
        if (bar && el && bar.contains(el)) {
          ;(rail?.querySelector<HTMLElement>('button[tabindex="0"]') ?? rail?.querySelector<HTMLElement>('button:not([disabled])'))?.focus()
        } else if (rail && el && rail.contains(el)) {
          scrollRef.current?.focus({ preventScroll: true })
        } else barHandle.current?.focusBar()
      }
    }
    editorRef.current = createDrawEditor(content, createDomServices(refs, () => editorRef.current!.store, ui))
    // Before anything can be edited: a live session with an older participant keeps the drawing v1.
    if (v2Blocked) editorRef.current.store.setState({ v2Writes: false, v2Blocked })
    // Pinned panels reopen with the editor (they stay open while you work).
    const pinned = shellPrefs.getState().pinned.filter((id) => panelById(id))
    if (pinned.length) editorRef.current.store.setState({ openPanels: pinned })
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

  // ⌘/Ctrl and Option/Alt held, for the rail: ⌘ with the Pen borrows Direct
  // Selection (shown as the active tool), and Alt-click on a flyout button
  // steps through its tools, as in Illustrator.
  const [modHeld, setModHeld] = useState(false)
  const altHeld = useRef(false)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      altHeld.current = e.altKey
      setModHeld(e.metaKey || e.ctrlKey)
      // Already handled in the capture phase (a chord typed in a top-bar field; see onKeyDownCapture).
      if ((e as KeyboardEvent & { drawHandled?: boolean }).drawHandled) return
      // A popover of the chrome (a rail flyout, a bar menu) already handled
      // this key (Escape closes it): it is not also a canvas key.
      const target = e.target as HTMLElement | null
      if (e.defaultPrevented && target && typeof target.closest === 'function' && target !== document.body && !target.closest('[data-testid="draw-canvas-scroll"]')) return
      const k = keyInput(e)
      // A focused button of the top bar, the rail or a panel keeps its own
      // navigation keys: they never nudge, pan or open tool options.
      if (!k.inField && CHROME_KEYS.has(e.key) && inChrome(e.target as HTMLElement | null)) return
      // Escape leaves a field (the text box, a top-bar or panel input).
      if (k.inField && e.code !== 'Space' && e.key === 'Escape') (e.target as HTMLElement).blur()
      editor.keyDown(k)
    }
    function onKeyUp(e: KeyboardEvent): void {
      altHeld.current = e.altKey
      setModHeld(e.metaKey || e.ctrlKey)
      editor.keyUp(e)
    }
    function onBlur(): void {
      altHeld.current = false
      setModHeld(false)
    }
    // The app menu's Edit › Cut / Copy / Paste (Electron roles) arrive as DOM
    // clipboard events; see editor/menuClipboard.ts for why keys never double up.
    function onClipboard(e: ClipboardEvent): void {
      handleClipboardEvent(editor.ctx, e.type as ClipboardEventKind, clipboardEventInfo(e))
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    document.addEventListener('cut', onClipboard)
    document.addEventListener('copy', onClipboard)
    document.addEventListener('paste', onClipboard)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
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

  // The app's zoom keys and View › Zoom items zoom the DRAWING while it is
  // open (⌘0 fits the active artboard, as in Illustrator), even when the app
  // menu takes the key before the page sees it (lib/zoomCommands.ts).
  useEffect(
    () =>
      claimZoomCommands((dir) => {
        ctx.run(dir === 'in' ? 'view.zoomIn' : dir === 'out' ? 'view.zoomOut' : 'view.fit')
        return true
      }),
    [ctx]
  )

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
  // ── Office shell: rail, top bar, overlay panels ───────────────────────────

  const prefs = useStore(shellPrefs)
  // Re-render when the person remaps a key, so the rail and bar show the new one.
  const [keysTick, setKeysTick] = useState(0)
  useEffect(() => subscribeKeyOverrides(() => setKeysTick((n) => n + 1)), [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const railItems = useMemo(() => drawRailItems(), [keysTick])
  // The rail shows the tool last used in each flyout, however it was chosen (rail, key, menu).
  useEffect(() => {
    const t = toolById(tool)
    if (t?.flyout) rememberFlyoutTool(t.flyout, t.id)
  }, [tool])
  const railCtx: RailCtx = { ctx, s: state, altHeld: () => altHeld.current }
  const barTabs = useMemo<BarTab<RailCtx>[]>(
    () =>
      drawBarTabs().map((t) => {
        const C = t.component
        return {
          id: t.id,
          label: t.label,
          contextual: !!t.when,
          ...(t.when ? { when: (c: RailCtx) => t.when!(c.s) } : {}),
          render: (c: RailCtx) => <C ctx={c.ctx} />
        }
      }),
    []
  )
  const changeTab = useCallback((id: string) => setShellPrefs({ tab: id }), [])
  const changeCollapsed = useCallback((collapsed: boolean) => setShellPrefs({ collapsed }), [])

  // Pinned panels inset the viewport, so Fit and Paste use the part they leave visible.
  const rects = useRef<Map<string, DOMRect>>(new Map())
  const [inset, setInset] = useState(0)
  const reportRect = useCallback((id: string, r: DOMRect | null) => {
    if (r) rects.current.set(id, r)
    else rects.current.delete(id)
    const sc = scrollRef.current?.getBoundingClientRect()
    let right = 0
    if (sc) for (const b of rects.current.values()) right = Math.max(right, b.right - sc.left + 8)
    const next = Math.max(0, Math.round(right))
    insetRef.current = next
    setInset(next)
  }, [])
  const setPinned = useCallback((id: string, pin: boolean) => {
    const cur = shellPrefs.getState().pinned
    setShellPrefs({ pinned: pin ? [...new Set([...cur, id])] : cur.filter((p) => p !== id) })
  }, [])
  const panelEls = state.openPanels
    .map((id) => panelById(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .map((p) => {
      const Panel = p.component
      return (
        <ShellPanel
          key={p.id}
          id={p.id}
          title={p.title}
          icon={p.icon}
          open
          onClose={() => ctx.run(p.command, false)}
          pinnable
          pinned={prefs.pinned.includes(p.id)}
          onPinnedChange={(v) => setPinned(p.id, v)}
          onRectChange={(r) => reportRect(p.id, r)}
          returnFocus={focusCanvas}
          testid={`draw-panel-${p.id}`}
        >
          {/* A disabled fieldset turns every control inside off natively: read-only. */}
          <fieldset disabled={state.readOnly} className="contents">
            <Panel ctx={ctx} />
          </fieldset>
        </ShellPanel>
      )
    })

  const dialog = state.dialog ? dialogById(state.dialog.id) : undefined
  const closeDialog = (): void => store.setState({ dialog: null })
  // One artboard: the stage IS the page (its background). Several: the stage
  // is pasteboard, and each artboard draws its own page (ArtboardsView).
  const bgNone = !multi && board.background.type === 'none'

  return (
    <div
      ref={rootRef}
      className="h-full flex flex-col text-[13px]"
      data-testid="draw-studio"
      onKeyDownCapture={(e) => {
        // The shell's own fields (bar numbers and menus) keep their keys from
        // the window. A command chord typed in one -- ⇧⌘P, ⌘0, F7 -- still
        // runs, as from any studio field (fieldKeepsKey), handled here once.
        const el = e.target as HTMLElement
        const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
        if (!field || !inChrome(el) || el.closest('[data-text-editing="1"]') || fieldKeepsKey(e)) return
        ;(e.nativeEvent as KeyboardEvent & { drawHandled?: boolean }).drawHandled = true
        editor.keyDown(keyInput(e.nativeEvent))
      }}
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
      <OfficeShellLayout
        testid="draw-shell"
        bar={
          <ContextBar<RailCtx>
            testid="draw-bar"
            tabs={barTabs}
            ctx={railCtx}
            activeTab={prefs.tab}
            onTabChange={changeTab}
            collapsed={prefs.collapsed}
            onCollapsedChange={changeCollapsed}
            readOnly={state.readOnly}
            barRef={barHandle}
            menuBar={<DrawStudioMenuBar ctx={ctx} />}
            pinnedStart={
              <>
                <CmdButton ctx={ctx} id="edit.undo" icon="undo" label="Undo" testid="draw-undo" />
                <CmdButton ctx={ctx} id="edit.redo" icon="redo" label="Redo" testid="draw-redo" />
              </>
            }
            rightSlot={<RightSlot ctx={ctx} />}
          />
        }
        rail={
          <ToolRail<RailCtx>
            testid="draw-toolbox"
            ariaLabel="Tools"
            items={withBadges(railItems, state)}
            ctx={railCtx}
            activeId={activeRailId(state, modHeld)}
            openPanels={state.openPanels}
            lastUsed={prefs.lastUsed}
            onFlyoutPick={(f, id) => rememberFlyoutTool(f, id)}
            readOnly={state.readOnly}
            footer={<RailFooter s={state} onOpen={() => changeTab('home')} />}
          />
        }
        panels={panelEls.length ? <>{panelEls}</> : undefined}
      >
      <div className="h-full flex flex-col min-h-0">
      {/* Notices sit beside a pinned panel, never under it. */}
      <div className="shrink-0" style={inset ? { paddingLeft: inset } : undefined}>
        {state.readOnly && <ReadOnlyBanner compat={state.compat} />}

        <KeysNotice ctx={ctx} />

        <IsolationBar ctx={ctx} />
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Canvas */}
        {/* The grey around the stage is pasteboard: a press there goes to the
            tool too (draw an artboard with the Artboard tool, start a marquee,
            deselect), in the same document coordinates. Only presses on the
            grey itself -- never the scrollbars, never the stage's own. */}
        <div
          ref={scrollRef}
          tabIndex={-1}
          className="flex-1 min-w-0 overflow-auto bg-stone-200/60 dark:bg-black/40 p-6 outline-none"
          style={inset ? { paddingLeft: 24 + inset } : undefined}
          data-testid="draw-canvas-scroll"
          onPointerDown={(e) => {
            const el = e.currentTarget
            if (e.target !== el || e.button === 2) return
            const r = el.getBoundingClientRect()
            if (e.clientX - r.left - el.clientLeft >= el.clientWidth || e.clientY - r.top - el.clientTop >= el.clientHeight) return
            el.setPointerCapture(e.pointerId)
            editor.pointerDown(toolPointer(e))
          }}
          onPointerMove={(e) => {
            if (e.target === e.currentTarget) editor.pointerMove(toolPointer(e))
          }}
          onPointerUp={(e) => {
            if (e.target === e.currentTarget) editor.pointerUp(toolPointer(e))
          }}
          onPointerCancel={(e) => {
            if (e.target === e.currentTarget) editor.pointerUp(toolPointer(e))
          }}
          onContextMenu={(e) => {
            if (e.target === e.currentTarget) onContextMenu(e)
          }}
        >
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

      </div>
      </div>
      </OfficeShellLayout>

      {menuAt && <CanvasContextMenu ctx={ctx} at={menuAt} onClose={closeMenu} />}

      {dialog && (
        <MenuModal title={dialog.title} onClose={closeDialog} width={dialog.width}>
          <dialog.component ctx={ctx} props={state.dialog?.props} close={closeDialog} />
        </MenuModal>
      )}
    </div>
  )
}
