import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

// A widget an agent puts on the desk you are looking at appears, live (4.3.41).
//
// The MCP server writes straight to the database, so the open desk's widget
// store never heard about it: the widget stayed invisible until the desk was
// reopened. The MCP adapter now emits widgets:externalChange for the desks it
// touched, and the open desk reloads in place.
//
// Over the wire, as mcpLive.spec does: the real /mcp route, a real write token,
// JSON-RPC from the renderer to 127.0.0.1. The desk stays open throughout; there
// is no reload and no navigation between the agent's call and the assertion.

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

async function mcp(window: Page, port: number, token: string, method: string, params?: Record<string, unknown>): Promise<Rpc> {
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

/** A port the OS says is free (see mcpLive.spec: never the default 8787, which may be a developer's own Plexii). */
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as { port: number }
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

async function setup(window: Page): Promise<{ port: number; token: string; deskId: string; anchorId: string }> {
  const wanted = await freePort()
  const out = await window.evaluate(async (wanted) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Agent desk' })
    const anchor = await api.widgets.create({ taskId: desk.id, kind: 'sticky', title: '', content: 'Already here', x: 60, y: 60, width: 220, height: 160 })
    const cfg = await api.apiAccess.setPort(wanted)
    const on = await api.apiAccess.setEnabled(true)
    const status = await api.apiAccess.status()
    const created = await api.apiAccess.createToken('e2e-live-desk', ['read', 'write'])
    return {
      port: (status.port ?? on.port ?? cfg.port) as number,
      portError: (cfg.error ?? on.error ?? null) as string | null,
      running: Boolean(status.running ?? on.running),
      token: created.secret as string,
      deskId: desk.id as string,
      anchorId: anchor.id as string
    }
  }, wanted)
  expect(out.portError, `the app refused the port: ${out.portError}`).toBeNull()
  expect(out.port, 'the server did not take the port this test chose').toBe(wanted)
  expect(out.running, 'the API server did not come up').toBe(true)
  return { port: out.port, token: out.token, deskId: out.deskId, anchorId: out.anchorId }
}

async function openDesk(window: Page, deskId: string, anchorId: string): Promise<void> {
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), deskId)
  await window.waitForSelector(`[data-widget-id="${anchorId}"]`, { timeout: 15_000 })
}

const onDesk = (window: Page, text: string) => window.locator('[data-widget-id]').filter({ hasText: text })

test('an agent adds a widget to the open desk over MCP, and it appears without a reload', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId, anchorId } = await setup(window)
  await openDesk(window, deskId, anchorId)
  await mcp(window, port, token, 'initialize', { protocolVersion: '2025-06-18' })

  // Mark the page: a reload or remount would lose this, so it proves the widget
  // arrived into the SAME open desk rather than through a fresh load.
  await window.evaluate(() => ((window as unknown as { __liveDeskMark: number }).__liveDeskMark = 1))

  await expect(onDesk(window, 'Added by an agent')).toHaveCount(0)
  const made = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_create_widget',
    arguments: { deskId, kind: 'sticky', content: 'Added by an agent' }
  })
  expect(made.error, JSON.stringify(made.error)).toBeUndefined()
  expect(made.result?.isError, JSON.stringify(made.result)).not.toBe(true)

  await expect(onDesk(window, 'Added by an agent'), 'the agent’s widget appears on the open desk').toHaveCount(1, { timeout: 5_000 })
  expect(await window.evaluate(() => (window as unknown as { __liveDeskMark?: number }).__liveDeskMark), 'no reload happened').toBe(1)
  await expect(window.locator(`[data-widget-id="${anchorId}"]`), 'the desk was not cleared').toBeVisible()
})

test('an agent edits a widget on the open desk over MCP, and the edit shows without a reload', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { port, token, deskId, anchorId } = await setup(window)
  await openDesk(window, deskId, anchorId)
  await mcp(window, port, token, 'initialize', { protocolVersion: '2025-06-18' })
  await window.evaluate(() => ((window as unknown as { __liveDeskMark: number }).__liveDeskMark = 1))

  // The sticky's BODY (its rendered text). Not the whole frame: the header shows
  // the widget's title, which a work widget file took from its first content, and
  // an edit to the content rightly leaves the title alone.
  const body = window.locator(`[data-widget-id="${anchorId}"] .fb-sticky-rendered`)
  await expect(body).toHaveText('Already here')
  const edited = await mcp(window, port, token, 'tools/call', {
    name: 'plexii_update_widget',
    arguments: { id: anchorId, content: 'Rewritten by an agent' }
  })
  expect(edited.error, JSON.stringify(edited.error)).toBeUndefined()
  expect(edited.result?.isError, JSON.stringify(edited.result)).not.toBe(true)

  await expect(body, 'the agent’s edit shows on the open desk').toHaveText('Rewritten by an agent', { timeout: 5_000 })
  expect(await window.evaluate(() => (window as unknown as { __liveDeskMark?: number }).__liveDeskMark), 'no reload happened').toBe(1)
})
