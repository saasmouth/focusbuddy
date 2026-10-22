import { useEffect, useMemo } from 'react'
import { useDocumentsStore } from '../../stores/documents'
import { useViewStore } from '../../stores/view'
import { DashboardHeader } from '../plexi'
import Icon from '../Icon'
import { PlexiiDocIcon } from '../PlexiiIcon'
import type { DocType } from '@shared/types'

// Recent — the documents you last touched, newest first. Built only from real
// document records (useDocumentsStore), sorted by their real updatedAt. No
// invented rows: an empty workspace shows an honest empty state, and a thin
// history shows only what is genuinely there.

const TYPE_ICON: Record<string, { icon: string; tint: string; label: string }> = {
  doc: { icon: 'description', tint: 'text-sky-500', label: 'Document' },
  sheet: { icon: 'table_chart', tint: 'text-emerald-500', label: 'Spreadsheet' },
  slides: { icon: 'slideshow', tint: 'text-orange-500', label: 'Presentation' },
  map: { icon: 'gesture', tint: 'text-violet-500', label: 'Drawing' },
  design: { icon: 'plexii:design', tint: 'text-fuchsia-500', label: 'Design' }
}

function relTime(ms: number): string {
  const diff = Date.now() - ms
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const hrs = Math.round(m / 60)
  if (hrs < 24) return `${hrs}h ago`
  const d = Math.round(hrs / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function RecentView(): JSX.Element {
  const list = useDocumentsStore((s) => s.list)
  const refresh = useDocumentsStore((s) => s.refresh)
  const goDocument = useViewStore((s) => s.goDocument)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const recent = useMemo(
    () => [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50),
    [list]
  )

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="recent-view">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <DashboardHeader title="Recent" subtitle="The documents you last opened, newest first" />

        {recent.length === 0 ? (
          <div className="px-3 py-16 text-center" data-testid="recent-empty">
            <Icon name="schedule" size={30} className="text-[var(--ink-30)]" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              Nothing here yet. Open or create a document and it will show up here so you can jump
              back to it quickly.
            </p>
          </div>
        ) : (
          <div className="fb-card mt-2 overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3 px-4 py-2 text-[11px] uppercase tracking-wide text-[var(--ink-50)] border-b border-[var(--edge-soft)]">
              <span>Name</span>
              <span>Type</span>
              <span>Last opened</span>
            </div>
            {recent.map((d) => {
              const ti = TYPE_ICON[d.docType as DocType] ?? { icon: 'draft', tint: 'text-[var(--ink-40)]', label: 'File' }
              return (
                <button
                  key={d.id}
                  onClick={() => goDocument(d.id)}
                  data-testid={`recent-row-${d.id}`}
                  className="grid grid-cols-[1fr_auto_auto] gap-3 w-full px-4 py-2.5 items-center text-left border-b border-[color-mix(in_oklab,var(--edge-soft)_60%,transparent)] hover:bg-[var(--surface-sunken)] last:border-b-0"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <PlexiiDocIcon docType={d.docType} size={18} fallback={ti.icon} fallbackClassName={ti.tint} className="shrink-0" />
                    <span className="truncate text-[13px]">{d.title || 'Untitled'}</span>
                  </span>
                  <span className="text-[12px] text-[var(--ink-60)] whitespace-nowrap">{ti.label}</span>
                  <span className="text-[12px] text-[var(--ink-60)] whitespace-nowrap fb-tabular">{relTime(d.updatedAt)}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
