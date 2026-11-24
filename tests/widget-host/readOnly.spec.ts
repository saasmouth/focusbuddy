// A read-only tile (signed out in PlexiiLite) shows what the file holds and no
// control that would change it (1a and d0, 2026-11-20).
//
// Read-only, the input guard refuses every gesture except Tab, following a
// link and a reading control (inputGuard.ts). So any other control drawn in a
// read-only tile is a dead button by definition: a ribbon, a toolbar, a colour
// dot, a keypad, an "Add" button, an empty field's placeholder inviting typing.
// For each of the 19 kinds and 6 documents this loads the file read-only and
// expects:
//
//   - no visible control, enabled or disabled, other than a READING control
//     (data-reading-control: copy, switching slide or sheet), which works;
//   - text it holds is shown as text: a field is read-only and invites nothing;
//   - what the file holds is still there.
import { readdirSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { FIXTURES, fixture, load, loaded, ofType, openHost } from './harness'

const FILES = readdirSync(FIXTURES).filter((f) => f.includes('.plexii-')).sort()
const kindOf = (f: string): string => f.slice(0, f.indexOf('.'))

/** Controls in the tile a read-only person could see and try, each described. */
async function writingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const box = document.querySelector('.plexii-widget-host-box')!
    const visible = (el: Element): boolean => {
      const r = (el as HTMLElement).getBoundingClientRect()
      const s = getComputedStyle(el as HTMLElement)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0
    }
    const name = (e: Element): string => (e.getAttribute('aria-label') || e.getAttribute('title') || e.getAttribute('placeholder') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50)
    const TEXT_INPUTS = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week'])
    const found: string[] = []
    const sel = 'button,[role=button],[role=menuitem],[role=tab],[role=checkbox],[role=switch],[role=slider],[role=combobox],[role=option],select,input,textarea,[contenteditable=""],[contenteditable="true"]'
    for (const el of box.querySelectorAll(sel)) {
      if (!visible(el) || el.closest('[data-reading-control]')) continue
      const tag = el.tagName.toLowerCase()
      const textField = tag === 'textarea' || (tag === 'input' && TEXT_INPUTS.has((el as HTMLInputElement).type))
      if (textField) {
        const f = el as HTMLInputElement
        if (!f.readOnly) found.push(`editable ${tag} "${name(el)}"`)
        else if (!f.value && f.placeholder) found.push(`placeholder "${f.placeholder.slice(0, 50)}"`)
        continue
      }
      found.push(`${tag}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''} "${name(el)}"`)
    }
    // A rich-text editor's empty-line prompt ("Write something…") is drawn by CSS.
    for (const el of box.querySelectorAll('[data-placeholder]')) {
      const c = getComputedStyle(el, '::before').content
      if (visible(el) && c && c !== 'none' && c !== 'normal' && c !== '""') found.push(`placeholder ${c.slice(0, 50)}`)
    }
    return found
  })
}

const readingControls = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    let i = 0
    const out: string[] = []
    for (const el of document.querySelectorAll('.plexii-widget-host-box [data-reading-control]')) {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) continue
      const id = `rc-${i++}`
      el.setAttribute('data-rc', id)
      out.push(id)
    }
    return out
  })

const unserved = (page: Page): Promise<string[]> =>
  page.evaluate(() => ((window as unknown as { plexiiUnserved: () => Array<{ channel: string }> }).plexiiUnserved() ?? []).map((u) => u.channel))

async function openReadOnly(page: Page, text: string, errors: string[]): Promise<void> {
  page.on('pageerror', (e) => errors.push(String(e.message)))
  // A stub clipboard (the machine's own is never touched) that records what is copied.
  await page.addInitScript(() => {
    const log: string[] = []
    ;(window as unknown as { __copied: string[] }).__copied = log
    const clip = { writeText: async (t: string) => void log.push(t), readText: async () => '', write: async () => {}, read: async () => [] }
    Object.defineProperty(navigator, 'clipboard', { value: clip, configurable: true })
  })
  await page.setViewportSize({ width: 1100, height: 760 })
  await openHost(page)
  await load(page, text, true)
  expect(await loaded(page)).toMatchObject({ readOnly: true })
  await page.waitForTimeout(1500)
}

test.describe('a read-only tile draws no control that would change the file', () => {
  for (const file of FILES) {
    test(kindOf(file), async ({ page }) => {
      const errors: string[] = []
      await openReadOnly(page, fixture(file), errors)
      expect(await writingControls(page)).toEqual([])
      // What is left works, and still writes nothing.
      for (const id of await readingControls(page)) {
        const before = await unserved(page)
        await page.locator(`[data-rc="${id}"]`).click({ timeout: 2000 })
        await page.waitForTimeout(150)
        expect((await unserved(page)).filter((u) => !before.includes(u)), `reading control ${id}`).toEqual([])
        await page.keyboard.press('Escape')
      }
      expect(errors).toEqual([])
      expect(await ofType(page, 'save')).toEqual([])
    })
  }
})

// The fixtures are mostly empty; these carry content, to prove it is still shown.
const withContent = (file: string, content: string): string => JSON.stringify({ ...JSON.parse(fixture(file)), content }, null, 2)
const SHOWN: Array<[string, string, string]> = [
  ['sticky', withContent('sticky.plexii-sticky', 'Buy oat milk'), 'Buy oat milk'],
  ['card', withContent('card.plexii-card', JSON.stringify({ title: 'Launch plan', body: 'Ship on Friday' })), 'Ship on Friday'],
  ['note', withContent('note.plexii-note', 'Call the plumber'), 'Call the plumber'],
  ['markdown', withContent('markdown.plexii-markdown', '# Agenda\n\nReview the budget'), 'Review the budget'],
  ['color', fixture('color.plexii-color'), '#fbbf24'],
  ['timer', fixture('timer.plexii-timer'), '10:00']
]

test.describe('read-only still shows what the file holds', () => {
  for (const [kind, text, shown] of SHOWN) {
    test(kind, async ({ page }) => {
      const errors: string[] = []
      await openReadOnly(page, text, errors)
      const box = page.locator('.plexii-widget-host-box')
      const inText = await box.evaluate((el, s) => (el.textContent ?? '').includes(s) || [...el.querySelectorAll('input,textarea')].some((f) => (f as HTMLInputElement).value.includes(s)), shown)
      expect(inText, `"${shown}" shown`).toBe(true)
      expect(await writingControls(page)).toEqual([])
      expect(errors).toEqual([])
    })
  }

  test('a table keeps its column names and rows; a task list its tasks and which are done', async ({ page }) => {
    const errors: string[] = []
    await openReadOnly(page, fixture('table.plexii-table'), errors)
    const table = JSON.parse(fixture('table.plexii-table')).table as { columns: Array<{ label: string }>; rows: Array<Record<string, unknown>> }
    const boxText = async (): Promise<string> => page.locator('.plexii-widget-host-box').evaluate((el) => `${el.textContent} ${[...el.querySelectorAll('input,textarea')].map((f) => (f as HTMLInputElement).value).join(' ')}`)
    for (const c of table.columns) expect(await boxText()).toContain(c.label)
    for (const row of table.rows) for (const v of Object.values(row)) if (typeof v === 'string' && v) expect(await boxText()).toContain(v)
    const page2 = await page.context().newPage()
    await openReadOnly(page2, fixture('task-list.plexii-tasks'), errors)
    const items = JSON.parse(JSON.parse(fixture('task-list.plexii-tasks')).content).items as Array<{ title?: string; text?: string }>
    for (const it of items) await expect(page2.locator('.plexii-widget-host-box')).toContainText(String(it.title ?? it.text))
    expect(errors).toEqual([])
  })
})

// The loop above proves a reading control breaks nothing; these prove each one
// still does its job read-only, which the input guard would otherwise refuse.
test.describe('reading controls still work read-only', () => {
  const copied = async (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)

  test('a colour\'s hex is copied', async ({ page }) => {
    const errors: string[] = []
    await openReadOnly(page, fixture('color.plexii-color'), errors)
    await page.locator('.plexii-widget-host-box [data-reading-control]', { hasText: 'copy hex' }).click()
    await expect.poll(() => copied(page)).toEqual(['#fbbf24'])
  })

  test('a task list switches between Active, Done and All, and saves nothing', async ({ page }) => {
    const errors: string[] = []
    const items = [{ id: 'a', title: 'Buy milk', done: false, dueAt: null }, { id: 'b', title: 'Pay the rent', done: true, dueAt: null }]
    await openReadOnly(page, withContent('task-list.plexii-tasks', JSON.stringify({ scope: 'own', filter: 'open', items })), errors)
    const box = page.locator('.plexii-widget-host-box')
    await expect(box).toContainText('Buy milk')
    await expect(box).not.toContainText('Pay the rent')
    await box.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(box).toContainText('Pay the rent')
    await expect(box).not.toContainText('Buy milk')
    await expect(box.getByRole('img', { name: 'Done' })).toHaveCount(1)
    expect(await ofType(page, 'save')).toEqual([])
    expect(errors).toEqual([])
  })

  test('a deck moves to its second slide', async ({ page }) => {
    const errors: string[] = []
    const deck = JSON.parse(fixture('slides.plexii-slides'))
    const first = deck.body.slides[0]
    deck.body.slides = [{ ...first, title: 'First slide' }, { ...first, id: 'second-slide-id', title: 'Second slide' }]
    await openReadOnly(page, JSON.stringify(deck, null, 2), errors)
    const thumbs = page.locator('[data-testid="slides-thumbnails"] [data-reading-control]')
    await expect(thumbs).toHaveCount(2)
    await expect(thumbs.nth(0)).toHaveAttribute('aria-current', 'true')
    await thumbs.nth(1).click()
    await expect(thumbs.nth(1)).toHaveAttribute('aria-current', 'true')
    expect(await ofType(page, 'save')).toEqual([])
    expect(errors).toEqual([])
  })
})
