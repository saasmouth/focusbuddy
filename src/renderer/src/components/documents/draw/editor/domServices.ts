// The services the studio gives the editor in the real app: paint layers on
// <canvas>, real-font text measuring, the scrolling viewport, and the host
// (saving, co-editing undo, export through the main process).

import type { DrawBody } from '@shared/draw'
import type { Box } from '@shared/drawGeometry'
import { artboardsBounds, primaryArtboard, rasterFrame } from '@shared/draw/ops'
import type { LiveUndo } from '../../../../lib/yjsKeyedJson'
import { fontShorthand, layoutText } from '../textMeasure'
import { createCanvasRaster } from './canvasRaster'
import type { EditorServices } from './editor'
import type { EditorState } from './types'

export interface StudioRefs {
  canvases: Map<string, HTMLCanvasElement>
  loaded: Map<string, string>
  scratch: { current: HTMLCanvasElement | null }
  scroll: { current: HTMLDivElement | null }
  onChange: { current: (body: unknown) => void }
  title: { current: string }
  liveUndo: { current: LiveUndo | undefined }
}

/** Services bound to a studio's refs; `store` is read lazily, once the editor exists. */
export function createDomServices(refs: StudioRefs, store: () => { getState(): EditorState; setState(p: Partial<EditorState>): void }): EditorServices {
  const doc = (): EditorState['doc'] => store().getState().doc

  /**
   * Zoom so `box` (document units) fills the window, then scroll it to the
   * middle once the stage has been laid out at the new zoom. With one artboard
   * and the whole artboard asked for, this is the old Fit to window exactly.
   */
  function fitBox(box: Box): void {
    const el = refs.scroll.current
    if (!el || !(box.w > 0) || !(box.h > 0)) return
    const z = Math.max(0.05, Math.min(4, Math.min((el.clientWidth - 48) / box.w, (el.clientHeight - 48) / box.h)))
    store().setState({ zoom: z })
    const centre = (): void => {
      const sc = refs.scroll.current
      const stage = sc?.querySelector('[data-testid="draw-stage"]') as HTMLElement | null
      if (!sc || !stage) return
      const f = artboardsBounds(doc())
      const zz = store().getState().zoom
      const sr = stage.getBoundingClientRect()
      const cr = sc.getBoundingClientRect()
      const left = sc.scrollLeft + (sr.left - cr.left - sc.clientLeft) + (box.x - f.x) * zz - (sc.clientWidth - box.w * zz) / 2
      const top = sc.scrollTop + (sr.top - cr.top - sc.clientTop) + (box.y - f.y) * zz - (sc.clientHeight - box.h * zz) / 2
      sc.scrollLeft = Math.max(0, left)
      sc.scrollTop = Math.max(0, top)
    }
    // Two frames: React commits the new zoom, then the browser lays it out.
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(centre))
  }

  return {
    raster: createCanvasRaster({
      canvases: refs.canvases,
      loaded: refs.loaded,
      scratch: refs.scratch,
      // Paint layers are pictures of the first page (rasterFrame), whichever artboard is active.
      size: () => {
        const b = rasterFrame(doc())
        return { w: b.w, h: b.h }
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
        return { x: (r.left + el.clientLeft - st.left) / z + b.x, y: (r.top + el.clientTop - st.top) / z + b.y, w: el.clientWidth / z, h: el.clientHeight / z }
      }
    },
    host: {
      emit: (stored) => refs.onChange.current(stored),
      liveUndo: () => refs.liveUndo.current,
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
