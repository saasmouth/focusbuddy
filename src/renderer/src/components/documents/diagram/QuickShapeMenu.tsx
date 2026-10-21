import { useEffect, useMemo, useState } from 'react'
import { getShape, searchShapes } from '@shared/diagram/shapes'
import { resolveNodeStyle } from '@shared/diagram/style'
import { ShapeThumb } from './ShapeSvg'
import { useDiagramCtx } from './DiagramContext'

// Shown when a connector is dropped on empty canvas: pick a shape to create
// there, already connected (Lucid's "drag a line out" flow). Esc cancels.

const QUICK = ['process', 'decision', 'terminator', 'data', 'database', 'circle', 'note', 'hexagon']

export function QuickShapeMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (shape: string) => void; onClose: () => void }): JSX.Element {
  const ctx = useDiagramCtx()
  const [q, setQ] = useState('')
  const list = useMemo(() => (q.trim() ? searchShapes(q).slice(0, 16).map((s) => s.id) : QUICK), [q])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <>
      <div className="absolute inset-0 z-30" onMouseDown={onClose} />
      <div className="fb-glass-panel fb-pop-in absolute z-40 p-2 rounded-[var(--radius-row)] w-[212px] shadow-xl" style={{ left: x, top: y }} data-testid="diagram-quick-menu">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && list[0]) onPick(list[0])
            if (e.key === 'Escape') onClose()
          }}
          placeholder="Add a connected shape…"
          className="fb-field w-full h-7 px-2 text-[12px] mb-1.5"
        />
        <div className="grid grid-cols-4 gap-1">
          {list.map((id) => (
            <button key={id} type="button" title={getShape(id).label} onClick={() => onPick(id)} className="pd-thumb" data-testid={`diagram-quick-shape-${id}`}>
              <ShapeThumb shape={id} size={30} style={resolveNodeStyle({ shape: id, color: getShape(id).color ?? '#475569' }, ctx.themeId)} />
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
