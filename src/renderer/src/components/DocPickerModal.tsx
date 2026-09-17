import { useEffect, useMemo, useState } from 'react'
import type { DocType, DocumentMeta } from '@shared/types'
import Icon from './Icon'

// A reusable "pick a PlexiOffice document" chooser: quick search across every
// office document, a type filter, and (when a desk is active) the documents used
// on that desk surfaced first. Used to reference an office file from a table cell
// and to embed a document inside another document. Picking returns the id + type
// + title so callers can render a chip or an embed without a second fetch.

export interface PickedDoc {
  id: string
  docType: DocType
  title: string
}

interface Props {
  title?: string
  // Restrict to one document kind (e.g. only sheets), or allow any when omitted.
  onlyType?: DocType
  // Document ids to surface first under a "On this desk" heading (e.g. the office
  // widgets on the currently open desk). Optional.
  deskDocIds?: string[]
  onPick: (doc: PickedDoc) => void
  onClose: () => void
}

const TYPE_ICON: Record<DocType, string> = {
  doc: 'description',
  sheet: 'table_chart',
  slides: 'slideshow',
  map: 'account_tree',
  design: 'plexii:design',
  draw: 'brush'
}
const TYPE_LABEL: Record<DocType, string> = {
  doc: 'Docs',
  sheet: 'Sheets',
  slides: 'Slides',
  map: 'Diagrams',
  design: 'Designs',
  draw: 'Artwork'
}
const TYPES: DocType[] = ['doc', 'sheet', 'slides', 'map', 'design', 'draw']

export default function DocPickerModal({
  title = 'Choose an office file',
  onlyType,
  deskDocIds = [],
  onPick,
  onClose
}: Props): JSX.Element {
  const [all, setAll] = useState<DocumentMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<DocType | 'all'>(onlyType ?? 'all')

  useEffect(() => {
    void window.api.documents
      .list()
      .then((docs) => setAll(onlyType ? docs.filter((d) => d.docType === onlyType) : docs))
      .catch(() => setAll([]))
  }, [onlyType])

  const deskSet = useMemo(() => new Set(deskDocIds), [deskDocIds])

  const filtered = useMemo(() => {
    if (!all) return null
    const q = query.trim().toLowerCase()
    return all.filter((d) => {
      if (typeFilter !== 'all' && d.docType !== typeFilter) return false
      if (q && !(d.title || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [all, query, typeFilter])

  const onDesk = useMemo(
    () => (filtered ? filtered.filter((d) => deskSet.has(d.id)) : []),
    [filtered, deskSet]
  )
  const others = useMemo(
    () => (filtered ? filtered.filter((d) => !deskSet.has(d.id)) : []),
    [filtered, deskSet]
  )

  function row(d: DocumentMeta): JSX.Element {
    return (
      <button
        key={d.id}
        onClick={() => onPick({ id: d.id, docType: d.docType, title: d.title })}
        data-testid={`doc-pick-${d.id}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--surface-sunken)]"
      >
        <Icon name={TYPE_ICON[d.docType]} size={15} className="text-[rgb(var(--accent))] shrink-0" />
        <span className="text-[12.5px] text-[var(--ink-80)] truncate flex-1 min-w-0">{d.title || 'Untitled'}</span>
        <span className="text-[10px] text-[var(--ink-40)] shrink-0">{TYPE_LABEL[d.docType].slice(0, -1)}</span>
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-[320] bg-black/40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="doc-picker"
        className="fb-card w-[460px] max-w-[92vw] flex flex-col max-h-[80vh]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--edge-soft)]">
          <Icon name="folder_open" size={16} className="text-[rgb(var(--accent))]" />
          <span className="text-[14px] font-semibold text-[var(--ink-90)]">{title}</span>
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="px-3 pt-3">
          <div className="relative">
            <Icon name="search" size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search office files"
              data-testid="doc-picker-search"
              className="fb-field w-full h-8 pl-7 pr-2 text-[12.5px]"
            />
          </div>
          {!onlyType && (
            <div className="flex items-center gap-1 mt-2 flex-wrap">
              <TypeChip active={typeFilter === 'all'} label="All" onClick={() => setTypeFilter('all')} />
              {TYPES.map((t) => (
                <TypeChip key={t} active={typeFilter === t} label={TYPE_LABEL[t]} onClick={() => setTypeFilter(t)} />
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto mt-2 mx-3 mb-3 rounded-lg bg-[var(--surface-sunken)] divide-y divide-[var(--edge-soft)]">
          {filtered === null ? (
            <div className="px-3 py-2 text-[12px] text-[var(--ink-40)]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-4 text-[12px] text-[var(--ink-40)] text-center">
              {all && all.length > 0 ? 'No office files match.' : 'No office files yet.'}
            </div>
          ) : (
            <>
              {onDesk.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-45)] bg-[var(--surface-sunken)]">
                    On this desk
                  </div>
                  {onDesk.map(row)}
                  {others.length > 0 && (
                    <div className="px-3 py-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--ink-45)] bg-[var(--surface-sunken)]">
                      All office files
                    </div>
                  )}
                </>
              )}
              {others.map(row)}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function TypeChip({
  active,
  label,
  onClick
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`h-6 px-2 rounded-full text-[11px] border transition-colors ${
        active
          ? 'bg-[rgb(var(--accent))] text-white border-transparent'
          : 'border-[var(--edge-firm)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
      }`}
    >
      {label}
    </button>
  )
}
