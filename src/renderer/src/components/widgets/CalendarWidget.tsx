import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FbNode, TimeBlock, Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useNodeStore } from '../../stores/nodes'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'

// The month, made of things that actually exist.
//
// Every mark on this grid comes from somewhere real: a task's due date, or a
// booked time block. Nothing is placed to make the month look inhabited. An
// empty February renders as an empty February.
//
// Scope follows the same rule as the tasks widget -- this desk and everything
// under it, or the whole workspace -- because the point of a calendar on a desk
// is the dates belonging to THIS work, not a second copy of the main calendar.

interface CalendarContent {
  scope?: 'desk' | 'all'
  /** Month being viewed, as ms at its first day. Absent = the current month. */
  month?: number
  show?: { due?: boolean; blocks?: boolean }
}

function parse(raw: string | null | undefined): CalendarContent {
  if (!raw) return {}
  try {
    const p = JSON.parse(raw) as CalendarContent
    return p && typeof p === 'object' ? p : {}
  } catch {
    return {}
  }
}

const DAY = 86_400_000
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

const startOfDay = (ts: number): number => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const startOfMonth = (ts: number): number => {
  const d = new Date(ts)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
const addMonths = (ts: number, n: number): number => {
  const d = new Date(ts)
  d.setMonth(d.getMonth() + n)
  return startOfMonth(d.getTime())
}
/** Monday-first weekday index. */
const dowIndex = (ts: number): number => (new Date(ts).getDay() + 6) % 7

/** Every id at or under `rootId`, so a desk's tasks include its sub-tasks. */
function descendantsOf(nodes: FbNode[], rootId: string | null): Set<string> {
  const out = new Set<string>()
  if (!rootId) return out
  const byParent = new Map<string, FbNode[]>()
  for (const n of nodes) {
    const k = n.parentId ?? ''
    const list = byParent.get(k)
    if (list) list.push(n)
    else byParent.set(k, [n])
  }
  const queue = [rootId]
  out.add(rootId)
  while (queue.length) {
    const id = queue.shift() as string
    for (const child of byParent.get(id) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id)
        queue.push(child.id)
      }
    }
  }
  return out
}

interface DayMark {
  due: FbNode[]
  blocks: TimeBlock[]
}

export default function CalendarWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const nodes = useNodeStore((s) => s.nodes)
  const model = useMemo(() => parse(widget.content), [widget.content])

  const scope = model.scope ?? 'desk'
  const show = { due: model.show?.due !== false, blocks: model.show?.blocks !== false }
  const [month, setMonth] = useState(() => model.month ?? startOfMonth(Date.now()))
  const [selected, setSelected] = useState<number | null>(() => startOfDay(Date.now()))
  const [blocks, setBlocks] = useState<TimeBlock[] | null>(null)
  const [blockError, setBlockError] = useState<string | null>(null)

  const save = (next: Partial<CalendarContent>): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, ...next }) })
  }

  // The grid always shows whole weeks, so it starts on the Monday on or before
  // the 1st and runs six rows -- a fixed height stops the widget resizing
  // itself as the user pages through months.
  const gridStart = useMemo(() => startOfDay(month) - dowIndex(month) * DAY, [month])
  const gridEnd = gridStart + 42 * DAY

  const loadBlocks = useCallback(async (): Promise<void> => {
    const api = (window as { api?: Record<string, unknown> }).api
    const tb = api?.timeBlocks as
      | { list?: (from: number, to: number) => Promise<TimeBlock[]> }
      | undefined
    if (!tb?.list) {
      // No time-block store in this runtime. Say so rather than drawing a month
      // with no bookings as though none were booked.
      setBlocks(null)
      setBlockError('unavailable')
      return
    }
    try {
      setBlocks(await tb.list(gridStart, gridEnd))
      setBlockError(null)
    } catch (e) {
      setBlocks(null)
      setBlockError(e instanceof Error ? e.message : String(e))
    }
  }, [gridStart, gridEnd])

  useEffect(() => {
    void loadBlocks()
  }, [loadBlocks])

  const inScope = useMemo(
    () => (scope === 'all' ? null : descendantsOf(nodes, widget.taskId)),
    [nodes, widget.taskId, scope]
  )

  // Day -> what falls on it. Built once per render rather than filtered inside
  // 42 cells.
  const marks = useMemo(() => {
    const map = new Map<number, DayMark>()
    const at = (ts: number): DayMark => {
      const key = startOfDay(ts)
      let m = map.get(key)
      if (!m) {
        m = { due: [], blocks: [] }
        map.set(key, m)
      }
      return m
    }
    if (show.due) {
      for (const n of nodes) {
        if (!n.dueDate || n.archived) continue
        if (n.kind === 'folder') continue
        if (inScope && !inScope.has(n.id)) continue
        if (n.dueDate < gridStart || n.dueDate >= gridEnd) continue
        at(n.dueDate).due.push(n)
      }
    }
    if (show.blocks && blocks) {
      for (const b of blocks) {
        if (inScope && b.taskId && !inScope.has(b.taskId)) continue
        // A generic block with no task belongs to nobody's desk in particular,
        // so it only shows in the whole-workspace view.
        if (inScope && !b.taskId) continue
        at(b.startMs).blocks.push(b)
      }
    }
    return map
  }, [nodes, blocks, inScope, gridStart, gridEnd, show.due, show.blocks])

  const today = startOfDay(Date.now())
  const monthLabel = new Date(month).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric'
  })

  const goMonth = (n: number): void => {
    const next = addMonths(month, n)
    setMonth(next)
    save({ month: next })
  }

  const selectedMark = selected ? marks.get(selected) : undefined
  const selectedTotal = (selectedMark?.due.length ?? 0) + (selectedMark?.blocks.length ?? 0)

  const openTask = (id: string): void => {
    useViewStore.getState().goTask(id)
  }

  return (
    <WidgetFrame
      widget={widget}
      headerLabel="Calendar"
      headerAccent="bg-violet-200/50 dark:bg-violet-400/10"
    >
      <div className="flex h-full flex-col bg-[var(--surface)] text-[12px]">
        <div className="flex items-center gap-1 border-b border-[var(--line)] px-2 py-1.5">
          <button
            type="button"
            className="widget-nodrag grid h-6 w-6 place-items-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            onClick={() => goMonth(-1)}
            title="Previous month"
          >
            <Icon name="chevron_left" className="text-[16px]" />
          </button>
          <span className="flex-1 text-center text-[12px] font-semibold text-[var(--ink-90)]">
            {monthLabel}
          </span>
          <button
            type="button"
            className="widget-nodrag grid h-6 w-6 place-items-center rounded text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            onClick={() => goMonth(1)}
            title="Next month"
          >
            <Icon name="chevron_right" className="text-[16px]" />
          </button>
          <button
            type="button"
            className="widget-nodrag rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            onClick={() => {
              const now = startOfMonth(Date.now())
              setMonth(now)
              setSelected(today)
              save({ month: now })
            }}
          >
            Today
          </button>
          <button
            type="button"
            className="widget-nodrag rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            title={scope === 'desk' ? 'Showing this desk' : 'Showing everything'}
            onClick={() => save({ scope: scope === 'desk' ? 'all' : 'desk' })}
          >
            {scope === 'desk' ? 'This desk' : 'All'}
          </button>
        </div>

        <div className="grid grid-cols-7 px-1 pt-1 text-center text-[9px] font-medium text-[var(--ink-40)]">
          {DOW.map((d, i) => (
            <span key={i}>{d}</span>
          ))}
        </div>

        <div className="widget-nodrag grid flex-1 grid-cols-7 grid-rows-6 gap-px px-1 pb-1">
          {Array.from({ length: 42 }, (_, i) => {
            const day = gridStart + i * DAY
            const inMonth = new Date(day).getMonth() === new Date(month).getMonth()
            const m = marks.get(day)
            const count = (m?.due.length ?? 0) + (m?.blocks.length ?? 0)
            const isToday = day === today
            const isSel = day === selected
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelected(day)}
                className={`flex flex-col items-center justify-start rounded-[3px] py-0.5 text-[10px] leading-none transition-colors ${
                  isSel
                    ? 'bg-[color-mix(in_oklab,var(--accent)_15%,transparent)] ring-1 ring-[var(--accent)]'
                    : 'hover:bg-[var(--surface-sunken)]'
                } ${inMonth ? 'text-[var(--ink-80)]' : 'text-[var(--ink-30)]'}`}
              >
                <span
                  className={`grid h-[16px] w-[16px] place-items-center rounded-full tabular-nums ${
                    isToday ? 'bg-[var(--accent)] font-semibold text-white' : ''
                  }`}
                >
                  {new Date(day).getDate()}
                </span>
                {count > 0 && (
                  <span className="mt-[2px] flex gap-[2px]">
                    {(m?.due.length ?? 0) > 0 && (
                      <span className="h-[4px] w-[4px] rounded-full bg-emerald-500" />
                    )}
                    {(m?.blocks.length ?? 0) > 0 && (
                      <span className="h-[4px] w-[4px] rounded-full bg-violet-500" />
                    )}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        <div className="max-h-[38%] overflow-y-auto border-t border-[var(--line)]">
          {selected && (
            <div className="px-2 py-1.5">
              <div className="mb-1 flex items-baseline gap-2">
                <span className="text-[11px] font-semibold text-[var(--ink-80)]">
                  {new Date(selected).toLocaleDateString(undefined, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'short'
                  })}
                </span>
                {selectedTotal === 0 && (
                  <span className="text-[10px] text-[var(--ink-40)]">Nothing scheduled</span>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {selectedMark?.blocks
                  .slice()
                  .sort((a, b) => a.startMs - b.startMs)
                  .map((b) => (
                    <li
                      key={b.id}
                      className="flex items-center gap-1.5 text-[11px] text-[var(--ink-70)]"
                    >
                      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-violet-500" />
                      <span className="shrink-0 tabular-nums text-[var(--ink-50)]">
                        {new Date(b.startMs).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit'
                        })}
                      </span>
                      <span className="truncate">{b.title || 'Time block'}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--ink-40)]">
                        {b.durationMin}m
                      </span>
                    </li>
                  ))}
                {selectedMark?.due.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="widget-nodrag flex w-full items-center gap-1.5 text-left text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-90)]"
                      onClick={() => openTask(n.id)}
                      title="Open task"
                    >
                      <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-emerald-500" />
                      <span
                        className={`truncate ${n.status === 'done' ? 'line-through opacity-60' : ''}`}
                      >
                        {n.title}
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--ink-40)]">due</span>
                    </button>
                  </li>
                ))}
              </ul>
              {blockError && blockError !== 'unavailable' && (
                <p className="mt-1 text-[10px] text-rose-500">
                  Time blocks unavailable: {blockError}
                </p>
              )}
              {blockError === 'unavailable' && show.blocks && (
                <p className="mt-1 text-[10px] text-[var(--ink-40)]">
                  Time blocks need the desktop app — only due dates are shown.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </WidgetFrame>
  )
}
