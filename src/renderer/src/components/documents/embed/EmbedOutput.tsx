// What an embed shows at rest: the OUTPUT of the object, not its editor.
//
// Owner, 4.3.44: "just the file output itself that is embedded, not the whole
// editor of that widget, app or tool. Example, just the diagram, or just the
// drawing. Not the surrounding controls and editing tools. A user should be
// able to enter an edit mode if they want to update it." So each type is drawn
// by the renderer that already produces its output — the one the share viewer,
// the exporters or the minimap trust — and editing is a separate, explicit mode
// (WidgetEmbed).
//
// Untrusted content: an embedded document may have come from someone else's
// share. Diagrams and drawings are drawn as <img> from SVG, which cannot run
// script; Write and Cells HTML goes into a sandboxed frame with no scripts.
//
// Live: an office document re-renders when it changes anywhere
// (documents:changed); a widget re-renders from the fresh widget its host
// passes in. Nothing here writes.

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { DocType, FbDocument, SlideElement, SlidesBody, Widget } from '@shared/types'
import type { DesignBody } from '@shared/design'
import { documentIdFromEmbed } from '@shared/documentEmbedId'
import { normalizeBody as normalizeMapBody } from '@shared/diagram/normalize'
import { mapToSvg } from '@shared/mapExport'
import { normalizeDrawDoc } from '@shared/draw/normalize'
import { drawDocToSvg } from '@shared/draw/svg'
import { resolveTheme } from '@shared/slideThemes'
import { documentHtml } from '../../../lib/officeShareSnapshot'
import SlideFace from '../slides/SlideFace'
import SlideElementView from '../slides/SlideElementView'
import WidgetPreview from '../../WidgetPreview'
import { parseState, strokeToPath } from '../../widgets/ScratchpadWidget'
import type { NaturalShape } from './embedOutputKind'
import { documentAspect } from './embedSize'

const svgImg = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

// Text output (Write, Cells) in a frame that can be measured but not scripted.
function HtmlFrame({ html, onHeight }: { html: string; onHeight: (h: number) => void }): JSX.Element {
  const ref = useRef<HTMLIFrameElement>(null)
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;padding:14px 18px;font:14px/1.55 Inter,system-ui,-apple-system,sans-serif;color:#1c1917;background:#fff}
    h1{font-size:24px;margin:.2em 0 .5em}h2{font-size:18px;margin:1.1em 0 .4em}h3{font-size:15px}
    p{margin:.4em 0}ul,ol{padding-left:1.4em}a{color:#6d28d9}
    table{border-collapse:collapse;width:100%;font-size:13px;margin:.5em 0}
    th,td{border:1px solid #e7e5e4;padding:5px 8px;text-align:left;vertical-align:top}
    th{background:#fafaf9;font-weight:600}td.num,th.num{text-align:right}
    img{max-width:100%}
  </style></head><body>${html}</body></html>`
  useEffect(() => {
    const f = ref.current
    if (!f) return
    const measure = (): void => {
      const h = f.contentDocument?.documentElement.scrollHeight
      if (h) onHeight(h)
    }
    f.addEventListener('load', measure)
    return () => f.removeEventListener('load', measure)
  }, [onHeight])
  // allow-same-origin only lets the host measure the height; scripts stay off.
  return <iframe ref={ref} title="Embedded content" sandbox="allow-same-origin" srcDoc={doc} className="block h-full w-full border-0 bg-white" />
}

function DesignPage({ body, width }: { body: DesignBody; width: number }): JSX.Element {
  const scale = width / Math.max(1, body.width)
  const bg = body.background?.type === 'solid' ? body.background.color : '#ffffff'
  const elements = ((body as unknown as { elements?: SlideElement[] }).elements ?? []).slice().sort((a, b) => a.z - b.z)
  return (
    <div style={{ width, height: body.height * scale, position: 'relative', overflow: 'hidden', background: bg }}>
      <div style={{ width: body.width, height: body.height, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'absolute' }}>
        {elements.map((el) => (
          <SlideElementView key={el.id} el={el} />
        ))}
      </div>
    </div>
  )
}

function DeckOutput({ body, width }: { body: SlidesBody; width: number }): JSX.Element {
  const slides = body.slides ?? []
  const [i, setI] = useState(0)
  const theme = useMemo(() => resolveTheme(body.theme), [body.theme])
  const slide = slides[Math.min(i, slides.length - 1)]
  if (!slide) return <div className="p-3 text-[12px] text-[var(--ink-40)]">This deck has no slides yet.</div>
  return (
    <div className="relative h-full w-full flex items-center justify-center bg-[var(--surface-sunken)]">
      <SlideFace slide={slide} theme={theme} width={width} />
      {slides.length > 1 && (
        // Paging through a deck is reading, not editing.
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[11px] text-white">
          <button type="button" aria-label="Previous slide" className="px-1" onClick={() => setI((n) => Math.max(0, n - 1))}>‹</button>
          <span data-testid="embed-slide-index">{Math.min(i, slides.length - 1) + 1} / {slides.length}</span>
          <button type="button" aria-label="Next slide" className="px-1" onClick={() => setI((n) => Math.min(slides.length - 1, n + 1))}>›</button>
        </div>
      )}
    </div>
  )
}

function DocumentOutput({ documentId, width, onShape }: { documentId: string; width: number; onShape: (s: NaturalShape) => void }): JSX.Element {
  const [doc, setDoc] = useState<FbDocument | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = (): void => {
      void window.api.documents.get(documentId).then((d) => live && setDoc(d ?? null)).catch(() => live && setDoc(null))
    }
    load()
    const off = window.api.documents.onChanged((id) => {
      if (id === documentId) load()
    })
    return () => {
      live = false
      off()
    }
  }, [documentId])

  const view = useMemo(() => {
    if (!doc) return null
    const t = doc.docType as DocType
    const body = doc.body as unknown
    try {
      if (t === 'doc' || t === 'sheet') return { kind: 'html' as const, html: documentHtml(t, body) }
      if (t === 'slides') return { kind: 'deck' as const, body: body as SlidesBody }
      if (t === 'design') return { kind: 'design' as const, body: body as DesignBody }
      if (t === 'map') {
        const r = mapToSvg(normalizeMapBody(body), { padding: 24, background: '#ffffff' })
        return { kind: 'svg' as const, src: svgImg(r.svg) }
      }
      if (t === 'draw') {
        const d = normalizeDrawDoc(body)
        return { kind: 'svg' as const, src: svgImg(drawDocToSvg(d)) }
      }
    } catch {
      return { kind: 'error' as const }
    }
    return { kind: 'error' as const }
  }, [doc])

  // Text measures itself (HtmlFrame); the rest has the shape a drop sizes to.
  useEffect(() => {
    if (!doc || !view || view.kind === 'html' || view.kind === 'error') return
    let live = true
    void documentAspect(doc.docType, doc.body).then((a) => live && a && onShape({ aspect: a }))
    return () => {
      live = false
    }
  }, [doc, view, onShape])

  if (doc === undefined) return <div className="h-full w-full" aria-hidden />
  if (!doc || !view) return <div className="p-3 text-[12px] text-[var(--ink-40)]">This document is no longer available.</div>
  if (view.kind === 'error') return <div className="p-3 text-[12px] text-[var(--ink-40)]">This document could not be shown. Choose Edit to open it.</div>
  if (view.kind === 'html') return <HtmlFrame html={view.html} onHeight={(h) => onShape({ height: h })} />
  if (view.kind === 'deck') return <DeckOutput body={view.body} width={width} />
  if (view.kind === 'design') return <div className="h-full w-full overflow-auto bg-[var(--surface-sunken)] flex justify-center"><DesignPage body={view.body} width={width} /></div>
  return <img src={view.src} alt={doc.title} className="block h-full w-full object-contain bg-white" draggable={false} />
}

function ScratchOutput({ widget }: { widget: Widget }): JSX.Element {
  const strokes = parseState(widget.content).strokes
  return (
    <svg className="block h-full w-full bg-white" viewBox={`0 0 ${Math.max(1, widget.width)} ${Math.max(1, widget.height - 40)}`} preserveAspectRatio="xMidYMid meet" aria-label={widget.title || 'Sketch'}>
      {strokes.map((s, i) => (
        <path key={i} d={strokeToPath(s.points, s.size)} fill={s.color} />
      ))}
    </svg>
  )
}

/** The output of an embedded object. `width` is the box it fills, for renderers that lay out to pixels. */
export default function EmbedOutput({ widget, width, onShape }: { widget: Widget; width: number; onShape: (s: NaturalShape) => void }): JSX.Element {
  const documentId = documentIdFromEmbed(widget.id)
  useEffect(() => {
    if (!documentId) onShape({ aspect: Math.max(60, widget.height) / Math.max(60, widget.width) })
  }, [documentId, widget.width, widget.height, onShape])
  if (documentId) return <DocumentOutput documentId={documentId} width={width} onShape={onShape} />
  if (widget.kind === 'scratchpad') return <ScratchOutput widget={widget} />
  return (
    <div className="h-full w-full overflow-hidden bg-[var(--surface-raised)]">
      <WidgetPreview widget={widget} />
    </div>
  )
}
