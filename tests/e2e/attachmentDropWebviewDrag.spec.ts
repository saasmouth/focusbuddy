// A picture dragged out of a desk browser onto a table's attachment cell, with
// Chromium building and routing the drag (owner, 2026-11-04).
//
// attachmentDrop.spec.ts dispatches DOM drag events carrying what a browser
// drag carries. Two things that leaves out, and this spec covers:
//   1. WHAT a drag that starts in a <webview> really carries. Not guessed: the
//      guest page is pressed on its <img> and moved past the drag threshold
//      through DevTools (Input.dispatchMouseEvent), with drags intercepted
//      (Input.setInterceptDrags), so Chromium hands back the exact drag data
//      it built for that image.
//   2. WHERE the drop goes. That data is delivered through Chromium's own
//      browser-side drag routing (Input.dispatchDragEvent on the desk's page),
//      the path an OS drag over the window takes after AppKit: it hit-tests
//      the point and picks the renderer under it, so a page (a web layer
//      wrapper, a webview) covering the cell would take the drop instead.
// The only part not exercised is the OS drag session itself (AppKit moving the
// drag with the real pointer): attachmentDropNative.spec.ts does that with
// real input when the screen is available.
//
//   WV-1 free canvas: the page lives in the canvas's web layer (lib/webLayer),
//        not in its widget's DOM.
//   WV-2 focus tiled: browser pane beside the table pane; the page renders
//        inline in its pane.

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

const SKY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAdElEQVR42u3XQQ2AQBBD0cpBBCJQgibOnBGGg10FkOyQ2XTCTyrg3dpqv26rCBAgQIAAAZoIaufylNmgF8pHlvI0MZNSNQGTsjWjpsqgsGbIBAgQIECFQFRHxbZ33EOOi9FxU//pBq3HZhVAgAABAgSoOqgDcL4TnGpAG+YAAAAASUVORK5CYII='
const SHOTS = process.env.AD_SHOTS ?? join(process.cwd(), 'test-results', 'attachment-drop')
mkdirSync(SHOTS, { recursive: true })

let server: Server
let origin = ''
test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith('/img/sky.png')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(Buffer.from(SKY_PNG, 'base64'))
    } else if (req.url?.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><title>Pictures</title>
        <style>html,body{margin:0;background:#fff;font:14px system-ui}</style>
        <p style="margin:12px 16px">Drag the picture onto the table.</p>
        <img id="pic" src="/img/sky.png" alt="Sky" width="200" height="200" style="display:block;margin:0 16px;image-rendering:pixelated">`)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Seed {
  taskId: string
  tableId: string
  rowId: string
  existing: string
  table: string
  browser: string
}

async function boot(): Promise<{ window: Page; app: ElectronApplication; seed: Seed }> {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const seed = await window.evaluate(
    async ({ png, page }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const existing = await api.files.ingestBuffer({ buffer: bytes.buffer, originalName: 'already-here.png', mimeType: 'image/png' })
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Browser drag desk' })
      const table = await api.tables.create({
        taskId: task.id,
        title: 'Mood board',
        schema: {
          columns: [
            { id: 'name', type: 'text-short', label: 'Name', config: {} },
            { id: 'photos', type: 'attachment', label: 'Photos', config: {} }
          ]
        } as never
      })
      const row = await api.tables.createRow({ tableId: table.id, cells: { name: 'Fox', photos: [existing.id] } })
      const mk = async (kind: string, content: string, x: number, y: number, width: number, height: number, title = ''): Promise<string> =>
        ((await api.widgets.create({ taskId: task.id, kind, title, content, x, y, width, height } as never)) as { id: string }).id
      // Clear of the floating side menu (it covers the desk's left edge, and the
      // web layer rightly cuts the page out under it).
      const browser = await mk('webview', page, 300, 40, 440, 440, 'Pictures')
      const tableW = await mk('table', table.id, 780, 40, 520, 260, 'Mood board')
      return { taskId: task.id, tableId: table.id, rowId: row.id, existing: existing.id, table: tableW, browser }
    },
    { png: SKY_PNG, page: `${origin}/page` }
  )
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible({ timeout: 15_000 })
  await window.evaluate(() => {
    const st = (window as unknown as { __fbWidgets: { getState: () => { setZoom: (z: number) => void; setPan: (x: number, y: number) => void } } }).__fbWidgets.getState()
    st.setZoom(1)
    st.setPan(0, 0)
  })
  return { window, app, seed }
}

const attachments = (window: Page, seed: Seed): Promise<string[]> =>
  window.evaluate(
    async ({ t, r }) => {
      const rows = await (window as unknown as { api: typeof window.api }).api.tables.listRows(t)
      const v = rows.find((x) => x.id === r)?.cells.photos
      return Array.isArray(v) ? (v as string[]) : []
    },
    { t: seed.tableId, r: seed.rowId }
  )

const deskObjects = (window: Page, taskId: string): Promise<string[]> =>
  window.evaluate(
    async (t) =>
      ((await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(t)) as Array<{ id: string; kind: string; archived?: boolean }>)
        .filter((w) => !w.archived)
        .map((w) => `${w.kind}:${w.id}`)
        .sort(),
    taskId
  )

/** The guest page's id and its picture's centre, in the guest's own coordinates. */
async function guestPicture(window: Page, webviewSel: string): Promise<{ guestId: number; at: { x: number; y: number } }> {
  await expect
    .poll(
      () =>
        window.evaluate(async (sel) => {
          const wv = document.querySelector(sel) as (HTMLElement & { executeJavaScript: (c: string) => Promise<unknown> }) | null
          if (!wv) return 'no webview'
          try {
            return String(await wv.executeJavaScript('(() => { const i = document.getElementById("pic"); return i && i.complete && i.naturalWidth > 0 ? "ready" : "loading" })()'))
          } catch (e) {
            return `not attached: ${(e as Error).message}`
          }
        }, webviewSel),
      { timeout: 20_000, message: 'the desk browser shows the test page and its picture' }
    )
    .toBe('ready')
  return window.evaluate(async (sel) => {
    const wv = document.querySelector(sel) as HTMLElement & { executeJavaScript: (c: string) => Promise<unknown>; getWebContentsId: () => number }
    const at = (await wv.executeJavaScript(
      '(() => { const b = document.getElementById("pic").getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()'
    )) as { x: number; y: number }
    return { guestId: wv.getWebContentsId(), at }
  }, webviewSel)
}

interface DragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>
  files?: string[]
  dragOperationsMask: number
}

/**
 * Press on the guest page's picture and drag it past the threshold, with drags
 * intercepted: Chromium hands back the drag data it built (Input.dragIntercepted).
 */
async function captureGuestDrag(app: ElectronApplication, guestId: number, at: { x: number; y: number }): Promise<DragData> {
  return app.evaluate(
    async ({ webContents }, { guestId, at }) => {
      const wc = webContents.fromId(guestId)
      if (!wc) throw new Error(`no guest webContents ${guestId}`)
      const dbg = wc.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      try {
        await dbg.sendCommand('Input.setInterceptDrags', { enabled: true })
        const got = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the guest never started a drag')), 8_000)
          dbg.on('message', (_e, method, params) => {
            if (method === 'Input.dragIntercepted') {
              clearTimeout(timer)
              resolve((params as { data: unknown }).data)
            }
          })
        })
        const mouse = (type: string, x: number, y: number, buttons: number): Promise<unknown> =>
          dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 })
        await mouse('mouseMoved', at.x, at.y, 0)
        await mouse('mousePressed', at.x, at.y, 1)
        for (let i = 1; i <= 8; i++) await mouse('mouseMoved', at.x + i * 4, at.y + i * 2, 1)
        const data = await got
        await mouse('mouseReleased', at.x + 32, at.y + 16, 0).catch(() => undefined)
        await dbg.sendCommand('Input.setInterceptDrags', { enabled: false }).catch(() => undefined)
        return data as never
      } finally {
        dbg.detach()
      }
    },
    { guestId, at }
  )
}

async function proveBrowserDrop(window: Page, app: ElectronApplication, seed: Seed, webviewSel: string, cellSel: string, shot: string): Promise<void> {
  const before = await attachments(window, seed)
  const objects = await deskObjects(window, seed.taskId)
  const { guestId, at } = await guestPicture(window, webviewSel)
  const data = await captureGuestDrag(app, guestId, at)
  console.log(`[${shot}] the drag Chromium built for the <img>: ${JSON.stringify({ ...data, items: data.items.map((i) => ({ ...i, data: i.data.slice(0, 160) })) })}`)
  const carried = data.items.map((i) => `${i.mimeType}:${i.data}`).join('\n')
  expect(carried, 'the drag names the picture').toContain(`${origin}/img/sky.png`)

  const cell = window.locator(cellSel).first()
  await expect(cell).toBeVisible()
  const cb = (await cell.boundingBox())!
  const target = { x: Math.round(cb.x + cb.width / 2), y: Math.round(cb.y + Math.min(cb.height / 2, 16)) }

  // Through Chromium's own drop routing on the desk's page.
  const cdp = await window.context().newCDPSession(window)
  const drag = (type: 'dragEnter' | 'dragOver' | 'drop'): Promise<unknown> => cdp.send('Input.dispatchDragEvent', { type, x: target.x, y: target.y, data })
  await drag('dragEnter')
  await drag('dragOver')
  await drag('dragOver')
  // Held over the cell: the cell (not a page over it) has it, and lights up.
  await expect.soft(cell, 'the cell lights up while the drag is held').toHaveAttribute('data-attachment-drop', 'over', { timeout: 3_000 })
  await window.screenshot({ path: join(SHOTS, `${shot}-hover.png`) })
  await drag('drop')
  await cdp.detach()

  await window.waitForTimeout(1_500)
  expect.soft(await deskObjects(window, seed.taskId), 'no new object on the desk').toEqual(objects)
  await expect.poll(() => attachments(window, seed), { timeout: 20_000, message: 'one more attachment' }).toHaveLength(before.length + 1)
  const after = await attachments(window, seed)
  expect(after.slice(0, before.length), 'appended, nothing replaced').toEqual(before)
  expect(await deskObjects(window, seed.taskId), 'still no new object on the desk').toEqual(objects)
  const name = await window.evaluate(async (id) => (await (window as unknown as { api: typeof window.api }).api.files.get(id))?.originalName, after[after.length - 1]!)
  expect(name, 'stored under the picture’s own name').toBe('sky.png')
  const thumb = cell.locator(`[data-file-id="${after[after.length - 1]}"] [data-testid="attachment-thumb"]`)
  await expect(thumb).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(48)
  await window.screenshot({ path: join(SHOTS, `${shot}-after.png`) })
}

test('WV-1 — free canvas: a picture dragged out of a desk browser (web layer) lands in the attachment cell', async () => {
  test.setTimeout(120_000)
  const { window, app, seed } = await boot()
  // The page lives in the canvas's web layer, not in its widget.
  await expect(window.locator(`[data-web-for="${seed.browser}"] webview`)).toHaveCount(1, { timeout: 10_000 })
  await expect(window.locator(`[data-widget-id="${seed.browser}"] webview`)).toHaveCount(0)
  // Diagnostics: whether this window is being drawn at all (a locked screen
  // occludes it, which pauses requestAnimationFrame and with it the web layer's
  // placement of the page over its slot).
  console.log(
    '[WV-1] page state:',
    await window.evaluate(async (id) => {
      const frames = await new Promise<number>((r) => {
        let n = 0
        const tick = (): void => void (++n < 1000 && requestAnimationFrame(tick))
        requestAnimationFrame(tick)
        setTimeout(() => r(n), 500)
      })
      const w = document.querySelector<HTMLElement>(`[data-web-for="${id}"]`)
      return JSON.stringify({ visibility: document.visibilityState, rafIn500ms: frames, pageWrapper: w?.style.visibility, width: w?.style.width })
    }, seed.browser)
  )
  // A desk browser on the canvas takes the pointer once it is active ("Click to
  // interact": until then scroll pans the desk). A person clicks it first.
  await window.evaluate((id: string) => {
    ;(window as unknown as { __fbWidgets: { getState: () => { setActive: (i: string) => void } } }).__fbWidgets.getState().setActive(id)
  }, seed.browser)
  await expect(window.locator(`[title^="Click to interact"]`)).toHaveCount(0)
  // The picture is on screen, uncovered: the point at its centre is the page.
  const wvBox = (await window.locator(`[data-web-for="${seed.browser}"] webview`).boundingBox())!
  const hit = await window.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    return el ? `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${String(el.className).slice(0, 60)}` : 'nothing'
  }, { x: wvBox.x + 116, y: wvBox.y + 160 })
  console.log('[WV-1] webview box', JSON.stringify(wvBox), 'under the picture:', hit)
  expect(hit, 'the picture in the desk browser is visible, not under a panel').toMatch(/^webview/)
  await proveBrowserDrop(window, app, seed, `[data-web-for="${seed.browser}"] webview`, `[data-widget-id="${seed.table}"] [data-testid="table-cell-0-1"]`, 'WV-1-browser-drag-canvas')
})

test('WV-2 — focus tiled: the browser pane beside the table pane; a picture dragged across lands', async () => {
  test.setTimeout(150_000)
  const { window, app, seed } = await boot()
  await window.evaluate((w: string) => {
    ;(window as unknown as { __fbWidgets: { getState: () => { setFocused: (i: string) => void } } }).__fbWidgets.getState().setFocused(w)
  }, seed.table)
  await expect(window.locator('[data-testid="widget-focus-mode"]')).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(500)
  // Tile the browser beside the table: its dock tile dragged into the body.
  const tile = window.locator(`[data-testid="focus-dock-tile-${seed.browser}"]`)
  await expect(tile).toBeVisible({ timeout: 5_000 })
  const t = (await tile.boundingBox())!
  const vp = await window.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const start = { x: t.x + t.width / 2, y: t.y + t.height / 2 }
  const end = { x: vp.width * 0.25, y: vp.height * 0.5 }
  await window.mouse.move(start.x, start.y)
  await window.mouse.down()
  for (let i = 1; i <= 12; i++) {
    await window.mouse.move(start.x + ((end.x - start.x) * i) / 12, start.y + ((end.y - start.y) * i) / 12)
    await window.waitForTimeout(40)
  }
  await window.waitForTimeout(300)
  await window.mouse.up()
  const grid = window.locator('[data-testid="focus-split-grid"][data-previewing="false"]')
  await expect(grid).toBeVisible({ timeout: 8_000 })
  await expect(grid.locator('[data-split-cell]')).toHaveCount(2)
  await window.waitForTimeout(800)
  // Focus renders its page inline, in its pane (not through the web layer).
  const webviewSel = '[data-testid="focus-split-grid"][data-previewing="false"] webview'
  await expect(window.locator(webviewSel)).toHaveCount(1, { timeout: 10_000 })
  await proveBrowserDrop(window, app, seed, webviewSel, '[data-testid="focus-split-grid"][data-previewing="false"] [data-testid="table-cell-0-1"]', 'WV-2-browser-drag-split')
})
