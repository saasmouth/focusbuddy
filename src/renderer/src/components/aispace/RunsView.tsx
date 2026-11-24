// Runs: every AI run across your projects, and where each one stands
// (SPEC-AI-SPACE §1 Runs, §4 grid, §5 motion; SPEC-CONNECTIONS §6–7).
//
// What holds on this page:
//  - Status is icon + text. A run Plexii can't observe reads "Status
//    unavailable" with the last step it confirmed and when; nothing is guessed.
//  - Content never moves under the pointer. A row's own status updates in
//    place, but which rows show and in what order only changes when the person
//    asks ("New updates") or changes a filter.
//  - When a run in the list finishes: one brief highlight of its row (none with
//    reduced motion) and one screen-reader announcement.
//  - Rows are buttons: Enter opens the inspector, arrow keys move between
//    rows, Escape closes the inspector and puts focus back on the row.
//  - Selecting a run gives it a stable link ({kind:'airuns', runId}).

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { RunSummary } from '@shared/aispace/api'
import type { RunStatus } from '@shared/aispace/model'
import { useViewStore } from '../../stores/view'
import { aiSpaceAvailable } from '../../lib/aiSpaceAvailable'
import { Announcer, EmptyState, LinkButton, NewUpdatesBar, Tabs, announce, useWideLayout } from './ui'
import RunInspector from './RunInspector'
import RunRow from './runs/RunRow'
import { ALL_RUNS, STATUS_GROUP_LABEL, connectionOptions, groupCounts, matchesFilter, projectOptions, type RunFilter, type StatusGroup } from './runs/runFilters'
import { errorText, isTerminal, prefersReducedMotion, safeText, statusWord } from './runs/runText'
import { useCoalescedRefresh } from './runs/useCoalescedRefresh'
import './runs/runs.css'

// listRuns returns at most this many, newest first (service.listRuns).
const LIST_LIMIT = 300
const FLASH_MS = 1000

export default function RunsView({ runId }: { runId?: string }): JSX.Element {
  // `runs` is live: each row's own data updates in place. `basis` decides which
  // rows show and in what order; it moves only when the person asks.
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [basis, setBasis] = useState<RunSummary[] | null>(null)
  const [incoming, setIncoming] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [filter, setFilter] = useState<RunFilter>(ALL_RUNS)
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set())
  const [expanded, setExpanded] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const wide = useWideLayout()

  const liveRef = useRef<RunSummary[] | null>(null)
  // The last status this page showed for each run, and which finishes it has
  // already announced (a late duplicate event must not announce twice).
  const seen = useRef(new Map<string, RunStatus>())
  const announced = useRef(new Set<string>())
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const scrollRef = useRef<HTMLDivElement>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    const t = timers.current
    return () => {
      for (const h of t) clearTimeout(h)
      t.clear()
    }
  }, [])

  const noteTransitions = useCallback((fresh: RunSummary[]) => {
    const finished: RunSummary[] = []
    for (const r of fresh) {
      const prev = seen.current.get(r.id)
      if (prev && !isTerminal(prev) && isTerminal(r.status) && !announced.current.has(r.id)) {
        announced.current.add(r.id)
        finished.push(r)
      }
      seen.current.set(r.id, r.status)
    }
    if (!finished.length) return
    for (const r of finished) announce(`${safeText(r.title) || 'A run'}: ${statusWord(r.status)}`)
    if (prefersReducedMotion()) return
    const ids = finished.map((r) => r.id)
    setFlashing((s) => new Set([...s, ...ids]))
    const h = setTimeout(() => {
      timers.current.delete(h)
      setFlashing((s) => {
        const n = new Set(s)
        for (const id of ids) n.delete(id)
        return n
      })
    }, FLASH_MS)
    timers.current.add(h)
  }, [])

  // Full read: the list takes its new shape. Only on open, on request, and when
  // the person switches workspaces.
  const load = useCallback(async () => {
    try {
      const fresh = await window.api.aiSpace.listRuns()
      noteTransitions(fresh)
      liveRef.current = fresh
      setRuns(fresh)
      setBasis(fresh)
      setIncoming(0)
      setLoadError(null)
      setRefreshError(null)
    } catch (e) {
      setLoadError(errorText(e))
    }
  }, [noteTransitions])

  // In-place read: rows already shown take their new status; runs not shown
  // yet are counted for "New updates", never inserted under the pointer.
  const refreshInPlace = useCoalescedRefresh(async () => {
    const current = liveRef.current
    if (!current) return
    try {
      const fresh = await window.api.aiSpace.listRuns()
      const byId = new Map(fresh.map((r) => [r.id, r]))
      const shownIds = new Set(current.map((r) => r.id))
      noteTransitions(fresh.filter((r) => shownIds.has(r.id)))
      const next = current.map((r) => byId.get(r.id) ?? r)
      const added = fresh.filter((r) => !shownIds.has(r.id)).length
      const gone = current.filter((r) => !byId.has(r.id)).length
      liveRef.current = next
      setRuns(next)
      setIncoming(added + gone)
      setRefreshError(null)
    } catch (e) {
      setRefreshError(errorText(e))
    }
  })

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const off = window.api?.aiSpace?.onChanged?.((p) => {
      // Switching workspaces is the person's own act: show that space now.
      if (p.topic === 'context') void load()
      else if (p.topic === 'run' || p.topic === 'event') refreshInPlace()
    })
    return () => off?.()
  }, [load, refreshInPlace])

  // ── What shows ──────────────────────────────────────────────────────────────

  const liveById = useMemo(() => new Map((runs ?? []).map((r) => [r.id, r])), [runs])
  const shown = useMemo(() => (basis ?? []).filter((r) => matchesFilter(r, filter)).map((r) => liveById.get(r.id) ?? r), [basis, filter, liveById])
  // A shown run whose new status takes it out of this filter (or one that now
  // belongs in it) waits for "New updates" like a new run does.
  const reshaped = useMemo(() => {
    const now = (runs ?? []).filter((r) => matchesFilter(r, filter)).map((r) => r.id)
    return now.length !== shown.length || now.some((id, i) => id !== shown[i].id)
  }, [runs, filter, shown])
  const pending = incoming + (reshaped && incoming === 0 ? 1 : 0)

  const counts = useMemo(() => groupCounts(basis ?? [], filter), [basis, filter])
  const projects = useMemo(() => projectOptions(runs ?? []), [runs])
  const connections = useMemo(() => connectionOptions(runs ?? []), [runs])
  const filtered = filter.group !== 'all' || filter.projectId !== '' || filter.connection !== ''

  function changeFilter(next: RunFilter): void {
    // The person acted, so the list may take its current shape now.
    if (liveRef.current) setBasis(liveRef.current)
    setFilter(next)
  }

  async function applyUpdates(): Promise<void> {
    const fromBar = (document.activeElement as HTMLElement | null)?.dataset?.testid === 'ais-new-updates'
    await load()
    scrollRef.current?.scrollTo?.({ top: 0 })
    // The bar is gone; keep keyboard focus on the list rather than the page.
    if (fromBar) setTimeout(() => scrollRef.current?.querySelector<HTMLElement>('[data-run-id]')?.focus(), 0)
  }

  // ── Selection, keyboard, focus ──────────────────────────────────────────────

  const open = useCallback((id: string) => {
    useViewStore.getState().go({ kind: 'airuns', runId: id })
  }, [])

  const close = useCallback(() => {
    setExpanded(false)
    useViewStore.getState().go({ kind: 'airuns' })
  }, [])

  // Escape (or Close) puts focus back on the run's row, also when the run was
  // opened from a link rather than from this list.
  const prevRunId = useRef(runId)
  useEffect(() => {
    const prev = prevRunId.current
    prevRunId.current = runId
    if (prev && !runId) {
      const h = setTimeout(() => rowRefs.current.get(prev)?.focus(), 0)
      return () => clearTimeout(h)
    }
    if (!runId) setExpanded(false)
    return undefined
  }, [runId])

  // A run opened by link scrolls into view once the list has it.
  const hasBasis = basis !== null
  useEffect(() => {
    if (runId && hasBasis) rowRefs.current.get(runId)?.scrollIntoView?.({ block: 'nearest' })
  }, [runId, hasBasis])

  const tabbable = (focusId && shown.some((r) => r.id === focusId) ? focusId : null) ?? (runId && shown.some((r) => r.id === runId) ? runId : null) ?? shown[0]?.id ?? null

  function onListKey(e: KeyboardEvent<HTMLUListElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const ids = shown.map((r) => r.id)
    if (!ids.length) return
    const cur = (e.target as HTMLElement).closest<HTMLElement>('[data-run-id]')?.dataset.runId ?? null
    const i = cur ? ids.indexOf(cur) : -1
    let n = i
    if (e.key === 'ArrowDown') n = Math.min(ids.length - 1, i + 1)
    if (e.key === 'ArrowUp') n = Math.max(0, i - 1)
    if (e.key === 'Home') n = 0
    if (e.key === 'End') n = ids.length - 1
    e.preventDefault()
    rowRefs.current.get(ids[n])?.focus()
  }

  if (!aiSpaceAvailable()) {
    return <EmptyState icon="desktop_mac" title="Runs are in the Plexii desktop app" body="AI runs and their records stay on your Mac, so they aren’t available here." testId="ais-runs-unavailable" />
  }

  const selectField =
    'fb-field min-h-[32px] rounded-lg px-2.5 py-1 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] text-[var(--ink-90)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] max-w-[240px]'

  return (
    <div className="relative h-full w-full flex overflow-hidden bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="ais-runs">
      <Announcer />
      <div ref={scrollRef} className="relative flex-1 min-w-0 h-full overflow-auto ais-touch">
        <NewUpdatesBar count={pending} onApply={() => void applyUpdates()} />
        <div className="max-w-6xl mx-auto px-6 pt-6 pb-16">
          <header>
            <h1 className="text-[28px] font-semibold leading-tight">Runs</h1>
            <p className="mt-1 text-[14px] text-[var(--ink-60)]">Every AI run across your projects, and where each one stands.</p>
          </header>

          {runs && runs.length > 0 && (
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3" data-testid="ais-runs-filters">
              <Tabs<StatusGroup>
                label="Show runs by status"
                testIdPrefix="ais-runs-filter"
                active={filter.group}
                onChange={(group) => changeFilter({ ...filter, group })}
                tabs={(['all', 'active', 'needs', 'done'] as const).map((id) => ({ id, label: STATUS_GROUP_LABEL[id], count: counts[id] }))}
              />
              <label className="inline-flex items-center gap-2 text-[12px] text-[var(--ink-60)]">
                Project
                <select className={selectField} value={filter.projectId} onChange={(e) => changeFilter({ ...filter, projectId: e.target.value })} data-testid="ais-runs-project">
                  <option value="">All projects</option>
                  {projects.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline-flex items-center gap-2 text-[12px] text-[var(--ink-60)]">
                Connection
                <select className={selectField} value={filter.connection} onChange={(e) => changeFilter({ ...filter, connection: e.target.value })} data-testid="ais-runs-connection">
                  <option value="">All connections</option>
                  {connections.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              {filtered && (
                <LinkButton onClick={() => changeFilter(ALL_RUNS)} testId="ais-runs-clear">
                  Clear filters
                </LinkButton>
              )}
            </div>
          )}

          {loadError && (
            <div role="alert" className="mt-6 text-[13.5px] text-[color:var(--ais-bad)]" data-testid="ais-runs-error">
              <p>Couldn’t load runs: {loadError}</p>
              <div className="mt-1">
                <LinkButton onClick={() => void load()}>Try again</LinkButton>
              </div>
            </div>
          )}
          {refreshError && !loadError && (
            <p role="alert" className="mt-4 text-[12.5px] text-[color:var(--ais-bad)]" data-testid="ais-runs-refresh-error">
              Couldn’t refresh: {refreshError}. Statuses below are the last ones Plexii read.{' '}
              <LinkButton onClick={() => void load()}>Try again</LinkButton>
            </p>
          )}

          {!runs && !loadError && <div className="mt-8 fb-skeleton h-40 rounded-xl" aria-busy="true" aria-label="Loading runs" />}

          {runs && runs.length === 0 && (
            <div className="mt-8 fb-card">
              <EmptyState
                icon="play_circle"
                title="No runs yet"
                body="When you ask an AI to work on a project, each run shows up here with where it stands, who ran it and what it was given."
                action={{ label: 'Open AI Space', run: () => useViewStore.getState().goAiSpace(), testId: 'ais-runs-empty-open' }}
                testId="ais-runs-empty"
              />
            </div>
          )}

          {runs && runs.length > 0 && shown.length === 0 && (
            <div className="mt-6 fb-card">
              <EmptyState icon="filter_alt_off" title="No runs match these filters" action={{ label: 'Show all runs', run: () => changeFilter(ALL_RUNS), testId: 'ais-runs-show-all' }} testId="ais-runs-none-match" />
            </div>
          )}

          {shown.length > 0 && (
            <>
              <p className="mt-5 text-[12px] text-[var(--ink-50)] fb-tabular" data-testid="ais-runs-count">
                {filtered ? `${shown.length} of ${basis?.length ?? 0} runs` : `${shown.length} ${shown.length === 1 ? 'run' : 'runs'}`}
                {(runs?.length ?? 0) >= LIST_LIMIT ? ` · the latest ${LIST_LIMIT} are listed` : ''}
              </p>
              <div className="ais-runs-list mt-2 rounded-xl border border-[var(--edge-soft)] bg-[var(--surface-raised)] overflow-hidden">
                <div className="ais-run-grid ais-runs-head px-4 py-2 border-b border-[var(--edge-soft)] text-[12px] text-[var(--ink-50)]" aria-hidden="true">
                  <span className="ais-run-status">Status</span>
                  <span className="ais-run-main">Run</span>
                  <span className="ais-run-conn">Connection</span>
                  <span className="ais-run-model">Model</span>
                  <span className="ais-run-time">Time</span>
                </div>
                <ul aria-label="Runs" onKeyDown={onListKey} data-testid="ais-runs-list">
                  {shown.map((r) => (
                    <RunRow
                      key={r.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(r.id, el)
                        else rowRefs.current.delete(r.id)
                      }}
                      run={r}
                      selected={r.id === runId}
                      flash={flashing.has(r.id)}
                      tabIndex={r.id === tabbable ? 0 : -1}
                      onOpen={open}
                      onFocusRow={setFocusId}
                    />
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
      {runId && <RunInspector key={runId} runId={runId} docked={wide} expanded={expanded} onToggleExpand={() => setExpanded((v) => !v)} onClose={close} />}
    </div>
  )
}
