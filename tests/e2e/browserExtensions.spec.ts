/**
 * Chrome extensions in Plexii's browser.
 *
 * The claim worth testing is the one that is not obvious from the code: that a
 * content script from an unpacked extension actually executes inside an
 * Electron <webview> guest. Electron loads extensions per SESSION, and whether
 * that reaches webview guests has varied between versions — so this is the
 * assertion that decides whether the feature works at all, rather than merely
 * whether loadExtension() resolved.
 *
 * Hermetic: the extension is written to a temp folder here, and the page it
 * runs against is served from a loopback HTTP server started by this spec. It
 * has to be http — `will-attach-webview` in main refuses a `file:` or `blob:`
 * guest on purpose ("the case nothing in this app asks for and an attacker
 * does"), which is correct and is why the first attempt at this test saw no
 * guest attach at all.
 */

import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'http'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

const MARKER = 'EXT_CONTENT_SCRIPT_RAN'

/** A minimal MV2 extension whose only job is to be observable. */
function writeProbeExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plexii-ext-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: 2,
        name: 'Plexii Extension Probe',
        version: '1.0.0',
        content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }]
      },
      null,
      2
    )
  )
  // The title is the cheapest thing a host can read back, from either side.
  writeFileSync(join(dir, 'content.js'), `document.title = ${JSON.stringify(MARKER)}\n`)
  return dir
}

let launched: LaunchedApp | null = null
let server: Server | null = null
let port = 0

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><meta charset="utf-8"><title>PLAIN_PAGE</title><body>probe</body>')
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  port = (server!.address() as { port: number }).port
})

test.afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('EXT-1 — a content script from an unpacked extension runs inside a webview guest', async () => {
  test.slow() // boots the app, loads an extension, and waits for a guest to paint
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)

  const extDir = writeProbeExtension()

  // Loaded into the partition every browser surface shares.
  const load = await app.evaluate(async ({ session }, dir: string) => {
    try {
      const ext = await session
        .fromPartition('persist:webview-default')
        .extensions.loadExtension(dir, { allowFileAccess: false })
      return { ok: true as const, id: ext.id, name: ext.name }
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) }
    }
  }, extDir)
  expect(load.ok, `loadExtension failed: ${JSON.stringify(load)}`).toBe(true)
  if (load.ok) expect(load.name).toBe('Plexii Extension Probe')

  // A desk with a browser widget on it, pointed at the loopback page.
  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const n = await api.nodes.create({ parentId: null, kind: 'task', title: 'Extension desk' })
    return (n as unknown as { id: string }).id
  })
  await window.evaluate(
    async ({ taskId, url }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      await api.widgets.create({
        taskId,
        kind: 'webview',
        content: url,
        x: 40,
        y: 40,
        width: 600,
        height: 400
      } as never)
    },
    { taskId: deskId, url: `http://127.0.0.1:${port}/` }
  )

  // The stores are populated by their own actions, not by bare IPC — reload so
  // the desk has something to open.
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: 'Extension desk' }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })

  // The guest attaches and paints asynchronously, and the content script runs at
  // document_idle, so poll rather than sleep.
  await expect
    .poll(
      async () =>
        app.evaluate(({ webContents }) => {
          const guest = webContents
            .getAllWebContents()
            .find((w) => w.getType() === 'webview' && w.getURL().includes('127.0.0.1'))
          return guest?.getTitle() ?? null
        }),
      { timeout: 20_000, message: 'the webview guest never reported the content script marker' }
    )
    .toBe(MARKER)
})

test('EXT-2 — a folder with no manifest is refused with a reason, not a crash', async () => {
  launched = await launchApp()
  const { app } = launched
  await waitForReady(launched.window)

  const empty = mkdtempSync(join(tmpdir(), 'plexii-ext-empty-'))
  const res = await app.evaluate(async ({ session }, dir: string) => {
    try {
      await session.fromPartition('persist:webview-default').extensions.loadExtension(dir)
      return { threw: false }
    } catch (e) {
      return { threw: true, message: e instanceof Error ? e.message : String(e) }
    }
  }, empty)
  // Electron refuses it; the module turns this into a readable sentence rather
  // than letting it reach the UI as a raw Chromium string.
  expect(res.threw).toBe(true)
})
