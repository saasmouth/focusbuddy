// Object › Artboards › Artboard Options… (and Rename…): Illustrator's
// Artboard Options -- name, preset, width, height and position -- for one
// artboard. One undo step when applied.

import { useState } from 'react'
import { DRAW_SIZES } from '@shared/draw'
import { ARTBOARD_MAX, ARTBOARD_MIN, artboardById, primaryArtboard } from '@shared/draw/ops'
import type { DrawDialog } from '../editor/types'

const field = 'fb-field w-24 px-2 py-1'

const artboardOptions: DrawDialog = {
  id: 'artboard-options',
  title: 'Artboard Options',
  component: function ArtboardOptionsDialog({ ctx, props, close }) {
    const doc = ctx.doc()
    const a = (typeof props?.id === 'string' ? artboardById(doc, props.id) : undefined) ?? primaryArtboard(doc)
    const [name, setName] = useState(a.name)
    const [w, setW] = useState(a.w)
    const [h, setH] = useState(a.h)
    const [x, setX] = useState(a.x)
    const [y, setY] = useState(a.y)
    const [preset, setPreset] = useState(a.presetId ?? '')
    const num = (v: string): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
    const apply = (): void => {
      if (!name.trim()) {
        ctx.status('An artboard needs a name.')
        return
      }
      const clamp = (v: number): number => Math.max(ARTBOARD_MIN, Math.min(ARTBOARD_MAX, Math.round(v)))
      ctx.run('artboard.patch', {
        id: a.id,
        label: name.trim() !== a.name && w === a.w && h === a.h && x === a.x && y === a.y ? 'Rename Artboard' : 'Artboard Options',
        patch: { name: name.trim(), x: Math.round(x), y: Math.round(y), w: clamp(w), h: clamp(h), ...(preset ? { presetId: preset } : {}) }
      })
      close()
    }
    return (
      <form
        className="space-y-2 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
      >
        <label className="flex items-center gap-2">
          <span className="w-14 text-[var(--ink-50)]">Name</span>
          <input autoFocus={props?.focus === 'name'} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-testid="draw-artboard-name" className="fb-field flex-1 min-w-0 px-2 py-1" />
        </label>
        <label className="flex items-center gap-2">
          <span className="w-14 text-[var(--ink-50)]">Preset</span>
          <select
            value={preset}
            data-testid="draw-artboard-preset"
            className="fb-field flex-1 min-w-0 px-2 py-1"
            onChange={(e) => {
              const s = DRAW_SIZES.find((z) => z.id === e.target.value)
              setPreset(e.target.value)
              if (s) {
                setW(s.w)
                setH(s.h)
              }
            }}
          >
            <option value="">Custom</option>
            {DRAW_SIZES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.w}×{s.h}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-2">
          <span className="w-14 text-[var(--ink-50)]">Size</span>
          <input type="number" aria-label="Width" value={w} min={ARTBOARD_MIN} max={ARTBOARD_MAX} onChange={(e) => (setW(num(e.target.value)), setPreset(''))} data-testid="draw-artboard-w" className={field} />
          <span className="text-[var(--ink-40)]">×</span>
          <input type="number" aria-label="Height" value={h} min={ARTBOARD_MIN} max={ARTBOARD_MAX} onChange={(e) => (setH(num(e.target.value)), setPreset(''))} data-testid="draw-artboard-h" className={field} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-14 text-[var(--ink-50)]">Position</span>
          <input type="number" aria-label="X" value={x} onChange={(e) => setX(num(e.target.value))} data-testid="draw-artboard-x" className={field} />
          <input type="number" aria-label="Y" value={y} onChange={(e) => setY(num(e.target.value))} data-testid="draw-artboard-y" className={field} />
        </div>
        <p className="text-[11px] text-[var(--ink-40)]">Changing an artboard here never moves or scales the artwork.</p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button type="submit" data-testid="draw-artboard-apply" className="btn-primary px-3 py-1.5">
            OK
          </button>
        </div>
      </form>
    )
  }
}

export default artboardOptions
