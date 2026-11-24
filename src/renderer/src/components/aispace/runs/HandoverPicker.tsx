// "Continue elsewhere": hand a run over to another model connection with its
// action history (SPEC-AI-SPACE §3 "Run fails or stops"; SPEC-CONNECTIONS §6
// "Can it switch when the provider fails?"). Choosing here IS the approval for
// the change of provider, payer and data destination, so all three are shown
// before the person confirms. A refusal shows main's reason and its checks.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ConnectionCard, RunSummary } from '@shared/aispace/api'
import { BLOCKING_STATUSES, CONNECTION_STATUS_LABEL } from '@shared/aispace/connections'
import Icon from '../../Icon'
import { useViewStore } from '../../../stores/view'
import { LinkButton, PrimaryButton, QuietButton } from '../ui'
import { ChecksList } from './RunDetailParts'
import { errorText, payerText, providerName, readStartAnswer, type RunStartAnswer } from './runText'

export interface HandoverPickerProps {
  run: RunSummary
  // The run's own connection (by reference), left out of the choices.
  fromConnectionId: string | null
  onStarted: (newRunId: string, duplicate: boolean) => void
  onCancel: () => void
}

function unusableReason(c: ConnectionCard, projectId: string, projectTitle: string): string | null {
  if (BLOCKING_STATUSES.has(c.status)) return CONNECTION_STATUS_LABEL[c.status]
  if (!c.eligibleProjects.some((p) => p.projectId === projectId)) return `Not allowed in ${projectTitle || 'this project'}`
  if (c.models.length === 0) return 'No models to choose from'
  return null
}

export default function HandoverPicker({ run, fromConnectionId, onStarted, onCancel }: HandoverPickerProps): JSX.Element {
  const [cards, setCards] = useState<ConnectionCard[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState('')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Extract<RunStartAnswer, { ok: false }> | null>(null)
  const ids = { conn: useId(), model: useId(), head: useId() }
  const firstRef = useRef<HTMLSelectElement>(null)

  const { id: runId, projectId, projectTitle } = run
  const why = (c: ConnectionCard): string | null => unusableReason(c, projectId, projectTitle)

  // Keyed on the run's identity only: the inspector refreshes the run object on
  // every event, and that must not reset a choice the person is making.
  useEffect(() => {
    let live = true
    window.api.aiSpace
      .listConnections({ kind: 'model_api' })
      .then((all) => {
        if (!live) return
        const others = all.filter((c) => c.id !== fromConnectionId)
        setCards(others)
        const first = others.find((c) => !unusableReason(c, projectId, projectTitle))
        if (first) {
          setConnectionId(first.id)
          setModel(first.defaultModel && first.models.some((m) => m.id === first.defaultModel) ? first.defaultModel : first.models[0]?.id ?? '')
        }
      })
      .catch((e) => live && setLoadError(errorText(e)))
    return () => {
      live = false
    }
  }, [fromConnectionId, runId, projectId, projectTitle])

  useEffect(() => {
    if (cards && cards.length) firstRef.current?.focus()
  }, [cards])

  const chosen = useMemo(() => cards?.find((c) => c.id === connectionId) ?? null, [cards, connectionId])
  const usable = cards?.filter((c) => !why(c)) ?? []

  function pickConnection(id: string): void {
    setConnectionId(id)
    setRefusal(null)
    const c = cards?.find((x) => x.id === id)
    setModel(c ? (c.defaultModel && c.models.some((m) => m.id === c.defaultModel) ? c.defaultModel : c.models[0]?.id ?? '') : '')
  }

  async function confirm(): Promise<void> {
    if (!chosen || !model) return
    setBusy(true)
    setRefusal(null)
    try {
      const answer = readStartAnswer(await window.api.aiSpace.handoverRun(run.id, chosen.id, model))
      if (answer.ok) onStarted(answer.runId, answer.duplicate)
      else setRefusal(answer)
    } catch (e) {
      setRefusal({ ok: false, code: 'error', reason: errorText(e), checks: [] })
    } finally {
      setBusy(false)
    }
  }

  // Escape closes this picker first, not the whole inspector.
  function onKey(e: KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }

  const field = 'fb-field w-full rounded-lg px-2.5 py-1.5 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]'
  const differentPayer = chosen && payerText(chosen.billedTo) !== payerText(run.billedTo)

  return (
    <div role="group" aria-labelledby={ids.head} onKeyDown={onKey} className="mt-3 rounded-xl border border-[var(--edge-soft)] bg-[var(--surface-base)] p-3" data-testid="ais-handover">
      <h4 id={ids.head} className="text-[13px] font-semibold text-[var(--ink-100)]">
        Continue on another connection
      </h4>
      <p className="mt-0.5 text-[12px] text-[var(--ink-60)]">It gets the same sources, plus what this run did and any partial text. It’s a new run, charged to the connection you pick.</p>
      {run.status === 'unavailable' && run.externalId && (
        <p className="mt-2 text-[12px] text-[color:var(--ais-warn)] inline-flex gap-1" data-testid="ais-handover-still-running">
          <Icon name="warning" size={14} />
          <span>This run may still be working at {providerName(run.provider)}. Stop it first if you can, or both may finish and bill.</span>
        </p>
      )}

      {!cards && !loadError && <p className="mt-3 text-[13px] text-[var(--ink-60)]">Loading connections…</p>}
      {loadError && (
        <p role="alert" className="mt-3 text-[13px] text-[color:var(--ais-bad)]">
          Couldn’t load your connections: {loadError}
        </p>
      )}

      {cards && usable.length === 0 && (
        <div className="mt-3 text-[13px] text-[var(--ink-70)]" data-testid="ais-handover-none">
          <p>{cards.length === 0 ? 'No other model connection is set up.' : 'None of your other model connections can take this run now.'}</p>
          <div className="mt-2 flex items-center gap-3">
            <LinkButton onClick={() => useViewStore.getState().goConnections()}>Manage connections</LinkButton>
            <LinkButton onClick={onCancel}>Close</LinkButton>
          </div>
        </div>
      )}

      {cards && usable.length > 0 && (
        <>
          <label htmlFor={ids.conn} className="block mt-3 text-[12px] text-[var(--ink-60)]">
            Connection
          </label>
          <select ref={firstRef} id={ids.conn} className={field} value={connectionId} onChange={(e) => pickConnection(e.target.value)} data-testid="ais-handover-connection">
            {cards.map((c) => {
              const reason = why(c)
              return (
                <option key={c.id} value={c.id} disabled={Boolean(reason)}>
                  {c.alias} · {c.providerName}
                  {reason ? ` (${reason})` : ''}
                </option>
              )
            })}
          </select>
          <label htmlFor={ids.model} className="block mt-2 text-[12px] text-[var(--ink-60)]">
            Model
          </label>
          <select id={ids.model} className={field} value={model} onChange={(e) => {
            setModel(e.target.value)
            setRefusal(null)
          }} data-testid="ais-handover-model">
            {(chosen?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          {chosen && (
            <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]" data-testid="ais-handover-summary">
              <dt className="text-[var(--ink-60)]">Paid by</dt>
              <dd className="text-[var(--ink-100)]" data-testid="ais-handover-payer">
                {chosen.payer}
                {differentPayer && <span className="block text-[12px] text-[color:var(--ais-warn)]">Not the original payer ({payerText(run.billedTo)})</span>}
              </dd>
              <dt className="text-[var(--ink-60)]">Data goes to</dt>
              <dd className="text-[var(--ink-100)] break-words" data-testid="ais-handover-destination">
                {chosen.dataDestination ?? 'Unknown destination'}
              </dd>
              <dt className="text-[var(--ink-60)]">Provider</dt>
              <dd className="text-[var(--ink-100)]">{chosen.providerName}</dd>
            </dl>
          )}

          {refusal && (
            <div role="alert" className="mt-3 rounded-lg border border-[color-mix(in_oklab,var(--ais-bad)_35%,transparent)] px-3 py-2" data-testid="ais-handover-refused">
              <p className="text-[13px] text-[color:var(--ais-bad)] inline-flex gap-1">
                <Icon name="block" size={15} />
                <span>Not started: {refusal.reason}</span>
              </p>
              <ChecksList checks={refusal.checks} />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <PrimaryButton onClick={() => void confirm()} disabled={busy || !chosen || !model} testId="ais-handover-confirm">
              {busy ? 'Starting…' : `Continue on ${chosen?.alias ?? 'this connection'}`}
            </PrimaryButton>
            <QuietButton onClick={onCancel} testId="ais-handover-cancel">
              Cancel
            </QuietButton>
          </div>
        </>
      )}
    </div>
  )
}
