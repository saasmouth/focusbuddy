import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  handleWorkspaceMcpBody,
  WORKSPACE_TOOLS,
  workspaceServerSpec,
  OUTBOUND_FLOW_ACTIONS,
  outboundActionsOf,
  MCP_WRITE_EVENT,
  type WorkspaceDeps
} from '../../src/main/mcpServer'
import { dispatchMcpMessage, capText, RESULT_CHAR_CAP, num, str, bool } from '../../src/main/mcpProtocol'
import { WORK_ITEM_STATES, INTENT_CLASSES } from '../../src/shared/workItems'
import { isValidEventTypeName, assertEventTypeName } from '../../src/shared/events'
import type { FbNode } from '../../src/shared/types'
import { migrateSlidesBody } from '../../src/shared/slidesMigrate'

// Plexii over MCP — the workspace surface. The contract under test:
//   1. scope is structural — a read token neither lists nor may call a write
//      tool; a write token gets everything;
//   2. every tool returns real data from the injected stores, an honest zero
//      when there is none, and isError (never an exception) on bad input;
//   3. writes are attributed (work items are born origin 'ai');
//   4. nothing on the surface deletes;
//   5. the route mounts behind PlexiAPI auth and hands the token's scopes in.

// ── Fixtures ────────────────────────────────────────────────────────────────

const DESK: FbNode = {
  id: 'd1', parentId: null, kind: 'task', title: 'Launch week', description: 'All launch tasks', status: 'active'
} as FbNode
const DONE_DESK: FbNode = { ...DESK, id: 'd2', title: 'Old desk', status: 'done' }
const FOLDER: FbNode = { ...DESK, id: 'f1', kind: 'folder', title: 'Clients' }
const WI_OPEN: FbNode = {
  id: 'w1', parentId: 'd1', kind: 'work_item', title: 'Countersign the contract', description: 'Dana needs it by Friday',
  status: 'active', workItemState: 'open', intentClass: 'to_do', dueAt: '2026-09-19T00:00:00.000Z', wiUrgency: 'high',
  tags: 'legal,launch', wiOrigin: 'human', sourceUrl: 'https://example.com/mail/1'
} as FbNode
const WI_DONE: FbNode = { ...WI_OPEN, id: 'w2', title: 'Old thing', workItemState: 'completed', intentClass: 'to_review' }
const WI_DECIDE: FbNode = { ...WI_OPEN, id: 'w3', title: 'Pick a vendor', workItemState: 'open', intentClass: 'to_decide', parentId: null }

const DOC = {
  id: 'doc1', docType: 'doc' as const, title: 'Launch plan', archived: false, createdAt: 1, updatedAt: 1757000000000, orgId: null,
  body: { type: 'doc', content: [{ type: 'heading', content: [{ type: 'text', text: 'Plan' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Ship on Monday.' }] }] }
}
const SHEET = {
  id: 'sh1', docType: 'sheet' as const, title: 'Budget', archived: false, createdAt: 1, updatedAt: 1757000000000, orgId: null,
  body: { version: 2 as const, sheets: [{ id: 't', name: 'Q4', columns: ['Item', 'Cost'], rows: [['Ads', '1200'], ['Video', '800']] }] }
}
// The store migrates a v1 deck to the v2 element model on READ (parseBody →
// migrateSlidesBody), so a fixture holding raw v1 would be a shape getDocument
// never actually returns — and a test written against it would pass while the
// real thing came back empty. Migrate it here for the same reason.
const SLIDES = {
  id: 'sl1', docType: 'slides' as const, title: 'Pitch', archived: false, createdAt: 1, updatedAt: 1757000000000, orgId: null,
  body: migrateSlidesBody({
    slides: [{ id: 's1', title: 'Why now', bullets: ['Tabs get closed', 'Context is lost'], notes: 'pause here' }]
  } as never)
}
const ARCHIVED_DOC = { ...DOC, id: 'doc2', title: 'Archived', archived: true }

const TABLE = {
  id: 't1', taskId: null, title: 'Leads', createdAt: 1, updatedAt: 1,
  schema: { columns: [
    { id: 'c_name', type: 'text-short', label: 'Name', config: {} },
    { id: 'c_stage', type: 'text-short', label: 'Stage', config: {} }
  ] }
}
const ROWS = [
  { id: 'r1', tableId: 't1', cells: { c_name: 'Acme', c_stage: 'Demo' }, sortOrder: 0 },
  { id: 'r2', tableId: 't1', cells: { c_name: 'Globex' }, sortOrder: 1 }
]
const KNOW = [
  { id: 'k1', title: 'Pricing', body: 'Pro is $9.95/mo.', tags: ['pricing'], pinned: true, createdAt: 1, updatedAt: 1 },
  { id: 'k2', title: 'Tone', body: 'Punchy three-word problem statements.', tags: [], pinned: false, createdAt: 1, updatedAt: 1 }
]
const BLOCKS = [
  { id: 'b1', taskId: 'd1', title: 'Deep work', startMs: Date.parse('2026-09-16T01:00:00Z'), durationMin: 90, status: 'planned', origin: 'manual', locked: false, pushPolicy: 'local' },
  { id: 'b2', taskId: null, title: 'Standup', startMs: Date.parse('2026-09-16T00:00:00Z'), durationMin: 15, status: 'planned', origin: 'manual', locked: false, pushPolicy: 'local', meeting: { url: 'x' } }
]
const FLOW = {
  id: 'fl1', title: 'Nightly digest', enabled: true, trigger: { kind: 'schedule' as const, every: 'day' }, actions: [],
  lastRunAt: 1757000000000, lastStatus: 'ok' as const, lastLog: [], nextRunAt: null, createdAt: 1, updatedAt: 1
}

// A desk's canvas, spanning the range that matters: prose, a table pointer, a
// document pointer, a voice-note transcript, and pure chrome that must NOT be
// printed.
const WIDGETS = [
  { id: 'wd1', taskId: 'd1', kind: 'note', title: 'Kickoff notes', content: 'Ship on Monday. Dana owns the contract.' },
  { id: 'wd2', taskId: 'd1', kind: 'table', title: 'Leads', content: 't1' },
  { id: 'wd3', taskId: 'd1', kind: 'doc', title: 'Launch plan', content: 'doc1' },
  {
    id: 'wd4', taskId: 'd1', kind: 'voice-recorder', title: 'Supplier call',
    content: JSON.stringify({ transcript: 'Chase the March invoice with Dolan Freight.', durationSec: 9 })
  },
  { id: 'wd5', taskId: 'd1', kind: 'section', title: 'Layout', content: '' },
  { id: 'wd6', taskId: 'd1', kind: 'minimap', title: '', content: '' }
]

function deps(over: Partial<WorkspaceDeps> = {}): WorkspaceDeps {
  return {
    // Recall
    searchSegments: () => [],
    getMeeting: () => null,
    listMeetings: () => [],
    listSegments: () => [],
    serverVersion: '4.2.2',
    // Reads
    searchAll: async (q) => (q === 'contract' ? [{ type: 'task', id: 'd1', title: 'Launch week', snippet: 'the contract', score: 1 }] : []),
    listNodes: () => [DESK, DONE_DESK, FOLDER],
    getNode: (id) => [DESK, DONE_DESK, FOLDER].find((n) => n.id === id) ?? null,
    listWorkItems: () => [WI_OPEN, WI_DONE, WI_DECIDE],
    getWorkItem: (id) => [WI_OPEN, WI_DONE, WI_DECIDE].find((n) => n.id === id) ?? null,
    listDocuments: () => [DOC, SHEET, SLIDES, ARCHIVED_DOC].map(({ id, docType, title, archived, createdAt, updatedAt }) => ({ id, docType, title, archived, createdAt, updatedAt })),
    getDocument: (id) => ([DOC, SHEET, SLIDES].find((d) => d.id === id) as never) ?? null,
    listTables: () => [TABLE as never],
    getTable: (id) => (id === 't1' ? (TABLE as never) : null),
    listRows: () => ROWS as never,
    listKnowledge: () => KNOW,
    searchKnowledge: (q) => KNOW.filter((k) => k.body.toLowerCase().includes(q.toLowerCase())),
    listBlocksInRange: (from, to) => (BLOCKS as never[]).filter((b: never) => (b as { startMs: number }).startMs >= from && (b as { startMs: number }).startMs < to),
    listFlows: () => [FLOW as never],
    getFlow: (id) => (id === 'fl1' ? (FLOW as never) : null),
    listWidgetsByTask: (taskId) => (taskId === 'd1' ? (WIDGETS as never) : []),
    // Writes
    createWorkItem: vi.fn((d) => ({ ...WI_OPEN, id: 'w-new', title: d.title, intentClass: d.intentClass ?? 'to_do', wiOrigin: d.wiOrigin, parentId: d.parentId ?? null, dueAt: d.dueAt ?? null, tags: d.tags ?? null, wiUrgency: d.wiUrgency ?? null }) as FbNode),
    setWorkItemState: vi.fn(() => true),
    createDesk: vi.fn((title, description) => ({ ...DESK, id: 'd-new', title, description })),
    createKnowledge: vi.fn((d) => ({ ...KNOW[0], id: 'k-new', title: d.title, body: d.body, tags: d.tags ?? [] })),
    createDocument: vi.fn((d) => ({ ...DOC, id: 'doc-new', title: d.title, body: d.body })),
    markdownToDoc: (md) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: md }] }] }),
    createRow: vi.fn((d) => ({ id: 'r-new', tableId: d.tableId, cells: d.cells, sortOrder: 9 })),
    createTable: vi.fn((d) => ({ ...TABLE, id: 't-new', title: d.title, taskId: d.taskId, schema: d.schema }) as never),
    createWidget: vi.fn((d) => ({ id: 'wg-new', taskId: d.taskId, kind: d.kind, title: d.title, content: d.content }) as never),
    listFileEntries: (parentId) => (parentId === null ? ([{ id: 'f1', parentId: null, kind: 'file', name: 'brief', ext: 'md', mimeType: 'text/markdown', sizeBytes: 2048 }] as never) : []),
    getFileEntry: (id) => (id === 'f1' ? ({ id: 'f1', parentId: null, kind: 'file', name: 'brief.md', mimeType: 'text/markdown' } as never) : id === 'fold' ? ({ id: 'fold', parentId: null, kind: 'folder', name: 'Docs' } as never) : null),
    fileText: async (id) => (id === 'f1' ? 'Launch is Monday.' : null),
    updateWorkItemFields: vi.fn((id, patch) => ({ ...WI_OPEN, id, ...patch }) as never),
    updateDocument: vi.fn((id, patch) => ({ ...DOC, id, ...patch }) as never),
    updateKnowledge: vi.fn((id, patch) => ({ ...KNOW[0], id, ...patch }) as never),
    updateRow: vi.fn((id, patch) => ({ id, tableId: 't1', cells: patch.cells ?? {}, sortOrder: 0 }) as never),
    getRow: (tableId, rowId) => (tableId === 't1' ? (ROWS.find((r) => r.id === rowId) as never) ?? null : null),
    updateWidget: vi.fn((id, patch) => ({ id, taskId: 'd1', kind: 'note', title: '', content: '', ...patch }) as never),
    getWidget: (id) => (id === 'wg2' ? ({ id: 'wg2', taskId: 'd1', kind: 'agent', title: 'Agent', content: '{}' } as never) : id === 'wgOther' ? ({ id: 'wgOther', taskId: 'd2', kind: 'note', title: 'Elsewhere', content: 'x' } as never) : id === 'wg1' ? ({ id: 'wg1', taskId: 'd1', kind: 'note', title: 'N', content: 'x' } as never) : id === 'wgT' ? ({ id: 'wgT', taskId: 'd1', kind: 'table', title: 'T', content: 't1' } as never) : null),
    updateNode: vi.fn((id, patch) => ({ ...DESK, id, ...patch })),
    updateTimeBlock: vi.fn((id, patch) => ({ ...BLOCKS[0], id, ...patch }) as never),
    updateTable: vi.fn((id, patch) => ({ ...TABLE, id, ...patch }) as never),
    listContacts: () => [{ id: 'p1', name: 'Dana Reed', email: 'dana@example.com', phone: null, company: 'Dolan', role: 'Ops', address: null, notes: null, kind: 'guest', accountId: null, tags: ['supplier'], createdAt: 1, updatedAt: 1 }] as never,
    getContact: (id) => (id === 'p1' ? ({ id: 'p1', name: 'Dana Reed' } as never) : null),
    createContact: vi.fn((d) => ({ id: 'p-new', ...d }) as never),
    updateContact: vi.fn((id, patch) => ({ id, name: 'Dana Reed', ...patch }) as never),
    createFlow: vi.fn((d) => ({ ...FLOW, id: 'fl-new', title: d.title, actions: [] }) as never),
    updateFlow: vi.fn((id, patch) => ({ ...FLOW, id, ...patch }) as never),
    createMeeting: vi.fn((d) => ({ id: 'mt-new', ...d }) as never),
    updateMeeting: vi.fn((id, patch) => ({ id, ...patch }) as never),
    listForms: () => [{ id: 'fm1', title: 'Enquiry', tableId: 't1' }],
    createForm: vi.fn((d) => ({ id: 'fm-new', ...d }) as never),
    listReports: () => [{ id: 'rp1', title: 'Weekly' }],
    createReport: vi.fn((d) => ({ id: 'rp-new', ...d }) as never),
    generateReport: vi.fn(async () => ({ ok: true, output: '3 rows across 1 table.', isAi: false })),
    listDecisions: () => [{ id: 'dc1', title: 'Ship on Monday', status: 'accepted' }],
    createDecision: vi.fn((i) => ({ id: 'dc-new', ...i }) as never),
    listProjectSummaries: () => [{ id: 'pr1', title: 'Launch', taskCount: 4, startMs: 1757000000000, endMs: 1757600000000 }],
    setTaskPlan: vi.fn(),
    recordAgentWrite: vi.fn(),
    listExternalEvents: (from, to) => ([{ id: 'x1', calendarId: 'cal1', uid: 'u1', title: 'Board meeting', description: null, location: 'Zoom', startMs: Date.parse('2026-09-16T03:00:00Z'), endMs: Date.parse('2026-09-16T04:00:00Z'), allDay: false, status: null, organizer: null, url: null, updatedAt: 1 }] as never[]).filter((e: never) => (e as { startMs: number }).startMs >= from && (e as { startMs: number }).startMs < to),
    listExternalCalendars: () => [{ id: 'cal1', provider: 'google', name: 'Work (Google)', color: null, sourceRef: 'x', accountId: null, enabled: true, lastSyncAt: null }] as never,
    listLinksByTask: vi.fn(() => [] as never[]),
    createLink: vi.fn((s2, t2, taskId, type) => ({ id: 'lk-new', sourceWidgetId: s2, targetWidgetId: t2, taskId, type, verb: '', enabled: false, createdAt: 1 }) as never),
    updateLink: vi.fn((id, patch) => ({ id, sourceWidgetId: 'wg1', targetWidgetId: 'wg2', taskId: 'd1', type: 'transform', verb: '', enabled: false, createdAt: 1, ...patch }) as never),
    listTemplates: () => [{ id: 'tp1', name: 'Client desk', description: 'Standard layout' }],
    createTemplateFromTask: vi.fn((taskId, name) => ({ id: 'tp-new', name, taskId })),
    snoozeWorkItem: vi.fn(),
    reclassifyWorkItem: vi.fn((id, intentClass) => ({ ...WI_OPEN, id, intentClass }) as never),
    listInbox: async () => [{ uid: 12, from: 'dana@example.com', subject: 'March invoice', date: '2026-09-15' }],
    getMailMessage: async (uid) => (uid === 12 ? { uid: 12, from: 'dana@example.com', to: 'me@example.com', subject: 'March invoice', date: '2026-09-15', text: 'Please chase this.' } : null),
    createTimeBlock: vi.fn((d) => ({ ...BLOCKS[0], id: 'b-new', title: d.title ?? '', startMs: d.startMs, durationMin: d.durationMin, taskId: d.taskId ?? null }) as never),
    runFlow: vi.fn(async () => ({ ok: true, steps: [{ actionId: 'a', type: 'notify', ok: true, message: 'sent' }] })) as never,
    contentToText: (raw) => {
      const out: string[] = []
      const walk = (v: unknown): void => {
        if (typeof v === 'string') out.push(v)
        else if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => k !== 'type' && walk(x))
      }
      try { walk(JSON.parse(raw ?? '')) } catch { return raw ?? '' }
      return out.join(' ').trim()
    },
    ...over
  } as WorkspaceDeps
}

const READ = { scopes: ['read' as const] }
const WRITE = { scopes: ['write' as const] }

type Reply = { result?: Record<string, unknown>; error?: { code: number; message: string } }
const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: '2.0', id: 1, method, params })
const call = async (name: string, args: Record<string, unknown>, caller = WRITE, d = deps()): Promise<Reply> =>
  (await handleWorkspaceMcpBody(rpc('tools/call', { name, arguments: args }), d, caller)) as Reply
const textOf = (r: Reply): string => ((r.result as { content: Array<{ text: string }> }).content[0] ?? { text: '' }).text
const isErr = (r: Reply): boolean => (r.result as { isError?: boolean })?.isError === true

// ── Protocol + scope ────────────────────────────────────────────────────────

describe('the workspace server: protocol and scope', () => {
  it('names itself plexii and claims exactly what it can answer', async () => {
    const r = (await handleWorkspaceMcpBody(rpc('initialize', { protocolVersion: '2025-11-25' }), deps(), READ)) as Reply
    expect(r.result?.serverInfo).toEqual({ name: 'plexii', version: '4.2.2' })
    // Tools and resources — and nothing else. Prompts and sampling are not
    // claimed, so a client never asks for what does not exist.
    expect(r.result?.capabilities).toEqual({ tools: {}, resources: {} })
    expect(r.result?.protocolVersion).toBe('2025-11-25')
  })

  it('every tool has annotations, a scope, a title, and an object input schema', () => {
    for (const t of WORKSPACE_TOOLS) {
      expect(t.annotations.title, t.name).toBeTruthy()
      expect(typeof t.annotations.readOnlyHint, t.name).toBe('boolean')
      expect(['read', 'write']).toContain(t.scope)
      expect((t.inputSchema as { type: string }).type).toBe('object')
      // A read-scope tool must say it is read-only; a write tool must not.
      expect(t.annotations.readOnlyHint, t.name).toBe(t.scope === 'read')
    }
    expect(new Set(WORKSPACE_TOOLS.map((t) => t.name)).size).toBe(WORKSPACE_TOOLS.length)
  })

  it('nothing on the surface deletes — no tool name or title says delete/trash/remove/purge', () => {
    for (const t of WORKSPACE_TOOLS) {
      expect(`${t.name} ${t.annotations.title}`.toLowerCase()).not.toMatch(/delete|trash|remove|purge/)
      expect(t.annotations.destructiveHint, t.name).toBe(false)
    }
  })

  // The naming check above is a convention, not a guarantee: a tool that
  // deleted but was not named so would pass it. This is the structural
  // version — the surface cannot delete because nothing that deletes is
  // wired into it. A tool can only reach the stores through WorkspaceDeps,
  // so if no member of that interface destroys anything, no tool can.
  it('cannot delete: no destructive capability is wired into WorkspaceDeps', () => {
    const src = readFileSync(join(ROOT, 'src/main/mcpServer.ts'), 'utf-8')
    const iface = src.slice(src.indexOf('export interface WorkspaceDeps'), src.indexOf('// ── Formatting helpers'))
    const members = [...iface.matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((m) => m[1])
    expect(members.length).toBeGreaterThan(20)
    for (const m of members) {
      expect(m, `WorkspaceDeps.${m} looks destructive`).not.toMatch(/delete|remove|purge|trash|destroy|drop|send|email/i)
    }
    // And the live wiring pulls in no store function of that shape either.
    const live = src.slice(src.indexOf('async function buildLiveWorkspaceDeps'))
    expect(live).not.toMatch(/\.(delete|remove|purge|trash|destroy)[A-Za-z]*\b/)
  })

  it('a read token lists only read tools; a write token lists all of them', async () => {
    const names = async (caller: { scopes: Array<'read' | 'write'> }) =>
      ((await handleWorkspaceMcpBody(rpc('tools/list'), deps(), caller)) as Reply).result!.tools as Array<{ name: string; annotations: unknown }>
    const readList = await names(READ)
    const writeList = await names(WRITE)
    expect(readList.map((t) => t.name)).toEqual(WORKSPACE_TOOLS.filter((t) => t.scope === 'read').map((t) => t.name))
    expect(writeList.length).toBe(WORKSPACE_TOOLS.length)
    expect(readList.every((t) => !t.name.startsWith('plexii_create') && t.name !== 'plexii_run_flow')).toBe(true)
    // Recall rides along on the workspace surface.
    expect(readList.map((t) => t.name)).toContain('recall_search')
    // Annotations reach the wire.
    expect(readList[0].annotations).toBeTruthy()
  })

  it('a read token calling a write tool is refused at the protocol level, not run', async () => {
    const d = deps()
    const r = await call('plexii_create_work_item', { title: 'x' }, READ, d)
    expect(r.error?.code).toBe(-32602)
    expect(r.error?.message).toContain('needs the "write" scope')
    expect(d.createWorkItem).not.toHaveBeenCalled()
  })

  it('a token with NO usable scope sees an empty list and cannot read', async () => {
    const empty = { scopes: [] as Array<'read' | 'write'> }
    const list = (await handleWorkspaceMcpBody(rpc('tools/list'), deps(), empty)) as Reply
    expect(list.result?.tools).toEqual([])
    const r = await call('plexii_list_desks', {}, empty)
    expect(r.error?.code).toBe(-32602)
  })

  it('a batch of mixed requests and notifications answers only the requests', async () => {
    const out = (await handleWorkspaceMcpBody(
      [rpc('ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, { ...rpc('tools/list'), id: 2 }],
      deps(),
      READ
    )) as Reply[]
    expect(out).toHaveLength(2)
  })

  it('a thrown store error becomes an isError result, never a crash', async () => {
    const r = await call('plexii_list_desks', {}, READ, deps({ listNodes: () => { throw new Error('db locked') } }))
    expect(isErr(r)).toBe(true)
    expect(textOf(r)).toContain('db locked')
  })
})

// ── Read tools ──────────────────────────────────────────────────────────────

describe('read tools', () => {
  it('plexii_search returns typed hits with ids, and an honest zero', async () => {
    const hit = textOf(await call('plexii_search', { query: 'contract' }, READ))
    expect(hit).toContain('task · d1 · Launch week')
    expect(hit).toContain('the contract')
    expect(textOf(await call('plexii_search', { query: 'zzz' }, READ))).toContain('honest zero')
    expect(isErr(await call('plexii_search', { query: 'a' }, READ))).toBe(true)
  })

  it('plexii_list_desks hides done desks by default and shows folders', async () => {
    const out = textOf(await call('plexii_list_desks', {}, READ))
    expect(out).toContain('d1 · desk · [active] Launch week')
    expect(out).toContain('f1 · folder')
    expect(out).not.toContain('Old desk')
    expect(textOf(await call('plexii_list_desks', { includeDone: true }, READ))).toContain('Old desk')
  })

  // plexii_list_desks gives a desk's NAME. This is the tool that gives its
  // CONTENTS, which is what a desk actually is.
  it('plexii_read_desk reads the widgets on the canvas, following table and document pointers', async () => {
    const out = textOf(await call('plexii_read_desk', { deskId: 'd1' }, READ))
    expect(out).toContain('# Launch week')

    // Prose straight from the widget.
    expect(out).toContain('Ship on Monday. Dana owns the contract.')
    // A table widget's content is a table ID — the resolver must follow it to
    // real columns and rows, not print the id.
    expect(out).toContain('Name | Stage')
    expect(out).toContain('Acme')
    expect(out).not.toContain('content: t1')
    // A document widget's content is a document id — likewise.
    expect(out).toContain('Ship on Monday.')
    // The transcript that used to be invisible to every AI surface.
    expect(out).toContain('Chase the March invoice with Dolan Freight.')
  })

  it('plexii_read_desk leaves chrome out but says how much it left out', async () => {
    const out = textOf(await call('plexii_read_desk', { deskId: 'd1' }, READ))
    // A section header and a minimap render UI, not content.
    expect(out).not.toMatch(/^## Layout/m)
    expect(out).not.toContain('(minimap')
    expect(out).toContain('2 empty or layout-only widgets not shown')
    expect(out).toContain('4 of 6 widgets')
  })

  it('plexii_read_desk is honest about an empty desk and an unknown one', async () => {
    const empty = deps({ listWidgetsByTask: () => [] })
    expect(textOf(await call('plexii_read_desk', { deskId: 'd1' }, READ, empty))).toContain('empty desk')
    expect(isErr(await call('plexii_read_desk', { deskId: 'nope' }, READ))).toBe(true)
  })

  it('plexii_read_desk pages, and says exactly how to get the rest', async () => {
    const out = textOf(await call('plexii_read_desk', { deskId: 'd1', limit: 1 }, READ))
    expect(out).toContain('Kickoff notes')
    expect(out).not.toContain('Chase the March invoice')
    // A count alone leaves the model guessing; the offset makes it actionable.
    expect(out).toContain('offset=1')
    const next = textOf(await call('plexii_read_desk', { deskId: 'd1', limit: 1, offset: 1 }, READ))
    expect(next).not.toContain('Kickoff notes')
  })

  // Every list used to end in .slice(0, limit) and say nothing — the model read
  // 100 of 400 work items and reasoned about "all" of them.
  describe('paging: a truncated list never pretends to be the whole list', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...WI_OPEN, id: `w${i}`, title: `Item ${i}` })) as FbNode[]

    it('reports the total and the next offset when there is more', async () => {
      const d = deps({ listWorkItems: () => many })
      const out = textOf(await call('plexii_list_work_items', { state: 'all', limit: 50 }, READ, d))
      expect(out).toContain('Item 0')
      expect(out).not.toContain('Item 50')
      expect(out).toContain('of 250')
      expect(out).toContain('offset=50')
    })

    it('walks pages without gaps or repeats', async () => {
      const d = deps({ listWorkItems: () => many })
      const p1 = textOf(await call('plexii_list_work_items', { state: 'all', limit: 100 }, READ, d))
      const p2 = textOf(await call('plexii_list_work_items', { state: 'all', limit: 100, offset: 100 }, READ, d))
      const p3 = textOf(await call('plexii_list_work_items', { state: 'all', limit: 100, offset: 200 }, READ, d))
      expect(p1).toContain('Item 99')
      expect(p1).not.toContain('Item 100 ')
      expect(p2).toContain('Item 100')
      expect(p3).toContain('Item 249')
      // The last page says it is the last — no offset to chase.
      expect(p3).not.toContain('offset=')
      expect(p3).toContain('250 in total')
    })

    it('says nothing about paging when everything fits', async () => {
      const out = textOf(await call('plexii_list_desks', {}, READ))
      expect(out).not.toContain('offset=')
      expect(out).not.toContain('in total')
    })

    it('advertises offset on every tool that pages, so a model can actually use it', () => {
      const paged = ['plexii_list_work_items', 'plexii_list_desks', 'plexii_list_documents', 'plexii_table_rows',
        'plexii_list_knowledge', 'plexii_list_contacts', 'plexii_list_files', 'plexii_list_meetings', 'plexii_read_desk']
      for (const name of paged) {
        const t = WORKSPACE_TOOLS.find((x) => x.name === name)!
        const props = (t.inputSchema as { properties: Record<string, unknown> }).properties
        expect(Object.keys(props), name).toContain('offset')
      }
    })
  })

  it('plexii_list_work_items filters by active/all/state, intent (incl. legacy names) and desk', async () => {
    const active = textOf(await call('plexii_list_work_items', {}, READ))
    expect(active).toContain('w1 · [open] Countersign the contract')
    expect(active).toContain('intent=to_do · due=2026-09-19T00:00:00.000Z · urgency=high · tags=legal,launch')
    expect(active).not.toContain('Old thing')
    expect(textOf(await call('plexii_list_work_items', { state: 'all' }, READ))).toContain('Old thing')
    const completed = textOf(await call('plexii_list_work_items', { state: 'completed' }, READ))
    expect(completed).toContain('w2 · [completed] Old thing · intent=to_review')
    expect(completed).not.toContain('w1')
    expect(textOf(await call('plexii_list_work_items', { intent: 'to_decide' }, READ))).toContain('Pick a vendor')
    // legacy 'action' maps forward to to_do
    expect(textOf(await call('plexii_list_work_items', { intent: 'action' }, READ))).toContain('Countersign')
    expect(textOf(await call('plexii_list_work_items', { deskId: 'd1' }, READ))).not.toContain('Pick a vendor')
    expect(textOf(await call('plexii_list_work_items', { intent: 'to_meet' }, READ))).toContain('honest zero')
  })

  it('plexii_get_work_item renders the full record; unknown id is isError', async () => {
    const out = textOf(await call('plexii_get_work_item', { id: 'w1' }, READ))
    expect(out).toContain('# Countersign the contract')
    expect(out).toContain('source: https://example.com/mail/1')
    expect(out).toContain('desk: d1')
    expect(out).toContain('Dana needs it by Friday')
    expect(isErr(await call('plexii_get_work_item', { id: 'nope' }, READ))).toBe(true)
  })

  it('plexii_list_documents hides archived and filters by type', async () => {
    const out = textOf(await call('plexii_list_documents', {}, READ))
    expect(out).toContain('doc1 · doc · Launch plan · edited 2025-09-04')
    expect(out).not.toContain('Archived')
    expect(textOf(await call('plexii_list_documents', { docType: 'sheet' }, READ))).toBe('sh1 · sheet · Budget · edited 2025-09-04')
  })

  // Reading a document and reading the same document as a widget go through
  // ONE extractor now (docBodyToText), so the two can never disagree.
  it('plexii_read_document renders every type through the shared extractor', async () => {
    const doc = textOf(await call('plexii_read_document', { id: 'doc1' }, READ))
    expect(doc).toContain('Plan')
    expect(doc).toContain('Ship on Monday.')
    // A sheet keeps its column structure — "Ads 1200 Video 800" is not a table.
    const sheet = textOf(await call('plexii_read_document', { id: 'sh1' }, READ))
    expect(sheet).toContain('Item | Cost')
    expect(sheet).toContain('Ads | 1200')
    const slides = textOf(await call('plexii_read_document', { id: 'sl1' }, READ))
    expect(slides).toContain('Why now')
    expect(slides).toContain('Tabs get closed')
    expect(isErr(await call('plexii_read_document', { id: 'nope' }, READ))).toBe(true)
  })

  it('plexii_list_tables shows column labels AND ids; plexii_table_rows is TSV with a header', async () => {
    expect(textOf(await call('plexii_list_tables', {}, READ))).toContain('columns: Name (text-short, id c_name), Stage (text-short, id c_stage)')
    const rows = textOf(await call('plexii_table_rows', { tableId: 't1' }, READ))
    expect(rows).toContain('row_id\tName\tStage\nr1\tAcme\tDemo\nr2\tGlobex\t')
    expect(isErr(await call('plexii_table_rows', { tableId: 'nope' }, READ))).toBe(true)
  })

  it('plexii_list_knowledge lists (pinned marked) or searches', async () => {
    const all = textOf(await call('plexii_list_knowledge', {}, READ))
    expect(all).toContain('k1 · 📌 Pricing · tags=pricing')
    expect(all).toContain('Pro is $9.95/mo.')
    expect(textOf(await call('plexii_list_knowledge', { query: 'punchy' }, READ))).toContain('k2 · Tone')
    expect(textOf(await call('plexii_list_knowledge', { query: 'zzz' }, READ))).toContain('No knowledge matches')
  })

  it('plexii_calendar lists blocks in a range, sorted, marking meetings; rejects a backwards range', async () => {
    const out = textOf(await call('plexii_calendar', { from: '2026-09-15T00:00:00Z', to: '2026-09-17T00:00:00Z' }, READ))
    const standup = out.indexOf('Standup')
    const deep = out.indexOf('Deep work')
    expect(standup).toBeGreaterThan(-1)
    expect(deep).toBeGreaterThan(standup)
    expect(out).toContain('15 min · [planned] Standup · meeting')
    expect(out).toContain('desk d1')
    expect(textOf(await call('plexii_calendar', { from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z' }, READ))).toContain('Nothing scheduled')
    expect(isErr(await call('plexii_calendar', { from: '2026-09-17T00:00:00Z', to: '2026-09-15T00:00:00Z' }, READ))).toBe(true)
  })

  it('plexii_list_flows shows trigger, enabled and last run', async () => {
    expect(textOf(await call('plexii_list_flows', {}, READ))).toBe('fl1 · on · trigger=schedule · Nightly digest · last 2025-09-04T15:33:20.000Z (ok)')
  })
})

// ── Write tools ─────────────────────────────────────────────────────────────

describe('write tools — attributed, validated, never destructive', () => {
  it('plexii_create_work_item is born origin ai with the supplied fields, and validates intent/due/desk', async () => {
    const d = deps()
    const r = await call('plexii_create_work_item', { title: 'Book the venue', intent: 'to_meet', dueAt: '2026-09-20T09:00:00Z', tags: 'launch', deskId: 'd1', urgency: 'high' }, WRITE, d)
    expect(d.createWorkItem).toHaveBeenCalledWith(expect.objectContaining({ title: 'Book the venue', intentClass: 'to_meet', wiOrigin: 'ai', parentId: 'd1', dueAt: '2026-09-20T09:00:00Z', tags: 'launch', wiUrgency: 'high' }))
    expect(textOf(r)).toContain('Created work item w-new')
    expect((r.result as { structuredContent: { id: string } }).structuredContent.id).toBe('w-new')
    // legacy intent names map forward instead of failing
    await call('plexii_create_work_item', { title: 'x', intent: 'review' }, WRITE, d)
    expect(d.createWorkItem).toHaveBeenLastCalledWith(expect.objectContaining({ intentClass: 'to_review' }))
    expect(isErr(await call('plexii_create_work_item', { title: 'x', intent: 'to_fly' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_work_item', { title: 'x', dueAt: 'friday' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_work_item', { title: 'x', deskId: 'nope' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_work_item', {}, WRITE, d))).toBe(true)
  })

  it('a refused creation (work items disabled) surfaces as isError with the store message', async () => {
    const d = deps({ createWorkItem: () => { throw new Error('Work items are not enabled.') } })
    const r = await call('plexii_create_work_item', { title: 'x' }, WRITE, d)
    expect(isErr(r)).toBe(true)
    expect(textOf(r)).toContain('Work items are not enabled.')
  })

  it('plexii_set_work_item_state accepts every declared state and refuses invented ones', async () => {
    const d = deps()
    for (const s of WORK_ITEM_STATES) {
      expect(isErr(await call('plexii_set_work_item_state', { id: 'w1', state: s }, WRITE, d)), s).toBe(false)
    }
    expect(d.setWorkItemState).toHaveBeenCalledTimes(WORK_ITEM_STATES.length)
    expect(isErr(await call('plexii_set_work_item_state', { id: 'w1', state: 'deleted' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_set_work_item_state', { id: 'nope', state: 'completed' }, WRITE, d))).toBe(true)
    const refused = deps({ setWorkItemState: () => false })
    expect(isErr(await call('plexii_set_work_item_state', { id: 'w1', state: 'completed' }, WRITE, refused))).toBe(true)
  })

  it('plexii_create_desk, plexii_create_knowledge, plexii_create_document return ids', async () => {
    const d = deps()
    expect(textOf(await call('plexii_create_desk', { title: 'Q4 planning', description: 'why' }, WRITE, d))).toContain('Created desk d-new')
    expect(d.createDesk).toHaveBeenCalledWith('Q4 planning', 'why')
    expect(textOf(await call('plexii_create_knowledge', { title: 'T', body: 'B', tags: 'a, b,,' }, WRITE, d))).toContain('k-new')
    expect(d.createKnowledge).toHaveBeenCalledWith({ title: 'T', body: 'B', tags: ['a', 'b'] })
    expect(isErr(await call('plexii_create_knowledge', { title: 'T' }, WRITE, d))).toBe(true)
    expect(textOf(await call('plexii_create_document', { title: 'Brief', markdown: '# Hi' }, WRITE, d))).toContain('doc-new')
    expect(d.createDocument).toHaveBeenCalledWith(expect.objectContaining({ docType: 'doc', title: 'Brief' }))
    expect(isErr(await call('plexii_create_document', { markdown: 'x' }, WRITE, d))).toBe(true)
  })

  it('plexii_add_table_row resolves labels (case-insensitive) or ids, reports unknown keys, refuses all-unknown', async () => {
    const d = deps()
    const r = await call('plexii_add_table_row', { tableId: 't1', cells: { name: 'Initech', c_stage: 'Won', Bogus: 1 } }, WRITE, d)
    expect(d.createRow).toHaveBeenCalledWith({ tableId: 't1', cells: { c_name: 'Initech', c_stage: 'Won' } })
    expect(textOf(r)).toContain('ignored unknown columns: Bogus')
    expect(isErr(await call('plexii_add_table_row', { tableId: 't1', cells: { Bogus: 1 } }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_add_table_row', { tableId: 't1', cells: 'x' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_add_table_row', { tableId: 'nope', cells: {} }, WRITE, d))).toBe(true)
  })

  // The gap a real session hit: you could append to a table but never make one,
  // and nothing you created could be put on a desk.
  it('plexii_create_table builds typed columns and places it on the desk', async () => {
    const d = deps()
    const r = await call('plexii_create_table', {
      title: 'GTM enquiries',
      deskId: 'd1',
      columns: [
        { label: 'Company', type: 'text-short' },
        { label: 'Stage', type: 'single-select', options: ['New', 'Qualified'] },
        { label: 'Value', type: 'number' }
      ]
    }, WRITE, d)

    const draft = (d.createTable as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(draft.taskId).toBe('d1')
    expect(draft.schema.columns.map((c: { label: string; type: string }) => [c.label, c.type])).toEqual([
      ['Company', 'text-short'], ['Stage', 'single-select'], ['Value', 'number']
    ])
    // Select options are materialised with ids, not left as bare strings.
    expect(draft.schema.columns[1].config.options.map((o: { label: string }) => o.label)).toEqual(['New', 'Qualified'])
    expect(draft.schema.columns[1].config.options[0].id).toBeTruthy()

    // A table is SEEN through a widget pointing at it — without one it exists
    // but appears on no canvas.
    expect(d.createWidget).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'd1', kind: 'table', content: 't-new' }))
    expect(textOf(r)).toContain('It is on the desk.')
    expect((r.result as { structuredContent: { id: string } }).structuredContent.id).toBe('t-new')
  })

  it('plexii_create_table without a desk creates it unfiled, and says so', async () => {
    const d = deps()
    const r = await call('plexii_create_table', { title: 'Loose', columns: [{ label: 'A' }] }, WRITE, d)
    expect(d.createWidget).not.toHaveBeenCalled()
    expect(textOf(r)).toContain('not on a desk')
    // An unspecified column type defaults to text rather than failing.
    expect((d.createTable as ReturnType<typeof vi.fn>).mock.calls[0][0].schema.columns[0].type).toBe('text-short')
  })

  it('plexii_create_table refuses bad input instead of making a broken table', async () => {
    const d = deps()
    expect(isErr(await call('plexii_create_table', { title: 'T', columns: [] }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_table', { title: 'T', columns: [{ type: 'number' }] }, WRITE, d))).toBe(true)
    // relation/attachment need a target this surface cannot supply.
    const bad = await call('plexii_create_table', { title: 'T', columns: [{ label: 'X', type: 'relation' }] }, WRITE, d)
    expect(isErr(bad)).toBe(true)
    expect(textOf(bad)).toContain('relation')
    expect(isErr(await call('plexii_create_table', { title: 'T', columns: [{ label: 'A' }], deskId: 'nope' }, WRITE, d))).toBe(true)
    expect(d.createTable).not.toHaveBeenCalled()
  })

  it('plexii_create_widget puts text on a canvas, and only text kinds', async () => {
    const d = deps()
    const r = await call('plexii_create_widget', { deskId: 'd1', kind: 'markdown', title: 'Plan', content: '# Hi' }, WRITE, d)
    expect(d.createWidget).toHaveBeenCalledWith({ taskId: 'd1', kind: 'markdown', title: 'Plan', content: '# Hi' })
    expect(textOf(r)).toContain('wg-new')
    // Default kind, and the refusals.
    await call('plexii_create_widget', { deskId: 'd1', content: 'x' }, WRITE, d)
    expect(d.createWidget).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'note' }))
    expect(isErr(await call('plexii_create_widget', { deskId: 'd1', kind: 'table', content: 'x' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_widget', { deskId: 'd1', content: '   ' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_widget', { deskId: 'nope', content: 'x' }, WRITE, d))).toBe(true)
  })

  it('plexii_create_document can now be filed on a desk', async () => {
    const d = deps()
    await call('plexii_create_document', { title: 'Brief', markdown: '# Hi', deskId: 'd1' }, WRITE, d)
    expect(d.createWidget).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'd1', kind: 'doc', content: 'doc-new' }))

    // Still optional: without a deskId it lives in Documents only.
    const plain = deps()
    await call('plexii_create_document', { title: 'Brief', markdown: '# Hi' }, WRITE, plain)
    expect(plain.createWidget).not.toHaveBeenCalled()
    expect(isErr(await call('plexii_create_document', { title: 'B', markdown: 'x', deskId: 'nope' }, WRITE, plain))).toBe(true)
  })

  it('plexii_create_time_block validates start/duration/desk', async () => {
    const d = deps()
    const r = await call('plexii_create_time_block', { title: 'Focus', start: '2026-09-16T02:00:00Z', durationMin: 60, deskId: 'd1' }, WRITE, d)
    expect(d.createTimeBlock).toHaveBeenCalledWith({ taskId: 'd1', title: 'Focus', startMs: Date.parse('2026-09-16T02:00:00Z'), durationMin: 60 })
    expect(textOf(r)).toContain('Created time block b-new')
    expect(isErr(await call('plexii_create_time_block', { title: 'F', start: 'soon', durationMin: 60 }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_time_block', { title: 'F', start: '2026-09-16T02:00:00Z', durationMin: 2 }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_time_block', { title: 'F', start: '2026-09-16T02:00:00Z', durationMin: 60, deskId: 'nope' }, WRITE, d))).toBe(true)
  })

  it('edits change only what was passed, and refuse to empty a name', async () => {
    const d = deps()
    await call('plexii_update_work_item', { id: 'w1', notes: 'new detail' }, WRITE, d)
    expect(d.updateWorkItemFields).toHaveBeenCalledWith('w1', { description: 'new detail' })
    // Clearing a due date is explicit and allowed; blanking a title is not.
    await call('plexii_update_work_item', { id: 'w1', dueAt: '' }, WRITE, d)
    expect(d.updateWorkItemFields).toHaveBeenLastCalledWith('w1', { dueAt: null })
    expect(isErr(await call('plexii_update_work_item', { id: 'w1', title: '  ' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_update_work_item', { id: 'w1' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_update_work_item', { id: 'nope', title: 'x' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_update_work_item', { id: 'w1', dueAt: 'friday' }, WRITE, d))).toBe(true)
  })

  // A patch naming one cell must not blank the others.
  describe('batch: twenty rows should be one request, not twenty', () => {
    it('adds many rows in one call and returns their ids', async () => {
      const d = deps()
      const r = await call('plexii_add_table_rows', {
        tableId: 't1',
        rows: [{ Name: 'Acme' }, { Name: 'Globex', Stage: 'Demo' }, { c_name: 'Initech' }]
      }, WRITE, d)
      expect(isErr(r)).toBe(false)
      expect(d.createRow).toHaveBeenCalledTimes(3)
      expect((r.result as { structuredContent: { added: number } }).structuredContent.added).toBe(3)
      expect(textOf(r)).toContain('Added 3 of 3 rows')
    })

    // "Added 20 rows" when three were malformed is a lie about their data.
    it('reports partial success as partial, and still lands the good rows', async () => {
      const d = deps()
      const r = await call('plexii_add_table_rows', {
        tableId: 't1',
        rows: [{ Name: 'Acme' }, 'not an object', { Bogus: 1 }, { Name: 'Initech', Nope: 2 }]
      }, WRITE, d)
      expect(d.createRow).toHaveBeenCalledTimes(2)
      const out = textOf(r)
      expect(out).toContain('Added 2 of 4 rows')
      expect(out).toContain('row 2')
      expect(out).toContain('row 3')
      expect(out).toContain('Nope')
      expect(isErr(r)).toBe(false)
    })

    it('is an error only when nothing at all landed', async () => {
      const d = deps()
      const r = await call('plexii_add_table_rows', { tableId: 't1', rows: [{ Bogus: 1 }] }, WRITE, d)
      expect(isErr(r)).toBe(true)
      expect(d.createRow).not.toHaveBeenCalled()
      expect(isErr(await call('plexii_add_table_rows', { tableId: 't1', rows: [] }, WRITE, d))).toBe(true)
      expect(isErr(await call('plexii_add_table_rows', { tableId: 'nope', rows: [{ a: 1 }] }, WRITE, d))).toBe(true)
    })

    it('refuses an absurd batch rather than hanging on it', async () => {
      const d = deps()
      const rows = Array.from({ length: 501 }, () => ({ Name: 'x' }))
      expect(isErr(await call('plexii_add_table_rows', { tableId: 't1', rows }, WRITE, d))).toBe(true)
      expect(d.createRow).not.toHaveBeenCalled()
    })

    // A bulk write is the worst kind to lose from the record.
    it('is attributed like any other write', async () => {
      const d = deps()
      await call('plexii_add_table_rows', { tableId: 't1', rows: [{ Name: 'Acme' }] }, WRITE, d)
      expect(d.recordAgentWrite).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plexii_add_table_rows', objectId: 'r-new' })
      )
    })
  })

  it('plexii_update_table_row merges cells instead of replacing the row', async () => {
    const d = deps()
    await call('plexii_update_table_row', { tableId: 't1', rowId: 'r1', cells: { Stage: 'Won' } }, WRITE, d)
    expect(d.updateRow).toHaveBeenCalledWith('r1', { cells: { c_name: 'Acme', c_stage: 'Won' } })
    expect(isErr(await call('plexii_update_table_row', { tableId: 't1', rowId: 'nope', cells: { Stage: 'x' } }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_update_table_row', { tableId: 't1', rowId: 'r1', cells: { Bogus: 1 } }, WRITE, d))).toBe(true)
  })

  it('plexii_update_widget edits text but refuses to repoint a pointer widget', async () => {
    const d = deps()
    await call('plexii_update_widget', { id: 'wg1', content: 'revised' }, WRITE, d)
    expect(d.updateWidget).toHaveBeenCalledWith('wg1', { content: 'revised' })
    // A table widget's content is a table id — "editing" it would swap what the
    // widget shows, which is not what anyone means by edit.
    const swap = await call('plexii_update_widget', { id: 'wgT', content: 'other-table' }, WRITE, d)
    expect(isErr(swap)).toBe(true)
    expect(textOf(swap)).toContain('pointer')
  })

  it('plexii_update_document refuses a non-doc rather than corrupting it', async () => {
    const d = deps()
    await call('plexii_update_document', { id: 'doc1', markdown: '# New' }, WRITE, d)
    expect(d.updateDocument).toHaveBeenCalled()
    const sheet = await call('plexii_update_document', { id: 'sh1', markdown: '# New' }, WRITE, d)
    expect(isErr(sheet)).toBe(true)
    expect(textOf(sheet)).toContain('sheet')
  })

  it('plexii_update_desk / knowledge / time_block validate before writing', async () => {
    const d = deps()
    await call('plexii_update_desk', { deskId: 'd1', title: 'Renamed' }, WRITE, d)
    expect(d.updateNode).toHaveBeenCalledWith('d1', { title: 'Renamed' })
    expect(isErr(await call('plexii_update_desk', { deskId: 'nope', title: 'x' }, WRITE, d))).toBe(true)
    await call('plexii_update_knowledge', { id: 'k1', tags: 'a, b' }, WRITE, d)
    expect(d.updateKnowledge).toHaveBeenCalledWith('k1', { tags: ['a', 'b'] })
    expect(isErr(await call('plexii_update_time_block', { id: 'b1', durationMin: 2 }, WRITE, d))).toBe(true)
    await call('plexii_update_time_block', { id: 'b1', start: '2026-09-20T09:00:00Z' }, WRITE, d)
    expect(d.updateTimeBlock).toHaveBeenCalledWith('b1', { startMs: Date.parse('2026-09-20T09:00:00Z') })
  })

  // Drafting is allowed; sending is not, and the tool must not blur that.
  it('plexii_draft_email drafts into the queue and never claims to send', async () => {
    const d = deps()
    const r = await call('plexii_draft_email', { to: 'dana@example.com', subject: 'Invoice', body: 'Chasing March.' }, WRITE, d)
    const draft = (d.createWorkItem as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(draft.intentClass).toBe('to_respond')
    expect(draft.wiOrigin).toBe('ai')
    expect(draft.notes).toContain('To: dana@example.com')
    expect(draft.notes).toContain('Chasing March.')
    expect(textOf(r)).toContain('not sent')
    expect(isErr(await call('plexii_draft_email', { to: 'x', subject: 'y' }, WRITE, d))).toBe(true)
  })

  it('a browser window can be put on a desk, but only on a real http(s) URL', async () => {
    const d = deps()
    await call('plexii_create_widget', { deskId: 'd1', kind: 'webview', content: 'https://example.com/pricing' }, WRITE, d)
    expect(d.createWidget).toHaveBeenCalledWith(expect.objectContaining({ kind: 'webview', content: 'https://example.com/pricing' }))
    // file:// would turn "open a page" into "read the disk".
    expect(isErr(await call('plexii_create_widget', { deskId: 'd1', kind: 'webview', content: 'file:///etc/passwd' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_widget', { deskId: 'd1', kind: 'webview', content: 'not a url' }, WRITE, d))).toBe(true)
  })

  it('files can be listed and read, and an unreadable one says so', async () => {
    const list = textOf(await call('plexii_list_files', {}, READ))
    expect(list).toContain('f1 · file · brief.md')
    const body = textOf(await call('plexii_read_file', { id: 'f1' }, READ))
    expect(body).toContain('Launch is Monday.')
    const folder = await call('plexii_read_file', { id: 'fold' }, READ)
    expect(isErr(folder)).toBe(true)
    expect(textOf(folder)).toContain('folder')
    const binary = await call('plexii_read_file', { id: 'f1' }, READ, deps({ fileText: async () => null }))
    expect(isErr(binary)).toBe(true)
    expect(textOf(binary)).toContain('nothing here invents')
  })

  it('creates every document type in the shape that type understands', async () => {
    const d = deps()
    await call('plexii_create_document', { title: 'Budget', docType: 'sheet', columns: ['Item', 'Cost'], rows: [['Ads', '1200']] }, WRITE, d)
    const sheet = (d.createDocument as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(sheet.docType).toBe('sheet')
    expect(sheet.body.sheets[0].columns).toEqual(['Item', 'Cost'])
    expect(sheet.body.sheets[0].rows).toEqual([['Ads', '1200']])

    await call('plexii_create_document', { title: 'Pitch', docType: 'slides', slides: [{ title: 'Why now', bullets: ['Tabs close'] }] }, WRITE, d)
    const deck = (d.createDocument as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(deck.body.slides[0].title).toBe('Why now')
    expect(deck.body.slides[0].bullets).toEqual(['Tabs close'])

    // A diagram CAN be described in text, and edges resolve by node label.
    await call('plexii_create_document', { title: 'Flow', docType: 'map', nodes: ['Draft', 'Review'], edges: [{ from: 'Draft', to: 'Review', label: 'send' }] }, WRITE, d)
    const map = (d.createDocument as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    // Flat MapNode, not React-Flow's nested shape — normalizeMapBody drops
    // anything else, which is how a diagram ends up with blank shapes.
    expect(map.body.nodes.map((n: { label: string }) => n.label)).toEqual(['Draft', 'Review'])
    expect(map.body.nodes[0]).toMatchObject({ id: 'n1', shape: 'process' })
    expect(typeof map.body.nodes[0].x).toBe('number')
    expect(map.body.edges[0]).toMatchObject({ source: 'n1', target: 'n2', label: 'send' })

    // Geometry is created EMPTY rather than invented.
    const drawn = await call('plexii_create_document', { title: 'Poster', docType: 'draw' }, WRITE, d)
    expect((d.createDocument as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0].body.layers).toEqual([])
    expect(textOf(drawn)).toContain('empty, ready to work in')

    expect(isErr(await call('plexii_create_document', { title: 'X', docType: 'sheet' }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_document', { title: 'X', docType: 'pdf' }, WRITE, d))).toBe(true)
  })

  it('the desk widget matches the document type, not a doc frame around everything', async () => {
    const d = deps()
    await call('plexii_create_document', { title: 'Budget', docType: 'sheet', columns: ['A'], deskId: 'd1' }, WRITE, d)
    expect(d.createWidget).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sheet' }))
  })

  it('editing a document takes the body shape of its own type, and refuses geometry', async () => {
    const d = deps({ getDocument: (id) => (id === 'sh1' ? (SHEET as never) : id === 'dr1' ? ({ id: 'dr1', docType: 'draw', title: 'Poster' } as never) : (DOC as never)) })
    await call('plexii_update_document', { id: 'sh1', columns: ['X'], rows: [['1']] }, WRITE, d)
    expect((d.updateDocument as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1].body.sheets[0].columns).toEqual(['X'])
    // Renaming a drawing is fine; rewriting it is not.
    expect(isErr(await call('plexii_update_document', { id: 'dr1', title: 'Renamed' }, WRITE, d))).toBe(false)
    const rewrite = await call('plexii_update_document', { id: 'dr1', markdown: '# nope' }, WRITE, d)
    expect(isErr(rewrite)).toBe(true)
    expect(textOf(rewrite)).toContain('geometry')
  })

  it('table columns can be added and renamed without moving data', async () => {
    const d = deps()
    await call('plexii_add_table_column', { tableId: 't1', label: 'Owner' }, WRITE, d)
    const added = (d.updateTable as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]
    expect(added.schema.columns.map((c: { label: string }) => c.label)).toEqual(['Name', 'Stage', 'Owner'])
    expect(isErr(await call('plexii_add_table_column', { tableId: 't1', label: 'name' }, WRITE, d))).toBe(true)

    // A rename must KEEP the column id, or every existing row loses its value.
    await call('plexii_update_table_column', { tableId: 't1', column: 'Stage', label: 'Status' }, WRITE, d)
    const renamed = (d.updateTable as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]
    const col = renamed.schema.columns.find((c: { id: string }) => c.id === 'c_stage')
    expect(col.label).toBe('Status')
    expect(isErr(await call('plexii_update_table_column', { tableId: 't1', column: 'Nope', label: 'x' }, WRITE, d))).toBe(true)
    // Options only mean something on a select column.
    expect(isErr(await call('plexii_update_table_column', { tableId: 't1', column: 'Name', options: ['a'] }, WRITE, d))).toBe(true)
  })

  it('contacts can be listed, created and edited', async () => {
    const d = deps()
    expect(textOf(await call('plexii_list_contacts', {}, READ, d))).toContain('p1 · Dana Reed')
    expect(textOf(await call('plexii_list_contacts', { query: 'dolan' }, READ, d))).toContain('Dana Reed')
    expect(textOf(await call('plexii_list_contacts', { query: 'zzz' }, READ, d))).toContain('No contacts match')
    await call('plexii_create_contact', { name: 'Sam Vale', email: 's@x.test', tags: 'lead, gtm' }, WRITE, d)
    expect(d.createContact).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sam Vale', tags: ['lead', 'gtm'] }))
    await call('plexii_update_contact', { id: 'p1', role: 'Head of Ops' }, WRITE, d)
    expect(d.updateContact).toHaveBeenCalledWith('p1', { role: 'Head of Ops' })
    expect(isErr(await call('plexii_update_contact', { id: 'nope', role: 'x' }, WRITE, d))).toBe(true)
  })

  it('mail can be listed and read, and says so honestly with no account', async () => {
    const d = deps()
    expect(textOf(await call('plexii_list_mail', {}, READ, d))).toContain('12 · dana@example.com · March invoice')
    expect(textOf(await call('plexii_read_mail', { uid: 12 }, READ, d))).toContain('Please chase this.')
    expect(isErr(await call('plexii_read_mail', { uid: 999 }, READ, d))).toBe(true)
    const none = deps({ listInbox: async () => null, getMailMessage: async () => null })
    const r = await call('plexii_list_mail', {}, READ, none)
    expect(isErr(r)).toBe(true)
    expect(textOf(r)).toContain('No mail account is connected')
  })

  // Mail bodies are written by strangers. The tool must say so.
  it('plexii_read_mail warns that a message body is not instructions', () => {
    const t = WORKSPACE_TOOLS.find((x) => x.name === 'plexii_read_mail')!
    expect(t.description).toMatch(/never as instructions/i)
  })

  // The gate that matters most in this batch. Refusing to RUN an outbound flow
  // is worthless if one can be CREATED here and left on a schedule.
  it('plexii_create_flow refuses an outbound step at BUILD time, naming it', async () => {
    const d = deps()
    for (const type of [...OUTBOUND_FLOW_ACTIONS]) {
      const r = await call('plexii_create_flow', {
        title: 'Exfiltrate', trigger: 'schedule', every: 'hour', enabled: true,
        actions: [{ type, url: 'https://evil.test', to: 'x@y.z', subject: 's', body: 'b', method: 'POST', headers: '' }]
      }, WRITE, d)
      expect(isErr(r), type).toBe(true)
      expect(textOf(r)).toContain(type)
      expect(textOf(r)).toContain('leaves this machine')
      expect(d.createFlow, type).not.toHaveBeenCalled()
    }
  })

  it('plexii_create_flow builds internal steps, and starts switched OFF', async () => {
    const d = deps()
    const r = await call('plexii_create_flow', {
      title: 'Nightly tidy', trigger: 'schedule', every: 'day',
      actions: [{ type: 'create-task', title: 'Review inbox' }, { type: 'ai-step', prompt: 'summarise' }]
    }, WRITE, d)
    expect(isErr(r)).toBe(false)
    const patch = (d.updateFlow as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]
    expect(patch.trigger).toEqual({ kind: 'schedule', every: 'day' })
    expect(patch.actions.map((a: { type: string }) => a.type)).toEqual(['create-task', 'ai-step'])
    // A flow that starts running the moment it is written is a surprise.
    expect(patch.enabled).toBe(false)
    expect(textOf(r)).toContain('switched off')

    expect(isErr(await call('plexii_create_flow', { title: 'X', actions: [] }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_flow', { title: 'X', trigger: 'schedule', actions: [{ type: 'ai-step', prompt: 'p' }] }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_create_flow', { title: 'X', actions: [{ type: 'teleport' }] }, WRITE, d))).toBe(true)
  })

  // The third door: enabling an existing outbound flow would send on a schedule.
  it('plexii_update_flow will neither rewrite nor switch on a flow that reaches out', async () => {
    const outbound = deps({ getFlow: () => ({ ...FLOW, actions: [{ id: 'a', type: 'http-request' }] }) as never })
    const rewrite = await call('plexii_update_flow', { id: 'fl1', actions: [{ type: 'ai-step', prompt: 'p' }] }, WRITE, outbound)
    expect(isErr(rewrite)).toBe(true)
    const enable = await call('plexii_update_flow', { id: 'fl1', enabled: true }, WRITE, outbound)
    expect(isErr(enable)).toBe(true)
    expect(textOf(enable)).toContain('on a schedule')
    expect(outbound.updateFlow).not.toHaveBeenCalled()
    // An internal flow edits normally.
    const clean = deps()
    expect(isErr(await call('plexii_update_flow', { id: 'fl1', enabled: true }, WRITE, clean))).toBe(false)
  })

  it('meetings, decisions and forms can be recorded; reports generate without mailing', async () => {
    const d = deps()
    await call('plexii_create_meeting', { title: 'Weekly sync', summary: 'Contract discussed.', actionItems: ['Countersign'] }, WRITE, d)
    expect(d.createMeeting).toHaveBeenCalledWith(expect.objectContaining({ title: 'Weekly sync', actionItems: ['Countersign'] }))

    await call('plexii_create_decision', { title: 'Ship Monday', rationale: 'Ads are booked.' }, WRITE, d)
    expect(d.createDecision).toHaveBeenCalledWith(expect.objectContaining({ title: 'Ship Monday', status: 'proposed' }))

    await call('plexii_create_form', { title: 'Enquiry', tableId: 't1' }, WRITE, d)
    expect(d.createForm).toHaveBeenCalledWith({ title: 'Enquiry', tableId: 't1' })
    expect(isErr(await call('plexii_create_form', { title: 'X', tableId: 'nope' }, WRITE, d))).toBe(true)

    // A report generates, and the tool exposes no recipients/schedule at all —
    // those are how a report gets MAILED, which this surface must not arrange.
    const rep = await call('plexii_create_report', { title: 'Weekly', tableIds: ['t1'] }, WRITE, d)
    expect(textOf(rep)).toContain('3 rows across 1 table.')
    const schema = WORKSPACE_TOOLS.find((t) => t.name === 'plexii_create_report')!.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).not.toContain('recipients')
    expect(Object.keys(schema.properties)).not.toContain('schedule')
  })

  it('the new read tools list what exists and are honest when nothing does', async () => {
    const d = deps()
    expect(textOf(await call('plexii_list_reports', {}, READ, d))).toContain('rp1 · Weekly')
    expect(textOf(await call('plexii_list_decisions', {}, READ, d))).toContain('[accepted] Ship on Monday')
    expect(textOf(await call('plexii_list_forms', {}, READ, d))).toContain('fm1 · Enquiry → table t1')
    expect(textOf(await call('plexii_list_projects', {}, READ, d))).toContain('4 tasks')
    const empty = deps({ listReports: () => [], listDecisions: () => [], listForms: () => [], listProjectSummaries: () => [] })
    expect(textOf(await call('plexii_list_reports', {}, READ, empty))).toContain('No reports yet')
    expect(textOf(await call('plexii_list_decisions', {}, READ, empty))).toContain('No decisions')
  })

  // Attribution used to depend on each tool remembering to mark its own work,
  // so only work items were ever marked. It is central now: a new write tool
  // cannot be added WITHOUT being attributed.
  describe('every write is recorded as an agent action', () => {
    it('records a create, with the object id it returned', async () => {
      const d = deps()
      await call('plexii_create_desk', { title: 'Q4 planning' }, WRITE, d)
      expect(d.recordAgentWrite).toHaveBeenCalledWith(
        expect.objectContaining({ tool: 'plexii_create_desk', objectId: 'd-new' })
      )
    })

    it('records an edit too, not just a create', async () => {
      const d = deps()
      await call('plexii_update_desk', { deskId: 'd1', title: 'Renamed' }, WRITE, d)
      expect(d.recordAgentWrite).toHaveBeenCalledWith(expect.objectContaining({ tool: 'plexii_update_desk' }))
    })

    it('records NOTHING for a read', async () => {
      const d = deps()
      await call('plexii_list_desks', {}, READ, d)
      await call('plexii_read_desk', { deskId: 'd1' }, READ, d)
      expect(d.recordAgentWrite).not.toHaveBeenCalled()
    })

    // A refused write changed nothing. Logging it would make the record lie in
    // the other direction — "the AI did this" about something that never happened.
    it('records NOTHING when a write is refused', async () => {
      const d = deps()
      await call('plexii_create_desk', {}, WRITE, d)
      await call('plexii_update_desk', { deskId: 'nope', title: 'x' }, WRITE, d)
      const outbound = deps({ getFlow: () => ({ ...FLOW, actions: [{ id: 'a', type: 'http-request' }] }) as never })
      await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, outbound)
      expect(d.recordAgentWrite).not.toHaveBeenCalled()
      expect(outbound.recordAgentWrite).not.toHaveBeenCalled()
    })

    it('records nothing when a read token is refused a write tool', async () => {
      const d = deps()
      await call('plexii_create_desk', { title: 'x' }, READ, d)
      expect(d.recordAgentWrite).not.toHaveBeenCalled()
    })

    // The guarantee, stated structurally: if a write tool exists, calling it
    // successfully attributes it. Nothing here relies on the tool's own code.
    it('holds for EVERY write tool, so a new one cannot ship unattributed', () => {
      const writes = WORKSPACE_TOOLS.filter((t) => t.scope === 'write')
      expect(writes.length).toBeGreaterThan(10)
      // The hook is on the spec, not in the tools — so it covers all of them.
      expect(typeof workspaceServerSpec('1').onWrite).toBe('function')
    })

    // emitObjectEvent swallows an invalid event name as a non-fatal warning,
    // so a bad name here does not throw — it silently records nothing, and the
    // attribution looks wired while doing absolutely no work. Caught once for
    // real ("AgentWrote" is not past tense by PLX-EVT-041); pinned so the next
    // rename is caught here instead of in production.
    it('uses an event name the store will actually accept', () => {
      expect(isValidEventTypeName(MCP_WRITE_EVENT)).toBe(true)
      expect(() => assertEventTypeName(MCP_WRITE_EVENT)).not.toThrow()
      expect(isValidEventTypeName('AgentWrote')).toBe(false)
    })
  })

  // The correctness bug: answering "when are you free" from Plexii's own blocks
  // while the person's real calendar was full.
  it('plexii_calendar merges linked calendars and labels where each entry came from', async () => {
    const out = textOf(await call('plexii_calendar', { from: '2026-09-15T00:00:00Z', to: '2026-09-17T00:00:00Z' }, READ))
    expect(out).toContain('Deep work')
    expect(out).toContain('Plexii')
    expect(out).toContain('Board meeting')
    expect(out).toContain('Work (Google)')
    expect(out).toContain('read-only')
    // Merged in time order, not one store then the other.
    expect(out.indexOf('Standup')).toBeLessThan(out.indexOf('Board meeting'))
  })

  it('says so when nothing is linked, rather than implying the view is complete', async () => {
    const d = deps({ listExternalCalendars: () => [], listExternalEvents: () => [] })
    const out = textOf(await call('plexii_calendar', { from: '2030-01-01T00:00:00Z', to: '2030-01-02T00:00:00Z' }, READ, d))
    expect(out).toContain('No linked calendars')
  })

  it('booking says when it has just double-booked, and books anyway', async () => {
    const d = deps()
    const r = await call('plexii_create_time_block', { title: 'Focus', start: '2026-09-16T03:00:00Z', durationMin: 60 }, WRITE, d)
    expect(isErr(r)).toBe(false)
    expect(d.createTimeBlock).toHaveBeenCalled()
    expect(textOf(r)).toContain('Board meeting')
    expect(textOf(r)).toContain('overlaps')
  })

  describe('wires — what makes a desk more than a pile of tiles', () => {
    it('wires two widgets, and creates a reactive wire switched OFF', async () => {
      const d = deps()
      const r = await call('plexii_create_wire', {
        sourceWidgetId: 'wg1', targetWidgetId: 'wg2', type: 'transform', verb: 'extract the action items'
      }, WRITE, d)
      expect(isErr(r)).toBe(false)
      expect(d.createLink).toHaveBeenCalledWith('wg1', 'wg2', 'd1', 'transform')
      // Live from birth, a transform wire rewrites a widget before anyone looked.
      expect(d.updateLink).toHaveBeenCalledWith('lk-new', { verb: 'extract the action items', enabled: false })
      expect(textOf(r)).toContain('switched off')
    })

    it('refuses the wires that cannot mean anything', async () => {
      const d = deps()
      expect(isErr(await call('plexii_create_wire', { sourceWidgetId: 'wg1', targetWidgetId: 'wg1' }, WRITE, d))).toBe(true)
      // Across two desks a wire has no canvas to be drawn on.
      const cross = await call('plexii_create_wire', { sourceWidgetId: 'wg1', targetWidgetId: 'wgOther' }, WRITE, d)
      expect(isErr(cross)).toBe(true)
      expect(textOf(cross)).toContain('same desk')
      // A transform with nothing to do is a wire that fires and does nothing.
      const noVerb = await call('plexii_create_wire', { sourceWidgetId: 'wg1', targetWidgetId: 'wg2', type: 'transform' }, WRITE, d)
      expect(isErr(noVerb)).toBe(true)
      expect(textOf(noVerb)).toContain('verb')
      expect(isErr(await call('plexii_create_wire', { sourceWidgetId: 'nope', targetWidgetId: 'wg2' }, WRITE, d))).toBe(true)
      expect(d.createLink).not.toHaveBeenCalled()
    })

    it('will not switch on a transform wire that has no instruction', async () => {
      const d = deps({ listLinksByTask: () => [{ id: 'lk1', sourceWidgetId: 'wg1', targetWidgetId: 'wg2', taskId: 'd1', type: 'transform', verb: '', enabled: false, createdAt: 1 }] as never })
      const r = await call('plexii_update_wire', { deskId: 'd1', id: 'lk1', enabled: true }, WRITE, d)
      expect(isErr(r)).toBe(true)
      expect(textOf(r)).toContain('verb')
    })

    it('lists what is wired, and is honest when nothing is', async () => {
      expect(textOf(await call('plexii_list_wires', { deskId: 'd1' }, READ))).toContain('Nothing on this desk is wired')
      const wired = deps({ listLinksByTask: () => [{ id: 'lk1', sourceWidgetId: 'wg1', targetWidgetId: 'wg2', taskId: 'd1', type: 'transform', verb: 'summarise', enabled: true, createdAt: 1 }] as never })
      const out = textOf(await call('plexii_list_wires', { deskId: 'd1' }, READ, wired))
      expect(out).toContain('→')
      expect(out).toContain('"summarise"')
      expect(out).toContain('live')
    })
  })

  it('a desk agent can be created and placed, with its instruction stored as the widget expects', async () => {
    const d = deps()
    await call('plexii_create_widget', { deskId: 'd1', kind: 'agent', title: 'Summariser', content: 'Summarise new rows daily.', x: 400, y: 200 }, WRITE, d)
    const draft = (d.createWidget as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]
    expect(draft.kind).toBe('agent')
    // Raw prose here would render as a broken widget.
    expect(JSON.parse(draft.content)).toEqual({ instruction: 'Summarise new rows daily.' })
    expect(draft).toMatchObject({ x: 400, y: 200 })
  })

  it('widgets can be moved and resized, and refuse a uselessly small size', async () => {
    const d = deps()
    await call('plexii_update_widget', { id: 'wg1', x: 100, y: 250, width: 320 }, WRITE, d)
    expect(d.updateWidget).toHaveBeenCalledWith('wg1', { x: 100, y: 250, width: 320 })
    expect(isErr(await call('plexii_update_widget', { id: 'wg1', width: 10 }, WRITE, d))).toBe(true)
    expect(isErr(await call('plexii_update_widget', { id: 'wg1', x: 'left' }, WRITE, d))).toBe(true)
  })

  it('work items can be snoozed and reclassified through their own store paths', async () => {
    const d = deps()
    await call('plexii_snooze_work_item', { id: 'w1', until: '2026-09-20T09:00:00Z' }, WRITE, d)
    expect(d.snoozeWorkItem).toHaveBeenCalledWith('w1', Date.parse('2026-09-20T09:00:00Z'))
    await call('plexii_snooze_work_item', { id: 'w1' }, WRITE, d)
    expect(d.snoozeWorkItem).toHaveBeenLastCalledWith('w1', null)
    // An intent change goes through reclassifyWorkItem, not a raw field write.
    await call('plexii_update_work_item', { id: 'w1', intent: 'to_review' }, WRITE, d)
    expect(d.reclassifyWorkItem).toHaveBeenCalledWith('w1', 'to_review')
    expect(isErr(await call('plexii_snooze_work_item', { id: 'w1', until: 'soon' }, WRITE, d))).toBe(true)
  })

  it('a desk can be saved as a template', async () => {
    const d = deps()
    expect(textOf(await call('plexii_list_templates', {}, READ, d))).toContain('tp1 · Client desk')
    await call('plexii_create_template', { deskId: 'd1', name: 'Client desk' }, WRITE, d)
    expect(d.createTemplateFromTask).toHaveBeenCalledWith('d1', 'Client desk', undefined)
  })

  it('plexii_run_flow reports every step; a failed run is isError; it is marked open-world', async () => {
    const d = deps()
    const ok = await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, d)
    expect(textOf(ok)).toContain('Flow "Nightly digest" succeeded.\n✓ notify: sent')
    expect(isErr(ok)).toBe(false)
    const bad = deps({ runFlow: async () => ({ ok: false, steps: [{ actionId: 'a', type: 'webhook', ok: false, message: 'timeout' }] }) as never })
    const r = await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, bad)
    expect(isErr(r)).toBe(true)
    expect(textOf(r)).toContain('✗ webhook: timeout')
    expect(isErr(await call('plexii_run_flow', { flowId: 'nope' }, WRITE, d))).toBe(true)
  })

  // The surface promises it never sends and never calls out. Every tool honours
  // that by construction except this one, which executes a flow it did not
  // write — so the promise lives or dies on this refusal.
  it('refuses a flow that would leave the machine, naming the action that blocked it', async () => {
    for (const type of [...OUTBOUND_FLOW_ACTIONS]) {
      const d = deps({ getFlow: () => ({ ...FLOW, actions: [{ id: 'a', type }] }) as never })
      const r = await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, d)
      expect(isErr(r), type).toBe(true)
      expect(textOf(r)).toContain(type)
      expect(textOf(r)).toContain('leave this machine')
      // Refused BEFORE running: the flow never executes.
      expect(d.runFlow, type).not.toHaveBeenCalled()
    }
  })

  it('refuses a mixed flow, and still runs a wholly internal one', async () => {
    const mixed = deps({
      getFlow: () => ({ ...FLOW, actions: [
        { id: 'a', type: 'create-task', title: 'x' },
        { id: 'b', type: 'http-request', url: 'https://evil.test', method: 'POST', headers: '', body: '' }
      ] }) as never
    })
    expect(isErr(await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, mixed))).toBe(true)
    expect(mixed.runFlow).not.toHaveBeenCalled()

    const internal = deps({
      getFlow: () => ({ ...FLOW, actions: [
        { id: 'a', type: 'create-task', title: 'x' },
        { id: 'b', type: 'create-knowledge', title: 'k', body: 'b' },
        { id: 'c', type: 'add-table-row', tableId: 't1' },
        { id: 'd', type: 'ai-step', prompt: 'p' }
      ] }) as never
    })
    expect(isErr(await call('plexii_run_flow', { flowId: 'fl1' }, WRITE, internal))).toBe(false)
    expect(internal.runFlow).toHaveBeenCalled()
  })

  // outboundActionsOf is the gate's whole judgement — pin it directly, and pin
  // it against the real FlowAction union so a NEW outbound action type added to
  // flows.ts cannot quietly become runnable from MCP.
  it('classifies every flow action type, and the set matches what flows.ts can do', () => {
    expect(outboundActionsOf({ ...FLOW, actions: [] } as never)).toEqual([])
    expect(outboundActionsOf({ ...FLOW, actions: [
      { id: '1', type: 'http-request' }, { id: '2', type: 'http-request' }, { id: '3', type: 'send-email' }
    ] } as never)).toEqual(['http-request', 'send-email'])

    const flows = readFileSync(join(ROOT, 'src/shared/flows.ts'), 'utf-8')
    const declared = [...flows.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1])
    const known = new Set(['create-task', 'add-table-row', 'send-email', 'create-knowledge', 'ai-step', 'http-request'])
    for (const t of declared) {
      expect(known, `flows.ts declares "${t}" — decide whether it is outbound and update OUTBOUND_FLOW_ACTIONS`).toContain(t)
    }
  })
})

// ── Caps and coercion ───────────────────────────────────────────────────────

describe('caps and argument coercion', () => {
  it('the dispatcher caps every text at RESULT_CHAR_CAP with a note', async () => {
    const huge = 'x'.repeat(RESULT_CHAR_CAP + 500)
    const spec = workspaceServerSpec('1')
    const d = deps({ getWorkItem: () => ({ ...WI_OPEN, description: huge }) })
    const r = (await dispatchMcpMessage(rpc('tools/call', { name: 'plexii_get_work_item', arguments: { id: 'w1' } }), spec, d, READ)) as Reply
    const t = textOf(r)
    expect(t.length).toBeLessThan(RESULT_CHAR_CAP + 100)
    expect(t.endsWith('[… truncated — the rest lives in Plexii]')).toBe(true)
  })

  it('capText/num/str/bool behave', () => {
    expect(capText('abc', 2, '!')).toBe('ab\n!')
    expect(capText('abc', 3)).toBe('abc')
    expect(num('7', 1, 1, 5)).toBe(5)
    expect(num(undefined, 3, 1, 5)).toBe(3)
    expect(num(2.9, 1, 1, 5)).toBe(2)
    expect(num('nope', 4, 1, 5)).toBe(4)
    expect(str(null)).toBe('')
    expect(str('  a ')).toBe('a')
    expect(bool('true', false)).toBe(true)
    expect(bool(undefined, true)).toBe(true)
  })

  it('the tool descriptions teach the real vocabularies, so a model never guesses', () => {
    const list = WORKSPACE_TOOLS.find((t) => t.name === 'plexii_list_work_items')!.description
    for (const s of WORK_ITEM_STATES) expect(list).toContain(s)
    for (const c of INTENT_CLASSES) expect(list).toContain(c)
  })
})

// ── Resources ────────────────────────────────────────────────────────────────

describe('resources — what a person can attach, rather than ask for', () => {
  const rpcCall = async (method: string, params?: Record<string, unknown>, caller = READ, d = deps()): Promise<Reply> =>
    (await handleWorkspaceMcpBody({ jsonrpc: '2.0', id: 1, method, params }, d, caller)) as Reply

  it('declares the capability only because it can answer it', async () => {
    const init = (await rpcCall('initialize', { protocolVersion: '2025-06-18' })) as Reply
    expect(init.result?.capabilities).toEqual({ tools: {}, resources: {} })
    // Neither subscribe nor listChanged — claiming either would leave clients
    // waiting for notifications that never come.
    const caps = init.result!.capabilities as { resources: Record<string, unknown> }
    expect(caps.resources.subscribe).toBeUndefined()
    expect(caps.resources.listChanged).toBeUndefined()
  })

  it('lists desks, documents and tables with plexii:// uris', async () => {
    const r = await rpcCall('resources/list')
    const list = r.result!.resources as Array<{ uri: string; name: string; mimeType: string }>
    expect(list.some((x) => x.uri === 'plexii://desk/d1')).toBe(true)
    expect(list.some((x) => x.uri === 'plexii://document/doc1')).toBe(true)
    expect(list.some((x) => x.uri === 'plexii://table/t1')).toBe(true)
    // A closed desk is not something you attach.
    expect(list.some((x) => x.uri === 'plexii://desk/d2')).toBe(false)
    expect(list.every((x) => x.name && x.mimeType)).toBe(true)
  })

  it('pages with an opaque cursor, and survives a malformed one', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...DESK, id: `d${i}`, title: `Desk ${i}` }))
    const d = deps({ listNodes: () => many, listDocuments: () => [], listTables: () => [] })
    const p1 = await rpcCall('resources/list', {}, READ, d)
    expect((p1.result!.resources as unknown[]).length).toBe(100)
    expect(p1.result!.nextCursor).toBe('100')
    const p2 = await rpcCall('resources/list', { cursor: p1.result!.nextCursor }, READ, d)
    expect((p2.result!.resources as Array<{ name: string }>)[0].name).toBe('Desk 100')
    const last = await rpcCall('resources/list', { cursor: '200' }, READ, d)
    expect(last.result!.nextCursor).toBeUndefined()
    // A client echoing back nonsense gets the first page, not a crash.
    const junk = await rpcCall('resources/list', { cursor: 'not-a-number' }, READ, d)
    expect((junk.result!.resources as Array<{ name: string }>)[0].name).toBe('Desk 0')
  })

  it('reads a desk, a document and a table through the same extractors the tools use', async () => {
    const desk = await rpcCall('resources/read', { uri: 'plexii://desk/d1' })
    const deskText = (desk.result!.contents as Array<{ text: string; uri: string }>)[0]
    expect(deskText.uri).toBe('plexii://desk/d1')
    expect(deskText.text).toContain('Kickoff notes')
    expect(deskText.text).toContain('Chase the March invoice')

    const doc = await rpcCall('resources/read', { uri: 'plexii://document/doc1' })
    expect((doc.result!.contents as Array<{ text: string }>)[0].text).toContain('Ship on Monday.')

    const table = await rpcCall('resources/read', { uri: 'plexii://table/t1' })
    const t = (table.result!.contents as Array<{ text: string; mimeType: string }>)[0]
    expect(t.mimeType).toBe('text/tab-separated-values')
    expect(t.text).toContain('row_id\tName\tStage')
    expect(t.text).toContain('Acme')
  })

  // A uri is caller input. The spec requires validating it.
  it('answers -32002 for a uri that names nothing, and refuses a foreign one', async () => {
    const gone = await rpcCall('resources/read', { uri: 'plexii://desk/nope' })
    expect(gone.error?.code).toBe(-32002)
    for (const uri of ['file:///etc/passwd', 'plexii://vault/secrets', 'plexii://desk/../../etc', 'https://evil.test']) {
      const r = await rpcCall('resources/read', { uri })
      expect(r.error?.code, uri).toBe(-32002)
    }
    expect((await rpcCall('resources/read', {})).error?.code).toBe(-32602)
  })

  it('a token with no read scope gets no resources', async () => {
    const none = { scopes: [] as Array<'read' | 'write'> }
    expect((await rpcCall('resources/list', {}, none)).error?.code).toBe(-32602)
    expect((await rpcCall('resources/read', { uri: 'plexii://desk/d1' }, none)).error?.code).toBe(-32602)
  })
})

// ── Source pins ─────────────────────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('MCP workspace wiring pins', () => {
  const server = read('src/main/apiServer.ts')
  const mcp = read('src/main/mcpServer.ts')
  const bridge = read('tools/plexii-mcp-bridge/server/index.js')
  const manifest = JSON.parse(read('tools/plexii-mcp-bridge/manifest.json')) as Record<string, unknown>

  it('the /mcp route hands the token scopes to the workspace dispatcher, behind auth', () => {
    const authIdx = server.indexOf('const scopes = authScopes(req)')
    const mcpIdx = server.indexOf("if (path === '/mcp')")
    expect(authIdx).toBeGreaterThan(-1)
    expect(mcpIdx).toBeGreaterThan(authIdx)
    expect(server).toContain('handleWorkspaceMcpBody(b.value, await liveWorkspaceDeps(app.getVersion()), { scopes })')
    expect(server).not.toContain("from './mcpRecall'")
  })

  it('live writes are attributed to an mcp agent actor', () => {
    expect(mcp).toContain("workItems.createWorkItem(draft, { kind: 'agent', agentRef: 'mcp' })")
    expect(mcp).toContain("workItems.setWorkItemState(id, state, { kind: 'agent', agentRef: 'mcp' })")
  })

  it('the stdio bridge is dependency-free, loopback-only, and never logs the token', () => {
    expect(bridge).not.toMatch(/require\(['"](?!node:|http|readline|process)/)
    expect(bridge).toContain("'127.0.0.1'")
    expect(bridge).toContain("'localhost'")
    expect(bridge).not.toMatch(/console\.(log|error)\([^)]*token/i)
    expect(bridge).toContain("Authorization: `Bearer ${TOKEN}`")
  })

  it('the MCPB manifest declares the two user settings and marks the token sensitive', () => {
    const cfg = manifest.user_config as Record<string, { sensitive?: boolean; required?: boolean }>
    expect(Object.keys(cfg)).toEqual(['api_url', 'api_token'])
    expect(cfg.api_token.sensitive).toBe(true)
    expect(cfg.api_token.required).toBe(true)
    expect(manifest.server).toEqual(expect.objectContaining({ type: 'node', entry_point: 'server/index.js' }))
    const tools = (manifest.tools as Array<{ name: string }>).map((t) => t.name)
    for (const t of WORKSPACE_TOOLS) expect(tools, t.name).toContain(t.name)
    expect(tools.length).toBe(WORKSPACE_TOOLS.length)
  })
})
