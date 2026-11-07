// A live web view link opens in the full web app (owner, 2026-11-07: "they all
// should be the same, just the interactivity that changes"). The full app
// needs the desk itself, so the desktop sends it beside the projection
// (useLiveDeskPublisher sendBundle -> main livePublisher.publishLiveBundle ->
// PUT /shares/desks/:token/bundle).
//
// Signal is played by a local server here: the main process talks to
// FB_SIGNAL_URL, so nothing reaches production.
import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

const TOKEN = 'dsk_e2e0000000000000000000000000000000000'

test('LB-1 a live desk sends the desk itself, so its link opens in the full web app', async () => {
  test.setTimeout(150_000)
  const got: { projections: number; bundles: Array<{ auth: string; body: { bundle?: string } }> } = { projections: 0, bundles: [] }
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      const url = req.url ?? ''
      if (req.method === 'POST' && url === '/shares/desks') return send(200, { ok: true, token: TOKEN })
      if (req.method === 'PUT' && url === `/shares/desks/${TOKEN}/projection`) {
        got.projections++
        return send(200, { ok: true, revision: got.projections })
      }
      if (req.method === 'PUT' && url.startsWith(`/shares/desks/${TOKEN}/assets/`)) return send(200, { ok: true })
      if (req.method === 'PUT' && url === `/shares/desks/${TOKEN}/bundle`) {
        got.bundles.push({ auth: String(req.headers.authorization ?? ''), body: JSON.parse(raw || '{}') })
        return send(200, { ok: true, bundleUpdatedAt: Date.now() })
      }
      return send(503, { ok: false, error: 'unavailable' })
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  launched = await launchApp({ env: { FB_SIGNAL_URL: base } })
  const { window } = launched
  await waitForReady(window)
  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    await api.account.saveSession({ token: 'e2e-live-session', email: 'sender@example.com' })
    const desk = (await api.nodes.create({ parentId: null, kind: 'task', title: 'Lesson Planning' })) as { id: string }
    await api.widgets.create({ taskId: desk.id, kind: 'sticky', title: '', content: 'Prep the exit ticket', x: 40, y: 40, width: 220, height: 160 } as never)
    const started = await api.liveDesk.start(desk.id)
    if (!started.ok) throw new Error(`could not publish: ${started.error}`)
    return desk.id
  })

  // The desk itself arrives, with the session, beside the projection.
  await expect.poll(() => got.bundles.length, { timeout: 90_000, intervals: [2000] }).toBeGreaterThan(0)
  const sent = got.bundles[0]
  expect(sent.auth).toBe('Bearer e2e-live-session')
  const bundle = JSON.parse(String(sent.body.bundle)) as {
    format: string; desk: { id: string; title: string }; tables: { widgets: Array<{ content: string }> }
  }
  expect(bundle.format).toBe('plexii.desk')
  expect(bundle.desk).toEqual({ id: deskId, title: 'Lesson Planning' })
  expect(bundle.tables.widgets.map((w) => w.content)).toEqual(['Prep the exit ticket'])
  expect(got.projections).toBeGreaterThan(0)
})
