// Connections: one screen for AI web accounts, model API keys, MCP servers and
// direct app APIs (docs/ai-space/SPEC-CONNECTIONS.md §1, §2).
//
// Cards are grouped under their provider ("Anthropic" holds both the Claude web
// account and every Claude API key), and each card is one identity with its
// own status, payer and projects: "Personal Claude" and "SaaSMouth Claude" sit
// side by side and never share anything. A card opens the side panel, whose
// link is part of the view ({kind:'connections', connectionId}). Coverage is
// honest: what isn't addable yet is listed as Planned, not hidden or faked.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CONNECTION_KIND_LABEL, type ConnectionKind } from '@shared/aispace/connections'
import type { ConnectionCard } from '@shared/aispace/api'
import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { useNoticeStore } from '../../stores/notice'
import { aiSpaceAvailable } from '../../lib/aiSpaceAvailable'
import { Announcer, EmptyState, PrimaryButton, QuietButton, Tabs, useWideLayout } from './ui'
import AddConnectionFlow from './connections/AddConnectionFlow'
import ConnectionCardItem from './connections/ConnectionCardItem'
import ConnectionPanel from './connections/ConnectionPanel'
import { CERTIFICATION_LABEL, FILTERS, loadConnections, useConnectionsScreen, type FilterId } from './connections/model'

export default function ConnectionsView({ connectionId }: { connectionId?: string }): JSX.Element {
  const cards = useConnectionsScreen((s) => s.cards)
  const catalogue = useConnectionsScreen((s) => s.catalogue)
  const workspaces = useConnectionsScreen((s) => s.workspaces)
  const activeWorkspaceIds = useConnectionsScreen((s) => s.activeWorkspaceIds)
  const loadError = useConnectionsScreen((s) => s.loadError)
  const filter = useConnectionsScreen((s) => s.filter)
  const plannedOpen = useConnectionsScreen((s) => s.plannedOpen)
  const disconnectedOpen = useConnectionsScreen((s) => s.disconnectedOpen)
  const docked = useWideLayout()
  const [openId, setOpenId] = useState<string | null>(connectionId ?? null)
  const [refreshTick, setRefreshTick] = useState(0)
  const [adding, setAdding] = useState<null | { preset: { providerId: string; workspaceId: string } | null }>(null)

  // The view is the source of truth for which panel is open.
  useEffect(() => setOpenId(connectionId ?? null), [connectionId])
  const openRef = useRef(openId)
  openRef.current = openId

  // Load, then follow changes made here or anywhere else (a run, a refresh, a
  // sign-in finishing in the browser).
  const available = aiSpaceAvailable()
  useEffect(() => {
    if (!available) return
    void loadConnections()
    const off = window.api.aiSpace.onChanged?.((p) => {
      if (p.topic === 'connection' || p.topic === 'event' || p.topic === 'context') {
        void loadConnections()
        setRefreshTick((n) => n + 1)
      }
    })
    return () => off?.()
  }, [available])

  // Hand focus back to the card the panel was opened from.
  useEffect(() => {
    if (openId || !cards) return
    const id = useConnectionsScreen.getState().returnFocusId
    if (!id) return
    const t = setTimeout(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[data-card-open]')).find((b) => b.dataset.cardOpen === id)
      el?.focus()
      useConnectionsScreen.setState({ returnFocusId: null })
    }, 0)
    return () => clearTimeout(t)
  }, [openId, cards])

  const open = useCallback((id: string) => {
    setOpenId(id)
    useViewStore.getState().go({ kind: 'connections', connectionId: id })
  }, [])

  // Opening or closing changes the view, and MainPane mounts the page afresh
  // for a new view: remember the card here so the new page can focus it.
  const close = useCallback(() => {
    if (openRef.current) useConnectionsScreen.setState({ returnFocusId: openRef.current })
    setOpenId(null)
    useViewStore.getState().go({ kind: 'connections' })
  }, [])

  const changed = useCallback(() => {
    void loadConnections()
  }, [])

  const live = useMemo(() => (cards ?? []).filter((c) => c.status !== 'disconnected'), [cards])
  const disconnected = useMemo(() => (cards ?? []).filter((c) => c.status === 'disconnected'), [cards])
  const counts = useMemo(() => {
    const m = new Map<FilterId, number>([['all', live.length]])
    for (const c of live) m.set(c.kind, (m.get(c.kind) ?? 0) + 1)
    return m
  }, [live])
  const shown = filter === 'all' ? live : live.filter((c) => c.kind === filter)
  const shownDisconnected = filter === 'all' ? disconnected : disconnected.filter((c) => c.kind === filter)
  const groups = useMemo(() => groupByProvider(shown), [shown])
  const planned = (catalogue?.providers ?? []).filter((p) => p.certification.status === 'planned' && (filter === 'all' || p.kind === filter))
  const addableKinds = new Set((catalogue?.providers ?? []).filter((p) => catalogue?.addable.includes(p.id)).map((p) => p.kind))
  const wsById = new Map(workspaces.map((w) => [w.id, w]))
  const openCard = (cards ?? []).find((c) => c.id === openId) ?? null

  const setFilter = (f: FilterId): void => useConnectionsScreen.setState({ filter: f })
  const startAdd = (preset: { providerId: string; workspaceId: string } | null = null): void => setAdding({ preset })

  // Connections live with AI Space on the desktop app (keys stay on this Mac).
  if (!available) {
    return (
      <div className="h-full overflow-auto" data-testid="ais-connections">
        <EmptyState icon="hub" title="Connections are in the Plexii desktop app" body="AI accounts, model keys and MCP servers are set up and stored on your Mac, so they’re managed from the desktop app." testId="conn-unavailable" />
      </div>
    )
  }

  return (
    <div className="ais-touch relative h-full min-h-0 flex" data-testid="ais-connections">
      <Announcer />
      <div className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-[1040px] mx-auto px-6 py-6">
          <header className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-[28px] font-semibold leading-tight text-[var(--ink-100)]">Connections</h1>
              <p className="mt-1 text-[14px] leading-relaxed text-[var(--ink-60)]">Your AI accounts, model keys, MCP servers and app APIs: which projects can use each, who pays, and what ran.</p>
            </div>
            <PrimaryButton onClick={() => startAdd()} testId="conn-add" disabled={!catalogue}>
              <Icon name="add" size={16} />
              Add connection
            </PrimaryButton>
          </header>

          <div className="mt-6 overflow-x-auto pb-1">
            <Tabs<FilterId>
              label="Show"
              testIdPrefix="conn-filter"
              active={filter}
              onChange={setFilter}
              tabs={FILTERS.map((f) => ({ id: f, label: f === 'all' ? 'All' : CONNECTION_KIND_LABEL[f], count: counts.get(f) ?? 0 }))}
            />
          </div>

          {loadError && (
            <div role="alert" className="mt-6 flex items-start gap-2 rounded-[var(--radius-row)] bg-[color-mix(in_oklab,var(--ais-bad)_8%,transparent)] px-3 py-2.5 text-[14px] text-[var(--ink-90)]" data-testid="conn-load-error">
              <Icon name="error" size={16} className="mt-0.5 text-[color:var(--ais-bad)]" />
              <span className="flex-1">Connections couldn’t load: {loadError}</span>
              <QuietButton onClick={() => void loadConnections()}>Try again</QuietButton>
            </div>
          )}

          {!cards && !loadError && (
            <p role="status" className="mt-8 text-[14px] text-[var(--ink-60)]">
              Loading connections…
            </p>
          )}

          {cards && shown.length === 0 && (
            <EmptyConnections filter={filter} addable={filter === 'all' || addableKinds.has(filter)} plannedCount={planned.length} onAdd={() => startAdd()} />
          )}

          {groups.map(([group, list]) => (
            <section key={group} aria-labelledby={`conn-group-${slug(group)}`} className="mt-8" data-testid={`conn-group-${slug(group)}`}>
              <h2 id={`conn-group-${slug(group)}`} className="text-[18px] font-semibold text-[var(--ink-100)]">
                {group}
              </h2>
              <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {list.map((c) => (
                  <ConnectionCardItem key={c.id} card={c} workspace={wsById.get(c.workspaceId)} selected={c.id === openId} onOpen={open} />
                ))}
              </ul>
            </section>
          ))}

          {shownDisconnected.length > 0 && (
            <Collapsible title="Disconnected" count={shownDisconnected.length} open={disconnectedOpen} onToggle={() => useConnectionsScreen.setState({ disconnectedOpen: !disconnectedOpen })} testId="conn-disconnected">
              <p className="text-[13px] text-[var(--ink-60)]">Kept for their history and for any step still to take at the provider.</p>
              <ul className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                {shownDisconnected.map((c) => (
                  <ConnectionCardItem key={c.id} card={c} workspace={wsById.get(c.workspaceId)} selected={c.id === openId} onOpen={open} />
                ))}
              </ul>
            </Collapsible>
          )}

          {planned.length > 0 && (
            <Collapsible title="Planned" count={planned.length} open={plannedOpen} onToggle={() => useConnectionsScreen.setState({ plannedOpen: !plannedOpen })} testId="conn-planned">
              <p className="text-[13px] text-[var(--ink-60)]">Not available yet. Each is added once its adapter passes certification.</p>
              <ul className="mt-3 divide-y divide-[var(--edge-hairline)]" data-testid="conn-planned-list">
                {planned.map((p) => (
                  <li key={p.id} className="py-2.5">
                    <p className="text-[14px] text-[var(--ink-90)]">
                      {p.name}
                      {p.group !== p.name && <span className="text-[var(--ink-50)]"> · {p.group}</span>}
                      <span className="ml-2 text-[12px] text-[var(--ink-50)]">{CONNECTION_KIND_LABEL[p.kind]}</span>
                    </p>
                    <p className="text-[12px] text-[var(--ink-60)]">
                      {CERTIFICATION_LABEL[p.certification.status]}. {p.certification.basis}
                    </p>
                  </li>
                ))}
              </ul>
            </Collapsible>
          )}

          <p className="mt-10 text-[12px] text-[var(--ink-50)]">Keys and tokens are stored encrypted on this Mac and are never shown again. Usage and run history stay on this Mac.</p>
        </div>
      </div>

      {openId && (
        <ConnectionPanel
          connectionId={openId}
          card={openCard}
          workspaces={workspaces}
          docked={docked}
          refreshTick={refreshTick}
          onClose={close}
          onChanged={changed}
          onAddSeparate={(providerId, workspaceId) => startAdd({ providerId, workspaceId })}
        />
      )}

      {adding && catalogue && (
        <AddConnectionFlow
          catalogue={catalogue}
          workspaces={workspaces}
          activeWorkspaceIds={activeWorkspaceIds}
          preset={adding.preset}
          onClose={() => {
            setAdding(null)
            void loadConnections()
          }}
          onFinished={(id, alias) => {
            setAdding(null)
            void loadConnections()
            if (id) {
              useNoticeStore.getState().show({ text: alias ? `${alias} is connected.` : 'Connected.', icon: 'check_circle' })
              open(id)
            }
          }}
        />
      )}
    </div>
  )
}

function groupByProvider(list: ConnectionCard[]): Array<[string, ConnectionCard[]]> {
  const m = new Map<string, ConnectionCard[]>()
  for (const c of list) m.set(c.group, [...(m.get(c.group) ?? []), c])
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function EmptyConnections(props: { filter: FilterId; addable: boolean; plannedCount: number; onAdd: () => void }): JSX.Element {
  const kind = props.filter === 'all' ? null : (props.filter as ConnectionKind)
  const title = kind ? `No ${CONNECTION_KIND_LABEL[kind].toLowerCase()} connected` : 'Nothing connected yet'
  const body = !kind
    ? 'Add an API key to run models from a Desk, link a chat account, or connect an MCP server or app. You choose which projects can use each one.'
    : props.addable
      ? 'Add one, then choose which projects can use it.'
      : `None can be added yet.${props.plannedCount ? ' See Planned below for what’s coming.' : ''}`
  return <EmptyState icon="hub" title={title} body={body} action={props.addable ? { label: 'Add connection', run: props.onAdd, testId: 'conn-empty-add' } : undefined} testId="conn-empty" />
}

function Collapsible(props: { title: string; count: number; open: boolean; onToggle: () => void; testId: string; children: ReactNode }): JSX.Element {
  const regionId = `${props.testId}-region`
  return (
    <section className="mt-10" data-testid={props.testId}>
      <h2 className="text-[18px] font-semibold text-[var(--ink-100)]">
        <button
          type="button"
          aria-expanded={props.open}
          aria-controls={regionId}
          onClick={props.onToggle}
          data-testid={`${props.testId}-toggle`}
          className="inline-flex items-center gap-1.5 min-h-[32px] rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
        >
          <Icon name="chevron_right" size={20} className={`text-[var(--ink-50)] motion-safe:transition-transform motion-safe:duration-200 ${props.open ? 'rotate-90' : ''}`} />
          {props.title}
          <span className="text-[13px] font-normal text-[var(--ink-50)] fb-tabular">{props.count}</span>
        </button>
      </h2>
      {props.open && (
        <div id={regionId} className="mt-2 pl-7 ais-expand">
          {props.children}
        </div>
      )}
    </section>
  )
}
