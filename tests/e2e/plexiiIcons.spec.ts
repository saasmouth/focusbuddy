import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { launchApp, waitForReady, openNewDesk, gotoView, type LaunchedApp } from './_helpers'

// The owner's Plexii icon set, on screen (4.3.41).
//
// Entity icons in the side menu and the work widget picker come from
// <PlexiiIcon>: an <img> for tiles and logos, a CSS mask for single-colour
// glyphs. A broken URL there renders as an empty box at 20px, which no unit
// test can see, so this loads the real build and asserts the images actually
// decoded (naturalWidth > 0) in BOTH themes, and that glyphs take the
// per-theme colour token. Screenshots go to SHOTS for the owner.

const SHOTS = process.env.PLEXII_ICON_SHOTS ?? '/private/tmp/claude-501/icons-41-shots'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

/** Wait until every matched <img> has decoded, then report the ones that did not. */
async function brokenImages(window: Page, selector: string): Promise<{ count: number; broken: string[] }> {
  await window.waitForFunction(
    (sel) => Array.from(document.querySelectorAll<HTMLImageElement>(sel)).every((i) => i.complete),
    selector,
    { timeout: 10_000 }
  )
  return window.evaluate((sel) => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(sel))
    return {
      count: imgs.length,
      broken: imgs.filter((i) => !(i.naturalWidth > 0)).map((i) => `${i.dataset.plexiiIcon} ${i.currentSrc}`)
    }
  }, selector)
}

/** Glyphs are masks: fetch each distinct mask file the way the page would. */
async function brokenGlyphs(window: Page, selector: string): Promise<{ count: number; broken: string[] }> {
  return window.evaluate(async (sel) => {
    const spans = Array.from(document.querySelectorAll<HTMLElement>(sel))
    const broken: string[] = []
    for (const s of spans) {
      const url = s.dataset.plexiiSrc ?? ''
      const ok = await new Promise<boolean>((resolve) => {
        const img = new Image()
        img.onload = () => resolve(img.naturalWidth > 0)
        img.onerror = () => resolve(false)
        img.src = url
      })
      if (!ok) broken.push(`${s.dataset.plexiiIcon} ${url}`)
    }
    return { count: spans.length, broken }
  }, selector)
}

/**
 * The menu scrolls inside its own panel, so an element screenshot shows only
 * what is in view. Scroll each section to the top of the panel and shoot the
 * panel, one file per section.
 */
async function shootMenu(window: Page, name: string, sections: string[]): Promise<void> {
  for (const id of sections) {
    const sel = id === 'other-widgets' ? '[data-testid="sidemenu-other-widgets"]' : `[data-testid="nav-section-${id}"]`
    const clip = await window.evaluate((s) => {
      const target = document.querySelector<HTMLElement>(s)
      const menu = document.querySelector<HTMLElement>('[data-testid="area-accordion"]')
      if (!target || !menu) return null
      let scroller: HTMLElement | null = menu.parentElement
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
      if (scroller) scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8
      const r = (scroller ?? menu).getBoundingClientRect()
      return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height }
    }, sel)
    if (!clip) continue
    await window.waitForTimeout(150)
    await window.screenshot({ path: `${SHOTS}/${name}-${id}.png`, clip })
  }
}

for (const theme of ['light', 'dark'] as const) {
  test(`side menu and work widget picker draw Plexii icons (${theme})`, async () => {
    mkdirSync(SHOTS, { recursive: true })
    // 2x, so the owner reviews the icons at the density most screens show them.
    launched = await launchApp({ extraArgs: ['--force-device-scale-factor=2'] })
    const { window } = launched
    await waitForReady(window)
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.evaluate((m) => localStorage.setItem('fb.theme.mode', m), theme)
    // Five standard connected apps, so the Connected apps tiles show logos.
    await window.evaluate(async () => {
      const api = (window as unknown as { api: typeof window.api }).api
      for (const [title, url] of [
        ['Gmail', 'https://mail.google.com'],
        ['Slack', 'https://app.slack.com'],
        ['Notion', 'https://www.notion.so'],
        ['Figma', 'https://www.figma.com'],
        ['GitHub', 'https://github.com']
      ]) {
        await api.connectedApps.create({ title, url })
      }
    })
    await window.reload()
    await waitForReady(window)
    await openNewDesk(window, `Icons ${theme}`)

    expect(await window.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(theme === 'dark')

    const menu = window.locator('[data-testid="area-accordion"]')
    await expect(menu).toBeVisible({ timeout: 10_000 })

    // A sample across the menu: Office apps, the Tools tiles, the Desk and
    // PlexiiBrain heads, and a tool glyph row.
    for (const sel of [
      '[data-testid="office-sideapp-docs"] img[data-plexii-icon="app:docs"]',
      '[data-testid="office-sideapp-sheets"] img[data-plexii-icon="app:sheets"]',
      '[data-testid="office-comms-app-mail"] img[data-plexii-icon="app:mail"]',
      '[data-testid="office-comms-app-calendar"] img[data-plexii-icon="app:calendar"]',
      '[data-testid="switch-plexidesk"] img[data-plexii-icon="app:plexidesk"]'
    ]) {
      await expect(window.locator(sel), sel).toHaveCount(1)
    }
    // Connected-app logos, rounded by the component rather than in the file.
    const logos = window.locator('[data-testid^="nav-connected-app-"] img[data-plexii-style="logo"]')
    await expect(logos).toHaveCount(5)
    expect(await logos.first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).not.toBe('0px')
    const menuImgs = await brokenImages(window, '[data-testid="area-accordion"] img[data-plexii-icon]')
    expect(menuImgs.count).toBeGreaterThanOrEqual(17)
    expect(menuImgs.broken).toEqual([])

    // Images sit in their box: no layout shift, the size the menu asked for.
    const box = await window.locator('[data-testid="office-sideapp-docs"] img').boundingBox()
    expect(box?.width ?? 0).toBeCloseTo(22, 0)
    expect(box?.height ?? 0).toBeCloseTo(22, 0)

    // Tool glyphs (PlexiiBrain Search, Flows) are masks in the theme's violet.
    const glyphs = await brokenGlyphs(window, '[data-testid="area-accordion"] [data-plexii-style="glyph"]')
    expect(glyphs.count).toBeGreaterThanOrEqual(1)
    expect(glyphs.broken).toEqual([])
    const glyphColor = await window.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="area-accordion"] [data-plexii-style="glyph"]')
      return el ? getComputedStyle(el).backgroundColor : ''
    })
    // #7c3aed on light, the owner's #c4b5fd on dark.
    expect(glyphColor).toBe(theme === 'dark' ? 'rgb(196, 181, 253)' : 'rgb(124, 58, 237)')

    await shootMenu(window, `${theme}-side-menu`, ['desk', 'apps', 'connected', 'people', 'brain'])

    // The work widget picker: the side menu's Work widgets section, both lists.
    const toggle = window.locator('[data-testid="sidemenu-other-widgets-toggle"]').first()
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    await expect(window.locator('[data-testid="sidemenu-other-widgets"]')).toBeVisible()
    const picker = await brokenImages(window, '[data-testid^="sidemenu-widget-"] img[data-plexii-icon^="widget:"]')
    expect(picker.count).toBeGreaterThanOrEqual(15)
    expect(picker.broken).toEqual([])
    // Focus wears the Attention asset; the kind id is unchanged (DEC-144).
    const focus = window.locator('[data-testid="sidemenu-widget-attention"] [data-plexii-icon="widget:attention"]')
    if ((await window.locator('[data-testid="sidemenu-widget-attention"]').count()) > 0) await expect(focus).toHaveCount(1)
    await shootMenu(window, `${theme}-widget-picker`, ['widgets', 'other-widgets'])

    // Home, for the dashboard tiles.
    await gotoView(window, 'goHome')
    await window.waitForTimeout(600)
    const home = await brokenImages(window, 'main img[data-plexii-icon], [data-testid^="home-"] img[data-plexii-icon]')
    expect(home.broken).toEqual([])
    await window.screenshot({ path: `${SHOTS}/${theme}-home.png` })
  })
}
