// WP1a, the desk's right-click menus on the menu contract (SPEC §9.3–§9.5), with
// REAL right-clicks: the empty canvas, a sticky's header, a gallery's body (it
// used to do nothing at all, AUDIT §1.3), the section handle, a menu opened on
// a zoomed canvas, and the keyboard with focus return on the jump list (which
// had no menu: right-click used to start a rename, E-11).
//
// Each menu open is photographed in light and dark for review; the screenshots
// go to CTX_SHOTS when it is set (the WP1a hand-over), and nowhere otherwise.

import { test, expect, type Page } from '@playwright/test'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { launchApp, waitForReady, renderedMenuGroups, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

const SHOTS = process.env.CTX_SHOTS
async function shot(window: Page, name: string): Promise<void> {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await window.screenshot({ path: join(SHOTS, `${name}.png`) })
}

interface Seeded {
  taskId: string
  sticky: string
  gallery: string
  section: string
}

/** One desk: a sticky (a work widget file), a gallery, an empty section; opened in `theme`. */
async function openSeededDesk(window: Page, theme: 'light' | 'dark'): Promise<Seeded> {
  const seeded = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Menu contract desk' })
    const sticky = await api.widgets.create({ taskId: d.id, kind: 'sticky', title: 'Plan', content: 'Buy milk', x: 120, y: 120, width: 260, height: 200 })
    // A sticky is a work widget file once promoted: its menu then names both removals (E-2).
    await api.widgetFiles.promote(sticky.id)
    const gallery = await api.widgets.create({ taskId: d.id, kind: 'gallery', title: 'Photos', content: '', x: 460, y: 120, width: 320, height: 240 })
    const section = await api.widgets.create({ taskId: d.id, kind: 'section', title: 'Ideas', content: '', x: 120, y: 460, width: 420, height: 260 })
    return { taskId: d.id, sticky: sticky.id, gallery: gallery.id, section: section.id }
  })
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (x: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, seeded.taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
  await window.waitForSelector(`[data-widget-id="${seeded.gallery}"]`, { timeout: 10_000 })
  expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')
  await window.waitForTimeout(400)
  return seeded
}

async function closeMenu(window: Page): Promise<void> {
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
}

/** A point on bare desk (the target carries data-bare-canvas), found by probing. */
async function bareCanvasPoint(window: Page): Promise<{ x: number; y: number }> {
  return window.evaluate(() => {
    const s = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const r = s.getBoundingClientRect()
    for (let fy = 0.8; fy > 0.15; fy -= 0.05) {
      for (let fx = 0.8; fx > 0.15; fx -= 0.05) {
        const x = r.left + r.width * fx
        const y = r.top + r.height * fy
        const el = document.elementFromPoint(x, y) as HTMLElement | null
        if (el && el.dataset.bareCanvas !== undefined) return { x, y }
      }
    }
    throw new Error('no bare desk to right-click')
  })
}

/**
 * E-1 (owner ruling): an object's Open row leads and Add to Focus… follows. A
 * work widget file's instance has "Open file"; a desk-only one has no Open row
 * and Add to Focus… leads. (The launch backfill may file a widget made through
 * the API, so the spec accepts either, and checks the order when Open is there.)
 */
function expectObjectLead(firstGroup: string[] | undefined): void {
  expect(firstGroup).toBeDefined()
  if (firstGroup![0] === 'Open file') expect(firstGroup![1]).toBe('Add to Focus…')
  else expect(firstGroup![0]).toBe('Add to Focus…')
}

const menu = (window: Page) => window.locator('[data-canvas-ctx-menu]').first()

/** Every destructive row is drawn in the danger colour, and nothing else is. */
async function dangerColour(window: Page): Promise<{ danger: string; plain: string }> {
  return menu(window).evaluate((m) => {
    const rows = Array.from(m.querySelectorAll(':scope > div > button')) as HTMLElement[]
    const d = rows.find((r) => r.className.includes('text-red-600'))
    const p = rows.find((r) => !r.className.includes('text-red-600') && !r.hasAttribute('disabled'))
    return { danger: d ? getComputedStyle(d).color : '', plain: p ? getComputedStyle(p).color : '' }
  })
}

for (const theme of ['light', 'dark'] as const) {
  test(`WP1A-1 — ${theme}: empty canvas, sticky header, gallery body and section handle, on the contract`, async () => {
    test.setTimeout(120_000)
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    const s = await openSeededDesk(window, theme)
    const mac = (await window.evaluate(() => (window as unknown as { api: { platform: string } }).api.platform)) === 'darwin'
    const key = (m: string, o: string): string => (mac ? m : o)

    // ── Empty canvas: Paste · Insert snippet… | Add object | Select all | view rows
    const bare = await bareCanvasPoint(window)
    await window.mouse.click(bare.x, bare.y, { button: 'right' })
    await expect(menu(window)).toBeVisible()
    const canvas = await renderedMenuGroups(window)
    expect(canvas.groups).toEqual([
      ['Paste', 'Insert snippet…'],
      ['Add object'],
      ['Select all'],
      ['Home — fit all to view', 'Reset view', 'Auto-arrange', "Customise this device's layout"]
    ])
    await expect(menu(window).getByTestId('canvas-ctx-paste')).toContainText(key('⌘V', 'Ctrl+V'))
    await expect(menu(window).getByRole('menuitemcheckbox', { name: /Customise this device's layout/ })).toHaveAttribute('aria-checked', 'false')
    await shot(window, `empty-canvas-${theme}`)
    await closeMenu(window)

    // ── Sticky header: Add to Focus… first, the kind row, clipboard, Plexii, More, E-2 rows
    await window.locator(`[data-widget-id="${s.sticky}"] [data-widget-header]`).click({ button: 'right', position: { x: 60, y: 10 } })
    await expect(menu(window)).toBeVisible()
    const sticky = await renderedMenuGroups(window)
    // Promoted to a file above, so its Open row leads (E-1).
    expect(sticky.groups[0]?.slice(0, 2)).toEqual(['Open file', 'Add to Focus…'])
    expect(sticky.groups.at(-1)).toEqual(['Remove from this desk', 'Archive', 'Move to Trash'])
    expect(sticky.danger).toEqual(['Remove from this desk', 'Archive', 'Move to Trash'])
    expect(sticky.groups.flat()).toContain('More actions')
    expect(sticky.groups.flat()).toContain('Paste')
    // The ceiling (E-6): at most eight rows above the destructive group.
    expect(sticky.groups.slice(0, -1).flat().length).toBeLessThanOrEqual(8)
    const colours = await dangerColour(window)
    expect(colours.danger).not.toBe('')
    expect(colours.danger).not.toBe(colours.plain)
    // More actions opens on hover and holds the rest, e.g. Make this a desk….
    await menu(window).getByRole('menuitem', { name: 'More actions' }).hover()
    await expect(window.locator('[data-canvas-ctx-menu]').nth(1).getByRole('menuitem', { name: 'Make this a desk…' })).toBeVisible()
    await shot(window, `sticky-header-${theme}`)
    await closeMenu(window)

    // ── Gallery BODY (previously silent): the same menu as its header
    const galleryBody = window.locator(`[data-widget-id="${s.gallery}"] [data-widget-body]`)
    await galleryBody.click({ button: 'right', position: { x: 120, y: 120 } })
    await expect(menu(window)).toBeVisible()
    const body = await renderedMenuGroups(window)
    expectObjectLead(body.groups[0])
    expect(body.danger).toContain('Archive')
    await shot(window, `gallery-body-${theme}`)
    await closeMenu(window)
    await window.locator(`[data-widget-id="${s.gallery}"] [data-widget-header]`).click({ button: 'right', position: { x: 60, y: 10 } })
    await expect(menu(window)).toBeVisible()
    expect((await renderedMenuGroups(window)).groups).toEqual(body.groups)
    await closeMenu(window)

    // ── Section handle: the resolver's menu (S1 was hand-built)
    await window.locator(`[data-widget-id="${s.section}"] .section-handle`).click({ button: 'right' })
    await expect(menu(window)).toBeVisible()
    const section = await renderedMenuGroups(window)
    expect(section.groups).toEqual([
      ['Add to Focus…', 'Section layout', 'Rename', 'Share…'],
      ['Duplicate, empty'],
      ['Bring to front'],
      ['Make this a desk…'],
      ['Archive']
    ])
    expect(section.danger).toEqual(['Archive'])
    await menu(window).getByRole('menuitem', { name: 'Section layout' }).hover()
    // The current layout is a checked row, not a " ✓" in the label (F-13).
    await expect(window.locator('[data-canvas-ctx-menu]').nth(1).getByRole('menuitemcheckbox', { name: 'Free' })).toHaveAttribute('aria-checked', 'true')
    await shot(window, `section-handle-${theme}`)
    await closeMenu(window)
  })
}

test('WP1A-2 — on a zoomed canvas the menu is not scaled or clipped', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  const s = await openSeededDesk(window, 'light')
  await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { setZoom: (z: number) => void } } }
    w.__fbWidgets?.getState().setZoom(1.6)
  })
  await window.waitForTimeout(400)
  const header = window.locator(`[data-widget-id="${s.sticky}"] [data-widget-header]`)
  const hb = await header.boundingBox()
  expect(hb, 'the header is on screen').not.toBeNull()
  await window.mouse.click(hb!.x + 40, hb!.y + hb!.height / 2, { button: 'right' })
  await expect(menu(window)).toBeVisible()
  await window.waitForTimeout(400)
  const geo = await menu(window).evaluate((m) => {
    const r = m.getBoundingClientRect()
    const row = m.querySelector(':scope > div > button') as HTMLElement
    // Drawn at its layout size: no ancestor scale() reaches it (the menu's own
    // pop-in animation has finished by now; its ancestors are body and html).
    const scaled = Math.abs(r.width / (m as HTMLElement).offsetWidth - 1) > 0.01
    let el: Element | null = m.parentElement
    let ancestorTransform = false
    while (el) {
      const t = getComputedStyle(el).transform
      if (t && t !== 'none') ancestorTransform = true
      el = el.parentElement
    }
    return { w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom, rowH: row.getBoundingClientRect().height, vw: innerWidth, vh: innerHeight, inBody: m.parentElement === document.body, scaled, ancestorTransform }
  })
  // Portalled to the body, outside the canvas's scale(), at its natural size.
  expect(geo.inBody).toBe(true)
  expect(geo.scaled).toBe(false)
  expect(geo.ancestorTransform).toBe(false)
  expect(geo.rowH).toBeLessThan(40)
  expect(geo.w).toBeGreaterThanOrEqual(209.5) // the kit's min-w-[210px], at its natural size
  expect(geo.w).toBeLessThan(420)
  expect(geo.left).toBeGreaterThanOrEqual(0)
  expect(geo.top).toBeGreaterThanOrEqual(0)
  expect(geo.right).toBeLessThanOrEqual(geo.vw)
  expect(geo.bottom).toBeLessThanOrEqual(geo.vh)
  await shot(window, 'sticky-header-zoom-1.6-light')
  await closeMenu(window)
})

test('WP1A-3 — keyboard: arrows move, Escape closes, focus returns to the jump list row (E-11)', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await window.setViewportSize({ width: 1440, height: 900 })
  const s = await openSeededDesk(window, 'light')
  await window.locator('[data-minimap-fab]').hover()
  const list = window.locator('[data-testid="desk-jump-list"]')
  await expect(list).toBeVisible({ timeout: 4_000 })
  const row = window.locator(`[data-testid="desk-jump-${s.gallery}"]`)
  await row.focus()
  await row.click({ button: 'right' })
  await expect(menu(window)).toBeVisible()
  const groups = await renderedMenuGroups(window)
  expect(groups.groups[0]?.slice(0, 2)).toEqual(['Rename', 'Show on the canvas'])
  expectObjectLead(groups.groups[0]?.slice(2))
  // The menu holds the list open even though it sits outside the minimap.
  await expect(list).toBeVisible()
  await shot(window, 'jump-list-row-light')
  // The panel has focus; Home and the arrows move the highlight. (The pointer
  // may sit on a row of the menu that opened under it, so start from Home.)
  await window.keyboard.press('Home')
  await window.keyboard.press('ArrowDown')
  const active = await menu(window).evaluate((m) => {
    const rows = Array.from(m.querySelectorAll(':scope > div > button')) as HTMLElement[]
    return rows.findIndex((r) => r.className.includes('bg-[var(--surface-sunken)]') && !r.className.includes('hover:'))
  })
  expect(active).toBe(1)
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
  expect(await row.evaluate((el) => el === document.activeElement), 'focus is back on the row').toBe(true)
})
