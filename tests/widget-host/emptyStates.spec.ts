// New files say nothing about Plexii's AI or desk (1a and d0, 2026-11-20).
//
// A new file is empty, and an empty widget or document is where Plexii puts
// its prompts: 'Write something, press "/" for commands, or use Ask AI…'. The
// host has no AI and no desk, so a prompt that points at either sends the
// person looking for something that is not there. Each kind PlexiiLite can make
// is made here (create, as PlexiiLite's New menu does), opened, and read for:
//
//   - placeholders and empty states that mention the AI or the assistant;
//   - "/" menus offering what needs Plexii (saved snippets, a desk's widgets,
//     another Plexii file to embed by id: the file would keep a reference to
//     something that is not in it);
//   - a mind map's desk actions (explore as a canvas, convert to a task, attach
//     a tool, find agents).
import { test, expect, type Page } from '@playwright/test'
import { load, loaded, ofType, openHost } from './harness'

/** Wording that points at Plexii's AI or assistant. A bare "AI" counts only in a prompt (a sheet's column AI is a column). */
const AI_PHRASE = /\b(?:Ask|use|with|by) AI\b|\bAI (?:draft|will|can|writes|Expand)|Ask Plexii|\bassistant\b/i

async function aiWording(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const phrase = new RegExp(src, 'i')
    const found: string[] = []
    for (const el of document.querySelectorAll('.plexii-widget-host-box *, [role=listbox] *, [role=menu] *')) {
      const prompts = [el.getAttribute('placeholder'), el.getAttribute('data-placeholder'), getComputedStyle(el, '::before').content, getComputedStyle(el, '::after').content]
      for (const p of prompts) if (p && p !== 'none' && p !== 'normal' && (/\bAI\b/.test(p) || phrase.test(p))) found.push(`prompt: ${p.slice(0, 80)}`)
      const said = [el.getAttribute('aria-label'), el.getAttribute('title'), el.children.length === 0 ? el.textContent : null]
      for (const s of said) if (s && phrase.test(s)) found.push(`text: ${s.trim().slice(0, 80)}`)
    }
    return [...new Set(found)]
  }, AI_PHRASE.source)
}

async function make(page: Page, kind: string): Promise<string> {
  const before = (await ofType(page, 'save')).length
  await page.evaluate((k) => window.postMessage({ type: 'plexii-widget-host:create', kind: k }, '*'), kind)
  await expect.poll(async () => (await ofType(page, 'save')).length, { message: kind }).toBe(before + 1)
  return String((await ofType(page, 'save')).at(-1)!.text)
}

let made: Record<string, string> = {}
test.beforeAll(async ({ browser, request }) => {
  const m = await (await request.get('/manifest.json')).json()
  const page = await browser.newPage()
  await openHost(page, '?via=window')
  made = {}
  for (const kind of [...m.kinds, ...Object.keys(m.documents)]) made[kind] = await make(page, kind)
  await page.close()
})

test('every kind PlexiiLite can make was made (19 widgets, 6 documents)', () => {
  expect(Object.keys(made)).toHaveLength(25)
})

for (const kind of ['sticky', 'note', 'markdown', 'page', 'card', 'scratchpad', 'calculator', 'color', 'timer', 'shape', 'field', 'task-list', 'metrics', 'stat-card', 'mindmap', 'custom-block', 'table', 'chart', 'location-map', 'doc', 'sheet', 'slides', 'map', 'design', 'draw']) {
  test(`a new ${kind}: no prompt points at the AI`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1100, height: 760 })
    await openHost(page)
    await load(page, made[kind]!)
    await loaded(page)
    await page.waitForTimeout(1200)
    expect(await aiWording(page)).toEqual([])
  })
}

/** Opens the "/" menu at the end of the editor and returns what it offers. */
async function slashMenu(page: Page, editor: string): Promise<string[]> {
  await page.locator(editor).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('/')
  await page.waitForTimeout(500)
  return page.evaluate(() => {
    // The document's menu (SlashMenu.ts) is mounted on body; the page widget's is inside the tile.
    const rows = document.querySelectorAll('[data-testid=doc-slash-menu] button, .plexii-widget-host-box .fb-glass-panel button')
    return [...rows].map((r) => (r.textContent ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean)
  })
}

const NEEDS_PLEXII = /snippet|from a desk|office file|work widget|\bAI\b|assistant/i

test('a new document\'s "/" menu offers block types only, nothing that needs Plexii', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await openHost(page)
  await load(page, made.doc!)
  await loaded(page)
  const items = await slashMenu(page, '.plexii-widget-host-box .ProseMirror')
  expect(items.some((i) => /Heading 1/.test(i)), `menu opened: ${items.join(' | ')}`).toBe(true)
  expect(items.filter((i) => NEEDS_PLEXII.test(i))).toEqual([])
})

test('a new page\'s "/" menu likewise', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await openHost(page)
  await load(page, made.page!)
  await loaded(page)
  const items = await slashMenu(page, '.plexii-widget-host-box .ProseMirror')
  expect(items.some((i) => /Heading 1/.test(i)), `menu opened: ${items.join(' | ')}`).toBe(true)
  expect(items.filter((i) => NEEDS_PLEXII.test(i))).toEqual([])
})

test('a mind map offers no desk actions: no canvas to explore, no task to convert to, no tools or agents to attach', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 })
  await openHost(page)
  await load(page, made.mindmap!)
  await loaded(page)
  await page.waitForTimeout(1000)
  // The node inspector opens on a node; open it on the root if it is not open.
  if (!(await page.getByTestId('mindmap-add-child').count())) await page.locator('.plexii-widget-host-box svg g[data-node-id], .plexii-widget-host-box [data-testid^="mindmap-node"]').first().click()
  await expect(page.getByTestId('mindmap-add-child')).toBeVisible()
  const desk = await page.locator('.plexii-widget-host-box').getByText(/Explore as canvas|Open canvas|Convert to task|Add tool|Find agents/).count()
  expect(desk).toBe(0)
})
