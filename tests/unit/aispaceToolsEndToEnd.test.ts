// @vitest-environment node
// The tool path end to end, through Plexii's own glue (mcpHost + tool gateway
// + policy + stores), against the reference MCP server and the fake Notion.
// SPEC-CONNECTIONS §8 acceptance: "Remote MCP consent", "Agent permissions"
// (an ungranted or unreviewed operation never runs), "Daily use" (call a tool
// and inspect a direct API action, with account, scope and activity recorded).

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memSqlDb } from './_memdb'
import { createAiSpaceService } from '../../src/main/aispace/service'
import { createVault } from '../../src/main/aispace/vault'
import { createMcpHost } from '../../src/main/aispace/mcpHost'
import { createToolGateway, appOpId } from '../../src/main/aispace/tools'
import { createNotionAdapter } from '../../src/main/aispace/appapi'
import { startReferenceServer, type RefServer } from './helpers/aispaceMcpReferenceServer'
import { FakeNotion, FAKE_NOTION_TOKEN, FAKE_WORKSPACE_ID, fakeId } from './helpers/aispaceFakeNotion'

const crypto = { available: () => true, encrypt: (s: string) => Buffer.from(s.split('').reverse().join('')), decrypt: (b: Buffer) => b.toString().split('').reverse().join('') }

function world() {
  const vault = createVault(join(mkdtempSync(join(tmpdir(), 'aist-')), 'v.json'), crypto)
  const svc = createAiSpaceService({ db: memSqlDb(), vault, grant: (fn) => fn() })
  const ws = svc.getContext().workspaces[0]
  const project = svc.createProject({ title: 'Launch', workspaceId: ws.id })
  return { vault, svc, ws, project }
}

// Plays the browser: follows the authorize URL, which the reference server
// answers with a redirect back to Plexii's loopback receiver.
function browser() {
  const opened: string[] = []
  return {
    opened,
    open: async (url: string) => {
      opened.push(url)
      void fetch(url).catch(() => {})
    }
  }
}

let srv: RefServer | null = null
let notion: FakeNotion | null = null
afterEach(async () => {
  await srv?.close()
  srv = null
  await notion?.close?.()
  notion = null
  delete process.env.AISPACE_ALLOW_LOOPBACK
})

describe('remote MCP through Connections (acceptance: Remote MCP consent)', () => {
  it('shows the verified origin first, signs in, keeps tools unreviewed until a person classifies them, runs a granted read, and asks for consent before a wider scope', async () => {
    srv = await startReferenceServer()
    const { svc, vault, ws, project } = world()
    const b = browser()
    const mcp = createMcpHost({ store: svc.store, conns: svc.conns, vault, openExternal: b.open, card: (id) => svc.connectionCard(svc.conns.getConnection(id)!) })
    const tools = createToolGateway({ store: svc.store, conns: svc.conns, broker: svc.broker, mcp: () => mcp.caller })

    const info = await mcp.inspect(srv.mcpUrl)
    expect(info).toMatchObject({ ok: true, onThisMac: true, needsAuth: true })
    expect(info.origin).toBe(new URL(srv.mcpUrl).origin)
    expect(srv.stats.register).toBe(0) // nothing registered just by looking

    const added = await mcp.add({ workspaceId: ws.id, alias: 'Team notes', endpoint: srv.mcpUrl })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.next).toBe('authorize')
    expect(added.connection.onThisMac).toBe(true)
    const cid = added.connection.id

    const auth = await mcp.authorize(cid, null)
    expect(auth.outcome).toBe('authorized')
    expect(b.opened).toHaveLength(1)
    // The token is in the vault, never in the record.
    expect(JSON.stringify(svc.connectionDetail(cid))).not.toMatch(/access_?token|refresh_?token/i)

    const ops = svc.conns.listOperations(cid)
    const search = ops.find((o) => o.id.endsWith(':search_notes'))!
    const create = ops.find((o) => o.id.endsWith(':create_note'))!
    expect(search.classification).toBe('unknown')
    expect(search.reviewState).toBe('needs_review')
    expect(search.suggestedClass).toBe('read')

    // Granted but not yet reviewed: refused.
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: search.id, mode: 'read' }] })
    const early = await tools.call({ projectId: project.id, connectionId: cid, operationId: search.id, input: { query: 'pricing' }, principal: 'user:me' })
    expect(early.status).toBe('blocked')
    expect(early.detail).toMatch(/changed since it was approved|Review it first|classified/)

    // A person classifies it as a read; now the granted read runs.
    svc.conns.reviewOperation(search.id, 'read')
    const ok = await tools.call({ projectId: project.id, connectionId: cid, operationId: search.id, input: { query: 'pricing' }, principal: 'user:me' })
    expect(ok.status).toBe('ok')
    const src = svc.store.getSource(ok.sourceId!)!
    expect(src.kind).toBe('tool_result')
    expect(src.connectionId).toBe(cid)
    expect(svc.conns.getInvocation(ok.invocationId!)!.status).toBe('ok')

    // The write tool isn't on the grant: refused whatever asked for it.
    const notGranted = await tools.call({ projectId: project.id, connectionId: cid, operationId: create.id, input: { title: 'x' }, principal: 'agent:Writer' })
    expect(notGranted.status).toBe('blocked')
    expect(notGranted.detail).toMatch(/isn’t allowed to run/)

    // Granted as a write and reviewed: it waits for approval, showing what it touches.
    svc.conns.reviewOperation(create.id, 'write')
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: search.id, mode: 'read' }, { operationId: create.id, mode: 'write' }] })
    const held = await tools.call({ projectId: project.id, connectionId: cid, operationId: create.id, input: { title: 'Launch notes' }, principal: 'user:me' })
    expect(held.status).toBe('awaiting_approval')
    expect(held.approval).toMatchObject({ account: 'Team notes' })
    expect(held.approval!.touches).toContain('Launch notes')

    // Approved, but the server needs a wider scope: Plexii asks for consent
    // instead of quietly signing in again.
    const authBefore = srv.stats.authorize
    const wider = await tools.approve(held.invocationId!, { title: 'Launch notes' })
    expect(wider.status).toBe('error')
    expect(wider.detail).toMatch(/needs more access than you approved/)
    expect(srv.stats.authorize).toBe(authBefore)
    expect(b.opened).toHaveLength(1)

    // The run log shows every step, attributed.
    const log = svc.connectionDetail(cid).invocations.map((i) => `${i.operationId.split(':').pop()}:${i.status}`)
    expect(log).toEqual(expect.arrayContaining(['search_notes:blocked', 'search_notes:ok', 'create_note:blocked', 'create_note:error']))
  })
})

describe('Notion through Connections (acceptance: Daily use, Agent permissions)', () => {
  it('checks the token read-only, runs a granted read, refuses an ungranted write, and holds a granted write for approval', async () => {
    notion = new FakeNotion()
    await notion.start()
    process.env.AISPACE_ALLOW_LOOPBACK = '1'
    const parent = notion.addPage({ id: fakeId(), title: 'Drafts', blocks: [] })
    notion.addPage({ id: fakeId(), title: 'Client brief', blocks: [{ id: fakeId(), type: 'paragraph', text: 'Offer a 30-day trial.' }] })
    const { svc, ws, project } = world()
    const adapter = createNotionAdapter({ origin: notion.origin })
    const tools = createToolGateway({ store: svc.store, conns: svc.conns, broker: svc.broker, appOptions: () => ({ adapterOverride: adapter }) })

    const added = await tools.addAppApi({ providerId: 'notion', workspaceId: ws.id, alias: 'SaaSMouth Notion', token: FAKE_NOTION_TOKEN })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const cid = added.connection.id
    expect(added.connection.identity).toBe(FAKE_WORKSPACE_ID)
    const searchId = appOpId(cid, 'notion.search')
    const draftId = appOpId(cid, 'notion.create_draft_page')
    expect(svc.conns.getOperation(searchId)!.reviewState).toBe('approved')

    // Reads only, like the connect flow's default grant.
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: searchId, mode: 'read' }, { operationId: appOpId(cid, 'notion.read_page'), mode: 'read' }] })
    const found = await tools.call({ projectId: project.id, connectionId: cid, operationId: searchId, input: { query: 'brief' }, principal: 'agent:Research' })
    expect(found.status).toBe('ok')
    expect(svc.store.getSource(found.sourceId!)!.content).toContain('Client brief')

    // A model asking for the write it wasn't granted is refused.
    const refused = await tools.call({ projectId: project.id, connectionId: cid, operationId: draftId, input: { parentPageId: parent.id, title: 'Hero draft' }, principal: 'agent:Writer' })
    expect(refused.status).toBe('blocked')
    expect(notion.pages.size).toBe(2)

    // Granted as a write: held for approval, then created once approved.
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: searchId, mode: 'read' }, { operationId: draftId, mode: 'write' }] })
    const held = await tools.call({ projectId: project.id, connectionId: cid, operationId: draftId, input: { parentPageId: parent.id, title: 'Hero draft', text: 'Start your 30-day trial.' }, principal: 'user:me' })
    expect(held.status).toBe('awaiting_approval')
    expect(notion.pages.size).toBe(2)
    // Approving a CHANGED request is refused: it must be shown again.
    await expect(tools.approve(held.invocationId!, { parentPageId: parent.id, title: 'Something else' })).rejects.toThrow(/changed since it was shown/)
    const made = await tools.approve(held.invocationId!, { parentPageId: parent.id, title: 'Hero draft', text: 'Start your 30-day trial.' })
    expect(made.status).toBe('ok')
    expect(notion.pages.size).toBe(3)
    expect(svc.conns.getConnection(cid)!.capabilities.find((c) => c.capability === 'app_write')!.state).toBe('passed')

    const detail = svc.connectionDetail(cid)
    expect(detail.connection.payer).toBe('Unknown payer')
    expect(detail.activity.some((e) => /can use SaaSMouth Notion/.test(e.summary))).toBe(true)
  })

  it('treats a write with an unknown outcome as uncertain and never repeats it until a person says what happened', async () => {
    notion = new FakeNotion()
    await notion.start()
    process.env.AISPACE_ALLOW_LOOPBACK = '1'
    const parent = notion.addPage({ id: fakeId(), title: 'Drafts', blocks: [] })
    const { svc, ws, project } = world()
    const adapter = createNotionAdapter({ origin: notion.origin, timeoutMs: 300 })
    const tools = createToolGateway({ store: svc.store, conns: svc.conns, broker: svc.broker, appOptions: () => ({ adapterOverride: adapter }) })
    const added = await tools.addAppApi({ providerId: 'notion', workspaceId: ws.id, alias: 'Notion', token: FAKE_NOTION_TOKEN })
    if (!added.ok) throw new Error(added.detail)
    const cid = added.connection.id
    const draftId = appOpId(cid, 'notion.create_draft_page')
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: draftId, mode: 'write' }], approval: 'auto' })
    const input = { parentPageId: parent.id, title: 'Ad draft' }
    notion.hang = true
    const first = await tools.call({ projectId: project.id, connectionId: cid, operationId: draftId, input, principal: 'user:me' })
    expect(first.status).toBe('uncertain')
    notion.hang = false
    const retry = await tools.call({ projectId: project.id, connectionId: cid, operationId: draftId, input, principal: 'user:me' })
    expect(retry.status).toBe('blocked')
    expect(retry.detail).toMatch(/may already have gone through/)
    tools.reconcile(first.invocationId!, 'not_done')
    const after = await tools.call({ projectId: project.id, connectionId: cid, operationId: draftId, input, principal: 'user:me' })
    expect(after.status).toBe('ok')
  })
})

describe('replacing an app token (rotate / reconnect)', () => {
  it('verifies first, keeps the old token on failure, switches only within the same workspace', async () => {
    notion = new FakeNotion()
    await notion.start()
    process.env.AISPACE_ALLOW_LOOPBACK = '1'
    const { svc, ws, project } = world()
    const adapter = createNotionAdapter({ origin: notion.origin })
    const tools = createToolGateway({ store: svc.store, conns: svc.conns, broker: svc.broker, appOptions: () => ({ adapterOverride: adapter }) })
    const added = await tools.addAppApi({ providerId: 'notion', workspaceId: ws.id, alias: 'Notion', token: FAKE_NOTION_TOKEN })
    if (!added.ok) throw new Error(added.detail)
    const cid = added.connection.id
    svc.setGrant({ connectionId: cid, projectId: project.id, actions: [{ operationId: appOpId(cid, 'notion.search'), mode: 'read' }] })

    // A wrong token: refused, nothing switched.
    const bad = await tools.replaceToken(cid, 'ntn_wrongWrongWrongWrongWrongWrong0000', 'rotate')
    expect(bad.ok).toBe(false)
    expect((await tools.call({ projectId: project.id, connectionId: cid, operationId: appOpId(cid, 'notion.search'), input: { query: 'x' }, principal: 'user:me' })).status).toBe('ok')

    // A new token for the same workspace: switched.
    const NEW = 'ntn_' + 'N3wT0kenAbcdefghijklmnopqrstuvwxyz9876543210'
    notion.token = NEW
    const good = await tools.replaceToken(cid, NEW, 'rotate')
    expect(good.ok).toBe(true)
    expect(svc.conns.getConnection(cid)!.secretHint).toBe('…3210')
    expect((await tools.call({ projectId: project.id, connectionId: cid, operationId: appOpId(cid, 'notion.search'), input: { query: 'x' }, principal: 'user:me' })).status).toBe('ok')

    // A token for another workspace: refused, it would be a separate connection.
    const OTHER = 'ntn_' + 'Oth3rT0kenAbcdefghijklmnopqrstuvwxyz1234567'
    notion.token = OTHER
    notion.workspaceId = '9a9a9a9a-0000-4000-8000-000000000001'
    const other = await tools.replaceToken(cid, OTHER, 'reconnect')
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.detail).toMatch(/different workspace/)
    expect(svc.conns.getConnection(cid)!.secretHint).toBe('…3210')
  })
})
