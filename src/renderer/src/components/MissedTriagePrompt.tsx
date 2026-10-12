import { useEffect, useMemo, useState } from 'react'
import type { FbNode, TimeBlock } from '@shared/types'
import { useTimeBlockStore } from '../stores/timeBlocks'
import { useWorkItemStore } from '../stores/workItems'
import { useNodeStore } from '../stores/nodes'
import { useActionHistory } from '../stores/actionHistory'
import { useCloseWorkItem } from './attention/useCloseWorkItem'
import { loadPlannerSettings } from '../lib/attentionPlanner'
import {
  untriagedMissed,
  dayStartOf,
  firstSlotOnDay,
  planReplacements,
  MISSED_LOOKBACK_DAYS
} from '../lib/missedTriage'
import { PRIMARY_ACTION, queueOf, isTerminalState } from '../lib/attentionQueues'
import Icon from './Icon'
import { useInterruptionClear } from '../lib/useInterruptionClear'

// DEC-075 — the missed-items triage. Yesterday's never-completed blocks used
// to scroll silently out of view behind the grid; now the next launch offers
// one gentle pass: check off what actually happened, move what still matters
// to today, park the rest on a coming day — or "Later", which costs nothing
// and returns next launch. Nothing here fires without the person's click, and
// the original block always keeps its honest record (DEC-052 B4: a missed
// block is marked 'missed', never moved — a MOVE is a fresh block).

const DAY_MS = 86_400_000

// Once per app session: the prompt greets the launch, not every navigation.
let promptedThisSession = false

/** Test seam + session reset for HMR. */
export function resetMissedTriageSession(): void {
  promptedThisSession = false
}

export default function MissedTriagePrompt(): JSX.Element | null {
  const interruptionClear = useInterruptionClear('missed-triage', 750)
  const [missed, setMissed] = useState<TimeBlock[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dayPickFor, setDayPickFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const updateBlock = useTimeBlockStore((s) => s.update)
  const createBlock = useTimeBlockStore((s) => s.create)
  const items = useWorkItemStore((s) => s.items)
  const nodes = useNodeStore((s) => s.nodes)
  const closeWorkItem = useCloseWorkItem()

  useEffect(() => {
    if (!interruptionClear) return
    if (promptedThisSession) return
    promptedThisSession = true
    const todayStart = dayStartOf(Date.now())
    void (async () => {
      try {
        const past = await window.api.timeBlocks.list(
          todayStart - MISSED_LOOKBACK_DAYS * DAY_MS,
          todayStart
        )
        const found = untriagedMissed(past, todayStart)
        if (found.length > 0) setMissed(found)
      } catch {
        /* the prompt must never break launch */
      }
    })()
  }, [interruptionClear])

  const titleById = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) m.set(n.id, n.title ?? '')
    for (const i of items) m.set(i.id, i.title ?? '')
    return m
  }, [nodes, items])

  const linkedItem = (b: TimeBlock): FbNode | null =>
    b.taskId ? items.find((i) => i.id === b.taskId && i.kind === 'work_item') ?? null : null

  const rowTitle = (b: TimeBlock): string =>
    b.title || (b.taskId ? titleById.get(b.taskId) || 'Focus time' : 'Focus time')

  function dropRows(ids: string[]): void {
    setMissed((prev) => {
      const next = (prev ?? []).filter((b) => !ids.includes(b.id))
      return next.length ? next : null
    })
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }

  /** "It happened, I just never marked it." Closes the linked item with its
   *  own queue verb (skipping items already closed), then the block. */
  async function completeOne(b: TimeBlock): Promise<void> {
    const item = linkedItem(b)
    if (item && !isTerminalState(item.workItemState)) {
      await closeWorkItem(item, (PRIMARY_ACTION[queueOf(item)] ?? PRIMARY_ACTION.to_do).state)
      const after = useWorkItemStore.getState().items.find((x) => x.id === item.id)
      if (!after || !isTerminalState(after.workItemState)) return // close was cancelled
    }
    await updateBlock(b.id, { status: 'done' })
    dropRows([b.id])
  }

  /** Move to a chosen day: the record stays ('missed'), a fresh block lands in
   *  the day's first honest opening — same clock time, visibly, if it is full. */
  async function moveToDay(b: TimeBlock, dayMs: number): Promise<void> {
    const dayBlocks = await window.api.timeBlocks.list(dayMs, dayMs + DAY_MS)
    const slot =
      firstSlotOnDay(dayBlocks, [], dayMs, b.durationMin, loadPlannerSettings(), Date.now()) ?? {
        startMs: dayMs + (b.startMs - dayStartOf(b.startMs)),
        durationMin: b.durationMin
      }
    await updateBlock(b.id, { status: 'missed' })
    await createBlock({
      taskId: b.taskId,
      title: b.title,
      startMs: slot.startMs,
      durationMin: slot.durationMin,
      meeting: b.meeting ?? null,
      origin: 'manual'
    })
    dropRows([b.id])
  }

  /** Bulk: Plexii places everything back, first openings from today forward,
   *  one undo batch for the whole set of fresh blocks. */
  async function addAllToCalendar(): Promise<void> {
    const rows = missed ?? []
    if (!rows.length) return
    setBusy(true)
    try {
      const todayStart = dayStartOf(Date.now())
      const upcoming = await window.api.timeBlocks.list(todayStart, todayStart + 8 * DAY_MS)
      const placements = planReplacements(
        upcoming,
        rows,
        loadPlannerSettings(),
        todayStart,
        Date.now()
      )
      useActionHistory.getState().beginBatch()
      try {
        for (const b of rows) {
          const p = placements.get(b.id)
          if (!p) continue
          await updateBlock(b.id, { status: 'missed' })
          await createBlock({
            taskId: b.taskId,
            title: b.title,
            startMs: p.startMs,
            durationMin: p.durationMin,
            meeting: b.meeting ?? null,
            origin: 'manual'
          })
        }
      } finally {
        useActionHistory.getState().endBatch(`Rescheduled ${rows.length} missed blocks`)
      }
      setMissed(null)
    } finally {
      setBusy(false)
    }
  }

  async function completeSelected(): Promise<void> {
    const rows = (missed ?? []).filter((b) => selected.has(b.id))
    if (!rows.length) return
    setBusy(true)
    try {
      for (const b of rows) await completeOne(b)
    } finally {
      setBusy(false)
    }
  }

  if (!interruptionClear || !missed || missed.length === 0) return null

  const upcomingDays = Array.from({ length: 7 }, (_, k) => {
    const dayMs = dayStartOf(Date.now()) + k * DAY_MS
    const d = new Date(dayMs)
    return {
      dayMs,
      label:
        k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' })
    }
  })

  return (
    <div
      className="fb-scrim fixed inset-0 z-[330] flex items-center justify-center p-6"
      data-testid="missed-triage"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Missed calendar items"
        data-interruption-owner="missed-triage"
        onKeyDown={(e) => {
          if (e.key === 'Escape') setMissed(null)
        }}
        className="fb-card w-[min(640px,94vw)] p-4 max-h-full overflow-y-auto"
      >
        <div className="flex items-start gap-2">
          <Icon name="history" size={16} className="mt-0.5 text-[rgb(var(--accent))]" />
          <div className="min-w-0 flex-1">
            <div className="fb-t-h3 text-[var(--ink-100)]">
              {missed.length} block{missed.length === 1 ? '' : 's'} slipped past
            </div>
            <div className="fb-t-caption text-[var(--ink-45)] mt-0.5">
              Never marked done, never rescheduled. Check off what happened, move what still
              matters — or Later, and this returns next launch.
            </div>
          </div>
          <button
            onClick={() => setMissed(null)}
            className="icon-btn !h-7 !w-7 shrink-0"
            title="Later — nothing changes"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="mt-3 rounded-[var(--radius-card)] border border-[var(--edge-soft)] divide-y divide-[var(--edge-soft)] overflow-hidden">
          {missed.map((b) => (
            <div
              key={b.id}
              className="flex items-center gap-2.5 px-3 py-2 bg-[var(--surface-raised)]"
              data-testid="missed-row"
            >
              <input
                type="checkbox"
                checked={selected.has(b.id)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(b.id)
                    else next.delete(b.id)
                    return next
                  })
                }
                aria-label="Select for bulk actions"
                className="shrink-0 accent-[rgb(var(--accent))]"
              />
              <div className="min-w-0 flex-1">
                <div className="fb-t-body text-[var(--ink-90)] truncate">{rowTitle(b)}</div>
                <div className="fb-t-caption fb-tabular text-[var(--ink-40)]">
                  {new Date(b.startMs).toLocaleDateString(undefined, {
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric'
                  })}{' '}
                  ·{' '}
                  {new Date(b.startMs).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit'
                  })}{' '}
                  · {b.durationMin}m
                </div>
              </div>
              <button
                onClick={() => void completeOne(b)}
                disabled={busy}
                title="It happened — mark it done"
                data-testid="missed-complete"
                className="h-7 px-2 rounded-[var(--radius-field)] fb-glass-row fb-press fb-t-caption text-emerald-600 hover:bg-emerald-500/10"
              >
                <Icon name="check" size={12} /> Done
              </button>
              <button
                onClick={() => void moveToDay(b, dayStartOf(Date.now()))}
                disabled={busy}
                title="Move it to today's first opening"
                data-testid="missed-today"
                className="h-7 px-2 rounded-[var(--radius-field)] fb-glass-row fb-press fb-t-caption text-[var(--ink-70)] hover:bg-accent/[0.08]"
              >
                Today
              </button>
              <div className="relative">
                <button
                  onClick={() => setDayPickFor((cur) => (cur === b.id ? null : b.id))}
                  disabled={busy}
                  title="Pick a day this week"
                  className="h-7 px-1.5 rounded-[var(--radius-field)] fb-glass-row fb-press fb-t-caption text-[var(--ink-70)] hover:bg-accent/[0.08]"
                >
                  <Icon name="calendar_month" size={13} />
                </button>
                {dayPickFor === b.id && (
                  <div className="absolute right-0 top-8 z-10 rounded-[var(--radius-card)] fb-card p-1.5 flex gap-1">
                    {upcomingDays.map((d) => (
                      <button
                        key={d.dayMs}
                        onClick={() => {
                          setDayPickFor(null)
                          void moveToDay(b, d.dayMs)
                        }}
                        className="h-7 px-2 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-70)] hover:bg-accent/10 whitespace-nowrap"
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <span className="fb-t-caption text-[var(--ink-40)] flex-1">
            The original slots keep their honest record — a move books fresh time.
          </span>
          {selected.size > 0 && (
            <button
              onClick={() => void completeSelected()}
              disabled={busy}
              data-testid="missed-complete-selected"
              className="h-8 px-3 fb-btn-surface fb-press fb-t-label text-emerald-600"
            >
              Complete {selected.size} selected
            </button>
          )}
          <button
            onClick={() => setMissed(null)}
            disabled={busy}
            className="h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-70)]"
          >
            Later
          </button>
          <button
            onClick={() => void addAllToCalendar()}
            disabled={busy}
            className="btn-primary"
            data-testid="missed-add-all"
          >
            <Icon name="event_repeat" size={14} />
            <span>Add all back to the calendar</span>
          </button>
        </div>
      </div>
    </div>
  )
}
