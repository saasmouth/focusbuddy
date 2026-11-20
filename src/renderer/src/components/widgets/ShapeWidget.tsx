import { useEffect, useRef, useState } from 'react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import { useSaveOnUnmount } from '../../lib/useSaveOnUnmount'

// A vector shape on the canvas — rectangle / ellipse / diamond / triangle /
// hexagon / star / line / arrow, with fill, stroke and an optional centred
// label. The shape stretches to fill the widget, so resizing the frame resizes
// the shape. Config persists as JSON in widget.content.

type ShapeType =
  | 'rect'
  | 'rounded'
  | 'ellipse'
  | 'diamond'
  | 'triangle'
  | 'hexagon'
  | 'star'
  | 'line'
  | 'arrow'

interface ShapeData {
  shape: ShapeType
  fill: string
  stroke: string
  strokeWidth: number
  label: string
}

const SHAPES: { type: ShapeType; icon: string; label: string }[] = [
  { type: 'rect', icon: 'crop_square', label: 'Rectangle' },
  { type: 'rounded', icon: 'rounded_corner', label: 'Rounded' },
  { type: 'ellipse', icon: 'circle', label: 'Ellipse' },
  { type: 'diamond', icon: 'diamond', label: 'Diamond' },
  { type: 'triangle', icon: 'change_history', label: 'Triangle' },
  { type: 'hexagon', icon: 'hexagon', label: 'Hexagon' },
  { type: 'star', icon: 'star', label: 'Star' },
  { type: 'line', icon: 'horizontal_rule', label: 'Line' },
  { type: 'arrow', icon: 'arrow_forward', label: 'Arrow' }
]

const DEFAULT: ShapeData = {
  shape: 'rect',
  fill: '#c7d2fe',
  stroke: '#4f46e5',
  strokeWidth: 2,
  label: ''
}

function parse(content: string): ShapeData {
  if (!content) return { ...DEFAULT }
  try {
    const p = JSON.parse(content) as Partial<ShapeData>
    return {
      shape: (p.shape as ShapeType) ?? DEFAULT.shape,
      fill: p.fill ?? DEFAULT.fill,
      stroke: p.stroke ?? DEFAULT.stroke,
      strokeWidth: typeof p.strokeWidth === 'number' ? p.strokeWidth : DEFAULT.strokeWidth,
      label: p.label ?? ''
    }
  } catch {
    return { ...DEFAULT }
  }
}

const STAR_PTS = '50,4 62,37 98,38 69,59 80,95 50,73 20,95 31,59 2,38 38,37'
const HEX_PTS = '27,4 73,4 98,50 73,96 27,96 2,50'
const DIAMOND_PTS = '50,3 97,50 50,97 3,50'
const TRI_PTS = '50,5 96,95 4,95'

function ShapeSvg({ d }: { d: ShapeData }): JSX.Element {
  const common = { fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth, vectorEffect: 'non-scaling-stroke' as const }
  const lineCommon = { stroke: d.stroke, strokeWidth: Math.max(2, d.strokeWidth), vectorEffect: 'non-scaling-stroke' as const, strokeLinecap: 'round' as const }
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="h-full w-full"
      style={{ display: 'block' }}
    >
      {d.shape === 'rect' && <rect x={2} y={2} width={96} height={96} {...common} />}
      {d.shape === 'rounded' && <rect x={2} y={2} width={96} height={96} rx={14} ry={14} {...common} />}
      {d.shape === 'ellipse' && <ellipse cx={50} cy={50} rx={47} ry={47} {...common} />}
      {d.shape === 'diamond' && <polygon points={DIAMOND_PTS} {...common} />}
      {d.shape === 'triangle' && <polygon points={TRI_PTS} {...common} />}
      {d.shape === 'hexagon' && <polygon points={HEX_PTS} {...common} />}
      {d.shape === 'star' && <polygon points={STAR_PTS} {...common} />}
      {d.shape === 'line' && <line x1={4} y1={50} x2={96} y2={50} {...lineCommon} />}
      {d.shape === 'arrow' && (
        <>
          <line x1={4} y1={50} x2={88} y2={50} {...lineCommon} />
          <polygon points="80,38 98,50 80,62" fill={d.stroke} stroke="none" />
        </>
      )}
    </svg>
  )
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function ShapeWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [data, setData] = useState<ShapeData>(() => parse(widget.content))
  const [editingLabel, setEditingLabel] = useState(false)
  const lastSaved = useRef(widget.content)

  // Debounced persist whenever the shape config changes.
  useEffect(() => {
    const next = JSON.stringify(data)
    if (next === lastSaved.current) return
    const h = window.setTimeout(() => {
      lastSaved.current = next
      void update(widget.id, { content: next })
    }, 250)
    return () => window.clearTimeout(h)
  }, [data, widget.id, update])

  // Write an edit still waiting for its debounce when the widget goes away (lib/useSaveOnUnmount).
  useSaveOnUnmount(() => {
    const next = JSON.stringify(data)
    if (next === lastSaved.current) return
    lastSaved.current = next
    void update(widget.id, { content: next })
  })

  // Adopt content from a synced sibling (live sync) without a remount/refresh.
  useEffect(() => {
    if (widget.content !== lastSaved.current) {
      lastSaved.current = widget.content
      setData(parse(widget.content))
    }
  }, [widget.content])

  const set = (patch: Partial<ShapeData>): void => setData((d) => ({ ...d, ...patch }))
  const noFill = data.shape === 'line' || data.shape === 'arrow'

  const content = (
    <div className="group relative h-full w-full bg-transparent">
      <ShapeSvg d={data} />

      {/* Centred label */}
      {(data.label || editingLabel) && (
        <div className="absolute inset-0 flex items-center justify-center p-2 pointer-events-none">
          {editingLabel ? (
            <input
              autoFocus
              value={data.label}
              onChange={(e) => set({ label: e.target.value })}
              onBlur={() => setEditingLabel(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') setEditingLabel(false)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="fb-field w-auto pointer-events-auto max-w-[90%] bg-[color-mix(in_oklab,var(--surface-raised)_80%,transparent)] text-center text-sm text-[var(--ink-100)] px-2 py-0.5"
            />
          ) : (
            <span className="text-sm font-medium text-[var(--ink-100)] text-center break-words drop-shadow-sm">
              {data.label}
            </span>
          )}
        </div>
      )}
      {!data.label && !editingLabel && (
        <button
          onClick={() => setEditingLabel(true)}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity text-[11px] text-[var(--ink-50)]"
        >
          <span className="px-2 py-0.5 rounded bg-[color-mix(in_oklab,var(--surface-raised)_70%,transparent)]">+ label</span>
        </button>
      )}
      {data.label && !editingLabel && (
        <button
          onClick={() => setEditingLabel(true)}
          onMouseDown={(e) => e.stopPropagation()}
          className="absolute inset-0"
          aria-label="Edit label"
        />
      )}

      {/* Hover toolbar: shape picker + fill/stroke */}
      <div
        className="absolute top-1.5 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full fb-glass-chrome border px-1.5 py-1 shadow-[var(--shadow-cast)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Dark HUD toolbar over arbitrary shape colours; literal by design. */}
        <select
          value={data.shape}
          onChange={(e) => set({ shape: e.target.value as ShapeType })}
          className="h-6 bg-stone-800 text-stone-100 text-[11px] rounded px-1 border border-white/10"
          title="Shape"
        >
          {SHAPES.map((s) => (
            <option key={s.type} value={s.type}>
              {s.label}
            </option>
          ))}
        </select>
        {!noFill && (
          <label className="relative h-6 w-6 rounded overflow-hidden cursor-pointer ring-1 ring-white/20" title="Fill">
            <span className="absolute inset-0" style={{ backgroundColor: data.fill }} />
            <input
              type="color"
              value={data.fill}
              onChange={(e) => set({ fill: e.target.value })}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        )}
        <label className="relative h-6 w-6 rounded overflow-hidden cursor-pointer ring-1 ring-white/20 inline-flex items-center justify-center" title="Stroke">
          <span className="absolute inset-1 rounded-full border-2" style={{ borderColor: data.stroke }} />
          <input
            type="color"
            value={data.stroke}
            onChange={(e) => set({ stroke: e.target.value })}
            className="absolute inset-0 opacity-0 cursor-pointer"
          />
        </label>
        <Icon name="line_weight" size={13} className="text-stone-400 ml-0.5" />
        <input
          type="range"
          min={0}
          max={8}
          step={1}
          value={data.strokeWidth}
          onChange={(e) => set({ strokeWidth: Number(e.target.value) })}
          className="w-14 accent-accent"
          title="Stroke width"
        />
      </div>
    </div>
  )

  if (inline) return content

  return (
    <WidgetFrame widget={widget} headerLabel="shape" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {content}
    </WidgetFrame>
  )
}
