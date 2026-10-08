// Diagnostic: does the sidebar header row fit at the minimum sidebar width?
// Reported 2026-10-08: "a formatting issue with the new desk button next to
// the plexii logo". Measure before changing anything.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.app.close()
  launched = null
})

test('sidebar header fit', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  for (const w of [232, 260, 300, 480]) {
    await window.evaluate((w) => localStorage.setItem('fb.sidebar.width', String(w)), w)
    await window.reload()
    await waitForReady(window)
    const m = await window.evaluate(() => {
      const aside = document.querySelector<HTMLElement>('[data-testid="desk-sidebar"]')
      if (!aside) return null
      const row = aside.firstElementChild as HTMLElement | null
      if (!row) return null
      const kids = Array.from(row.children) as HTMLElement[]
      const cs = getComputedStyle(row)
      const inner =
        row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      const btn = row.querySelector<HTMLElement>('button')
      return {
        asideW: aside.getBoundingClientRect().width,
        rowInner: Math.round(inner),
        scrollW: row.scrollWidth,
        clientW: row.clientWidth,
        overflow: row.scrollWidth - row.clientWidth,
        kids: kids.map((k) => ({
          tag: k.tagName.toLowerCase(),
          w: Math.round(k.getBoundingClientRect().width)
        })),
        btnW: btn ? Math.round(btn.getBoundingClientRect().width) : null,
        btnH: btn ? Math.round(btn.getBoundingClientRect().height) : null,
        btnLines: btn ? Math.round(btn.getBoundingClientRect().height / 16) : null
      }
    })
    console.log(`width=${w}`, JSON.stringify(m))
  }
  expect(true).toBe(true)
})
