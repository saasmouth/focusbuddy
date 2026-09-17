import { useState } from 'react'
import Icon from '../../Icon'
import {
  BASE_LAYER_ID,
  designLayers,
  masterForPage,
  type DesignBody,
  type DesignLayer,
  type DesignMaster
} from '@shared/design'

// The page-layout control panel: everything that governs the DOCUMENT rather
// than a single object. Margins and columns, facing pages, page numbering,
// guides, master pages and layers all live here, because in a layout program
// they are set once and then obeyed by every page.

interface Props {
  design: DesignBody
  activePage: number
  onPatch: (patch: Partial<DesignBody>) => void
  onEditMaster: (masterId: string | null) => void
  onAddMaster: () => void
  onRenameMaster: (id: string, name: string) => void
  onDeleteMaster: (id: string) => void
  onAssignMaster: (pageIndex: number, masterId: string | null) => void
  onAddLayer: () => void
  onPatchLayer: (id: string, patch: Partial<DesignLayer>) => void
  onDeleteLayer: (id: string) => void
  onMoveSelectionToLayer: (layerId: string) => void
  hasSelection: boolean
}

export default function LayoutPanel(p: Props): JSX.Element {
  const { design } = p
  const margins = design.margins ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const columns = design.columns ?? { count: 1, gutter: 16 }
  const masters: DesignMaster[] = design.masters ?? []
  const layers = designLayers(design)
  const page = (design.pages ?? [])[p.activePage]
  const current = masterForPage(design, page)
  const [renaming, setRenaming] = useState<string | null>(null)

  return (
    <div className="grid gap-4 md:grid-cols-3 text-[12px]" data-testid="design-layout-panel">
      {/* ── Page setup ──────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-[var(--ink-40)]">Margins &amp; columns</h4>
        <div className="grid grid-cols-2 gap-1.5">
          {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
            <label key={side} className="flex items-center gap-1.5">
              <span className="w-12 capitalize text-[var(--ink-50)]">{side}</span>
              <input
                type="number"
                min={0}
                value={Math.round(margins[side])}
                data-testid={`design-margin-${side}`}
                onChange={(e) => p.onPatch({ margins: { ...margins, [side]: Math.max(0, Number(e.target.value) || 0) } })}
                className="fb-field w-full min-w-0 px-1.5 py-1"
              />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <label className="flex items-center gap-1.5">
            <span className="w-12 text-[var(--ink-50)]">Cols</span>
            <input
              type="number"
              min={1}
              max={20}
              value={columns.count}
              data-testid="design-columns-count"
              onChange={(e) => p.onPatch({ columns: { ...columns, count: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })}
              className="fb-field w-full min-w-0 px-1.5 py-1"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-12 text-[var(--ink-50)]">Gutter</span>
            <input
              type="number"
              min={0}
              value={Math.round(columns.gutter)}
              data-testid="design-columns-gutter"
              onChange={(e) => p.onPatch({ columns: { ...columns, gutter: Math.max(0, Number(e.target.value) || 0) } })}
              className="fb-field w-full min-w-0 px-1.5 py-1"
            />
          </label>
        </div>

        <h4 className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] pt-1">Document</h4>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={design.facing === true}
            data-testid="design-facing-toggle"
            onChange={(e) => p.onPatch({ facing: e.target.checked })}
            className="accent-[var(--accent)]"
          />
          <span className="text-[var(--ink-70)]">Facing pages (spreads)</span>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="w-24 text-[var(--ink-50)]">Numbering from</span>
          <input
            type="number"
            value={design.pageNumberStart ?? 1}
            data-testid="design-page-number-start"
            onChange={(e) => p.onPatch({ pageNumberStart: Math.round(Number(e.target.value) || 1) })}
            className="fb-field w-20 px-1.5 py-1"
          />
        </label>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => p.onPatch({ guides: { v: [], h: [] } })}
            data-testid="design-clear-guides"
            className="fb-btn-surface px-2 py-1 hover:border-accent"
          >
            Clear guides
          </button>
          <span className="text-[10px] text-[var(--ink-40)]">
            {(design.guides?.v.length ?? 0) + (design.guides?.h.length ?? 0)} placed — drag from a ruler to add
          </span>
        </div>
      </section>

      {/* ── Master pages ────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] flex-1">Master pages</h4>
          <button onClick={p.onAddMaster} data-testid="design-add-master" className="icon-btn !h-6 !w-6" title="New master page">
            <Icon name="add" size={14} />
          </button>
        </div>
        <p className="text-[10px] text-[var(--ink-40)] leading-snug">
          Anything on a master repeats on every page that uses it, underneath the page&apos;s own content. Put <code>{'{#}'}</code> in a text frame for the page
          number and <code>{'{pages}'}</code> for the total.
        </p>
        {masters.length === 0 && <p className="text-[11px] text-[var(--ink-40)]">No masters yet.</p>}
        {masters.map((m) => {
          const editing = design.editingMasterId === m.id
          return (
            <div key={m.id} className={`flex items-center gap-1 px-1.5 py-1 rounded border ${editing ? 'border-accent bg-accent/10' : 'border-[var(--edge-soft)]'}`} data-testid={`design-master-${m.id}`}>
              <Icon name="auto_stories" size={13} className="text-[var(--ink-40)] shrink-0" />
              {renaming === m.id ? (
                <input
                  autoFocus
                  defaultValue={m.name}
                  onBlur={(e) => {
                    p.onRenameMaster(m.id, e.target.value.trim() || m.name)
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="fb-field flex-1 min-w-0 px-1 py-0.5"
                />
              ) : (
                <span onDoubleClick={() => setRenaming(m.id)} className="flex-1 min-w-0 truncate text-[var(--ink-80)]" title="Double-click to rename">
                  {m.name}
                </span>
              )}
              <button
                onClick={() => p.onEditMaster(editing ? null : m.id)}
                data-testid={`design-edit-master-${m.id}`}
                className={`px-1.5 py-0.5 rounded text-[10px] ${editing ? 'bg-accent text-white' : 'hover:bg-[var(--surface-sunken)] text-[var(--ink-60)]'}`}
                title={editing ? 'Stop editing this master' : 'Edit this master'}
              >
                {editing ? 'Done' : 'Edit'}
              </button>
              <button onClick={() => p.onDeleteMaster(m.id)} className="icon-btn !h-5 !w-5" title="Delete master">
                <Icon name="delete" size={12} />
              </button>
            </div>
          )
        })}
        <label className="flex items-center gap-1.5 pt-1">
          <span className="w-24 text-[var(--ink-50)]">This page uses</span>
          <select
            value={page?.masterId === null ? 'none' : current?.id ?? 'none'}
            data-testid="design-page-master"
            onChange={(e) => p.onAssignMaster(p.activePage, e.target.value === 'none' ? null : e.target.value)}
            className="fb-field flex-1 min-w-0 px-1.5 py-1"
          >
            <option value="none">None</option>
            {masters.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* ── Layers ──────────────────────────────────────────────────────────── */}
      <section className="space-y-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-[10px] uppercase tracking-wide text-[var(--ink-40)] flex-1">Layers</h4>
          <button onClick={p.onAddLayer} data-testid="design-add-layer" className="icon-btn !h-6 !w-6" title="New layer">
            <Icon name="add" size={14} />
          </button>
        </div>
        <p className="text-[10px] text-[var(--ink-40)] leading-snug">
          Hide a layer to get it out of the way; lock one so its objects cannot be selected or moved. Hidden layers stay out of the export.
        </p>
        {layers.map((l) => (
          <div key={l.id} className="flex items-center gap-1 px-1.5 py-1 rounded border border-[var(--edge-soft)]" data-testid={`design-layer-${l.id}`}>
            <button
              onClick={() => p.onPatchLayer(l.id, { visible: !l.visible })}
              className="icon-btn !h-5 !w-5 shrink-0"
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
              title={l.visible ? 'Hide layer' : 'Show layer'}
            >
              <Icon name={l.visible ? 'visibility' : 'visibility_off'} size={13} className={l.visible ? '' : 'text-[var(--ink-30)]'} />
            </button>
            <button
              onClick={() => p.onPatchLayer(l.id, { locked: !l.locked })}
              className="icon-btn !h-5 !w-5 shrink-0"
              aria-label={l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`}
              title={l.locked ? 'Unlock layer' : 'Lock layer'}
            >
              <Icon name={l.locked ? 'lock' : 'lock_open'} size={13} className={l.locked ? 'text-amber-500' : 'text-[var(--ink-30)]'} />
            </button>
            <input
              defaultValue={l.name}
              onBlur={(e) => p.onPatchLayer(l.id, { name: e.target.value.trim() || l.name })}
              className="flex-1 min-w-0 bg-transparent text-[var(--ink-80)] outline-none"
              aria-label={`Layer name for ${l.name}`}
            />
            {p.hasSelection && (
              <button
                onClick={() => p.onMoveSelectionToLayer(l.id)}
                className="px-1.5 py-0.5 rounded text-[10px] text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
                title="Move the selected objects onto this layer"
                data-testid={`design-move-to-layer-${l.id}`}
              >
                Move here
              </button>
            )}
            {l.id !== BASE_LAYER_ID && layers.length > 1 && (
              <button onClick={() => p.onDeleteLayer(l.id)} className="icon-btn !h-5 !w-5" title="Delete layer — its objects move to the base layer">
                <Icon name="delete" size={12} />
              </button>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
