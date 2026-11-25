// The widget host, built, in Chromium (F2 of plexii-lite docs/plans/widget-files.md).
//
// What PlexiiLite relies on, end to end: every offered kind opens from its file
// and draws with no desk chrome and no AI affordance; opening a file never
// writes it; an edit comes back as the file's text, flush included; read-only
// never saves; each page keeps its rows in memory, apart from every other page;
// a file the host cannot show says so.
import { readdirSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { FIXTURES, aiAffordances, deskChrome, drawn, fixture, flush, load, loaded, ofType, openHost, stickyText } from './harness'

const FILES = readdirSync(FIXTURES).filter((f) => f.includes('.plexii-')).sort()
const DOC_TYPES = ['doc', 'sheet', 'slides', 'map', 'design', 'draw']
const kindOf = (f: string): string => f.slice(0, f.indexOf('.'))
const sticky = (content: string): string => JSON.stringify({ type: 'plexii.widget.sticky', version: 1, title: 'Shopping', kind: 'sticky', content, color: null, exportedAt: '2026-11-20T00:00:00.000Z' }, null, 2)

test('every offered kind is a fixture (19 widgets, 6 documents)', () => {
  expect(FILES).toHaveLength(25)
})

test.describe('each kind opens from its file', () => {
  for (const file of FILES) {
    test(`${kindOf(file)}: drawn, no desk chrome, no AI, and opening it writes nothing`, async ({ page }) => {
      await openHost(page)
      await load(page, fixture(file))
      const msg = await loaded(page)
      const kind = kindOf(file)
      expect(msg).toMatchObject({ protocol: 1, family: DOC_TYPES.includes(kind) ? 'document' : 'widget', kind, readOnly: false })
      await drawn(page)
      await page.waitForTimeout(1500)
      expect(await ofType(page, 'error')).toEqual([])
      expect(await deskChrome(page)).toEqual([])
      expect(await aiAffordances(page)).toEqual([])
      // Opening and closing: nothing written, even by kinds that tidy themselves on mount.
      await flush(page)
      expect(await ofType(page, 'save')).toEqual([])
    })
  }
})

test.describe('saving', () => {
  test('an edit comes back as the file\'s text, and reopens as it was left', async ({ page, context }) => {
    await openHost(page)
    await load(page, sticky('milk'))
    await loaded(page)
    const box = await stickyText(page, 'milk')
    await box.press('End')
    await page.keyboard.type(' and eggs')
    await expect.poll(async () => (await ofType(page, 'save')).length, { timeout: 10_000 }).toBeGreaterThan(0)
    const saved = (await ofType(page, 'save')).at(-1)!
    const file = JSON.parse(String(saved.text))
    expect(file).toMatchObject({ type: 'plexii.widget.sticky', version: 1, kind: 'sticky', content: 'milk and eggs' })
    // Another page, the saved text: the same sticky.
    const again = await context.newPage()
    await openHost(again)
    await load(again, String(saved.text))
    await loaded(again)
    await expect(again.locator('.plexii-widget-host-box')).toContainText('milk and eggs')
  })

  test('flush straight after typing: the last keystrokes are in the save, then flushed', async ({ page }) => {
    await openHost(page)
    await load(page, sticky(''))
    await loaded(page)
    await (await stickyText(page, '')).click()
    await page.keyboard.type('typed just now')
    await flush(page)
    const types = (await page.evaluate(() => (window as unknown as { __hostOut: Array<{ type: string }> }).__hostOut.map((m) => m.type)))
    expect(types.slice(-2)).toEqual(['plexii-widget-host:save', 'plexii-widget-host:flushed'])
    expect(JSON.parse(String((await ofType(page, 'save')).at(-1)!.text)).content).toBe('typed just now')
  })
})

test.describe('read-only (signed out in PlexiiLite)', () => {
  for (const how of ['address', 'load message'] as const) {
    test(`by ${how}: shown, not editable, never saved`, async ({ page }) => {
      await openHost(page, how === 'address' ? '?readonly=1' : '')
      await load(page, sticky('hello'), how === 'load message' ? true : undefined)
      expect(await loaded(page)).toMatchObject({ readOnly: true })
      await expect(page.locator('.plexii-widget-host-box')).toContainText('hello')
      // A click on the text would open the editor; read-only, it must not.
      await page.locator('.plexii-widget-host-box').getByText('hello', { exact: true }).click()
      await expect(page.locator('.plexii-widget-host-box textarea')).toHaveCount(0)
      await page.keyboard.type(' changed')
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(1200)
      await expect(page.locator('.plexii-widget-host-box')).toContainText('hello')
      await expect(page.locator('.plexii-widget-host-box')).not.toContainText('changed')
      await flush(page)
      expect(await ofType(page, 'save')).toEqual([])
    })
  }
})

test.describe('the file is the only copy', () => {
  test('nothing is kept in the browser\'s storage, and no page holds the workspace lock', async ({ page }) => {
    await openHost(page)
    await load(page, sticky('one'))
    await loaded(page)
    await (await stickyText(page, 'one')).press('End')
    await page.keyboard.type(' two')
    await flush(page)
    const kept = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const names: string[] = []
      for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name)
      const locks = await navigator.locks.query()
      return { opfs: names, locks: [...(locks.held ?? []), ...(locks.pending ?? [])].map((l) => l.name) }
    })
    expect(kept).toEqual({ opfs: [], locks: [] })
  })

  test('two pages of the same origin each keep their own file', async ({ context }) => {
    const [a, b] = [await context.newPage(), await context.newPage()]
    await openHost(a)
    await openHost(b)
    await load(a, sticky('first file'))
    await load(b, sticky('second file'))
    await loaded(a)
    await loaded(b)
    await expect(a.locator('.plexii-widget-host-box')).toContainText('first file')
    await expect(b.locator('.plexii-widget-host-box')).toContainText('second file')
    await (await stickyText(a, 'first file')).press('End')
    await a.keyboard.type('!')
    await flush(a)
    await flush(b)
    expect(JSON.parse(String((await ofType(a, 'save')).at(-1)!.text)).content).toBe('first file!')
    expect(await ofType(b, 'save')).toEqual([])
  })
})

test.describe('a file the host cannot show says so', () => {
  const cases: Array<[string, string, string, string]> = [
    ['not a Plexii file', 'just some text', 'not-a-plexii-file', "This file isn't a Plexii widget or document, or it's damaged."],
    ['a voice note', JSON.stringify({ type: 'plexii.widget.voice-note', version: 1, kind: 'voice-recorder', title: 'v', content: '' }), 'needs-plexii', 'A Voice note works only in Plexii.'],
    ['a newer kind', JSON.stringify({ type: 'plexii.widget.hologram', version: 1, kind: 'hologram' }), 'newer-than-host', 'This file was made by a newer version of Plexii. Update PlexiiLite to open it.']
  ]
  for (const [name, text, code, sentence] of cases) {
    test(name, async ({ page }) => {
      await openHost(page)
      await load(page, text)
      await expect.poll(async () => (await ofType(page, 'error')).length).toBe(1)
      expect((await ofType(page, 'error'))[0]).toMatchObject({ protocol: 1, code, message: sentence })
      await expect(page.locator('.plexii-widget-host-problem')).toHaveText(sentence)
    })
  }
})

test.describe('what used to be dead now works', () => {
  // A 1x1 PNG.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

  test('Insert image in a document: the browser\'s file chooser, the image saved inside the file', async ({ page }) => {
    await openHost(page)
    await page.setViewportSize({ width: 1100, height: 760 })
    await load(page, fixture('doc.plexii-doc'))
    await loaded(page)
    await page.locator('.ProseMirror').first().click()
    await page.keyboard.type('A picture:')
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Insert image' }).first().click()
    await (await chooser).setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG })
    await expect(page.locator('.ProseMirror img[src^="data:image/png;base64,"]')).toHaveCount(1)
    await flush(page)
    const saved = String((await ofType(page, 'save')).at(-1)!.text)
    expect(saved).toContain('data:image/png;base64,')
    expect(saved).toContain('A picture:')
  })

  test('a link opens in the person\'s browser through PlexiiLite, and the page stays', async ({ page }) => {
    await openHost(page)
    await load(page, JSON.stringify({ type: 'plexii.widget.markdown', version: 1, title: 'Links', kind: 'markdown', content: 'See [Plexii](https://plexiidesk.com/) for more.', color: null, exportedAt: '' }))
    await loaded(page)
    const before = page.url()
    await page.locator('.plexii-widget-host-box a[href="https://plexiidesk.com/"]').click()
    await expect.poll(async () => (await page.evaluate(() => (window as unknown as { __hostOut: Array<{ type: string; url?: string }> }).__hostOut.filter((m) => m.type === 'plexii-widget-host:open-link').map((m) => m.url)))).toEqual(['https://plexiidesk.com/'])
    expect(page.url()).toBe(before)
    await expect(page.locator('.plexii-widget-host-box')).toContainText('Plexii')
  })
})

test.describe('making new files (create, for PlexiiLite\'s New > Plexii widget / document)', () => {
  test('the build says what it can make: manifest.json beside index.html', async ({ request }) => {
    const m = await (await request.get('/manifest.json')).json()
    expect(m.protocol).toBe(1)
    expect(m.kinds).toHaveLength(19)
    expect(Object.keys(m.documents)).toEqual(['doc', 'sheet', 'slides', 'map', 'design', 'draw'])
  })

  test('every kind it lists can be made by Plexii\'s own code, in a page that shows nothing, and the new file opens', async ({ page, context, request }) => {
    test.setTimeout(240_000)
    const m = await (await request.get('/manifest.json')).json()
    await openHost(page, '?via=window')
    for (const kind of [...m.kinds, ...Object.keys(m.documents)]) {
      const before = (await ofType(page, 'save')).length
      await page.evaluate((k) => window.postMessage({ type: 'plexii-widget-host:create', kind: k }, '*'), kind)
      await expect.poll(async () => (await ofType(page, 'save')).length, { message: kind }).toBe(before + 1)
      const file = JSON.parse(String((await ofType(page, 'save')).at(-1)!.text))
      if (kind in m.documents) expect(file, kind).toMatchObject({ type: `plexii.document.${kind}`, version: 1, docType: kind, body: expect.any(Object) })
      else expect(file, kind).toMatchObject({ version: 1, kind })
      if (kind === 'table') expect(file.table.columns.map((c: { label: string }) => c.label)).toEqual(['Name', 'Done'])
      if (kind === 'task-list') expect(JSON.parse(file.content).scope).toBe('own')
    }
    expect(await ofType(page, 'error')).toEqual([])
    // A made file opens like any other.
    const saved = (await ofType(page, 'save')).length
    await page.evaluate((k) => window.postMessage({ type: 'plexii-widget-host:create', kind: k }, '*'), 'table')
    await expect.poll(async () => (await ofType(page, 'save')).length).toBe(saved + 1)
    const tableText = String((await ofType(page, 'save')).at(-1)!.text)
    expect(JSON.parse(tableText)).toMatchObject({ kind: 'table' })
    const tile = await context.newPage()
    await openHost(tile)
    await load(tile, tableText)
    expect(await loaded(tile)).toMatchObject({ kind: 'table' })
    await expect(tile.locator('.plexii-widget-host-box')).toContainText('Name')
  })

  test('a kind it cannot make is refused, named', async ({ page }) => {
    await openHost(page, '?via=window')
    await page.evaluate(() => window.postMessage({ type: 'plexii-widget-host:create', kind: 'inbox' }, '*'))
    await expect.poll(async () => (await ofType(page, 'error')).length).toBe(1)
    expect((await ofType(page, 'error'))[0]).toMatchObject({ code: 'cannot-create', message: expect.stringMatching(/^Plexii can't make an? .+ here\.$/) })
  })
})
