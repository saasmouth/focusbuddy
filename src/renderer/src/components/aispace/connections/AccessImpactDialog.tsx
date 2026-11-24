// "What changes if you do this": shown BEFORE pausing, disconnecting or
// removing a project's access (SPEC-CONNECTIONS.md §2 "Show affected projects,
// agents and schedules before changing access"). Nothing is called until the
// impact has loaded and the person confirms.

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AccessImpactData } from '@shared/aispace/api'
import Modal from '../../plexi/Modal'
import Icon from '../../Icon'
import { QuietButton, StatusBadge } from '../ui'
import { errorText } from './model'

export interface ImpactRequest {
  title: string
  // What the action does, in one or two plain sentences.
  effect: string
  confirmLabel: string
  danger?: boolean
  load: () => Promise<AccessImpactData>
  run: () => Promise<void>
}

export default function AccessImpactDialog(props: { request: ImpactRequest; onClose: () => void }): JSX.Element {
  const { request } = props
  const [impact, setImpact] = useState<AccessImpactData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headId = useId()

  useEffect(() => {
    let live = true
    request
      .load()
      .then((d) => live && setImpact(d))
      .catch((e) => live && setError(errorText(e)))
    return () => {
      live = false
    }
  }, [request])

  async function confirm(): Promise<void> {
    if (!impact || busy) return
    setBusy(true)
    setError(null)
    try {
      await request.run()
      props.onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  const nothing = impact && !impact.projects.length && !impact.agents.length && !impact.activeRuns.length && !impact.scheduled.length && !impact.defaultFor.length && !impact.external

  return (
    <Modal onClose={props.onClose} labelledById={headId} z={260} className="fb-card w-[min(520px,94vw)] max-h-[86vh] overflow-auto p-6 ais-touch" testId="conn-impact-dialog">
      <h2 id={headId} className="text-[18px] font-semibold text-[var(--ink-100)]">
        {request.title}
      </h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--ink-70)]">{request.effect}</p>

      <div className="mt-4" aria-live="polite">
        {!impact && !error && (
          <p role="status" className="text-[13px] text-[var(--ink-60)]">
            Checking what uses it…
          </p>
        )}
        {nothing && (
          <p className="text-[14px] text-[var(--ink-70)]" data-testid="conn-impact-none">
            Nothing else uses it right now: no projects, agents, runs or schedules.
          </p>
        )}
        {impact && !nothing && (
          <div className="space-y-4" data-testid="conn-impact-list">
            <ImpactGroup title="Projects that lose access" count={impact.projects.length}>
              {impact.projects.map((p) => (
                <li key={p.id}>{p.title || 'Untitled project'}</li>
              ))}
            </ImpactGroup>
            <ImpactGroup title="Agents that use it" count={impact.agents.length}>
              {impact.agents.map((a) => (
                <li key={a.id}>
                  {a.name} <span className="text-[var(--ink-50)]">in {a.projectTitle}</span>
                </li>
              ))}
            </ImpactGroup>
            <ImpactGroup title="Runs in progress" count={impact.activeRuns.length}>
              {impact.activeRuns.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  <span className="min-w-0 truncate">{r.title}</span>
                  <StatusBadge status={r.status} />
                </li>
              ))}
            </ImpactGroup>
            <ImpactGroup title="Scheduled runs" count={impact.scheduled.length}>
              {impact.scheduled.map((r) => (
                <li key={r.id}>
                  {r.title} <span className="text-[var(--ink-50)]">in {r.projectTitle}</span>
                </li>
              ))}
            </ImpactGroup>
            <ImpactGroup title="Project default for" count={impact.defaultFor.length}>
              {impact.defaultFor.map((p) => (
                <li key={p.id}>{p.title}</li>
              ))}
            </ImpactGroup>
            {impact.external > 0 && (
              <div className="flex items-start gap-2 text-[14px] text-[var(--ink-80)]" data-testid="conn-impact-external">
                <Icon name="cloud_sync" size={16} className="mt-0.5 text-[color:var(--ais-warn)]" />
                <p>
                  <span className="fb-tabular">{impact.external}</span> {impact.external === 1 ? 'job is' : 'jobs are'} running at the provider. Plexii can’t stop {impact.external === 1 ? 'it' : 'them'} from here; {impact.external === 1 ? 'it' : 'they'} will show as Status unavailable until you check at the provider.
                </p>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-[color:var(--ais-bad)]">
            {error}
          </p>
        )}
      </div>

      <div className="mt-6 flex items-center justify-end gap-2">
        <QuietButton onClick={props.onClose} testId="conn-impact-cancel">
          Cancel
        </QuietButton>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={!impact || busy}
          data-testid="conn-impact-confirm"
          className={`inline-flex items-center justify-center gap-1.5 min-h-[32px] px-3.5 rounded-lg text-[13px] font-medium text-white disabled:opacity-45 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--accent))] motion-safe:transition-colors motion-safe:duration-150 ${request.danger ? 'bg-[color:var(--ais-bad)] hover:brightness-110' : 'bg-[rgb(var(--accent))] hover:bg-[rgb(var(--accent-hover,var(--accent)))]'}`}
        >
          {busy ? 'Working…' : request.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

function ImpactGroup(props: { title: string; count: number; children: ReactNode }): JSX.Element | null {
  if (props.count === 0) return null
  return (
    <section>
      <h3 className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">
        {props.title} <span className="fb-tabular">({props.count})</span>
      </h3>
      <ul className="mt-1.5 space-y-1 text-[14px] text-[var(--ink-90)]">{props.children}</ul>
    </section>
  )
}
