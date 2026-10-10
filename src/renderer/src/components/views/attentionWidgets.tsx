import { useEffect, useMemo, useState } from 'react'
import type { FbNode } from '@shared/types'
import { useWorkItemStore } from '../../stores/workItems'
import { useWidgetStore } from '../../stores/widgets'
import WidgetFrame from '../widgets/WidgetFrame'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import Icon from '../Icon'
import { isTerminalState, queueOf, scopeItemsForDesk, QUEUE_ICON } from '../../lib/attentionQueues'
import { WidgetItemRow } from '../attention/WidgetItemRow'
import type { WidgetSize } from './homeWidgetDefs'

// The Attention widget family (S6, SPEC-014): the command center's face on the
// home canvas. Every widget REFERENCES items that live elsewhere — counts and
// top slices, click-through to the Attention page or the desk — never a second
// place work lives. Counts derive from work_item_state exclusively (F013).

const DAY = 24 * 60 * 60 * 1000

function useAttentionItems(): FbNode[] {
  const items = useWorkItemStore((s) => s.items)
  const loaded = useWorkItemStore((s) => s.loaded)
  const refresh = useWorkItemStore((s) => s.refresh)
  useEffect(() => {
    if (!loaded) void refresh()
  }, [loaded, refresh])
  return items
}

function WidgetShell({
  icon,
  title,
  count,
  children,
  emptyLine
}: {
  icon: string
  title: string
  count: number
  children?: JSX.Element | null
  emptyLine: string
}): JSX.Element {
  const goAttention = useViewStore((s) => s.goAttention)
  return (
    <div className="w-full h-full text-left flex flex-col p-3">
      <button
        onClick={() => goAttention()}
        title="Open Attention"
        className="flex items-center gap-2 fb-press text-left"
      >
        <Icon name={icon} size={15} className="text-[var(--ink-40)]" />
        <span className="fb-t-label text-[var(--ink-70)] flex-1 min-w-0 truncate">{title}</span>
        <span className="fb-t-label text-[var(--ink-40)] fb-tabular">{count}</span>
      </button>
      {/* DEC-128 — an open row needs room: scroll, never clip. */}
      <div className="mt-2 flex-1 min-h-0 overflow-y-auto">
        {count === 0 ? (
          <div className="text-[11px] text-[var(--ink-30)]">{emptyLine}</div>
        ) : (
          children
        )}
      </div>
    </div>
  )
}

/**
 * DEC-050/051 — the widget row carries the SAME anatomy as the Attention
 * page: a card with the queue's colour as a left spine, a completion circle
 * that closes with the queue's own verb, the status, and the due date. Only
 * the density differs — `dense` (small widgets) shows a status DOT where a
 * roomy widget shows the full pill.
 *
 * DEC-128 — the row itself is WidgetItemRow (components/attention): one
 * click opens the page's quick summary and row actions in place, a
 * double-click opens the full item over the page you are on. Nothing here
 * is a trip to the Attention page any more — that is one of the row's doors.
 */
function ItemLines({
  items,
  max,
  dense = false
}: {
  items: FbNode[]
  max: number
  dense?: boolean
}): JSX.Element {
  const nowMs = Date.now()
  return (
    <div className="flex flex-col gap-1">
      {items.slice(0, max).map((i) => (
        <WidgetItemRow key={i.id} i={i} dense={dense} nowMs={nowMs} />
      ))}
    </div>
  )
}

function activeOf(items: FbNode[], queue: string): FbNode[] {
  const now = Date.now()
  return items
    .filter(
      (i) =>
        queueOf(i) === queue &&
        !isTerminalState(i.workItemState) &&
        !(i.snoozeUntil != null && i.snoozeUntil > now) &&
        i.detachedFromId == null
    )
    .sort((a, b) => {
      const da = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY
      const db = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY
      return da - db || b.createdAt - a.createdAt
    })
}

export function AttentionQueueWidget({
  queue,
  title,
  emptyLine,
  size = 'sm'
}: {
  queue: string
  title: string
  emptyLine: string
  size?: WidgetSize
}): JSX.Element {
  const items = useAttentionItems()
  const active = useMemo(() => activeOf(items, queue), [items, queue])
  return (
    <WidgetShell
      icon={QUEUE_ICON[queue] ?? 'check_circle'}
      title={title}
      count={active.length}
      emptyLine={emptyLine}
    >
      <ItemLines items={active} max={size === 'sm' ? 2 : 5} dense={size === 'sm'} />
    </WidgetShell>
  )
}

/** Upcoming dated work: everything with a due_at plus the scheduling queue —
 *  the calendar's attention slice, soonest first. */
export function AttentionCalendarWidget({ size = 'sm' }: { size?: WidgetSize }): JSX.Element {
  const items = useAttentionItems()
  const upcoming = useMemo(() => {
    const now = Date.now()
    return items
      .filter(
        (i) =>
          !isTerminalState(i.workItemState) &&
          i.detachedFromId == null &&
          (i.dueAt != null || queueOf(i) === 'to_meet')
      )
      .sort((a, b) => {
        const da = a.dueAt ? Date.parse(a.dueAt) : now + 365 * DAY
        const db = b.dueAt ? Date.parse(b.dueAt) : now + 365 * DAY
        return da - db
      })
  }, [items])
  return (
    <WidgetShell
      icon="event"
      title="Coming up"
      count={upcoming.length}
      emptyLine="Nothing dated. Clear runway."
    >
      <ItemLines items={upcoming} max={size === 'sm' ? 2 : 5} dense={size === 'sm'} />
    </WidgetShell>
  )
}

/** The closed-loop shelf: what got finished lately (dismissals excluded — this
 *  celebrates completion, it does not archive noise). */
export function AttentionCompletedWidget({ size = 'sm' }: { size?: WidgetSize }): JSX.Element {
  const items = useAttentionItems()
  const done = useMemo(() => {
    const cutoff = Date.now() - 7 * DAY
    return items
      .filter(
        (i) =>
          isTerminalState(i.workItemState) &&
          i.workItemState !== 'dismissed' &&
          i.workItemState !== 'reclassified' &&
          i.updatedAt > cutoff
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [items])
  return (
    <WidgetShell
      icon="task_alt"
      title="Completed"
      count={done.length}
      emptyLine="Loops close here as you finish things."
    >
      <ItemLines items={done} max={size === 'sm' ? 2 : 5} dense={size === 'sm'} />
    </WidgetShell>
  )
}

/** System-origin items (DEC-016 Q7): agent escalations, parked-inbound rows,
 *  cost caps — excluded from the headline count, visible here. */
export function AttentionSystemWidget({ size = 'sm' }: { size?: WidgetSize }): JSX.Element {
  const items = useAttentionItems()
  const sys = useMemo(
    () =>
      items.filter(
        (i) => i.wiOrigin === 'system' && !isTerminalState(i.workItemState) && i.detachedFromId == null
      ),
    [items]
  )
  return (
    <WidgetShell
      icon="settings_suggest"
      title="System"
      count={sys.length}
      emptyLine="No system signals. All quiet."
    >
      <ItemLines items={sys} max={size === 'sm' ? 2 : 5} dense={size === 'sm'} />
    </WidgetShell>
  )
}

// ── The unified Attention widget (DEC-019c) ─────────────────────────────────
// One widget, a section slider: All · To Do · Review · Coming up · Respond ·
// Completed · Stale desks · System. Replaces the seven separates (retired in
// the registry; stored placements keep rendering their old cases).

const SECTIONS = [
  { key: 'all', icon: 'notifications', label: 'All' },
  { key: 'to_do', icon: 'check_circle', label: 'To Do' },
  { key: 'to_review', icon: 'rate_review', label: 'Review' },
  { key: 'upcoming', icon: 'event', label: 'Coming up' },
  { key: 'to_respond', icon: 'reply', label: 'Respond' },
  { key: 'completed', icon: 'task_alt', label: 'Completed' },
  { key: 'stale', icon: 'bedtime', label: 'Stale desks' },
  { key: 'system', icon: 'settings_suggest', label: 'System' }
] as const

// Persisted section keys from before the taxonomy alignment map forward once.
const LEGACY_SECTION: Record<string, string> = {
  action: 'to_do',
  review: 'to_review',
  acknowledgment: 'to_respond'
}

export function AttentionWidget({
  size = 'md',
  itemsOverride,
  showStale = true,
  storageKey = 'attention.widget.section',
  limit,
  // DEC-121 lifted the cap with `scroll`; DEC-128 makes every host scroll, so
  // the prop is kept for its callers and no longer changes anything.
  scroll: _scroll = false,
  onCapture
}: {
  size?: WidgetSize
  /** DEC-045: the desk widget hands in a pre-scoped set; the home widget
   *  keeps reading everything. */
  itemsOverride?: FbNode[]
  /** Stale desks are a GLOBAL feeder — hidden in desk scope (CR-09 lean:
   *  a desk's widget showing that desk's own staleness is circular). */
  showStale?: boolean
  storageKey?: string
  /** DEC-121 — the assistant's Attention tab shows EVERYTHING in the
   *  section, scrolling, where the home widget shows a sized slice. */
  limit?: number
  scroll?: boolean
  /** DEC-131 — a + at the right of the section pills that opens the house
   *  capture prompt (the assistant's Attention tab wears it). */
  onCapture?: () => void
}): JSX.Element {
  const allItems = useAttentionItems()
  const items = itemsOverride ?? allItems
  const goAttention = useViewStore((s) => s.goAttention)
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  const [section, setSection] = useState<string>(() => {
    const stored = localStorage.getItem(storageKey) || 'all'
    return LEGACY_SECTION[stored] ?? stored
  })
  const pick = (k: string): void => {
    localStorage.setItem(storageKey, k)
    setSection(k)
  }
  const [stale, setStale] = useState<Array<{ id: string; title: string; daysQuiet: number }>>([])
  useEffect(() => {
    let alive = true
    void window.api.nodes
      .staleDesks()
      .then((rows) => {
        if (alive) setStale(rows)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const now = Date.now()
  const max = limit ?? (size === 'lg' ? 7 : size === 'md' ? 4 : 2)
  const active = (q: string): FbNode[] => activeOf(items, q)
  const allActive = useMemo(
    () =>
      items
        .filter(
          (i) =>
            !isTerminalState(i.workItemState) &&
            !(i.snoozeUntil != null && i.snoozeUntil > now) &&
            i.detachedFromId == null &&
            i.wiOrigin !== 'system'
        )
        .sort((a, b) => (b.dueAt ? 1 : 0) - (a.dueAt ? 1 : 0) || b.createdAt - a.createdAt),
    [items, now]
  )
  const upcoming = useMemo(
    () =>
      items
        .filter(
          (i) =>
            !isTerminalState(i.workItemState) &&
            i.detachedFromId == null &&
            (i.dueAt != null || queueOf(i) === 'to_meet')
        )
        .sort((a, b) => {
          const da = a.dueAt ? Date.parse(a.dueAt) : now + 365 * DAY
          const db = b.dueAt ? Date.parse(b.dueAt) : now + 365 * DAY
          return da - db
        }),
    [items, now]
  )
  const completed = useMemo(() => {
    const cutoff = now - 7 * DAY
    return items
      .filter(
        (i) =>
          isTerminalState(i.workItemState) &&
          i.workItemState !== 'dismissed' &&
          i.workItemState !== 'reclassified' &&
          i.updatedAt > cutoff
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [items, now])
  const system = useMemo(
    () => items.filter((i) => i.wiOrigin === 'system' && !isTerminalState(i.workItemState)),
    [items]
  )

  const listFor = (): { list: FbNode[]; empty: string } => {
    switch (section) {
      case 'to_do':
        return { list: active('to_do'), empty: 'Nothing to do. Capture with ⌘K.' }
      case 'to_review':
        return { list: active('to_review'), empty: 'No reviews waiting.' }
      case 'upcoming':
        return { list: upcoming, empty: 'Nothing dated. Clear runway.' }
      case 'to_respond':
        return { list: active('to_respond'), empty: 'No one waiting on you.' }
      case 'completed':
        return { list: completed, empty: 'Loops close here as you finish things.' }
      case 'system':
        return { list: system, empty: 'No system signals. All quiet.' }
      default:
        return { list: allActive, empty: 'Nothing needs you. Capture with ⌘K.' }
    }
  }

  const current = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0]
  const { list, empty } = listFor()
  const count = section === 'stale' ? stale.length : list.length

  return (
    <div className="w-full h-full flex flex-col p-3">
      <div className="flex items-center gap-1.5">
        {SECTIONS.filter((s) => showStale || s.key !== 'stale').map((s) => (
          <button
            key={s.key}
            onClick={() => pick(s.key)}
            title={s.label}
            className={`inline-flex items-center justify-center h-6 w-6 rounded-full fb-press ${
              section === s.key
                ? 'bg-[var(--surface-sunken)] text-[var(--ink-100)]'
                : 'text-[var(--ink-30)] hover:text-[var(--ink-70)]'
            }`}
          >
            <Icon name={s.icon} size={13} />
          </button>
        ))}
        {onCapture && (
          <button
            onClick={onCapture}
            title="Capture a new attention item"
            aria-label="Capture a new attention item"
            data-testid="attention-widget-capture"
            className="ml-auto inline-flex items-center justify-center h-6 w-6 rounded-full bg-accent/10 text-[rgb(var(--accent))] hover:bg-accent/20 fb-press"
          >
            <Icon name="add" size={14} />
          </button>
        )}
      </div>
      <button onClick={() => goAttention()} className="mt-2 flex items-center gap-2 fb-press text-left">
        <span className="fb-t-label text-[var(--ink-70)] flex-1 min-w-0 truncate">{current.label}</span>
        <span className="fb-t-label text-[var(--ink-40)] fb-tabular">{count}</span>
      </button>
      {/* DEC-121's `scroll` lifted the cap for the assistant tab; DEC-128 makes
          every host scroll, because an open row (the in-place summary) needs
          room in a sized widget too — clipping it would hide the actions. */}
      <div className="mt-1.5 flex-1 min-h-0 overflow-y-auto" data-testid="attention-widget-list">
        {section === 'stale' ? (
          stale.length === 0 ? (
            <div className="text-[11px] text-[var(--ink-30)]">Every open desk has a pulse.</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {stale.slice(0, max).map((d) => (
                <button
                  key={d.id}
                  onClick={() => {
                    setActive(d.id)
                    goTask(d.id)
                  }}
                  className="text-left min-w-0 fb-press"
                >
                  <div className="text-[12px] text-[var(--ink-90)] truncate">{d.title}</div>
                  <div className="text-[10px] text-[var(--ink-40)]">
                    Quiet for {d.daysQuiet} day{d.daysQuiet === 1 ? '' : 's'}
                  </div>
                </button>
              ))}
            </div>
          )
        ) : count === 0 ? (
          <div className="text-[11px] text-[var(--ink-30)]">{empty}</div>
        ) : (
          <ItemLines items={list} max={max} dense={size === 'sm'} />
        )}
      </div>
    </div>
  )
}

/** Lifecycle L3's only consumer (F006): desks gone quiet while still open. */
export function StaleDesksWidget({ size = 'sm' }: { size?: WidgetSize }): JSX.Element {
  const [stale, setStale] = useState<
    Array<{ id: string; title: string; daysQuiet: number }>
  >([])
  const setActive = useNodeStore((s) => s.setActive)
  const goTask = useViewStore((s) => s.goTask)
  useEffect(() => {
    let alive = true
    void window.api.nodes
      .staleDesks()
      .then((rows) => {
        if (alive) setStale(rows)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return (
    <div className="w-full h-full flex flex-col p-3">
      <div className="flex items-center gap-2">
        <Icon name="bedtime" size={15} className="text-[var(--ink-40)]" />
        <span className="fb-t-label text-[var(--ink-70)] flex-1 min-w-0 truncate">Stale desks</span>
        <span className="fb-t-label text-[var(--ink-40)] fb-tabular">{stale.length}</span>
      </div>
      <div className="mt-2 flex-1 min-h-0 overflow-hidden flex flex-col gap-1.5">
        {stale.length === 0 ? (
          <div className="text-[11px] text-[var(--ink-30)]">Every open desk has a pulse.</div>
        ) : (
          stale.slice(0, size === 'sm' ? 2 : 5).map((d) => (
            <button
              key={d.id}
              onClick={() => {
                setActive(d.id)
                goTask(d.id)
              }}
              className="text-left min-w-0 fb-press"
            >
              <div className="text-[12px] text-[var(--ink-90)] truncate">{d.title}</div>
              <div className="text-[10px] text-[var(--ink-40)]">
                Quiet for {d.daysQuiet} day{d.daysQuiet === 1 ? '' : 's'}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

// ── The desk-placed Attention widget (DEC-045, CR-09 D-B) ───────────────────
// The SAME face as the home widget, scoped to the desk it sits on. Scope
// persists in widget.content ({"scope":"desk"|"all"}); "desk" with an empty
// desk falls back to everything and says so, rather than sitting blank next
// to a full queue.

export function DeskAttentionWidget({
  widget
}: {
  widget: import('@shared/types').Widget
}): JSX.Element {
  const items = useAttentionItems()
  const update = useWidgetStore((s) => s.update)
  const scope = useMemo<'desk' | 'all'>(() => {
    try {
      const c = JSON.parse(widget.content || '{}') as { scope?: string }
      return c.scope === 'all' ? 'all' : 'desk'
    } catch {
      return 'desk'
    }
  }, [widget.content])
  const pickScope = (next: 'desk' | 'all'): void => {
    void update(widget.id, { content: JSON.stringify({ scope: next }) })
  }
  const { scoped, fellBack } = useMemo(
    () => scopeItemsForDesk(items, widget.taskId),
    [items, widget.taskId]
  )
  const effective = scope === 'all' ? items : scoped
  const deskCount = fellBack ? 0 : scoped.length
  return (
    <WidgetFrame widget={widget} headerLabel="attention" headerAccent="bg-violet-300/60 dark:bg-violet-400/25">
      <div className="w-full h-full flex flex-col bg-[var(--surface-raised)]">
        <div className="flex items-center gap-1 px-3 pt-2.5">
          {(
            [
              ['desk', `This desk${deskCount ? ` · ${deskCount}` : ''}`],
              ['all', 'All']
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => pickScope(k)}
              className={`px-2 h-6 rounded-full fb-t-caption fb-press ${
                scope === k
                  ? 'bg-[var(--surface-sunken)] text-[var(--ink-100)]'
                  : 'text-[var(--ink-40)] hover:text-[var(--ink-80)]'
              }`}
            >
              {label}
            </button>
          ))}
          {scope === 'desk' && fellBack && (
            <span className="fb-t-caption text-[var(--ink-30)] truncate">
              nothing here yet — showing all
            </span>
          )}
        </div>
        <div className="flex-1 min-h-0">
          <AttentionWidget
            size="lg"
            itemsOverride={effective}
            showStale={scope === 'all'}
            storageKey={`attention.widget.section:${widget.id}`}
          />
        </div>
      </div>
    </WidgetFrame>
  )
}
