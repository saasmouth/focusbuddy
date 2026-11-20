// No dead buttons (d0's rule for F2): in the widget host, every control a
// person can see works there. A control is dead when clicking it reaches a
// channel this runtime does not serve, or throws. Each kind is opened from its
// file; every ribbon tab is opened and every visible control in it clicked;
// then the right-click menu is read for anything that needs Plexii itself.
//
// The clipboard is stubbed in the page: copy buttons are exercised without ever
// touching the real clipboard of the machine running the tests.
import { readdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { FIXTURES, fixture, load, loaded, openHost } from './harness'

const FILES = readdirSync(FIXTURES).filter((f) => f.includes('.plexii-')).sort()
const kindOf = (f: string): string => f.slice(0, f.indexOf('.'))

const unserved = (page: Page): Promise<string[]> =>
  page.evaluate(() => ((window as unknown as { plexiiUnserved: () => Array<{ channel: string; calls: number }> }).plexiiUnserved() ?? []).map((u) => `${u.channel}x${u.calls}`))

/** Every visible control, each tagged so it can be clicked by its tag. */
async function controls(page: Page, round: string): Promise<Array<[string, string]>> {
  return page.evaluate((r) => {
    const out: Array<[string, string]> = []
    let i = 0
    for (const e of document.querySelectorAll('.plexii-widget-host-box button:not([role=tab]), .plexii-widget-host-box [role=menuitem]')) {
      const box = e.getBoundingClientRect()
      if (box.width <= 0 || box.height <= 0 || (e as HTMLButtonElement).disabled) continue
      const id = `${r}-${i++}`
      e.setAttribute('data-ctl', id)
      out.push([id, (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)])
    }
    return out
  }, round)
}

test.describe('every control the host shows works there', () => {
  for (const file of FILES) {
    test(`${kindOf(file)}`, async ({ page }) => {
      test.setTimeout(600_000)
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(String(e.message)))
      await page.addInitScript(() => {
        const clip = { writeText: async () => {}, readText: async () => '', write: async () => {}, read: async () => [] }
        Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true })
      })
      await page.setViewportSize({ width: 1100, height: 760 })
      await openHost(page)
      await load(page, fixture(file))
      await loaded(page)
      await page.waitForTimeout(1500)
      // Reads a widget makes on its own that this runtime does not serve (a
      // desk's work items, a brand kit) are not controls; only what a click adds counts.
      const dead: string[] = []
      const clicked = new Set<string>()
      const sweep = async (where: string): Promise<void> => {
        for (const [id, name] of await controls(page, where.replace(/\W+/g, '_'))) {
          if (clicked.has(name)) continue
          clicked.add(name)
          const before = await unserved(page)
          const errsBefore = errors.length
          try {
            await page.locator(`[data-ctl="${id}"]`).click({ timeout: 1500, force: true })
          } catch {
            continue
          }
          await page.waitForTimeout(150)
          const added = (await unserved(page)).filter((u) => !before.includes(u))
          if (added.length || errors.length > errsBefore) dead.push(`[${where}] ${name}: ${[...added, ...errors.slice(errsBefore)].join('; ')}`)
          await page.keyboard.press('Escape')
          await page.keyboard.press('Escape')
        }
      }
      await sweep('start')
      // Tabs come and go with the context (a document's Table tab, a diagram's
      // Shape and Text tabs), so each is found by name when its turn comes.
      const tabs = (await page.locator('.plexii-widget-host-box [role=tab]').allTextContents()).map((t) => t.trim())
      for (const tab of tabs) {
        const it = page.locator('.plexii-widget-host-box [role=tab]', { hasText: tab }).first()
        if (!(await it.count())) continue
        await it.click({ force: true, timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(200)
        await sweep(`tab ${tab}`)
      }
      expect(dead, 'controls that reach something the host does not serve').toEqual([])

      // The right-click menu: nothing that needs Plexii itself.
      const box = await page.locator('.plexii-widget-host-box').boundingBox()
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2, { button: 'right' })
      await page.waitForTimeout(300)
      const rows = await page.locator('[role=menu] [role=menuitem], [role=menuitem]').allTextContents()
      expect(rows.filter((r) => /\bAI\b|assist|snippet|comment|PlexiiAssist/i.test(r))).toEqual([])
    })
  }
})

// A kind with no controls of its own (a note, a page) still renders: the sweep
// above would pass for an empty page, so these kinds are pinned by name to
// have controls -- the guard is not vacuous for the kinds that do.
test('the sweep sees controls where they exist', async ({ page }) => {
  await openHost(page)
  await load(page, fixture('table.plexii-table'))
  await loaded(page)
  await expect.poll(async () => (await controls(page, 'probe')).length).toBeGreaterThan(5)
})
