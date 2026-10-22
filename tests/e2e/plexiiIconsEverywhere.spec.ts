import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The owner's Plexii icon set, second pass (4.3.41, "every icon, system
// wide"): the surfaces beyond the side menu — Office home, Documents, Recent,
// Suite, search, the app empty states — wear the set, every <img> decodes,
// and the logo is the approved purple one, reversed on dark. Light and dark;
// screenshots go to SHOTS for the owner.

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
    await window.reload()
    await waitForReady(window)
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

    await go(window, 'goOffice')
    await surface(window, theme, 'office-home', ['app:docs', 'app:sheets', 'app:slides'])

    await go(window, 'goDocuments')
    await surface(window, theme, 'documents', ['app:docs', 'app:sheets'])

    await go(window, 'goPlexiDesk', 'recent')
    await surface(window, theme, 'recent', ['app:docs'])

    await go(window, 'goSuite')
    await surface(window, theme, 'suite', ['app:plexidesk', 'app:docs'])

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
  })
}
