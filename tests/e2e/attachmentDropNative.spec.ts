// A picture dragged for REAL out of a desk browser onto a table's attachment
// cell (owner, 2026-11-04).
//
// attachmentDrop.spec.ts dispatches the drop the way a browser describes it.
// This one makes the browser do it: the real macOS pointer (CGEvents through
// the window server, _macMouse) presses on an <img> inside a desk browser's
// <webview>, drags out of the guest page across the desk, and lets go over the
// table's attachment cell. That is the path a synthetic event cannot reach:
// the drag starts in another renderer process (the guest), leaves it, and must
// still be delivered to the desk's own page and land on the cell, through:
//   - the canvas's web layer (lib/webLayer): the page is NOT in its widget's
//     DOM, it sits over a slot, at the slot's pointer-events;
//   - focus tiled mode, where the page renders inline in its pane (NAT-2).
// Whatever Chromium hands over (the picture's bytes as a File, or its address
// on text/uri-list and text/html), one attachment must land and nothing else
// may appear on the desk.
//
// Real input owns the one screen: the lock (_realInputLock) is held from
// beforeAll to afterAll, the window is pinned on top, and the cursor is put
// back where it was. It takes the owner's pointer, so it runs only with
// PLEXII_REAL_INPUT=1, once they have said the Mac is free; a hand on the mouse
// mid-run is reported as such (the driven-path check), not as a failed drop.

import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { acquireRealInput, releaseRealInput } from './_realInputLock'
import {
  cursorLocation,
  moveMouse,
  path,
  pinWindowForRealInput,
  postMouse,
  realInputAllowed,
  REAL_INPUT_SKIP,
  screenIsLocked,
  unpinWindow,
  type ScreenPoint
} from './_macMouse'

test.skip(process.platform !== 'darwin', 'posts macOS mouse events')
test.skip(!realInputAllowed(), REAL_INPUT_SKIP)
// A locked screen takes every real event: nothing could reach the app, and a
// red here would blame the app for it. Say so instead (the DevTools-level
// proof, attachmentDropWebviewDrag.spec.ts, needs no screen).
test.skip(process.platform === 'darwin' && screenIsLocked(), 'the Mac screen is locked: real input goes to the lock screen, not the app')

const SKY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAdElEQVR42u3XQQ2AQBBD0cpBBCJQgibOnBGGg10FkOyQ2XTCTyrg3dpqv26rCBAgQIAAAZoIaufylNmgF8pHlvI0MZNSNQGTsjWjpsqgsGbIBAgQIECFQFRHxbZ33EOOi9FxU//pBq3HZhVAgAABAgSoOqgDcL4TnGpAG+YAAAAASUVORK5CYII='
const SHOTS = process.env.AD_SHOTS ?? join(process.cwd(), 'test-results', 'attachment-drop')
mkdirSync(SHOTS, { recursive: true })

let server: Server
let origin = ''
let launched: LaunchedApp | null = null
let cursorBefore: ScreenPoint | null = null

test.beforeAll(async () => {
  // Real input is one spec at a time across workers (_realInputLock.ts).
  test.setTimeout(240_000)
  await acquireRealInput('attachmentDropNative')
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
  cursorBefore = cursorLocation()
})

test.afterAll(async () => {
  try {
    if (cursorBefore) moveMouse(cursorBefore)
    await new Promise<void>((r) => server.close(() => r()))
  } finally {
    releaseRealInput()
  }
})

test.afterEach(async () => {
  if (launched) {
    await unpinWindow(launched.app).catch(() => undefined)
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

async function boot(): Promise<{ window: Page; seed: Seed; toScreen: (p: { x: number; y: number }) => ScreenPoint }> {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  await chooseCloudAiSource(window)
  const seed = await window.evaluate(
    async ({ png, page }) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      const existing = await api.files.ingestBuffer({ buffer: bytes.buffer, originalName: 'already-here.png', mimeType: 'image/png' })
      const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Real drag desk' })
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
  // Pin the window where the real events will land, in front of everything.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!
    win.setBounds({ x: 40, y: 40, width: 1400, height: 900 })
  })
  await window.waitForTimeout(500)
  const toScreen = await pinWindowForRealInput(app, window)
  return { window, seed, toScreen }
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

/**
 * The centre of the page's <img>, in the desk page's coordinates: the guest's
 * own rect, scaled and offset by where the <webview> sits. The scale is the
 * webview's drawn width over the guest's own viewport width, so it holds
 * whatever zooms are in play: the web layer's canvas zoom, the app's uiScale
 * (0.9 on a 1512x904 screen) and the guest's own zoom, followed or not.
 */
async function pictureInPage(window: Page, webviewSel: string): Promise<{ x: number; y: number }> {
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
    const wv = document.querySelector(sel) as HTMLElement & { executeJavaScript: (c: string) => Promise<unknown> }
    const r = wv.getBoundingClientRect()
    const g = (await wv.executeJavaScript(
      '(() => { const b = document.getElementById("pic").getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, iw: window.innerWidth } })()'
    )) as { x: number; y: number; iw: number }
    const scale = r.width / (g.iw || r.width)
    return { x: r.left + g.x * scale, y: r.top + g.y * scale }
  }, webviewSel)
}

/**
 * Record every drag event the desk's own page sees (capture phase), for the log
 * and the assertions. An event inside a table cell names the cell first
 * ("table-cell-0-1>attachment-chip"): the cell owns the drop wherever in it the
 * pointer is let go, and a real hand aims at the picture already there (NAT-1,
 * a7 2026-11-05, let go over the existing chip). Every dragover's point is kept
 * too, to tell a pointer that left the path this spec drives from a drop that
 * went wrong.
 */
async function watchDrags(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __dragLog: string[]; __dropTypes: string[]; __dragPts: Array<{ x: number; y: number }> }
    w.__dragLog = []
    w.__dropTypes = []
    w.__dragPts = []
    for (const t of ['dragenter', 'dragover', 'dragleave', 'drop', 'dragend']) {
      window.addEventListener(
        t,
        (e) => {
          const ev = e as DragEvent
          const el = ev.target as HTMLElement | null
          const inner = el?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? el?.tagName ?? '?'
          const cell = el?.closest?.('[data-testid^="table-cell-"]')?.getAttribute('data-testid')
          const where = cell && cell !== inner ? `${cell}>${inner}` : inner
          if (t === 'dragover' && w.__dragPts.length < 600) w.__dragPts.push({ x: ev.clientX, y: ev.clientY })
          if (t === 'drop') w.__dropTypes = Array.from(ev.dataTransfer?.types ?? [])
          const last = w.__dragLog[w.__dragLog.length - 1]
          const entry = `${t}@${where}`
          if (last !== entry && w.__dragLog.length < 300) w.__dragLog.push(entry)
        },
        true
      )
    }
  })
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

async function realDrag(from: ScreenPoint, to: ScreenPoint): Promise<void> {
  // Press, nudge past the drag threshold inside the picture (that starts the
  // drag session in the guest), travel, settle over the target, let go.
  const nudge = path(from, { x: from.x + 14, y: from.y + 6 }, 6)
  const travel = path(nudge[nudge.length - 1]!, to, 28)
  postMouse(
    [
      { kind: 'move', at: from },
      { kind: 'down', at: from },
      ...nudge.map((at) => ({ kind: 'drag' as const, at })),
      ...travel.map((at) => ({ kind: 'drag' as const, at })),
      ...Array.from({ length: 8 }, (_, i) => ({ kind: 'drag' as const, at: { x: to.x + (i % 2), y: to.y } })),
      { kind: 'up', at: to }
    ],
    30
  )
}

async function proveRealDrop(
  window: Page,
  seed: Seed,
  webviewSel: string,
  cellSel: string,
  shot: string
): Promise<void> {
  const before = await attachments(window, seed)
  const objects = await deskObjects(window, seed.taskId)
  const pic = await pictureInPage(window, webviewSel)
  const cell = window.locator(cellSel).first()
  await expect(cell).toBeVisible()
  const cb = (await cell.boundingBox())!
  const target = { x: cb.x + cb.width / 2, y: cb.y + Math.min(cb.height / 2, 16) }
  // What is under the target point is the cell (no page or panel over it).
  const under = await window.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-attachment-drop]')?.getAttribute('data-attachment-drop') ?? null, target)
  expect(under, 'the attachment cell is what sits under the drop point').not.toBeNull()
  await watchDrags(window)
  const to = await toScreenOf(window, target)
  await realDrag(await toScreenOf(window, pic), to)
  const cursorAfter = cursorLocation()
  const log = await window.evaluate(() => (window as unknown as { __dragLog: string[] }).__dragLog.join(' '))
  const types = await window.evaluate(() => (window as unknown as { __dropTypes: string[] }).__dropTypes)
  console.log(`[${shot}] desk drag log: ${log}`)
  console.log(`[${shot}] drop carried: ${JSON.stringify(types)}`)
  // The pointer must have followed the path this spec drove: a straight line
  // from the picture to the cell (the nudge that starts the drag is under
  // 20 page px off it). A point far off it means the pointer was moved by
  // something else (a hand on the mouse: the owner works at this Mac) or the
  // app reads drag positions wrongly; either way the drop's result proves
  // nothing about the drop, so say which, before blaming the drop.
  const pts = await window.evaluate(() => (window as unknown as { __dragPts: Array<{ x: number; y: number }> }).__dragPts)
  const offPath = pts
    .map((q) => ({ ...q, off: Math.round(distanceToSegment(q, pic, target)) }))
    .filter((q) => q.off > 40)
  const moved = Math.hypot(cursorAfter.x - to.x, cursorAfter.y - to.y)
  console.log(`[${shot}] dragover points: ${pts.length}, off the driven path: ${offPath.length}; cursor ${Math.round(moved)} px from the release point`)
  expect(
    offPath.slice(0, 5),
    `${offPath.length} of ${pts.length} drag points were over 40 px off the driven path` +
      ` (cursor ended ${Math.round(moved)} px from the release point): someone moved the mouse during the run, or drag positions are mapped wrongly`
  ).toEqual([])
  expect(log, 'the drag out of the browser reached the desk page and was dropped in the cell').toMatch(/drop@table-cell-0-1(?:>|\s|$)/)
  await expect.poll(() => attachments(window, seed), { timeout: 20_000, message: 'one more attachment' }).toHaveLength(before.length + 1)
  const after = await attachments(window, seed)
  expect(after.slice(0, before.length), 'appended, nothing replaced').toEqual(before)
  await window.waitForTimeout(1_500)
  expect(await deskObjects(window, seed.taskId), 'no new object on the desk').toEqual(objects)
  const name = await window.evaluate(async (id) => (await (window as unknown as { api: typeof window.api }).api.files.get(id))?.originalName, after[after.length - 1]!)
  console.log(`[${shot}] stored as: ${name}`)
  const thumb = cell.locator(`[data-file-id="${after[after.length - 1]}"] [data-testid="attachment-thumb"]`)
  await expect(thumb).toBeVisible({ timeout: 5_000 })
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth), { timeout: 5_000 }).toBe(48)
  await window.screenshot({ path: join(SHOTS, `${shot}.png`) })
}

let mapper: ((p: { x: number; y: number }) => ScreenPoint) | null = null
async function toScreenOf(_window: Page, p: { x: number; y: number }): Promise<ScreenPoint> {
  return mapper!(p)
}

test('NAT-1 — free canvas: a picture dragged for real out of a desk browser lands in the attachment cell', async () => {
  test.setTimeout(120_000)
  const { window, seed, toScreen } = await boot()
  mapper = toScreen
  // A control press, as a person would: a real click on the desk browser. It
  // makes the app active (a drag session only targets the active app), proves
  // real input lands here, and activates the browser -- on the canvas an
  // inactive browser is under a "Click to interact" shield that lets scroll
  // pan the desk, so its page takes no press until it is clicked once.
  // (Drawn over the page, so it lives with the page in the web layer.)
  const shield = window
    .locator(`[data-web-for="${seed.browser}"] [title^="Click to interact"], [data-widget-id="${seed.browser}"] [title^="Click to interact"]`)
    .first()
  const sb = await shield.boundingBox()
  expect(sb, 'the inactive browser shows its click-to-interact shield').not.toBeNull()
  const quiet = toScreen({ x: sb!.x + sb!.width * 0.75, y: sb!.y + sb!.height * 0.85 })
  postMouse([{ kind: 'move', at: quiet }, { kind: 'down', at: quiet }, { kind: 'up', at: quiet }])
  await window.waitForTimeout(400)
  const active = await window.evaluate(() => (window as unknown as { __fbWidgets: { getState: () => { activeWidgetId: string | null } } }).__fbWidgets.getState().activeWidgetId)
  expect(active, 'control click did not land: real input is not reaching the window').toBe(seed.browser)
  // The page lives in the canvas's web layer, not in its widget.
  await expect(window.locator(`[data-web-for="${seed.browser}"] webview`)).toHaveCount(1)
  await proveRealDrop(window, seed, `[data-web-for="${seed.browser}"] webview`, `[data-widget-id="${seed.table}"] [data-testid="table-cell-0-1"]`, 'NAT-1-real-drag-canvas')
})

test('NAT-2 — focus tiled: browser pane beside the table pane, a real drag between them lands', async () => {
  test.setTimeout(150_000)
  const { window, seed, toScreen } = await boot()
  mapper = toScreen
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
  // Focus renders its page inline, in the pane (not through the web layer).
  const webviewSel = '[data-testid="focus-split-grid"][data-previewing="false"] webview'
  await expect(window.locator(webviewSel)).toHaveCount(1, { timeout: 10_000 })
  // Make the app active with a real click on the table pane's empty area.
  const cellSel = '[data-testid="focus-split-grid"][data-previewing="false"] [data-testid="table-cell-0-0"]'
  const nb = (await window.locator(cellSel).first().boundingBox())!
  const quiet = toScreen({ x: nb.x + nb.width / 2, y: nb.y + nb.height + 120 })
  await window.evaluate(() => {
    const w = window as unknown as { __presses: number }
    w.__presses = 0
    window.addEventListener('pointerdown', () => void w.__presses++, true)
  })
  postMouse([{ kind: 'move', at: quiet }, { kind: 'down', at: quiet }, { kind: 'up', at: quiet }])
  await window.waitForTimeout(400)
  expect(
    await window.evaluate(() => (window as unknown as { __presses: number }).__presses),
    'control click did not land: real input is not reaching the window'
  ).toBeGreaterThan(0)
  await proveRealDrop(window, seed, webviewSel, '[data-testid="focus-split-grid"][data-previewing="false"] [data-testid="table-cell-0-1"]', 'NAT-2-real-drag-split')
})
