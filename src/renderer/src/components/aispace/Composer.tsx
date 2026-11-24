// The project composer (SPEC-AI-SPACE §1 Start and capture; SPEC-CONNECTIONS
// §6): before anything is sent it shows the project, the intended assistant
// (connection, model, payer, destination) and the sources included. An
// informal request stays a chat with the Project Manager, or becomes a task
// with a deliverable that a model run starts on.

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import Icon from '../Icon'
import type { ProjectViewData } from '@shared/aispace/api'
import type { OutputKind, RecordRef } from '@shared/aispace/model'
import { OUTPUT_KINDS, OUTPUT_KIND_LABEL } from '@shared/aispace/model'
import { capabilityPassed } from '@shared/aispace/connections'
import { useViewStore } from '../../stores/view'
import { confirmDialog } from '../plexi/PromptDialog'
import { Kbd, LinkButton, PrimaryButton, announce } from './ui'

const SINGULAR: Record<OutputKind, string> = {
  document: 'Document',
  sheet: 'Sheet',
  slides: 'Slides',
  image: 'Image',
  canvas: 'Canvas',
  site: 'Site',
  code: 'Code',
  media: 'Media',
  other: 'Other file'
}

export default function Composer(props: { view: ProjectViewData; onSent: () => void; onOpenRun?: (runId: string) => void; presetInputs?: RecordRef[]; branchId?: string | null; branchName?: string | null }): JSX.Element {
  const { view } = props
  const p = view.project
  const [mode, setMode] = useState<'chat' | 'task'>('chat')
  const [text, setText] = useState('')
  const [kind, setKind] = useState<OutputKind>('document')
  const [title, setTitle] = useState('')
  const [background, setBackground] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<{ reason: string; checks: Array<{ name: string; ok: boolean; detail: string }> } | null>(null)
  const ids = { text: useId(), conn: useId(), model: useId() }

  // Connections this project may run models on (granted + capability passed).
  const runnable = useMemo(
    () => view.eligibleConnections.filter((c) => c.kind === 'model_api' && c.granted && capabilityPassed(c, 'run_model') && c.status !== 'paused' && c.status !== 'disconnected' && c.status !== 'reconnect_required'),
    [view.eligibleConnections]
  )
  const [connectionId, setConnectionId] = useState<string>(p.defaultConnectionId ?? '')
  useEffect(() => {
    if (!connectionId || !runnable.some((c) => c.id === connectionId)) setConnectionId(runnable.find((c) => c.id === p.defaultConnectionId)?.id ?? runnable[0]?.id ?? '')
  }, [runnable, connectionId, p.defaultConnectionId])
  const conn = runnable.find((c) => c.id === connectionId) ?? null
  const [model, setModel] = useState<string>(p.defaultModel ?? '')
  useEffect(() => {
    if (conn && !conn.models.some((m) => m.id === model)) setModel(conn.defaultModel ?? conn.models[0]?.id ?? '')
  }, [conn, model])
  const canBackground = Boolean(conn && conn.providerId === 'openai')

  // Included sources: the approved brief by default, plus anything picked.
  const brief = view.outputs.find((o) => o.role === 'brief')
  const briefRef: RecordRef | null = brief?.approvedVersionId ? { type: 'version', id: brief.approvedVersionId, versionId: brief.approvedVersionId, label: `Project brief v${brief.approved?.n ?? ''}` } : null
  const [included, setIncluded] = useState<RecordRef[]>(() => [...(briefRef ? [briefRef] : []), ...(props.presetInputs ?? [])])
  useEffect(() => {
    if (props.presetInputs?.length) setIncluded((cur) => dedupe([...cur, ...props.presetInputs!]))
  }, [props.presetInputs])
  const addable = useMemo(() => {
    const out: RecordRef[] = []
    for (const o of view.outputs) {
      if (o.role === 'brief') continue
      const vid = o.approvedVersionId ?? o.latestVersionId
      if (vid) out.push({ type: 'version', id: vid, versionId: vid, label: `${o.title} ${o.approvedVersionId ? `v${o.approved?.n} (approved)` : `v${o.latest?.n}`}` })
    }
    for (const s of view.sources) out.push({ type: 'source', id: s.id, label: s.title })
    for (const d of view.decisions.filter((x) => x.status === 'approved')) out.push({ type: 'decision', id: d.id, label: d.title })
    return out.filter((r) => !included.some((i) => key(i) === key(r)))
  }, [view, included])

  async function send(): Promise<void> {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      if (mode === 'chat') {
        const r = await window.api.aiSpace.askManager(p.id, body, { inputs: included })
        if (!r.ok && r.reason) setRefusal({ reason: r.reason, checks: [] })
        else {
          setText('')
          announce(r.ran ? 'Sent to the Project Manager.' : 'The Project Manager answered from your records.')
        }
      } else {
        if (!conn) return
        const t = await window.api.aiSpace.createTask({ projectId: p.id, title: title.trim() || firstWords(body, 60), outcome: body, deliverableKind: kind, branchId: props.branchId ?? null })
        let res = await window.api.aiSpace.startRun({ projectId: p.id, connectionId: conn.id, model, instruction: body, inputs: included, aiTaskId: t.id, newOutput: { kind, title: title.trim() || t.title }, background, branchId: props.branchId ?? null })
        if (!res.ok && res.code === 'approval_required') {
          const ok = await confirmDialog({ title: 'Cost can’t be estimated', body: `Plexii has no verified price for ${model}, so it can’t check this against the project budget. Run it anyway?`, confirmLabel: 'Run anyway' })
          if (ok) res = await window.api.aiSpace.startRun({ projectId: p.id, connectionId: conn.id, model, instruction: body, inputs: included, aiTaskId: t.id, newOutput: { kind, title: title.trim() || t.title }, background, approvedUnknownCost: true, branchId: props.branchId ?? null })
        }
        if (!res.ok) setRefusal({ reason: res.reason, checks: res.checks })
        else {
          setText('')
          setTitle('')
          announce(`Run started on ${conn.alias}.`)
          props.onOpenRun?.(res.run.id)
        }
      }
      props.onSent()
    } finally {
      setBusy(false)
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void send()
    }
  }

  const field = 'fb-field rounded-lg px-2.5 h-9 text-[13px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]'
  return (
    <div className="fb-card px-4 py-3.5" data-testid="ais-composer">
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="What this becomes">
        {(['chat', 'task'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            data-testid={`ais-composer-mode-${m}`}
            className={`h-8 px-3 rounded-lg text-[13px] border focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))] ${mode === m ? 'border-[rgb(var(--accent)/0.45)] bg-[rgb(var(--accent)/0.10)] text-[rgb(var(--accent))]' : 'border-[var(--edge-soft)] text-[var(--ink-70)]'}`}
          >
            {m === 'chat' ? 'Ask the Project Manager' : 'Make it a task with a deliverable'}
          </button>
        ))}
      </div>

      <label htmlFor={ids.text} className="sr-only">
        Message
      </label>
      <textarea
        id={ids.text}
        data-testid="ais-composer-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={mode === 'chat' ? 'Ask what changed, what to do next, or for a plan…' : 'Describe the deliverable: what it is for, what it must say, how long…'}
        className="mt-3 fb-field w-full min-h-[88px] rounded-lg px-3 py-2 text-[14px] bg-[var(--surface-sunken)] border border-[var(--edge-soft)] resize-y focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
      />

      {mode === 'task' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="Deliverable name" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deliverable name" className={`${field} flex-1 min-w-[180px]`} data-testid="ais-composer-title" />
          <select aria-label="Deliverable type" value={kind} onChange={(e) => setKind(e.target.value as OutputKind)} className={field} data-testid="ais-composer-kind">
            {OUTPUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {SINGULAR[k]}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* What will be sent, where, and who pays: shown before Send. */}
      <dl className="mt-3 grid gap-1.5 text-[12.5px]" data-testid="ais-composer-summary">
        <div className="flex items-center gap-2 flex-wrap">
          <dt className="text-[var(--ink-50)] w-[78px]">Project</dt>
          <dd>
            {p.title}
            {props.branchName ? <span className="text-[var(--ink-60)]"> · branch “{props.branchName}”</span> : null}
          </dd>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <dt className="text-[var(--ink-50)] w-[78px]">Assistant</dt>
          <dd className="flex items-center gap-2 flex-wrap">
            {mode === 'chat' && !p.defaultConnectionId ? (
              <span className="text-[var(--ink-70)]">Project Manager, answering from your records (no model set)</span>
            ) : runnable.length === 0 ? (
              <span className="text-[var(--ink-70)]">No model connection can be used by this project yet.</span>
            ) : (
              <>
                <select id={ids.conn} aria-label="Connection" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className={field} data-testid="ais-composer-connection">
                  {runnable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.alias}
                    </option>
                  ))}
                </select>
                <select id={ids.model} aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} className={field} data-testid="ais-composer-model">
                  {(conn?.models ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                {conn && (
                  <span className="text-[var(--ink-60)]">
                    Paid by {conn.payer} · sent to {conn.dataDestination ?? conn.providerName}
                  </span>
                )}
              </>
            )}
            <LinkButton onClick={() => useViewStore.getState().goConnections()} testId="ais-composer-manage">
              Manage connections
            </LinkButton>
          </dd>
        </div>
        <div className="flex items-start gap-2 flex-wrap">
          <dt className="text-[var(--ink-50)] w-[78px] pt-1">Sources</dt>
          <dd className="flex flex-wrap items-center gap-1.5 min-w-0" data-testid="ais-composer-sources">
            {included.length === 0 && <span className="text-[var(--ink-60)] pt-1">None. Only your message is sent.</span>}
            {included.map((r) => (
              <span key={key(r)} className="inline-flex items-center gap-1 h-7 pl-2 pr-1 rounded-md border border-[var(--edge-soft)] text-[12.5px]">
                {r.label ?? r.type}
                <button type="button" aria-label={`Remove ${r.label ?? 'source'}`} onClick={() => setIncluded((cur) => cur.filter((x) => key(x) !== key(r)))} className="h-6 w-6 inline-flex items-center justify-center rounded text-[var(--ink-50)] hover:text-[var(--ink-100)]">
                  <Icon name="close" size={13} />
                </button>
              </span>
            ))}
            {addable.length > 0 && (
              <select
                aria-label="Add a source"
                value=""
                onChange={(e) => {
                  const r = addable.find((x) => key(x) === e.target.value)
                  if (r) setIncluded((cur) => [...cur, r])
                }}
                className={`${field} h-7`}
                data-testid="ais-composer-add-source"
              >
                <option value="">Add a source…</option>
                {addable.map((r) => (
                  <option key={key(r)} value={key(r)}>
                    {r.label}
                  </option>
                ))}
              </select>
            )}
          </dd>
        </div>
        {mode === 'task' && canBackground && (
          <div className="flex items-center gap-2">
            <dt className="text-[var(--ink-50)] w-[78px]">Run</dt>
            <dd>
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} data-testid="ais-composer-background" />
                Keep running at the provider if Plexii closes
              </label>
            </dd>
          </div>
        )}
      </dl>

      {refusal && (
        <div role="alert" className="mt-3 rounded-lg border border-[color-mix(in_oklab,var(--ais-bad)_35%,transparent)] px-3 py-2 text-[13px]" data-testid="ais-composer-refusal">
          <p className="text-[color:var(--ais-bad)]">{refusal.reason}</p>
          {refusal.checks.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 text-[12px] text-[var(--ink-70)]">
              {refusal.checks.map((c) => (
                <li key={c.name} className="flex gap-1.5">
                  <Icon name={c.ok ? 'check' : 'close'} size={13} className={c.ok ? 'text-[color:var(--ais-ok)]' : 'text-[color:var(--ais-bad)]'} />
                  <span>
                    {c.name}: {c.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-3">
        <span className="text-[12px] text-[var(--ink-50)]">
          <Kbd>⌘</Kbd> <Kbd>Enter</Kbd> to send
        </span>
        <PrimaryButton onClick={() => void send()} disabled={busy || !text.trim() || (mode === 'task' && !conn)} testId="ais-composer-send">
          {busy ? 'Sending…' : mode === 'chat' ? 'Send' : 'Start the run'}
        </PrimaryButton>
      </div>
      <p className="sr-only">
        {mode === 'task' && conn ? `Sends your message and ${included.length} sources to ${conn.providerName} as ${conn.alias}, paid by ${conn.payer}.` : ''}
      </p>
    </div>
  )
}

function key(r: RecordRef): string {
  return r.versionId ? `v:${r.versionId}` : `${r.type}:${r.id}`
}

function dedupe(list: RecordRef[]): RecordRef[] {
  const seen = new Set<string>()
  return list.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)))
}

function firstWords(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export { OUTPUT_KIND_LABEL }
