import { useMemo, useState } from 'react'
import type { Widget, FbNode, TaskStatus } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
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

interface TaskListContent {
  scope?: Scope
  filter?: Filter
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
  const updateWidget = useWidgetStore((s) => s.update)

  const model = useMemo(() => parse(widget.content), [widget.content])
  const scope: Scope = model.scope ?? 'desk'
  const filter: Filter = model.filter ?? 'open'
  const [draft, setDraft] = useState('')

  const deskId = widget.taskId

  const tasks = useMemo(() => {
    const pool = scope === 'desk' && deskId ? descendantsOf(nodes, deskId) : nodes
    return pool
      .filter((n) => n.kind === 'task' && !n.archived)
      .filter((n) => (filter === 'all' ? true : filter === 'done' ? n.status === DONE : n.status !== DONE))
      .sort((a, b) => {
        // Done sinks; then by due date, soonest first; then by the order they
        // sit in the tree, which is the order the person arranged them in.
        if ((a.status === DONE) !== (b.status === DONE)) return a.status === DONE ? 1 : -1
        const ad = a.dueDate ?? Number.MAX_SAFE_INTEGER
        const bd = b.dueDate ?? Number.MAX_SAFE_INTEGER
        return ad === bd ? a.sortOrder - b.sortOrder : ad - bd
      })
  }, [nodes, scope, filter, deskId])

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
          <button
            onClick={() => setModel({ scope: scope === 'desk' ? 'all' : 'desk' })}
            title={scope === 'desk' ? 'Showing this desk — click for the whole workspace' : 'Showing everything — click for this desk only'}
            className="ml-auto px-2 py-0.5 rounded-full text-[10px] text-[var(--ink-50)] hover:text-[var(--ink-80)] inline-flex items-center gap-1"
          >
            <Icon name={scope === 'desk' ? 'filter_alt' : 'public'} size={11} />
            {scope === 'desk' ? 'This desk' : 'Everywhere'}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto px-1 pb-1">
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
            tasks.map((n) => {
              const d = due(n.dueDate)
              const done = n.status === DONE
              return (
                <div key={n.id} className="group flex items-center gap-2 px-1.5 py-[5px] rounded hover:bg-[var(--surface-sunken)]">
                  <button
                    onClick={() => toggle(n)}
                    aria-label={done ? 'Mark not done' : 'Mark done'}
                    className={`h-[15px] w-[15px] rounded-[4px] shrink-0 inline-flex items-center justify-center border transition-colors ${
                      done ? 'bg-accent border-transparent text-white' : 'border-[var(--ink-30)] hover:border-accent'
                    }`}
                  >
                    {done && <Icon name="check" size={10} />}
                  </button>
                  <button
                    onClick={() => setActiveTask(n.id)}
                    className={`flex-1 min-w-0 text-left text-[12px] truncate ${
                      done ? 'text-[var(--ink-40)] line-through' : 'text-[var(--ink-90)]'
                    }`}
                    title={n.title}
                  >
                    {n.title || 'Untitled'}
                  </button>
                  {d && <span className={`text-[10px] shrink-0 ${done ? 'text-[var(--ink-30)]' : d.tone}`}>{d.label}</span>}
                </div>
              )
            })
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
    </WidgetFrame>
  )
}
