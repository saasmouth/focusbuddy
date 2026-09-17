import { useState } from 'react'
import Icon from '../../Icon'
import { DRAW_BLEND_MODES, type DrawBlend, type DrawLayer } from '@shared/draw'

// The PlexiDraw layers panel. One stack holds both vector and painted layers, so
// this list is deliberately kind-agnostic: every row offers the same visibility,
// lock, opacity and blend controls, and only the leading icon says which kind it
// is. Rows are drawn top-first (the reverse of the stored array, where index 0 is
// the bottom) because that is how every layers panel in every editor reads.

interface Props {
  layers: DrawLayer[]
  activeLayerId: string | undefined
  onSelect: (id: string) => void
  onPatch: (id: string, patch: { name?: string; visible?: boolean; locked?: boolean; opacity?: number; blend?: DrawBlend }) => void
  onAdd: (kind: 'vector' | 'raster') => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, delta: number) => void
  onMergeDown: (id: string) => void
  onRasterize: (id: string) => void
}

export default function DrawLayersPanel({
  layers,
  activeLayerId,
  onSelect,
  onPatch,
  onAdd,
  onDuplicate,
  onDelete,
  onMove,
  onMergeDown,
  onRasterize
}: Props): JSX.Element {
  const [renaming, setRenaming] = useState<string | null>(null)
  const active = layers.find((l) => l.id === activeLayerId)
  // Top of the stack first, which is the reverse of paint order.
  const rows = layers.slice().reverse()

  return (
    <div className="flex flex-col h-full text-[12px]" data-testid="draw-layers-panel">
      <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-[var(--edge-soft)]">
        <span className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] flex-1">Layers</span>
        <button onClick={() => onAdd('vector')} title="New vector layer" data-testid="draw-add-vector-layer" className="icon-btn !h-6 !w-6">
          <Icon name="shapes" size={14} />
        </button>
        <button onClick={() => onAdd('raster')} title="New paint layer" data-testid="draw-add-raster-layer" className="icon-btn !h-6 !w-6">
          <Icon name="brush" size={14} />
        </button>
      </div>

      {active && (
        <div className="shrink-0 px-2 py-1.5 border-b border-[var(--edge-soft)] space-y-1.5">
          <label className="flex items-center gap-1.5">
            <span className="w-11 text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Blend</span>
            <select
              value={active.blend}
              data-testid="draw-layer-blend"
              onChange={(e) => onPatch(active.id, { blend: e.target.value as DrawBlend })}
              className="fb-field flex-1 min-w-0 px-1.5 py-1 capitalize"
            >
              {DRAW_BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {b.replace('-', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-11 text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(active.opacity * 100)}
              data-testid="draw-layer-opacity"
              onChange={(e) => onPatch(active.id, { opacity: Number(e.target.value) / 100 })}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="w-8 text-right fb-tabular text-[var(--ink-50)]">{Math.round(active.opacity * 100)}%</span>
          </label>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {rows.map((l) => {
          const isActive = l.id === activeLayerId
          return (
            <div
              key={l.id}
              onClick={() => onSelect(l.id)}
              data-testid={`draw-layer-row-${l.id}`}
              className={`group flex items-center gap-1 px-1.5 py-1 border-b border-[var(--edge-soft)] cursor-pointer ${
                isActive ? 'bg-accent/10' : 'hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onPatch(l.id, { visible: !l.visible })
                }}
                title={l.visible ? 'Hide layer' : 'Show layer'}
                aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
                className="icon-btn !h-5 !w-5 shrink-0"
              >
                <Icon name={l.visible ? 'visibility' : 'visibility_off'} size={13} className={l.visible ? '' : 'text-[var(--ink-30)]'} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onPatch(l.id, { locked: !l.locked })
                }}
                title={l.locked ? 'Unlock layer' : 'Lock layer'}
                aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
                className="icon-btn !h-5 !w-5 shrink-0"
              >
                <Icon name={l.locked ? 'lock' : 'lock_open'} size={13} className={l.locked ? 'text-amber-500' : 'text-[var(--ink-30)]'} />
              </button>
              <Icon name={l.kind === 'raster' ? 'brush' : 'shapes'} size={13} className="shrink-0 text-[var(--ink-40)]" />
              {renaming === l.id ? (
                <input
                  autoFocus
                  defaultValue={l.name}
                  onBlur={(e) => {
                    onPatch(l.id, { name: e.target.value.trim() || l.name })
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="fb-field flex-1 min-w-0 px-1 py-0.5"
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenaming(l.id)
                  }}
                  className="flex-1 min-w-0 truncate text-[var(--ink-80)]"
                  title={`${l.name} — double-click to rename`}
                >
                  {l.name}
                </span>
              )}
              {l.opacity < 1 && <span className="shrink-0 fb-tabular text-[10px] text-[var(--ink-40)]">{Math.round(l.opacity * 100)}%</span>}
              <div className="shrink-0 flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <button onClick={(e) => { e.stopPropagation(); onMove(l.id, 1) }} title="Move layer up" className="icon-btn !h-5 !w-5">
                  <Icon name="keyboard_arrow_up" size={13} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); onMove(l.id, -1) }} title="Move layer down" className="icon-btn !h-5 !w-5">
                  <Icon name="keyboard_arrow_down" size={13} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); onDuplicate(l.id) }} title="Duplicate layer" className="icon-btn !h-5 !w-5">
                  <Icon name="file_copy" size={12} />
                </button>
                {l.kind === 'vector' && (
                  <button onClick={(e) => { e.stopPropagation(); onRasterize(l.id) }} title="Rasterize layer — turn its shapes into pixels" className="icon-btn !h-5 !w-5">
                    <Icon name="grain" size={12} />
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); onMergeDown(l.id) }} title="Merge down" className="icon-btn !h-5 !w-5">
                  <Icon name="merge" size={12} />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDelete(l.id) }}
                  disabled={layers.length <= 1}
                  title={layers.length <= 1 ? 'A document needs at least one layer' : 'Delete layer'}
                  className="icon-btn !h-5 !w-5 disabled:opacity-30"
                >
                  <Icon name="delete" size={12} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
