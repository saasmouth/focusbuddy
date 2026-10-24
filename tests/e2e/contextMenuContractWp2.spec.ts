// WP2's right-click menus, by real right-clicks (SPEC §9.3–§9.5): a side-menu
// desk row, a desk in All Desks, a tray tab and a Home card. Each asserts the
// menu as RENDERED (groups between separators, labels, danger rows, roles),
// does what one of its rows says, and is photographed open in light and dark.
// The tray tab — a bespoke popover until now — is also driven by the keyboard:
// arrows, Enter, Escape, and focus back on the tab.

import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, chooseCloudAiSource, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'

test.setTimeout(240_000)
const OUT =
  process.env.CTX_WP2_SHOTS ??
  '/private/tmp/claude-501/-Users-mymac-Desktop-My-Apps-06-Agentic-Starter-Kit--links-/496f07e8-34aa-467c-81bd-e6d13054477c/scratchpad/ctx-menus/wp2'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

interface Rendered {
  groups: string[][]
  danger: string[]
  roles: string[]
}

/** The open root menu as drawn: labels grouped at separators, which rows are danger, every row's role. */
async function rendered(window: Page): Promise<Rendered> {
  const menu = window.locator('[data-canvas-ctx-menu][role="menu"]').first()
  await expect(menu).toBeVisible({ timeout: 5_000 })
  return menu.evaluate((m) => {
    const groups: string[][] = [[]]
    const danger: string[] = []
    const roles: string[] = []
    for (const child of Array.from(m.children)) {
      if (child.getAttribute('role') === 'separator') {
        groups.push([])
        continue
      }
      const b = child.querySelector('button')
      if (!b) continue
      const label = (b.querySelector('span.flex-1')?.childNodes[0]?.textContent ?? '').trim()
      groups[groups.length - 1]!.push(label)
      roles.push(b.getAttribute('role') ?? '')
      if (/text-red-/.test(b.className)) danger.push(label)
    }
    return { groups: groups.filter((g) => g.length), danger, roles }
  })
}

async function shot(window: Page, name: string, theme: string): Promise<void> {
  await window.waitForTimeout(250) // the pop-in animation
  await window.screenshot({ path: `${OUT}/${name}-${theme}.png` })
}

async function closeMenu(window: Page): Promise<void> {
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
}

async function boot(theme: 'light' | 'dark'): Promise<{ window: Page; deskId: string; otherId: string }> {
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  const seed = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Launch plan' })
    const other = await api.nodes.create({ parentId: null, kind: 'task', title: 'Printer quotes' })
    return { deskId: desk.id as string, otherId: other.id as string }
  })
  // A Home with one pinned-desk card, the theme, and no first-run spotlights.
  await window.evaluate(
    ({ t, deskId }) => {
      localStorage.setItem('fb.theme.mode', t)
      localStorage.setItem(
        'home.layout.v3',
        JSON.stringify({ widgets: [{ key: 'k-pin', widget: 'pinned-desk', size: 'md', config: { deskId } }, { key: 'k-agenda', widget: 'agenda', size: 'md' }] })
      )
    },
    { t: theme, deskId: seed.deskId }
  )
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900))
  await window.waitForTimeout(500)
  return { window, ...seed }
}

const go = (window: Page, fn: string, arg?: string): Promise<void> =>
  window.evaluate(
    ({ fn, arg }) => (window as unknown as { __fbView: { getState: () => Record<string, (a?: string) => void> } }).__fbView.getState()[fn]!(arg),
    { fn, arg }
  )

// Owner rulings: E-1 Open then Add to Focus…; E-2 Remove from ‹container› · Archive · Move to Trash.
const DESK_GROUPS = [['Open', 'Add to Focus…', 'Rename', 'Share…'], ['Ask PlexiiAssist'], ['Archive', 'Move to Trash']]

for (const theme of ['light', 'dark'] as const) {
  test(`WP2 menus by real right-click (${theme})`, async () => {
    const { window, deskId, otherId } = await boot(theme)

    // ── A side-menu desk row (Sidebar NavRow): a place; its menu is Open. ──
    await go(window, 'goHome')
    const rooms = window.locator('[data-testid="desk-sidebar"] button.fb-nav-row', { hasText: /^Rooms$/ }).first()
    await expect(rooms).toBeVisible()
    await rooms.click({ button: 'right' })
    const nav = await rendered(window)
    expect(nav.groups).toEqual([['Open']])
    expect(nav.roles).toEqual(['menuitem'])
    await shot(window, 'side-menu-row', theme)
    await window.locator('[data-canvas-ctx-menu] [data-testid="nav-menu-open"]').click()
    await expect.poll(() => window.evaluate(() => (window as unknown as { __fbView: { getState: () => { view: { kind: string } } } }).__fbView.getState().view.kind)).toBe('rooms')

    // ── A desk in All Desks: §9.3 groups, danger last, then Add to Focus… does its job. ──
    await go(window, 'goDesks')
    const card = window.locator(`[data-testid="index-card-${deskId}"]`)
    await expect(card).toBeVisible({ timeout: 8_000 })
    await card.click({ button: 'right' })
    const desk = await rendered(window)
    expect(desk.groups).toEqual(DESK_GROUPS)
    expect(desk.danger).toEqual(['Archive', 'Move to Trash'])
    await shot(window, 'all-desks-desk', theme)
    await window.locator('[data-canvas-ctx-menu] [data-testid="node-menu-focus"]').click()
    await expect(window.locator('[data-testid="capture-console"]')).toBeVisible({ timeout: 5_000 })
    await expect(window.locator('[data-testid="capture-console"]')).toContainText('Launch plan')
    // Escape backs out of the confirm card, then the console.
    for (let i = 0; i < 3 && (await window.locator('[data-testid="capture-console"]').count()) > 0; i++) {
      await window.keyboard.press('Escape')
      await window.waitForTimeout(250)
    }
    await expect(window.locator('[data-testid="capture-console"]')).toHaveCount(0)

    // ── A tray tab: browser wording, close rows last as the placement group. ──
    await go(window, 'goTask', otherId)
    await window.waitForTimeout(600)
    await go(window, 'goTask', deskId)
    await window.waitForTimeout(600)
    const tab = window.locator(`[data-testid="tray-item-task:${otherId}"]`)
    await expect(tab).toBeVisible({ timeout: 8_000 })
    await tab.click({ button: 'right' })
    const tray = await rendered(window)
    expect(tray.groups).toEqual([['Pin tab'], ['Close tab', 'Close other tabs', 'Close all tabs']])
    expect(tray.danger).toEqual(['Close tab', 'Close other tabs', 'Close all tabs'])
    await shot(window, 'tray-tab', theme)
    await closeMenu(window)

    // ── A Home card: Open · Choose another… · Size ▸ | Ask PlexiiAssist | Remove from Home. ──
    await go(window, 'goHome')
    const pin = window.locator('[data-widget-key="k-pin"]')
    await expect(pin).toBeVisible({ timeout: 8_000 })
    await pin.click({ button: 'right', position: { x: 12, y: 12 } })
    const home = await rendered(window)
    expect(home.groups).toEqual([['Open', 'Choose another…', 'Size'], ['Ask PlexiiAssist'], ['Remove from Home']])
    expect(home.danger).toEqual(['Remove from Home'])
    // The size submenu shows the current size as checked (menuitemcheckbox), not as text.
    await window.locator('[data-canvas-ctx-menu] [data-testid="home-card-menu-size"]').hover()
    const medium = window.locator('[data-canvas-ctx-menu] [data-testid="home-card-menu-size-md"]')
    await expect(medium).toHaveAttribute('role', 'menuitemcheckbox')
    await expect(medium).toHaveAttribute('aria-checked', 'true')
    await shot(window, 'home-card', theme)
    await window.locator('[data-canvas-ctx-menu] [data-testid="home-card-menu-open"]').first().click()
    await expect.poll(() => window.evaluate(() => (window as unknown as { __fbView: { getState: () => { view: { kind: string; taskId?: string } } } }).__fbView.getState().view)).toEqual({ kind: 'task', taskId: deskId })

    // Remove from Home takes the card off, and only that card.
    await go(window, 'goHome')
    await expect(pin).toBeVisible({ timeout: 8_000 })
    await pin.click({ button: 'right', position: { x: 12, y: 12 } })
    await window.locator('[data-canvas-ctx-menu] [data-testid="home-card-menu-remove"]').click()
    await expect(pin).toHaveCount(0)
    await expect(window.locator('[data-widget-key="k-agenda"]')).toBeVisible()
  })
}

test('WP2 tray tab menu by keyboard: arrows, Enter, Escape, focus back on the tab', async () => {
  const { window, deskId, otherId } = await boot('light')
  await go(window, 'goTask', otherId)
  await window.waitForTimeout(600)
  await go(window, 'goTask', deskId)
  await window.waitForTimeout(600)
  const tab = window.locator(`[data-testid="tray-item-task:${otherId}"]`)
  await expect(tab).toBeVisible({ timeout: 8_000 })

  // Open by right-click; the menu takes focus.
  await tab.click({ button: 'right' })
  const menu = window.locator('[data-canvas-ctx-menu][role="menu"]').first()
  await expect(menu).toBeFocused()
  // Home lands on the first row; ArrowDown moves to the next; ArrowUp back.
  const active = (): Promise<string> =>
    menu.evaluate((m) => {
      const b = Array.from(m.querySelectorAll('button')).find((x) => x.className.split(/\s+/).includes('bg-[var(--surface-sunken)]'))
      return (b?.querySelector('span.flex-1')?.childNodes[0]?.textContent ?? '').trim()
    })
  // The menu may open under the pointer, and hovering a row highlights it;
  // park the pointer, then drive by keys only. Home lands on the first row.
  await window.mouse.move(5, 5)
  await window.keyboard.press('Home')
  expect(await active()).toBe('Pin tab')
  await window.keyboard.press('ArrowDown')
  expect(await active()).toBe('Close tab')
  await window.keyboard.press('ArrowUp')
  expect(await active()).toBe('Pin tab')
  // Enter runs it: the tab is pinned.
  await window.keyboard.press('Enter')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
  await expect
    .poll(() =>
      window.evaluate(
        (k) => (window as unknown as { __fbOpenTray?: { getState: () => { entries: Array<{ key: string; pinned?: boolean }> } } }).__fbOpenTray?.getState().entries.find((e) => e.key === k)?.pinned ?? null,
        `task:${otherId}`
      )
    )
    .toBe(true)
  await expect(tab, 'focus is back on the tab after the menu ran').toBeFocused()

  // Reopen: it now says Unpin tab. Escape closes it and focus returns to the tab.
  await tab.click({ button: 'right' })
  expect((await rendered(window)).groups[0]).toEqual(['Unpin tab'])
  await window.keyboard.press('Escape')
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
  await expect(tab).toBeFocused()
  // And it no longer closes when the pointer wanders off (the old popover did).
  await tab.click({ button: 'right' })
  await window.mouse.move(5, 5)
  await window.waitForTimeout(300)
  await expect(window.locator('[data-canvas-ctx-menu][role="menu"]')).toHaveCount(1)
  await window.keyboard.press('Escape')
})
