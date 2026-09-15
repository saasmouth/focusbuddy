import type { FbNode, TaskStatus } from '@shared/types'
import { parseAttachments, derivedStart, durationDays } from '@shared/taskPlanning'
import Icon from '../Icon'
import { STATUSES, toDateInput, fromDateInput } from './TaskDetail'

// Every field at once.
//
// The list view answers "what is outstanding"; this answers "is the plan
// coherent" -- which you cannot see one expanded row at a time, because the
// question is about the relationships BETWEEN rows: what waits on what, whether
// two things are booked over each other, who has everything.
//
// Editable in place, because a planning grid you have to leave to change is a
// report, and a report is what people export to a spreadsheet instead.

export interface TaskTableProps {
  tasks: readonly FbNode[]
  /** All nodes, so a dependency can be named and a subtask counted. */
  nodes: readonly FbNode[]
  childrenOf: Map<string, FbNode[]>
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onOpen: (id: string) => void
}

const DONE: TaskStatus = 'done'

export default function TaskTable({
  tasks,
  nodes,
  childrenOf,
  onPatch,
  onOpen
}: TaskTableProps): JSX.Element {
  const titleOf = (id: string | null | undefined): string =>
    id ? (nodes.find((n) => n.id === id)?.title ?? '—') : '—'

  return (
    // The grid scrolls inside itself: a widget that makes the whole desk scroll
    // sideways is worse than one with a scrollbar.
    <div className="min-h-0 flex-1 overflow-auto" data-testid="task-table">
      <table className="w-full border-collapse text-[11px]">
        <thead className="sticky top-0 z-10 bg-[var(--surface-raised)]">
          <tr className="text-left text-[9px] uppercase tracking-wide text-[var(--ink-40)]">
            <th className="px-1.5 py-1 font-medium">Task</th>
            <th className="px-1.5 py-1 font-medium">Status</th>
            <th className="px-1.5 py-1 font-medium">Who</th>
            <th className="px-1.5 py-1 font-medium">Start</th>
            <th className="px-1.5 py-1 font-medium">Due</th>
            <th className="px-1.5 py-1 text-right font-medium">Days</th>
            <th className="px-1.5 py-1 font-medium">Waits for</th>
            <th className="px-1.5 py-1 text-right font-medium">Lag</th>
            <th className="px-1.5 py-1 text-right font-medium">Sub</th>
            <th className="px-1.5 py-1 text-right font-medium">Files</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((n) => {
            const predecessor = n.dependsOn
              ? (nodes.find((p) => p.id === n.dependsOn) ?? null)
              : null
            const start = derivedStart(n, predecessor?.dueDate ?? null)
            const days = durationDays(start, n.dueDate ?? null)
            const subs = childrenOf.get(n.id) ?? []
            const subsDone = subs.filter((c) => c.status === DONE).length
            const atts = parseAttachments(n.attachmentsJson).length
            const done = n.status === DONE
            // A start that came from a dependency is marked, so a date nobody
            // typed is not mistaken for one somebody did.
            const derived = start !== null && !n.plannedStartAt

            return (
              <tr
                key={n.id}
                className="border-t border-[color:var(--edge-soft)] hover:bg-[var(--surface-sunken)]"
              >
                <td className="max-w-[180px] px-1.5 py-1">
                  <button
                    type="button"
                    onClick={() => onOpen(n.id)}
                    title={`${n.title} — open details`}
                    className={`widget-nodrag block w-full truncate text-left ${
                      done ? 'text-[var(--ink-40)] line-through' : 'text-[var(--ink-90)]'
                    }`}
                  >
                    {n.title || 'Untitled'}
                  </button>
                </td>
                <td className="px-1.5 py-1">
                  <select
                    className="widget-nodrag w-full rounded border border-transparent bg-transparent px-0.5 py-0.5 hover:border-[var(--line)]"
                    value={n.status}
                    onChange={(e) => onPatch(n.id, { status: e.target.value as TaskStatus })}
                  >
                    {STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-1.5 py-1">
                  <input
                    className="widget-nodrag w-[74px] rounded border border-transparent bg-transparent px-0.5 py-0.5 hover:border-[var(--line)] focus:border-[var(--line)]"
                    placeholder="—"
                    defaultValue={n.assignee ?? ''}
                    onBlur={(e) => {
                      const v = e.target.value.trim()
                      if (v !== (n.assignee ?? '')) onPatch(n.id, { assignee: v || null })
                    }}
                  />
                </td>
                <td className="px-1.5 py-1">
                  <input
                    type="date"
                    className={`widget-nodrag rounded border border-transparent bg-transparent px-0.5 py-0.5 hover:border-[var(--line)] ${
                      derived ? 'text-[var(--ink-45)] italic' : ''
                    }`}
                    title={derived ? 'Derived from the task this one waits on' : 'Planned start'}
                    value={toDateInput(start)}
                    onChange={(e) => onPatch(n.id, { plannedStartAt: fromDateInput(e.target.value) })}
                  />
                </td>
                <td className="px-1.5 py-1">
                  <input
                    type="date"
                    className="widget-nodrag rounded border border-transparent bg-transparent px-0.5 py-0.5 hover:border-[var(--line)]"
                    value={toDateInput(n.dueDate)}
                    onChange={(e) => onPatch(n.id, { dueDate: fromDateInput(e.target.value) })}
                  />
                </td>
                <td className="px-1.5 py-1 text-right tabular-nums text-[var(--ink-60)]">
                  {days ?? '—'}
                </td>
                <td className="max-w-[130px] px-1.5 py-1">
                  <select
                    className="widget-nodrag w-full rounded border border-transparent bg-transparent px-0.5 py-0.5 hover:border-[var(--line)]"
                    value={n.dependsOn ?? ''}
                    onChange={(e) => onPatch(n.id, { dependsOn: e.target.value || null })}
                    title={predecessor ? `Waits for ${titleOf(n.dependsOn)}` : 'Waits for nothing'}
                  >
                    <option value="">—</option>
                    {tasks
                      .filter((t) => t.id !== n.id)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title || 'Untitled'}
                        </option>
                      ))}
                  </select>
                </td>
                <td className="px-1.5 py-1 text-right">
                  <input
                    type="number"
                    className="widget-nodrag w-[42px] rounded border border-transparent bg-transparent px-0.5 py-0.5 text-right tabular-nums hover:border-[var(--line)] disabled:opacity-30"
                    placeholder="0"
                    disabled={!n.dependsOn}
                    defaultValue={n.lagDays ?? ''}
                    title={
                      n.dependsOn
                        ? 'Days after the other task ends. Negative overlaps them.'
                        : 'Pick something to wait for first'
                    }
                    onBlur={(e) => {
                      const raw = e.target.value
                      const v = raw === '' ? null : Number(raw)
                      if (v !== (n.lagDays ?? null)) onPatch(n.id, { lagDays: v })
                    }}
                  />
                </td>
                <td className="px-1.5 py-1 text-right tabular-nums text-[var(--ink-50)]">
                  {subs.length > 0 ? `${subsDone}/${subs.length}` : '—'}
                </td>
                <td className="px-1.5 py-1 text-right text-[var(--ink-50)]">
                  {atts > 0 ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Icon name="attach_file" size={10} />
                      {atts}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
