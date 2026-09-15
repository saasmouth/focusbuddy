import { useEffect, useMemo, useRef, useState } from 'react'
import type { FbNode, TaskStatus } from '@shared/types'
import { parseAttachments, derivedStart, durationDays, type TaskAttachment } from '@shared/taskPlanning'
import Icon from '../Icon'

// Everything a task is, once it is more than a line on a list.
//
// Each field here is backed by a real column (see shared/taskPlanning.ts) and
// writes through the ordinary node update path, so a start date typed here is
// the same start date the rest of the app sees. Nothing is display-only and
// nothing is remembered in component state.
//
// Duration is the exception worth explaining: it is DERIVED from start and due
// rather than stored, because two of the three can always be edited and storing
// all three guarantees they will eventually disagree. Typing a duration moves
// the due date, which is the one interpretation that keeps the other two true.

export const STATUSES: ReadonlyArray<{ value: TaskStatus; label: string; dot: string }> = [
  { value: 'open', label: 'Open', dot: 'bg-slate-400' },
  { value: 'in_progress', label: 'In progress', dot: 'bg-sky-500' },
  { value: 'parked', label: 'Parked', dot: 'bg-amber-500' },
  { value: 'done', label: 'Done', dot: 'bg-emerald-500' }
]

const DAY = 86_400_000

/** yyyy-mm-dd in LOCAL time, which is what <input type="date"> expects. */
export function toDateInput(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Local midnight for a yyyy-mm-dd, or null for a cleared field. */
export function fromDateInput(v: string): number | null {
  if (!v) return null
  const [y, m, d] = v.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).getTime()
}

export interface TaskDetailProps {
  task: FbNode
  /** Candidate predecessors — siblings, so a task can't depend on its own child. */
  siblings: readonly FbNode[]
  /** Subtasks of this task. */
  subtasks: readonly FbNode[]
  onPatch: (id: string, patch: Record<string, unknown>) => void
  onAddSubtask: (parentId: string, title: string) => void
  onOpenTask: (id: string) => void
}

export default function TaskDetail({
  task,
  siblings,
  subtasks,
  onPatch,
  onAddSubtask,
  onOpenTask
}: TaskDetailProps): JSX.Element {
  const [subDraft, setSubDraft] = useState('')
  const [notes, setNotes] = useState(task.description ?? '')
  const [assignee, setAssignee] = useState(task.assignee ?? '')
  const [busyAttach, setBusyAttach] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)
  const notesTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Re-sync when the task changes underneath (another widget, a sync peer).
  useEffect(() => setNotes(task.description ?? ''), [task.id, task.description])
  useEffect(() => setAssignee(task.assignee ?? ''), [task.id, task.assignee])
  useEffect(() => () => { if (notesTimer.current) clearTimeout(notesTimer.current) }, [])

  const predecessor = useMemo(
    () => (task.dependsOn ? siblings.find((s) => s.id === task.dependsOn) ?? null : null),
    [siblings, task.dependsOn]
  )
  // A predecessor's END is its due date; its completion is when it actually
  // finished. The plan runs on the former.
  const start = derivedStart(task, predecessor?.dueDate ?? null)
  const duration = durationDays(start, task.dueDate ?? null)
  const attachments = useMemo(() => parseAttachments(task.attachmentsJson), [task.attachmentsJson])
  const derived = start !== null && !task.plannedStartAt

  const patch = (p: Record<string, unknown>): void => onPatch(task.id, p)

  const setNotesDebounced = (v: string): void => {
    setNotes(v)
    if (notesTimer.current) clearTimeout(notesTimer.current)
    notesTimer.current = setTimeout(() => patch({ description: v }), 400)
  }

  /** Typing a duration moves the END, keeping the start the user chose. */
  const setDuration = (days: number): void => {
    if (!Number.isFinite(days) || days < 0) return
    const from = start ?? Date.now()
    if (!task.plannedStartAt && !predecessor) patch({ plannedStartAt: from, dueDate: from + days * DAY })
    else patch({ dueDate: from + days * DAY })
  }

  const addAttachment = async (): Promise<void> => {
    const api = (window as {
      api?: {
        files?: {
          pickAndIngest?: (o?: { title?: string }) => Promise<{
            id: string
            originalName: string
            mimeType: string
            sizeBytes: number
          } | null>
        }
      }
    }).api
    const pick = api?.files?.pickAndIngest
    if (!pick) {
      setAttachError('Attaching files needs the desktop app.')
      return
    }
    setAttachError(null)
    setBusyAttach(true)
    try {
      const file = await pick({ title: `Attach to “${task.title}”` })
      if (!file) return
      const next: TaskAttachment[] = [
        ...attachments,
        { id: file.id, name: file.originalName, mime: file.mimeType, size: file.sizeBytes }
      ]
      patch({ attachmentsJson: JSON.stringify(next) })
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyAttach(false)
    }
  }

  const removeAttachment = (id: string): void => {
    // Detaches from the task; the ingested file itself is left alone, because
    // it may be attached elsewhere and deleting shared bytes from a Remove
    // button is not what that button appears to promise.
    patch({ attachmentsJson: JSON.stringify(attachments.filter((a) => a.id !== id)) })
  }

  const openAttachment = (a: TaskAttachment): void => {
    const api = (window as { api?: { files?: { openExternal?: (u: string) => void } } }).api
    api?.files?.openExternal?.(`fb-file://${a.id}`)
  }

  const doneCount = subtasks.filter((s) => s.status === 'done').length

  return (
    <div className="flex flex-col gap-2 border-t border-[color:var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_40%,transparent)] px-2 py-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={task.status}
          onChange={(v) => patch({ status: v as TaskStatus })}
          options={STATUSES.map((s) => ({ value: s.value, label: s.label }))}
          title="Status"
        />
        <label className="flex min-w-0 flex-1 items-center gap-1" title="Assignee">
          <Icon name="person" size={12} className="shrink-0 text-[var(--ink-40)]" />
          <input
            className="widget-nodrag min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11px] text-[var(--ink-80)] outline-none placeholder:text-[var(--ink-35)] hover:border-[var(--line)] focus:border-[var(--line)]"
            placeholder="Unassigned"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            onBlur={() => patch({ assignee: assignee.trim() || null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </label>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Labeled label="Start">
          <input
            type="date"
            className="widget-nodrag w-full rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 text-[11px] text-[var(--ink-80)]"
            value={toDateInput(start)}
            onChange={(e) => patch({ plannedStartAt: fromDateInput(e.target.value) })}
            title={derived ? 'Derived from the task this one waits on' : 'Planned start'}
          />
          {derived && <span className="text-[9px] text-[var(--ink-40)]">from dependency</span>}
        </Labeled>
        <Labeled label="Due">
          <input
            type="date"
            className="widget-nodrag w-full rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 text-[11px] text-[var(--ink-80)]"
            value={toDateInput(task.dueDate)}
            onChange={(e) => patch({ dueDate: fromDateInput(e.target.value) })}
          />
        </Labeled>
        <Labeled label="Duration">
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              className="widget-nodrag w-full rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 text-[11px] tabular-nums text-[var(--ink-80)]"
              value={duration ?? ''}
              placeholder="—"
              onChange={(e) => setDuration(Number(e.target.value))}
            />
            <span className="shrink-0 text-[9px] text-[var(--ink-40)]">days</span>
          </div>
        </Labeled>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Labeled label="Waits for">
          <Select
            value={task.dependsOn ?? ''}
            onChange={(v) => patch({ dependsOn: v || null })}
            options={[
              { value: '', label: 'Nothing' },
              ...siblings
                .filter((s) => s.id !== task.id)
                .map((s) => ({ value: s.id, label: s.title || 'Untitled' }))
            ]}
            title="The task that must finish first"
            full
          />
        </Labeled>
        <Labeled label="Lag">
          <div className="flex items-center gap-1">
            <input
              type="number"
              className="widget-nodrag w-[52px] rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 text-[11px] tabular-nums text-[var(--ink-80)] disabled:opacity-40"
              value={task.lagDays ?? ''}
              placeholder="0"
              disabled={!task.dependsOn}
              onChange={(e) =>
                patch({ lagDays: e.target.value === '' ? null : Number(e.target.value) })
              }
              title={
                task.dependsOn
                  ? 'Days after the other task ends. Negative overlaps them.'
                  : 'Pick a task to wait for first'
              }
            />
            <span className="shrink-0 text-[9px] text-[var(--ink-40)]">d</span>
          </div>
        </Labeled>
      </div>

      <Labeled label="Notes">
        <textarea
          className="widget-nodrag min-h-[46px] w-full resize-y rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-1 text-[11px] leading-snug text-[var(--ink-80)] outline-none placeholder:text-[var(--ink-35)]"
          placeholder="Anything worth remembering about this task"
          value={notes}
          onChange={(e) => setNotesDebounced(e.target.value)}
          onBlur={() => patch({ description: notes })}
        />
      </Labeled>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--ink-40)]">
            Attachments
          </span>
          <button
            type="button"
            className="widget-nodrag ml-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-80)] disabled:opacity-50"
            onClick={() => void addAttachment()}
            disabled={busyAttach}
          >
            <Icon name={busyAttach ? 'hourglass_empty' : 'attach_file'} size={11} />
            {busyAttach ? 'Adding…' : 'Attach'}
          </button>
        </div>
        {attachError && <span className="text-[10px] text-rose-500">{attachError}</span>}
        {attachments.length === 0 && !attachError && (
          <span className="text-[10px] text-[var(--ink-35)]">None</span>
        )}
        {attachments.map((a) => (
          <div key={a.id} className="group/att flex items-center gap-1">
            <Icon name="draft" size={11} className="shrink-0 text-[var(--ink-40)]" />
            <button
              type="button"
              className="widget-nodrag min-w-0 flex-1 truncate text-left text-[10px] text-[var(--ink-70)] hover:text-[var(--ink-90)] hover:underline"
              onClick={() => openAttachment(a)}
              title={a.name}
            >
              {a.name}
            </button>
            <button
              type="button"
              className="widget-nodrag shrink-0 text-[var(--ink-30)] opacity-0 transition-opacity hover:text-rose-500 group-hover/att:opacity-100"
              onClick={() => removeAttachment(a.id)}
              title="Remove from this task"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--ink-40)]">
            Subtasks
          </span>
          {subtasks.length > 0 && (
            <span className="text-[9px] tabular-nums text-[var(--ink-40)]">
              {doneCount}/{subtasks.length}
            </span>
          )}
        </div>
        {subtasks.map((s) => (
          <div key={s.id} className="flex items-center gap-1.5">
            <button
              type="button"
              className={`inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
                s.status === 'done'
                  ? 'border-transparent bg-accent text-white'
                  : 'border-[var(--ink-30)] hover:border-accent'
              }`}
              onClick={() => onPatch(s.id, { status: s.status === 'done' ? 'open' : 'done' })}
              aria-label={s.status === 'done' ? 'Mark not done' : 'Mark done'}
            >
              {s.status === 'done' && <Icon name="check" size={9} />}
            </button>
            <button
              type="button"
              className={`widget-nodrag min-w-0 flex-1 truncate text-left text-[10px] ${
                s.status === 'done' ? 'text-[var(--ink-40)] line-through' : 'text-[var(--ink-70)]'
              }`}
              onClick={() => onOpenTask(s.id)}
              title={s.title}
            >
              {s.title || 'Untitled'}
            </button>
          </div>
        ))}
        <div className="flex items-center gap-1">
          <Icon name="add" size={11} className="shrink-0 text-[var(--ink-35)]" />
          <input
            className="widget-nodrag min-w-0 flex-1 bg-transparent text-[10px] text-[var(--ink-80)] outline-none placeholder:text-[var(--ink-35)]"
            placeholder="Add a subtask"
            value={subDraft}
            onChange={(e) => setSubDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const t = subDraft.trim()
              if (!t) return
              setSubDraft('')
              onAddSubtask(task.id, t)
            }}
          />
        </div>
      </div>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[9px] font-medium uppercase tracking-wide text-[var(--ink-40)]">
        {label}
      </span>
      {children}
    </label>
  )
}

function Select({
  value,
  onChange,
  options,
  title,
  full
}: {
  value: string
  onChange: (v: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  title?: string
  full?: boolean
}): JSX.Element {
  return (
    <select
      title={title}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`widget-nodrag rounded border border-[var(--line)] bg-[var(--surface)] px-1 py-0.5 text-[11px] text-[var(--ink-80)] ${full ? 'w-full' : ''}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
