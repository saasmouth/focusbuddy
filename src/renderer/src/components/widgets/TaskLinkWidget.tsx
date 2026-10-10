import { useMemo, useState } from 'react'
import type { Widget } from '@shared/types'
import { useNodeStore } from '../../stores/nodes'
import { useWidgetStore } from '../../stores/widgets'
import { useFocusSessionStore } from '../../stores/focusSession'
import { useViewStore } from '../../stores/view'
import { futuristicPowerOn } from '../../lib/audioBeep'
import { projectPath } from '../../lib/dashboardScope'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'

interface Props {
  widget: Widget
  inline?: boolean
}

// A reference to another task — created by dragging a task from the sidebar onto a canvas.
// Stores the referenced task id in `widget.content`. Renders the task's title, project path,
// status icon, due chip, and a one-click "Just 5 min" / "Open" pair.
export default function TaskLinkWidget({ widget, inline = false }: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const setActive = useNodeStore((s) => s.setActive)
  const updateNode = useNodeStore((s) => s.update)
  const startSession = useFocusSessionStore((s) => s.start)
  const goTask = useViewStore((s) => s.goTask)
  const updateWidget = useWidgetStore((st) => st.update)
  const [query, setQuery] = useState('')

  const targetId = widget.content.trim()
  const task = targetId ? nodes.find((n) => n.id === targetId && n.kind === 'task') ?? null : null

  function openTarget(): void {
    if (!task) return
    setActive(task.id)
    goTask(task.id)
  }

  function fivePromise(): void {
    if (!task) return
    futuristicPowerOn()
    void startSession(task.id, 5 * 60, '5min')
    if (task.status === 'open') void updateNode(task.id, { status: 'in_progress' })
    setActive(task.id)
    goTask(task.id)
  }

  // Every desk, newest first, minus this widget's own desk — pointing a desk
  // at itself is a loop with nothing to show.
  const desks = useMemo(
    () => nodes.filter((n) => n.kind === 'task' && n.id !== widget.taskId),
    [nodes, widget.taskId]
  )
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q ? desks.filter((d) => (d.title || '').toLowerCase().includes(q)) : desks
    // Bounded: a long list in a small widget is not a picker, it is a wall.
    return matching.slice(0, 50)
  }, [desks, query])

  const path = task ? projectPath(nodes, task.id) : []

  const body = (
    <div className="min-h-full w-full flex flex-col bg-[var(--surface-raised)] p-3 gap-1.5">
      {task ? (
        <>
          <div className="flex items-center gap-2">
            <Icon
              name={task.status === 'in_progress' ? 'play_arrow' : 'task_alt'}
              size={14}
              filled={task.status === 'in_progress'}
              className={
                task.status === 'done'
                  ? 'text-emerald-700'
                  : task.status === 'in_progress'
                    ? 'text-blue-700 dark:text-blue-400'
                    : 'text-[var(--ink-50)]'
              }
            />
            <button
              onClick={openTarget}
              className={`text-sm font-medium text-left truncate flex-1 ${
                task.status === 'done'
                  ? 'line-through text-[var(--ink-40)]'
                  : 'text-[var(--ink-100)] hover:text-accent'
              }`}
              title="Open this task"
            >
              {task.title}
            </button>
          </div>
          {path.length > 0 && (
            <div className="text-[10px] text-[var(--ink-50)] truncate flex items-center gap-0.5">
              {path.map((segment, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  {i > 0 && <Icon name="chevron_right" size={9} />}
                  <span>{segment}</span>
                </span>
              ))}
            </div>
          )}
          {task.dueDate != null && (() => {
            const daysLeft = Math.ceil((task.dueDate - Date.now()) / 86_400_000)
            const overdue = daysLeft < 0
            const cls = overdue
              ? 'bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-400'
              : daysLeft <= 1
                ? 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400'
                : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
            const label =
              daysLeft === 0
                ? 'due today'
                : daysLeft === 1
                  ? 'due tomorrow'
                  : overdue
                    ? `${-daysLeft}d late`
                    : `due in ${daysLeft}d`
            return (
              <span
                className={`self-start text-[10px] font-mono px-1.5 py-0.5 rounded ${cls}`}
              >
                {label}
              </span>
            )
          })()}
          <div className="flex items-center gap-1.5 mt-auto pt-1">
            <button
              onClick={fivePromise}
              disabled={task.status === 'done'}
              className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-white transition-all hover:brightness-110 disabled:opacity-50"
              style={{ backgroundColor: 'rgb(var(--accent))' }}
              title="Start a 5-minute focus session on this task"
            >
              <Icon name="bolt" size={11} />
              <span>5 min</span>
            </button>
            <button
              onClick={openTarget}
              className="fb-btn-surface inline-flex items-center justify-center gap-1 px-2 py-1 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] transition-colors"
              title="Open this task"
            >
              <Icon name="arrow_forward" size={11} />
              <span>Open</span>
            </button>
          </div>
        </>
      ) : targetId ? (
        // It HAD a target and the target is gone. Only now is this message true.
        <div className="flex flex-col items-center justify-center h-full text-center gap-1">
          <Icon name="link_off" size={20} className="text-[var(--ink-40)]" />
          <p className="text-[11px] text-[var(--ink-50)]">
            Referenced desk was deleted or moved.
          </p>
          <button
            onClick={() => void updateWidget(widget.id, { content: '' })}
            className="mt-1 text-[11px] text-accent hover:underline"
            data-testid="task-link-rechoose"
          >
            Point it somewhere else
          </button>
        </div>
      ) : (
        // NEVER had one. This widget used to claim the desk "was deleted or
        // moved" the moment it was added, which was simply untrue, and offered
        // no way to set a target — so a task-link could only ever be created
        // by dragging a desk onto the canvas, and was a dead end otherwise.
        <div className="flex flex-col h-full gap-1.5" data-testid="task-link-picker">
          <p className="text-[11px] text-[var(--ink-50)] shrink-0">
            Which desk should this point at?
          </p>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search desks…"
            data-testid="task-link-search"
            className="shrink-0 w-full rounded-md border border-[var(--edge-soft)] bg-[var(--surface-base)] px-2 py-1 text-[11px]"
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {candidates.length === 0 ? (
              <p className="text-[11px] text-[var(--ink-40)] py-2">
                {desks.length === 0 ? 'No desks yet.' : 'No desk matches that.'}
              </p>
            ) : (
              candidates.map((d) => (
                <button
                  key={d.id}
                  onClick={() => void updateWidget(widget.id, { content: d.id })}
                  data-testid={`task-link-option-${d.id}`}
                  className="w-full text-left px-2 py-1 rounded text-[11.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] truncate"
                  title={d.title || 'Untitled desk'}
                >
                  {d.title || 'Untitled desk'}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame widget={widget} headerLabel="task link" headerAccent="bg-stone-200/70 dark:bg-white/[0.07]">
      {body}
    </WidgetFrame>
  )
}
