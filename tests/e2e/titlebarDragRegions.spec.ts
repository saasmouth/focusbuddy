import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, openNewDesk } from './_helpers'

// Every control in the title bar must be clickable on a real Mac.
//
// The window is frameless (hiddenInset), so macOS decides from the page's
// `-webkit-app-region` which points move the window. Electron folds the
// regions in DOCUMENT ORDER: a `drag` rect adds to the draggable area, a
// `no-drag` rect cuts it back out, and the last one covering a point wins.
// `pointer-events: none` plays no part. So an invisible full-width wrapper that
// inherits `drag` silently re-covers every no-drag control before it — which
// is how the back button, the desk name and the desk view selector stopped
// opening for real clicks (2026-10-22) while every Playwright click, which
// bypasses the OS hit-test, kept passing.
//
// This applies Electron's rule to the live DOM: for each control's centre, the
// last region-bearing element in document order that contains it must be
// no-drag.
test('title-bar controls are not covered by a drag region', async () => {
  test.setTimeout(90_000)
  const { window, dispose } = await launchApp({})
  try {
    await waitForReady(window)
    await openNewDesk(window, 'Drag Region Desk')
    await expect(window.locator('[data-testid="view-selector-btn"]')).toBeVisible()

    const covered = await window.evaluate(() => {
      const regionOf = (el: Element): string => {
        const cs = getComputedStyle(el)
        return (cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region') || 'none').trim()
      }
      const header = document.querySelector('header.titlebar-drag')
      if (!header) return ['no header.titlebar-drag found']
      const all = Array.from(document.querySelectorAll('*')).filter((el) => {
        const r = regionOf(el)
        return r === 'drag' || r === 'no-drag'
      })
      const controls = Array.from(
        header.querySelectorAll('button, a[href], input, select, [role="button"], [role="menuitem"]')
      ).filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      const bad: string[] = []
      for (const c of controls) {
        const r = (c as HTMLElement).getBoundingClientRect()
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        let last: Element | null = null
        for (const el of all) {
          const b = (el as HTMLElement).getBoundingClientRect()
          if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) last = el
        }
        if (last && regionOf(last) === 'drag') {
          const name = c.getAttribute('data-testid') || c.getAttribute('aria-label') || (c.textContent || '').trim().slice(0, 30)
          const by = `${last.tagName.toLowerCase()}.${String((last as HTMLElement).className).slice(0, 60)}`
          bad.push(`${name} ← ${by}`)
        }
      }
      return bad
    })
    expect(covered, `controls under a drag region:\n${covered.join('\n')}`).toEqual([])
  } finally {
    await dispose()
  }
})
