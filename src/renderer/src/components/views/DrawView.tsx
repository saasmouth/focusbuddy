import { useEffect, useState } from 'react'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { DRAW_SIZES, blankDrawBody, type DrawBody, type DrawSize } from '@shared/draw'
import Icon from '../Icon'

// PlexiDraw hub — the door into the vector + painting studio. Start an artwork
// at any artboard size and it opens straight into the studio. Everything about
// what a document contains lives inside the editor; this page only starts and
// reopens them, the same shape as the PlexiDesign hub next door.

const CATEGORIES: { id: DrawSize['category']; label: string; icon: string; blurb: string }[] = [
  { id: 'canvas', label: 'Canvas', icon: 'draw', blurb: 'General-purpose artboards to draw and paint on' },
  { id: 'print', label: 'Print', icon: 'print', blurb: 'Paper sizes at 150dpi, ready to export as PDF' },
  { id: 'screen', label: 'Screen', icon: 'devices', blurb: 'Banners, posts and stories at their native sizes' },
  { id: 'icon', label: 'Icons & marks', icon: 'workspace_premium', blurb: 'Transparent artboards for logos and app icons' }
]

export default function DrawView(): JSX.Element {
  const list = useDocumentsStore((s) => s.list)
  const refresh = useDocumentsStore((s) => s.refresh)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const artworks = list.filter((d) => d.docType === 'draw')

  async function create(body: DrawBody, title: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const doc = await window.api.documents.create({ docType: 'draw', title, body })
      await refresh()
      goDocument(doc.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-auto desk-paper no-tod" data-testid="draw-hub">
      <div className="w-full px-8 py-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="brush" size={22} className="text-accent" />
          <h1 className="text-[20px] font-semibold text-[var(--ink-100)]">PlexiDraw</h1>
        </div>
        <p className="text-[13px] text-[var(--ink-50)] mb-5 max-w-[720px]">
          Vector and painting in one studio. Draw bezier paths with the pen tool, combine them with pathfinder booleans, and paint on pixel layers with brushes
          and blend modes — in the same document, the same layer stack and the same export.
        </p>

        {CATEGORIES.map((cat) => (
          <div key={cat.id} className="mb-5">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-70)] mb-0.5">
              <Icon name={cat.icon} size={15} className="text-[var(--ink-40)]" /> {cat.label}
            </div>
            <p className="text-[11px] text-[var(--ink-40)] mb-2">{cat.blurb}</p>
            <div className="flex flex-wrap gap-2">
              {DRAW_SIZES.filter((s) => s.category === cat.id).map((s) => (
                <button
                  key={s.id}
                  disabled={busy}
                  onClick={() => void create(blankDrawBody(s), s.label)}
                  data-testid={`draw-size-${s.id}`}
                  className="fb-btn-surface group flex flex-col items-center gap-1.5 w-[124px] p-2.5 hover:border-accent hover:shadow-sm transition disabled:opacity-50"
                >
                  <div className="flex items-center justify-center w-full h-12">
                    <div
                      className={`rounded ${s.transparent ? 'border border-dashed border-[var(--edge-firm)]' : 'bg-[var(--surface-sunken)] group-hover:bg-accent/15'}`}
                      style={{ width: Math.min(56, (s.w / Math.max(s.w, s.h)) * 56), height: Math.min(44, (s.h / Math.max(s.w, s.h)) * 44) }}
                    />
                  </div>
                  <div className="text-[11px] text-[var(--ink-70)] text-center leading-tight">{s.label}</div>
                  <div className="text-[10px] text-[var(--ink-40)] fb-tabular">
                    {s.w}×{s.h}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="mt-2">
          <h2 className="text-[13px] font-medium text-[var(--ink-70)] mb-2">Your artwork</h2>
          {artworks.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-40)]">No artwork yet. Pick an artboard size above to start.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {artworks.map((d) => (
                <div
                  key={d.id}
                  className="fb-card fb-press group flex items-center gap-2 px-3 py-2.5 hover:border-accent cursor-pointer"
                  onClick={() => goDocument(d.id)}
                  data-testid={`draw-open-${d.id}`}
                >
                  <Icon name="brush" size={16} className="text-accent shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--ink-90)]">{d.title || 'Untitled artwork'}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(d.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500"
                    title="Delete"
                    aria-label={`Delete ${d.title || 'Untitled artwork'}`}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
