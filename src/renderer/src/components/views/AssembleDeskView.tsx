import { useCallback, useEffect, useRef, useState } from 'react'
import type { SearchHit, Widget, WidgetKind } from '@shared/types'
import { DashboardHeader } from '../plexi'
import Icon from '../Icon'
import { catalogFor } from '../../lib/widgetCatalog'
import { bringWidgetToDesk } from '../../lib/bringWidgetToDesk'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'

// PlexiBrain > Assemble a desk. Search the brain, tick the items you want (and the
// related items it surfaces), then spin up a new desk holding them. By default each
// item comes across as a LIVE-synced copy (shared syncGroupId, so edits mirror
// across desks); a toggle takes disconnected copies instead. Widgets only for now,
// the case the sync model is built for.

function isContentWidget(w: Widget): boolean {
  return w.kind !== 'section' && w.kind !== 'minimap' && !w.pinned
}

function labelFor(w: Widget): string {
  return (w.title && w.title.trim()) || catalogFor(w.kind)?.label || w.kind
}

export default function AssembleDeskView(): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [collected, setCollected] = useState<Widget[]>([])
  const [related, setRelated] = useState<Widget[]>([])
  const [synced, setSynced] = useState(true)
  const [deskName, setDeskName] = useState('')
  const [creating, setCreating] = useState(false)
  const goTask = useViewStore((s) => s.goTask)
  const setActive = useNodeStore((s) => s.setActive)
  const createNode = useNodeStore((s) => s.create)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isCollected = useCallback((id: string) => collected.some((w) => w.id === id), [collected])

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current)
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounce.current = setTimeout(async () => {
      try {
        const all = (await window.api?.search?.query?.(q)) ?? []
        setHits(all.filter((h) => h.type === 'widget'))
      } catch {
        setHits([])
      } finally {
        setSearching(false)
      }
    }, 220)
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [query])

  // Surface graph-related widgets for something the user just collected, so a pick
  // pulls its neighbours in as also-tickable suggestions.
  const surfaceRelated = useCallback(
    async (seedId: string, alreadyIds: Set<string>) => {
      try {
        const ids = (await window.api?.context?.related?.(seedId)) ?? []
        const fetched = await Promise.all(ids.map((id) => window.api?.widgets?.get?.(id) ?? Promise.resolve(null)))
        setRelated((prev) => {
          const have = new Set([...alreadyIds, ...prev.map((w) => w.id)])
          const add = fetched.filter(
            (w): w is Widget => !!w && isContentWidget(w) && !have.has(w.id)
          )
          return add.length ? [...prev, ...add] : prev
        })
      } catch {
        /* honest no-op: no related rather than invented */
      }
    },
    []
  )

  const collect = useCallback(
    async (id: string) => {
      if (isCollected(id)) {
        setCollected((prev) => prev.filter((w) => w.id !== id))
        setRelated((prev) => prev.filter((w) => w.id !== id))
        return
      }
      const w = await window.api?.widgets?.get?.(id)
      if (!w || !isContentWidget(w)) return
      setCollected((prev) => (prev.some((x) => x.id === id) ? prev : [...prev, w]))
      setRelated((prev) => prev.filter((x) => x.id !== id)) // it moved into collected
      void surfaceRelated(id, new Set([...collected.map((x) => x.id), id]))
    },
    [isCollected, collected, surfaceRelated]
  )

  const createDesk = useCallback(async () => {
    if (!collected.length || creating) return
    setCreating(true)
    try {
      // Create through the node STORE (not raw IPC) so the renderer's nodes array
      // includes the new desk; otherwise Canvas cannot resolve it after goTask and
      // falls back to the empty desk gallery.
      const desk = await createNode({
        parentId: null,
        kind: 'task',
        title: deskName.trim() || 'Assembled desk'
      })
      if (!desk) return
      // Lay the collected widgets out in a simple grid on the new desk.
      const COLS = 3
      for (let i = 0; i < collected.length; i++) {
        const x = 40 + (i % COLS) * 380
        const y = 40 + Math.floor(i / COLS) * 320
        await bringWidgetToDesk(collected[i], desk.id, { synced, x, y })
      }
      setActive(desk.id)
      goTask(desk.id)
    } finally {
      setCreating(false)
    }
  }, [collected, creating, deskName, synced, setActive, goTask, createNode])

  return (
    <div
      className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]"
      data-testid="assemble-desk-view"
    >
      <div className="max-w-4xl mx-auto px-6 py-6">
        <DashboardHeader
          title="Assemble a desk"
          subtitle="Search your workspace, gather related items, and open a new desk that holds them."
        />

        <div className="fb-card mt-2 flex items-center gap-2 px-3 py-2">
          <Icon name="search" size={16} className="text-[var(--ink-50)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search work widgets across every desk"
            className="flex-1 bg-transparent text-[14px] placeholder:text-[var(--ink-40)]"
            data-testid="assemble-search"
            autoFocus
          />
          {searching && <Icon name="progress_activity" size={15} className="text-[var(--ink-40)] animate-spin" />}
        </div>

        {/* Results */}
        {query.trim().length >= 2 && (
          <ul className="mt-3 space-y-1" data-testid="assemble-results">
            {hits.length === 0 && !searching ? (
              <li className="px-2 py-6 text-center text-[13px] text-[var(--ink-60)]">No matching work widgets.</li>
            ) : (
              hits.map((h) => (
                <li key={h.id}>
                  <Row
                    id={h.id}
                    title={h.title}
                    kind={h.widgetKind}
                    snippet={h.snippet}
                    checked={isCollected(h.id)}
                    onToggle={() => void collect(h.id)}
                    testid="assemble-result"
                  />
                </li>
              ))
            )}
          </ul>
        )}

        {/* Related surfaced from picks */}
        {related.length > 0 && (
          <div className="mt-4" data-testid="assemble-related">
            <p className="px-1 text-[12px] font-medium uppercase tracking-[0.06em] text-[var(--ink-50)]">
              Related to what you picked
            </p>
            <ul className="mt-1 space-y-1">
              {related.map((w) => (
                <li key={w.id}>
                  <Row
                    id={w.id}
                    title={labelFor(w)}
                    kind={w.kind}
                    snippet={(w.content ?? '').slice(0, 120)}
                    checked={isCollected(w.id)}
                    onToggle={() => void collect(w.id)}
                    testid="assemble-related-row"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Collected tray + create */}
        {collected.length > 0 && (
          <div
            className="fb-card mt-5 p-4"
            data-testid="assemble-tray"
          >
            <div className="flex items-center justify-between gap-3">
              <p className="text-[14px] font-semibold">
                {collected.length} {collected.length === 1 ? 'item' : 'items'} collected
              </p>
              <label className="inline-flex items-center gap-2 text-[13px] text-[var(--ink-70)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={synced}
                  onChange={(e) => setSynced(e.target.checked)}
                  data-testid="assemble-synced-toggle"
                />
                Keep synced across desks
              </label>
            </div>
            <p className="mt-1 text-[12px] text-[var(--ink-55)]">
              {synced
                ? 'Edits to these will stay in sync everywhere they appear.'
                : 'Disconnected copies, they will not stay in sync with the originals.'}
            </p>

            <ul className="mt-3 flex flex-wrap gap-2">
              {collected.map((w) => (
                <li
                  key={w.id}
                  className="inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-sunken)] px-2.5 py-1 text-[12px]"
                >
                  <Icon name={catalogFor(w.kind)?.icon ?? 'widgets'} size={13} className="text-[var(--ink-50)]" />
                  <span className="max-w-[160px] truncate">{labelFor(w)}</span>
                  <button
                    type="button"
                    onClick={() => void collect(w.id)}
                    className="text-[var(--ink-40)] hover:text-rose-500"
                    aria-label={`Remove ${labelFor(w)}`}
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>

            <div className="mt-4 flex items-center gap-2">
              <input
                value={deskName}
                onChange={(e) => setDeskName(e.target.value)}
                placeholder="New desk name"
                className="fb-field flex-1 px-3 py-1.5 text-[13px]"
                data-testid="assemble-desk-name"
              />
              <button
                type="button"
                onClick={() => void createDesk()}
                disabled={creating}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
                data-testid="assemble-create"
              >
                {creating ? (
                  <Icon name="progress_activity" size={14} className="animate-spin" />
                ) : (
                  <Icon name="add" size={14} />
                )}
                Create desk with {collected.length} {collected.length === 1 ? 'item' : 'items'}
              </button>
            </div>
          </div>
        )}

        {query.trim().length < 2 && collected.length === 0 && (
          <div className="px-3 py-16 text-center" data-testid="assemble-empty">
            <Icon name="dashboard_customize" size={30} className="text-[var(--ink-30)]" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              Search for a work widget, tick the ones you want, and pull in the related items it surfaces.
              Then open a fresh desk that holds them all, synced or as standalone copies.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Row(props: {
  id: string
  title: string
  kind?: string
  snippet?: string
  checked: boolean
  onToggle: () => void
  testid: string
}): JSX.Element {
  const { title, kind, snippet, checked, onToggle, testid } = props
  return (
    <label
      className="flex items-center gap-3 rounded-xl border border-transparent hover:border-[var(--edge-soft)] hover:bg-[var(--surface-raised)] px-3 py-2 cursor-pointer"
      data-testid={testid}
      data-checked={checked}
    >
      <input type="checkbox" checked={checked} onChange={onToggle} />
      <Icon name={kind ? catalogFor(kind as WidgetKind)?.icon ?? 'widgets' : 'widgets'} size={15} className="text-[var(--ink-50)] shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] text-[var(--ink-90)] truncate">{title}</span>
        {snippet && <span className="block text-[12px] text-[var(--ink-55)] truncate">{snippet}</span>}
      </span>
    </label>
  )
}
