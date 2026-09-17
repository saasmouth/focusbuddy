import { useEffect, useMemo, useState } from 'react'
import Icon from '../Icon'
import { useNodeStore } from '../../stores/nodes'
import { useDocumentsStore } from '../../stores/documents'
import {
  ADD_OPTIONS,
  createAndPlace,
  placeExisting,
  isPlaceableDocType,
  type AddableKind
} from '../../lib/focusAdd'
import type { DocType } from '@shared/types'

interface Props {
  // Focus a freshly created/opened widget as the active tab. Provided by
  // WidgetFocusMode, which clears the Add chrome tab and shows the new widget.
  onOpenWidget: (widgetId: string) => void
}

const DOC_TYPE_ICON: Record<DocType, string> = {
  doc: 'article',
  sheet: 'grid_on',
  slides: 'slideshow',
  map: 'account_tree',
  design: 'palette',
  draw: 'brush'
}

// Full-size launcher for the "Add" action tab: create a new document / page or
// drop an existing document onto the current desk — all without leaving Focus
// Mode. Every path resolves to a real widget, which we then focus so you land
// straight in the thing you just made.
export default function FocusAddSurface({ onOpenWidget }: Props): JSX.Element {
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const docs = useDocumentsStore((s) => s.list)
  const refresh = useDocumentsStore((s) => s.refresh)
  const [busy, setBusy] = useState<AddableKind | string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openQuery, setOpenQuery] = useState('')

  // Load the document list once so "Open existing" is populated. Best-effort:
  // a failure just leaves the list empty; creating still works.
  useEffect(() => {
    void refresh().catch(() => {})
  }, [refresh])

  const existing = useMemo(() => {
    const q = openQuery.trim().toLowerCase()
    // Only documents that have a placeable widget kind (everything but 'design').
    const placeable = docs.filter((d) => isPlaceableDocType(d.docType))
    const filtered = q
      ? placeable.filter((d) => d.title.toLowerCase().includes(q))
      : placeable
    // Most-recently-updated first — the doc you're likely reaching for.
    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40)
  }, [docs, openQuery])

  const noTask = !activeTaskId

  async function handleCreate(kind: AddableKind): Promise<void> {
    if (busy || noTask) return
    setBusy(kind)
    setError(null)
    try {
      const widget = await createAndPlace(kind, activeTaskId)
      if (widget) onOpenWidget(widget.id)
      else setError('Could not create that here.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create that.')
    } finally {
      setBusy(null)
    }
  }

  async function handleOpen(id: string, docType: DocType, title: string): Promise<void> {
    if (busy || noTask) return
    setBusy(id)
    setError(null)
    try {
      const widget = await placeExisting(docType, id, title, activeTaskId)
      if (widget) onOpenWidget(widget.id)
      else setError('Could not open that here.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-raised)] px-8 py-8">
      <div className="mx-auto max-w-2xl flex flex-col gap-8">
        {/* Intro */}
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-2xl bg-[rgb(var(--accent))]/10 flex items-center justify-center shrink-0">
            <Icon name="add" size={22} className="text-[rgb(var(--accent))]" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink-100)]">Add to this desk</h2>
            <p className="text-[12.5px] text-[var(--ink-50)]">
              Create something new or open an existing document — it opens right here.
            </p>
          </div>
        </div>

        {noTask && (
          <div className="rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-[12.5px] text-[var(--ink-90)] flex items-center gap-2">
            <Icon name="info" size={16} className="text-amber-700 dark:text-amber-400 shrink-0" />
            Open a task first — new documents attach to whichever task is on the desk.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 px-3 py-2 text-[12.5px] text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Create new */}
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-50)] mb-3">
            Create new
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {ADD_OPTIONS.map((opt) => (
              <button
                key={opt.kind}
                onClick={() => void handleCreate(opt.kind)}
                disabled={noTask || busy !== null}
                title={opt.hint}
                data-testid={`focus-add-create-${opt.kind}`}
                className="fb-tile group flex flex-col items-start gap-2 hover:border-accent hover:bg-accent/5 px-3.5 py-3 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span className="h-8 w-8 rounded-lg bg-[var(--surface-raised)] flex items-center justify-center text-[rgb(var(--accent))] group-hover:bg-accent/10 transition-colors">
                  <Icon name={busy === opt.kind ? 'hourglass_top' : opt.icon} size={17} className={busy === opt.kind ? 'animate-spin' : ''} />
                </span>
                <span className="text-[13px] font-medium text-[var(--ink-100)]">{opt.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Open existing */}
        <section>
          <div className="flex items-center justify-between gap-3 mb-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--ink-50)]">
              Open existing
            </h3>
            {docs.length > 0 && (
              <div className="relative">
                <Icon
                  name="search"
                  size={14}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)] pointer-events-none"
                />
                <input
                  value={openQuery}
                  onChange={(e) => setOpenQuery(e.target.value)}
                  placeholder="Search documents"
                  data-testid="focus-add-open-search"
                  className="fb-field w-48 text-[var(--ink-100)] pl-7 pr-2 py-1 text-[12px]"
                />
              </div>
            )}
          </div>

          {docs.length === 0 ? (
            <p className="text-[12.5px] text-[var(--ink-40)] italic px-0.5">
              No documents yet — create one above and it'll show up here.
            </p>
          ) : existing.length === 0 ? (
            <p className="text-[12.5px] text-[var(--ink-40)] italic px-0.5">
              Nothing matches "{openQuery}".
            </p>
          ) : (
            <div className="flex flex-col gap-1" data-testid="focus-add-open-list">
              {existing.map((d) => (
                <button
                  key={d.id}
                  onClick={() => void handleOpen(d.id, d.docType, d.title)}
                  disabled={noTask || busy !== null}
                  data-testid={`focus-add-open-${d.id}`}
                  className="flex items-center gap-2.5 rounded-lg border border-transparent hover:border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)] px-2.5 py-2 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span className="h-7 w-7 rounded-md bg-[var(--surface-sunken)] flex items-center justify-center text-[var(--ink-50)] shrink-0">
                    <Icon name={busy === d.id ? 'hourglass_top' : DOC_TYPE_ICON[d.docType] ?? 'description'} size={15} className={busy === d.id ? 'animate-spin' : ''} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] text-[var(--ink-100)] truncate">
                      {d.title || 'Untitled'}
                    </span>
                    <span className="block text-[10.5px] uppercase tracking-wide text-[var(--ink-40)]">
                      {d.docType}
                    </span>
                  </span>
                  <Icon name="north_east" size={14} className="text-[var(--ink-40)] shrink-0" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
