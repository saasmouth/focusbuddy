// AI Space screens: Impact, Composer, Home, the Desk view (happy-dom, a mocked
// window.api). What matters here is what a person can see and do: inferred
// links show their evidence before any review, the past is read-only, the
// composer states payer and destination before Send, failures keep inputs.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImpactResponse, ProjectViewData, HomeData, ConnectionCard } from '../../src/shared/aispace/api'
import type { ImpactRow } from '../../src/shared/aispace/impact'

const dialogs = vi.hoisted(() => ({ confirm: vi.fn(async () => true), alert: vi.fn(async () => {}), prompt: vi.fn(async () => null) }))
vi.mock('../../src/renderer/src/components/plexi/PromptDialog', () => ({
  confirmDialog: dialogs.confirm,
  alertDialog: dialogs.alert,
  promptText: dialogs.prompt,
  promptChoice: vi.fn()
}))

import ImpactView from '../../src/renderer/src/components/aispace/ImpactView'
import Composer from '../../src/renderer/src/components/aispace/Composer'
import AiSpaceHome from '../../src/renderer/src/components/aispace/AiSpaceHome'
import AiSpaceDeskView from '../../src/renderer/src/components/aispace/AiSpaceDeskView'

let host: HTMLDivElement
let root: Root
const q = <T extends Element>(sel: string): T | null => host.querySelector(sel) as T | null
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const tid = <T extends Element>(id: string): T | null => q<T>(`[data-testid="${id}"]`)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
const click = async (el: Element | null): Promise<void> => {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}
const type = (el: Element | null, value: string): void => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const byText = (text: string | RegExp, sel = 'button'): HTMLElement | null =>
  (qa(sel).find((e) => (typeof text === 'string' ? e.textContent?.trim() === text : text.test(e.textContent ?? ''))) as HTMLElement) ?? null

const NOW = Date.UTC(2026, 10, 24, 1)

function row(): ImpactRow {
  return {
    change: { id: 'chg_dec2', kind: 'decision', title: 'Client approved a 30-day trial.', detail: 'Previously 14 days.', at: NOW - 3600_000, eventSeq: 9, source: { type: 'source', id: 'src_mail', label: 'Client email' }, changed: [] },
    affected: [
      { key: 'output:hero', ref: { type: 'output', id: 'hero', versionId: 'v2', label: 'Site hero' }, title: 'Site hero', relation: 'acted', status: 'revision_ready', reason: 'Site hero has a revision.', evidence: [{ basis: 'recorded', text: 'v2 by Writer used the brief v2.', ref: { type: 'version', id: 'v2' } }], depth: 0, proposedRevisionId: null, actions: [{ id: 'compare', label: 'Compare hero', target: { type: 'output', id: 'hero' }, payload: { a: 'v1', b: 'v2' } }], preview: null },
      { key: 'output:img', ref: { type: 'output', id: 'img', label: 'Image 03' }, title: 'Image 03', relation: 'recorded', status: 'stale', reason: 'Image 03 still says 14 days.', evidence: [{ basis: 'recorded', text: 'v1 was made by a run that used the brief v1.', ref: { type: 'run', id: 'r2' }, excerpt: 'Try it free for 14 days', matchStart: 16, matchEnd: 23 }], depth: 0, proposedRevisionId: null, actions: [{ id: 'queue_revision', label: 'Queue image 03 revision', target: { type: 'output', id: 'img' }, payload: { changeId: 'chg_dec2' } }], preview: null },
      { key: 'run:r3', ref: { type: 'run', id: 'r3', label: 'Email run' }, title: 'Email run', relation: 'recorded', status: 'will_use_old_input', reason: "Tomorrow's Email run uses the brief v1.", evidence: [], depth: 0, proposedRevisionId: null, actions: [{ id: 'update_input', label: 'Update input', target: { type: 'run', id: 'r3' }, payload: { from: { type: 'version', id: 'b1', versionId: 'b1' }, to: { type: 'version', id: 'b2', versionId: 'b2', label: 'brief v2' } } }], preview: null },
      { key: 'output:blog', ref: { type: 'output', id: 'blog', label: 'Blog post' }, title: 'Blog post', relation: 'possible', status: 'possible_match', reason: 'Blog post mentions fourteen-day.', evidence: [{ basis: 'inferred', text: 'No recorded link. The text matches the old value “14 days”.', ref: null, excerpt: 'Our fourteen-day trial lets agencies test everything.', matchStart: 4, matchEnd: 16 }], depth: 0, proposedRevisionId: null, actions: [{ id: 'confirm_link', label: 'Confirm match', target: { type: 'output', id: 'blog' } }, { id: 'dismiss_match', label: 'Not related', target: { type: 'output', id: 'blog' } }], preview: null }
    ],
    actions: [
      { id: 'compare', label: 'Compare hero', target: { type: 'output', id: 'hero' }, payload: { a: 'v1', b: 'v2' } },
      { id: 'update_input', label: 'Update input', target: { type: 'run', id: 'r3' } },
      { id: 'queue_revision', label: 'Queue image 03 revision', target: { type: 'output', id: 'img' } }
    ],
    severity: 5,
    category: 'conflict'
  }
}

function impactResponse(rows: ImpactRow[] = [row()]): ImpactResponse {
  return { asOf: NOW, leftAt: NOW - 86_400_000, result: { asOf: NOW, rows, proposedRevisions: [] }, activity: [], timeline: [{ seq: 1, at: NOW - 86_400_000 * 2, kind: 'project.created', summary: 'Project started.' }] }
}

function apiMock(overrides: Record<string, unknown> = {}) {
  const ai = {
    onChanged: vi.fn(() => () => {}),
    impact: vi.fn(async (_p: string, opts?: { asOf?: number | null }) => (opts?.asOf ? impactResponse([]) : impactResponse())),
    judgeMatch: vi.fn(async () => ({ ok: true })),
    queueRevision: vi.fn(async () => ({ ok: true, runId: 'run_9' })),
    updateRunInput: vi.fn(async () => ({ ok: true, detail: 'Now uses brief v2.' })),
    createBranch: vi.fn(async () => ({ id: 'brn_1', name: 'From date' })),
    previewBundle: vi.fn(async () => ({ title: 'Fix what “Client approved a 30-day trial” affected', activities: [
      { id: 'a1', label: 'Draft a revision of Image 03', connection: 'SaaSMouth Claude', payer: 'SaaSMouth', estimate: 'One model run', dependsOn: [] },
      { id: 'a2', label: 'Give Email run the new input', connection: 'No model call', payer: null, estimate: 'No cost', dependsOn: [] }
    ] })),
    approveBundle: vi.fn(async () => [
      { activityId: 'a1', ok: false, detail: 'Overloaded. Try again later.' },
      { activityId: 'a2', ok: true, detail: 'Now uses brief v2.' }
    ]),
    ...overrides
  }
  ;(window as unknown as { api: unknown }).api = { aiSpace: ai, nodes: { create: vi.fn() } }
  return ai
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  dialogs.confirm.mockClear()
  dialogs.confirm.mockImplementation(async () => true)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  delete (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__
})

describe('Impact view', () => {
  it('shows three stable columns and labels every relation by its basis', async () => {
    apiMock()
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={vi.fn()} onChanged={vi.fn()} />))
    await flush()
    const headers = qa('[role="columnheader"]').map((e) => e.textContent)
    expect(headers).toEqual(['What changed', 'What it affected', 'What you can do'])
    expect(host.textContent).toContain('Client approved a 30-day trial.')
    expect(host.textContent).toContain('Previously 14 days.')
    const items = qa('[data-testid="ais-impact-item"]')
    expect(items.map((i) => i.getAttribute('data-relation'))).toEqual(['acted', 'recorded', 'recorded', 'possible'])
    expect(host.textContent).toContain('Agent revised it')
    expect(host.textContent).toContain('Used this version')
    expect(host.textContent).toContain('Possible match')
  })

  it('shows an inferred match’s exact evidence before any review, recorded evidence on request', async () => {
    apiMock()
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={vi.fn()} onChanged={vi.fn()} />))
    await flush()
    // Inferred: visible without expanding, with the match highlighted.
    const marks = qa('mark').map((m) => m.textContent)
    expect(marks).toContain('fourteen-day')
    // Recorded: hidden until the row is expanded…
    expect(marks).not.toContain('14 days')
    const rowEl = tid<HTMLElement>('ais-impact-row')!
    await act(async () => {
      rowEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(rowEl.getAttribute('aria-expanded')).toBe('true')
    expect(qa('mark').map((m) => m.textContent)).toContain('14 days')
    // …and Escape folds it again.
    await act(async () => {
      rowEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(rowEl.getAttribute('aria-expanded')).toBe('false')
  })

  it('confirming or dismissing a possible match records the person’s judgement', async () => {
    const ai = apiMock()
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={vi.fn()} onChanged={vi.fn()} />))
    await flush()
    await click(byText('Confirm match'))
    expect(ai.judgeMatch).toHaveBeenCalledWith('prj_1', 'blog', 'chg_dec2', true)
    await click(byText('Not related'))
    expect(ai.judgeMatch).toHaveBeenLastCalledWith('prj_1', 'blog', 'chg_dec2', false)
  })

  it('Compare opens the output inspector on the two versions; Update input swaps the run’s input', async () => {
    const ai = apiMock()
    const onInspect = vi.fn()
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={onInspect} onChanged={vi.fn()} />))
    await flush()
    await click(tid('ais-row-action-compare'))
    expect(onInspect).toHaveBeenCalledWith({ kind: 'output', id: 'hero', versionId: 'v2', compare: ['v1', 'v2'] })
    await click(tid('ais-item-action-update_input'))
    expect(ai.updateRunInput).toHaveBeenCalledWith('r3', { type: 'version', id: 'b1', versionId: 'b1' }, { type: 'version', id: 'b2', versionId: 'b2', label: 'brief v2' })
  })

  it('a past moment is read-only, and can start a branch from that point', async () => {
    const ai = apiMock({ impact: vi.fn(async () => impactResponse()) })
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={vi.fn()} onChanged={vi.fn()} />))
    await flush()
    const sel = tid<HTMLSelectElement>('ais-asof')!
    await act(async () => {
      sel.value = 'left'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(ai.impact).toHaveBeenLastCalledWith('prj_1', { asOf: NOW - 86_400_000 })
    expect(tid('ais-impact-history-note')).toBeTruthy()
    expect(qa('[data-testid^="ais-item-action-"]').length).toBe(0)
    expect(qa('[data-testid^="ais-row-action-"]').length).toBe(0)
    await click(tid('ais-impact-branch-here'))
    expect(ai.createBranch).toHaveBeenCalled()
  })

  it('a bundle previews scope and payer, then reports each activity, keeping successes when one fails', async () => {
    const ai = apiMock()
    act(() => root.render(<ImpactView projectId="prj_1" onInspect={vi.fn()} onChanged={vi.fn()} />))
    await flush()
    await click(tid('ais-row-bundle'))
    expect(ai.previewBundle).toHaveBeenCalledWith('prj_1', 'chg_dec2')
    const modal = document.querySelector('[data-testid="ais-bundle"]')!
    expect(modal.textContent).toContain('SaaSMouth Claude')
    expect(modal.textContent).toContain('paid by SaaSMouth')
    await click(document.querySelector('[data-testid="ais-bundle-approve"]'))
    expect(ai.approveBundle).toHaveBeenCalledWith('prj_1', 'chg_dec2', ['a1', 'a2'])
    const results = [...document.querySelectorAll('[data-testid="ais-bundle-result"]')].map((e) => e.textContent ?? '')
    expect(results).toHaveLength(2)
    expect(results[0]).toContain('Overloaded. Try again later.')
    expect(results[1]).toContain('Now uses brief v2.')
  })
})

function card(over: Partial<ConnectionCard> = {}): ConnectionCard {
  return {
    id: 'con_1', workspaceId: 'ws_w', providerId: 'anthropic', kind: 'model_api', alias: 'SaaSMouth Claude', providerOrg: 'org_1', identity: 'org_1', credentialOwner: 'You', billedTo: 'SaaSMouth', region: null, endpoint: null, verifiedOrigin: null,
    status: 'ready', statusDetail: '', statusSince: NOW, pausedBy: null, lastCheckedAt: NOW, hasSecret: true, secretHint: '…wxyz',
    capabilities: [{ capability: 'run_model', state: 'passed', checkedAt: NOW, detail: '' }], createdAt: NOW, disconnectedAt: null, providerAction: null,
    config: {}, providerName: 'Claude API', group: 'Anthropic', payer: 'SaaSMouth', dataDestination: 'api.anthropic.com', onThisMac: false, eligibleProjects: [], usage: { calls: 0, inputTokens: 0, outputTokens: 0, amountMicros: 0, unknownAmounts: 0, estimated: false },
    keySettingsUrl: null, billingUrl: null, certification: null, defaultModel: 'claude-sonnet-5-5', models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', modalities: ['text'], usdPerMInput: null, usdPerMOutput: null, maxOutputTokens: 16000 }],
    ...over
  }
}

function projectView(over: Partial<ProjectViewData> = {}): ProjectViewData {
  const project = { id: 'prj_1', workspaceId: 'ws_w', deskId: 'desk_1', roomId: null, title: 'SaaSMouth launch', goal: 'Launch the new offer', briefOutputId: 'out_brief', authority: { draftRevisions: true, maxAutoFollowUps: 3 }, budgetLimitMinor: null, budgetCurrency: 'USD', defaultConnectionId: 'con_1', defaultModel: 'claude-sonnet-5-5', createdAt: NOW, updatedAt: NOW, archivedAt: null }
  return {
    project,
    workspace: { id: 'ws_w', kind: 'work', name: 'SaaSMouth', createdAt: NOW },
    tasks: [],
    outputs: [{ id: 'out_brief', projectId: 'prj_1', aiTaskId: null, branchId: null, kind: 'document', role: 'brief', title: 'Project brief', latestVersionId: 'b1', approvedVersionId: 'b1', publishedVersionId: null, domain: null, reviewState: 'approved', createdAt: NOW, updatedAt: NOW, latest: { id: 'b1', n: 1, author: 'user:me', createdAt: NOW, changeSummary: '', mediaRef: null, mediaWidth: null, mediaHeight: null, excerpt: 'Offer a 14-day trial.' }, approved: { id: 'b1', n: 1, author: 'user:me', createdAt: NOW, changeSummary: '', mediaRef: null, mediaWidth: null, mediaHeight: null, excerpt: 'Offer a 14-day trial.' }, versionCount: 1 }],
    agents: [{ id: 'agt_m', projectId: 'prj_1', name: 'Project Manager', role: 'manager', connectionId: 'con_1', model: 'claude-sonnet-5-5', instructions: '', createdAt: NOW }],
    threads: [], decisions: [], sources: [], requests: [], suggestions: [], branches: [], runs: [],
    brief: { projectId: 'prj_1', projectTitle: 'SaaSMouth launch', since: 0, headline: '1 change since you were last here.', updates: [], currentDeliverable: null, usable: [], needsYou: [], nextStep: null, bundles: [] },
    grants: [],
    eligibleConnections: [{ ...card(), granted: true }],
    spend: { spentMicros: 0, reservedMicros: 0, unknownCount: 0 },
    storageNote: 'Stored on this Mac only.',
    ...over
  }
}

describe('Composer', () => {
  it('states the project, assistant, payer, destination and sources before Send', async () => {
    apiMock()
    act(() => root.render(<Composer view={projectView()} onSent={vi.fn()} />))
    await flush()
    await click(tid('ais-composer-mode-task'))
    const summary = tid('ais-composer-summary')!.textContent!
    expect(summary).toContain('SaaSMouth launch')
    expect(summary).toContain('Paid by SaaSMouth')
    expect(summary).toContain('sent to api.anthropic.com')
    expect(tid('ais-composer-sources')!.textContent).toContain('Project brief v1')
    // No key anywhere.
    expect(host.innerHTML).not.toMatch(/sk-|wxyz/)
  })

  it('starts a task run with the included sources; a refusal shows its reason and checks and keeps the text', async () => {
    const ai = apiMock({
      createTask: vi.fn(async () => ({ id: 'tsk_1', title: 'Hero' })),
      startRun: vi.fn(async () => ({ ok: false, code: 'over_budget', reason: 'This would go over the project budget.', checks: [{ name: 'Budget', ok: false, detail: 'US$0.90 spent of US$1.00.' }] }))
    })
    act(() => root.render(<Composer view={projectView()} onSent={vi.fn()} />))
    await flush()
    await click(tid('ais-composer-mode-task'))
    type(tid('ais-composer-text'), 'Write the site hero')
    await click(tid('ais-composer-send'))
    expect(ai.startRun).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'prj_1', connectionId: 'con_1', model: 'claude-sonnet-5-5', instruction: 'Write the site hero', inputs: [{ type: 'version', id: 'b1', versionId: 'b1', label: 'Project brief v1' }], aiTaskId: 'tsk_1' }))
    expect(tid('ais-composer-refusal')!.textContent).toContain('over the project budget')
    expect(tid('ais-composer-refusal')!.textContent).toContain('Budget: US$0.90 spent of US$1.00.')
    expect(tid<HTMLTextAreaElement>('ais-composer-text')!.value).toBe('Write the site hero')
  })

  it('asks before running when the cost can’t be estimated, and only then sends with approval', async () => {
    const start = vi.fn(async (input: { approvedUnknownCost?: boolean }) => (input.approvedUnknownCost ? { ok: true, run: { id: 'run_1' }, duplicate: false } : { ok: false, code: 'approval_required', reason: 'Needs your OK.', checks: [] }))
    apiMock({ createTask: vi.fn(async () => ({ id: 'tsk_1', title: 'X' })), startRun: start })
    dialogs.confirm.mockImplementation(async () => false)
    act(() => root.render(<Composer view={projectView()} onSent={vi.fn()} />))
    await flush()
    await click(tid('ais-composer-mode-task'))
    type(tid('ais-composer-text'), 'Research competitors')
    await click(tid('ais-composer-send'))
    expect(dialogs.confirm).toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    dialogs.confirm.mockImplementation(async () => true)
    await click(tid('ais-composer-send'))
    expect(start).toHaveBeenLastCalledWith(expect.objectContaining({ approvedUnknownCost: true }))
  })
})

function homeData(over: Partial<HomeData> = {}): HomeData {
  const pv = projectView()
  return {
    since: NOW - 86_400_000,
    firstVisit: false,
    updates: [{ id: 'chg_dec2', text: 'Client approved a 30-day trial.', detail: 'Site hero has a revision. Image 03 still says 14 days.', action: { id: 'compare', label: 'Compare hero', target: { type: 'output', id: 'hero' } }, source: { type: 'source', id: 'src_mail' }, category: 'conflict', at: NOW, projectId: 'prj_1', projectTitle: 'SaaSMouth launch' }],
    needsYou: [{ id: 'nd_1', kind: 'decision', text: 'Decide: headline direction', target: { type: 'decision', id: 'dec_9' }, since: NOW, projectId: 'prj_1', projectTitle: 'SaaSMouth launch' }],
    activeRuns: [],
    projects: [{ project: pv.project, headline: '1 change since you were last here, 1 needs you.', currentDeliverable: { id: 'hero', title: 'Site hero', kind: 'site', why: 'A new version is waiting for your review.' }, needs: 1, nextStep: { text: 'Decide: headline direction', action: null } }],
    sharedIn: [],
    inbox: [],
    storageNote: 'AI Space projects are stored on this Mac only.',
    ...over
  }
}

describe('Home', () => {
  it('answers the return-to-work questions on each project card: deliverable, why, next', async () => {
    const ai = apiMock({ getContext: vi.fn(async () => ({ workspaces: [{ id: 'ws_w', kind: 'work', name: 'SaaSMouth', createdAt: NOW }], active: ['ws_w'] })), home: vi.fn(async () => homeData()), markHomeViewed: vi.fn(async () => {}) })
    act(() => root.render(<AiSpaceHome />))
    await flush()
    const cardEl = tid('ais-home-project')!
    expect(cardEl.textContent).toContain('Site hero')
    expect(cardEl.textContent).toContain('A new version is waiting for your review.')
    expect(cardEl.textContent).toContain('Decide: headline direction')
    expect(tid('ais-home-update')!.textContent).toContain('Client approved a 30-day trial.')
    expect(tid('ais-home-update')!.textContent).toContain('Open source')
    expect(host.textContent).toContain('stored on this Mac only')
    // Viewing Home moves the mark once; it resolves nothing.
    expect(ai.markHomeViewed).toHaveBeenCalledTimes(1)
  })

  it('offers one meaningful action when there is nothing yet', async () => {
    apiMock({ getContext: vi.fn(async () => ({ workspaces: [], active: [] })), home: vi.fn(async () => homeData({ projects: [], updates: [], needsYou: [] })), markHomeViewed: vi.fn(async () => {}) })
    act(() => root.render(<AiSpaceHome />))
    await flush()
    expect(tid('ais-home-empty-new')!.textContent).toContain('Start a project')
  })

  it('is not available in the browser runtime', async () => {
    ;(globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ = true
    const ai = apiMock({ getContext: vi.fn(async () => ({ workspaces: [], active: [] })), home: vi.fn(async () => homeData()), markHomeViewed: vi.fn(async () => {}) })
    act(() => root.render(<AiSpaceHome />))
    await flush()
    expect(tid('ais-home-unavailable')).toBeTruthy()
    expect(tid('ais-home')).toBeNull()
    expect(ai.markHomeViewed).not.toHaveBeenCalled()
  })
})

describe('Desk AI view', () => {
  it('offers to start a project on a Desk that has none', async () => {
    apiMock({ projectForDesk: vi.fn(async () => null) })
    act(() => root.render(<AiSpaceDeskView taskId="desk_1" />))
    await flush()
    expect(tid('ais-desk-start')!.textContent).toContain('Start an AI project')
  })

  it('shows the project with the four-way switcher, and takes ⌘⇧K for the project switcher without leaking it to the app', async () => {
    const pv = projectView()
    apiMock({
      projectForDesk: vi.fn(async () => pv.project),
      projectView: vi.fn(async () => pv),
      getContext: vi.fn(async () => ({ workspaces: [pv.workspace!], active: ['ws_w'] })),
      managerThread: vi.fn(async () => ({ thread: { id: 'thr_m' }, messages: [] })),
      markProjectViewed: vi.fn(async () => {}),
      home: vi.fn(async () => homeData())
    })
    act(() => root.render(<AiSpaceDeskView taskId="desk_1" />))
    await flush()
    expect(tid('ais-project-title')!.textContent).toBe('SaaSMouth launch')
    expect(qa('[role="tab"]').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual(['Overview', 'Tasks', 'Outputs', 'Impact'])
    expect(tid('ais-return-brief')!.textContent).toContain('1 change since you were last here.')
    const appWide = vi.fn()
    window.addEventListener('keydown', appWide)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true, bubbles: true }))
    })
    await flush()
    window.removeEventListener('keydown', appWide)
    expect(document.querySelector('[data-testid="ais-switcher"]')).toBeTruthy()
    expect(appWide).not.toHaveBeenCalled()
  })
})

import BranchReview from '../../src/renderer/src/components/aispace/BranchReview'

describe('Branch review (exercise branches)', () => {
  function branchView(): ProjectViewData {
    const pv = projectView()
    const meta = (id: string, n: number, excerpt: string) => ({ id, n, author: 'agent:Writer', createdAt: NOW, changeSummary: '', mediaRef: null, mediaWidth: null, mediaHeight: null, excerpt })
    const out = (id: string, title: string, branchId: string | null, vid: string, text: string) => ({ id, projectId: 'prj_1', aiTaskId: null, branchId, kind: 'document' as const, role: 'deliverable' as const, title, latestVersionId: vid, approvedVersionId: null, publishedVersionId: null, domain: null, reviewState: 'draft' as const, createdAt: NOW, updatedAt: NOW, latest: meta(vid, 1, text), approved: null, versionCount: 1 })
    return {
      ...pv,
      branches: [
        { id: 'brn_bold', projectId: 'prj_1', name: 'Bold', snapshot: { briefVersionId: 'b1', outputVersions: { out_main: 'mv1' } }, status: 'open', createdAt: NOW },
        { id: 'brn_calm', projectId: 'prj_1', name: 'Calm', snapshot: { briefVersionId: 'b1', outputVersions: { out_main: 'mv1' } }, status: 'open', createdAt: NOW }
      ],
      outputs: [...pv.outputs, out('out_main', 'Hero', null, 'mv1', 'Try it free.'), out('out_bold', 'Hero (Bold)', 'brn_bold', 'bv1', 'Start winning today.'), out('out_calm', 'Hero (Calm)', 'brn_calm', 'cv1', 'A calmer way to grow.')]
    }
  }

  it('compares two directions side by side and brings a selection back to main with a diff', async () => {
    const ai = apiMock({
      listVersions: vi.fn(async (id: string) => ({ output: { id, latestVersionId: id === 'out_main' ? 'mv1' : 'bv1' }, versions: [{ id: id === 'out_main' ? 'mv1' : 'bv1', content: id === 'out_main' ? 'Try it free.' : 'Start winning today.', sources: [{ type: 'version', id: 'b1', label: 'Project brief v1' }] }] })),
      applyBranchSelection: vi.fn(async () => ({ ok: true, version: { id: 'mv2', n: 2 } }))
    })
    act(() => root.render(<BranchReview view={branchView()} onChanged={async () => {}} />))
    await flush()
    expect(qa('[data-testid="ais-branch-column"]').map((c) => c.querySelector('h3')!.textContent!.replace('call_split', ''))).toEqual(['Bold', 'Calm'])
    await click(qa('[data-testid="ais-branch-diff"]')[0])
    const diff = tid('ais-branch-diffview')!.textContent!
    expect(diff).toContain('Removed: Try it free.')
    expect(diff).toContain('Added: Start winning today.')
    expect(host.textContent).toContain('Made from: Project brief v1')
    await click(tid('ais-branch-apply'))
    expect(ai.applyBranchSelection).toHaveBeenCalledWith({ branchId: 'brn_bold', mainOutputId: 'out_main', fromVersionId: 'bv1', resolvedAgainstVersionId: undefined })
    expect(host.textContent).toContain('Brought back as Hero v2.')
  })

  it('refuses when main changed during the review, shows the newer text, and applies only once resolved', async () => {
    const apply = vi.fn(async (input: { resolvedAgainstVersionId?: string | null }) => (input.resolvedAgainstVersionId ? { ok: true, version: { id: 'mv3', n: 3 } } : { ok: false, conflict: true, message: 'changed', currentVersionId: 'mv2', currentContent: 'Try it free for 30 days.' }))
    apiMock({ listVersions: vi.fn(async (id: string) => ({ output: { id, latestVersionId: 'x' }, versions: [{ id: 'x', content: 'text', sources: [] }] })), applyBranchSelection: apply })
    act(() => root.render(<BranchReview view={branchView()} onChanged={async () => {}} />))
    await flush()
    await click(qa('[data-testid="ais-branch-diff"]')[0])
    await click(tid('ais-branch-apply'))
    expect(tid('ais-branch-conflict')!.textContent).toContain('Try it free for 30 days.')
    expect(apply).toHaveBeenCalledTimes(1)
    await click(tid('ais-branch-resolve'))
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ resolvedAgainstVersionId: 'mv2' }))
    expect(tid('ais-branch-conflict')).toBeNull()
  })
})

describe('automatic drafts opt-in', () => {
  it('is off by default, and turning it on first says where, as whom and what gets sent', async () => {
    const pv = projectView({ project: { ...projectView().project, authority: { draftRevisions: false, maxAutoFollowUps: 3 } } })
    const update = vi.fn(async () => pv.project)
    apiMock({
      projectForDesk: vi.fn(async () => pv.project),
      projectView: vi.fn(async () => pv),
      getContext: vi.fn(async () => ({ workspaces: [pv.workspace!], active: ['ws_w'] })),
      managerThread: vi.fn(async () => ({ thread: { id: 'thr_m' }, messages: [] })),
      markProjectViewed: vi.fn(async () => {}),
      updateProject: update
    })
    act(() => root.render(<AiSpaceDeskView taskId="desk_1" />))
    await flush()
    const box = tid<HTMLInputElement>('ais-authority-drafts')!
    expect(box.checked).toBe(false)
    dialogs.confirm.mockImplementation(async () => false)
    await click(box)
    const asked = dialogs.confirm.mock.calls[0][0] as { body: string }
    expect(asked.body).toContain('SaaSMouth Claude')
    expect(asked.body).toContain('sent to api.anthropic.com')
    expect(asked.body).toContain('paid by SaaSMouth')
    expect(asked.body).toContain('the new input and the current version of that output')
    expect(update).not.toHaveBeenCalled()
    dialogs.confirm.mockImplementation(async () => true)
    await click(tid('ais-authority-drafts'))
    expect(update).toHaveBeenCalledWith('prj_1', { authority: { draftRevisions: true, maxAutoFollowUps: 3 } })
  })
})
