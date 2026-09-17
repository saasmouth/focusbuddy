import { useEffect, useState } from 'react'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { useBrandStore } from '../../stores/brand'
import {
  DESIGN_SIZES,
  blankDesign,
  blankPublication,
  designFromTemplate,
  findDesignSize,
  templatesForCategory,
  type DesignBody,
  type DesignCategory
} from '@shared/design'
import Icon from '../Icon'

// PlexiDesign hub — its own top-level module (not a tab inside Documents). Start a
// publication at a real page size, a design at any other size, or an on-brand
// template, or open one you already made. Picking a size or template creates the
// document with that body and opens the studio; the AI template generator lives
// inside the studio.
//
// Publications are the page-layout path: they open multi-page, with margins, a
// column grid and a master page already set up, because a brochure that starts
// as a bare canvas makes you build the same scaffolding by hand every time.

const CATEGORIES: { id: DesignCategory; label: string; icon: string }[] = [
  { id: 'publication', label: 'Publications', icon: 'menu_book' },
  { id: 'social', label: 'Social media', icon: 'tag' },
  { id: 'marketing', label: 'Marketing', icon: 'campaign' },
  { id: 'presentation', label: 'Presentations', icon: 'slideshow' },
  { id: 'logo', label: 'Logos & brand', icon: 'workspace_premium' }
]

// How many pages a new publication opens with. Four is a folded A4 sheet — the
// smallest thing that is actually a publication rather than a flyer — and pages
// are trivial to add or remove from the page rail.
const PUBLICATION_PAGES = 4

export default function DesignsView(): JSX.Element {
  const list = useDocumentsStore((s) => s.list)
  const refresh = useDocumentsStore((s) => s.refresh)
  const remove = useDocumentsStore((s) => s.remove)
  const goDocument = useViewStore((s) => s.goDocument)
  const brand = useBrandStore((s) => s.kit)
  const loadBrand = useBrandStore((s) => s.load)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
    void loadBrand()
  }, [refresh, loadBrand])

  const designs = list.filter((d) => d.docType === 'design')

  async function create(body: DesignBody, title: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const doc = await window.api.documents.create({ docType: 'design', title, body })
      await refresh()
      goDocument(doc.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-auto desk-paper no-tod">
      <div className="w-full px-8 py-6">
        <div className="flex items-center gap-2.5 mb-1">
          <Icon name="palette" size={22} className="text-accent" />
          <h1 className="text-[20px] font-semibold text-[var(--ink-100)]">PlexiDesign</h1>
        </div>
        <p className="text-[13px] text-[var(--ink-50)] mb-5 max-w-[760px]">
          A free-form page designer — somewhere between Publisher and InDesign. Place anything anywhere, thread a story through linked text frames, lay pages
          out on master pages with real margins, columns and guides, and send it to print with bleed and crop marks.
        </p>

        {/* Start a blank design at a size */}
        {CATEGORIES.map((cat) => (
          <div key={cat.id} className="mb-5">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink-70)] mb-0.5">
              <Icon name={cat.icon} size={15} className="text-[var(--ink-40)]" /> {cat.label}
            </div>
            <p className="text-[11px] text-[var(--ink-40)] mb-2">
              {cat.id === 'publication'
                ? `Opens as a ${PUBLICATION_PAGES}-page document with margins, a column grid and a master page ready to use.`
                : 'A single-page canvas at a fixed size.'}
            </p>
            <div className="flex flex-wrap gap-2">
              {DESIGN_SIZES.filter((s) => s.category === cat.id).map((s) => (
                <button
                  key={s.id}
                  disabled={busy}
                  onClick={() => void create(cat.id === 'publication' ? blankPublication(s, PUBLICATION_PAGES) : blankDesign(s), s.label)}
                  data-testid={`designs-size-${s.id}`}
                  className="fb-btn-surface group flex flex-col items-center gap-1.5 w-[112px] p-2.5 hover:border-accent hover:shadow-sm transition disabled:opacity-50"
                >
                  <div className="flex items-center justify-center w-full h-12">
                    <div
                      className="bg-[var(--surface-sunken)] group-hover:bg-accent/15 rounded"
                      style={{ width: Math.min(56, (s.w / Math.max(s.w, s.h)) * 56), height: Math.min(44, (s.h / Math.max(s.w, s.h)) * 44) }}
                    />
                  </div>
                  <div className="text-[11px] text-[var(--ink-70)] text-center leading-tight">{s.label}</div>
                  <div className="text-[10px] text-[var(--ink-40)] fb-tabular">{s.w}×{s.h}</div>
                </button>
              ))}
            </div>
            {/* On-brand template starts for this category */}
            {templatesForCategory(cat.id).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {templatesForCategory(cat.id).map((t) => {
                  const size = findDesignSize(t.sizeId)
                  return (
                    <button
                      key={t.id}
                      disabled={busy || !size}
                      onClick={() => size && void create(designFromTemplate(t, size, brand), t.label)}
                      data-testid={`designs-template-${t.id}`}
                      className="fb-btn-surface inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] text-[var(--ink-70)] hover:border-accent hover:bg-accent/5 disabled:opacity-50"
                    >
                      <Icon name="auto_awesome" size={12} className="text-accent" /> {t.label}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}

        {/* Existing designs */}
        <div className="mt-2">
          <h2 className="text-[13px] font-medium text-[var(--ink-70)] mb-2">Your documents</h2>
          {designs.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-40)]">Nothing here yet. Pick a page size or a template above to start.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {designs.map((d) => (
                <div
                  key={d.id}
                  className="fb-card fb-press group flex items-center gap-2 px-3 py-2.5 hover:border-accent cursor-pointer"
                  onClick={() => goDocument(d.id)}
                  data-testid={`designs-open-${d.id}`}
                >
                  <Icon name="palette" size={16} className="text-accent shrink-0" />
                  <span className="flex-1 min-w-0 truncate text-[13px] text-[var(--ink-90)]">{d.title || 'Untitled design'}</span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(d.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--ink-40)] hover:text-red-500"
                    title="Delete"
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
