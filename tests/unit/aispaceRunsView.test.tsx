// AI Space > Runs (SPEC-AI-SPACE §1 Runs, §5 motion; SPEC-CONNECTIONS §6–7).
// The page and its inspector mounted against a stubbed window.api.aiSpace with
// a run in every status: status in words (never colour alone), "Status
// unavailable" with its last confirmed step, the three filters, the run
// manifest in the inspector (sources, payer, never a key), the four actions
// with the exact API calls, focus coming back to the row on Escape, exactly one
// announcement when a run finishes, and "New updates" instead of a list that
// reshuffles under the pointer.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionCard, RunDetailData, RunSummary } from '../../src/shared/aispace/api'
import type { RunStep } from '../../src/shared/aispace/model'

// The view store records each navigation in the open-tray lazily; that store
// is not part of this screen.
vi.mock('../../src/renderer/src/stores/openTray', () => ({ useOpenTrayStore: { getState: () => ({ open: () => undefined }) } }))

import RunsView from '../../src/renderer/src/components/aispace/RunsView'
import RunInspector from '../../src/renderer/src/components/aispace/RunInspector'
import { PromptDialogHost } from '../../src/renderer/src/components/plexi/PromptDialog'
import { useViewStore } from '../../src/renderer/src/stores/view'
import { useAnnounce } from '../../src/renderer/src/components/aispace/ui'

// React's act() only flushes and stays quiet when the environment says so.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.now()
const MIN = 60_000

function summary(p: Partial<RunSummary> & Pick<RunSummary, 'id' | 'status' | 'title'>): RunSummary {
  return {
    projectId: 'p-launch',
    aiTaskId: null,
    projectTitle: 'Spring launch',
    statusDetail: '',
    kind: 'model',
    connectionAlias: 'Writer API',
    provider: 'openai',
    model: 'gpt-5.5',
    billedTo: 'Acme Ltd',
    externalId: null,
    lastConfirmedStep: '',
    lastConfirmedAt: null,
    createdAt: NOW - 30 * MIN,
    startedAt: NOW - 29 * MIN,
    endedAt: null,
    canCancel: false,
    canPause: false,
    canRetry: false,
    hasHeldDraft: false,
    ...p
  }
}

// Newest first, as main's listRuns returns them.
function baseRuns(): RunSummary[] {
  return [
    summary({ id: 'r-queued', status: 'queued', title: 'Draft the launch email', createdAt: NOW - 1 * MIN, startedAt: null, canCancel: true }),
    summary({ id: 'r-running', status: 'running', title: 'Write the pricing FAQ', statusDetail: 'Running on Writer API · gpt-5.5.', lastConfirmedStep: 'Received 1,200 characters.', lastConfirmedAt: NOW - 2 * MIN, createdAt: NOW - 3 * MIN, startedAt: NOW - 3 * MIN, canCancel: true }),
    summary({ id: 'r-waiting', status: 'waiting', title: 'Hero copy', statusDetail: 'The output changed while this ran. Review the draft against the newer version before saving it.', lastConfirmedStep: 'Draft held for review.', lastConfirmedAt: NOW - 5 * MIN, createdAt: NOW - 8 * MIN, startedAt: NOW - 8 * MIN, hasHeldDraft: true }),
    summary({ id: 'r-unavail', status: 'unavailable', title: 'Research competitor trials', statusDetail: 'Status unavailable: the provider did not answer.', externalId: 'resp_bg_1', lastConfirmedStep: 'Started at the provider (queued).', lastConfirmedAt: NOW - 12 * MIN, createdAt: NOW - 14 * MIN, startedAt: NOW - 14 * MIN, canCancel: true }),
    summary({ id: 'r-succeeded', status: 'succeeded', title: 'Summarise the client call', statusDetail: 'Saved as v3.', createdAt: NOW - 60 * MIN, startedAt: NOW - 60 * MIN, endedAt: NOW - 58 * MIN }),
    summary({
      id: 'r-failed',
      status: 'failed',
      title: 'Image 03 caption',
      projectId: 'p-pricing',
      projectTitle: 'Pricing page',
      connectionAlias: 'Claude team',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      billedTo: null,
      statusDetail: 'The provider stopped early (max_tokens). The partial text is kept in the run.',
      createdAt: NOW - 90 * MIN,
      startedAt: NOW - 90 * MIN,
      endedAt: NOW - 89 * MIN,
      canRetry: true
    }),
    summary({ id: 'r-cancelled', status: 'cancelled', title: 'Old ad variants', statusDetail: 'Stopped.', createdAt: NOW - 120 * MIN, startedAt: NOW - 120 * MIN, endedAt: NOW - 119 * MIN, canRetry: true })
  ]
}

const KEY_SHAPED = 'sk-live-abcdefghijklmnop1234'

function detailFor(r: RunSummary): RunDetailData {
  const at = r.startedAt ?? r.createdAt
  const steps: RunStep[] = [{ runId: r.id, seq: 1, kind: 'info', text: `Sent 2 inputs to the provider as ${r.connectionAlias}.`, at }]
  if (r.id === 'r-waiting') steps.push({ runId: r.id, seq: 2, kind: 'output', text: 'Try Plexii free for 30 days.\nNo card needed.', at: at + 1000 })
  if (r.id === 'r-failed') {
    // A provider error that echoes a key must never reach the screen.
    steps.push({ runId: r.id, seq: 2, kind: 'error', text: `Provider said: bad header Authorization: Bearer ${KEY_SHAPED}`, at: at + 1000 })
    steps.push({ runId: r.id, seq: 3, kind: 'output', text: 'A partial caption about the 30-day', at: at + 2000 })
  }
  const connectionId = r.provider === 'anthropic' ? 'c-claude' : 'c-writer'
  return {
    run: r,
    manifest: {
      connectionId,
      connectionAlias: r.connectionAlias,
      billedTo: r.billedTo,
      provider: r.provider,
      model: r.model,
      inputs: [
        { type: 'version', id: 'v-brief-3' },
        { type: 'source', id: 's-email' }
      ],
      tools: r.id === 'r-failed' ? ['notion.create_page'] : [],
      hostedExecution: false,
      budgetMinor: 5000,
      instruction: 'Write the caption for image 03 from the approved brief.',
      targetOutputId: 'o-1',
      ...(r.externalId ? { background: true } : {})
    },
    inputs: [
      { ref: { type: 'version', id: 'v-brief-3' }, label: 'Project brief v3' },
      { ref: { type: 'source', id: 's-email' }, label: 'Client email: 30-day trial approved' }
    ],
    steps,
    invocations:
      r.id === 'r-failed'
        ? [
            {
              id: 'inv-1',
              runId: r.id,
              projectId: r.projectId,
              connectionId: 'c-notion',
              principal: 'agent:Writer',
              operationId: 'notion.create_page',
              inputRef: 'sha256:abc',
              outputRef: null,
              approval: { mode: 'not_required', by: null, at: null },
              status: 'uncertain',
              detail: 'The request timed out after it was sent.',
              providerRequestId: null,
              idempotencyKey: null,
              startedAt: at + 500,
              endedAt: null
            }
          ]
        : [],
    usage: [
      { id: `u-${r.id}-1`, workspaceId: 'w', projectId: r.projectId, runId: r.id, connectionId, providerId: r.provider ?? 'openai', model: r.model, inputTokens: 1200, outputTokens: 340, amountMicros: 4200, currency: 'USD', tokensSource: 'reported', amountSource: 'estimated', state: 'final', createdAt: at },
      { id: `u-${r.id}-2`, workspaceId: 'w', projectId: r.projectId, runId: r.id, connectionId, providerId: r.provider ?? 'openai', model: r.model, inputTokens: null, outputTokens: null, amountMicros: null, currency: 'USD', tokensSource: 'unavailable', amountSource: 'unavailable', state: 'final', createdAt: at }
    ],
    handoverOf: null,
    followUps: []
  }
}

function card(p: Partial<ConnectionCard> & Pick<ConnectionCard, 'id' | 'alias' | 'providerId' | 'providerName'>): ConnectionCard {
  return {
    workspaceId: 'w',
    kind: 'model_api',
    providerOrg: null,
    identity: 'org-1',
    credentialOwner: 'user:me',
    billedTo: 'Acme Ltd',
    region: null,
    endpoint: null,
    verifiedOrigin: null,
    status: 'ready',
    statusDetail: '',
    statusSince: NOW,
    pausedBy: null,
    lastCheckedAt: NOW,
    hasSecret: true,
    // The last four characters of a key: shown on the Connections page, never here.
    secretHint: '…9XQZ',
    capabilities: [],
    createdAt: NOW,
    disconnectedAt: null,
    providerAction: null,
    config: {},
    group: p.providerName,
    payer: 'Acme Ltd',
    dataDestination: 'api.openai.com',
    onThisMac: false,
    eligibleProjects: [
      { projectId: 'p-launch', title: 'Spring launch' },
      { projectId: 'p-pricing', title: 'Pricing page' }
    ],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, amountMicros: 0, unknownAmounts: 0, estimated: false },
    keySettingsUrl: null,
    billingUrl: null,
    certification: null,
    defaultModel: 'gpt-5.5',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', modalities: ['text'], usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', modalities: ['text'], usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 }
    ],
    ...p
  }
}

function cards(): ConnectionCard[] {
  return [
    card({ id: 'c-claude', alias: 'Claude team', providerId: 'anthropic', providerName: 'Claude API', dataDestination: 'api.anthropic.com', models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', modalities: ['text'], usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 }], defaultModel: 'claude-sonnet-5-5' }),
    card({ id: 'c-writer', alias: 'Writer API', providerId: 'openai', providerName: 'OpenAI API' }),
    card({ id: 'c-paused', alias: 'Spare OpenAI', providerId: 'openai', providerName: 'OpenAI API', status: 'paused' }),
    card({ id: 'c-elsewhere', alias: 'Client OpenAI', providerId: 'openai', providerName: 'OpenAI API', billedTo: 'Client Co', payer: 'Client Co', eligibleProjects: [{ projectId: 'p-launch', title: 'Spring launch' }] })
  ]
}

// ── Harness ───────────────────────────────────────────────────────────────────

let runs: RunSummary[]
let host: HTMLDivElement
let root: Root
const listeners = new Set<(p: { topic: string; projectId?: string | null; runId?: string | null }) => void>()
let said: string[]
let unsubAnnounce: () => void

const ais = {
  listRuns: vi.fn(),
  runDetail: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  handoverRun: vi.fn(),
  saveHeldDraft: vi.fn(),
  listConnections: vi.fn(),
  getContext: vi.fn(),
  projectView: vi.fn(),
  onChanged: vi.fn()
}

function Routed(): JSX.Element {
  const view = useViewStore((s) => s.view)
  return (
    <>
      <RunsView runId={view.kind === 'airuns' ? view.runId : undefined} />
      <PromptDialogHost />
    </>
  )
}

const q = <T extends Element = HTMLElement>(id: string): T => document.querySelector(`[data-testid="${id}"]`) as T
const row = (id: string): HTMLButtonElement => q<HTMLButtonElement>(`ais-run-row-${id}`)
const shownIds = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-testid="ais-runs-list"] [data-run-id]')].map((el) => el.dataset.runId!)
const settle = async (ms = 5): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}
const click = (el: Element | null): void => {
  if (!el) throw new Error('nothing to click')
  act(() => (el as HTMLElement).click())
}
const choose = (id: string, value: string): void => {
  const el = q<HTMLSelectElement>(id)
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const key = (el: Element, k: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}
const emit = (p: { topic: string; projectId?: string | null; runId?: string | null }): void => {
  act(() => {
    for (const l of [...listeners]) l(p)
  })
}
const statusLabel = (id: string): string => row(id).querySelector('[data-status]')!.lastElementChild!.textContent ?? ''

async function mount(): Promise<void> {
  act(() => root.render(<Routed />))
  await settle()
}

async function openRun(id: string): Promise<HTMLElement> {
  click(row(id))
  await settle(40)
  const el = q('ais-run-inspector')
  expect(el?.dataset.runId).toBe(id)
  return el
}

beforeEach(() => {
  runs = baseRuns()
  listeners.clear()
  for (const f of Object.values(ais)) f.mockReset()
  ais.listRuns.mockImplementation(async () => runs.map((r) => ({ ...r })))
  ais.runDetail.mockImplementation(async (id: string) => {
    const r = runs.find((x) => x.id === id)
    if (!r) throw new Error('Run not found.')
    return detailFor({ ...r })
  })
  ais.cancelRun.mockImplementation(async (id: string) => ({ id, status: 'cancelled', statusDetail: 'Cancelled at the provider.' }))
  ais.retryRun.mockResolvedValue({ ok: true, run: { id: 'r-retry-1' }, duplicate: false })
  ais.saveHeldDraft.mockResolvedValue({ id: 'r-waiting', status: 'succeeded', statusDetail: 'Saved as v4 after review.' })
  ais.listConnections.mockImplementation(async () => cards())
  ais.onChanged.mockImplementation((cb: (p: { topic: string }) => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  })
  ;(window as unknown as { api: unknown }).api = { aiSpace: ais }
  useViewStore.setState({ view: { kind: 'airuns' }, past: [], future: [] })
  said = []
  unsubAnnounce = useAnnounce.subscribe((s, prev) => {
    if (s.n !== prev.n) said.push(s.text)
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  unsubAnnounce()
})

// ── The list ──────────────────────────────────────────────────────────────────

describe('Runs list', () => {
  it('says every status in words, and an unobservable run reads "Status unavailable" with its last confirmed step and time', async () => {
    await mount()
    expect(q('ais-runs').textContent).toContain('Every AI run across your projects, and where each one stands.')
    const expected: Record<string, string> = {
      'r-queued': 'Queued',
      'r-running': 'Running',
      'r-waiting': 'Waiting for you',
      'r-unavail': 'Status unavailable',
      'r-succeeded': 'Succeeded',
      'r-failed': 'Failed',
      'r-cancelled': 'Cancelled'
    }
    for (const [id, label] of Object.entries(expected)) expect(statusLabel(id)).toBe(label)
    // Seven statuses, seven different words: colour is never the only signal.
    expect(new Set(Object.keys(expected).map(statusLabel)).size).toBe(7)

    const confirmed = (id: string): string | null => row(id).querySelector('[data-testid="ais-run-confirmed"]')?.textContent ?? null
    expect(confirmed('r-unavail')).toBe('Last confirmed: Started at the provider (queued). · 12 min ago')
    expect(confirmed('r-running')).toBe('Last confirmed: Received 1,200 characters. · 2 min ago')
    expect(confirmed('r-queued')).toBe('Nothing confirmed yet')
    // Finished runs show how long they took instead.
    expect(confirmed('r-succeeded')).toBeNull()
    expect(row('r-succeeded').textContent).toContain('Took 2 min 0 s')
  })

  it('names who pays on each row, and "Unknown payer" when nobody recorded it', async () => {
    await mount()
    const payer = (id: string): string => row(id).querySelector('[data-testid="ais-run-row-payer"]')!.textContent ?? ''
    expect(payer('r-running')).toBe('Paid by Acme Ltd')
    expect(payer('r-failed')).toBe('Unknown payer')
    expect(row('r-failed').textContent).toContain('Claude team')
    expect(row('r-failed').textContent).toContain('Claude Sonnet 5.5')
  })

  it('filters: Active, Needs you and Done pick the right rows; project and connection narrow further', async () => {
    await mount()
    expect(shownIds()).toEqual(['r-queued', 'r-running', 'r-waiting', 'r-unavail', 'r-succeeded', 'r-failed', 'r-cancelled'])

    click(q('ais-runs-filter-active'))
    expect(shownIds()).toEqual(['r-queued', 'r-running', 'r-waiting', 'r-unavail'])
    click(q('ais-runs-filter-needs'))
    expect(shownIds()).toEqual(['r-waiting', 'r-unavail', 'r-failed'])
    click(q('ais-runs-filter-done'))
    expect(shownIds()).toEqual(['r-succeeded', 'r-cancelled'])
    expect(q('ais-runs-filter-needs').textContent).toContain('3')

    click(q('ais-runs-filter-all'))
    choose('ais-runs-project', 'p-pricing')
    expect(shownIds()).toEqual(['r-failed'])
    choose('ais-runs-project', '')
    choose('ais-runs-connection', 'anthropic|Claude team')
    expect(shownIds()).toEqual(['r-failed'])
    click(q('ais-runs-filter-done'))
    expect(shownIds()).toEqual([])
    expect(q('ais-runs-none-match')).not.toBeNull()
    click(q('ais-runs-show-all'))
    expect(shownIds()).toHaveLength(7)
  })

  it('arrow keys move between rows; only one row is in the Tab order', async () => {
    await mount()
    expect([...document.querySelectorAll('[data-run-id]')].filter((el) => (el as HTMLElement).tabIndex === 0)).toHaveLength(1)
    act(() => row('r-queued').focus())
    key(row('r-queued'), 'ArrowDown')
    expect(document.activeElement).toBe(row('r-running'))
    key(row('r-running'), 'End')
    expect(document.activeElement).toBe(row('r-cancelled'))
    key(row('r-cancelled'), 'ArrowUp')
    expect(document.activeElement).toBe(row('r-failed'))
    key(row('r-failed'), 'Home')
    expect(document.activeElement).toBe(row('r-queued'))
  })

  it('with no runs at all, offers one way on: Open AI Space', async () => {
    runs = []
    await mount()
    expect(q('ais-runs-empty').textContent).toContain('No runs yet')
    click(q('ais-runs-empty-open'))
    expect(useViewStore.getState().view).toEqual({ kind: 'aispace' })
  })

  it('a failed load says why instead of showing an empty list', async () => {
    ais.listRuns.mockRejectedValue(new Error('The AI Space database is locked.'))
    await mount()
    expect(q('ais-runs-error').textContent).toContain('The AI Space database is locked.')
    expect(q('ais-runs-empty')).toBeNull()
  })
})

// ── Live updates ──────────────────────────────────────────────────────────────

describe('Live updates', () => {
  it('a run reaching "succeeded" updates its own row in place, flashes it, and is announced exactly once', async () => {
    await mount()
    const before = shownIds()
    runs = runs.map((r) => (r.id === 'r-running' ? { ...r, status: 'succeeded', statusDetail: 'Saved as v2.', endedAt: NOW, canCancel: false } : r))
    emit({ topic: 'run', projectId: 'p-launch', runId: 'r-running' })
    await settle()
    expect(statusLabel('r-running')).toBe('Succeeded')
    expect(row('r-running').classList.contains('ais-flash')).toBe(true)
    expect(shownIds()).toEqual(before)
    // The same finish reported again (a duplicate event, then its activity event).
    emit({ topic: 'run', projectId: 'p-launch', runId: 'r-running' })
    emit({ topic: 'event', projectId: 'p-launch' })
    await settle()
    expect(said).toEqual(['Write the pricing FAQ: succeeded'])
    expect(q('ais-announcer').textContent).toBe('Write the pricing FAQ: succeeded')
  })

  it('a new run shows "New updates" instead of moving the list; the list changes only when asked', async () => {
    await mount()
    const before = shownIds()
    runs = [summary({ id: 'r-new', status: 'running', title: 'Brand-new run', createdAt: NOW, startedAt: NOW, canCancel: true }), ...runs]
    emit({ topic: 'run', projectId: 'p-launch', runId: 'r-new' })
    await settle()
    expect(shownIds()).toEqual(before)
    expect(row('r-new')).toBeNull()
    const bar = q<HTMLButtonElement>('ais-new-updates')
    expect(bar?.textContent).toContain('New updates')
    click(bar)
    await settle()
    expect(shownIds()[0]).toBe('r-new')
    expect(q('ais-new-updates')).toBeNull()
  })

  it('under a filter, a run that leaves it keeps its place (with its new status) until the person asks', async () => {
    await mount()
    click(q('ais-runs-filter-active'))
    runs = runs.map((r) => (r.id === 'r-queued' ? { ...r, status: 'cancelled', endedAt: NOW, canCancel: false } : r))
    emit({ topic: 'event', projectId: 'p-launch' })
    await settle()
    expect(shownIds()).toEqual(['r-queued', 'r-running', 'r-waiting', 'r-unavail'])
    expect(statusLabel('r-queued')).toBe('Cancelled')
    click(q('ais-new-updates'))
    await settle()
    expect(shownIds()).toEqual(['r-running', 'r-waiting', 'r-unavail'])
  })
})

// ── The inspector ─────────────────────────────────────────────────────────────

describe('Run inspector', () => {
  it('shows the source list, the payer ("Unknown payer" when null), the credential by reference, and nothing key-shaped', async () => {
    await mount()
    const insp = await openRun('r-failed')
    expect(useViewStore.getState().view).toEqual({ kind: 'airuns', runId: 'r-failed' })
    expect(row('r-failed').getAttribute('aria-current')).toBe('true')
    const sources = [...insp.querySelectorAll('[data-testid="ais-run-source"]')].map((el) => el.textContent)
    expect(sources[0]).toContain('Project brief v3')
    expect(sources[1]).toContain('Client email: 30-day trial approved')
    expect(q('ais-run-payer').textContent).toBe('Unknown payer')
    expect(q('ais-run-credential').textContent).toContain('By reference')
    expect(q('ais-run-budget').textContent).toBe('US$50.00 project budget when it started')
    expect(q('ais-run-where').textContent).toBe('Ran from this Mac.')
    // Usage keeps tokens and amount labelled on their own.
    const entries = [...insp.querySelectorAll('[data-testid="ais-run-usage-entry"]')]
    expect(entries[0].querySelector('[data-testid="ais-usage-tokens-source"]')!.textContent).toBe('Reported')
    expect(entries[0].querySelector('[data-testid="ais-usage-amount-source"]')!.textContent).toBe('Estimated')
    expect(entries[1].querySelector('[data-testid="ais-usage-tokens-source"]')!.textContent).toBe('Unavailable')
    // An uncertain tool call is explained, never offered for a repeat.
    expect(insp.querySelector('[data-testid="ais-run-tool"][data-status="uncertain"]')!.textContent).toContain('The result is unknown, so Plexii won’t repeat it.')
    // The partial text is kept and shown.
    expect(q('ais-run-output').textContent).toBe('A partial caption about the 30-day')

    // The error step echoed a key: it shows redacted. The handover picker reads
    // connection cards that carry a key hint: that never shows either.
    click(q('ais-run-handover'))
    await settle()
    const text = document.body.textContent ?? ''
    expect(text).toContain('[redacted]')
    expect(text).not.toContain(KEY_SHAPED)
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    expect(text).not.toContain('9XQZ')
  })

  it('a background run says it keeps going at the provider; an active run says pause is not supported, with no pause button', async () => {
    await mount()
    const insp = await openRun('r-unavail')
    expect(q('ais-run-where').textContent).toBe('Running at the provider; keeps going if Plexii closes.')
    expect(q('ais-run-last-confirmed').textContent).toBe('Last confirmed: Started at the provider (queued)., 12 min ago')
    expect(q('ais-run-pause-note').textContent).toBe('Pause isn’t supported by this provider.')
    expect([...insp.querySelectorAll('button')].some((b) => /pause/i.test(b.textContent ?? ''))).toBe(false)
  })

  it('Run it again says it is charged again and calls retryRun with the run; the new run opens by its link', async () => {
    await mount()
    await openRun('r-failed')
    const btn = q<HTMLButtonElement>('ais-run-retry')
    expect(btn.textContent).toContain('Run it again (charged again)')
    click(btn)
    await settle()
    expect(ais.retryRun).toHaveBeenCalledTimes(1)
    expect(ais.retryRun).toHaveBeenCalledWith('r-failed')
    expect(q('ais-run-action-result').textContent).toContain('Started it again as a new run.')
    click(q('ais-run-open-new'))
    expect(useViewStore.getState().view).toEqual({ kind: 'airuns', runId: 'r-retry-1' })
  })

  it('Continue elsewhere shows the other connection’s payer and destination before confirming, shows a refusal’s reason and checks, then hands over', async () => {
    await mount()
    await openRun('r-failed')
    click(q('ais-run-handover'))
    await settle()
    const options = [...q<HTMLSelectElement>('ais-handover-connection').options]
    // The run's own connection is not offered; unusable ones say why.
    expect(options.map((o) => o.value)).toEqual(['c-writer', 'c-paused', 'c-elsewhere'])
    expect(options[1].disabled).toBe(true)
    expect(options[1].textContent).toContain('Paused')
    expect(options[2].disabled).toBe(true)
    expect(options[2].textContent).toContain('Not allowed in Pricing page')
    // Before anything is sent: who pays and where the data goes.
    expect(q('ais-handover-payer').textContent).toContain('Acme Ltd')
    expect(q('ais-handover-payer').textContent).toContain('Not the original payer (Unknown payer)')
    expect(q('ais-handover-destination').textContent).toBe('api.openai.com')
    expect(ais.handoverRun).not.toHaveBeenCalled()

    choose('ais-handover-model', 'gpt-5.4-mini')
    ais.handoverRun.mockResolvedValueOnce({
      ok: false,
      code: 'budget_exceeded',
      reason: 'This would go over the project budget.',
      checks: [
        { name: 'Project grant', ok: true, detail: 'Writer API may run models here.' },
        { name: 'Budget', ok: false, detail: 'US$48.00 of US$50.00 used.' }
      ]
    })
    click(q('ais-handover-confirm'))
    await settle()
    expect(ais.handoverRun).toHaveBeenCalledWith('r-failed', 'c-writer', 'gpt-5.4-mini')
    const refused = q('ais-handover-refused').textContent ?? ''
    expect(refused).toContain('This would go over the project budget.')
    expect(refused).toContain('US$48.00 of US$50.00 used.')

    ais.handoverRun.mockResolvedValueOnce({ ok: true, run: { id: 'r-handover-1' }, duplicate: false })
    click(q('ais-handover-confirm'))
    await settle()
    expect(ais.handoverRun).toHaveBeenCalledTimes(2)
    expect(q('ais-handover')).toBeNull()
    expect(q('ais-run-action-result').textContent).toContain('Continued as a new run on the other connection.')
    click(q('ais-run-open-new'))
    expect(useViewStore.getState().view).toEqual({ kind: 'airuns', runId: 'r-handover-1' })
  })

  it('Escape inside the handover picker closes the picker, not the inspector', async () => {
    await mount()
    await openRun('r-failed')
    click(q('ais-run-handover'))
    await settle()
    key(q('ais-handover-connection'), 'Escape')
    await settle()
    expect(q('ais-handover')).toBeNull()
    expect(q('ais-inspector')).not.toBeNull()
    expect(ais.handoverRun).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(q('ais-run-handover'))
  })

  it('Save held draft explains why it was held, shows the draft, and calls saveHeldDraft with the run', async () => {
    await mount()
    await openRun('r-waiting')
    expect(q('ais-run-held-draft').textContent).toContain('The output changed while this ran')
    expect(q('ais-run-output').textContent).toBe('Try Plexii free for 30 days.\nNo card needed.')
    click(q('ais-run-save-draft'))
    await settle()
    expect(ais.saveHeldDraft).toHaveBeenCalledWith('r-waiting')
    expect(q('ais-run-action-result').textContent).toContain('Saved as v4 after review.')
  })

  it('Stop on a background run asks first and calls nothing when cancelled; a run on this Mac stops without asking', async () => {
    await mount()
    await openRun('r-unavail')
    click(q('ais-run-stop'))
    await settle()
    expect(q('prompt-dialog').textContent).toContain('Ask the provider to cancel?')
    click(q('prompt-dialog-cancel'))
    await settle()
    expect(q('prompt-dialog')).toBeNull()
    expect(ais.cancelRun).not.toHaveBeenCalled()

    click(q('ais-run-stop'))
    await settle()
    click(q('prompt-dialog-confirm'))
    await settle()
    expect(ais.cancelRun).toHaveBeenCalledWith('r-unavail')
    expect(q('ais-run-action-result').textContent).toContain('The provider cancelled it.')

    ais.cancelRun.mockClear()
    await openRun('r-running')
    click(q('ais-run-stop'))
    await settle()
    expect(q('prompt-dialog')).toBeNull()
    expect(ais.cancelRun).toHaveBeenCalledWith('r-running')
  })

  it('Manage connections goes to the run’s connection', async () => {
    await mount()
    await openRun('r-failed')
    click(q('ais-run-manage-connections'))
    expect(useViewStore.getState().view).toEqual({ kind: 'connections', connectionId: 'c-claude' })
  })

  it('Escape closes the inspector and focus returns to the row it was opened from', async () => {
    await mount()
    act(() => row('r-succeeded').focus())
    click(row('r-succeeded'))
    await settle(40)
    expect(q('ais-inspector')).not.toBeNull()
    expect(q('ais-inspector').contains(document.activeElement)).toBe(true)
    key(document.activeElement!, 'Escape')
    await settle(10)
    expect(q('ais-inspector')).toBeNull()
    expect(useViewStore.getState().view).toEqual({ kind: 'airuns' })
    expect(document.activeElement).toBe(row('r-succeeded'))
  })

  it('a run opened by its link also hands focus to its row on Escape', async () => {
    useViewStore.setState({ view: { kind: 'airuns', runId: 'r-failed' } })
    await mount()
    await settle(40)
    expect(q('ais-run-inspector')?.dataset.runId).toBe('r-failed')
    key(document.activeElement ?? document.body, 'Escape')
    await settle(10)
    expect(q('ais-inspector')).toBeNull()
    expect(document.activeElement).toBe(row('r-failed'))
  })
})

// ── Embedded in a Desk's own inspector panel ──────────────────────────────────

describe('Run inspector embedded in a Desk', () => {
  it('renders only the body (the host owns the panel), leaves out Open project, and announces the run finishing once', async () => {
    act(() => root.render(<RunInspector runId="r-running" onClose={() => undefined} docked={false} embedded />))
    await settle()
    expect(q('ais-inspector')).toBeNull()
    expect(q('ais-run-inspector')?.dataset.runId).toBe('r-running')
    expect(q('ais-run-open-project')).toBeNull()
    expect(q('ais-run-where').textContent).toBe('Running from this Mac; it stops if Plexii closes.')

    runs = runs.map((r) => (r.id === 'r-running' ? { ...r, status: 'succeeded', endedAt: NOW, canCancel: false } : r))
    emit({ topic: 'run', projectId: 'p-launch', runId: 'r-running' })
    await settle()
    expect(q('ais-run-status').textContent).toContain('Succeeded')
    // The stop's activity event for the same project arrives too.
    emit({ topic: 'event', projectId: 'p-launch' })
    await settle()
    expect(said).toEqual(['Write the pricing FAQ: succeeded'])
  })

  it('a refused retry shows main’s reason and checks, and says nothing started', async () => {
    act(() => root.render(<RunInspector runId="r-failed" onClose={() => undefined} docked={false} embedded />))
    await settle()
    ais.retryRun.mockResolvedValueOnce({ ok: false, code: 'connection_paused', reason: 'Claude team is paused.', checks: [{ name: 'Connection status', ok: false, detail: 'Paused by you.' }] })
    click(q('ais-run-retry'))
    await settle()
    const res = q('ais-run-action-result')
    expect(res.getAttribute('role')).toBe('alert')
    expect(res.textContent).toContain('Not started: Claude team is paused.')
    expect(res.textContent).toContain('Paused by you.')
    expect(q('ais-run-open-new')).toBeNull()
  })
})
