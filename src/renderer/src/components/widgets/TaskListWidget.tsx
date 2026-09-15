import { useEffect, useMemo, useState } from 'react'
import { useViewStore } from '../../stores/view'
import TaskOpenChoice from './TaskOpenChoice'
import {
  QUEUE_ORDER,
  QUEUE_LABEL,
  QUEUE_ICON,
  QUEUE_COLOR,
  CLASS_CHOICES,
  PRIMARY_ACTION,
  queueOf,
  rankScore,
  itemReason,
  queueTint
} from '../../lib/attentionQueues'
import { asAttentionItem } from '@shared/attentionProjection'
import TaskTable from './TaskTable'
import type { Widget, FbNode, TaskStatus } from '@shared/types'
import { parseAttachments, derivedStart } from '@shared/taskPlanning'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import TaskDetail, { STATUSES } from './TaskDetail'
import { useNodeStore } from '../../stores/nodes'
import { useWidgetStore } from '../../stores/widgets'

// The desk's own tasks, on the desk.
//
// This is the one widget in the "desk as a lens" idea that needs no new
// storage: a desk is a node, tasks filed under it are its children, and that
// relationship already exists and already syncs. Everything else people want
// scoped to a desk -- the mail about it, the people on it -- has no such link
// today, and inventing one per widget is how you end up with four disagreeing
// notions of "related to this desk".
//
// Scope is a choice, not an assumption. A desk's own tasks is the default; the
// whole workspace is one click away, because the useful question is often "what
// else is waiting" and a widget that refuses to answer it sends you elsewhere.

type Scope = 'desk' | 'all'
type Filter = 'open' | 'done' | 'all'

type ViewMode = 'list' | 'table'
type GroupMode = 'none' | 'queue' | 'due'

interface TaskListContent {
  scope?: Scope
  filter?: Filter
  /** List reads as a to-do; table shows every planning field at once. */
  view?: ViewMode
  /** How rows are gathered. Attention's queues, its due bands, or flat. */
  group?: GroupMode
  /** Most-pressing-first, using Attention's own ranker. */
  ranked?: boolean
  /** Task ids whose detail panel is open, so it survives a re-render. */
  expanded?: string[]
}

function parse(raw: string | null | undefined): TaskListContent {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as TaskListContent
  } catch {
    return {}
  }
}

/** Descendants of a desk, breadth-first, so nesting does not hide a task. */
function descendantsOf(nodes: readonly FbNode[], rootId: string): FbNode[] {
  const byParent = new Map<string | null, FbNode[]>()
  for (const n of nodes) {
    const list = byParent.get(n.parentId) ?? []
    list.push(n)
    byParent.set(n.parentId, list)
  }
  const out: FbNode[] = []
  const queue = [...(byParent.get(rootId) ?? [])]
  while (queue.length) {
    const n = queue.shift()!
    out.push(n)
    queue.push(...(byParent.get(n.id) ?? []))
  }
  return out
}

const DONE: TaskStatus = 'done'

export default function TaskListWidget({ widget }: { widget: Widget }): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const updateNode = useNodeStore((s) => s.update)
  const createNode = useNodeStore((s) => s.create)
  const setActiveTask = useNodeStore((s) => s.setActive)
  // Queue and snooze are written through the work-item path (one record, two
  // lenses), which the node store does not observe — so it is told to re-read.
  const refreshNodes = useNodeStore((s) => s.refresh)
  const updateWidget = useWidgetStore((s) => s.update)

  const model = useMemo(() => parse(widget.content), [widget.content])
  const scope: Scope = model.scope ?? 'desk'
  const filter: Filter = model.filter ?? 'open'
  const [draft, setDraft] = useState('')
  // Which tasks actually have a canvas behind them.
  //
  // A task and a desk are the same node kind, so "does this have a desk" is not
  // a flag to read -- it is whether anything was ever put on it. Widgets are
  // that answer, and asking the question only when the answer is yes is what
  // keeps the chooser from becoming a dialog people click through.
  const [widgetCounts, setWidgetCounts] = useState<Record<string, number>>({})
  const [choosing, setChoosing] = useState<FbNode | null>(null)

  const view: ViewMode = model.view ?? 'list'
  const group: GroupMode = model.group ?? 'none'
  const ranked = model.ranked ?? false
  const nowMs = Date.now()
  const expanded = useMemo(() => new Set(model.expanded ?? []), [model.expanded])
  const toggleExpanded = (id: string): void => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setModel({ expanded: [...next] })
  }

  const deskId = widget.taskId

  // Subtasks belong under their parent, not loose in the list -- otherwise a
  // task broken into six steps reads as seven unrelated tasks.
  const childrenOf = useMemo(() => {
    const m = new Map<string, FbNode[]>()
    for (const n of nodes) {
      if (n.kind !== 'task' || n.archived || !n.parentId) continue
      const list = m.get(n.parentId)
      if (list) list.push(n)
      else m.set(n.parentId, [n])
    }
    for (const list of m.values()) list.sort((a, b) => a.sortOrder - b.sortOrder)
    return m
  }, [nodes])

  const tasks = useMemo(() => {
    const pool = scope === 'desk' && deskId ? descendantsOf(nodes, deskId) : nodes
    return pool
      .filter((n) => n.kind === 'task' && !n.archived)
      // Which of these is a SUBTASK rather than a task in its own right?
      //
      // A desk and a task are the same node kind here -- a desk is just a task
      // you have opened as a canvas -- so "my parent is a task, therefore I am
      // a subtask" would swallow every task on the desk, the desk being their
      // parent. The boundary is the desk root: its own children are the list,
      // and anything deeper is a subtask of the row above it.
      .filter((n) => {
        if (!n.parentId) return true
        if (n.parentId === deskId) return true
        const parent = nodes.find((p) => p.id === n.parentId)
        return !parent || parent.kind !== 'task'
      })
      .filter((n) => (filter === 'all' ? true : filter === 'done' ? n.status === DONE : n.status !== DONE))
      // A snoozed task is one somebody deliberately put down until a date. It
      // comes back on its own; until then it is not "outstanding", and showing
      // it anyway makes snoozing pointless.
      .filter((n) => filter === 'all' || !n.snoozeUntil || n.snoozeUntil <= nowMs)
      .sort((a, b) => {
        // Done sinks either way.
        if ((a.status === DONE) !== (b.status === DONE)) return a.status === DONE ? 1 : -1
        if (ranked) {
          // Attention's own ranker, on the same projection Attention reads, so
          // a task does not lead here and trail there.
          return rankScore(asAttentionItem(b), nowMs) - rankScore(asAttentionItem(a), nowMs)
        }
        // Otherwise by due date, soonest first; then by the order they sit in
        // the tree, which is the order the person arranged them in.
        const ad = a.dueDate ?? Number.MAX_SAFE_INTEGER
        const bd = b.dueDate ?? Number.MAX_SAFE_INTEGER
        return ad === bd ? a.sortOrder - b.sortOrder : ad - bd
      })
  }, [nodes, scope, filter, deskId, ranked, nowMs])

  /** Rows gathered into sections, or one unnamed section when flat. */
  const sections = useMemo((): Array<{ key: string; label: string; icon?: string; items: FbNode[] }> => {
    if (group === 'queue') {
      const by = new Map<string, FbNode[]>()
      for (const n of tasks) {
        const q = queueOf(asAttentionItem(n))
        const list = by.get(q)
        if (list) list.push(n)
        else by.set(q, [n])
      }
      // QUEUE_ORDER, not insertion order: the queues have a deliberate reading
      // order and shuffling it per desk would make them unlearnable.
      return QUEUE_ORDER.filter((q) => by.has(q)).map((q) => ({
        key: q,
        label: QUEUE_LABEL[q] ?? q,
        icon: QUEUE_ICON[q],
        items: by.get(q) as FbNode[]
      }))
    }
    if (group === 'due') {
      const band = (n: FbNode): { k: string; label: string; order: number } => {
        if (!n.dueDate) return { k: 'none', label: 'No date', order: 5 }
        const days = Math.ceil((n.dueDate - nowMs) / 86_400_000)
        if (days < 0) return { k: 'overdue', label: 'Overdue', order: 0 }
        if (days === 0) return { k: 'today', label: 'Today', order: 1 }
        if (days === 1) return { k: 'tomorrow', label: 'Tomorrow', order: 2 }
        if (days <= 7) return { k: 'week', label: 'This week', order: 3 }
        return { k: 'later', label: 'Later', order: 4 }
      }
      const by = new Map<string, { label: string; order: number; items: FbNode[] }>()
      for (const n of tasks) {
        const b = band(n)
        const e = by.get(b.k)
        if (e) e.items.push(n)
        else by.set(b.k, { label: b.label, order: b.order, items: [n] })
      }
      return [...by.entries()]
        .sort((a, b) => a[1].order - b[1].order)
        .map(([k, v]) => ({ key: k, label: v.label, items: v.items }))
    }
    return [{ key: 'all', label: '', items: [...tasks] }]
  }, [tasks, group, nowMs])

  // Refreshed whenever the visible set changes: a task that just gained a desk
  // must start asking, and one whose widgets were all removed must stop.
  const taskIdsKey = tasks.map((t) => t.id).join(',')
  useEffect(() => {
    const ids = taskIdsKey ? taskIdsKey.split(',') : []
    if (ids.length === 0) {
      setWidgetCounts({})
      return
    }
    let alive = true
    const api = (window as unknown as { api?: { widgets?: Record<string, any> } }).api
    void api?.widgets
      ?.countsByTask?.(ids)
      .then((c: Record<string, number>) => {
        if (alive) setWidgetCounts(c ?? {})
      })
      .catch(() => {
        // Unknown counts mean no chooser rather than a chooser on everything:
        // a question asked wrongly is worse than one not asked.
        if (alive) setWidgetCounts({})
      })
    return () => {
      alive = false
    }
  }, [taskIdsKey])

  /**
   * What a click on a task means.
   *
   * With no desk behind it there is nothing to choose between, so it opens in
   * place. With one, the app asks rather than silently navigating away from the
   * desk somebody is working on.
   */
  const openTask = (n: FbNode): void => {
    if ((widgetCounts[n.id] ?? 0) > 0) {
      setChoosing(n)
      return
    }
    toggleExpanded(n.id)
  }

  const setModel = (patch: TaskListContent): void => {
    void updateWidget(widget.id, { content: JSON.stringify({ ...model, ...patch }) })
  }

  const add = async (): Promise<void> => {
    const title = draft.trim()
    if (!title || !deskId) return
    setDraft('')
    await createNode({ parentId: deskId, kind: 'task', title })
  }

  const toggle = (n: FbNode): void => {
    void updateNode(n.id, { status: n.status === DONE ? 'open' : DONE })
  }

  /** What "done" is called for this task's queue: Reviewed, Decided, Answered… */
  const closeVerb = (n: FbNode): string =>
    PRIMARY_ACTION[queueOf(asAttentionItem(n))]?.label ?? 'Done'

  const setQueue = (n: FbNode, intentClass: string): void => {
    const api = (window as unknown as { api?: { workItems?: Record<string, any> } }).api
    void api?.workItems?.reclassify?.(n.id, intentClass).then(() => refreshNodes())
  }

  const snooze = (n: FbNode, days: number | null): void => {
    const api = (window as unknown as { api?: { workItems?: Record<string, any> } }).api
    const until = days === null ? null : nowMs + days * 86_400_000
    void api?.workItems?.snooze?.(n.id, until).then(() => refreshNodes())
  }

  const due = (ms: number | null | undefined): { label: string; tone: string } | null => {
    if (!ms) return null
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const d = new Date(ms); d.setHours(0, 0, 0, 0)
    const days = Math.round((d.getTime() - today.getTime()) / 86_400_000)
    if (days < 0) return { label: days === -1 ? 'Yesterday' : `${Math.abs(days)}d overdue`, tone: 'text-rose-600' }
    if (days === 0) return { label: 'Today', tone: 'text-rose-600' }
    if (days === 1) return { label: 'Tomorrow', tone: 'text-amber-600' }
    if (days < 7) return { label: d.toLocaleDateString(undefined, { weekday: 'short' }), tone: 'text-[var(--ink-50)]' }
    return { label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), tone: 'text-[var(--ink-50)]' }
  }

  const TABS: Array<[Filter, string]> = [['open', 'Active'], ['done', 'Done'], ['all', 'All']]

  return (
    <WidgetFrame widget={widget} headerLabel="Tasks" headerAccent="bg-emerald-200/50 dark:bg-emerald-400/10">
      <div className="h-full w-full flex flex-col bg-[var(--surface-raised)]">
        <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
          {TABS.map(([f, label]) => (
            <button
              key={f}
              onClick={() => setModel({ filter: f })}
              className={`px-2 py-0.5 rounded-full text-[11px] transition-colors ${
                f === filter ? 'bg-accent/10 text-accent font-medium' : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
              }`}
            >
              {label}
            </button>
          ))}
          <select
            value={group}
            onChange={(e) => setModel({ group: e.target.value as GroupMode })}
            title="How rows are gathered"
            data-testid="task-group"
            className="ml-auto rounded bg-transparent px-1 py-0.5 text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-80)]"
          >
            <option value="none">Flat</option>
            <option value="queue">By queue</option>
            <option value="due">By when</option>
          </select>
          <button
            onClick={() => setModel({ ranked: !ranked })}
            title={ranked ? 'Most pressing first' : 'By due date'}
            data-testid="task-rank"
            className={`px-1.5 py-0.5 rounded text-[10px] inline-flex items-center gap-1 ${
              ranked ? 'text-accent' : 'text-[var(--ink-50)] hover:text-[var(--ink-80)]'
            }`}
          >
            <Icon name="sort" size={11} />
            {ranked ? 'Ranked' : 'Sort'}
          </button>
          <button
            onClick={() => setModel({ view: view === 'list' ? 'table' : 'list' })}
            title={view === 'list' ? 'Show every field as a table' : 'Back to the list'}
            data-testid="task-view-toggle"
            className="px-1.5 py-0.5 rounded text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-80)] inline-flex items-center gap-1"
          >
            <Icon name={view === 'list' ? 'table_rows' : 'list'} size={11} />
            {view === 'list' ? 'Table' : 'List'}
          </button>
          <button
            onClick={() => setModel({ scope: scope === 'desk' ? 'all' : 'desk' })}
            title={scope === 'desk' ? 'Showing this desk — click for the whole workspace' : 'Showing everything — click for this desk only'}
            className="px-2 py-0.5 rounded-full text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-80)] inline-flex items-center gap-1"
          >
            <Icon name={scope === 'desk' ? 'filter_alt' : 'public'} size={11} />
            {scope === 'desk' ? 'This desk' : 'Everywhere'}
          </button>
        </div>

        {view === 'table' && tasks.length > 0 ? (
          <TaskTable
            tasks={tasks}
            nodes={nodes}
            childrenOf={childrenOf}
            onPatch={(id, p) => void updateNode(id, p)}
            onOpen={(id) => toggleExpanded(id)}
          />
        ) : null}

        <div
          className={`flex-1 min-h-0 overflow-auto px-1 pb-1 ${
            view === 'table' && tasks.length > 0 ? 'hidden' : ''
          }`}
        >
          {tasks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-1 text-center px-4">
              <Icon name="task_alt" size={18} className="text-[var(--ink-40)]" />
              <div className="fb-t-caption text-[var(--ink-60)]">
                {filter === 'done' ? 'Nothing finished yet' : 'Nothing outstanding'}
              </div>
              {scope === 'desk' && (
                <div className="text-[10px] text-[var(--ink-40)]">Tasks filed under this desk appear here.</div>
              )}
            </div>
          ) : (
            sections.map((sec) => (
             <div key={sec.key}>
              {sec.label && (
                <div
                  className="flex items-center gap-1 px-1.5 pt-2 pb-0.5 text-[9px] font-medium uppercase tracking-wide text-[var(--ink-40)]"
                  style={
                    group === 'queue'
                      ? { color: QUEUE_COLOR[sec.key] ?? 'var(--ink-40)' }
                      : undefined
                  }
                >
                  {sec.icon && <Icon name={sec.icon} size={10} />}
                  {sec.label}
                  <span className="ml-auto tabular-nums text-[var(--ink-35)]">
                    {sec.items.length}
                  </span>
                </div>
              )}
              {sec.items.map((n) => {
              const subs = childrenOf.get(n.id) ?? []
              const projected = asAttentionItem(n)
              const queue = queueOf(projected)
              const reason = itemReason(projected, nowMs)
              const isOpen = expanded.has(n.id)
              const done = n.status === DONE
              // The row shows the start when it is known, because a task that
              // cannot begin for three weeks is not the same as one due then.
              const predecessor = n.dependsOn ? nodes.find((p) => p.id === n.dependsOn) ?? null : null
              const start = derivedStart(n, predecessor?.dueDate ?? null)
              const d = due(n.dueDate)
              const atts = parseAttachments(n.attachmentsJson).length
              const statusMeta = STATUSES.find((st) => st.value === n.status)
              const subsDone = subs.filter((c) => c.status === DONE).length
              return (
                <div key={n.id} className="rounded">
                  <div className="group flex items-center gap-1.5 px-1.5 py-[5px] rounded hover:bg-[var(--surface-sunken)]">
                    <button
                      onClick={() => toggle(n)}
                      aria-label={done ? 'Mark not done' : closeVerb(n)}
                      // The queue's own closing word. "Done" is wrong for a
                      // decision or a reply, and a verb that does not match the
                      // work makes the tick feel like the wrong button.
                      title={done ? 'Reopen' : closeVerb(n)}
                      className={`h-[15px] w-[15px] rounded-[4px] shrink-0 inline-flex items-center justify-center border transition-colors ${
                        done ? 'bg-accent border-transparent text-white' : 'border-[var(--ink-30)] hover:border-accent'
                      }`}
                    >
                      {done && <Icon name="check" size={10} />}
                    </button>
                    <button
                      onClick={() => openTask(n)}
                      className={`flex-1 min-w-0 text-left text-[12px] truncate ${
                        done ? 'text-[var(--ink-40)] line-through' : 'text-[var(--ink-90)]'
                      }`}
                      title={`${n.title} — click for dates, subtasks and attachments`}
                    >
                      {n.title || 'Untitled'}
                    </button>

                    {/* Why this is surfacing, in Attention's own words. */}
                    {!done && reason && (
                      <span
                        className={`shrink-0 text-[9px] ${
                          reason === 'Past due' || reason === 'Due today'
                            ? 'text-rose-600'
                            : 'text-[var(--ink-45)]'
                        }`}
                      >
                        {reason}
                      </span>
                    )}
                    {n.snoozeUntil && n.snoozeUntil > nowMs && (
                      <span
                        className="shrink-0 text-[9px] text-[var(--ink-40)]"
                        title={`Snoozed until ${new Date(n.snoozeUntil).toLocaleDateString()}`}
                      >
                        <Icon name="bedtime" size={10} />
                      </span>
                    )}
                    {group !== 'queue' && queue !== 'to_do' && (
                      <span
                        className="shrink-0 rounded-full px-1.5 text-[9px]"
                        style={{
                          backgroundColor: queueTint(QUEUE_COLOR[queue] ?? '#64748b', 0.16),
                          color: QUEUE_COLOR[queue] ?? 'var(--ink-60)'
                        }}
                        title={QUEUE_LABEL[queue]}
                      >
                        {QUEUE_LABEL[queue]}
                      </span>
                    )}

                    {/* At-a-glance facts, each only shown when it exists. An
                        always-present row of dashes reads as missing data. */}
                    {n.assignee && (
                      <span
                        className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-1.5 text-[9px] text-[var(--ink-60)]"
                        title={`Assigned to ${n.assignee}`}
                      >
                        {n.assignee.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('')}
                      </span>
                    )}
                    {atts > 0 && (
                      <span className="shrink-0 inline-flex items-center text-[9px] text-[var(--ink-40)]" title={`${atts} attachment${atts === 1 ? '' : 's'}`}>
                        <Icon name="attach_file" size={10} />
                        {atts}
                      </span>
                    )}
                    {subs.length > 0 && (
                      <span className="shrink-0 text-[9px] tabular-nums text-[var(--ink-40)]" title={`${subsDone} of ${subs.length} subtasks done`}>
                        {subsDone}/{subs.length}
                      </span>
                    )}
                    {!done && statusMeta && n.status !== 'open' && (
                      <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${statusMeta.dot}`} title={statusMeta.label} />
                    )}
                    {start && !done && (
                      <span className="shrink-0 text-[9px] text-[var(--ink-40)]" title="Starts">
                        {new Date(start).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} →
                      </span>
                    )}
                    {d && <span className={`text-[10px] shrink-0 ${done ? 'text-[var(--ink-30)]' : d.tone}`}>{d.label}</span>}
                    <button
                      onClick={() => toggleExpanded(n.id)}
                      aria-label={isOpen ? 'Hide details' : 'Show details'}
                      title={isOpen ? 'Hide details' : 'Show details'}
                      data-testid="task-expand"
                      className={`shrink-0 rounded transition-colors hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)] ${
                        isOpen ? 'text-[var(--accent)]' : 'text-[var(--ink-40)]'
                      }`}
                    >
                      <Icon name={isOpen ? 'expand_less' : 'expand_more'} size={13} />
                    </button>
                  </div>
                  {isOpen && (
                    <div className="flex flex-wrap items-center gap-1 border-t border-[color:var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_40%,transparent)] px-2 pt-1.5 text-[10px]">
                      <span className="text-[var(--ink-45)]">Queue</span>
                      <select
                        className="widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5"
                        value={queue}
                        onChange={(e) => setQueue(n, e.target.value)}
                        data-testid="task-queue"
                        title="What this task is actually for — it sets the closing verb too"
                      >
                        {CLASS_CHOICES.map((c) => (
                          <option key={c.value} value={c.value}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <span className="ml-2 text-[var(--ink-45)]">Snooze</span>
                      {([['1d', 1], ['3d', 3], ['1w', 7]] as const).map(([label, days]) => (
                        <button
                          key={label}
                          type="button"
                          className="widget-nodrag rounded border border-[var(--line)] px-1.5 py-0.5 text-[var(--ink-60)] hover:bg-[var(--surface-sunken)]"
                          onClick={() => snooze(n, days)}
                          title={`Put this down for ${label}; it comes back on its own`}
                        >
                          {label}
                        </button>
                      ))}
                      {n.snoozeUntil && (
                        <button
                          type="button"
                          className="widget-nodrag rounded px-1.5 py-0.5 text-[var(--ink-50)] hover:text-[var(--ink-90)]"
                          onClick={() => snooze(n, null)}
                        >
                          Wake now
                        </button>
                      )}
                      {/* A desk exists because somebody asked for one. Until
                          then this task is a task, and clicking it opens it
                          here rather than taking you somewhere else. */}
                      <button
                        type="button"
                        className="widget-nodrag ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
                        data-testid="task-make-desk"
                        onClick={() => useViewStore.getState().goTask(n.id)}
                        title={
                          (widgetCounts[n.id] ?? 0) > 0
                            ? 'Open this task’s desk'
                            : 'Open this task as a desk and start putting things on it'
                        }
                      >
                        <Icon name="space_dashboard" size={11} />
                        {(widgetCounts[n.id] ?? 0) > 0 ? 'Its desk' : 'Give it a desk'}
                      </button>
                    </div>
                  )}
                  {isOpen && (
                    <TaskDetail
                      task={n}
                      siblings={tasks}
                      subtasks={subs}
                      onPatch={(id, p) => void updateNode(id, p)}
                      onAddSubtask={(parentId, title) => void createNode({ parentId, kind: 'task', title })}
                      onOpenTask={(id) => setActiveTask(id)}
                    />
                  )}
                </div>
              )
              })}
             </div>
            ))
          )}
        </div>

        {deskId && (
          <div className="border-t border-[color:var(--edge-soft)] px-2 py-1.5 flex items-center gap-1.5">
            <Icon name="add" size={13} className="text-[var(--ink-40)] shrink-0" />
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
              placeholder="Add a task to this desk"
              className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[var(--ink-90)] placeholder:text-[var(--ink-40)]"
            />
          </div>
        )}
      </div>

      {choosing && (
        <TaskOpenChoice
          task={choosing}
          widgetCount={widgetCounts[choosing.id] ?? 0}
          onOpenHere={() => {
            toggleExpanded(choosing.id)
            setChoosing(null)
          }}
          onGoToDesk={() => {
            // Through the VIEW store, not setActive: an effect syncs
            // activeTaskId FROM the current view, so setting it directly is
            // overwritten on the next render and nothing appears to happen.
            useViewStore.getState().goTask(choosing.id)
            setChoosing(null)
          }}
          onClose={() => setChoosing(null)}
        />
      )}
    </WidgetFrame>
  )
}
