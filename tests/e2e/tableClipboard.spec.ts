// The Table work widget behaves like a spreadsheet range (owner, 2026-11-19:
// "why i cant copy multiple rows and cells in tables, nor drag down or across
// to fill").
//
//   TC-1  drag across cells, press ⌘C: the range is copied, as TSV and as an
//         HTML table, with no other step (tablePaste TP-1 focused the table
//         body itself before pressing the key, which no person does).
//   TC-2  click, then shift-click: the range between is copied.
//   TC-3  dates and choices copy as the table shows them (2026-11-19, Open),
//         not as stored (epoch milliseconds, option ids).
//   TC-4  ⌘V of a TSV block over a range writes it, and ONE ⌘Z takes the
//         whole paste back.
//   TC-5  a paste longer than the table adds the rows it needs, and that ⌘Z
//         takes them away again.
//   TC-6  the fill handle: drag down continues 1, 2 → 3, 4 and "Item 1" →
//         "Item 2", "Item 3"; one ⌘Z undoes the fill.
//   TC-7  the fill handle across copies the value to the right.
//   TC-8  a row's handle selects the whole row; shift-click a second handle
//         selects the rows between; ⌘C copies them.
//   TC-9  ⌘A in the table (not typing in a cell) selects every cell.
//
// The clipboard is the test's own (_clipboardStub.ts): never the system
// clipboard, which is shared between workers and belongs to the owner.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, setStubClipboard, stubClipboard, MOD } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

interface Seed {
  widgetId: string
  tableId: string
}

const DAY = Date.UTC(2026, 10, 19)

async function seed(window: LaunchedApp['window']): Promise<Seed> {
  return window.evaluate(async (day) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'ClipTable' })
    const table = await api.tables.create({
      title: 'ClipTable',
      schema: {
        columns: [
          { id: 'c-name', type: 'text-short', label: 'Name', config: {} },
          { id: 'c-city', type: 'text-short', label: 'City', config: {} },
          { id: 'c-n', type: 'number', label: 'N', config: {} },
          { id: 'c-when', type: 'date', label: 'When', config: {} },
          { id: 'c-st', type: 'single-select', label: 'Status', config: { options: [{ id: 'o-open', label: 'Open' }, { id: 'o-done', label: 'Done' }] } }
        ]
      }
    })
    const rows = [
      { 'c-name': 'Item 1', 'c-city': 'NYC', 'c-n': 1, 'c-when': day, 'c-st': 'o-open' },
      { 'c-name': 'Bob', 'c-city': 'LA', 'c-n': 2, 'c-when': day + 86400000, 'c-st': 'o-done' },
      { 'c-name': 'Cy', 'c-city': 'SF', 'c-n': null, 'c-when': null, 'c-st': null },
      { 'c-name': 'Di', 'c-city': 'DC', 'c-n': null, 'c-when': null, 'c-st': null }
    ]
    for (const cells of rows) await api.tables.createRow({ tableId: table.id, cells })
    const widget = await api.widgets.create({
      taskId: task.id, kind: 'table', title: 'ClipTable', content: table.id, x: 80, y: 80, width: 900, height: 420
    })
    return { widgetId: widget.id, tableId: table.id }
  }, DAY)
}

async function open(l: LaunchedApp): Promise<Seed> {
  const { window } = l
  await waitForReady(window)
  const s = await seed(window)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /ClipTable/ }).first().click()
  await window.waitForSelector(`[data-widget-id="${s.widgetId}"] [data-testid="table-body"]`, { timeout: 15_000 })
  await installClipboardStub(window)
  return s
}

const cell = (l: LaunchedApp, s: Seed, r: number, c: number) =>
  l.window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="table-cell-${r}-${c}"]`)

async function centre(l: LaunchedApp, s: Seed, r: number, c: number): Promise<{ x: number; y: number }> {
  const b = await cell(l, s, r, c).boundingBox()
  if (!b) throw new Error(`no cell ${r},${c}`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

async function dragSelect(l: LaunchedApp, s: Seed, from: [number, number], to: [number, number]): Promise<void> {
  const a = await centre(l, s, ...from)
  const b = await centre(l, s, ...to)
  await l.window.mouse.move(a.x, a.y)
  await l.window.mouse.down()
  await l.window.mouse.move(b.x, b.y, { steps: 8 })
  await l.window.mouse.up()
  await l.window.waitForTimeout(150)
}

async function rows(l: LaunchedApp, s: Seed): Promise<Array<Record<string, unknown>>> {
  return l.window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.tables.listRows(id)).map((r) => r.cells as Record<string, unknown>)
  }, s.tableId)
}
const col = async (l: LaunchedApp, s: Seed, key: string): Promise<unknown[]> => (await rows(l, s)).map((r) => r[key] ?? null)

test('TC-1 drag across cells and press ⌘C: the range is copied as TSV and as a table', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await dragSelect(launched, s, [0, 0], [1, 1])
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']).toBe('Item 1\tNYC\nBob\tLA')
  const html = (await stubClipboard(launched.window)).data['text/html'] ?? ''
  expect(html).toContain('<table')
  expect(html).toMatch(/<td[^>]*>Item 1<\/td>\s*<td[^>]*>NYC<\/td>/)
  expect(html).toMatch(/<td[^>]*>Bob<\/td>\s*<td[^>]*>LA<\/td>/)
})

test('TC-2 click, then shift-click: the range between is copied', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await cell(launched, s, 0, 0).click()
  await cell(launched, s, 2, 1).click({ modifiers: ['Shift'] })
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']).toBe('Item 1\tNYC\nBob\tLA\nCy\tSF')
})

test('TC-3 dates and choices copy as the table shows them', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await dragSelect(launched, s, [0, 2], [1, 4])
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']).toBe('1\t2026-11-19\tOpen\n2\t2026-11-20\tDone')
})

test('TC-4 ⌘V of a block over a range writes it, and one ⌘Z takes the whole paste back', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await setStubClipboard(launched.window, { 'text/plain': 'Paris\tFR\nRome\tIT' })
  await dragSelect(launched, s, [0, 0], [1, 1])
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(async () => (await rows(launched!, s)).slice(0, 2).map((r) => [r['c-name'], r['c-city']])).toEqual([
    ['Paris', 'FR'],
    ['Rome', 'IT']
  ])
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => (await rows(launched!, s)).slice(0, 2).map((r) => [r['c-name'], r['c-city']])).toEqual([
    ['Item 1', 'NYC'],
    ['Bob', 'LA']
  ])
})

test('TC-5 a paste longer than the table adds the rows it needs; ⌘Z removes them again', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await setStubClipboard(launched.window, { 'text/plain': 'A\nB\nC\nD\nE\nF' })
  await dragSelect(launched, s, [2, 1], [3, 1])
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(async () => col(launched!, s, 'c-city')).toEqual(['NYC', 'LA', 'A', 'B', 'C', 'D', 'E', 'F'])
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => col(launched!, s, 'c-city')).toEqual(['NYC', 'LA', 'SF', 'DC'])
})

async function dragFillHandle(l: LaunchedApp, s: Seed, to: [number, number]): Promise<void> {
  const handle = l.window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="table-fill-handle"]`)
  await expect(handle).toBeVisible({ timeout: 5_000 })
  const h = await handle.boundingBox()
  const t = await centre(l, s, ...to)
  await l.window.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2)
  await l.window.mouse.down()
  await l.window.mouse.move(t.x, t.y, { steps: 10 })
  await l.window.mouse.up()
}

test('TC-6 the fill handle down continues series (1,2 → 3,4; Item 1 → Item 2, 3), and one ⌘Z undoes it', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await dragSelect(launched, s, [0, 2], [1, 2])
  await dragFillHandle(launched, s, [3, 2])
  await expect.poll(async () => col(launched!, s, 'c-n')).toEqual([1, 2, 3, 4])
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => col(launched!, s, 'c-n')).toEqual([1, 2, null, null])

  // A single "Item 1" continues as text with a number.
  await cell(launched, s, 0, 0).click()
  await launched.window.keyboard.press('Escape')
  await dragFillHandle(launched, s, [2, 0])
  await expect.poll(async () => col(launched!, s, 'c-name')).toEqual(['Item 1', 'Item 2', 'Item 3', 'Di'])
})

test('TC-7 the fill handle across copies the value to the right', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await cell(launched, s, 1, 0).click()
  await launched.window.keyboard.press('Escape')
  await dragFillHandle(launched, s, [1, 1])
  await expect.poll(async () => (await rows(launched!, s))[1]['c-city']).toBe('Bob')
})

test('TC-8 a row handle selects the row; shift-click another: the rows between are copied', async () => {
  launched = await launchApp()
  const s = await open(launched)
  const handle = (i: number) => launched!.window.locator(`[data-widget-id="${s.widgetId}"] [data-testid="table-row-select-${i}"]`)
  await handle(1).click()
  await handle(2).click({ modifiers: ['Shift'] })
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']).toBe('Bob\tLA\t2\t2026-11-20\tDone\nCy\tSF\t\t\t')
})

test('TC-9 ⌘A in the table selects every cell', async () => {
  launched = await launchApp()
  const s = await open(launched)
  await cell(launched, s, 0, 0).click()
  await launched.window.keyboard.press('Escape')
  await launched.window.keyboard.press(`${MOD}+a`)
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']?.split('\n').length).toBe(4)
  expect((await stubClipboard(launched.window)).data['text/plain']?.split('\n')[3]).toBe('Di\tDC\t\t\t')
})
