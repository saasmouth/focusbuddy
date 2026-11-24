// Pieces of the run inspector: steps, output, usage, tool calls, policy checks.
// Usage is labelled Reported / Estimated / Unavailable, tokens and amount each
// on their own (SPEC-CONNECTIONS §7). An uncertain tool call is never retried.

import { useId, type ReactNode } from 'react'
import type { RecordRef, RunStep } from '@shared/aispace/model'
import type { Invocation, InvocationStatus, UsageEntry, UsageSource } from '@shared/aispace/connections'
import Icon from '../../Icon'
import { authorLabel, fmtMoney, fmtWhen } from '../ui'
import { safeText } from './runText'

// ── Layout ────────────────────────────────────────────────────────────────────

export function Part(props: { title: string; children: ReactNode; testId?: string; aside?: ReactNode }): JSX.Element {
  const hid = useId()
  return (
    <section aria-labelledby={hid} className="mt-6 first:mt-0" data-testid={props.testId}>
      <div className="flex items-center gap-2 mb-2">
        <h3 id={hid} className="text-[14px] font-semibold text-[var(--ink-100)]">
          {props.title}
        </h3>
        {props.aside && <div className="ml-auto">{props.aside}</div>}
      </div>
      {props.children}
    </section>
  )
}

export function Facts({ children, testId }: { children: ReactNode; testId?: string }): JSX.Element {
  return (
    <dl className="grid grid-cols-[minmax(96px,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13.5px]" data-testid={testId}>
      {children}
    </dl>
  )
}

export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <>
      <dt className="text-[12.5px] text-[var(--ink-60)] pt-px">{label}</dt>
      <dd className="text-[var(--ink-100)] min-w-0 break-words" data-testid={testId}>
        {children}
      </dd>
    </>
  )
}

export function stepTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

// ── Policy checks (a refused retry or handover) ───────────────────────────────

export function ChecksList({ checks }: { checks: Array<{ name: string; ok: boolean; detail: string }> }): JSX.Element | null {
  if (!checks.length) return null
  return (
    <ul className="mt-2 space-y-1" data-testid="ais-run-checks">
      {checks.map((c, i) => (
        <li key={`${c.name}:${i}`} className="flex gap-1.5 text-[12.5px]">
          <Icon name={c.ok ? 'check_circle' : 'cancel'} size={14} className={c.ok ? 'text-[color:var(--ais-ok)] mt-px' : 'text-[color:var(--ais-bad)] mt-px'} />
          <span className="min-w-0">
            <span className="text-[var(--ink-90)]">{c.name}</span>
            <span className="sr-only">{c.ok ? ' passed' : ' did not pass'}</span>
            {c.detail && <span className="block text-[var(--ink-60)]">{safeText(c.detail)}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Sources the run was given ─────────────────────────────────────────────────

const REF_ICON: Record<string, string> = {
  output: 'description',
  version: 'description',
  source: 'link',
  decision: 'gavel',
  task: 'task_alt',
  thread: 'forum',
  run: 'play_circle'
}

const REF_KIND: Record<string, string> = {
  output: 'Output',
  version: 'Output version',
  source: 'Source',
  decision: 'Decision',
  task: 'Task',
  thread: 'Chat',
  run: 'Run'
}

export function SourceList({ inputs }: { inputs: Array<{ ref: RecordRef; label: string }> }): JSX.Element {
  if (!inputs.length) return <p className="text-[13.5px] text-[var(--ink-60)]">No sources. The run had only its instruction.</p>
  return (
    <ul className="space-y-1" data-testid="ais-run-sources">
      {inputs.map((i, n) => (
        <li key={`${i.ref.type}:${i.ref.id}:${n}`} className="flex items-start gap-2 text-[13.5px]" data-testid="ais-run-source">
          <Icon name={REF_ICON[i.ref.type] ?? 'article'} size={15} className="text-[var(--ink-50)] mt-0.5" />
          <span className="min-w-0">
            <span className="text-[var(--ink-100)] break-words">{safeText(i.label) || REF_KIND[i.ref.type] || i.ref.type}</span>
            <span className="block text-[12px] text-[var(--ink-50)]">
              {REF_KIND[i.ref.type] ?? i.ref.type}
              {i.ref.follow === 'approved' ? ' · follows the approved version' : i.ref.versionId || i.ref.type === 'version' ? ' · this exact version' : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

// ── Steps timeline ────────────────────────────────────────────────────────────

const STEP_ICON: Record<RunStep['kind'], string> = {
  info: 'info',
  progress: 'arrow_forward',
  output: 'description',
  tool: 'build',
  error: 'error',
  usage: 'data_usage'
}

const STEP_KIND_LABEL: Record<RunStep['kind'], string> = {
  info: 'Step',
  progress: 'Progress',
  output: 'Text kept',
  tool: 'Tool',
  error: 'Problem',
  usage: 'Usage'
}

export function StepsList({ steps }: { steps: RunStep[] }): JSX.Element {
  if (!steps.length) return <p className="text-[13.5px] text-[var(--ink-60)]">No steps recorded yet.</p>
  return (
    <ol className="relative space-y-2 border-l border-[var(--edge-soft)] ml-[7px] pl-4" data-testid="ais-run-steps">
      {steps.map((s) => (
        <li key={s.seq} className="relative text-[13.5px]" data-testid="ais-run-step" data-kind={s.kind}>
          <span className={`absolute -left-[24.5px] top-0.5 inline-flex h-[15px] w-[15px] items-center justify-center rounded-full bg-[var(--surface-raised)] ${s.kind === 'error' ? 'text-[color:var(--ais-bad)]' : 'text-[var(--ink-50)]'}`}>
            <Icon name={STEP_ICON[s.kind] ?? 'circle'} size={13} />
          </span>
          <span className="flex items-baseline gap-2">
            <span className="text-[12px] text-[var(--ink-60)]">{STEP_KIND_LABEL[s.kind] ?? s.kind}</span>
            <time className="ml-auto fb-tabular text-[12px] text-[var(--ink-50)]" dateTime={new Date(s.at).toISOString()} title={fmtWhen(s.at)}>
              {stepTime(s.at)}
            </time>
          </span>
          <span className="block text-[var(--ink-90)] break-words">
            {s.kind === 'output' ? `${s.text.length.toLocaleString()} characters, shown under Output.` : safeText(s.text)}
          </span>
        </li>
      ))}
    </ol>
  )
}

// ── Output text kept with the run ─────────────────────────────────────────────

export function OutputBlocks({ steps, label }: { steps: RunStep[]; label: string }): JSX.Element | null {
  const outs = steps.filter((s) => s.kind === 'output')
  if (!outs.length) return null
  return (
    <div className="space-y-3">
      {outs.map((s, i) => (
        <figure key={s.seq} className="m-0">
          <figcaption className="mb-1 flex items-baseline gap-2 text-[12px] text-[var(--ink-60)]">
            <span>
              {label}
              {outs.length > 1 ? ` ${i + 1} of ${outs.length}` : ''}
            </span>
            <span className="ml-auto fb-tabular">
              {s.text.length.toLocaleString()} characters · {stepTime(s.at)}
            </span>
          </figcaption>
          <pre
            tabIndex={0}
            aria-label={label}
            className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--edge-soft)] bg-[var(--surface-sunken)] px-3 py-2 font-sans text-[13.5px] leading-relaxed text-[var(--ink-90)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent))]"
            data-testid="ais-run-output"
          >
            {safeText(s.text)}
          </pre>
        </figure>
      ))}
    </div>
  )
}

// ── Usage ─────────────────────────────────────────────────────────────────────

const SOURCE_LABEL: Record<UsageSource, string> = {
  reported: 'Reported',
  estimated: 'Estimated',
  unavailable: 'Unavailable'
}

const STATE_LABEL: Record<UsageEntry['state'], string> = {
  reserved: 'Held before sending (an estimate, not a charge)',
  final: 'Recorded',
  released: 'Released (not charged)'
}

function tokensText(u: UsageEntry): string {
  if (u.tokensSource === 'unavailable' || (u.inputTokens === null && u.outputTokens === null)) return 'Unavailable'
  const fmt = (n: number | null): string => (n === null ? 'unknown' : n.toLocaleString())
  return `${fmt(u.inputTokens)} in · ${fmt(u.outputTokens)} out`
}

export function UsageList({ usage }: { usage: UsageEntry[] }): JSX.Element {
  if (!usage.length) return <p className="text-[13.5px] text-[var(--ink-60)]">No usage recorded for this run.</p>
  return (
    <ul className="space-y-2" data-testid="ais-run-usage">
      {usage.map((u) => (
        <li key={u.id} className="rounded-lg border border-[var(--edge-hairline)] px-3 py-2 text-[13px]" data-testid="ais-run-usage-entry">
          <div className="flex items-baseline gap-2 text-[12px] text-[var(--ink-60)]">
            <span>{STATE_LABEL[u.state]}</span>
            {u.model && <span className="ml-auto truncate">{u.model}</span>}
          </div>
          <div className="mt-1 grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 gap-y-0.5">
            <span className="text-[var(--ink-60)]">Tokens</span>
            <span className="fb-tabular text-[var(--ink-100)]">{tokensText(u)}</span>
            <span className="text-[12px] text-[var(--ink-60)]" data-testid="ais-usage-tokens-source">
              {SOURCE_LABEL[u.tokensSource]}
            </span>
            <span className="text-[var(--ink-60)]">Amount</span>
            <span className="fb-tabular text-[var(--ink-100)]">{u.amountSource === 'unavailable' ? 'Unavailable' : fmtMoney(u.amountMicros, u.currency)}</span>
            <span className="text-[12px] text-[var(--ink-60)]" data-testid="ais-usage-amount-source">
              {SOURCE_LABEL[u.amountSource]}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

// ── Tool calls ────────────────────────────────────────────────────────────────

const INVOCATION: Record<InvocationStatus, { label: string; icon: string; cls: string }> = {
  ok: { label: 'Done', icon: 'check_circle', cls: 'text-[color:var(--ais-ok)]' },
  error: { label: 'Failed', icon: 'error', cls: 'text-[color:var(--ais-bad)]' },
  uncertain: { label: 'Result unknown', icon: 'help', cls: 'text-[color:var(--ais-warn)]' },
  blocked: { label: 'Blocked', icon: 'block', cls: 'text-[var(--ink-60)]' },
  awaiting_approval: { label: 'Waiting for your approval', icon: 'pending_actions', cls: 'text-[color:var(--ais-warn)]' }
}

function approverLabel(by: string): string {
  const who = authorLabel(by)
  return who === 'You' ? 'you' : who
}

export function ToolCalls({ invocations }: { invocations: Invocation[] }): JSX.Element {
  if (!invocations.length) return <p className="text-[13.5px] text-[var(--ink-60)]">No tool calls.</p>
  return (
    <ul className="space-y-2" data-testid="ais-run-tools">
      {invocations.map((v) => {
        const s = INVOCATION[v.status] ?? { label: v.status, icon: 'circle', cls: 'text-[var(--ink-60)]' }
        return (
          <li key={v.id} className="rounded-lg border border-[var(--edge-hairline)] px-3 py-2 text-[13px]" data-testid="ais-run-tool" data-status={v.status}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 truncate font-medium text-[var(--ink-100)]">{v.operationId}</span>
              <span className={`ml-auto inline-flex items-center gap-1 text-[12px] whitespace-nowrap ${s.cls}`}>
                <Icon name={s.icon} size={14} />
                {s.label}
              </span>
            </div>
            {v.detail && <p className="mt-0.5 text-[12.5px] text-[var(--ink-70)] break-words">{safeText(v.detail)}</p>}
            {v.status === 'uncertain' && <p className="mt-1 text-[12.5px] text-[var(--ink-80)]">The result is unknown, so Plexii won’t repeat it.</p>}
            <p className="mt-0.5 fb-tabular text-[12px] text-[var(--ink-50)]">
              {fmtWhen(v.startedAt)}
              {v.approval.by ? ` · approved by ${approverLabel(v.approval.by)}` : ''}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
