// Place a PDF with several pages: which page (Illustrator's Place PDF dialog,
// reduced to what PlexiiDraw can do -- the page is placed as an image).

import { useState } from 'react'
import type { DrawDialog } from '../editor/types'

interface PdfPageProps {
  name?: string
  pages?: number
  template?: boolean
}

const placePdfPage: DrawDialog = {
  id: 'place-pdf-page',
  title: 'Place PDF',
  component: function PlacePdfPageDialog({ ctx, props, close }) {
    const { name = 'PDF', pages = 1, template = false } = (props ?? {}) as PdfPageProps
    const [page, setPage] = useState(1)
    const ok = Number.isInteger(page) && page >= 1 && page <= pages
    return (
      <div className="space-y-2 text-[13px]">
        <p className="text-[var(--ink-60)]">
          {name} has {pages} pages. Choose the page to place; it is placed as an image of that page.
        </p>
        <label className="flex items-center gap-2">
          <span className="text-[var(--ink-50)]">Page</span>
          <input
            type="number"
            min={1}
            max={pages}
            value={page}
            onChange={(e) => setPage(Math.round(Number(e.target.value)))}
            data-testid="draw-pdf-page"
            className="fb-field w-20 px-2 py-1"
          />
          <span className="text-[var(--ink-40)]">of {pages}</span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={close} className="fb-btn-surface px-3 py-1.5">
            Cancel
          </button>
          <button
            disabled={!ok}
            onClick={() => {
              close()
              ctx.run('file.placePdfPage', { page, template })
            }}
            data-testid="draw-pdf-page-place"
            className="btn-primary px-3 py-1.5 disabled:opacity-40"
          >
            Place
          </button>
        </div>
      </div>
    )
  }
}

export default placePdfPage
