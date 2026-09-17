import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ExternalEvent, FbNode, TimeBlock, Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import { useNodeStore } from '../../stores/nodes'
import { colorOfBlock, colorOfCalendar, useCalendarStore } from '../../stores/calendars'
import CalendarEntryModal, { type DayItem } from '../calendar/CalendarEntryModal'
import {
  applyCalendarFilter,
  describeCalendarFilter,
  sourceEnabled,
  type CalendarEntry,
  type CalendarFilter
} from '@shared/calendarFilter'
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
  /** Month being viewed, as ms at its first day. Absent = the current month. */
  month?: number
  /** What this calendar is about. See shared/calendarFilter. */
  filter?: CalendarFilter
  /** Whether the criteria editor is open. */
  editing?: boolean
  // Legacy shape, still read so an existing widget keeps working: these were
  // the whole of the configuration before criteria existed.
  scope?: 'desk' | 'all'
  show?: { due?: boolean; blocks?: boolean }
}

/** Fold the old two-switch config into the criteria model. */
function filterOf(model: CalendarContent): CalendarFilter {
  if (model.filter) return model.filter
  return {
    scope: model.scope ?? 'desk',
    sources: {
      task: model.show?.due !== false,
      block: model.show?.blocks !== false,
      external: true
    },
    taskStatus: 'all'
  }
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
  external: ExternalEvent[]
}

export default function CalendarWidget({ widget }: { widget: Widget }): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const nodes = useNodeStore((s) => s.nodes)
  const model = useMemo(() => parse(widget.content), [widget.content])

  const filter = useMemo(() => filterOf(model), [model])
  const scope = filter.scope ?? 'desk'
  const [openDay, setOpenDay] = useState<number | null>(null)
  const [reloadTick, setReloadTick] = useState(0)
  const [month, setMonth] = useState(() => model.month ?? startOfMonth(Date.now()))
  const [selected, setSelected] = useState<number | null>(() => startOfDay(Date.now()))
  const [blocks, setBlocks] = useState<TimeBlock[] | null>(null)
  const [blockError, setBlockError] = useState<string | null>(null)
  // Events mirrored from Google / Outlook / an ICS feed. Read-only here: they
  // belong to a calendar somewhere else.
  const [external, setExternal] = useState<ExternalEvent[]>([])
  // Each entry is drawn in its own calendar's colour, so a day's list says
  // which diary each line came from.
  const calendars = useCalendarStore((s) => s.calendars)
  const loadCalendars = useCalendarStore((s) => s.load)

  const save = (next: Partial<CalendarContent>): void => {
    void update(widget.id, { content: JSON.stringify({ ...model, ...next }) })
  }

  // The grid always shows whole weeks, so it starts on the Monday on or before
  // the 1st and runs six rows -- a fixed height stops the widget resizing
  // itself as the user pages through months.
  const gridStart = useMemo(() => startOfDay(month) - dowIndex(month) * DAY, [month])
  const gridEnd = gridStart + 42 * DAY

  // Bumped whenever the modal edits something, so the grid reflects the change
  // immediately rather than at the next month page.
  const refresh = useCallback(() => setReloadTick((n) => n + 1), [])

  // A background sync (every 15 minutes) writes straight to the database, so
  // without this the widget kept showing whatever it read when the desk opened.
  useEffect(() => {
    void loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    const api = (window as { api?: Record<string, unknown> }).api
    const ext = api?.externalCalendars as { onEventsChanged?: (cb: () => void) => () => void } | undefined
    return ext?.onEventsChanged?.(() => {
      refresh()
      void loadCalendars()
    })
  }, [refresh, loadCalendars])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStart, gridEnd, reloadTick])

  useEffect(() => {
    void loadBlocks()
  }, [loadBlocks])

  useEffect(() => {
    const api = (window as { api?: Record<string, unknown> }).api
    const ext = api?.externalCalendars as
      | { listEvents?: (f: number, t: number) => Promise<ExternalEvent[]> }
      | undefined
    if (!ext?.listEvents) return
    let alive = true
    void ext
      .listEvents(gridStart, gridEnd)
      .then((rows) => {
        if (alive) setExternal(rows ?? [])
      })
      .catch(() => {
        // A failed read leaves the subscribed events out rather than showing a
        // stale copy; the calendars panel carries the actual error.
        if (alive) setExternal([])
      })
    return () => {
      alive = false
    }
  }, [gridStart, gridEnd, reloadTick])

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
        m = { due: [], blocks: [], external: [] }
        map.set(key, m)
      }
      return m
    }
    // Everything is reduced to one shape and put through ONE filter, so the
    // criteria cannot mean different things to a task and a booking.
    const entries: Array<{ entry: CalendarEntry; put: () => void }> = []

    for (const n of nodes) {
      if (!n.dueDate || n.archived) continue
      if (n.kind === 'folder') continue
      if (n.dueDate < gridStart || n.dueDate >= gridEnd) continue
      entries.push({
        entry: {
          id: n.id,
          source: 'task',
          title: n.title ?? '',
          startMs: n.dueDate,
          status: n.status,
          assignee: n.assignee ?? null,
          inScope: !inScope || inScope.has(n.id)
        },
        put: () => at(n.dueDate as number).due.push(n)
      })
    }

    for (const b of blocks ?? []) {
      if (b.startMs < gridStart || b.startMs >= gridEnd) continue
      entries.push({
        entry: {
          id: b.id,
          source: 'block',
          title: b.title ?? '',
          startMs: b.startMs,
          // A generic block with no task belongs to nobody's desk in
          // particular, so it only counts as in-scope in the whole-workspace
          // view.
          inScope: !inScope ? true : Boolean(b.taskId && inScope.has(b.taskId))
        },
        put: () => at(b.startMs).blocks.push(b)
      })
    }

    for (const e of external) {
      if (e.startMs < gridStart || e.startMs >= gridEnd) continue
      entries.push({
        entry: {
          id: e.id,
          source: 'external',
          title: e.title ?? '',
          startMs: e.startMs,
          calendarId: e.calendarId,
          inScope: true
        },
        put: () => at(e.startMs).external.push(e)
      })
    }

    const keep = new Set(applyCalendarFilter(entries.map((x) => x.entry), filter).map((e) => `${e.source}:${e.id}`))
    for (const x of entries) {
      if (keep.has(`${x.entry.source}:${x.entry.id}`)) x.put()
    }
    return map
  }, [nodes, blocks, external, inScope, gridStart, gridEnd, filter])

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

  /** Everything on a day, in the shape the modal edits. */
  const itemsFor = (day: number): DayItem[] => {
    const m = marks.get(day)
    if (!m) return []
    return [
      ...m.blocks
        .slice()
        .sort((a, b) => a.startMs - b.startMs)
        .map((block) => ({ kind: 'block', block }) as DayItem),
      ...m.external
        .slice()
        .sort((a, b) => a.startMs - b.startMs)
        .map((event) => ({ kind: 'external', event }) as DayItem),
      ...m.due.map((node) => ({ kind: 'task', node }) as DayItem)
    ]
  }

  const selectedMark = selected ? marks.get(selected) : undefined
  const selectedTotal =
    (selectedMark?.due.length ?? 0) +
    (selectedMark?.blocks.length ?? 0) +
    (selectedMark?.external.length ?? 0)

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
            className={`widget-nodrag rounded px-1 py-0.5 hover:bg-[var(--surface-sunken)] ${
              model.editing ? 'text-[var(--accent)]' : 'text-[var(--ink-40)]'
            }`}
            title="Filter criteria"
            data-testid="calendar-filter-toggle"
            onClick={() => save({ editing: !model.editing })}
          >
            <Icon name="tune" className="text-[13px]" />
          </button>
          <button
            type="button"
            className="widget-nodrag hidden rounded px-1.5 py-0.5 text-[10px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
            title={scope === 'desk' ? 'Showing this desk' : 'Showing everything'}
            onClick={() => save({ filter: { ...filter, scope: scope === 'desk' ? 'all' : 'desk' } })}
          >
            {scope === 'desk' ? 'This desk' : 'All'}
          </button>
        </div>

        {model.editing ? (
          <FilterEditor
            filter={filter}
            onChange={(f) => save({ filter: f })}
            onDone={() => save({ editing: false })}
          />
        ) : (
          <button
            type="button"
            onClick={() => save({ editing: true })}
            title="Filter criteria"
            className="widget-nodrag flex items-center gap-1 px-2 py-0.5 text-left text-[9px] text-[var(--ink-45)] hover:text-[var(--ink-70)]"
          >
            <Icon name="filter_alt" className="text-[10px]" />
            <span className="truncate">{describeCalendarFilter(filter)}</span>
          </button>
        )}

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
            const count = (m?.due.length ?? 0) + (m?.blocks.length ?? 0) + (m?.external.length ?? 0)
            const isToday = day === today
            const isSel = day === selected
            return (
              <button
                key={day}
                type="button"
                onClick={() => setSelected(day)}
                onDoubleClick={() => setOpenDay(day)}
                title={count > 0 ? `${count} on this day — double-click to open` : undefined}
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
                    {[
                      ...new Set([
                        ...(m?.blocks ?? []).map((b) => colorOfBlock(calendars, b.calendarId)),
                        ...(m?.external ?? []).map((e) => colorOfCalendar(calendars, e.calendarId))
                      ])
                    ]
                      .slice(0, 3)
                      .map((c) => (
                        <span key={c} className="h-[4px] w-[4px] rounded-full" style={{ backgroundColor: c }} />
                      ))}
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
                {selectedTotal === 0 ? (
                  <span className="text-[10px] text-[var(--ink-40)]">Nothing scheduled</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpenDay(selected)}
                    data-testid="calendar-open-day"
                    className="widget-nodrag ml-auto rounded px-1 text-[10px] text-[var(--ink-45)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)]"
                  >
                    Open day
                  </button>
                )}
              </div>
              <ul className="flex flex-col gap-1">
                {selectedMark?.blocks
                  .slice()
                  .sort((a, b) => a.startMs - b.startMs)
                  .map((b) => (
                    <li key={b.id}>
                     <button
                      type="button"
                      onClick={() => setOpenDay(selected)}
                      className="widget-nodrag flex w-full items-center gap-1.5 text-left text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-90)]"
                     >
                      <span
                        className="h-[6px] w-[6px] shrink-0 rounded-full"
                        style={{ backgroundColor: colorOfBlock(calendars, b.calendarId) }}
                      />
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
                     </button>
                    </li>
                  ))}
                {selectedMark?.external
                  .slice()
                  .sort((a, b2) => a.startMs - b2.startMs)
                  .map((e) => (
                    <li key={e.id}>
                     <button
                      type="button"
                      onClick={() => setOpenDay(selected)}
                      className="widget-nodrag flex w-full items-center gap-1.5 text-left text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-90)]"
                      title={e.location ? `${e.title} — ${e.location}` : e.title}
                     >
                      <span
                        className="h-[6px] w-[6px] shrink-0 rounded-full"
                        style={{ backgroundColor: colorOfCalendar(calendars, e.calendarId) }}
                      />
                      <span className="shrink-0 tabular-nums text-[var(--ink-50)]">
                        {e.allDay
                          ? 'all day'
                          : new Date(e.startMs).toLocaleTimeString(undefined, {
                              hour: 'numeric',
                              minute: '2-digit'
                            })}
                      </span>
                      <span className="truncate">{e.title || 'Untitled event'}</span>
                     </button>
                    </li>
                  ))}
                {selectedMark?.due.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="widget-nodrag flex w-full items-center gap-1.5 text-left text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-90)]"
                      onClick={() => setOpenDay(selected)}
                      title="Open for detail"
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
              {blockError === 'unavailable' && sourceEnabled(filter, 'block') && (
                <p className="mt-1 text-[10px] text-[var(--ink-40)]">
                  Time blocks need the desktop app — only due dates are shown.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {openDay !== null && (
        <CalendarEntryModal
          dayMs={openDay}
          items={itemsFor(openDay)}
          onClose={() => setOpenDay(null)}
          onChanged={refresh}
        />
      )}
    </WidgetFrame>
  )
}

/** The criteria editor: what this calendar is about. */
function FilterEditor({
  filter,
  onChange,
  onDone
}: {
  filter: CalendarFilter
  onChange: (f: CalendarFilter) => void
  onDone: () => void
}): JSX.Element {
  const terms = (t: string[] | undefined): string => (t ?? []).join(', ')
  const parse = (v: string): string[] =>
    v.split(',').map((x) => x.trim()).filter(Boolean)
  const set = (p: Partial<CalendarFilter>): void => onChange({ ...filter, ...p })

  return (
    <div className="flex flex-col gap-1.5 border-b border-[var(--line)] px-2 py-2 text-[10px]">
      <div className="flex items-center gap-1">
        {(['desk', 'all'] as const).map((sc) => (
          <button
            key={sc}
            type="button"
            onClick={() => set({ scope: sc })}
            className={`widget-nodrag rounded-full px-2 py-0.5 ${
              (filter.scope ?? 'desk') === sc
                ? 'bg-accent/10 font-medium text-accent'
                : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
            }`}
          >
            {sc === 'desk' ? 'This desk' : 'Everywhere'}
          </button>
        ))}
        <button
          type="button"
          onClick={onDone}
          data-testid="calendar-filter-done"
          className="widget-nodrag ml-auto rounded bg-[var(--accent)] px-2 py-0.5 font-medium text-white"
        >
          Done
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['task', 'Due dates'],
            ['block', 'Time blocks'],
            ['external', 'Subscribed']
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="widget-nodrag flex items-center gap-1 text-[var(--ink-60)]">
            <input
              type="checkbox"
              checked={sourceEnabled(filter, k)}
              onChange={(e) =>
                set({ sources: { ...(filter.sources ?? {}), [k]: e.target.checked } })
              }
            />
            {label}
          </label>
        ))}
      </div>

      <input
        className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
        placeholder="About… ridge st, auction (commas mean “or”)"
        value={terms(filter.match)}
        onChange={(e) => set({ match: parse(e.target.value) })}
        data-testid="calendar-filter-match"
      />
      <input
        className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1"
        placeholder="But not… draft, internal"
        value={terms(filter.exclude)}
        onChange={(e) => set({ exclude: parse(e.target.value) })}
      />
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <span className="text-[var(--ink-50)]">Tasks</span>
          <select
            className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            value={filter.taskStatus ?? 'open'}
            onChange={(e) => set({ taskStatus: e.target.value as CalendarFilter['taskStatus'] })}
          >
            <option value="open">open only</option>
            <option value="done">done only</option>
            <option value="all">any status</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-1 items-center gap-1">
          <span className="shrink-0 text-[var(--ink-50)]">For</span>
          <input
            className="widget-nodrag min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
            placeholder="anyone"
            value={terms(filter.assignees)}
            onChange={(e) => set({ assignees: parse(e.target.value) })}
          />
        </label>
      </div>
    </div>
  )
}
