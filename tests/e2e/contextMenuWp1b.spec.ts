// WP1b: work widget BODY menus on the context-menu kit (SPEC §9.3–§9.5).
//
// Real right-clicks (Playwright's click({ button: 'right' }) on the real
// element, no synthetic dispatch) on the surfaces that had bespoke menus: the
// table's column header (no keyboard, no portal: it sat fixed-position inside
// the zoomed canvas) and the speed deck's tile and background menus (dark-only
// colours, hints for keys that were not bound). Asserts the rendered groups,
// separators and danger colour, the keyboard and focus return, the portal at
// zoom ≠ 1, the tile's keys, and that a right-click on text is left to the text
// menu. Screenshots of each menu, light and dark, go to the WP1b scratch folder.

import { mkdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

const OUT =
  process.env.CTX_MENU_SHOTS ??
  '/private/tmp/claude-501/-Users-mymac-Desktop-My-Apps-06-Agentic-Starter-Kit--links-/496f07e8-34aa-467c-81bd-e6d13054477c/scratchpad/ctx-menus/wp1b'
mkdirSync(OUT, { recursive: true })

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
  tableWidgetId: string
  deckWidgetId: string
  noteWidgetId: string
}

async function seed(window: Page): Promise<Seed> {
  return window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Body menus' })
    const table = await api.tables.create({
      title: 'Launch list',
      schema: {
        columns: [
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          { id: 'c-owner', type: 'text-short', label: 'Owner', config: {} },
          { id: 'c-done', type: 'checkbox', label: 'Done', config: {} }
        ]
      }
    })
    await api.tables.createRow({ tableId: table.id, cells: { 'c-name': 'Pricing page', 'c-owner': 'Ana', 'c-done': false } })
    const tableWidget = await api.widgets.create({
      taskId: task.id,
      kind: 'table',
      title: 'Launch list',
      content: table.id,
      x: 60,
      y: 60,
      width: 600,
      height: 260
    })
    const rootPageId = 'pg-home'
    const deck = {
      scope: 'task',
      taskDeck: {
        _version: 1,
        rootPageId,
        pages: {
          [rootPageId]: {
            id: rootPageId,
            name: 'Home',
            buttons: {
              0: {
                id: 'btn-launch',
                kind: 'action',
                label: 'Launch',
                style: { icon: 'rocket_launch', color: '#8b5cf6' },
                action: { type: 'open-url', url: 'https://example.com' }
              }
            }
          }
        },
        settings: { defaultSound: 'silent', defaultHaptic: 'none', glow: 0.6 }
      }
    }
    const deckWidget = await api.widgets.create({
      taskId: task.id,
      kind: 'streamdeck',
      title: 'SpeedDeck',
      content: JSON.stringify(deck),
      x: 700,
      y: 60,
      width: 640,
      height: 300
    })
    const note = await api.widgets.create({
      taskId: task.id,
      kind: 'note',
      title: '',
      content: 'Read me, then right-click me.',
      x: 60,
      y: 360,
      width: 380,
      height: 200
    })
    return { taskId: task.id, tableId: table.id, tableWidgetId: tableWidget.id, deckWidgetId: deckWidget.id, noteWidgetId: note.id }
  })
}

async function openDesk(l: LaunchedApp, theme: 'light' | 'dark'): Promise<Seed> {
  const { window, app } = l
  await waitForReady(window)
  const s = await seed(window)
  await suppressFeatureSpotlights(window)
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Body menus/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8_000 })
  await window.waitForSelector(`[data-widget-id="${s.tableWidgetId}"] [data-testid="table-col-title-1"]`, { timeout: 10_000 })
  await window.waitForSelector(`[data-widget-id="${s.deckWidgetId}"] [data-speeddeck-slot="0"]`, { timeout: 10_000 })
  return s
}

interface Rendered {
  groups: string[][]
  danger: string[]
  shortcuts: Record<string, string>
  disabled: Record<string, string>
  checked: Record<string, boolean>
}

/** The open root menu as a person sees it: groups split at separators, plus each row's state. */
async function renderedMenu(window: Page): Promise<Rendered> {
  const menu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(menu).toBeVisible({ timeout: 4_000 })
  return menu.evaluate((el) => {
    const out = { groups: [[]] as string[][], danger: [] as string[], shortcuts: {} as Record<string, string>, disabled: {} as Record<string, string>, checked: {} as Record<string, boolean> }
    for (const child of Array.from(el.children)) {
      if (child.getAttribute('role') === 'separator') {
        out.groups.push([])
        continue
      }
      const btn = child.querySelector(':scope > button')
      if (!btn) continue
      const labelSpan = btn.querySelector('span.flex-1') as HTMLElement
      const label = (labelSpan.childNodes[0]?.textContent ?? '').trim()
      out.groups[out.groups.length - 1]!.push(label)
      if (/text-red-/.test(btn.className)) out.danger.push(label)
      const kbd = btn.querySelector('span.font-mono')
      if (kbd) out.shortcuts[label] = (kbd.textContent ?? '').trim()
      if (btn.getAttribute('aria-disabled') === 'true') out.disabled[label] = (labelSpan.querySelector('span')?.textContent ?? '').trim()
      if (btn.getAttribute('role') === 'menuitemcheckbox') out.checked[label] = btn.getAttribute('aria-checked') === 'true'
    }
    out.groups = out.groups.filter((g) => g.length)
    return out
  })
}

async function closeMenu(window: Page): Promise<void> {
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
}

const TABLE_HEADER_GROUPS = [
  ['Insert column left', 'Insert column right', 'Move column left', 'Move column right', 'Edit column…', 'Group rows by this column'],
  ['Delete column']
]

for (const theme of ['light', 'dark'] as const) {
  test(`WP1b-1 (${theme}) — table column header: real right-click opens the kit menu with §9.3 groups`, async () => {
    launched = await launchApp()
    const { window } = launched
    const s = await openDesk(launched, theme)
    const th = window.locator(`[data-widget-id="${s.tableWidgetId}"] thead th[data-col-index="1"]`)
    await th.click({ button: 'right' })
    const m = await renderedMenu(window)
    expect(m.groups).toEqual(TABLE_HEADER_GROUPS)
    expect(m.danger).toEqual(['Delete column'])
    expect(m.checked).toEqual({ 'Group rows by this column': false })
    await window.screenshot({ path: `${OUT}/table-header-${theme}.png` })
    // The type picker is a real submenu now (it swapped the panel's contents).
    await window.locator('[data-testid="table-col-insert-left"]').hover()
    await expect(window.locator('[data-testid="table-col-insert-left-number"]')).toBeVisible({ timeout: 3_000 })
    for (const m of await window.locator('[data-canvas-ctx-menu]').all()) await m.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
    await window.screenshot({ path: `${OUT}/table-header-insert-submenu-${theme}.png` })
    await closeMenu(window)
  })

  test(`WP1b-2 (${theme}) — speed-deck tile and background: real right-clicks, §9.3 groups, bound hints only`, async () => {
    launched = await launchApp()
    const { window } = launched
    const s = await openDesk(launched, theme)
    const deck = window.locator(`[data-widget-id="${s.deckWidgetId}"]`)
    // Outside edit mode (it used to be silent there).
    await deck.locator('[data-speeddeck-slot="0"]').click({ button: 'right' })
    const tile = await renderedMenu(window)
    expect(tile.groups).toEqual([['Configure…'], ['Cut', 'Copy', 'Paste', 'Duplicate'], ['Delete']])
    expect(tile.danger).toEqual(['Delete'])
    expect(tile.shortcuts).toEqual({ Cut: '⌘X', Copy: '⌘C', Paste: '⌘V', Duplicate: '⌘D' })
    expect(tile.disabled).toEqual({ Paste: 'Cut or copy a button first' })
    await window.screenshot({ path: `${OUT}/speeddeck-tile-${theme}.png` })
    await closeMenu(window)

    // The background (not a tile): the deck's actions, Reset deck… last.
    await deck.locator('[data-speeddeck-root] span', { hasText: /^SpeedDeck$/ }).click({ button: 'right' })
    const bg = await renderedMenu(window)
    expect(bg.groups).toEqual([
      ['Edit buttons', 'Copy deck JSON', 'Export deck to file…', 'Import deck from file…', 'Accessibility permission…'],
      ['Reset deck…']
    ])
    expect(bg.danger).toEqual(['Reset deck…'])
    expect(bg.checked).toEqual({ 'Edit buttons': false })
    await window.screenshot({ path: `${OUT}/speeddeck-background-${theme}.png` })
    await closeMenu(window)
  })
}

test('WP1b-3 — table header menu: keyboard, focus return, keyboard opening, and an action by key', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await openDesk(launched, 'light')
  const title = window.locator(`[data-widget-id="${s.tableWidgetId}"] [data-testid="table-col-title-1"]`)
  await window.locator(`[data-widget-id="${s.tableWidgetId}"] thead th[data-col-index="1"]`).click({ button: 'right' })
  const menu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(menu).toBeVisible()
  // The menu has focus; arrows move the highlight.
  expect(await menu.evaluate((el) => el === document.activeElement)).toBe(true)
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('ArrowDown')
  await expect(menu.locator('button.bg-\\[var\\(--surface-sunken\\)\\]')).toContainText('Insert column right')
  // Escape closes, and focus goes back to the column's title (the invoker).
  await closeMenu(window)
  await expect(title).toBeFocused()

  // The keyboard's own right-click (Shift+F10) on the focused title opens it.
  await title.press('Shift+F10')
  await expect(menu).toBeVisible()
  // Down four times: Insert left, Insert right, Move left, Move right. Enter.
  for (let i = 0; i < 4; i++) await window.keyboard.press('ArrowDown')
  await expect(menu.locator('button.bg-\\[var\\(--surface-sunken\\)\\]')).toContainText('Move column right')
  await window.keyboard.press('Enter')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
  await expect
    .poll(async () =>
      window.evaluate(async (tid) => {
        const api = (window as unknown as { api: typeof window.api }).api
        return ((await api.tables.get(tid))?.schema.columns ?? []).map((c: { label: string }) => c.label)
      }, s.tableId)
    )
    .toEqual(['Name', 'Done', 'Owner'])
})

test('WP1b-4 — at zoom ≠ 1 the header menu is portalled: not scaled, not clipped, at the pointer', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await openDesk(launched, 'light')
  const th = window.locator(`[data-widget-id="${s.tableWidgetId}"] thead th[data-col-index="0"]`)

  // The menu's row height at zoom 1, for comparison.
  await th.click({ button: 'right' })
  await window.locator('[data-canvas-ctx-menu]').first().evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const rowAt1 = await window.locator('[data-canvas-ctx-menu] [data-testid="table-col-edit"]').boundingBox()
  await closeMenu(window)

  await window.evaluate(() => {
    const w = window as unknown as { __fbWidgets?: { getState: () => { setZoom: (n: number) => void } } }
    w.__fbWidgets?.getState().setZoom(1.6)
  })
  await window.waitForTimeout(400)
  const box = (await th.boundingBox())!
  const point = { x: Math.round(box.x + 20), y: Math.round(box.y + box.height / 2) }
  await window.mouse.click(point.x, point.y, { button: 'right' })
  const menu = window.locator('[data-canvas-ctx-menu]').first()
  await expect(menu).toBeVisible()
  // Measure after the pop-in (a short scale animation of the menu itself).
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))
  const geo = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const centre = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    let transformed = false
    // Ancestors only: the menu's own pop-in animation is a transform of itself.
    for (let p: Element | null = el.parentElement; p; p = p.parentElement) if (getComputedStyle(p).transform !== 'none') transformed = true
    return {
      parentIsBody: el.parentElement === document.body,
      transformed,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
      centreInside: !!centre && el.contains(centre)
    }
  })
  expect(geo.parentIsBody, 'portalled to the body').toBe(true)
  expect(geo.transformed, 'no scaled ancestor').toBe(false)
  expect(Math.abs(geo.left - point.x), `left ${geo.left} vs pointer ${point.x}`).toBeLessThanOrEqual(2)
  expect(Math.abs(geo.top - point.y), `top ${geo.top} vs pointer ${point.y}`).toBeLessThanOrEqual(2)
  expect(geo.right <= geo.vw && geo.bottom <= geo.vh && geo.left >= 0 && geo.top >= 0, 'inside the window').toBe(true)
  expect(geo.centreInside, 'nothing covers it').toBe(true)
  const rowAtZoom = await window.locator('[data-canvas-ctx-menu] [data-testid="table-col-edit"]').boundingBox()
  expect(Math.abs(rowAtZoom!.height - rowAt1!.height), 'rows are not scaled with the canvas').toBeLessThanOrEqual(0.5)
  await window.screenshot({ path: `${OUT}/table-header-zoom160-light.png` })
  await closeMenu(window)
})

test('WP1b-5 — speed-deck tile keys are bound (⌘C, ⌘V, ⌘D) and focus returns to the tile', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await openDesk(launched, 'light')
  const deck = window.locator(`[data-widget-id="${s.deckWidgetId}"]`)
  const launchTiles = deck.locator('[data-speeddeck-slot][title^="Launch"]')
  await expect(launchTiles).toHaveCount(1)

  const tile0 = deck.locator('[data-speeddeck-slot="0"]')
  await tile0.click({ button: 'right' })
  await closeMenu(window)
  await expect(tile0, 'focus returns to the tile').toBeFocused()

  // ⌘D duplicates into the first free slot.
  await window.keyboard.press('Meta+d')
  await expect(launchTiles).toHaveCount(2)
  // ⌘C, then Paste from the menu of an empty slot (now enabled), and ⌘V on another.
  await tile0.focus()
  await window.keyboard.press('Meta+c')
  await deck.locator('[data-speeddeck-slot="5"]').click({ button: 'right' })
  const empty = await renderedMenu(window)
  expect(empty.groups).toEqual([['Add button…', 'New folder here'], ['Paste']])
  expect(empty.disabled).toEqual({})
  await window.locator('[data-testid="speeddeck-menu-paste"]').click()
  await expect(launchTiles).toHaveCount(3)
  await deck.locator('[data-speeddeck-slot="7"]').focus()
  await window.keyboard.press('Meta+v')
  await expect(launchTiles).toHaveCount(4)
})

test('WP1b-6 — text is the text menu’s: a cell being edited and a note’s textarea are not taken', async () => {
  launched = await launchApp()
  const { window } = launched
  const s = await openDesk(launched, 'light')
  const table = window.locator(`[data-widget-id="${s.tableWidgetId}"]`)
  const ctx = window.locator('[data-canvas-ctx-menu]')

  // A cell that is not being edited is an object: the cell menu.
  const ownerInput = table.locator('input[value="Ana"]')
  await ownerInput.click({ button: 'right' })
  await expect(ctx.first()).toBeVisible()
  await closeMenu(window)
  // The row's handle, never text, always opens the row's menu.
  await table.locator('[data-testid="table-row-handle-0"]').click({ button: 'right' })
  await expect(ctx.first()).toBeVisible()
  await closeMenu(window)
  // Off the canvas's edge-pan band (the handle sits near the window's left edge).
  await window.mouse.move(720, 450)
  // A cell being edited is text: nothing of ours opens (main's text menu does, WP3).
  await ownerInput.click()
  await expect(ownerInput).toBeFocused()
  await ownerInput.click({ button: 'right' })
  await window.waitForTimeout(600)
  await expect(ctx).toHaveCount(0)
  await window.keyboard.press('Escape')

  // A note being read opens its work widget menu (it did nothing before).
  const note = window.locator(`[data-widget-id="${s.noteWidgetId}"]`)
  await note.locator('.fb-note-rendered').click({ button: 'right' })
  await expect(ctx.first()).toBeVisible()
  await window.screenshot({ path: `${OUT}/note-read-mode-light.png` })
  await closeMenu(window)
  // Its editing textarea is text.
  await note.locator('.fb-note-rendered').click()
  const ta = note.locator('textarea')
  await expect(ta).toBeVisible()
  await ta.click({ button: 'right' })
  await window.waitForTimeout(600)
  await expect(ctx).toHaveCount(0)
})
