// The services the studio gives the editor in the real app: paint layers on
// <canvas>, real-font text measuring, the scrolling viewport, and the host
// (saving, co-editing undo, export through the main process).

import type { DrawBody } from '@shared/draw'
import type { Box } from '@shared/drawGeometry'
import { artboardsBounds, primaryArtboard, rasterFrame, rasterLayerFrame } from '@shared/draw/ops'
import type { LiveUndo } from '../../../../lib/yjsKeyedJson'
import type { DocumentOps } from '../../editor/documentOps'
import { fontShorthand, layoutText } from '../textMeasure'
import { clampZoom } from '../viewport'
import { createCanvasRaster } from './canvasRaster'
import type { EditorServices } from './editor'
import type { DrawSession, EditorState, UiService } from './types'

export interface StudioRefs {
  canvases: Map<string, HTMLCanvasElement>
  loaded: Map<string, string>
  scratch: { current: HTMLCanvasElement | null }
  scroll: { current: HTMLDivElement | null }
  onChange: { current: (body: unknown) => void }
  title: { current: string }
  liveUndo: { current: LiveUndo | undefined }
  /** The host's Save, when it saves only on request (DrawStudio's `onSaveRequest`). */
  onSaveRequest?: { current: (() => void) | undefined }
  /** What the studio edits when it is not a document (DrawStudio's `session`). */
  session?: { current: DrawSession | undefined }
  /** The document on screen, bound by the host to its id (DrawStudio's `documentOps`). */
  documentOps?: { current: DocumentOps | undefined }
  /**
   * How much of the viewport's left edge pinned overlay panels cover, in
   * screen px. Fit and Paste work in the visible part, so ⌘0 centres the art
   * beside a pinned Layers panel rather than under it.
   */
  inset: { current: number }
  /**
   * A fit waiting for the stage to be laid out at its new zoom. The studio
   * runs it in a layout effect, in the same frame the zoom lands, so the view
   * never shows a frame scrolled to the wrong place (on a 227-inch pasteboard
   * that frame is far from the art) and a click right after a fit hits what
   * is drawn. Optional: without it the fit centres two frames later.
   */
  pendingCentre?: { current: (() => void) | null }
}

/** Services bound to a studio's refs; `store` is read lazily, once the editor exists. */
export function createDomServices(refs: StudioRefs, store: () => { getState(): EditorState; setState(p: Partial<EditorState>): void }, ui?: UiService): EditorServices {
  const doc = (): EditorState['doc'] => store().getState().doc

  /**
   * Zoom so `box` (document units) fills the window, then scroll it to the
   * middle once the stage has been laid out at the new zoom. With one artboard
   * and the whole artboard asked for, this is the old Fit to window exactly.
   */
  function fitBox(box: Box, opts: { pad?: number; maxZoom?: number } = {}): void {
    const el = refs.scroll.current
    if (!el || !(box.w > 0) || !(box.h > 0)) return
    const inset = Math.max(0, Math.min(refs.inset.current, el.clientWidth - 96))
    const pad = Math.max(0, opts.pad ?? 24)
    const room = (n: number): number => Math.max(16, n - 2 * pad)
    const z = clampZoom(Math.min(opts.maxZoom ?? 4, Math.min(room(el.clientWidth - inset) / box.w, room(el.clientHeight) / box.h)))
    const zoomChanges = store().getState().zoom !== z
    store().setState({ zoom: z })
    const centre = (): void => {
      if (refs.pendingCentre && refs.pendingCentre.current === centre) refs.pendingCentre.current = null
      const sc = refs.scroll.current
      const stage = sc?.querySelector('[data-testid="draw-stage"]') as HTMLElement | null
      if (!sc || !stage) return
      const f = artboardsBounds(doc())
      const zz = store().getState().zoom
      const sr = stage.getBoundingClientRect()
      const cr = sc.getBoundingClientRect()
      // Centred in the part of the viewport no pinned panel covers.
      const left = sc.scrollLeft + (sr.left - cr.left - sc.clientLeft) + (box.x - f.x) * zz - inset - (sc.clientWidth - inset - box.w * zz) / 2
      const top = sc.scrollTop + (sr.top - cr.top - sc.clientTop) + (box.y - f.y) * zz - (sc.clientHeight - box.h * zz) / 2
      sc.scrollLeft = Math.max(0, left)
      sc.scrollTop = Math.max(0, top)
    }
    if (refs.pendingCentre) {
      // Same zoom: the stage is already laid out, so centre now. A new zoom:
      // the studio's layout effect centres once React has committed it.
      if (!zoomChanges) return centre()
      refs.pendingCentre.current = centre
      return
    }
    // Two frames: React commits the new zoom, then the browser lays it out.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(centre))
  }

  return {
    raster: createCanvasRaster({
      canvases: refs.canvases,
      loaded: refs.loaded,
      scratch: refs.scratch,
      // Each paint layer's pixels lie in its own frame (the first page at the
      // origin unless it has followed an artboard), whichever artboard is active.
      frame: (layerId) => {
        const d = doc()
        const l = layerId ? d.layers.find((x) => x.id === layerId) : undefined
        return l ? rasterLayerFrame(d, l) : rasterFrame(d)
      }
    }),
    text: {
      measure: (o) => ({
        ...o,
        lines: layoutText({ text: o.text, width: o.w, font: fontShorthand(o), letterSpacing: o.letterSpacing, fontSize: o.fontSize, lineHeight: o.lineHeight }).lines
      })
    },
    viewport: {
      getScroll: () => ({ left: refs.scroll.current?.scrollLeft ?? 0, top: refs.scroll.current?.scrollTop ?? 0 }),
      setScroll: (left, top) => {
        const sc = refs.scroll.current
        if (!sc) return
        sc.scrollLeft = left
        sc.scrollTop = top
      },
      fit: () => fitBox(primaryArtboard(doc())),
      fitBox,
      visibleRect: () => {
        // The scroll viewport, mapped through the stage's on-screen box exactly
        // as pointer events are (DrawStudio.toolPointer).
        const el = refs.scroll.current
        const stage = el?.querySelector('[data-testid="draw-stage"]')
        if (!el || !stage) return null
        const r = el.getBoundingClientRect()
        const st = stage.getBoundingClientRect()
        const z = store().getState().zoom
        const b = artboardsBounds(doc())
        // Less what a pinned panel covers on the left.
        const inset = Math.max(0, Math.min(refs.inset.current, el.clientWidth - 96))
        return { x: (r.left + el.clientLeft + inset - st.left) / z + b.x, y: (r.top + el.clientTop - st.top) / z + b.y, w: (el.clientWidth - inset) / z, h: el.clientHeight / z }
      }
    },
    ui,
    host: {
      emit: (stored) => refs.onChange.current(stored),
      liveUndo: () => refs.liveUndo.current,
      saveRequest: () => refs.onSaveRequest?.current,
      session: () => refs.session?.current,
      title: () => refs.title.current,
      docOps: () => refs.documentOps?.current,
      exportAs: async (format, opts) => {
        const s = store()
        // A drawing this build cannot fully show cannot be honestly exported:
        // the file would silently leave out what the newer app added.
        if (s.getState().readOnly) {
          s.setState({ status: 'This artwork was made in a newer PlexiiDraw — update to export it.' })
          return
        }
        s.setState({ busy: `Exporting ${format.toUpperCase()}…` })
        try {
          // The main process accepts a v1 body or a v2 document and normalises it.
          const res = await window.api.draw.export({ draw: doc() as unknown as DrawBody, title: refs.title.current || 'drawing', format, ...(opts ?? {}) })
          if (res.ok && res.path) s.setState({ status: `Saved to ${res.path}` })
          else if (res.error) s.setState({ status: res.error })
        } finally {
          s.setState({ busy: null })
        }
      }
    }
  }
}
