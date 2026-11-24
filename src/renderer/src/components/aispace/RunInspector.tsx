// The run inspector (SPEC-AI-SPACE §1 Runs + "Show the source list in the run
// inspector"; §5 motion; SPEC-CONNECTIONS §6–7 run manifest and usage).
//
// One run, read from main's record: where it stands (and the last step Plexii
// confirmed when it can't see further), who ran it and who pays, exactly what
// it was given, its steps and any text it kept, usage with honest labels, and
// tool calls. Actions are only the ones main says are possible: Stop, Run it
// again, Continue elsewhere, Save held draft. Pausing isn't offered because no
// provider supports it yet; the inspector says so in words.
//
// Reusable: the Runs page docks or overlays it in its own Inspector panel; a
// Desk that already has an inspector panel embeds just the body (`embedded`).

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunDetailData } from '@shared/aispace/api'
import type { RunStatus } from '@shared/aispace/model'
import Icon from '../Icon'
import { confirmDialog } from '../plexi/PromptDialog'
import { useNoticeStore } from '../../stores/notice'
import { useViewStore } from '../../stores/view'
import { Inspector, LinkButton, PrimaryButton, QuietButton, StatusBadge, announce, fmtAgo, fmtDuration, fmtMoney, fmtWhen } from './ui'
import HandoverPicker from './runs/HandoverPicker'
import { ChecksList, Fact, Facts, OutputBlocks, Part, SourceList, StepsList, ToolCalls, UsageList } from './runs/RunDetailParts'
import { errorText, isActiveStatus, isTerminal, modelLabel, payerText, providerDestination, providerName, readStartAnswer, safeText, statusWord } from './runs/runText'
import { useCoalescedRefresh } from './runs/useCoalescedRefresh'

export interface RunInspectorProps {
  runId: string
  onClose: () => void
  // Docked beside the content on wide screens; an overlay otherwise.
  docked: boolean
  expanded?: boolean
  onToggleExpand?: () => void
  // Render only the body, inside a host's own Inspector (which then owns the
  // title, Close, Escape, width and expand). The project link is left out:
  // the host is the project.
  embedded?: boolean
  // Open another run (the retry, the handover, the run this one continues).
  // Defaults to that run's stable link on the Runs page.
  onOpenRun?: (runId: string) => void
  // Announce when this run finishes. The Runs page announces from its list,
  // so it leaves this off. Defaults to on when embedded, off otherwise.
  announceCompletion?: boolean
}

interface ActionResult {
  tone: 'ok' | 'bad'
  text: string
  checks?: Array<{ name: string; ok: boolean; detail: string }>
  newRunId?: string
}

// A run that stopped short can be picked up by another model with its history.
const HANDOVER_FROM: ReadonlySet<RunStatus> = new Set<RunStatus>(['failed', 'cancelled', 'unavailable'])

export default function RunInspector(props: RunInspectorProps): JSX.Element {
  const { runId, embedded = false } = props
  const announceCompletion = props.announceCompletion ?? embedded
  const [detail, setDetail] = useState<RunDetailData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'stop' | 'retry' | 'save'>(null)
  const [result, setResult] = useState<ActionResult | null>(null)
  const [handover, setHandover] = useState(false)
  const seq = useRef(0)
  const statusRef = useRef<RunStatus | null>(null)
  const projectRef = useRef<string | null>(null)
  const actionsRef = useRef<HTMLDivElement>(null)
  const outputRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const d = await window.api.aiSpace.runDetail(runId)
      if (mine !== seq.current) return
      const prev = statusRef.current
      if (announceCompletion && prev && !isTerminal(prev) && isTerminal(d.run.status)) {
        announce(`${safeText(d.run.title) || 'Run'}: ${statusWord(d.run.status)}`)
      }
      statusRef.current = d.run.status
      projectRef.current = d.run.projectId
      setDetail(d)
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError(errorText(e))
    }
  }, [runId, announceCompletion])

  const refresh = useCoalescedRefresh(load)

  // A different run: start clean, never show the previous run's numbers.
  useEffect(() => {
    statusRef.current = null
    projectRef.current = null
    setDetail(null)
    setError(null)
    setResult(null)
    setHandover(false)
    void load()
  }, [load])

  // Status changes arrive as 'run' (with its id) or, for a stop or a saved
  // draft, only as the project's activity event.
  useEffect(() => {
    const off = window.api?.aiSpace?.onChanged?.((p) => {
      if ((p.topic === 'run' && p.runId === runId) || (p.topic === 'event' && p.projectId && p.projectId === projectRef.current)) refresh()
    })
    return () => off?.()
  }, [runId, refresh])

  const openRun = (id: string): void => {
    if (props.onOpenRun) props.onOpenRun(id)
    else useViewStore.getState().go({ kind: 'airuns', runId: id })
  }

  const run = detail?.run ?? null
  const manifest = detail?.manifest ?? null

  async function stop(): Promise<void> {
    if (!run) return
    // A background run lives at the provider: stopping it is a request to them.
    if (run.externalId) {
      const ok = await confirmDialog({
        title: 'Ask the provider to cancel?',
        body: `This run is working at ${providerName(run.provider)}. Plexii will ask it to stop. Work it already did may still be billed.`,
        confirmLabel: 'Ask to cancel',
        danger: true
      })
      if (!ok) return
    }
    setBusy('stop')
    setResult(null)
    try {
      const after = (await window.api.aiSpace.cancelRun(run.id)) as { status?: RunStatus; statusDetail?: string } | null
      const st = after?.status
      if (st === 'cancelled') setResult({ tone: 'ok', text: run.externalId ? 'The provider cancelled it.' : 'Stopped.' })
      else if (st && isTerminal(st)) setResult({ tone: 'ok', text: `It ${st} before the stop arrived.${after?.statusDetail ? ` ${safeText(after.statusDetail)}` : ''}` })
      else setResult({ tone: 'ok', text: 'Asked it to stop. It shows Cancelled once that’s confirmed.' })
    } catch (e) {
      setResult({ tone: 'bad', text: `Couldn’t stop it: ${errorText(e)}` })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  async function retry(): Promise<void> {
    if (!run) return
    setBusy('retry')
    setResult(null)
    try {
      const a = readStartAnswer(await window.api.aiSpace.retryRun(run.id))
      setResult(a.ok ? { tone: 'ok', text: a.duplicate ? 'That retry had already started.' : 'Started it again as a new run.', newRunId: a.runId } : { tone: 'bad', text: `Not started: ${safeText(a.reason)}`, checks: a.checks })
    } catch (e) {
      setResult({ tone: 'bad', text: `Not started: ${errorText(e)}` })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  async function saveDraft(): Promise<void> {
    if (!run) return
    setBusy('save')
    setResult(null)
    try {
      const after = (await window.api.aiSpace.saveHeldDraft(run.id)) as { statusDetail?: string } | null
      setResult({ tone: 'ok', text: safeText(after?.statusDetail) || 'Saved the draft as a new version.' })
    } catch (e) {
      setResult({ tone: 'bad', text: `Couldn’t save the draft: ${errorText(e)}` })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  async function openProject(): Promise<void> {
    if (!run) return
    try {
      const view = await window.api.aiSpace.projectView(run.projectId)
      const nav = await import('../../lib/aiSpaceNav')
      if (nav.openProject(view.project, { tab: 'overview', item: { type: 'run', id: run.id } })) return
      useNoticeStore.getState().show({ text: 'This project has no Desk yet, so AI Space opened instead.', icon: 'info' })
    } catch (e) {
      useNoticeStore.getState().show({ text: `Couldn’t open the project: ${errorText(e)}`, icon: 'error' })
    }
    useViewStore.getState().goAiSpace()
  }

  function closeHandover(): void {
    setHandover(false)
    setTimeout(() => actionsRef.current?.querySelector<HTMLElement>('[data-testid="ais-run-handover"]')?.focus(), 0)
  }

  function showDraft(): void {
    const el = outputRef.current
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    el?.querySelector<HTMLElement>('[data-testid="ais-run-output"]')?.focus()
  }

  const title = run ? safeText(run.title) || 'Untitled run' : 'Run'
  const active = run ? isActiveStatus(run.status) : false
  const background = Boolean(run?.externalId || manifest?.background)
  const alias = manifest?.connectionAlias ?? run?.connectionAlias ?? null
  const provider = manifest?.provider ?? run?.provider ?? null
  const destination = providerDestination(provider)
  const step = run ? safeText(run.lastConfirmedStep).trim() : ''

  const body = (
    <>
      {!detail && !error && (
        <p className="text-[13.5px] text-[var(--ink-60)]" aria-busy="true">
          Loading the run…
        </p>
      )}
      {error && !detail && (
        <div role="alert" className="text-[13.5px] text-[color:var(--ais-bad)]" data-testid="ais-run-load-error">
          <p>Couldn’t load this run: {error}</p>
          <div className="mt-2">
            <LinkButton onClick={() => void load()}>Try again</LinkButton>
          </div>
        </div>
      )}
      {run && manifest && detail && (
        <div className="ais-touch" data-testid="ais-run-inspector" data-run-id={run.id}>
          {error && (
            <p role="alert" className="mb-3 text-[12.5px] text-[color:var(--ais-bad)]">
              Couldn’t refresh: {error}. Showing what Plexii last read.
            </p>
          )}

          <Part title="Status" testId="ais-run-status">
            <StatusBadge status={run.status} className="text-[13px]" />
            {run.statusDetail && <p className="mt-1.5 text-[13.5px] text-[var(--ink-80)] break-words">{safeText(run.statusDetail)}</p>}
            {step && (
              <p className="mt-1 text-[12.5px] text-[var(--ink-70)]" data-testid="ais-run-last-confirmed" title={run.lastConfirmedAt ? fmtWhen(run.lastConfirmedAt) : undefined}>
                Last confirmed: {step}
                {run.lastConfirmedAt ? `, ${fmtAgo(run.lastConfirmedAt)}` : ''}
              </p>
            )}
            {run.status === 'unavailable' && (
              <p className="mt-1 text-[12.5px] text-[var(--ink-70)]">Plexii can’t see this run right now. It may still be running at the provider, so nothing is assumed finished.</p>
            )}
            <div className="mt-2 fb-tabular text-[12px] text-[var(--ink-60)] flex flex-wrap gap-x-3">
              <span>{run.startedAt ? `Started ${fmtWhen(run.startedAt)}` : `Queued ${fmtWhen(run.createdAt)}`}</span>
              {run.endedAt && <span>Ended {fmtWhen(run.endedAt)}</span>}
              {run.endedAt && <span>Took {fmtDuration(run.endedAt - (run.startedAt ?? run.createdAt))}</span>}
            </div>

            {run.hasHeldDraft && (
              <div className="mt-3 rounded-lg border border-[color-mix(in_oklab,var(--ais-warn)_40%,transparent)] px-3 py-2" data-testid="ais-run-held-draft">
                <p className="text-[13px] text-[var(--ink-90)]">The output changed while this ran, so Plexii held the draft instead of overwriting the newer version. Read it, then save it as a new version if it’s still right.</p>
                <div className="mt-1">
                  <LinkButton onClick={showDraft}>Read the draft</LinkButton>
                </div>
              </div>
            )}

            <div ref={actionsRef} className="mt-3 flex flex-wrap items-center gap-2">
              {run.hasHeldDraft && (
                <PrimaryButton onClick={() => void saveDraft()} disabled={busy !== null} testId="ais-run-save-draft">
                  {busy === 'save' ? 'Saving…' : 'Save held draft as a new version'}
                </PrimaryButton>
              )}
              {run.canCancel && (
                <QuietButton danger icon="stop_circle" onClick={() => void stop()} disabled={busy !== null} testId="ais-run-stop" title={background ? 'Asks the provider to cancel' : 'Stops it on this Mac'}>
                  {busy === 'stop' ? 'Stopping…' : 'Stop'}
                </QuietButton>
              )}
              {run.canRetry && (
                <QuietButton icon="replay" onClick={() => void retry()} disabled={busy !== null} testId="ais-run-retry">
                  {busy === 'retry' ? 'Starting…' : 'Run it again (charged again)'}
                </QuietButton>
              )}
              {HANDOVER_FROM.has(run.status) && (
                <QuietButton icon="swap_horiz" onClick={() => setHandover((v) => !v)} disabled={busy !== null} testId="ais-run-handover">
                  Continue elsewhere
                </QuietButton>
              )}
            </div>
            {active && !run.canPause && (
              <p className="mt-2 text-[12px] text-[var(--ink-60)]" data-testid="ais-run-pause-note">
                Pause isn’t supported by this provider.
              </p>
            )}

            {result && (
              <div role={result.tone === 'bad' ? 'alert' : 'status'} className={`mt-3 text-[13px] ${result.tone === 'bad' ? 'text-[color:var(--ais-bad)]' : 'text-[var(--ink-90)]'}`} data-testid="ais-run-action-result">
                <p className="inline-flex gap-1">
                  <Icon name={result.tone === 'bad' ? 'block' : 'check_circle'} size={15} className={result.tone === 'bad' ? '' : 'text-[color:var(--ais-ok)]'} />
                  <span>{result.text}</span>
                </p>
                {result.checks && <ChecksList checks={result.checks} />}
                {result.newRunId && (
                  <div className="mt-1">
                    <LinkButton onClick={() => openRun(result.newRunId!)} testId="ais-run-open-new">
                      Open the new run
                    </LinkButton>
                  </div>
                )}
              </div>
            )}

            {handover && (
              <HandoverPicker
                run={run}
                fromConnectionId={manifest.connectionId}
                onCancel={closeHandover}
                onStarted={(id, duplicate) => {
                  setHandover(false)
                  setResult({ tone: 'ok', text: duplicate ? 'That handover had already started.' : 'Continued as a new run on the other connection.', newRunId: id })
                  refresh()
                }}
              />
            )}
          </Part>

          <Part
            title="Who ran it"
            testId="ais-run-who"
            aside={
              <LinkButton onClick={() => useViewStore.getState().goConnections(manifest.connectionId ?? undefined)} testId="ais-run-manage-connections">
                Manage connections
              </LinkButton>
            }
          >
            <Facts>
              <Fact label="Connection">{alias ?? 'No connection'}</Fact>
              <Fact label="Provider">{providerName(provider)}</Fact>
              <Fact label="Model">
                {modelLabel(provider, manifest.model ?? run.model, run.modelLabel)}
                {(manifest.model ?? run.model) && modelLabel(provider, manifest.model ?? run.model, run.modelLabel) !== (manifest.model ?? run.model) && <span className="block text-[12px] text-[var(--ink-50)]">{manifest.model ?? run.model}</span>}
              </Fact>
              <Fact label="Paid by" testId="ais-run-payer">
                {payerText(manifest.billedTo ?? run.billedTo)}
              </Fact>
              <Fact label="Credential" testId="ais-run-credential">
                {manifest.connectionId
                  ? `By reference: the key saved for ${alias ?? 'this connection'}. The run records which key it used, never the key itself.`
                  : 'None. This run didn’t use a connection.'}
              </Fact>
              <Fact label={active ? 'Data goes to' : 'Data went to'}>{destination ?? 'Not recorded'}</Fact>
            </Facts>
          </Part>

          <Part title="What it was given" testId="ais-run-given">
            <h4 className="mb-1 text-[12.5px] text-[var(--ink-60)]">Sources</h4>
            <SourceList inputs={detail.inputs} />
            {manifest.instruction && (
              <>
                <h4 className="mt-3 mb-1 text-[12.5px] text-[var(--ink-60)]">Asked to</h4>
                <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-sunken)] px-3 py-2 text-[13.5px] text-[var(--ink-90)]" data-testid="ais-run-instruction">
                  {safeText(manifest.instruction)}
                </p>
              </>
            )}
            <div className="mt-3">
              <Facts>
                <Fact label="Tools">{manifest.tools.length ? manifest.tools.join(', ') : 'None'}</Fact>
                <Fact label="Budget" testId="ais-run-budget">
                  {manifest.budgetMinor === null ? 'No project budget set' : `${fmtMoney(manifest.budgetMinor * 10_000)} project budget when it started`}
                </Fact>
                <Fact label="Where it ran" testId="ais-run-where">
                  {background
                    ? active
                      ? 'Running at the provider; keeps going if Plexii closes.'
                      : 'Ran at the provider in the background.'
                    : active
                      ? 'Running from this Mac; it stops if Plexii closes.'
                      : 'Ran from this Mac.'}
                </Fact>
                <Fact label="Provider-hosted tools">{manifest.hostedExecution ? 'Allowed' : 'Not allowed'}</Fact>
              </Facts>
            </div>
            {detail.handoverOf && (
              <p className="mt-3 text-[13px] text-[var(--ink-70)]">
                This continues an earlier run.{' '}
                <LinkButton onClick={() => openRun(detail.handoverOf!)} testId="ais-run-open-earlier">
                  Open the earlier run
                </LinkButton>
              </p>
            )}
            {detail.followUps.length > 0 && (
              <div className="mt-2 text-[13px] text-[var(--ink-70)]">
                <p>{detail.followUps.length === 1 ? 'A later run continued this one.' : `${detail.followUps.length} later runs continued this one.`}</p>
                <div className="mt-1 flex flex-wrap gap-3">
                  {detail.followUps.map((id, i) => (
                    <LinkButton key={id} onClick={() => openRun(id)}>
                      {detail.followUps.length === 1 ? 'Open it' : `Open run ${i + 1}`}
                    </LinkButton>
                  ))}
                </div>
              </div>
            )}
          </Part>

          <Part title="Steps" testId="ais-run-steps-part">
            <StepsList steps={detail.steps} />
          </Part>

          {detail.steps.some((s) => s.kind === 'output') && (
            <div ref={outputRef}>
              <Part title="Output" testId="ais-run-output-part">
                <OutputBlocks
                  steps={detail.steps}
                  label={run.hasHeldDraft ? 'Held draft' : run.status === 'failed' || run.status === 'cancelled' ? 'Partial text received before it stopped' : 'Output'}
                />
              </Part>
            </div>
          )}

          <Part title="Usage" testId="ais-run-usage-part">
            <UsageList usage={detail.usage} />
          </Part>

          {(detail.invocations.length > 0 || manifest.tools.length > 0) && (
            <Part title="Tool calls" testId="ais-run-tools-part">
              <ToolCalls invocations={detail.invocations} />
            </Part>
          )}

          {!embedded && (
            <div className="mt-6 pt-3 border-t border-[var(--edge-hairline)]">
              <LinkButton onClick={() => void openProject()} testId="ais-run-open-project">
                Open project
              </LinkButton>
            </div>
          )}
        </div>
      )}
    </>
  )

  if (embedded) return body

  return (
    <Inspector
      open
      onClose={props.onClose}
      docked={props.docked}
      expanded={props.expanded}
      onToggleExpand={props.onToggleExpand}
      title={title}
      subtitle={run ? <span className="truncate">{run.projectTitle || 'Untitled project'}</span> : undefined}
    >
      {body}
    </Inspector>
  )
}
