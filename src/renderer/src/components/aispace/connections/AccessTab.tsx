// Side panel › Access: which projects may use this connection, and exactly
// how (SPEC-CONNECTIONS.md §2 "Reveal permissions when the user expands a
// project … Project assignment uses an explicit role and scope picker"; §4
// tool review; §6 grants).
//
// Assignment happens here and only here: one project row at a time, opened by
// keyboard or click, saved with an explicit button. Nothing is dragged.
// Reads and actions are separate grants. A tool nobody has classified can't be
// granted until a person says whether it reads data or takes action; the
// server's own claim is shown as advisory only.

import { useEffect, useId, useMemo, useState } from 'react'
import type { ConnectionCard, ConnectionDetailData } from '@shared/aispace/api'
import type { AiAgent } from '@shared/aispace/model'
import type { ApprovalLevel, GrantAction } from '@shared/aispace/connections'
import Icon from '../../Icon'
import { useNoticeStore } from '../../../stores/notice'
import { announce, EmptyState, PrimaryButton, QuietButton } from '../ui'
import type { ImpactRequest } from './AccessImpactDialog'
import { activeGrantFor, describeGrant, errorText, expiredGrantFor, operationUsable } from './model'
import { FIELD_CLASS } from './SecretField'

type Operation = ConnectionDetailData['operations'][number]
type DetailGrant = ConnectionDetailData['grants'][number]

const DAY = 24 * 60 * 60 * 1000

export default function AccessTab(props: { card: ConnectionCard; detail: ConnectionDetailData; onChanged: () => void; onAskImpact: (req: ImpactRequest) => void }): JSX.Element {
  const { card, detail } = props
  const [open, setOpen] = useState<string | null>(null)
  const now = Date.now()
  const disconnected = card.status === 'disconnected'

  if (detail.projects.length === 0) {
    return <EmptyState icon="folder_off" title="No projects in this workspace yet" body="Start an AI project in this workspace, then come back to choose what it can use." testId="conn-access-empty" />
  }

  return (
    <div data-testid="conn-access">
      <p className="text-[13px] leading-relaxed text-[var(--ink-60)]">Open a project to choose what it may do with {card.alias}. Reads and actions are granted separately.</p>
      {disconnected && <p className="mt-2 text-[13px] text-[var(--ink-70)]">This connection is disconnected, so no project can use it.</p>}
      <ul className="mt-3 divide-y divide-[var(--edge-hairline)]">
        {detail.projects.map((p) => {
          const grant = activeGrantFor(detail.grants, p.id, now)
          const expired = grant ? null : expiredGrantFor(detail.grants, p.id, now)
          const isOpen = open === p.id
          const regionId = `conn-access-region-${p.id}`
          return (
            <li key={p.id} data-testid={`conn-access-row-${p.id}`}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={regionId}
                onClick={() => setOpen(isOpen ? null : p.id)}
                data-testid={`conn-access-toggle-${p.id}`}
                className="w-full min-h-[44px] flex items-center gap-2 py-2 text-left rounded-[var(--radius-row)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
              >
                <Icon name="chevron_right" size={18} className={`shrink-0 text-[var(--ink-50)] motion-safe:transition-transform motion-safe:duration-200 ${isOpen ? 'rotate-90' : ''}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-[var(--ink-90)] truncate">{p.title || 'Untitled project'}</span>
                  <span className="block text-[12px] text-[var(--ink-60)]">{grant ? describeGrant(card.kind, grant, detail.operations) : expired ? 'Access ended' : 'No access'}</span>
                </span>
                {grant && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-[color:var(--ais-ok)]">
                    <Icon name="check_circle" size={14} />
                    Has access
                  </span>
                )}
              </button>
              {isOpen && (
                <div id={regionId} role="region" aria-label={`Access for ${p.title}`} className="pb-4 pl-7 ais-expand">
                  <GrantEditor key={grant?.id ?? 'none'} card={card} project={p} grant={grant} operations={detail.operations} disabled={disconnected} onChanged={props.onChanged} onAskImpact={props.onAskImpact} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function GrantEditor(props: {
  card: ConnectionCard
  project: { id: string; title: string }
  grant: DetailGrant | null
  operations: Operation[]
  disabled: boolean
  onChanged: () => void
  onAskImpact: (req: ImpactRequest) => void
}): JSX.Element {
  const { card, grant, project } = props
  const api = window.api.aiSpace
  const kind = card.kind
  const usesOperations = kind === 'app_api' || kind === 'mcp'
  // Explicit choices the person made; anything else falls back to the grant
  // (or, for a new grant, to reads only).
  const [choices, setChoices] = useState<Record<string, 'read' | 'write' | null>>({})
  const [runModels, setRunModels] = useState<boolean>(grant ? grant.actions.some((a) => a.operationId === 'model:*') : true)
  const [allAgents, setAllAgents] = useState<boolean>(grant ? grant.agentIds.includes('*') : true)
  const [agentIds, setAgentIds] = useState<string[]>(grant && !grant.agentIds.includes('*') ? grant.agentIds : [])
  const [agents, setAgents] = useState<AiAgent[] | null>(null)
  const [agentsError, setAgentsError] = useState<string | null>(null)
  const [approval, setApproval] = useState<ApprovalLevel>(grant?.approval ?? 'ask_each_time')
  const [expiry, setExpiry] = useState<'keep' | 'none' | '7' | '30'>(grant?.expiresAt ? 'keep' : 'none')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [defaultModel, setDefaultModel] = useState<string>(card.defaultModel ?? card.models[0]?.id ?? '')
  const ids = { approval: useId(), expiry: useId(), model: useId(), agents: useId() }

  // The project's own agents, only when the person narrows the grant to some.
  useEffect(() => {
    if (allAgents || agents) return
    let live = true
    api
      .projectView(project.id)
      .then((v) => live && setAgents(v.agents))
      .catch((e) => live && setAgentsError(errorText(e)))
    return () => {
      live = false
    }
  }, [allAgents, agents, api, project.id])

  const effective = useMemo(() => {
    const out: Record<string, 'read' | 'write' | null> = {}
    for (const op of props.operations) {
      if (op.id in choices) {
        out[op.id] = choices[op.id]
        continue
      }
      if (grant) out[op.id] = grant.actions.find((a) => a.operationId === op.id)?.mode ?? null
      else out[op.id] = operationUsable(op) && op.classification === 'read' ? 'read' : null
    }
    return out
  }, [choices, grant, props.operations])

  function actionsToSave(): GrantAction[] {
    if (kind === 'model_api') return runModels ? [{ operationId: 'model:*', mode: 'read' }] : []
    if (!usesOperations) return []
    const out: GrantAction[] = []
    for (const op of props.operations) {
      const mode = effective[op.id]
      if (!mode) continue
      // A tool waiting for review keeps what it had; policy refuses it until reviewed.
      if (!operationUsable(op) && !grant?.actions.some((a) => a.operationId === op.id)) continue
      // Reads and actions never blur: a write tool needs a write grant.
      if (op.classification === 'write' && mode !== 'write' && operationUsable(op)) continue
      out.push({ operationId: op.id, mode })
    }
    return out
  }

  const writesGranted = usesOperations && props.operations.some((op) => effective[op.id] === 'write')

  async function save(): Promise<void> {
    if (busy) return
    if (!allAgents && agentIds.length === 0) {
      setError('Pick at least one agent, or allow all agents.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const expiresAt = expiry === 'keep' ? grant?.expiresAt ?? null : expiry === 'none' ? null : Date.now() + Number(expiry) * DAY
      await api.setGrant({
        connectionId: card.id,
        projectId: project.id,
        agentIds: allAgents ? ['*'] : agentIds,
        actions: actionsToSave(),
        dataFilters: grant?.dataFilters ?? [],
        approval,
        expiresAt
      })
      useNoticeStore.getState().show({ text: `${project.title} can use ${card.alias}.`, icon: 'check_circle' })
      announce(`Access saved for ${project.title}.`)
      props.onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  function askRemove(): void {
    if (!grant) return
    props.onAskImpact({
      title: `Remove ${project.title}’s access?`,
      effect: `${project.title} stops using ${card.alias} for new calls. Its history stays.`,
      confirmLabel: 'Remove access',
      danger: true,
      // Only what changes for THIS project.
      load: async () => {
        const all = await api.accessImpact(card.id)
        const activeRuns = all.activeRuns.filter((r) => r.projectId === project.id)
        const scheduled = all.scheduled.filter((r) => r.projectId === project.id)
        return {
          projects: all.projects.filter((p) => p.id === project.id),
          agents: all.agents.filter((a) => a.projectTitle === project.title),
          activeRuns,
          scheduled,
          defaultFor: all.defaultFor.filter((p) => p.id === project.id),
          external: activeRuns.concat(scheduled).filter((r) => r.externalId).length
        }
      },
      run: async () => {
        await api.revokeGrant(grant.id)
        useNoticeStore.getState().show({ text: `${project.title} no longer uses ${card.alias}.`, icon: 'link_off' })
        announce(`Access removed for ${project.title}.`)
        props.onChanged()
      }
    })
  }

  async function review(op: Operation, cls: 'read' | 'write'): Promise<void> {
    setReviewing(op.id)
    setError(null)
    try {
      await api.reviewOperation(op.id, cls)
      announce(`${op.title} marked as ${cls === 'read' ? 'reading data' : 'taking action'}.`)
      props.onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setReviewing(null)
    }
  }

  async function makeDefault(): Promise<void> {
    if (busy || !defaultModel) return
    setBusy(true)
    setError(null)
    try {
      await api.setProjectDefault(project.id, card.id, defaultModel)
      const label = card.models.find((m) => m.id === defaultModel)?.label ?? defaultModel
      useNoticeStore.getState().show({ text: `${project.title} now starts with ${card.alias} (${label}).`, icon: 'check_circle' })
      props.onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (opId: string, mode: 'read' | 'write', on: boolean): void => setChoices((c) => ({ ...c, [opId]: on ? mode : null }))

  return (
    <div className="space-y-4" data-testid={`conn-grant-${project.id}`}>
      <p className="text-[13px] text-[var(--ink-70)]">
        <span className="text-[var(--ink-50)]">Role:</span> Use. Runs inside this project’s rules. Nobody can see or copy the {kind === 'app_api' ? 'token' : 'key'}.
      </p>

      {/* What it may do. */}
      <fieldset disabled={props.disabled}>
        <legend className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">What it may do</legend>
        {kind === 'model_api' && (
          <label className="mt-2 flex items-center gap-2 min-h-[32px] text-[14px] text-[var(--ink-90)]">
            <input type="checkbox" checked={runModels} onChange={(e) => setRunModels(e.target.checked)} data-testid="conn-grant-models" className="h-4 w-4 accent-[rgb(var(--accent))]" />
            Run models
          </label>
        )}
        {kind === 'ai_account' && <p className="mt-2 text-[14px] text-[var(--ink-80)]">Open its chats and import what you pick. Nothing else is possible with a web account.</p>}
        {(kind === 'agent' || kind === 'local') && <p className="mt-2 text-[14px] text-[var(--ink-80)]">Use it within this project’s rules.</p>}
        {usesOperations &&
          (props.operations.length === 0 ? (
            <p className="mt-2 text-[13px] text-[var(--ink-60)]">No tools listed yet. Test the connection to fetch them.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {props.operations.map((op) => (
                <li key={op.id} className="rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-3 py-2" data-testid={`conn-op-${op.id}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-[var(--ink-90)]">{op.title}</p>
                      {op.description && <p className="text-[12px] leading-relaxed text-[var(--ink-60)] line-clamp-2">{op.description}</p>}
                      {operationUsable(op) && (
                        <p className="mt-0.5 text-[12px] text-[var(--ink-50)]">
                          {op.classification === 'write' ? 'Takes action (changes data)' : 'Reads data'} · sends to {op.destination}
                        </p>
                      )}
                    </div>
                    {operationUsable(op) && op.classification === 'read' && (
                      <label className="inline-flex items-center gap-1.5 min-h-[32px] text-[13px] text-[var(--ink-80)] whitespace-nowrap">
                        <input type="checkbox" checked={effective[op.id] === 'read'} onChange={(e) => toggle(op.id, 'read', e.target.checked)} data-testid={`conn-op-read-${op.id}`} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                        Read
                      </label>
                    )}
                    {operationUsable(op) && op.classification === 'write' && (
                      <label className="inline-flex items-center gap-1.5 min-h-[32px] text-[13px] text-[var(--ink-80)] whitespace-nowrap">
                        <input type="checkbox" checked={effective[op.id] === 'write'} onChange={(e) => toggle(op.id, 'write', e.target.checked)} data-testid={`conn-op-write-${op.id}`} className="h-4 w-4 accent-[rgb(var(--accent))]" />
                        Write
                      </label>
                    )}
                  </div>
                  {!operationUsable(op) && (
                    <div className="mt-2 border-t border-[var(--edge-hairline)] pt-2" data-testid={`conn-op-review-${op.id}`}>
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-[color:var(--ais-warn)]">
                        <Icon name="rule" size={15} />
                        Review this tool
                      </p>
                      <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ink-60)]">
                        {op.reviewState === 'needs_review' && op.classification !== 'unknown' ? 'It changed since it was approved. ' : ''}
                        No project can use it until you say what it does.{' '}
                        {op.suggestedClass === 'read' ? 'The server says it only reads (advisory).' : op.suggestedClass === 'write' ? 'The server says it takes action (advisory).' : 'The server doesn’t say whether it reads or takes action.'}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <QuietButton onClick={() => void review(op, 'read')} disabled={reviewing !== null} testId={`conn-op-mark-read-${op.id}`}>
                          It reads data
                        </QuietButton>
                        <QuietButton onClick={() => void review(op, 'write')} disabled={reviewing !== null} testId={`conn-op-mark-write-${op.id}`}>
                          It takes action
                        </QuietButton>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </fieldset>

      {/* Which agents. */}
      <fieldset disabled={props.disabled}>
        <legend className="text-[12px] font-medium uppercase tracking-[0.08em] text-[var(--ink-50)]">Agents</legend>
        <label className="mt-2 flex items-center gap-2 min-h-[32px] text-[14px] text-[var(--ink-90)]">
          <input type="checkbox" checked={allAgents} onChange={(e) => setAllAgents(e.target.checked)} data-testid="conn-grant-all-agents" className="h-4 w-4 accent-[rgb(var(--accent))]" />
          All agents in this project
        </label>
        {!allAgents && (
          <div id={ids.agents} className="mt-1 pl-6">
            {agentsError && <p className="text-[12px] text-[color:var(--ais-bad)]">{agentsError}</p>}
            {!agents && !agentsError && <p className="text-[12px] text-[var(--ink-60)]">Loading agents…</p>}
            {agents && agents.length === 0 && <p className="text-[12px] text-[var(--ink-60)]">This project has no agents yet.</p>}
            {agents?.map((a) => (
              <label key={a.id} className="flex items-center gap-2 min-h-[28px] text-[13px] text-[var(--ink-80)]">
                <input
                  type="checkbox"
                  checked={agentIds.includes(a.id)}
                  onChange={(e) => setAgentIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                  className="h-4 w-4 accent-[rgb(var(--accent))]"
                />
                {a.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor={ids.approval} className="block text-[12px] text-[var(--ink-60)]">
            Before an action
          </label>
          <select id={ids.approval} value={approval} onChange={(e) => setApproval(e.target.value as ApprovalLevel)} disabled={props.disabled} data-testid="conn-grant-approval" className={FIELD_CLASS}>
            <option value="ask_each_time">Ask each time</option>
            <option value="auto">Automatic</option>
          </select>
          <p className="mt-1 text-[12px] text-[var(--ink-50)]">{writesGranted ? 'Applies to the tools above that change data.' : 'Reads never ask. This applies to actions only.'}</p>
        </div>
        <div>
          <label htmlFor={ids.expiry} className="block text-[12px] text-[var(--ink-60)]">
            Access ends
          </label>
          <select id={ids.expiry} value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)} disabled={props.disabled} data-testid="conn-grant-expiry" className={FIELD_CLASS}>
            {grant?.expiresAt && <option value="keep">Keep: {new Date(grant.expiresAt).toLocaleDateString()}</option>}
            <option value="none">No end date</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-[color:var(--ais-bad)]">
          {error}
        </p>
      )}

      {!props.disabled && (
        <div className="flex flex-wrap items-center gap-2">
          <PrimaryButton onClick={() => void save()} disabled={busy} testId="conn-grant-save">
            {grant ? 'Save access' : 'Give access'}
          </PrimaryButton>
          {grant && (
            <QuietButton danger onClick={askRemove} disabled={busy} testId="conn-grant-remove">
              Remove access
            </QuietButton>
          )}
        </div>
      )}

      {kind === 'model_api' && !props.disabled && card.models.length > 0 && (
        <div className="border-t border-[var(--edge-hairline)] pt-3">
          <label htmlFor={ids.model} className="block text-[12px] text-[var(--ink-60)]">
            Project default model
          </label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <select id={ids.model} value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} data-testid="conn-grant-default-model" className={`${FIELD_CLASS} w-auto flex-1 min-w-[160px]`}>
              {card.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <QuietButton onClick={() => void makeDefault()} disabled={busy} testId="conn-grant-default">
              Set as project default
            </QuietButton>
          </div>
          <p className="mt-1 text-[12px] text-[var(--ink-50)]">New work in {project.title} starts with this connection and model. Setting it also gives the project access to run models.</p>
        </div>
      )}
    </div>
  )
}
