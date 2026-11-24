// Connections screen (docs/ai-space/SPEC-CONNECTIONS.md §1, §2, §6, §7).
//
// Mounted the way MainPane mounts it: the page is keyed on the whole view, so
// opening and closing the side panel (which changes the view) remounts the
// page. The bridge is a stub with realistic records: two Anthropic identities
// ("Personal Claude" in a personal workspace, "SaaSMouth Claude" in a work
// one), a Claude web account, a remote MCP server with a tool nobody has
// classified, an MCP server on this Mac, and a Notion app API.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccessImpactData, ConnectionCard, ConnectionDetailData, RunSummary } from '../../src/shared/aispace/api'
import type { CapabilityHealth, Connection, ConnectionConfig, Invocation, OperationDef, UsageEntry } from '../../src/shared/aispace/connections'
import { MCP_CATALOGUE, PROVIDERS } from '../../src/shared/aispace/catalogue'
import ConnectionsView from '../../src/renderer/src/components/aispace/ConnectionsView'
import ConnectionsSection from '../../src/renderer/src/components/settings/ConnectionsSection'
import { resetConnectionsScreen } from '../../src/renderer/src/components/aispace/connections/model'
import { useViewStore } from '../../src/renderer/src/stores/view'

// React's act() needs this set to apply updates fired from outside a test step.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FAKE_KEY = 'sk-ant-api03-TESTKEY-not-a-real-one-9f8e7d6c5b4a'
const FAKE_TOKEN = 'lin_oauth_FAKE_TOKEN_0123456789abcdef'
const T0 = Date.now() - 2 * 60 * 60 * 1000

const WORKSPACES = [
  { id: 'ws_p', kind: 'personal' as const, name: 'Personal', createdAt: T0 },
  { id: 'ws_w', kind: 'work' as const, name: 'SaaSMouth', createdAt: T0 }
]
const PROJECTS: Record<string, Array<{ id: string; title: string }>> = {
  ws_p: [{ id: 'p_home', title: 'Home budget' }],
  ws_w: [
    { id: 'p_launch', title: 'Spring launch' },
    { id: 'p_site', title: 'Site refresh' }
  ]
}

function def(id: string) {
  const d = PROVIDERS.find((p) => p.id === id)
  if (!d) throw new Error(`no provider ${id}`)
  return d
}

function cap(capability: CapabilityHealth['capability'], state: CapabilityHealth['state'], detail = ''): CapabilityHealth {
  return { capability, state, checkedAt: T0, detail }
}

function card(p: Partial<Connection> & { id: string; providerId: string; workspaceId: string; alias: string }, extra: Partial<ConnectionCard> = {}, config: ConnectionConfig = {}): ConnectionCard {
  const d = def(p.providerId)
  const base: Connection = {
    kind: d.kind,
    providerOrg: null,
    identity: null,
    credentialOwner: 'You',
    billedTo: null,
    region: null,
    endpoint: null,
    verifiedOrigin: null,
    status: 'ready',
    statusDetail: '',
    statusSince: T0,
    pausedBy: null,
    lastCheckedAt: T0,
    hasSecret: false,
    secretHint: null,
    capabilities: [],
    createdAt: T0,
    disconnectedAt: null,
    providerAction: null,
    ...p
  }
  return {
    ...base,
    config,
    providerName: d.name,
    group: d.group,
    payer: base.billedTo ?? 'Unknown payer',
    dataDestination: base.endpoint ? new URL(base.endpoint).host : d.dataDestination,
    onThisMac: Boolean(config.localEndpoint),
    eligibleProjects: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, amountMicros: 0, unknownAmounts: 0, estimated: false },
    keySettingsUrl: d.keySettingsUrl,
    billingUrl: d.billingUrl,
    certification: d.certification,
    defaultModel: config.defaultModel ?? d.models[0]?.id ?? null,
    models: d.models,
    ...extra
  }
}

function op(o: Partial<OperationDef> & { id: string; title: string; classification: OperationDef['classification'] }, suggestedClass: 'read' | 'write' | null = null): OperationDef & { suggestedClass: 'read' | 'write' | null } {
  return {
    connectionId: null,
    adapter: 'x',
    description: '',
    scope: null,
    destination: 'example.com',
    inputSchema: {},
    outputSchema: null,
    schemaVersion: 1,
    schemaHash: 'h',
    rateLimitPerMinute: 60,
    timeoutMs: 10000,
    retry: o.classification === 'write' ? 'never' : 'safe_read',
    reviewState: 'approved',
    origin: 'catalogue',
    ...o,
    suggestedClass
  }
}

function run(p: Partial<RunSummary> & { id: string; title: string }): RunSummary {
  return {
    projectId: 'p_launch',
    aiTaskId: null,
    projectTitle: 'Spring launch',
    status: 'running',
    statusDetail: '',
    kind: 'model',
    connectionAlias: 'SaaSMouth Claude',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    billedTo: 'SaaSMouth Ltd',
    externalId: null,
    lastConfirmedStep: '',
    lastConfirmedAt: null,
    createdAt: T0,
    startedAt: T0,
    endedAt: null,
    canCancel: true,
    canPause: false,
    canRetry: false,
    hasHeldDraft: false,
    ...p
  }
}

function fixtures() {
  const cards: ConnectionCard[] = [
    card({ id: 'c_pers', providerId: 'anthropic', workspaceId: 'ws_p', alias: 'Personal Claude', providerOrg: 'Jane Doe', identity: 'org_personal', hasSecret: true, secretHint: '…ab12', capabilities: [cap('run_model', 'passed', 'Listed 4 models.')] }, { eligibleProjects: [{ projectId: 'p_home', title: 'Home budget' }] }),
    card(
      { id: 'c_saas', providerId: 'anthropic', workspaceId: 'ws_w', alias: 'SaaSMouth Claude', providerOrg: 'SaaSMouth Ltd', identity: 'org_saas', billedTo: 'SaaSMouth Ltd', hasSecret: true, secretHint: '…cd34', capabilities: [cap('run_model', 'passed'), cap('cancel_run', 'failed', 'Not offered for this model.')] },
      { eligibleProjects: [{ projectId: 'p_launch', title: 'Spring launch' }], usage: { calls: 3, inputTokens: 3200, outputTokens: 900, amountMicros: 41000, unknownAmounts: 1, estimated: true } }
    ),
    card({ id: 'c_web', providerId: 'claude_web', workspaceId: 'ws_w', alias: 'Claude', credentialOwner: 'Your browser', capabilities: [cap('open_source', 'passed'), cap('import', 'passed')] }),
    card({ id: 'c_mcp', providerId: 'mcp_remote', workspaceId: 'ws_w', alias: 'Linear', endpoint: 'https://mcp.linear.app/mcp', verifiedOrigin: 'https://mcp.linear.app', providerOrg: 'Linear', hasSecret: true, capabilities: [cap('call_tool', 'passed'), cap('read_resource', 'unsupported')] }, {}, { authMode: 'oauth' }),
    card({ id: 'c_local', providerId: 'mcp_remote', workspaceId: 'ws_w', alias: 'Local tools', endpoint: 'http://localhost:3333/mcp', verifiedOrigin: 'http://localhost:3333', credentialOwner: 'No sign-in', capabilities: [cap('call_tool', 'passed')] }, {}, { authMode: 'none', localEndpoint: true }),
    card({ id: 'c_notion', providerId: 'notion', workspaceId: 'ws_w', alias: 'SaaSMouth Notion', providerOrg: 'SaaSMouth', hasSecret: true, secretHint: '…ef56', capabilities: [cap('app_read', 'passed'), cap('app_write', 'untested')] })
  ]
  const operations: Record<string, ConnectionDetailData['operations']> = {
    c_mcp: [
      op({ id: 'mcp:c_mcp:list_issues', title: 'List issues', classification: 'read', origin: 'mcp', destination: 'mcp.linear.app' }, 'read'),
      op({ id: 'mcp:c_mcp:create_issue', title: 'Create issue', classification: 'write', origin: 'mcp', destination: 'mcp.linear.app' }, 'write'),
      op({ id: 'mcp:c_mcp:mystery', title: 'Mystery tool', classification: 'unknown', reviewState: 'needs_review', origin: 'mcp', destination: 'mcp.linear.app' }, 'read')
    ],
    c_notion: [
      op({ id: 'notion.whoami', title: 'Who am I', classification: 'read', destination: 'api.notion.com' }),
      op({ id: 'notion.search', title: 'Search pages', classification: 'read', destination: 'api.notion.com' }),
      op({ id: 'notion.create_draft_page', title: 'Create a draft page', classification: 'write', destination: 'api.notion.com' })
    ]
  }
  const usage: Record<string, UsageEntry[]> = {
    c_saas: [
      { id: 'u1', workspaceId: 'ws_w', projectId: 'p_launch', runId: 'r1', connectionId: 'c_saas', providerId: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1200, outputTokens: 400, amountMicros: 21000, currency: 'USD', tokensSource: 'reported', amountSource: 'estimated', state: 'final', createdAt: T0 },
      { id: 'u2', workspaceId: 'ws_w', projectId: 'p_launch', runId: 'r2', connectionId: 'c_saas', providerId: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 300, amountMicros: 20000, currency: 'USD', tokensSource: 'reported', amountSource: 'estimated', state: 'final', createdAt: T0 },
      { id: 'u3', workspaceId: 'ws_w', projectId: 'p_site', runId: 'r3', connectionId: 'c_saas', providerId: 'anthropic', model: 'claude-fable-5-2', inputTokens: 1000, outputTokens: 200, amountMicros: null, currency: 'USD', tokensSource: 'reported', amountSource: 'unavailable', state: 'final', createdAt: T0 }
    ]
  }
  const invocations: Record<string, Invocation[]> = {
    c_notion: [
      { id: 'inv_unsure', runId: null, projectId: 'p_launch', connectionId: 'c_notion', principal: 'agent:Writer', operationId: 'notion.create_draft_page', inputRef: 'h1', outputRef: null, approval: { mode: 'ask_each_time', by: 'user:me', at: T0 }, status: 'uncertain', detail: 'The request timed out after it was sent.', providerRequestId: null, idempotencyKey: null, startedAt: T0, endedAt: T0 },
      { id: 'inv_wait', runId: 'r9', projectId: 'p_launch', connectionId: 'c_notion', principal: 'agent:Writer', operationId: 'notion.create_draft_page', inputRef: 'h2', outputRef: null, approval: { mode: 'ask_each_time', by: null, at: null }, status: 'awaiting_approval', detail: '', providerRequestId: null, idempotencyKey: null, startedAt: T0, endedAt: null }
    ]
  }
  return { cards, operations, usage, invocations }
}

const IMPACT: AccessImpactData = {
  projects: [{ id: 'p_launch', title: 'Spring launch' }],
  agents: [{ id: 'ag_writer', name: 'Writer', projectTitle: 'Spring launch' }],
  activeRuns: [run({ id: 'r_active', title: 'Draft the launch email', externalId: 'resp_123' })],
  scheduled: [run({ id: 'r_sched', title: 'Weekly ad report', status: 'queued' })],
  defaultFor: [{ id: 'p_launch', title: 'Spring launch' }],
  external: 1
}

// ── Bridge stub ───────────────────────────────────────────────────────────────

type Fx = ReturnType<typeof fixtures>
let fx: Fx
let changed: ((p: { topic: string }) => void) | null
let api: Record<string, ReturnType<typeof vi.fn>>

function detailFor(id: string): ConnectionDetailData {
  const c = fx.cards.find((x) => x.id === id)
  if (!c) throw new Error('Connection not found.')
  return {
    connection: c,
    grants: [],
    operations: fx.operations[id] ?? [],
    usage: fx.usage[id] ?? [],
    invocations: fx.invocations[id] ?? [],
    runs: id === 'c_saas' ? [run({ id: 'r1', title: 'Draft the launch email', status: 'succeeded' })] : [],
    activity: [],
    projects: PROJECTS[c.workspaceId] ?? []
  }
}

function installApi(): void {
  fx = fixtures()
  changed = null
  api = {
    onChanged: vi.fn((cb: (p: { topic: string }) => void) => {
      changed = cb
      return () => {
        changed = null
      }
    }),
    getContext: vi.fn(async () => ({ workspaces: WORKSPACES, active: ['ws_p', 'ws_w'] })),
    catalogue: vi.fn(async () => ({ providers: PROVIDERS, addable: PROVIDERS.filter((p) => p.certification.status !== 'planned').map((p) => p.id), mcp: MCP_CATALOGUE })),
    // A fresh array each call, as IPC gives.
    listConnections: vi.fn(async () => fx.cards.map((c) => ({ ...c }))),
    connectionDetail: vi.fn(async (id: string) => detailFor(id)),
    accessImpact: vi.fn(async () => IMPACT),
    addModelApi: vi.fn(),
    addChatAccount: vi.fn(),
    addAppApi: vi.fn(),
    testConnection: vi.fn(),
    replaceKey: vi.fn(),
    pauseConnection: vi.fn(async (id: string) => fx.cards.find((c) => c.id === id)),
    resumeConnection: vi.fn(),
    disconnect: vi.fn(),
    renameConnection: vi.fn(),
    setGrant: vi.fn(async () => ({})),
    revokeGrant: vi.fn(async () => ({ ok: true })),
    reviewOperation: vi.fn(),
    listDrafts: vi.fn(async () => []),
    deleteDraft: vi.fn(async () => ({ ok: true })),
    inspectMcpEndpoint: vi.fn(),
    addMcpServer: vi.fn(),
    authorizeMcp: vi.fn(),
    reconcileInvocation: vi.fn(async () => ({ ok: true })),
    setProjectDefault: vi.fn(async () => ({})),
    projectView: vi.fn(async () => ({ agents: [] })),
    openOriginal: vi.fn(async () => ({ ok: true }))
  }
  ;(window as unknown as { api: unknown }).api = { aiSpace: api }
}

// ── Mount like MainPane: the page is keyed on the whole view ─────────────────

function Harness(): JSX.Element {
  const view = useViewStore((s) => s.view)
  return <ConnectionsView key={JSON.stringify(view)} connectionId={view.kind === 'connections' ? view.connectionId : undefined} />
}

let host: HTMLDivElement
let root: Root

const q = <T extends Element = HTMLElement>(id: string): T | null => document.querySelector(`[data-testid="${id}"]`) as T | null
const must = <T extends Element = HTMLElement>(id: string): T => {
  const el = q<T>(id)
  if (!el) throw new Error(`missing [data-testid="${id}"]`)
  return el
}
const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}
const click = async (id: string): Promise<void> => {
  act(() => must(id).click())
  await flush()
}
const type = (el: HTMLInputElement, value: string): void => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const body = (): string => document.body.innerHTML
const storageText = (): string => {
  let out = ''
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!
    out += `${k}=${localStorage.getItem(k)};`
  }
  return out
}

beforeEach(async () => {
  installApi()
  resetConnectionsScreen()
  localStorage.clear()
  useViewStore.setState({ view: { kind: 'connections' }, past: [], future: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Harness />))
  await flush()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

// ── Cards ─────────────────────────────────────────────────────────────────────

describe('Connections cards', () => {
  it('groups identities under their provider and shows only capabilities that passed', () => {
    const anthropic = must('conn-group-anthropic')
    // Both Claude API identities and the Claude web account sit under Anthropic.
    expect(anthropic.querySelector('[data-testid="conn-card-c_pers"]')).not.toBeNull()
    expect(anthropic.querySelector('[data-testid="conn-card-c_saas"]')).not.toBeNull()
    expect(anthropic.querySelector('[data-testid="conn-card-c_web"]')).not.toBeNull()

    // cancel_run FAILED on SaaSMouth Claude: no "Cancel run" label.
    const saasCaps = must('conn-card-caps-c_saas').textContent!
    expect(saasCaps).toContain('Run model')
    expect(saasCaps).not.toContain('Cancel run')
    // app_write is untested on Notion: "Read data" only.
    const notionCaps = must('conn-card-caps-c_notion').textContent!
    expect(notionCaps).toContain('Read data')
    expect(notionCaps).not.toContain('Create drafts')
    // read_resource is unsupported on Linear.
    expect(must('conn-card-caps-c_mcp').textContent).not.toContain('Read resource')
  })

  it('says Unknown payer when nobody is recorded, and the payer when one is', () => {
    expect(must('conn-card-payer-c_pers').textContent).toBe('Unknown payer')
    expect(must('conn-card-payer-c_saas').textContent).toBe('SaaSMouth Ltd')
    expect(must('conn-card-c_pers').textContent).toContain('Jane Doe')
    expect(must('conn-card-projects-c_pers').textContent).toBe('Home budget')
    expect(must('conn-card-c_pers').textContent).toContain('Personal (personal)')
    expect(must('conn-card-c_saas').textContent).toContain('SaaSMouth (work)')
  })

  it('labels a loopback MCP server On this Mac, and no other', () => {
    expect(must('conn-card-local-c_local').textContent).toContain('On this Mac')
    expect(q('conn-card-local-c_mcp')).toBeNull()
  })

  it('filters by kind with counts', async () => {
    expect(must('conn-filter-mcp').textContent).toContain('2')
    await click('conn-filter-mcp')
    expect(q('conn-card-c_mcp')).not.toBeNull()
    expect(q('conn-card-c_local')).not.toBeNull()
    expect(q('conn-card-c_pers')).toBeNull()
    await click('conn-filter-agent')
    expect(must('conn-empty').textContent).toContain('No agents connected')
    expect(q('conn-empty-add')).toBeNull()
  })

  it('lists planned providers, collapsed until asked', async () => {
    const toggle = must('conn-planned-toggle')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(q('conn-planned-list')).toBeNull()
    await click('conn-planned-toggle')
    expect(must('conn-planned-toggle').getAttribute('aria-expanded')).toBe('true')
    const list = must('conn-planned-list').textContent!
    expect(list).toContain('Gemini API')
    expect(list).toContain('Amazon Bedrock')
    expect(list).toContain('Planned')
  })

  it('without the desktop bridge it says where Connections live, and calls nothing', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    act(() => root.render(<ConnectionsView />))
    await flush()
    expect(must('conn-unavailable').textContent).toContain('desktop app')
    expect(q('conn-add')).toBeNull()
  })

  it('reloads when main says a connection changed', async () => {
    fx.cards.push(card({ id: 'c_openai', providerId: 'openai', workspaceId: 'ws_w', alias: 'SaaSMouth OpenAI', capabilities: [cap('run_model', 'passed')] }))
    expect(changed).toBeTypeOf('function')
    await act(async () => changed!({ topic: 'connection' }))
    await flush()
    expect(q('conn-card-c_openai')).not.toBeNull()
  })
})

// ── Keyboard ──────────────────────────────────────────────────────────────────

describe('Keyboard', () => {
  it('Enter on a card opens its panel with a stable link; Escape closes it and focus returns to the card', async () => {
    const btn = must<HTMLButtonElement>('conn-card-open-c_pers')
    act(() => btn.focus())
    act(() => {
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(useViewStore.getState().view).toEqual({ kind: 'connections', connectionId: 'c_pers' })
    expect(must('conn-panel').getAttribute('data-connection-id')).toBe('c_pers')
    expect(must('ais-inspector').textContent).toContain('Personal Claude')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40))
    })
    expect(q('ais-inspector')).toBeNull()
    expect(useViewStore.getState().view).toEqual({ kind: 'connections' })
    expect(document.activeElement?.getAttribute('data-testid')).toBe('conn-card-open-c_pers')
  })
})

// ── Adding a model API key ────────────────────────────────────────────────────

async function startModelFlowToStep3(): Promise<void> {
  await click('conn-add')
  expect(must('conn-add-title').textContent).toBe('What do you want to connect?')
  await click('conn-add-provider-anthropic')
  await click('conn-add-next')
  expect(must('conn-add-title').textContent).toBe('Which workspace?')
  await click('conn-add-ws-ws_w')
  await click('conn-add-next')
  expect(must('conn-add-title').textContent).toBe('Add your Claude API key')
}

describe('Add a model API key', () => {
  it('uses a masked field, never renders the key, and empties the field on submit', async () => {
    const cNew = card({ id: 'c_new', providerId: 'anthropic', workspaceId: 'ws_w', alias: 'SaaSMouth Claude', providerOrg: 'SaaSMouth Ltd', billedTo: 'SaaSMouth Ltd', hasSecret: true, secretHint: '…5b4a', capabilities: [cap('run_model', 'passed')] })
    api.addModelApi
      .mockResolvedValueOnce({ ok: false, detail: 'The key was refused (401).', confirmed: [] })
      .mockImplementationOnce(async () => {
        fx.cards.push(cNew)
        return { ok: true, connection: cNew, confirmed: ['The key was accepted (read-only check, no charge).', 'Organisation: SaaSMouth Ltd.', '4 models available to this key.'] }
      })
    await startModelFlowToStep3()

    expect(must<HTMLInputElement>('conn-add-alias').value).toBe('SaaSMouth Claude')
    const key = must<HTMLInputElement>('conn-add-secret')
    expect(key.type).toBe('password')
    expect(key.getAttribute('autocomplete')).toBe('off')
    expect(key.getAttribute('spellcheck')).toBe('false')
    expect(body()).toContain('free, read-only call')
    must<HTMLButtonElement>('conn-add-key-link').click()
    expect(api.openOriginal).toHaveBeenCalledWith('https://console.anthropic.com/settings/keys')

    // First try: refused. The form stays, the detail shows, the field is empty.
    type(key, FAKE_KEY)
    expect(body()).not.toContain(FAKE_KEY)
    await click('conn-add-submit')
    expect(api.addModelApi).toHaveBeenCalledTimes(1)
    expect(api.addModelApi.mock.calls[0][0]).toMatchObject({ providerId: 'anthropic', workspaceId: 'ws_w', alias: 'SaaSMouth Claude', billedTo: null, secret: FAKE_KEY })
    expect(must('conn-add-title').textContent).toBe('Add your Claude API key')
    expect(must('conn-add-message').textContent).toContain('The key was refused (401).')
    expect(must<HTMLInputElement>('conn-add-secret').value).toBe('')
    expect(body()).not.toContain(FAKE_KEY)
    expect(storageText()).not.toContain(FAKE_KEY)

    // Second try: accepted. Exactly what main confirmed is shown.
    type(must<HTMLInputElement>('conn-add-secret'), FAKE_KEY)
    await click('conn-add-submit')
    expect(must('conn-add-title').textContent).toBe('Which projects can use it?')
    const confirmed = Array.from(must('conn-add-confirmed').querySelectorAll('li')).map((li) => li.textContent)
    expect(confirmed).toEqual(['The key was accepted (read-only check, no charge).', 'Organisation: SaaSMouth Ltd.', '4 models available to this key.'])
    expect(body()).not.toContain(FAKE_KEY)
    expect(storageText()).not.toContain(FAKE_KEY)

    // Projects: none ticked to start; a model key grants "run models".
    expect(must<HTMLInputElement>('conn-add-project-p_launch').checked).toBe(false)
    expect(must<HTMLButtonElement>('conn-add-grant').disabled).toBe(true)
    await click('conn-add-project-p_launch')
    await click('conn-add-grant')
    expect(api.setGrant).toHaveBeenCalledWith({ connectionId: 'c_new', projectId: 'p_launch', actions: [{ operationId: 'model:*', mode: 'read' }] })

    // Result: what works, account, payer.
    expect(must('conn-add-title').textContent).toBe('Connected')
    expect(must('conn-add-result-caps').textContent).toContain('Run model')
    expect(must('conn-add-result-payer').textContent).toBe('SaaSMouth Ltd')
    await click('conn-add-done')
    expect(q('conn-add-dialog')).toBeNull()
    expect(storageText()).not.toContain('connectDraft')
    expect(body()).not.toContain(FAKE_KEY)
  })

  it('keeps a draft without the key when closed part-way, and offers to continue', async () => {
    await startModelFlowToStep3()
    type(must<HTMLInputElement>('conn-add-alias'), 'Client Claude')
    type(must<HTMLInputElement>('conn-add-secret'), FAKE_KEY)
    await click('conn-add-close')
    expect(q('conn-add-dialog')).toBeNull()
    expect(storageText()).toContain('Client Claude')
    expect(storageText()).not.toContain(FAKE_KEY)

    await click('conn-add')
    expect(must('conn-add-title').textContent).toBe('Pick up where you left off?')
    await click('conn-add-resume-local')
    expect(must('conn-add-title').textContent).toBe('Add your Claude API key')
    expect(must<HTMLInputElement>('conn-add-alias').value).toBe('Client Claude')
    expect(must<HTMLInputElement>('conn-add-secret').value).toBe('')
    expect(body()).not.toContain(FAKE_KEY)
  })
})

// ── MCP ───────────────────────────────────────────────────────────────────────

describe('Add an MCP server', () => {
  const inspectOk = { ok: true, origin: 'https://mcp.linear.app', onThisMac: false, reason: 'Sign-in needed. You’ll approve access in your browser.', needsAuth: true, authServer: 'https://linear.app', scopes: ['read'] }
  const mcpNew = (): ConnectionCard => card({ id: 'c_mcp2', providerId: 'mcp_remote', workspaceId: 'ws_w', alias: 'Linear', endpoint: 'https://mcp.linear.app/mcp', verifiedOrigin: 'https://mcp.linear.app', status: 'draft' }, {}, { authMode: 'oauth' })

  it('shows the verified origin before adding, and a denied sign-in returns to the same step', async () => {
    api.inspectMcpEndpoint.mockResolvedValue(inspectOk)
    api.addMcpServer.mockImplementation(async () => {
      const c = mcpNew()
      fx.cards.push(c)
      return { ok: true, connection: c, next: 'authorize', confirmed: ['Verified origin: https://mcp.linear.app.', 'Sign-in through https://linear.app.'] }
    })
    api.authorizeMcp
      .mockResolvedValueOnce({ ok: false, outcome: 'denied', detail: 'Access was declined in the browser. Nothing was stored; try again when you’re ready.', connection: null })
      .mockResolvedValueOnce({ ok: true, outcome: 'authorized', detail: 'Signed in with access: read. Linear: 3 tools.', connection: null })

    await click('conn-add')
    await click('conn-add-provider-mcp')
    await click('conn-add-mcp-pick-linear')
    expect(must<HTMLInputElement>('conn-add-mcp-url').value).toBe('https://mcp.linear.app/mcp')
    await click('conn-add-next')
    await click('conn-add-ws-ws_w')
    await click('conn-add-next')

    expect(api.inspectMcpEndpoint).toHaveBeenCalledWith('https://mcp.linear.app/mcp')
    expect(must('conn-add-mcp-origin').textContent).toBe('https://mcp.linear.app')
    expect(must('conn-add-mcp-authserver').textContent).toContain('https://linear.app')
    expect(api.addMcpServer).not.toHaveBeenCalled()
    expect(must<HTMLInputElement>('conn-add-alias').value).toBe('Linear')

    await click('conn-add-submit')
    expect(api.addMcpServer).toHaveBeenCalledWith({ workspaceId: 'ws_w', alias: 'Linear', endpoint: 'https://mcp.linear.app/mcp', bearerToken: null })
    expect(api.authorizeMcp).toHaveBeenCalledWith('c_mcp2')
    // Denied: same step, a clear message, and a way to try again.
    expect(must('conn-add-title').textContent).toBe('Check the server and sign in')
    expect(must('conn-add-message').textContent).toContain('Access was declined in the browser.')
    expect(must('conn-add-submit').textContent).toBe('Try again')

    // Try again signs in to the SAME connection; it is never added twice.
    await click('conn-add-submit')
    expect(api.addMcpServer).toHaveBeenCalledTimes(1)
    expect(api.authorizeMcp).toHaveBeenCalledTimes(2)
    expect(api.authorizeMcp.mock.calls[1][0]).toBe('c_mcp2')
    expect(must('conn-add-title').textContent).toBe('Which projects can use it?')
  })

  it('a pasted token goes through a masked field and is never rendered', async () => {
    api.inspectMcpEndpoint.mockResolvedValue(inspectOk)
    api.addMcpServer.mockImplementation(async () => {
      const c = { ...mcpNew(), status: 'ready' as const }
      fx.cards.push(c)
      return { ok: true, connection: c, next: 'done', confirmed: ['Verified origin: https://mcp.linear.app.'] }
    })
    await click('conn-add')
    await click('conn-add-provider-mcp')
    await click('conn-add-mcp-pick-linear')
    await click('conn-add-next')
    await click('conn-add-ws-ws_w')
    await click('conn-add-next')
    await click('conn-add-mcp-token')
    const tok = must<HTMLInputElement>('conn-add-secret')
    expect(tok.type).toBe('password')
    type(tok, FAKE_TOKEN)
    await click('conn-add-submit')
    expect(api.addMcpServer).toHaveBeenCalledWith({ workspaceId: 'ws_w', alias: 'Linear', endpoint: 'https://mcp.linear.app/mcp', bearerToken: FAKE_TOKEN })
    expect(api.authorizeMcp).not.toHaveBeenCalled()
    expect(must('conn-add-title').textContent).toBe('Which projects can use it?')
    expect(body()).not.toContain(FAKE_TOKEN)
    expect(storageText()).not.toContain(FAKE_TOKEN)
  })

  it('labels an address the person typed on this Mac', async () => {
    api.inspectMcpEndpoint.mockResolvedValue({ ok: true, origin: 'http://localhost:3333', onThisMac: true, reason: 'Open server: no sign-in needed.', needsAuth: false, authServer: null, scopes: [] })
    await click('conn-add')
    await click('conn-add-provider-mcp')
    type(must<HTMLInputElement>('conn-add-mcp-url'), 'http://localhost:3333/mcp')
    await click('conn-add-next')
    await click('conn-add-ws-ws_w')
    await click('conn-add-next')
    expect(must('conn-add-mcp-inspect').textContent).toContain('On this Mac')
    expect(must('conn-add-submit').textContent).toBe('Connect')
  })

  it('continues a sign-in main kept as a draft, without adding the server again', async () => {
    api.listDrafts.mockResolvedValue([{ id: 'mcp_c_mcp9', providerId: 'mcp_remote', workspaceId: 'ws_w', step: 'authorize', state: { connectionId: 'c_mcp9', endpoint: 'https://mcp.sentry.dev/mcp' }, updatedAt: T0 }])
    api.inspectMcpEndpoint.mockResolvedValue({ ...inspectOk, origin: 'https://mcp.sentry.dev', authServer: 'https://sentry.io' })
    api.authorizeMcp.mockResolvedValue({ ok: false, outcome: 'timeout', detail: 'The sign-in wasn’t finished in time. Your setup is saved; try again.', connection: null })
    await click('conn-add')
    expect(must('conn-add-resume').textContent).toContain('https://mcp.sentry.dev/mcp')
    await click('conn-add-resume-mcp_c_mcp9')
    expect(must('conn-add-mcp-origin').textContent).toBe('https://mcp.sentry.dev')
    expect(must('conn-add-submit').textContent).toBe('Sign in with the server')
    await click('conn-add-submit')
    expect(api.addMcpServer).not.toHaveBeenCalled()
    expect(api.authorizeMcp).toHaveBeenCalledWith('c_mcp9')
    expect(must('conn-add-message').textContent).toContain('wasn’t finished in time')
  })
})

// ── Side panel: Overview verbs ────────────────────────────────────────────────

async function openPanel(id: string): Promise<void> {
  await click(`conn-card-open-${id}`)
  expect(must('conn-panel').getAttribute('data-connection-id')).toBe(id)
}

describe('Overview', () => {
  it('shows the key only as its last four characters', async () => {
    await openPanel('c_saas')
    expect(must('conn-secret-hint').textContent).toBe('Key ending …cd34')
    expect(must('conn-certification').textContent).toContain('A live check needs a key.')
    expect(must('conn-capabilities').textContent).toContain('Not working')
  })

  it('Disconnect lists what is affected first, does nothing on Cancel, then shows the provider-side step', async () => {
    await openPanel('c_saas')
    await click('conn-disconnect')
    expect(api.accessImpact).toHaveBeenCalledWith('c_saas')
    const list = must('conn-impact-list').textContent!
    expect(list).toContain('Spring launch')
    expect(list).toContain('Writer')
    expect(list).toContain('Draft the launch email')
    expect(list).toContain('Weekly ad report')
    expect(must('conn-impact-external').textContent).toContain('running at the provider')
    expect(api.disconnect).not.toHaveBeenCalled()

    await click('conn-impact-cancel')
    expect(q('conn-impact-dialog')).toBeNull()
    expect(api.disconnect).not.toHaveBeenCalled()

    const action = 'Plexii deleted its copy of the key. The key itself still works until you delete it in Claude API’s settings (https://console.anthropic.com/settings/keys).'
    api.disconnect.mockImplementation(async (id: string) => {
      const i = fx.cards.findIndex((c) => c.id === id)
      fx.cards[i] = { ...fx.cards[i], status: 'disconnected', hasSecret: false, secretHint: null, providerAction: action }
      return { connection: fx.cards[i], affected: IMPACT }
    })
    await click('conn-disconnect')
    await click('conn-impact-confirm')
    expect(api.disconnect).toHaveBeenCalledTimes(1)
    expect(api.disconnect).toHaveBeenCalledWith('c_saas')
    expect(must('conn-provider-action').textContent).toContain(action)
    await click('conn-provider-action-link')
    expect(api.openOriginal).toHaveBeenCalledWith('https://console.anthropic.com/settings/keys')
  })

  it('Pause also shows what is affected before pausing', async () => {
    await openPanel('c_saas')
    await click('conn-pause')
    expect(must('conn-impact-list').textContent).toContain('Spring launch')
    expect(api.pauseConnection).not.toHaveBeenCalled()
    await click('conn-impact-confirm')
    expect(api.pauseConnection).toHaveBeenCalledWith('c_saas')
  })

  it('Rotate key: a key for another account is refused with the separate-connection route, and is never rendered', async () => {
    api.replaceKey.mockResolvedValue({ ok: false, detail: 'That key belongs to a different account, so it can’t replace this one. Add it as a separate connection instead.', separate: { providerId: 'anthropic', identity: 'org_other' } })
    await openPanel('c_saas')
    await click('conn-rotate')
    const field = must<HTMLInputElement>('conn-secret-input')
    expect(field.type).toBe('password')
    type(field, FAKE_KEY)
    await click('conn-secret-submit')
    expect(api.replaceKey).toHaveBeenCalledWith('c_saas', FAKE_KEY, 'rotate')
    expect(must<HTMLInputElement>('conn-secret-input').value).toBe('')
    expect(must('conn-result').textContent).toContain('different account')
    expect(body()).not.toContain(FAKE_KEY)
    await click('conn-add-separate')
    expect(must('conn-add-title').textContent).toBe('Add your Claude API key')
  })

  it('edits the payer inline; blank means Unknown payer', async () => {
    api.renameConnection.mockResolvedValue(fx.cards[0])
    await openPanel('c_pers')
    expect(must('conn-payer-value').textContent).toBe('Unknown payer')
    await click('conn-payer-edit')
    type(must<HTMLInputElement>('conn-payer-input'), 'Jane Doe (personal card)')
    await click('conn-payer-save')
    expect(api.renameConnection).toHaveBeenCalledWith('c_pers', 'Personal Claude', 'Jane Doe (personal card)')
  })
})

// ── Side panel: Access ────────────────────────────────────────────────────────

describe('Access', () => {
  it('grants an MCP server read tools only by default; an unclassified tool needs review first', async () => {
    await openPanel('c_mcp')
    await click('conn-tab-access')
    const toggle = must('conn-access-toggle-p_launch')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await click('conn-access-toggle-p_launch')
    expect(must('conn-access-toggle-p_launch').getAttribute('aria-expanded')).toBe('true')

    expect(must<HTMLInputElement>('conn-op-read-mcp:c_mcp:list_issues').checked).toBe(true)
    expect(must<HTMLInputElement>('conn-op-write-mcp:c_mcp:create_issue').checked).toBe(false)
    // The unknown tool has no toggle at all, only a review.
    expect(q('conn-op-read-mcp:c_mcp:mystery')).toBeNull()
    expect(q('conn-op-write-mcp:c_mcp:mystery')).toBeNull()
    const review = must('conn-op-review-mcp:c_mcp:mystery').textContent!
    expect(review).toContain('Review this tool')
    expect(review).toContain('The server says it only reads (advisory).')
    expect((must<HTMLSelectElement>('conn-grant-approval')).value).toBe('ask_each_time')

    await click('conn-grant-save')
    expect(api.setGrant).toHaveBeenCalledTimes(1)
    expect(api.setGrant.mock.calls[0][0]).toMatchObject({
      connectionId: 'c_mcp',
      projectId: 'p_launch',
      agentIds: ['*'],
      actions: [{ operationId: 'mcp:c_mcp:list_issues', mode: 'read' }],
      approval: 'ask_each_time',
      expiresAt: null
    })

    // Reviewing it as a read makes it grantable.
    api.reviewOperation.mockImplementation(async (id: string, cls: 'read' | 'write') => {
      fx.operations.c_mcp = fx.operations.c_mcp.map((o) => (o.id === id ? { ...o, classification: cls, reviewState: 'approved' } : o))
      return null
    })
    await click('conn-op-mark-read-mcp:c_mcp:mystery')
    expect(api.reviewOperation).toHaveBeenCalledWith('mcp:c_mcp:mystery', 'read')
    expect(q('conn-op-review-mcp:c_mcp:mystery')).toBeNull()
    expect(must<HTMLInputElement>('conn-op-read-mcp:c_mcp:mystery').checked).toBe(true)
  })

  it('keeps actions a separate, explicit grant for an app API', async () => {
    await openPanel('c_notion')
    await click('conn-tab-access')
    await click('conn-access-toggle-p_launch')
    await click('conn-grant-save')
    expect(api.setGrant.mock.calls[0][0].actions).toEqual([
      { operationId: 'notion.whoami', mode: 'read' },
      { operationId: 'notion.search', mode: 'read' }
    ])
    await click('conn-op-write-notion.create_draft_page')
    await click('conn-grant-save')
    expect(api.setGrant.mock.calls[1][0].actions).toContainEqual({ operationId: 'notion.create_draft_page', mode: 'write' })
  })

  it('lists only projects in the connection’s own workspace', async () => {
    await openPanel('c_pers')
    await click('conn-tab-access')
    expect(q('conn-access-row-p_home')).not.toBeNull()
    expect(q('conn-access-row-p_launch')).toBeNull()
  })
})

// ── Side panel: Usage and Activity ────────────────────────────────────────────

describe('Usage and Activity', () => {
  it('labels tokens Reported and the amount Estimated, keeps an unknown amount Unavailable, and links billing', async () => {
    await openPanel('c_saas')
    await click('conn-tab-usage')
    expect(must('conn-usage-input').textContent).toContain('Reported')
    expect(must('conn-usage-amount').textContent).toContain('Estimated')
    expect(must('conn-usage-amount').textContent).toContain('1 call without an amount')
    expect(must('conn-usage-table').textContent).toContain('Unavailable')
    expect(must('conn-usage-note').textContent).toContain('Budgets are Plexii limits, not your provider invoice')
    await click('conn-usage-billing')
    expect(api.openOriginal).toHaveBeenCalledWith('https://console.anthropic.com/settings/billing')
  })

  it('an uncertain action is settled by the person, never retried', async () => {
    await openPanel('c_notion')
    await click('conn-tab-activity')
    expect(must('conn-inv-uncertain-inv_unsure').textContent).toContain('won’t try again')
    expect(must('conn-inv-approval-inv_wait').textContent).toContain('Waiting for approval')
    await click('conn-inv-done-inv_unsure')
    expect(api.reconcileInvocation).toHaveBeenCalledWith('inv_unsure', 'done')
  })
})

// ── Settings › Connections ────────────────────────────────────────────────────

describe('Settings section', () => {
  it('summarises by status, lists what needs attention, and opens the screen', async () => {
    fx.cards[3] = { ...fx.cards[3], status: 'reconnect_required' }
    const onManage = vi.fn()
    const el = document.createElement('div')
    document.body.appendChild(el)
    const r = createRoot(el)
    act(() => r.render(<ConnectionsSection onManage={onManage} />))
    await flush()
    expect(must('settings-connections-counts').textContent).toContain('5 ready')
    expect(must('settings-connections-counts').textContent).toContain('1 reconnect required')
    expect(must('settings-connections-attention').textContent).toContain('Linear')
    await click('settings-connections-manage')
    expect(onManage).toHaveBeenCalledTimes(1)
    act(() => r.unmount())
  })
})
