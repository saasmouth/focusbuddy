// File › Export PNG / SVG / PDF with several artboards: what the file covers.
// PNG and SVG: the active artboard, each artboard as its own file, or the
// whole canvas; PDF: every artboard as a page (in Artboards panel order), or
// the active artboard alone.

import { useState } from 'react'
import { primaryArtboard } from '@shared/draw/ops'
import type { DrawDialog, ExportOptions } from '../editor/types'

type Scope = NonNullable<ExportOptions['scope']>

const exportArtboards: DrawDialog = {
  id: 'export-artboards',
  title: 'Export',
  component: function ExportArtboardsDialog({ ctx, props, close }) {
    const format = (props?.format === 'svg' || props?.format === 'pdf' ? props.format : 'png') as 'png' | 'svg' | 'pdf'
    const doc = ctx.doc()
    const n = doc.artboards.length
    const active = primaryArtboard(doc)
    const choices: Array<{ id: Scope; label: string }> =
      format === 'pdf'
        ? [
            { id: 'pages', label: `All ${n} artboards, one page each` },
            { id: 'artboard', label: `Only the active artboard (${active.name})` }
          ]
        : [
            { id: 'artboard', label: `The active artboard (${active.name})` },
            { id: 'each', label: `Each artboard as its own file (${n} files)` },
            { id: 'canvas', label: 'The whole canvas, every artboard in one picture' }
          ]
    const [scope, setScope] = useState<Scope>(choices[0].id)
    return (
      <form
        className="space-y-2 text-[13px]"
        onSubmit={(e) => {
          e.preventDefault()
          close()
          void ctx.host.exportAs(format, { scope, ...(scope === 'artboard' ? { artboardId: active.id } : {}) })
        }}
      >
        <p className="text-[var(--ink-50)]">Export {format.toUpperCase()} of:</p>
        {choices.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input type="radio" name="export-scope" checked={scope === c.id} onChange={() => setScope(c.id)} data-testid={`draw-export-scope-${c.id}`} />
            <span>{c.label}</span>
          </label>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button type="submit" data-testid="draw-export-go" className="btn-primary px-3 py-1.5">
            Export…
          </button>
        </div>
      </form>
    )
  }
}

export default exportArtboards
