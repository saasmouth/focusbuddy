import { useEffect, useMemo, useState } from 'react'
import { RailCard, StatusPill } from '../plexi'
import Icon from '../Icon'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useDocumentsStore } from '../../stores/documents'
import { usePresenceStore } from '../../stores/presence'
import { useCallStore } from '../../stores/call'
import { useCapabilityEnabled } from '../../stores/capabilities'
import { useViewKindEnabled } from '../../lib/viewCapability'
import { personDisplayName, personInitials } from '../../lib/personName'
import type { TimeBlock, FbNode, DocumentMeta } from '@shared/types'

// The live-dashboard region of the PlexiSuite home: Upcoming, My Tasks, Recent
// Desks, Recent Documents and a Who's-online panel. Every card reads a real store
// and shows an honest empty state when there is no data. Nothing here is seeded
// or invented; an empty workspace shows empty cards, not placeholder rows.

function ago(ms: number): string {
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function Row({
  title,
  meta,
  onClick,
  testid,
  metaNode
}: {
  title: string
  meta?: string
  metaNode?: JSX.Element
  onClick: () => void
  testid?: string
}): JSX.Element {
  return (
    <li>
      <button
        onClick={onClick}
        data-testid={testid}
        className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-[var(--surface-raised)] transition-colors text-left group"
      >
        <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-[var(--edge-firm)]" />
        <span className="flex-1 min-w-0 text-[12.5px] text-[var(--ink-100)] truncate group-hover:text-accent transition-colors">
          {title}
        </span>
        {metaNode}
        {meta && <span className="shrink-0 text-[11px] text-[var(--ink-50)] fb-tabular whitespace-nowrap">{meta}</span>}
      </button>
    </li>
  )
}

function EmptyCard({ text }: { text: string }): JSX.Element {
  return <p className="py-4 text-center text-[12px] text-[var(--ink-50)]">{text}</p>
}

export default function HomeDashboardRegion(): JSX.Element {
  const v = useViewStore()
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const docs = useDocumentsStore((s) => s.list)
  const refreshDocs = useDocumentsStore((s) => s.refresh)
  const peersMap = usePresenceStore((s) => s.peers)
  const startCall = useCallStore((s) => s.startCall)
  // Dashboard cards that lead to (or launch) a gated surface are hidden when the
  // matching capability is off, using the same map the backbone enforces.
  const viewEnabled = useViewKindEnabled()
  const callsEnabled = useCapabilityEnabled('calls')

  const [blocks, setBlocks] = useState<TimeBlock[] | null>(null)

  useEffect(() => {
    void refreshDocs()
    // Upcoming reads the next seven days directly so it never disturbs the
    // calendar view's own loaded range. A failure leaves an honest empty card.
    const now = Date.now()
    window.api.timeBlocks
      .list(now, now + 7 * 86400000)
      .then(setBlocks)
      .catch(() => setBlocks([]))
  }, [refreshDocs])

  const openTask = (n: FbNode): void => {
    setActive(n.id)
    v.goTask(n.id)
  }

  const upcoming = useMemo(() => {
    const now = Date.now()
    return (blocks ?? [])
      .filter((b) => b.startMs > now)
      .sort((a, b) => a.startMs - b.startMs)
      .slice(0, 5)
  }, [blocks])

  const myTasks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && n.status !== 'done' && !n.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    [nodes]
  )

  const recentDesks = useMemo(
    () =>
      nodes
        .filter((n) => n.kind === 'task' && !n.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4),
    [nodes]
  )

  const recentDocs = useMemo(
    () => docs.filter((d) => !d.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5),
    [docs]
  )

  const peers = useMemo(() => Object.values(peersMap), [peersMap])

  const taskStatusTone = (n: FbNode): 'amber' | 'sky' | 'stone' =>
    n.status === 'in_progress' ? 'sky' : n.status === 'parked' ? 'stone' : 'amber'

  return (
    <div data-testid="home-dashboard">
      <div className="mt-10 mb-4 flex items-center gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-widest text-[var(--ink-50)]">Your workspace</h2>
        <div className="flex-1 h-px bg-[var(--edge-soft)]" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-5 items-start">
        {/* Main column */}
        <div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {viewEnabled('calendar') && (
              <RailCard title="Upcoming" icon="calendar_today" tone="sky" action={{ label: 'Calendar', onClick: () => v.goCalendar() }}>
                {blocks === null ? (
                  <p className="py-4 text-center text-[12px] text-[var(--ink-50)]">Loading…</p>
                ) : upcoming.length === 0 ? (
                  <EmptyCard text="Nothing scheduled in the next week." />
                ) : (
                  <ul className="space-y-1" data-testid="home-upcoming">
                    {upcoming.map((b) => (
                      <Row key={b.id} title={b.title || 'Time block'} meta={clockTime(b.startMs)} onClick={() => v.goCalendar()} />
                    ))}
                  </ul>
                )}
              </RailCard>
            )}

            <RailCard title="My desks" icon="check_circle" tone="accent" action={{ label: 'All desks', onClick: () => v.goAllTasks() }}>
              {myTasks.length === 0 ? (
                <EmptyCard text="No open desks. Enjoy the clear deck." />
              ) : (
                <ul className="space-y-1" data-testid="home-tasks">
                  {myTasks.map((n) => (
                    <Row
                      key={n.id}
                      title={n.title || 'Untitled task'}
                      onClick={() => openTask(n)}
                      testid={`home-task-${n.id}`}
                      metaNode={<StatusPill tone={taskStatusTone(n)} label={n.status === 'in_progress' ? 'doing' : n.status === 'parked' ? 'parked' : 'open'} dot={false} />}
                    />
                  ))}
                </ul>
              )}
            </RailCard>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            <RailCard title="Recent desks" icon="desk" tone="violet">
              {recentDesks.length === 0 ? (
                <EmptyCard text="No desks yet. Create one from the hero above." />
              ) : (
                <ul className="space-y-1" data-testid="home-desks">
                  {recentDesks.map((n) => (
                    <Row key={n.id} title={n.title || 'Untitled desk'} meta={ago(n.updatedAt)} onClick={() => openTask(n)} testid={`home-desk-${n.id}`} />
                  ))}
                </ul>
              )}
            </RailCard>

            {viewEnabled('documents') && (
              <RailCard title="Recent documents" icon="description" tone="stone" action={{ label: 'All documents', onClick: () => v.goDocuments() }}>
                {recentDocs.length === 0 ? (
                  <EmptyCard text="No documents yet." />
                ) : (
                  <ul className="space-y-1" data-testid="home-docs">
                    {recentDocs.map((d: DocumentMeta) => (
                      <Row key={d.id} title={d.title || 'Untitled'} meta={ago(d.updatedAt)} onClick={() => v.goDocument(d.id)} testid={`home-doc-${d.id}`} />
                    ))}
                  </ul>
                )}
              </RailCard>
            )}
          </div>
        </div>

        {/* Right rail: presence */}
        <div className="space-y-4">
          <RailCard title="Who's online" icon="group" tone="emerald" action={viewEnabled('people-map') ? { label: 'People Map', onClick: () => v.goPeopleMap() } : undefined}>
            {peers.length === 0 ? (
              <EmptyCard text="Nobody else is online right now." />
            ) : (
              <div data-testid="home-people">
                <ul className="space-y-1.5">
                  {peers.slice(0, 5).map((p) => (
                    <li key={p.accountId} className="flex items-center gap-2.5 px-1">
                      <span className="relative shrink-0">
                        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--surface-sunken)] text-[11px] font-semibold text-[var(--ink-90)] uppercase select-none">
                          {personInitials(p)}
                        </span>
                        <span
                          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface-base)] ${
                            p.status === 'online'
                              ? 'bg-emerald-500'
                              : p.status === 'focus'
                                ? 'bg-violet-500'
                                : p.status === 'away'
                                  ? 'bg-amber-500'
                                  : p.status === 'busy'
                                    ? 'bg-rose-500'
                                    : 'bg-stone-400'
                          }`}
                        />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-medium text-[var(--ink-100)] truncate">{personDisplayName(p, p.accountId)}</p>
                        {p.workingOn && <p className="text-[11px] text-[var(--ink-50)] truncate">{p.workingOn}</p>}
                      </div>
                      {callsEnabled && (
                        <button
                          onClick={() => void startCall({ accountId: p.accountId, handle: p.handle ?? p.accountId, firstName: p.firstName, lastName: p.lastName }, 'video')}
                          aria-label={`Call ${personDisplayName(p, 'teammate')}`}
                          title="Start a video call"
                          data-testid={`home-call-${p.accountId}`}
                          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--ink-50)] hover:text-[rgb(var(--accent))] hover:bg-[var(--surface-sunken)]"
                        >
                          <Icon name="videocam" size={15} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {peers.length > 5 && <p className="mt-2 px-1 text-[11.5px] text-[var(--ink-50)]">+{peers.length - 5} more online</p>}
              </div>
            )}
          </RailCard>
        </div>
      </div>
    </div>
  )
}
