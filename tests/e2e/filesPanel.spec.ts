// Files beside your work (owner, Q1): a LEFT flyout from the side menu, in
// every context including the office apps. Unpinned it overlays the content
// (nothing under it moves); pinned it reserves its width and the content (the
// office tool rail included) moves right.
//
//   FP-1  every opener: header toggle, side-menu Files click, its right-click
//         menu, ⌥⌘F, the palette; the header toggle reflects state
//   FP-2  office app (Write and Draw): unpinned the rail does NOT move and the
//         flyout overlays it with an edge and shadow; pinned the rail moves
//         right of the panel and is hit-testable
//   FP-3  desk: unpinned overlays, pinned moves the visible canvas edge
//   FP-4  resize by keyboard and pointer, clamped 240–560; pinned + width
//         remembered across a reload
//   FP-5  too narrow to pin (1100px window): a sheet over the content, no
//         horizontal overflow anywhere
//   FP-6  keyboard: arrows, Enter into a folder, Backspace up, type-ahead;
//         multi-select with ⌘ and ⇧
//   FP-7  the panel keeps its own folder when Files opens full screen
//   FP-8  the floating panel: opens, its header drags but never above the
//         title bar, Dock docks it
//   FP-9  light and dark: the panel paints from the theme tokens

import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Seed = { taskId: string; folderId: string; subId: string; docId: string; drawId: string; csvId: string }

async function boot(opts: { theme?: 'light' | 'dark' } = {}): Promise<{ window: Page; app: ElectronApplication; seed: Seed }> {
  launched = await launchApp()
  const { window, app } = launched
  await waitForReady(window)
  const seed = (await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Files desk' })
    await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Hello', x: 60, y: 60, width: 220, height: 160 } as never)
    const folder = await api.fileManager.createFolder(null, 'Alpha folder')
    const sub = await api.fileManager.createFolder(folder.id, 'Beta inside')
    const csv = await api.files.ingestBuffer({ buffer: new TextEncoder().encode('a,b\n1,2\n').buffer, originalName: 'numbers.csv', mimeType: 'text/csv', parentId: null })
    await api.files.ingestBuffer({ buffer: new TextEncoder().encode('note').buffer, originalName: 'zeta.txt', mimeType: 'text/plain', parentId: null })
    const doc = (await api.documents.create({ docType: 'doc', title: 'Panel doc' } as never)) as { id: string }
    const draw = (await api.documents.create({ docType: 'draw', title: 'Panel art' } as never)) as { id: string }
    return { taskId: task.id, folderId: folder.id, subId: sub.id, docId: doc.id, drawId: draw.id, csvId: csv.id }
  })) as Seed
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), opts.theme ?? 'light')
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  return { window, app, seed }
}

async function goDesk(window: Page, id: string): Promise<void> {
  await window.evaluate((i: string) => (window as unknown as { __fbView: { getState: () => { goTask: (x: string) => void } } }).__fbView.getState().goTask(i), id)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
}
async function goOfficeDoc(window: Page, id: string): Promise<void> {
  await window.evaluate((i: string) => (window as unknown as { __fbView: { getState: () => { goOffice: (a?: string, d?: string) => void } } }).__fbView.getState().goOffice(undefined, i), id)
}
const panelState = (window: Page): Promise<{ open: boolean; mode: string; pinned: boolean; width: number }> =>
  window.evaluate(() => {
    const raw = Object.keys(localStorage).filter((k) => k.startsWith('fb.filesPanel.'))
    const v = raw.length ? JSON.parse(localStorage.getItem(raw[0]!) ?? '{}') : {}
    return { open: !!v.open, mode: v.mode ?? 'beside', pinned: !!v.pinned, width: v.width ?? 320 }
  })
const rect = (window: Page, sel: string): Promise<{ left: number; right: number; top: number; bottom: number; width: number } | null> =>
  window.evaluate((s: string) => {
    const el = document.querySelector(s)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
  }, sel)

test('FP-1 every opener opens Files beside; the toggle says so', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  const flyout = window.locator('[data-testid="files-flyout"]')
  const toggle = window.locator('[data-testid="files-panel-toggle"]')

  // Header toggle.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(flyout).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(window.locator('[data-testid="files-panel"]')).toHaveAttribute('data-files-panel-host', 'flyout')
  await toggle.click()
  await expect(flyout).toHaveCount(0)

  // Side menu: a click flies it out; a second click closes it.
  const tile = window.locator('[data-testid="office-comms-app-files"]').first()
  await tile.scrollIntoViewIfNeeded()
  await tile.click()
  await expect(flyout).toBeVisible()
  await expect(window.locator('[data-canvas-surface="true"]')).toBeVisible() // still on the desk
  await tile.click()
  await expect(flyout).toHaveCount(0)

  // Right-click: Open floating, then Open beside, then Open full screen.
  await tile.click({ button: 'right' })
  await window.locator('[data-testid="files-open-floating"]').click()
  await expect(window.locator('[data-testid="files-float"]')).toBeVisible()
  await tile.click({ button: 'right' })
  await window.locator('[data-testid="files-open-beside"]').click()
  await expect(flyout).toBeVisible()
  await expect(window.locator('[data-testid="files-float"]')).toHaveCount(0)

  // ⌥⌘F closes and opens it, wherever focus is.
  await window.locator('[data-canvas-surface="true"]').click({ position: { x: 900, y: 500 } })
  await window.keyboard.press('Meta+Alt+KeyF')
  await expect(flyout).toHaveCount(0)
  await window.keyboard.press('Meta+Alt+KeyF')
  await expect(flyout).toBeVisible()
  // ⌥⇧⌘F is not ours (Draw binds it).
  await window.keyboard.press('Meta+Alt+Shift+KeyF')
  await expect(flyout).toBeVisible()

  // Palette.
  await window.keyboard.press('Meta+Alt+KeyF')
  await expect(flyout).toHaveCount(0)
  await window.locator('[data-testid="topbar-search"]').click()
  await window.locator('[data-testid="command-palette-input"]').fill('Files: Open beside')
  await window.locator('[data-testid="palette-row-files-panel-open-beside"]').click()
  await expect(flyout).toBeVisible()

  // Full screen from the right-click menu; the header toggle steps aside there.
  await tile.click({ button: 'right' })
  await window.locator('[data-testid="files-open-fullscreen"]').click()
  await expect(window.locator('[data-testid="files-view"]')).toBeVisible({ timeout: 8_000 })
  await expect(toggle).toHaveCount(0)
})

for (const app of [
  { name: 'PlexiiWrite', key: 'docId' as const, rail: '[data-testid="doc-rail"]' },
  { name: 'PlexiiDraw', key: 'drawId' as const, rail: '[data-testid="draw-toolbox"]' }
]) {
  test(`FP-2 ${app.name}: unpinned overlays the tool rail without moving it; pinned moves the rail right`, async () => {
    test.setTimeout(120_000)
    const { window, seed } = await boot()
    await goOfficeDoc(window, seed[app.key])
    const rail = window.locator(app.rail).first()
    await expect(rail).toBeVisible({ timeout: 20_000 })
    await window.waitForTimeout(500)
    const closed = (await rect(window, app.rail))!

    await window.locator('[data-testid="files-panel-toggle"]').click()
    const flyout = window.locator('[data-testid="files-flyout"]')
    await expect(flyout).toHaveAttribute('data-pinned', 'false')
    await window.waitForTimeout(400)
    const over = (await rect(window, app.rail))!
    const fly = (await rect(window, '[data-testid="files-flyout"]'))!
    expect(Math.abs(over.left - closed.left), 'the rail moved when the flyout opened').toBeLessThanOrEqual(1)
    expect(fly.right, 'the unpinned flyout should sit over the rail').toBeGreaterThan(over.left)
    // A clear edge and a cast shadow, so it never reads as part of the rail.
    const shadow = await flyout.evaluate((el) => getComputedStyle(el).boxShadow)
    expect(shadow).toMatch(/rgba\(0, 0, 0, 0\.38\)/)
    // The flyout's own controls are on top, not the rail's.
    const top = await window.evaluate(() => {
      const b = document.querySelector('[data-testid="files-panel-pin"]')!.getBoundingClientRect()
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('[data-testid="files-panel-pin"]') != null
    })
    expect(top).toBe(true)

    await window.locator('[data-testid="files-panel-pin"]').click()
    await expect(flyout).toHaveAttribute('data-pinned', 'true')
    await window.waitForTimeout(500)
    const pinned = (await rect(window, app.rail))!
    const fly2 = (await rect(window, '[data-testid="files-flyout"]'))!
    expect(pinned.left, 'pinned: the rail sits right of the panel').toBeGreaterThanOrEqual(fly2.right)
    // The rail's first button is hit-testable (nothing covers it).
    const railHit = await window.evaluate((sel: string) => {
      const btn = document.querySelector(`${sel} button`) as HTMLElement
      const b = btn.getBoundingClientRect()
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest(sel) != null
    }, app.rail)
    expect(railHit).toBe(true)
  })
}

test('FP-3 desk: unpinned overlays the canvas; pinned moves the canvas edge right', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  const inset = (): Promise<number> => window.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fb-dock-inset')) || 0)
  const before = await inset()
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveAttribute('data-over-canvas', 'true')
  await window.waitForTimeout(300)
  expect(await inset(), 'unpinned must not move the desk').toBe(before)
  await window.locator('[data-testid="files-panel-pin"]').click()
  await window.waitForTimeout(500)
  const fly = (await rect(window, '[data-testid="files-flyout"]'))!
  const after = await inset()
  expect(after).toBeGreaterThan(before)
  expect(after, 'the visible canvas starts past the pinned panel').toBeGreaterThanOrEqual(Math.round(fly.right))
})

test('FP-4 resize by keyboard and pointer; pinned and width are remembered across a reload', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  const sep = window.locator('[data-testid="files-panel-resize"]')
  await expect(sep).toHaveAttribute('aria-valuenow', '320')
  await expect(sep).toHaveAttribute('aria-valuemin', '240')
  await sep.focus()
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('ArrowRight')
  await expect(sep).toHaveAttribute('aria-valuenow', '352')
  await window.keyboard.press('Home')
  await expect(sep).toHaveAttribute('aria-valuenow', '240')
  // Pointer: drag the splitter 80px right.
  const b = (await sep.boundingBox())!
  await window.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  await window.mouse.down()
  await window.mouse.move(b.x + b.width / 2 + 40, b.y + b.height / 2, { steps: 4 })
  await window.mouse.move(b.x + b.width / 2 + 80, b.y + b.height / 2, { steps: 4 })
  await window.mouse.up()
  await expect(sep).toHaveAttribute('aria-valuenow', '320')
  // Way past the maximum: clamped.
  const b2 = (await sep.boundingBox())!
  await window.mouse.move(b2.x + 3, b2.y + 50)
  await window.mouse.down()
  await window.mouse.move(b2.x + 900, b2.y + 50, { steps: 6 })
  await window.mouse.up()
  const max = Number(await sep.getAttribute('aria-valuemax'))
  expect(max).toBeLessThanOrEqual(560)
  await expect(sep).toHaveAttribute('aria-valuenow', String(max))
  await sep.dblclick()
  await expect(sep).toHaveAttribute('aria-valuenow', '320')
  await sep.focus()
  await window.keyboard.press('ArrowRight')
  await window.locator('[data-testid="files-panel-pin"]').click()
  expect(await panelState(window)).toMatchObject({ open: true, pinned: true, width: 336 })

  await window.reload()
  await waitForReady(window)
  await goDesk(window, seed.taskId)
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveAttribute('data-pinned', 'true')
  await expect(window.locator('[data-testid="files-panel-resize"]')).toHaveAttribute('aria-valuenow', '336')
  await expect(window.locator('[data-testid="files-panel-pin"]')).toHaveAttribute('aria-pressed', 'true')
})

test('FP-5 too narrow to pin: a sheet over the content, nothing overflows', async () => {
  test.setTimeout(120_000)
  const { window, app, seed } = await boot()
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.setMinimumSize(800, 600)
    w?.setContentSize(1100, 800)
  })
  await window.waitForTimeout(600)
  await goOfficeDoc(window, seed.docId)
  await expect(window.locator('[data-testid="doc-rail"]').first()).toBeVisible({ timeout: 20_000 })
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await window.locator('[data-testid="files-panel-pin"]').click()
  // Widest it allows.
  await window.locator('[data-testid="files-panel-resize"]').focus()
  await window.keyboard.press('End')
  await window.waitForTimeout(500)
  const flyout = window.locator('[data-testid="files-flyout"]')
  const sheet = await flyout.getAttribute('data-sheet')
  const reserved = Number(await window.locator('[data-testid="files-dock-slot"]').getAttribute('data-reserved'))
  // Either it pinned and left the content ≥ 560px, or it is a sheet that reserves nothing.
  const vw = await window.evaluate(() => window.innerWidth)
  if (sheet === 'true') expect(reserved).toBe(0)
  else {
    const main = (await rect(window, '[data-testid="doc-rail"]'))!
    expect(vw - main.left).toBeGreaterThanOrEqual(560)
  }
  // Narrower still (below the main window's own minimum, as a docked meeting or
  // the assistant sidebar make it): it cannot pin, so it is a sheet over the
  // content that reserves nothing.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(860, 800))
  await window.waitForTimeout(700)
  await expect(flyout).toHaveAttribute('data-sheet', 'true')
  await expect(window.locator('[data-testid="files-dock-slot"]')).toHaveAttribute('data-reserved', '0')
  // NW-1: nothing in the editor's chain is wider than the window or scrolls the page sideways.
  const overflow = await window.evaluate(() => ({
    doc: document.documentElement.scrollWidth - window.innerWidth,
    body: document.body.scrollWidth - window.innerWidth,
    wide: Array.from(document.querySelectorAll('[data-testid="doc-rail"]')).map((el) => {
      let n: HTMLElement | null = el as HTMLElement
      let worst = 0
      while (n && n !== document.body) {
        worst = Math.max(worst, n.getBoundingClientRect().right - window.innerWidth)
        n = n.parentElement
      }
      return worst
    })
  }))
  expect(overflow.doc).toBeLessThanOrEqual(0)
  expect(overflow.body).toBeLessThanOrEqual(0)
  for (const w of overflow.wide) expect(w).toBeLessThanOrEqual(1)
})

test('FP-6 keyboard: arrows, Enter into a folder, Backspace up, type-ahead, ⌘ and ⇧ select', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  const list = window.locator('[data-testid="files-panel-list"]')
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`)).toBeVisible()
  // Click the first row, then walk.
  await window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`).click()
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('ArrowDown')
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.csvId}"]`)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Shift+ArrowUp')
  await expect(window.locator('[data-testid^="files-panel-entry-"][aria-selected="true"]')).toHaveCount(2)
  // Type-ahead to the folder, then Enter opens it.
  await window.keyboard.type('alp')
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Enter')
  await expect(list).toHaveAttribute('data-cwd', seed.folderId)
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.subId}"]`)).toBeVisible()
  await window.locator(`[data-testid="files-panel-entry-${seed.subId}"]`).click()
  await window.keyboard.press('Backspace')
  await expect(list).toHaveAttribute('data-cwd', '')
  // ⌘-click adds to the selection.
  await window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`).click()
  await window.locator(`[data-testid="files-panel-entry-${seed.csvId}"]`).click({ modifiers: ['Meta'] })
  await expect(window.locator('[data-testid^="files-panel-entry-"][aria-selected="true"]')).toHaveCount(2)
  // Search narrows across the whole drive; Esc clears it.
  await window.locator('[data-testid="files-panel-search"]').fill('beta')
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.subId}"]`)).toBeVisible({ timeout: 5_000 })
  await window.locator('[data-testid="files-panel-search"]').press('Escape')
  await expect(window.locator('[data-testid="files-panel-search"]')).toHaveValue('')
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
})

test('FP-7 the panel keeps its folder when Files opens full screen elsewhere', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await window.locator(`[data-testid="files-panel-entry-${seed.folderId}"]`).dblclick()
  await expect(window.locator('[data-testid="files-panel-list"]')).toHaveAttribute('data-cwd', seed.folderId)
  // The full view goes to the root and filters to work widgets (the side menu's
  // Work widgets heading does exactly this): the panel must not follow.
  await window.evaluate(() => {
    const w = window as unknown as { __fbView: { getState: () => { goFiles: () => void } } }
    w.__fbView.getState().goFiles()
  })
  await expect(window.locator('[data-testid="files-view"]')).toBeVisible()
  await window.locator('[data-testid="files-crumb-root"]').click()
  await window.locator('[data-testid="files-type-filter"]').selectOption('widgets').catch(() => undefined)
  await goDesk(window, seed.taskId)
  await expect(window.locator('[data-testid="files-panel-list"]')).toHaveAttribute('data-cwd', seed.folderId)
  await expect(window.locator(`[data-testid="files-panel-entry-${seed.subId}"]`)).toBeVisible()
})

test('FP-8 floating: opens top right, never rises into the title bar, docks', async () => {
  test.setTimeout(120_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await window.locator('[data-testid="files-panel-float"]').click()
  const float = window.locator('[data-testid="files-float"]')
  await expect(float).toBeVisible()
  await expect(window.locator('[data-testid="files-flyout"]')).toHaveCount(0)
  const r0 = (await float.boundingBox())!
  const vw = await window.evaluate(() => window.innerWidth)
  expect(r0.x + r0.width).toBeGreaterThan(vw / 2) // top right
  expect(r0.y).toBeGreaterThanOrEqual(47.5)
  // Drag the header far up and left: it stops below the 40px title bar.
  const h = (await window.locator('[data-testid="files-float-header"]').boundingBox())!
  await window.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await window.mouse.down()
  await window.mouse.move(h.x + h.width / 2 - 200, h.y - 300, { steps: 8 })
  await window.mouse.up()
  const r1 = (await float.boundingBox())!
  expect(r1.y, "the float rose into the title bar").toBeGreaterThanOrEqual(47.5)
  expect(r1.x).toBeLessThan(r0.x)
  // Its z-order puts its buttons on top.
  await window.locator('[data-testid="files-panel-dock"]').click()
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
  await expect(float).toHaveCount(0)
})

for (const theme of ['light', 'dark'] as const) {
  test(`FP-9 the panel paints from the theme (${theme})`, async () => {
    test.setTimeout(120_000)
    const { window, seed } = await boot({ theme })
    await goDesk(window, seed.taskId)
    expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')
    await window.locator('[data-testid="files-panel-toggle"]').click()
    const { bg, ink } = await window.locator('[data-testid="files-flyout"]').evaluate((el) => ({
      bg: getComputedStyle(el).backgroundColor,
      ink: getComputedStyle(el.querySelector('[data-testid^="files-panel-entry-"] span') as Element).color
    }))
    // Any CSS colour (rgb, lab, oklab, color()) → sRGB through a canvas pixel.
    const [bgL, inkL] = await window.evaluate((cs: string[]) => {
      const cv = document.createElement('canvas')
      cv.width = cv.height = 1
      const g = cv.getContext('2d')!
      return cs.map((c) => {
        g.clearRect(0, 0, 1, 1)
        g.fillStyle = '#fff'
        g.fillRect(0, 0, 1, 1)
        g.fillStyle = c
        g.fillRect(0, 0, 1, 1)
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data
        return (0.2126 * r! + 0.7152 * gg! + 0.0722 * b!) / 255
      })
    }, [bg, ink])
    const lum = (c: string): number => (c === bg ? bgL! : inkL!)
    if (theme === 'dark') {
      expect(lum(bg)).toBeLessThan(0.35)
      expect(lum(ink)).toBeGreaterThan(0.6)
    } else {
      expect(lum(bg)).toBeGreaterThan(0.85)
      expect(lum(ink)).toBeLessThan(0.4)
    }
  })
}

test('FP-10 menus opened from the chrome sit ABOVE the flyout (the desk view selector)', async () => {
  test.setTimeout(90_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  await expect(window.locator('[data-testid="files-flyout"]')).toBeVisible()
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  const opt = window.locator('[data-testid="view-opt-workcentre"]')
  await expect(opt).toBeVisible()
  // Hit-tested, not just visible: toBeVisible passes on a covered element.
  const onTop = await opt.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    return !!hit && (hit === el || el.contains(hit))
  })
  expect(onTop, 'the flyout covers the view selector menu').toBe(true)
  await opt.click({ timeout: 5_000 })
  await expect(window.locator('[data-testid="workcentre-view"]')).toBeVisible()
})

test('FP-11 the folder path button opens and closes its menu (a second click closes it)', async () => {
  test.setTimeout(60_000)
  const { window, seed } = await boot()
  await goDesk(window, seed.taskId)
  await window.locator('[data-testid="files-panel-toggle"]').click()
  const path = window.locator('[data-testid="files-panel-path"]')
  await path.click()
  await expect(window.locator('[data-testid="files-panel-path-menu"]')).toBeVisible()
  await expect(path).toHaveAttribute('aria-expanded', 'true')
  await path.click()
  await expect(window.locator('[data-testid="files-panel-path-menu"]')).toHaveCount(0)
  await expect(path).toHaveAttribute('aria-expanded', 'false')
})
