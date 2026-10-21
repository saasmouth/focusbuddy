import { useEffect, useMemo, useState } from 'react'
import { useNodeStore } from '../../stores/nodes'
import { useWorkItemStore } from '../../stores/workItems'
import { isDeskTask } from '@shared/attentionProjection'
import { URGENCY_LEVELS, type Urgency } from '../../lib/itemTags'
import Icon from '../Icon'

// Turn an email into a task (DEC-144). The task lands in Focus, the one list
// of tasks, optionally filed on one of your desks, with a due date and an
// urgency, and it points back at the email. It used to create a whole DESK
// (or a folder and a desk) — the opposite of what "make a task" means, and a
// second way to make the same thing the Add to Focus button already makes.

interface EmailLike {
  subject: string
  fromName: string
  fromAddress: string
  text: string
}

interface Props {
  email: EmailLike
  onClose: () => void
  onCreated: (title: string) => void
}

export default function EmailTaskDialog({ email, onClose, onCreated }: Props): JSX.Element {
  const nodes = useNodeStore((s) => s.nodes)
  const refresh = useNodeStore((s) => s.refresh)
  const createTask = useWorkItemStore((s) => s.create)

  const [title, setTitle] = useState(email.subject || '(no subject)')
  const [deskId, setDeskId] = useState<string>('') // '' = Focus only, no desk
  const [due, setDue] = useState('') // yyyy-mm-dd
  const [urgency, setUrgency] = useState<Urgency>('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (nodes.length === 0) void refresh()
  }, [nodes.length, refresh])

  // Your own live desks — the same rule the Focus editor uses (shared and
  // archived desks refuse a captured task), minus the tasks filed on them.
  const desks = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return nodes
      .filter((n) => n.kind === 'task' && !n.archived && !n.sharedRootId && !isDeskTask(n, (id) => byId.get(id)))
      .sort((a, b) => a.title.localeCompare(b.title))
  }, [nodes])

  async function submit(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const snippet = email.text.trim().slice(0, 400)
      const finalTitle = title.trim() || '(no subject)'
      await createTask({
        title: finalTitle,
        notes: `From ${email.fromName} <${email.fromAddress}>\n\n${snippet}`,
        parentId: deskId || null,
        intentClass: 'to_do',
        dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
        wiUrgency: urgency === 'normal' ? null : urgency,
        sourceType: 'mail',
        wiOrigin: 'human'
      })
      onCreated(finalTitle)
    } catch (e) {
      setBusy(false)
      setError((e as Error)?.message ?? 'Could not create the task.')
    }
  }

  const inputCls =
    'w-full bg-[var(--surface-sunken)] rounded-lg px-3 py-2 text-[13px] focus:border-accent'

  return (
    <div className="fixed inset-0 z-[300] bg-black/40 flex items-center justify-center" onMouseDown={onClose}>
      <div
        data-testid="email-task-dialog"
        className="fb-card w-[480px] max-w-[92vw] p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Icon name="add_task" size={16} className="text-accent" />
          <span className="text-[14px] font-semibold text-[var(--ink-90)]">Make a task from this email</span>
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Task</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls + ' mt-1'} data-testid="email-task-title" />
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Desk (optional)</span>
          <select
            value={deskId}
            onChange={(e) => setDeskId(e.target.value)}
            data-testid="email-task-destination"
            className={inputCls + ' mt-1'}
          >
            <option value="">No desk — just Focus</option>
            {desks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title || 'Untitled desk'}
              </option>
            ))}
          </select>
        </label>

        <div className="flex gap-3">
          <label className="block flex-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Due date</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="email-task-due" className={inputCls + ' mt-1'} />
          </label>
          <div className="flex-1">
            <span className="text-[11px] uppercase tracking-wide text-[var(--ink-40)]">Urgency</span>
            <div className="mt-1 flex gap-1" data-testid="email-task-urgency">
              {URGENCY_LEVELS.map((u) => (
                <button
                  key={u}
                  onClick={() => setUrgency(u)}
                  className={`flex-1 py-1.5 rounded text-[11px] border capitalize ${
                    urgency === u
                      ? 'border-accent bg-accent/15 text-accent font-medium'
                      : 'border-[var(--edge-soft)] text-[var(--ink-50)]'
                  }`}
                >
                  {u}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <div className="text-[12px] text-red-600 dark:text-red-400">{error}</div>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="fb-btn-surface text-[12px] px-3 py-1.5 text-[var(--ink-70)]">
            Cancel
          </button>
          <button onClick={() => void submit()} disabled={busy} className="btn-primary text-[12px] px-3 py-1.5" data-testid="email-task-create">
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </div>
    </div>
  )
}
