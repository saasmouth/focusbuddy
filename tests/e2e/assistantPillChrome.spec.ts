// The Plexii pill must be findable, and must not sit on top of the chrome.
//
// Reported 2026-10-09: "make sure the ii assistant button is more noticable,
// and doesnt overlap the tabs. It should be super obvious."
//
// "The tabs" turned out to be the open-item tray — a 45px strip above the
// footer that is 0px tall when empty. The pill was fixed at a flat bottom:42px
// and landed on the tray's last tab on every desk. Found by measuring, so it
// is kept honest by measuring.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('the pill clears the open tray and the footer, and reads as the primary action', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  // Open a desk so the tray is actually populated — an empty tray renders
  // nothing at all, which is the case that would make this test pass for the
  // wrong reason.
  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = await api.nodes.create({ parentId: null, kind: 'task', title: 'Pill chrome desk' })
    return d.id
  })
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  await expect(window.locator('[data-testid="open-tray"]')).toBeVisible({ timeout: 8000 })

  // The pill carries `transition-all duration-200`, so it SLIDES to its new
  // offset when the tray appears. Measuring immediately catches it mid-flight
  // and reports an overlap that resolves 200ms later — which is exactly what
  // happened while this was being written. Wait for the offset to stop moving
  // rather than for a fixed delay.
  await window.waitForFunction(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="assistant-pill"]')
    if (!el) return false
    const w = window as unknown as { __lastPillBottom?: number; __pillStill?: number }
    const b = Math.round(el.getBoundingClientRect().bottom)
    if (w.__lastPillBottom === b) {
      w.__pillStill = (w.__pillStill ?? 0) + 1
    } else {
      w.__pillStill = 0
      w.__lastPillBottom = b
    }
    return (w.__pillStill ?? 0) >= 3
  }, undefined, { timeout: 5000 })

  const geo = await window.evaluate(() => {
    const pill = document.querySelector<HTMLElement>('[data-testid="assistant-pill"]')!
    const tray = document.querySelector<HTMLElement>('[data-testid="open-tray"]')!
    const footer = document.querySelector<HTMLElement>('footer')
    const r = (el: Element): DOMRect => el.getBoundingClientRect()
    const cs = getComputedStyle(pill)
    return {
      pill: r(pill).toJSON(),
      tray: r(tray).toJSON(),
      footer: footer ? r(footer).toJSON() : null,
      trayVar: getComputedStyle(document.documentElement).getPropertyValue('--fb-pill-bottom').trim(),
      size: Math.round(r(pill).width),
      // The purple disc, not a surface-coloured circle.
      bg: cs.backgroundImage + cs.backgroundColor,
      hasPulseClass: pill.classList.contains('fb-assistant-pill')
    }
  })

  const overlaps = (a: DOMRect, b: DOMRect): boolean =>
    !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)

  // The tray publishes its real height, so the offset follows it rather than a
  // constant that goes stale the next time the strip's padding changes.
  expect(geo.trayVar, 'the tray publishes a finished offset').not.toBe('0px')
  expect(geo.trayVar).not.toBe('')

  expect(overlaps(geo.pill as DOMRect, geo.tray as DOMRect), 'pill must clear the open tray').toBe(false)
  if (geo.footer) {
    expect(overlaps(geo.pill as DOMRect, geo.footer as DOMRect), 'pill must clear the footer').toBe(false)
  }

  // Obvious: bigger than the 40px chrome circle it was, and filled with the
  // accent rather than the surface colour.
  expect(geo.size).toBeGreaterThanOrEqual(48)
  expect(geo.hasPulseClass, 'carries the pill styling that animates the halo').toBe(true)
  expect(geo.bg, 'filled with the accent, not surface-coloured').toMatch(/gradient/)
})

test('the pill sits at a plain offset when the tray is empty', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  // Nothing opened: the tray renders nothing, so the variable must read 0 and
  // the pill must not float on a gap that is not there.
  await expect(window.locator('[data-testid="open-tray"]')).toHaveCount(0)
  const trayVar = await window.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--fb-pill-bottom').trim()
  )
  expect(['0px', '']).toContain(trayVar)
})
