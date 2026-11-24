// Side panel › Activity: the attributed trail for this connection
// (SPEC-CONNECTIONS.md §7 "Keep configuration changes, capability changes,
// approvals, invocations and failures attributed and timestamped"; "Show what
// work completed and what is uncertain").
//
// An action whose result is uncertain is never retried by Plexii. The person
// checks in the app it touched and records what happened.

import { useState } from 'react'
import type { ConnectionCard, ConnectionDetailData } from '@shared/aispace/api'
import Icon from '../../Icon'
import { useViewStore } from '../../../stores/view'
import type { ReactNode } from 'react'
import { announce, authorLabel, fmtAgo, fmtWhen, QuietButton, StatusBadge } from '../ui'
import { errorText, INVOCATION_STATUS } from './model'

export default function ActivityTab(props: { card: ConnectionCard; detail: ConnectionDetailData; onChanged: () => void }): JSX.Element {
  const { card, detail } = props
  const opTitle = new Map(detail.operations.map((o) => [o.id, o.title]))
  const opOf = new Map(detail.operations.map((o) => [o.id, o]))
  const projectTitle = new Map(detail.projects.map((p) => [p.id, p.title]))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function actor(a: string): string {
    if (a === 'system') return 'Plexii'
    if (a.startsWith('connection:')) return card.alias
    return authorLabel(a)
  }

  function nameOf(operationId: string): string {
    if (operationId === 'model:*') return 'Run a model'
    return opTitle.get(operationId) ?? operationId.split(':').pop() ?? operationId
  }

  async function reconcile(id: string, outcome: 'done' | 'not_done'): Promise<void> {
    setBusy(id)
    setError(null)
    try {
      await window.api.aiSpace.reconcileInvocation(id, outcome)
      announce(outcome === 'done' ? 'Marked as done.' : 'Marked as not done.')
      props.onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const empty = detail.activity.length === 0 && detail.invocations.length === 0 && detail.runs.length === 0

  return (
    <div data-testid="conn-activity">
      {empty && <p className="text-[14px] text-[var(--ink-60)]">Nothing has happened with {card.alias} yet.</p>}
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-[color:var(--ais-bad)]">
          {error}
        </p>
      )}

      {detail.invocations.length > 0 && (
        <Group title="Actions" testId="conn-invocations">
          <ul className="space-y-2">
            {detail.invocations.map((inv) => {
              const s = INVOCATION_STATUS[inv.status]
              const op = opOf.get(inv.operationId)
              return (
                <li key={inv.id} className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2.5" data-testid={`conn-inv-${inv.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[var(--ink-90)]">{nameOf(inv.operationId)}</span>
                    <StatusBadge status={s.status} label={s.label} />
                  </div>
                  <p className="mt-0.5 text-[12px] text-[var(--ink-50)]">
                    {actor(inv.principal)}
                    {inv.projectId ? ` · ${projectTitle.get(inv.projectId) ?? 'a project'}` : ''} · <span className="fb-tabular">{fmtWhen(inv.startedAt)}</span>
                  </p>
                  {inv.detail && <p className="mt-1 text-[13px] leading-relaxed text-[var(--ink-70)]">{inv.detail}</p>}
                  {inv.approval.by && <p className="mt-1 text-[12px] text-[var(--ink-60)]">Approved by {authorLabel(inv.approval.by)}{inv.approval.at ? `, ${fmtAgo(inv.approval.at)}` : ''}.</p>}
                  {inv.status === 'awaiting_approval' && (
                    <div className="mt-2 text-[13px] leading-relaxed text-[var(--ink-80)]" data-testid={`conn-inv-approval-${inv.id}`}>
                      <p>
                        Waiting for approval: <strong className="font-medium">{nameOf(inv.operationId)}</strong> on {card.alias}
                        {op ? `, sending to ${op.destination}` : ''}. {op?.classification === 'write' ? 'It changes data.' : ''}
                      </p>
                      <p className="mt-0.5 text-[12px] text-[var(--ink-60)]">Payer: {card.payer}. Approve or decline it where it was asked{inv.runId ? ', in its run' : ''}.</p>
                    </div>
                  )}
                  {inv.status === 'uncertain' && (
                    <div className="mt-2" data-testid={`conn-inv-uncertain-${inv.id}`}>
                      <p className="flex items-start gap-1.5 text-[13px] leading-relaxed text-[var(--ink-80)]">
                        <Icon name="help" size={15} className="mt-0.5 shrink-0 text-[color:var(--ais-warn)]" />
                        Plexii can’t tell whether this happened, so it won’t try again. Check in the app, then mark Done or Not done.
                      </p>
                      <div className="mt-2 flex gap-2">
                        <QuietButton onClick={() => void reconcile(inv.id, 'done')} disabled={busy !== null} testId={`conn-inv-done-${inv.id}`}>
                          Done
                        </QuietButton>
                        <QuietButton onClick={() => void reconcile(inv.id, 'not_done')} disabled={busy !== null} testId={`conn-inv-notdone-${inv.id}`}>
                          Not done
                        </QuietButton>
                      </div>
                    </div>
                  )}
                  {inv.runId && (
                    <button type="button" onClick={() => useViewStore.getState().goAiRuns(inv.runId!)} className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-[rgb(var(--accent))] hover:underline underline-offset-2 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]">
                      Open its run
                      <Icon name="arrow_forward" size={13} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </Group>
      )}

      {detail.runs.length > 0 && (
        <Group title="Recent runs" testId="conn-runs">
          <ul className="divide-y divide-[var(--edge-hairline)]">
            {detail.runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => useViewStore.getState().goAiRuns(r.id)}
                  data-testid={`conn-run-${r.id}`}
                  className="w-full min-h-[44px] flex items-center gap-2 py-2 text-left rounded-[var(--radius-row)] hover:bg-[var(--surface-sunken)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-[var(--ink-90)]">{r.title}</span>
                    <span className="block text-[12px] text-[var(--ink-50)]">
                      {r.projectTitle}
                      {r.model ? ` · ${r.model}` : ''} · <span className="fb-tabular">{fmtAgo(r.createdAt)}</span>
                    </span>
                  </span>
                  <StatusBadge status={r.status} />
                </button>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {detail.activity.length > 0 && (
        <Group title="Changes" testId="conn-audit">
          <ol className="space-y-2.5">
            {[...detail.activity].sort((a, b) => b.at - a.at).map((e) => (
              <li key={e.id} className="text-[13px] leading-relaxed">
                <p className="text-[var(--ink-80)]">{e.summary}</p>
                <p className="text-[12px] text-[var(--ink-50)]">
                  {actor(e.actor)} · <span className="fb-tabular">{fmtWhen(e.at)}</span>
                </p>
              </li>
            ))}
          </ol>
        </Group>
      )}
    </div>
  )
}

function Group(props: { title: string; testId: string; children: ReactNode }): JSX.Element {
  return (
    <section className="mt-6 first:mt-0" data-testid={props.testId} aria-label={props.title}>
      <h3 className="mb-2 text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">{props.title}</h3>
      {props.children}
    </section>
  )
}
