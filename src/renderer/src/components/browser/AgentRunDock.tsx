import { useMemo, useState } from 'react'
import Icon from '../Icon'
import { useBrowserAgentRuns, type BrowserAgentRunState } from '../../stores/browserAgentRuns'
import { useWebPanel } from '../../stores/webPanel'
import { useViewStore } from '../../stores/view'
import { QUICK_TASKS } from '../../lib/browserQuickTasks'

// The visible run (A6/B3, AI-05): Plexii acts inside the browser panel,
// visibly, cancellable. This dock floats over the bottom of the browser
// surface and is the run's honest face — the task, the current narration,
// every step as it lands (refusals included), the R26 consent question, a
// Stop that always works, and the run's real cost so far. Card material,
// not glass: the interior is read at length (the A5.5 precedent).

// A number, or nothing, without ever throwing. These readouts are cosmetic —
// a token count and a read window — and they render inside the dock that shows
// a run's ONLY visible progress. Reaching .toLocaleString() through a field
// that happens to be missing took the whole browser surface down to an error
// card, which is a spectacular way to fail at displaying a number.
function num(v: unknown): string | null {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : null
}

function costLabel(cost: BrowserAgentRunState['cost']): string {
  if (!cost || typeof cost.costMicros !== 'number' || !Number.isFinite(cost.costMicros)) return ''
  const usd = cost.costMicros / 1_000_000
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

function actionLabel(ev: { [k: string]: unknown }): string {
  const action = ev.action as { kind?: string } | undefined
  const detail = typeof ev.detail === 'string' && ev.detail ? ev.detail : null
  switch (action?.kind) {
    case 'click':
    case 'click_at':
      return detail ? `Clicked “${detail}”` : 'Clicked'
    case 'type':
    case 'type_text':
      return detail ? `Typed into “${detail}”` : 'Typed'
    case 'select':
      return detail ? `Chose in “${detail}”` : 'Chose an option'
    case 'open_url': {
      try {
        return `Opened ${new URL(String(ev.url ?? '')).hostname.replace(/^www\./, '')}`
      } catch {
        return 'Opened a page'
      }
    }
    case 'scroll':
      return 'Scrolled'
    case 'wait':
      return 'Waited for the page'
    case 'press_key':
      return 'Pressed a key'
    default:
      return 'Acted'
  }
}

const REFUSAL_LINES: Record<string, string> = {
  credential_field: 'Held back — the sign-in is yours to do',
  credential_submit: 'Held back — the sign-in is yours to do',
  payment_field: 'Held back — payment never happens on its own',
  payment_submit: 'Held back — payment never happens on its own',
  file_transfer: 'Held back — no file transfers',
  captcha: 'Held back — a CAPTCHA needs a human',
  run_stopped: 'Stopped'
}

const HEADERS: Record<string, string> = {
  done: 'Done',
  stopped: 'Stopped',
  need_input: 'Plexii needs you',
  blocked: 'Plexii needs you',
  denied: 'Not run',
  budget: 'Paused',
  failed: 'Did not finish'
}

const OUTCOME_LINES: Record<string, string> = {
  stopped: 'Stopped.',
  denied: 'Not run — you said no.',
  budget: 'Paused — the step budget ran out.',
  failed: 'Something went wrong.'
}

export default function AgentRunDock(props: {
  askOpen: boolean
  onCloseAsk: () => void
  onOpenAsk: () => void
}): React.JSX.Element | null {
  const runs = useBrowserAgentRuns((s) => s.runs)
  const start = useBrowserAgentRuns((s) => s.start)
  const stop = useBrowserAgentRuns((s) => s.stop)
  const consent = useBrowserAgentRuns((s) => s.consent)
  const activeRunId = useWebPanel((s) => s.activeRunId)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  const [task, setTask] = useState('')
  const [stepsOpen, setStepsOpen] = useState(false)
  // AI-43: which step is expanded to its full detail (what was seen, what
  // was touched, what came back). One at a time keeps the ledger calm.
  const [expandedStep, setExpandedStep] = useState<number | null>(null)

  // The run this dock shows: the live one, else the newest finished run not
  // yet dismissed (its outcome deserves to be read, not to vanish).
  const run = useMemo(() => {
    if (activeRunId && runs[activeRunId]) return runs[activeRunId]
    const all = Object.values(runs).filter((r) => !dismissed.has(r.runId))
    return all.length ? all[all.length - 1] : null
  }, [runs, activeRunId, dismissed])

  // A preset skips the input entirely: the phrasing is already right, and
  // making someone edit it first would defeat the point of offering it.
  const runQuick = async (t: string): Promise<void> => {
    setTask('')
    props.onCloseAsk()
    await start({ task: t })
  }

  const submitTask = async (): Promise<void> => {
    const t = task.trim()
    if (!t) return
    setTask('')
    props.onCloseAsk()
    await start({ task: t })
  }

  if (run && !dismissed.has(run.runId)) {
    const acted = run.events.filter((e) => e.kind === 'acted')
    const last = acted[acted.length - 1]
    const running = run.outcome === 'running'
    const liveLine = run.pendingConsentHost
      ? ''
      : last
        ? String(last.narration || actionLabel(last))
        : 'Reading the page…'

    return (
      <div
        data-testid="agent-run-dock"
        data-outcome={run.outcome}
        className="absolute bottom-3 left-3 right-3 z-20 rounded-[var(--radius-card)] bg-[var(--surface-raised)] fb-fade-in-up"
        style={{
          boxShadow: '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)'
        }}
      >
        {run.pendingConsentHost ? (
          <div className="p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--ink-100)]">
              <Icon name="plexii:ai" size={15} />
              Let Plexii act on {run.pendingConsentHost}?
            </div>
            <div className="mt-1 text-[12px] text-[var(--ink-70)]">
              First time on this site. Everything it does stays visible here, and you can revoke
              this any time in Settings.
            </div>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                className="btn-primary !text-[12px]"
                data-testid="agent-consent-always"
                onClick={() => void consent(run.runId, true, true)}
              >
                Always allow
              </button>
              <button
                className="btn-ghost !text-[12px]"
                data-testid="agent-consent-once"
                onClick={() => void consent(run.runId, true, false)}
              >
                Just this once
              </button>
              <button
                className="btn-ghost !text-[12px]"
                data-testid="agent-consent-no"
                onClick={() => void consent(run.runId, false, false)}
              >
                No
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3">
            <div className="flex items-center gap-2">
              <Icon name="plexii:ai" size={15} className="text-[var(--ink-70)]" />
              <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink-100)]">
                {running ? 'Plexii is browsing' : HEADERS[run.outcome] ?? 'Plexii stopped'}
                <span className="ml-2 font-normal text-[var(--ink-70)]">{run.task}</span>
              </div>
              {run.cost && (
                <span
                  data-testid="agent-run-cost"
                  className="shrink-0 text-[11px] tabular-nums text-[var(--ink-70)]"
                  title={
                    num(run.cost?.inputTokens) && num(run.cost?.outputTokens)
                      ? `${num(run.cost?.inputTokens)} in / ${num(run.cost?.outputTokens)} out tokens`
                      : undefined
                  }
                >
                  {costLabel(run.cost)}
                </span>
              )}
              {running ? (
                <button
                  className="btn-ghost !px-2.5 !py-1 !text-[12px]"
                  data-testid="agent-run-stop"
                  onClick={() => void stop(run.runId)}
                >
                  Stop
                </button>
              ) : (
                <>
                  {(run.outcome === 'need_input' || run.outcome === 'blocked') && (
                    /* The auth story's second half: sign in right here (the
                       panel shares the app's one cookie jar), then let the
                       same task run again — now authenticated. */
                    <button
                      className="btn-ghost !px-2.5 !py-1 !text-[12px]"
                      data-testid="agent-run-retry"
                      onClick={() => void start({ task: run.task })}
                    >
                      Try again
                    </button>
                  )}
                  <button
                    className="icon-btn !h-6 !w-6"
                    data-testid="agent-run-dismiss"
                    title="Dismiss"
                    onClick={() => setDismissed(new Set([...dismissed, run.runId]))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </>
              )}
            </div>

            <div
              data-testid="agent-run-line"
              className="mt-1.5 text-[12px] leading-snug text-[var(--ink-70)]"
            >
              {running ? liveLine : run.summary || OUTCOME_LINES[run.outcome] || liveLine}
            </div>

            {/* What the run FOUND, and the offer to put it to work. A run used
                to end at the line above — a sentence — with everything it had
                read thrown away. The findings are the actual product, so they
                are shown, and one click routes them wherever the task meant
                them to go. */}
            {!running && run.findings && (
              <div
                data-testid="agent-run-findings"
                className="mt-2 rounded-md border border-[var(--line-20)] bg-[var(--surface-raised)] p-2"
              >
                <div className="text-[11px] font-medium text-[var(--ink-100)]">
                  {run.findings.records.length > 0
                    ? `Found ${run.findings.records.length} ${
                        run.findings.records.length === 1 ? 'result' : 'results'
                      }`
                    : 'Found an answer'}
                </div>
                {run.findings.records.length > 0 && (
                  <div className="mt-1 max-h-24 overflow-y-auto">
                    {run.findings.records.slice(0, 5).map((r, i) => (
                      <div key={i} className="truncate text-[11px] text-[var(--ink-70)]">
                        {run.findings!.fields.filter((f) => r[f]).map((f) => r[f]).join(' · ')}
                      </div>
                    ))}
                    {run.findings.records.length > 5 && (
                      <div className="text-[11px] text-[var(--ink-70)] opacity-70">
                        +{run.findings.records.length - 5} more
                      </div>
                    )}
                  </div>
                )}
                {run.findings.answer && (
                  <div className="mt-1 line-clamp-3 text-[11px] text-[var(--ink-70)]">
                    {run.findings.answer}
                  </div>
                )}
                {run.delivery.state === 'idle' ? (
                  <button
                    type="button"
                    data-testid="agent-run-use-findings"
                    className="mt-2 rounded border border-[var(--line-20)] px-2 py-1 text-[11px] font-medium text-[var(--ink-100)] hover:bg-[var(--surface-hover)]"
                    onClick={() => void useBrowserAgentRuns.getState().deliver(run.runId)}
                  >
                    Use these results
                  </button>
                ) : (
                  <div
                    data-testid="agent-run-delivery"
                    className="mt-2 text-[11px] text-[var(--ink-70)]"
                  >
                    {run.delivery.state === 'planning' ? 'Working out where this belongs…' : run.delivery.message}
                    {/* Saying what was created without saying where it went
                        leaves the user to go hunting for it — and the desk it
                        used is the last ACTIVE one, which from a desk-less
                        browser is not one they were looking at. */}
                    {run.delivery.destination && (
                      <button
                        type="button"
                        data-testid="agent-run-open-destination"
                        onClick={() => {
                          const d = run.delivery.destination
                          if (d) useViewStore.getState().go(d.view)
                        }}
                        className="mt-1.5 flex items-center gap-1 rounded border border-[var(--line-20)] px-2 py-1 text-[11px] font-medium text-[var(--ink-100)] hover:bg-[var(--surface-hover)]"
                      >
                        <Icon name={run.delivery.destination.icon} size={12} />
                        Open {run.delivery.destination.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {acted.length > 0 && (
              <div className="mt-2">
                <button
                  className="flex items-center gap-1 text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-100)]"
                  data-testid="agent-run-steps-toggle"
                  onClick={() => setStepsOpen((v) => !v)}
                >
                  <Icon
                    name="plexii:chevron-right"
                    size={12}
                    style={{ transform: stepsOpen ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
                  />
                  {acted.length} {acted.length === 1 ? 'step' : 'steps'}
                </button>
                {stepsOpen && (
                  <ol data-testid="agent-run-steps" className="mt-1.5 max-h-44 space-y-1 overflow-y-auto">
                    {acted.map((e, i) => {
                      const rw = e.readWindow as { start: number; end: number; total: number } | undefined
                      const open = expandedStep === i
                      return (
                        <li key={i} className="text-[12px]">
                          <button
                            type="button"
                            className="flex w-full items-start gap-1.5 text-left hover:text-[var(--ink-100)]"
                            data-testid={`agent-run-step-${i}`}
                            onClick={() => setExpandedStep(open ? null : i)}
                          >
                            <Icon
                              name={e.ok ? 'plexii:check' : 'close'}
                              size={13}
                              className={
                                e.ok ? 'mt-px text-[var(--ink-70)]' : 'mt-px text-[var(--ink-70)] opacity-70'
                              }
                            />
                            <span className="min-w-0 flex-1 text-[var(--ink-70)]">
                              {e.ok
                                ? actionLabel(e)
                                : `${REFUSAL_LINES[String(e.refused)] ?? `Refused (${String(e.refused)})`}${
                                    typeof e.detail === 'string' && e.detail ? ` (“${e.detail}”)` : ''
                                  }`}
                            </span>
                          </button>
                          {open && (
                            <div
                              data-testid={`agent-run-step-detail-${i}`}
                              className="ml-5 mt-1 space-y-0.5 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] text-[var(--ink-70)]"
                            >
                              {typeof e.narration === 'string' && e.narration && (
                                <div>“{e.narration}”</div>
                              )}
                              {typeof e.detail === 'string' && e.detail && (
                                <div>Target: “{e.detail}”</div>
                              )}
                              {typeof e.url === 'string' && e.url && (
                                <div className="truncate">On: {e.url}</div>
                              )}
                              {rw && num(rw.total) && rw.total > 0 && (
                                <div>
                                  Saw chars {num(rw.start) ?? '?'}–{num(rw.end) ?? '?'} of{' '}
                                  {num(rw.total)}
                                  {rw.end < rw.total ? ' (more below its scroll)' : ' (the whole page)'}
                                </div>
                              )}
                              {!e.ok && typeof e.refused === 'string' && <div>Refused: {e.refused}</div>}
                            </div>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  if (!props.askOpen) {
    // AI-44 (Caleb's B5 drive): the ask door must announce itself — a
    // quiet pill on the idle browser, not a hidden toolbar glyph.
    return (
      <button
        type="button"
        data-testid="agent-ask-pill"
        onClick={props.onOpenAsk}
        className="absolute bottom-3 right-3 z-20 inline-flex items-center gap-1.5 rounded-full bg-[var(--surface-raised)] px-3 py-1.5 text-[12px] text-[var(--ink-70)] hover:text-[var(--ink-100)] fb-press"
        style={{
          boxShadow: '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)'
        }}
      >
        <Icon name="plexii:ai" size={14} />
        Let Plexii do something here
      </button>
    )
  }

  return (
    <div
      data-testid="agent-ask-dock"
      className="absolute bottom-3 left-3 right-3 z-20 rounded-[var(--radius-card)] bg-[var(--surface-raised)] p-3 fb-fade-in-up"
      style={{
        boxShadow: '0 0 0 1px var(--edge-hairline), var(--shadow-cast), var(--shadow-inset-highlight)'
      }}
    >
      <div className="flex items-center gap-2">
        <Icon name="plexii:ai" size={15} className="shrink-0 text-[var(--ink-70)]" />
        <input
          autoFocus
          data-testid="agent-ask-input"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink-100)] placeholder:text-[var(--ink-40)] focus:outline-none"
          placeholder="What should Plexii do on this page?"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitTask()
            if (e.key === 'Escape') props.onCloseAsk()
          }}
        />
        <button className="icon-btn !h-6 !w-6" title="Close" onClick={props.onCloseAsk}>
          <Icon name="close" size={14} />
        </button>
      </div>
      {/* The blank field is the worst way to meet a capability you have never
          used: it asks you to guess what the agent can do AND how to say it.
          These are the handful of things most sessions want, already phrased
          the way the loop needs. Free text above stays the way out. */}
      <div className="mt-2 flex flex-wrap gap-1">
        {QUICK_TASKS.map((q) => (
          <button
            key={q.id}
            type="button"
            data-testid={`agent-quick-${q.id}`}
            onClick={() => void runQuick(q.task)}
            title={q.task}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-sunken)] px-2.5 py-1 text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-100)] fb-press"
          >
            <Icon name={q.icon} size={12} />
            {q.label}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-[var(--ink-50)]">
        Plexii drives this page step by step — everything visible, Stop any time. It never signs
        in, pays, or moves files.
      </div>
    </div>
  )
}
