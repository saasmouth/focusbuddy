// The services the studio gives the editor in the real app: paint layers on
// <canvas>, real-font text measuring, the scrolling viewport, and the host
// (saving, co-editing undo, export through the main process).

import type { DrawBody } from '@shared/draw'
import { primaryArtboard } from '@shared/draw/ops'
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
  return {
    raster: createCanvasRaster({
      canvases: refs.canvases,
      loaded: refs.loaded,
      scratch: refs.scratch,
      size: () => {
        const b = primaryArtboard(doc())
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
      fit: () => {
        const el = refs.scroll.current
        if (!el) return
        const b = primaryArtboard(doc())
        const z = Math.min((el.clientWidth - 48) / b.w, (el.clientHeight - 48) / b.h)
        store().setState({ zoom: Math.max(0.05, Math.min(4, z)) })
      }
    },
    host: {
      emit: (stored) => refs.onChange.current(stored),
      liveUndo: () => refs.liveUndo.current,
      exportAs: async (format) => {
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
          const res = await window.api.draw.export({ draw: doc() as unknown as DrawBody, title: refs.title.current || 'drawing', format })
          if (res.ok && res.path) s.setState({ status: `Saved to ${res.path}` })
          else if (res.error) s.setState({ status: res.error })
        } finally {
          s.setState({ busy: null })
        }
      }
    }
  }
}
