import { useEffect, useMemo, useRef, useState } from 'react'
import type { FbNode } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useViewStore } from '../../stores/view'
import { futuristicPowerOn, taskComplete } from '../../lib/audioBeep'
import { priorityScore, projectPath } from '../../lib/dashboardScope'
import { energyAffinity, energyFitForTask, useEnergyStore } from '../../stores/energy'
import Icon from '../Icon'
import { DashboardHeader, ListRow, PLEXI_CARD, StatusPill } from '../plexi'
import { fieldInputClass } from '../plexi/forms'

type Filter = 'today' | 'overdue' | 'upcoming' | 'open' | 'done'
type Sort = 'smart' | 'energy' | 'due' | 'updated' | 'alpha'

const FILTERS: Array<{ value: Filter; label: string; icon: string }> = [
  { value: 'today', label: 'Today', icon: 'today' },
  { value: 'overdue', label: 'Overdue', icon: 'alarm' },
  { value: 'upcoming', label: 'Upcoming', icon: 'event' },
  { value: 'open', label: 'All open', icon: 'checklist' },
  { value: 'done', label: 'Done', icon: 'check_circle' }
]

// 'energy' kept as a Sort enum value for backward-compat with any persisted state,
// but no longer offered in the dropdown — two-axis model dropped Energy/Interest.
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'smart', label: 'Smart' },
  { value: 'due', label: 'Due date' },
  { value: 'updated', label: 'Recently updated' },
  { value: 'alpha', label: 'Alphabetical' }
]

const MS_PER_DAY = 86_400_000
const ONE_WEEK = 7 * MS_PER_DAY

function endOfTodayMs(): number {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function isOverdue(n: FbNode, now: number): boolean {
  return n.dueDate != null && n.dueDate < now && n.status !== 'done'
}

function isToday(n: FbNode): boolean {
  if (n.dueDate == null) return false
  const dueDay = new Date(n.dueDate)
  const today = new Date()
  return (
    dueDay.getFullYear() === today.getFullYear() &&
    dueDay.getMonth() === today.getMonth() &&
    dueDay.getDate() === today.getDate()
  )
}

function matchesFilter(n: FbNode, filter: Filter, now: number): boolean {
  if (filter === 'done') return n.status === 'done'
  if (n.status === 'done' || n.status === 'parked') return false
  switch (filter) {
    case 'today':
      return n.status === 'in_progress' || isOverdue(n, now) || isToday(n)
    case 'overdue':
      return isOverdue(n, now)
    case 'upcoming':
      return (
        n.dueDate != null &&
        n.dueDate > endOfTodayMs() &&
        n.dueDate <= now + ONE_WEEK
      )
    case 'open':
      return true
    default:
      return true
  }
}

function sortTasks(
  tasks: FbNode[],
  sort: Sort,
  now: number,
  currentEnergy: 'low' | 'medium' | 'high' | null
): FbNode[] {
  const arr = [...tasks]
  switch (sort) {
    case 'smart':
      arr.sort((a, b) => {
        const aOver = isOverdue(a, now)
        const bOver = isOverdue(b, now)
        if (aOver !== bOver) return aOver ? -1 : 1
        const aDue = a.dueDate ?? Number.POSITIVE_INFINITY
        const bDue = b.dueDate ?? Number.POSITIVE_INFINITY
        if (aDue !== bDue) return aDue - bDue
        return priorityScore(b) - priorityScore(a)
      })
      break
    case 'energy':
      // No current energy = fall back to smart. Otherwise rank by affinity, then priority.
      if (!currentEnergy) {
        return sortTasks(tasks, 'smart', now, null)
      }
      arr.sort((a, b) => {
        const aFit = energyAffinity(currentEnergy, energyFitForTask(a))
        const bFit = energyAffinity(currentEnergy, energyFitForTask(b))
        if (aFit !== bFit) return bFit - aFit // higher affinity first
        // Within same affinity bucket, overdue wins, then due date, then priority
        const aOver = isOverdue(a, now)
        const bOver = isOverdue(b, now)
        if (aOver !== bOver) return aOver ? -1 : 1
        const aDue = a.dueDate ?? Number.POSITIVE_INFINITY
        const bDue = b.dueDate ?? Number.POSITIVE_INFINITY
        if (aDue !== bDue) return aDue - bDue
        return priorityScore(b) - priorityScore(a)
      })
      break
    case 'due':
      arr.sort((a, b) => {
        const aDue = a.dueDate ?? Number.POSITIVE_INFINITY
        const bDue = b.dueDate ?? Number.POSITIVE_INFINITY
        return aDue - bDue
      })
      break
    case 'updated':
      arr.sort((a, b) => b.updatedAt - a.updatedAt)
      break
    case 'alpha':
      arr.sort((a, b) => a.title.localeCompare(b.title))
      break
  }
  return arr
}

export default function AllTasksView(): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const updateNode = useNodeStore((s) => s.update)
  const setActive = useNodeStore((s) => s.setActive)
  const startSession = useFocusSessionStore((s) => s.start)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  const currentEnergy = useEnergyStore((s) => s.current)
  const [filter, setFilter] = useState<Filter>('today')
  const [sort, setSort] = useState<Sort>('smart')
  const [search, setSearch] = useState('')
  // Progressive rendering: with years of tasks a flat .map() renders thousands
  // of rows and the view starts to chug (review scale finding). We mount the
  // first chunk and reveal more as the sentinel at the bottom scrolls into
  // view, so the DOM stays small without a windowing dependency. Every task is
  // still reachable by scrolling; nothing is silently capped.
  const CHUNK = 120
  const [renderCap, setRenderCap] = useState(CHUNK)
  const sentinelRef = useRef<HTMLLIElement | null>(null)

  // A new filter/search/sort starts back at the first chunk.
  useEffect(() => {
    setRenderCap(CHUNK)
  }, [filter, sort, search])

  // Reveal the next chunk whenever the sentinel row becomes visible.
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setRenderCap((c) => c + CHUNK)
    })
    io.observe(el)
    return () => io.disconnect()
  })

  const now = Date.now()
  const allTasks = useMemo(() => nodes.filter((n) => n.kind === 'task'), [nodes])

  // Pre-compute counts for filter chips
  const counts = useMemo(() => {
    const c: Record<Filter, number> = {
      today: 0,
      overdue: 0,
      upcoming: 0,
      open: 0,
      done: 0
    }
    for (const t of allTasks) {
      if (matchesFilter(t, 'today', now)) c.today += 1
      if (matchesFilter(t, 'overdue', now)) c.overdue += 1
      if (matchesFilter(t, 'upcoming', now)) c.upcoming += 1
      if (matchesFilter(t, 'open', now)) c.open += 1
      if (matchesFilter(t, 'done', now)) c.done += 1
    }
    return c
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = allTasks.filter((t) => {
      if (!matchesFilter(t, filter, now)) return false
      if (q) {
        const hay = `${t.title} ${t.description}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    return sortTasks(filtered, sort, now, currentEnergy?.level ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTasks, filter, sort, search, currentEnergy?.level])

  function openTask(task: FbNode): void {
    setActive(task.id)
    goTask(task.id)
  }

  function quickStart(task: FbNode): void {
    futuristicPowerOn()
    void startSession(task.id, 5 * 60, '5min')
    if (task.status === 'open') {
      void updateNode(task.id, { status: 'in_progress' })
    }
    setActive(task.id)
    goTask(task.id)
  }

  function markDone(task: FbNode): void {
    void updateNode(task.id, { status: 'done' })
    // taskComplete chime is fired by the node store's update method on the transition,
    // but call it here too in case the chime path misses; harmless duplicate.
    taskComplete()
  }

  return (
    <div className="h-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
        {/* Header */}
        {/* This is the all-TASKS view (view.kind 'all-tasks'). Its header read
            "All Desks — Every desk across every room, flat.", copied from the
            desks view, while the page below it listed tasks with Today /
            Overdue / Upcoming / Done filters and tick-to-complete. */}
        <DashboardHeader title="All Tasks" subtitle="Every task across every desk, in one list." />

        {/* Filter chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => {
            const active = filter === f.value
            const count = counts[f.value]
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full fb-t-label fb-press transition-colors ${
                  active
                    ? 'bg-accent/15 text-accent shadow-[0_0_0_1px_rgb(var(--accent)/0.4)]'
                    : 'bg-[var(--surface-sunken)] shadow-[0_0_0_1px_var(--edge-hairline)] text-[var(--ink-70)] hover:shadow-[0_0_0_1px_var(--edge-firm)]'
                }`}
              >
                <Icon name={f.icon} size={12} filled={active} />
                <span>{f.label}</span>
                <span
                  className={`fb-t-caption font-mono px-1 rounded-[var(--radius-chip)] ${
                    active
                      ? 'bg-accent/20 !text-accent'
                      : 'bg-[var(--surface-base)] text-[var(--ink-60)]'
                  }`}
                >
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Search + sort */}
        <div className="flex items-center gap-2">
          <div className="flex-1 relative">
            <Icon
              name="search"
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-50)]"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search desks…"
              className={`${fieldInputClass()} pl-7`}
            />
          </div>
          {/* The important w-auto stops fieldInputClass's w-full from letting
              the select starve the flex-1 search input beside it. */}
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className={`${fieldInputClass()} !w-auto`}
          >
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                Sort: {s.label}
              </option>
            ))}
          </select>
        </div>

        {/* List */}
        <div className={`${PLEXI_CARD} overflow-hidden`}>
          {visible.length === 0 ? (
            <EmptyState filter={filter} hasSearch={search.trim().length > 0} />
          ) : (
            <ul className="divide-y divide-[var(--edge-soft)]">
              {visible.slice(0, renderCap).map((task, i) => (
                <TaskRow
                  key={task.id}
                  enterDelay={Math.min(i * 25, 250)}
                  task={task}
                  nodes={nodes}
                  onOpen={() => openTask(task)}
                  onQuickStart={() => quickStart(task)}
                  onMarkDone={() => markDone(task)}
                  onOpenProject={(id) => goProject(id)}
                />
              ))}
              {visible.length > renderCap && (
                <li ref={sentinelRef} className="py-3 text-center fb-t-caption">
                  Loading more…
                </li>
              )}
            </ul>
          )}
        </div>

        <div className="fb-t-caption text-center">
          {visible.length} of {counts.open + counts.done} task{visible.length === 1 ? '' : 's'}{' '}
          shown
        </div>
      </div>
    </div>
  )
}

function EmptyState({
  filter,
  hasSearch
}: {
  filter: Filter
  hasSearch: boolean
}): JSX.Element {
  const msg = hasSearch
    ? "Nothing matches your search."
    : filter === 'today'
      ? "Nothing due today, nothing overdue, nothing in progress. You're caught up."
      : filter === 'overdue'
        ? 'Nothing overdue. Sweet.'
        : filter === 'upcoming'
          ? 'Nothing in the next 7 days.'
          : filter === 'done'
            ? 'Nothing completed yet. When you finish tasks they show up here.'
            : 'No open desks yet.'
  const showCreate = !hasSearch && filter !== 'done'
  return (
    <div className="py-10 text-center">
      <Icon name="partly_cloudy_day" size={32} className="text-[var(--ink-30)] mb-2" />
      <p className="fb-t-body text-[var(--ink-70)] leading-relaxed px-6">{msg}</p>
      {showCreate && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('fb:command-new-task'))}
          className="mt-4 inline-flex items-center gap-1.5 h-8 px-3 fb-btn-surface fb-press fb-t-label text-[var(--ink-90)]"
        >
          <Icon name="add" size={14} /> New task
        </button>
      )}
    </div>
  )
}

interface RowProps {
  enterDelay: number
  task: FbNode
  nodes: FbNode[]
  onOpen: () => void
  onQuickStart: () => void
  onMarkDone: () => void
  onOpenProject: (id: string) => void
}

function TaskRow({
  enterDelay,
  task,
  nodes,
  onOpen,
  onQuickStart,
  onMarkDone,
  onOpenProject
}: RowProps): JSX.Element {
  const now = Date.now()
  let dueLabel: string | null = null
  // StatusPill tones: rose family (busy) for overdue, amber (away) for due
  // soon, neutral (offline) otherwise.
  let dueTone: 'busy' | 'away' | 'offline' = 'offline'
  if (task.dueDate != null) {
    const daysLeft = Math.ceil((task.dueDate - now) / MS_PER_DAY)
    if (daysLeft < 0) {
      dueLabel = `${-daysLeft}d late`
      dueTone = 'busy'
    } else if (daysLeft === 0) {
      dueLabel = 'today'
      dueTone = 'away'
    } else if (daysLeft === 1) {
      dueLabel = 'tomorrow'
      dueTone = 'away'
    } else if (daysLeft <= 7) {
      dueLabel = `${daysLeft}d`
    } else {
      dueLabel = new Date(task.dueDate).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric'
      })
    }
  }

  const path = projectPath(nodes, task.id)
  const parentNode = task.parentId ? nodes.find((n) => n.id === task.parentId) : null
  const isDone = task.status === 'done'

  return (
    <ListRow as="li" className="px-4 py-2 group fb-fade-in-up" style={{ animationDelay: `${enterDelay}ms` }}>
      <button
        onClick={onMarkDone}
        disabled={isDone}
        title={isDone ? 'Already done' : 'Mark done'}
        className={`shrink-0 h-5 w-5 inline-flex items-center justify-center rounded-full border fb-press transition-colors ${
          isDone
            ? 'border-emerald-500 bg-emerald-500 text-white cursor-default'
            : task.status === 'in_progress'
              ? 'border-sky-500 text-sky-500 hover:bg-sky-500/10'
              : 'border-[var(--edge-firm)] text-transparent hover:text-[var(--ink-90)] hover:border-[var(--ink-50)]'
        }`}
      >
        <Icon
          name={isDone ? 'check' : task.status === 'in_progress' ? 'play_arrow' : 'check'}
          size={11}
          filled={isDone}
        />
      </button>
      <div className="flex-1 min-w-0">
        <button
          onClick={onOpen}
          className={`fb-t-body text-left truncate w-full ${
            isDone
              ? 'line-through text-[var(--ink-50)]'
              : 'text-[var(--ink-100)] hover:text-accent'
          }`}
        >
          {task.title}
        </button>
        {path.length > 0 && (
          <div className="fb-t-caption text-[var(--ink-70)] truncate flex items-center gap-0.5 mt-0.5">
            {path.map((segment, i) => (
              <span key={i} className="flex items-center gap-0.5">
                {i > 0 && <Icon name="chevron_right" size={10} />}
                <button
                  onClick={() => {
                    // Last segment = immediate parent (always); open that project's dashboard
                    if (i === path.length - 1 && parentNode) onOpenProject(parentNode.id)
                  }}
                  className={i === path.length - 1 ? 'hover:text-[var(--ink-90)]' : ''}
                >
                  {segment}
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      {dueLabel && (
        <span
          className="shrink-0"
          title={task.dueDate ? `Due ${new Date(task.dueDate).toLocaleDateString()}` : ''}
        >
          <StatusPill tone={dueTone} label={dueLabel} />
        </span>
      )}
      <AxisDots task={task} />
      {!isDone && (
        <button
          onClick={onQuickStart}
          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent fb-t-caption !text-white font-medium fb-press transition-all shrink-0"
          title="Start a 5-minute focus session on this task"
        >
          <Icon name="bolt" size={11} />
          <span>5 min</span>
        </button>
      )}
    </ListRow>
  )
}

function AxisDots({ task }: { task: FbNode }): JSX.Element {
  const dots = (val: number): JSX.Element => (
    <div className="flex gap-[1px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`w-1 h-1 rounded-full ${
            i <= val ? 'bg-[var(--ink-70)]' : 'bg-[var(--ink-10)]'
          }`}
        />
      ))}
    </div>
  )
  return (
    <div
      className="hidden md:flex items-center gap-2 shrink-0 text-[var(--ink-50)]"
      title={`Urgency ${task.priority} · Importance ${task.importance}`}
    >
      <div className="flex items-center gap-0.5">
        <Icon name="priority_high" size={10} />
        {dots(task.priority)}
      </div>
      <div className="flex items-center gap-0.5">
        <Icon name="flag" size={10} />
        {dots(task.importance)}
      </div>
    </div>
  )
}
