// Start an AI project: a goal, an optional brief, a workspace. It lands on a
// new Desk (or on the Desk you're on), opened in the AI view.

import { useEffect, useId, useState } from 'react'
import Modal from '../plexi/Modal'
import type { AiWorkspace } from '@shared/aispace/model'
import { PrimaryButton, QuietButton } from './ui'
import { openProject, startProjectOnNewDesk } from '../../lib/aiSpaceNav'
import { useNodeStore } from '../../stores/nodes'

export default function NewProjectDialog(props: { onClose: () => void; deskId?: string | null; deskTitle?: string | null; roomId?: string | null; onCreated?: (projectId: string) => void }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<AiWorkspace[]>([])
  const [workspaceId, setWorkspaceId] = useState<string>('')
  const [title, setTitle] = useState(props.deskTitle ?? '')
  const [goal, setGoal] = useState('')
  const [brief, setBrief] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { title: useId(), goal: useId(), brief: useId(), ws: useId(), head: useId() }

  useEffect(() => {
    void window.api.aiSpace.getContext().then((c) => {
      const active = c.workspaces.filter((w) => c.active.includes(w.id))
      setWorkspaces(c.workspaces)
      setWorkspaceId((active[0] ?? c.workspaces[0])?.id ?? '')
    })
  }, [])

  async function create(): Promise<void> {
    if (!title.trim()) {
      setError('Give the project a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (props.deskId) {
        const p = await window.api.aiSpace.createProject({ workspaceId, title, goal, brief, deskId: props.deskId, roomId: props.roomId ?? null })
        props.onCreated?.(p.id)
        props.onClose()
        return
      }
      const p = await startProjectOnNewDesk({ title, goal, brief, workspaceId, roomId: props.roomId ?? null })
      await useNodeStore.getState().refresh()
      props.onClose()
      props.onCreated?.(p.id)
      openProject(p, { tab: 'overview' })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const field = 'fb-field w-full rounded-lg px-3 py-2 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]'
  return (
    <Modal onClose={props.onClose} labelledById={ids.head} testId="ais-new-project" className="fb-card w-[min(560px,94vw)]">
      <form
        className="p-5 ais-touch"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <h2 id={ids.head} className="text-[18px] font-semibold text-[var(--ink-100)]">
          {props.deskId ? 'Start an AI project on this Desk' : 'Start an AI project'}
        </h2>
        <p className="mt-1 text-[13px] text-[var(--ink-60)]">It gets its own Desk with a brief, tasks, outputs and a Project Manager. Stored on this Mac only for now.</p>
        <label htmlFor={ids.title} className="block mt-4 text-[12px] text-[var(--ink-60)]">
          Name
        </label>
        <input id={ids.title} data-testid="ais-new-project-title" className={field} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. SaaSMouth spring launch" autoFocus />
        <label htmlFor={ids.goal} className="block mt-3 text-[12px] text-[var(--ink-60)]">
          Goal <span className="text-[var(--ink-40)]">(what done looks like)</span>
        </label>
        <input id={ids.goal} data-testid="ais-new-project-goal" className={field} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Launch the new pricing page and ads by Friday" />
        <label htmlFor={ids.brief} className="block mt-3 text-[12px] text-[var(--ink-60)]">
          Brief <span className="text-[var(--ink-40)]">(optional; agents work from it, and every change is kept as a version)</span>
        </label>
        <textarea id={ids.brief} data-testid="ais-new-project-brief" className={`${field} min-h-[96px] resize-y`} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Offer, audience, tone, must-haves…" />
        {workspaces.length > 1 && (
          <>
            <label htmlFor={ids.ws} className="block mt-3 text-[12px] text-[var(--ink-60)]">
              Workspace
            </label>
            <select id={ids.ws} data-testid="ais-new-project-ws" className={field} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.kind === 'work' ? 'work' : 'personal'})
                </option>
              ))}
            </select>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-[color:var(--ais-bad)]">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <QuietButton onClick={props.onClose}>Cancel</QuietButton>
          <PrimaryButton type="submit" disabled={busy} testId="ais-new-project-create">
            {busy ? 'Starting…' : 'Start project'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  )
}
