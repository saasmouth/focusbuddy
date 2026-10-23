// REAL input proof for Files beside your work (plan §7 Phase 4 cases 1, 5, 6).
// Not part of the suite (underscore = sweep): it moves the real mouse.
//
// Playwright input goes through CDP and bypasses the macOS hit-test, so a
// control under a window drag region passes every e2e and still does nothing
// for a person (memory: titlebar-drag-region-eats-clicks). These clicks and
// drags are posted as CGEvents (click / drag tools beside this run), with the
// window pinned (setBounds + setAlwaysOnTop) and page coordinates scaled by
// contentBounds.width / innerWidth (the app is zoomed).
//
// Run: FILES_REAL_TOOLS=<dir with click and drag> npx playwright test _filesRealInput

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

const TOOLS = process.env.FILES_REAL_TOOLS ?? '/private/tmp/claude-501/files-flyout-logs/real'
const CLICK = process.env.FILES_REAL_CLICK ?? '/private/tmp/claude-501/vsreal/click'
const SHOTS = process.env.FILES_REAL_SHOTS ?? '/private/tmp/claude-501/files-flyout-logs/shots'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setAlwaysOnTop(false)).catch(() => undefined)
    await launched.dispose()
    launched = null
  }
})

async function pin(app: ElectronApplication, w = 1400, h = 900): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setMinimumSize(800, 600)
    win.setBounds({ x: 60, y: 60, width: s.w, height: s.h })
    win.setAlwaysOnTop(true, 'floating')
    win.show()
    win.focus()
  }, { w, h })
  await new Promise((r) => setTimeout(r, 700))
}

/** Page (CSS px) → global screen points. */
async function toScreen(app: ElectronApplication, window: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const cb = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentBounds())
  const iw = await window.evaluate(() => window.innerWidth)
  const s = cb.width / iw
  return { x: Math.round(cb.x + x * s), y: Math.round(cb.y + y * s) }
}
async function centre(window: Page, sel: string): Promise<{ x: number; y: number }> {
  const b = (await window.locator(sel).first().boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}
async function realClick(app: ElectronApplication, window: Page, sel: string): Promise<void> {
  const c = await centre(window, sel)
  const p = await toScreen(app, window, c.x, c.y)
  execFileSync(CLICK, [String(p.x), String(p.y)])
  await window.waitForTimeout(350)
}
async function realDrag(app: ElectronApplication, window: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const a = await toScreen(app, window, from.x, from.y)
  const b = await toScreen(app, window, to.x, to.y)
  execFileSync(join(TOOLS, 'drag'), [String(a.x), String(a.y), String(b.x), String(b.y)])
  await window.waitForTimeout(800)
}

async function boot(): Promise<{ window: Page; app: ElectronApplication; taskId: string; pdf: string; stickyId: string }> {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  const seed = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Real input desk' })
    const sticky = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Control', x: 700, y: 120, width: 220, height: 160 } as never)) as { id: string }
    const pdf = await api.files.ingestBuffer({ buffer: new TextEncoder().encode('%PDF-1.4\n%%EOF').buffer, originalName: 'real.pdf', mimeType: 'application/pdf', parentId: null })
    await api.fileManager.createFolder(null, 'A folder')
    return { taskId: task.id, pdf: pdf.id, stickyId: sticky.id }
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await window.evaluate((id: string) => (window as unknown as { __fbView: { getState: () => { goTask: (i: string) => void } } }).__fbView.getState().goTask(id), seed.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]')
  await pin(app)
  return { window, app, ...seed }
}

const fileWidgets = (window: Page, taskId: string, content: string): Promise<number> =>
  window.evaluate(
    async ({ t, c }) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(t)).filter((w) => !w.archived && w.kind === 'file' && w.content === c).length,
    { t: taskId, c: content }
  )

test('REAL-1/5: header toggle, float header buttons at the top, and a row dragged onto the desk', async () => {
  test.setTimeout(180_000)
  const { window, app, taskId, pdf, stickyId } = await boot()

  // Control: a real click on a work widget selects it, so input is landing.
  await realClick(app, window, `[data-widget-id="${stickyId}"]`)
  const active = await window.evaluate(() => (window as unknown as { __fbWidgets?: { getState: () => { activeWidgetId: string | null } } }).__fbWidgets?.getState().activeWidgetId)
  expect(active, 'control click did not land: real input is not reaching the window').toBe(stickyId)

  // The header toggle, clicked for real (it sits in the title bar).
  await realClick(app, window, '[data-testid="files-panel-toggle"]')
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
  await window.screenshot({ path: join(SHOTS, 'real-flyout-open.png') })

  // Case 5: the float, dragged as high as it goes, then every header button clicked for real.
  await realClick(app, window, '[data-testid="files-panel-float"]')
  await expect(window.locator('[data-testid="files-float"]')).toBeVisible()
  const hdr = await centre(window, '[data-testid="files-panel-path"]')
  await realDrag(app, window, hdr, { x: hdr.x - 120, y: 2 })
  const top = (await window.locator('[data-testid="files-float"]').boundingBox())!.y
  expect(top, 'the float rose into the title bar').toBeGreaterThanOrEqual(47.5)
  expect(top).toBeLessThan(60)
  await window.screenshot({ path: join(SHOTS, 'real-float-top.png') })
  await realClick(app, window, '[data-testid="files-panel-view-grid"]')
  await expect(window.locator('[data-testid="files-panel-grid"]')).toBeVisible()
  await realClick(app, window, '[data-testid="files-panel-view-list"]')
  await expect(window.locator('[data-testid="files-panel-list"]')).toBeVisible()
  await realClick(app, window, '[data-testid="files-panel-path"]')
  await expect(window.locator('[data-testid="files-panel-path-menu"]')).toBeVisible()
  await realClick(app, window, '[data-testid="files-panel-path"]')
  await realClick(app, window, '[data-testid="files-panel-search"]')
  expect(await window.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('files-panel-search')
  await realClick(app, window, '[data-testid="files-panel-dock"]')
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
  await realClick(app, window, '[data-testid="files-panel-pin"]')
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveAttribute('data-pinned', 'true')
  // Case 1: a real drag from a flyout row onto the desk canvas.
  await window.evaluate(() => {
    const w = window as unknown as { __dragLog: string[] }
    w.__dragLog = []
    for (const t of ['pointerdown', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'pointerup'])
      window.addEventListener(t, (e) => { if (w.__dragLog.length < 400 && (t !== 'dragover' || !w.__dragLog.includes('dragover'))) w.__dragLog.push(`${t}@${(e.target as HTMLElement)?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? (e.target as HTMLElement)?.tagName}${e.defaultPrevented ? '!' : ''}`) }, true)
  })
  const before = await fileWidgets(window, taskId, pdf)
  const row = await centre(window, `[data-testid="files-panel-entry-${pdf}"]`)
  const vp = await window.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  await realDrag(app, window, row, { x: Math.round(vp.w * 0.62), y: Math.round(vp.h * 0.6) })
  console.log('DRAGLOG', await window.evaluate(() => (window as unknown as { __dragLog: string[] }).__dragLog.join(' ')))
  await expect.poll(() => fileWidgets(window, taskId, pdf), { timeout: 6_000 }).toBe(before + 1)
  await window.screenshot({ path: join(SHOTS, 'real-drag-dropped.png') })

  await realClick(app, window, '[data-testid="files-panel-close"]')
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveCount(0)
})

test('REAL-6: a row dragged out of a narrow sheet lands on the content beneath it', async () => {
  test.setTimeout(180_000)
  const { window, app, taskId, pdf } = await boot()
  await pin(app, 860, 820)
  // Real clicks make the app active: a drag session only targets the active app's window.
  await realClick(app, window, '[data-testid="files-panel-toggle"]')
  await realClick(app, window, '[data-testid="files-panel-pin"]')
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveAttribute('data-sheet', 'true')
  const fly = (await window.locator('[data-testid="files-flyout"]').boundingBox())!
  const row = await centre(window, `[data-testid="files-panel-entry-${pdf}"]`)
  await window.evaluate(() => {
    const w = window as unknown as { __dragLog: string[] }
    w.__dragLog = []
    for (const t of ['dragstart', 'dragenter', 'drop', 'dragend'])
      window.addEventListener(t, (e) => { w.__dragLog.push(`${t}@${(e.target as HTMLElement)?.closest?.('[data-testid]')?.getAttribute('data-testid') ?? (e.target as HTMLElement)?.tagName}`) }, true)
  })
  const before = await fileWidgets(window, taskId, pdf)
  // Drop INSIDE the sheet's own rectangle, low down: the canvas is beneath it.
  await realDrag(app, window, row, { x: Math.round(fly.x + fly.width * 0.6), y: Math.round(fly.y + fly.height * 0.8) })
  console.log('DRAGLOG6', await window.evaluate(() => (window as unknown as { __dragLog: string[] }).__dragLog.join(' ')))
  await expect.poll(() => fileWidgets(window, taskId, pdf), { timeout: 6_000 }).toBe(before + 1)
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveCSS('opacity', '1')
})
