// Object › Artboards › Rearrange All Artboards…: Illustrator's dialog --
// layout (grid by row, grid by column, one row, one column), columns or rows,
// spacing, and whether each artboard's artwork moves with it.

import { useState } from 'react'
import type { ArtboardLayout } from '@shared/draw/ops'
import { moveArtWithArtboard } from '../editor/artboards'
import type { DrawDialog } from '../editor/types'

const LAYOUTS: Array<{ id: ArtboardLayout; label: string; icon: string }> = [
  { id: 'grid-by-row', label: 'Grid by row', icon: 'view_comfy' },
  { id: 'grid-by-column', label: 'Grid by column', icon: 'view_module' },
  { id: 'row', label: 'Arrange by row', icon: 'view_column' },
  { id: 'column', label: 'Arrange by column', icon: 'view_agenda' }
]

const artboardRearrange: DrawDialog = {
  id: 'artboard-rearrange',
  title: 'Rearrange All Artboards',
  component: function ArtboardRearrangeDialog({ ctx, close }) {
    const n = ctx.doc().artboards.length
    const [layout, setLayout] = useState<ArtboardLayout>('grid-by-row')
    const [count, setCount] = useState(Math.max(1, Math.ceil(Math.sqrt(n))))
    const [spacing, setSpacing] = useState(20)
    const [rtl, setRtl] = useState(false)
    const [withArt, setWithArt] = useState(moveArtWithArtboard(ctx.get()))
    const grid = layout === 'grid-by-row' || layout === 'grid-by-column'
    return (
      <form
        className="space-y-2.5 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault()
          ctx.run('artboard.rearrange', { layout, count: Math.max(1, Math.round(count) || 1), spacing: Number.isFinite(spacing) ? spacing : 20, rtl, withArt })
          close()
        }}
      >
        <div className="flex gap-1.5" role="radiogroup" aria-label="Layout">
          {LAYOUTS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="radio"
              aria-checked={layout === l.id}
              aria-label={l.label}
              title={l.label}
              data-testid={`draw-rearrange-${l.id}`}
              onClick={() => setLayout(l.id)}
              className={`px-2 py-1 rounded border text-[12px] ${layout === l.id ? 'bg-accent text-white border-accent' : 'border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'}`}
            >
              {l.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <span className="w-28 text-[var(--ink-50)]">{layout === 'grid-by-column' ? 'Rows' : 'Columns'}</span>
          <input type="number" min={1} max={n} disabled={!grid} value={count} onChange={(e) => setCount(Number(e.target.value))} data-testid="draw-rearrange-count" className="fb-field w-20 px-2 py-1" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-28 text-[var(--ink-50)]">Spacing (px)</span>
          <input type="number" value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} data-testid="draw-rearrange-spacing" className="fb-field w-20 px-2 py-1" />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={rtl} onChange={(e) => setRtl(e.target.checked)} />
          <span>Right-to-left layout</span>
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={withArt} onChange={(e) => setWithArt(e.target.checked)} data-testid="draw-rearrange-with-art" />
          <span>Move artwork with artboard</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button type="submit" data-testid="draw-rearrange-apply" className="btn-primary px-3 py-1.5">
            OK
          </button>
        </div>
      </form>
    )
  }
}

export default artboardRearrange
