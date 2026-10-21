// Document > Artboard size…: width, height and the anchor the artwork stays
// pinned at.

import { useState } from 'react'
import { ARTBOARD_ANCHORS, primaryArtboard, type ArtboardAnchor } from '@shared/draw/ops'
import type { DrawDialog } from '../editor/types'

const artboardSize: DrawDialog = {
  id: 'artboard-size',
  title: 'Artboard size',
  component: function ArtboardSizeDialog({ ctx, close }) {
    const board = primaryArtboard(ctx.doc())
    const [w, setW] = useState(board.w)
    const [h, setH] = useState(board.h)
    const [anchor, setAnchor] = useState<ArtboardAnchor>('nw')
    return (
      <div className="space-y-2 text-[13px]">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            <span className="text-[var(--ink-50)]">Width</span>
            <input
              type="number"
              value={w}
              min={16}
              max={12000}
              onChange={(e) => setW(Number(e.target.value) || 0)}
              data-testid="draw-size-width"
              className="fb-field w-24 px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[var(--ink-50)]">Height</span>
            <input
              type="number"
              value={h}
              min={16}
              max={12000}
              onChange={(e) => setH(Number(e.target.value) || 0)}
              data-testid="draw-size-height"
              className="fb-field w-24 px-2 py-1"
            />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[var(--ink-50)]">Anchor</span>
          {/* Where the artwork stays pinned as the page grows or shrinks
              around it, like a canvas-size dialog. */}
          <div className="grid grid-cols-3 gap-0.5" role="radiogroup" aria-label="Anchor" data-testid="draw-size-anchor">
            {ARTBOARD_ANCHORS.map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={anchor === id}
                aria-label={`Anchor ${id}`}
                data-testid={`draw-size-anchor-${id}`}
                onClick={() => setAnchor(id)}
                className={`w-5 h-5 rounded-sm border ${anchor === id ? 'bg-accent border-accent' : 'border-[var(--edge-firm)] hover:bg-[var(--surface-sunken)]'}`}
              />
            ))}
          </div>
        </div>
        <p className="text-[11px] text-[var(--ink-40)]">
          Changing the artboard resizes the canvas only — the artwork stays pinned at the anchor, and painted pixels are kept at their size, never stretched.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button
            onClick={() => {
              ctx.run('document.resize', { w: Math.max(16, Math.min(12000, Math.round(w))), h: Math.max(16, Math.min(12000, Math.round(h))), anchor })
              close()
            }}
            data-testid="draw-size-apply"
            className="btn-primary px-3 py-1.5"
          >
            Resize
          </button>
        </div>
      </div>
    )
  }
}

export default artboardSize
