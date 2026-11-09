import { useMemo } from 'react'
import type { Widget } from '@shared/types'
import { sectionFrameOf } from '../lib/sectionGeometry'
import WidgetPreview from './WidgetPreview'

// A spatial, content-aware miniature of a set of widgets — the same idea as the
// minimap's thumbnails, but for an arbitrary widget array (e.g. another task's
// desk in a portal). Fits the widgets into the given pixel box, drawing each as
// a scaled real preview. Read-only and non-interactive by itself.

interface Props {
  widgets: Widget[]
  width: number
  height: number
  padding?: number
}

export default function DeskMiniature({ widgets, width, height, padding = 6 }: Props): JSX.Element {
  // Top-level, visible, real widgets — skip archived, pinned, section children,
  // and the auto minimap (a minimap inside a miniature is just noise).
  const visible = useMemo(
    () =>
      widgets.filter(
        (w) =>
          !w.archived && !w.pinned && w.parentSectionId === null && w.kind !== 'minimap'
      ),
    [widgets]
  )

  const bbox = useMemo(() => {
    if (visible.length === 0) return null
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const w of visible) {
      let ww = w.width
      let hh = w.height
      if (w.kind === 'section') {
        const children = widgets.filter((c) => c.parentSectionId === w.id)
        const frame = sectionFrameOf(w, children)
        ww = frame.width
        hh = frame.height
      }
      minX = Math.min(minX, w.x)
      minY = Math.min(minY, w.y)
      maxX = Math.max(maxX, w.x + ww)
      maxY = Math.max(maxY, w.y + hh)
    }
    return { minX, minY, maxX, maxY }
  }, [visible, widgets])

  const scale = useMemo(() => {
    if (!bbox) return 1
    const bbW = Math.max(1, bbox.maxX - bbox.minX)
    const bbH = Math.max(1, bbox.maxY - bbox.minY)
    return Math.min((width - 2 * padding) / bbW, (height - 2 * padding) / bbH, 1)
  }, [bbox, width, height, padding])

  if (!bbox || visible.length === 0) {
    return (
      <div
        aria-hidden="true"
        className="h-full w-full flex items-center justify-center text-[10px] text-[var(--ink-40)]"
      >
        Empty desk
      </div>
    )
  }

  return (
    // Decorative by definition: a spatial thumbnail of a desk the reader has not
    // opened. Rendering it exposed every widget's real content -- note bodies,
    // document text, URLs, prompts and internal ids -- to assistive technology
    // and automation, for every desk in the collection including the ones
    // scrolled off screen. The card's own title, object count and status carry
    // the meaning; the picture of it carries none.
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="block"
      aria-hidden="true"
      focusable="false"
      role="presentation"
    >
      {visible.map((w) => {
        let ww = w.width
        let hh = w.height
        if (w.kind === 'section') {
          const children = widgets.filter((c) => c.parentSectionId === w.id)
          const frame = sectionFrameOf(w, children)
          ww = frame.width
          hh = frame.height
        }
        const x = padding + (w.x - bbox.minX) * scale
        const y = padding + (w.y - bbox.minY) * scale
        const pw = Math.max(2, ww * scale)
        const ph = Math.max(2, hh * scale)
        if (w.kind === 'section') {
          return (
            <rect
              key={w.id}
              x={x}
              y={y}
              width={pw}
              height={ph}
              fill="rgb(var(--accent) / 0.06)"
              stroke="rgb(var(--accent) / 0.30)"
              strokeWidth={0.75}
              rx={2}
            />
          )
        }
        return (
          <foreignObject key={w.id} x={x} y={y} width={pw} height={ph} style={{ overflow: 'hidden' }}>
            <div className="h-full w-full overflow-hidden rounded-[2px] ring-1 ring-black/10 dark:ring-white/10">
              <div
                style={{
                  width: ww,
                  height: hh,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  pointerEvents: 'none'
                }}
              >
                <WidgetPreview widget={w} />
              </div>
            </div>
          </foreignObject>
        )
      })}
    </svg>
  )
}
