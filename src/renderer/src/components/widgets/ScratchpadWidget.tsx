import { useEffect, useMemo, useRef, useState } from 'react'
import { getStroke } from 'perfect-freehand'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'

// ── Scratchpad widget ───────────────────────────────────────────────────────
// A freeform sketch surface. Strokes are captured as raw [x, y, pressure]
// points and rendered with perfect-freehand (a tiny MIT lib that turns those
// points into a smooth, pressure-tapered outline). The whole sketch
// (strokes + chosen colours) serialises to widget.content as JSON so it
// persists like any other widget.

interface Stroke {
  points: number[][] // [x, y, pressure][] in widget-local pixels
  color: string
  size: number
}
interface ScratchState {
  strokes: Stroke[]
}

const COLORS = ['#1c1917', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#db2777']
const SIZES = [3, 6, 12]

export function parseState(content: string): ScratchState {
  if (!content) return { strokes: [] }
  try {
    const o = JSON.parse(content) as Partial<ScratchState>
    return { strokes: Array.isArray(o.strokes) ? (o.strokes as Stroke[]) : [] }
  } catch {
    return { strokes: [] }
  }
}

// perfect-freehand → SVG path data. Standard helper from the lib's docs.
export function strokeToPath(points: number[][], size: number): string {
  const outline = getStroke(points, {
    size,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true
  })
  if (!outline.length) return ''
  const d = outline.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length]
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
      return acc
    },
    ['M', ...outline[0], 'Q'] as (string | number)[]
  )
  return [...d, 'Z'].join(' ')
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function ScratchpadWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const isActive = useWidgetStore((s) => s.activeWidgetId === widget.id)
  const initial = useMemo(() => parseState(widget.content), [widget.id])
  const [strokes, setStrokes] = useState<Stroke[]>(initial.strokes)
  const [drawing, setDrawing] = useState<Stroke | null>(null)
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen')
  const [color, setColor] = useState<string>(COLORS[0])
  const [size, setSize] = useState<number>(SIZES[1])
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const lastSavedRef = useRef<string>(widget.content)
  const strokesRef = useRef<Stroke[]>(initial.strokes)
  strokesRef.current = strokes

  // Re-seed when a different widget instance mounts (e.g. focus-mode sibling).
  useEffect(() => {
    const s = parseState(widget.content)
    setStrokes(s.strokes)
    lastSavedRef.current = widget.content
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id])

  function persist(next: Stroke[]): void {
    const json = JSON.stringify({ strokes: next })
    if (json === lastSavedRef.current) return
    lastSavedRef.current = json
    void update(widget.id, { content: json })
  }
  // Flush on unmount so an in-progress board isn't lost on a layout remount.
  useEffect(() => {
    return () => {
      const json = JSON.stringify({ strokes: strokesRef.current })
      if (json !== lastSavedRef.current) void update(widget.id, { content: json })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget.id])

  // Convert a pointer event to widget-local pixels, correcting for the canvas
  // zoom (the surface is CSS-scaled) via the intrinsic/rendered size ratio.
  function toLocal(e: React.PointerEvent): [number, number, number] {
    const el = surfaceRef.current
    if (!el) return [0, 0, 0.5]
    const rect = el.getBoundingClientRect()
    const sx = el.offsetWidth / rect.width || 1
    const sy = el.offsetHeight / rect.height || 1
    return [(e.clientX - rect.left) * sx, (e.clientY - rect.top) * sy, e.pressure || 0.5]
  }

  // Only draw when the widget is the active one (matches the rest of the app:
  // first click activates, subsequent interaction draws). In focus mode it's
  // always interactive.
  const interactive = inline || isActive

  function onPointerDown(e: React.PointerEvent): void {
    if (!interactive) return
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    const p = toLocal(e)
    if (tool === 'eraser') {
      eraseAt(p[0], p[1])
      return
    }
    setDrawing({ points: [p], color, size })
  }
  function onPointerMove(e: React.PointerEvent): void {
    if (!interactive) return
    const p = toLocal(e)
    if (tool === 'eraser') {
      if (e.buttons === 1) eraseAt(p[0], p[1])
      return
    }
    setDrawing((d) => (d ? { ...d, points: [...d.points, p] } : d))
  }
  function onPointerUp(): void {
    if (drawing && drawing.points.length > 0) {
      const next = [...strokesRef.current, drawing]
      setStrokes(next)
      persist(next)
    }
    setDrawing(null)
  }

  // Erase: drop any stroke with a point within ~14px of the cursor.
  function eraseAt(x: number, y: number): void {
    const R = 14
    const next = strokesRef.current.filter(
      (s) => !s.points.some(([px, py]) => Math.hypot(px - x, py - y) < R + s.size)
    )
    if (next.length !== strokesRef.current.length) {
      setStrokes(next)
      persist(next)
    }
  }

  function clearAll(): void {
    setStrokes([])
    persist([])
  }

  const body = (
    <div className="h-full w-full flex flex-col bg-[#fcfbf7] dark:bg-stone-900">
      {/* Toolbar */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_80%,transparent)]">
        <button
          onClick={() => setTool('pen')}
          className={`icon-btn ${tool === 'pen' ? '!text-accent' : 'text-[var(--ink-50)]'}`}
          title="Pen"
        >
          <Icon name="edit" size={15} />
        </button>
        <button
          onClick={() => setTool('eraser')}
          className={`icon-btn ${tool === 'eraser' ? '!text-accent' : 'text-[var(--ink-50)]'}`}
          title="Eraser"
        >
          <Icon name="ink_eraser" size={15} />
        </button>
        <div className="w-px h-4 bg-[var(--surface-sunken)] mx-0.5" />
        {COLORS.map((c) => (
          <button
            key={c}
            onClick={() => {
              setColor(c)
              setTool('pen')
            }}
            className={`h-4 w-4 rounded-full border ${
              color === c && tool === 'pen' ? 'ring-2 ring-offset-1 ring-[var(--edge-firm)]' : 'border-black/10'
            }`}
            style={{ backgroundColor: c }}
            title={c}
            aria-label={`Colour ${c}`}
          />
        ))}
        <div className="w-px h-4 bg-[var(--surface-sunken)] mx-0.5" />
        {SIZES.map((s) => (
          <button
            key={s}
            onClick={() => setSize(s)}
            className={`h-6 w-6 inline-flex items-center justify-center rounded hover:bg-[var(--surface-sunken)] ${
              size === s ? 'bg-[var(--surface-sunken)]' : ''
            }`}
            title={`${s}px`}
          >
            <span className="rounded-full bg-stone-700 dark:bg-stone-200" style={{ width: s, height: s }} />
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={clearAll} className="icon-btn text-[var(--ink-50)] hover:!text-red-600" title="Clear">
          <Icon name="delete_sweep" size={16} />
        </button>
      </div>
      {/* Drawing surface */}
      <div
        ref={surfaceRef}
        className="flex-1 min-h-0 relative touch-none"
        style={{ cursor: tool === 'eraser' ? 'cell' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <svg className="absolute inset-0 w-full h-full" style={{ touchAction: 'none' }}>
          {strokes.map((s, i) => (
            <path key={i} d={strokeToPath(s.points, s.size)} fill={s.color} />
          ))}
          {drawing && <path d={strokeToPath(drawing.points, drawing.size)} fill={drawing.color} />}
        </svg>
        {!interactive && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none">
            <span className="px-2 py-1 rounded-full bg-stone-900/70 text-stone-50 text-[11px] opacity-0 hover:opacity-100">
              Click to draw
            </span>
          </div>
        )}
      </div>
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame widget={widget} headerLabel="Scratchpad" headerAccent="bg-violet-300/50 dark:bg-violet-400/20">
      {body}
    </WidgetFrame>
  )
}
