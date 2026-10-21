import { useState } from 'react'
import { layerOf, type Graph, type Sel } from '@shared/diagram/ops'
import Icon from '../../Icon'
import type { Commands } from './commands'

// Layers for the current page: show/hide, lock, rename, delete, and move the
// selection onto a layer. Shapes without a layer belong to "Base".

export function LayersPanel({ cmd, page, sel, onClose }: { cmd: Commands; page: Graph; sel: Sel; onClose: () => void }): JSX.Element {
  const layers = page.layers?.length ? page.layers : [{ id: 'layer-base', name: 'Base', visible: true, locked: false }]
  const [editing, setEditing] = useState<string | null>(null)
  const count = (id: string): number => page.nodes.filter((n) => layerOf(n) === id).length
  return (
    <div className="absolute bottom-2 left-2 z-30 fb-glass-panel rounded-[var(--radius-row)] w-[250px] shadow-lg" data-testid="diagram-layers">
      <div className="flex items-center px-3 py-2 border-b border-[var(--edge-soft)]">
        <span className="text-[12px] font-semibold flex-1">Layers</span>
        <button type="button" className="icon-btn" title="Add layer" onClick={() => cmd.addLayer()} data-testid="diagram-layer-add">
          <Icon name="add" size={15} />
        </button>
        <button type="button" className="icon-btn" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="py-1 max-h-[260px] overflow-auto">
        {[...layers].reverse().map((l) => (
          <div key={l.id} className="flex items-center gap-1 px-2 py-1 hover:bg-[var(--surface-sunken)]">
            <button type="button" className="icon-btn" title={l.visible ? 'Hide layer' : 'Show layer'} onClick={() => page.layers?.length && cmd.updateLayer(l.id, { visible: !l.visible })}>
              <Icon name={l.visible ? 'visibility' : 'visibility_off'} size={14} />
            </button>
            <button type="button" className="icon-btn" title={l.locked ? 'Unlock layer' : 'Lock layer'} onClick={() => page.layers?.length && cmd.updateLayer(l.id, { locked: !l.locked })}>
              <Icon name={l.locked ? 'lock' : 'lock_open'} size={14} />
            </button>
            {editing === l.id ? (
              <input
                autoFocus
                defaultValue={l.name}
                onBlur={(e) => {
                  cmd.updateLayer(l.id, { name: e.target.value.trim() || l.name })
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
                className="fb-field flex-1 h-6 px-1 text-[12px]"
              />
            ) : (
              <span className="flex-1 min-w-0 text-[12px] truncate" onDoubleClick={() => page.layers?.length && setEditing(l.id)}>
                {l.name} <span className="text-[10px] text-[var(--ink-40)]">{count(l.id)}</span>
              </span>
            )}
            <button
              type="button"
              className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--surface-raised)] text-[var(--ink-60)] disabled:opacity-30"
              disabled={!sel.nodes.size && !sel.edges.size}
              title="Move selection to this layer"
              onClick={() => cmd.moveSelectionToLayer(l.id === 'layer-base' ? undefined : l.id)}
            >
              Move here
            </button>
            {page.layers?.length && l.id !== 'layer-base' ? (
              <button type="button" className="icon-btn" title="Delete layer (shapes move to Base)" onClick={() => cmd.deleteLayer(l.id)}>
                <Icon name="delete" size={13} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {!page.layers?.length && <p className="px-3 pb-2 text-[10px] text-[var(--ink-50)]">Add a layer to show, hide or lock groups of shapes together.</p>}
    </div>
  )
}
