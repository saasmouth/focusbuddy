import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { launchApp, waitForReady, suppressFeatureSpotlights, grantCapability, type LaunchedApp } from './_helpers'

// The owner's Plexii icon set, second pass (4.3.41, "every icon, system
// wide"): the surfaces beyond the side menu — Office home, Documents, Recent,
// Suite, search, the app empty states — wear the set, every <img> decodes,
// and the logo is the approved purple one, reversed on dark. Light and dark;
// screenshots go to SHOTS for the owner.
//
// Third pass (the 22 Oct 2026 delivery): the nine Suite product tiles, the
// Office library's Recent / Starred / Templates / Trash, the People area head,
// the Home action tiles (New desk, Discover, Transcribe, Focus timer) on the
// neutral lit surface instead of their old gradients, and the onboarding tour
// modules in the forced-dark tour hub.

const SHOTS = process.env.PLEXII_ICON_SHOTS ?? '/private/tmp/claude-501/icons-everywhere-shots'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

async function go(window: Page, fn: string, ...args: unknown[]): Promise<void> {
  await window.evaluate(
    ([f, a]) => {
      const w = window as unknown as { __fbView?: { getState: () => Record<string, (...x: unknown[]) => void> } }
      w.__fbView?.getState()[f as string]?.(...(a as unknown[]))
    },
    [fn, args] as const
  )
  await window.waitForTimeout(700)
}

/** Every Plexii <img> decoded and every glyph mask file loads; returns the entity ids seen. */
async function plexiiImages(window: Page): Promise<{ ids: string[]; broken: string[] }> {
  await window.waitForFunction(
    () => Array.from(document.querySelectorAll<HTMLImageElement>('img[data-plexii-icon]')).every((i) => i.complete),
    undefined,
    { timeout: 10_000 }
  )
  return window.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[data-plexii-icon]'))
    // Single-colour tool glyphs are CSS masks on a <span>: load each mask file.
    const glyphs = Array.from(document.querySelectorAll<HTMLElement>('span[data-plexii-style="glyph"]'))
    const brokenGlyphs: string[] = []
    for (const g of glyphs) {
      const url = g.dataset.plexiiSrc ?? ''
      const ok = await new Promise<boolean>((res) => {
        const im = new Image()
        im.onload = () => res(im.naturalWidth > 0)
        im.onerror = () => res(false)
        im.src = url
      })
      if (!ok) brokenGlyphs.push(`${g.dataset.plexiiIcon} ${url}`)
    }
    return {
      ids: [...new Set([...imgs, ...glyphs].map((i) => i.dataset.plexiiIcon ?? ''))],
      broken: [...imgs.filter((i) => !(i.naturalWidth > 0)).map((i) => `${i.dataset.plexiiIcon} ${i.currentSrc}`), ...brokenGlyphs]
    }
  })
}

async function surface(window: Page, theme: string, name: string, expectIds: string[]): Promise<void> {
  const { ids, broken } = await plexiiImages(window)
  expect(broken, `${name}: broken icons`).toEqual([])
  for (const id of expectIds) expect(ids, `${name}: expected ${id} among ${ids.join(', ')}`).toContain(id)
  await window.screenshot({ path: `${SHOTS}/${theme}-${name}.png` })
}

for (const theme of ['light', 'dark'] as const) {
  test(`Plexii icons on the wider surfaces, and the approved logo (${theme})`, async () => {
    test.setTimeout(180_000)
    mkdirSync(SHOTS, { recursive: true })
    launched = await launchApp({ extraArgs: ['--force-device-scale-factor=2'] })
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.evaluate((m) => localStorage.setItem('fb.theme.mode', m), theme)
    // Real documents of four types, so lists have rows to wear app icons.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: { documents: { create: (d: { docType: string; title: string }) => Promise<unknown> } } }).api
      for (const [docType, title] of [
        ['doc', 'Launch brief'],
        ['sheet', 'Budget'],
        ['slides', 'Board deck'],
        ['map', 'Onboarding flow']
      ]) {
        await api.documents.create({ docType, title })
      }
    })
    // The Home action tiles, at both of their sizes, so Home shows all four.
    await window.evaluate(() => {
      const w = (widget: string, size: string): { key: string; widget: string; size: string } => ({ key: `${widget}:${size}`, widget, size })
      localStorage.setItem(
        'home.layout.v3',
        JSON.stringify({
          widgets: [
            w('new-desk', 'icon'),
            w('discover', 'icon'),
            w('transcribe', 'icon'),
            w('focus-timer', 'icon'),
            w('transcribe', 'md'),
            w('focus-timer', 'sm')
          ]
        })
      )
    })
    await suppressFeatureSpotlights(window)
    await window.reload()
    await waitForReady(window)
    // The collapsed rail shows the People area with the People entitlement
    // (product_people); people_map is granted for the People Map surfaces.
    for (const cap of ['product_office', 'product_people', 'product_brain', 'people_map']) await grantCapability(window, cap)
    expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')

    // The logo: approved purple ii (a gradient fill) and letterforms in the
    // logo ink, navy on light and white (reversed) on dark.
    const logo = await window.evaluate(() => {
      const mark = document.querySelector('[role="img"][aria-label="Plexii"] svg')
      if (!mark) return null
      const fill = getComputedStyle(mark).getPropertyValue('--plexi-mark').trim()
      const ink = getComputedStyle(mark).getPropertyValue('--plexi-wordmark').trim()
      const stops = Array.from(mark.querySelectorAll('linearGradient stop')).map((s) => s.getAttribute('stop-color'))
      const resolvedInk = getComputedStyle(document.documentElement).getPropertyValue('--plexii-logo-ink').trim()
      return { fill, ink, stops, resolvedInk }
    })
    expect(logo, 'a Plexii logo is on screen').not.toBeNull()
    expect(logo!.fill).toMatch(/^url\(#plexii-ii-/)
    expect(logo!.stops).toEqual(['#A38CF3', '#7C66E8'])
    const ink = theme === 'dark' ? '#ffffff' : '#061c46'
    expect(logo!.resolvedInk.toLowerCase()).toBe(ink)
    // Chromium substitutes var() in custom properties at computed time.
    expect([ink, 'var(--plexii-logo-ink)']).toContain(logo!.ink.toLowerCase())
    await window.screenshot({ path: `${SHOTS}/${theme}-start.png` })

    await go(window, 'goHome')
    await surface(window, theme, 'home-actions', ['action:new-desk', 'action:discover', 'action:transcribe', 'action:focus-timer'])
    // The icon-size action tiles sit on the neutral lit tile, not a gradient.
    for (const id of ['home-new-desk-create', 'home-discover-start', 'home-transcribe-start', 'home-focus-timer-start']) {
      const cls = await window.locator(`[data-testid="${id}"]`).first().getAttribute('class')
      expect(cls ?? '', id).toContain('fb-tile-lit')
      expect(cls ?? '', id).not.toContain('bg-gradient')
    }

    await go(window, 'goOffice')
    await surface(window, theme, 'office-home', ['app:docs', 'app:sheets', 'app:slides', 'place:recent', 'place:starred', 'place:templates', 'place:trash'])

    await go(window, 'goDocuments')
    await surface(window, theme, 'documents', ['app:docs', 'app:sheets'])

    await go(window, 'goPlexiDesk', 'recent')
    await surface(window, theme, 'recent', ['app:docs'])

    await go(window, 'goSuite')
    await surface(window, theme, 'suite', [
      'app:plexidesk',
      'app:docs',
      'product:agents',
      'product:dash',
      'product:tables',
      'product:reports',
      'product:build',
      'product:widgets',
      'product:api',
      'product:marketplace',
      'product:ops',
      'place:new-desk',
      'place:templates',
      'place:all-desks'
    ])
    // The product tiles sit below the fold: one shot per product group they are in.
    for (const [key, shot] of [
      ['plexiagents', 'suite-products-ai'],
      ['plexidash', 'suite-products-data'],
      ['plexibuild', 'suite-products-build'],
      ['plexiops', 'suite-products-ops']
    ] as const) {
      await window.locator(`[data-testid="product-tile-${key}"]`).scrollIntoViewIfNeeded()
      await window.waitForTimeout(200)
      await window.screenshot({ path: `${SHOTS}/${theme}-${shot}.png` })
    }

    await go(window, 'goDraw')
    await surface(window, theme, 'draw-hub', ['app:draw'])

    await go(window, 'goDesign')
    await surface(window, theme, 'design-hub', ['app:design'])

    await go(window, 'goInbox')
    await surface(window, theme, 'inbox', ['app:inbox'])

    await go(window, 'goShared')
    await surface(window, theme, 'shared', ['tool:shared'])

    await go(window, 'goVault')
    await surface(window, theme, 'vault', ['app:vault'])

    // The tour hub: every onboarding module wears its own tile (the owner's
    // 23 Oct gradient revision; they were dark-stage violet line icons).
    await window.evaluate(() => window.dispatchEvent(new Event('fb:onboarding-hub')))
    await expect(window.locator('[data-testid="onboarding-hub"]')).toBeVisible()
    await surface(window, theme, 'onboarding-hub', ['place:tour-core', 'place:tour-rooms-desks', 'place:tour-office-connect', 'place:tour-body-double'])
    const tourTiles = await window.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('[data-testid="onboarding-hub"] img[data-plexii-icon^="place:tour-"]')).map((i) => {
        const r = i.getBoundingClientRect()
        return `${i.dataset.plexiiIcon} ${i.dataset.plexiiStyle} ${i.naturalWidth > 0 ? 'ok' : 'broken'} ${Math.round(r.width) === Math.round(r.height) ? 'square' : 'skewed'}`
      })
    )
    expect(tourTiles.sort()).toEqual(
      ['place:tour-body-double', 'place:tour-core', 'place:tour-office-connect', 'place:tour-rooms-desks'].map((id) => `${id} tile ok square`)
    )
    await window.mouse.click(5, 5) // the scrim closes the hub
    await expect(window.locator('[data-testid="onboarding-hub"]')).toBeHidden()

    // The collapsed rail: the Office and People areas and the desk places.
    await go(window, 'goHome')
    await window.locator('[data-testid="desk-sidebar"] [data-testid="menu-minimize"]').click()
    await expect(window.locator('[data-testid="desk-sidebar-collapsed"]')).toBeVisible()
    await surface(window, theme, 'collapsed-rail', [
      'place:office-area',
      'place:people-area',
      'place:home',
      'place:focus',
      'place:rooms',
      'place:desks',
      'place:trash',
      'place:section-connected-apps'
    ])
    await window.locator('[data-testid="desk-sidebar-collapsed"] button[title="Expand menu"]').click()

    // The four work widget kinds that had no icon, on a real desk: each frame
    // header wears its own tile (Minimap draws no frame header: it is a HUD).
    const deskId = await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'New kinds' })
      let x = 60
      for (const kind of ['task-link', 'custom', 'local-app-launcher', 'minimap']) {
        await api.widgets.create({ taskId: desk.id, kind, title: '', content: '', x, y: 200, width: 260, height: 180 } as never)
        x += 300
      }
      const w = window as unknown as { __fbNodes?: { getState: () => { refresh: () => Promise<void> } } }
      await w.__fbNodes?.getState().refresh()
      return desk.id
    })
    await go(window, 'goTask', deskId)
    await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 10_000 })
    await window.waitForTimeout(800)
    await surface(window, theme, 'new-widget-kinds', ['widget:task-link', 'widget:custom', 'widget:local-app-launcher'])
    // A Minimap widget is retired on load; the kind lives on as the canvas
    // minimap button, which wears the Minimap tile while the map is closed.
    const fab = window.locator('[data-testid="minimap-fab-toggle"]')
    if (!(await fab.isVisible().catch(() => false))) {
      await window.locator('button[title="Close minimap"]').click()
    }
    await expect(fab.locator('img[data-plexii-icon="widget:minimap"]')).toHaveCount(1)
    await surface(window, theme, 'minimap-button', ['widget:minimap'])
  })
}
