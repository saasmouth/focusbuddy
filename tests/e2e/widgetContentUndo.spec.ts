// Content edits that ⌘Z did not take back (owner, 2026-11-19: "check for
// similar issues with all other widgets and fix"; gap list item 8). The undo
// history recorded only a widget's geometry, so ⌘Z after one of these undid an
// unrelated earlier desk move instead.
//
//   WU-1  A task list of its own: add, tick, rename, set a due date, delete.
//         Each ⌘Z takes back one, last first; ⇧⌘Z puts one back.
//   WU-2  The Diagram widget: an added box is one ⌘Z away, and selecting a
//         node in between is not a step of its own.
//   WU-3  An Image widget given a new picture: ⌘Z brings the old one back.
//   WU-4  The Scratchpad: a stroke, then Clear. ⌘Z restores the board, ⌘Z
//         again removes the stroke.
//   WU-4b One eraser drag across two strokes is one step: one ⌘Z brings both
//         back, ⇧⌘Z erases both again.
//   WU-5  Duplicating three selected widgets is one step: one ⌘Z removes all
//         three copies (it took three).
//
// Every result is read back from the stored widget.
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { MOD } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

type Seed = { kind: string; content: string; title?: string; width?: number; height?: number }

async function deskWith(l: LaunchedApp, widgets: Seed[]): Promise<{ deskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const made = await window.evaluate(async (ws) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'UndoDesk' })
    const ids: string[] = []
    let x = 80
    for (const w of ws) {
      const c = await api.widgets.create({ taskId: desk.id, kind: w.kind, title: w.title ?? '', content: w.content, x, y: 80, width: w.width ?? 380, height: w.height ?? 320 } as never)
      ids.push(c.id)
      x += (w.width ?? 380) + 40
    }
    return { deskId: desk.id, ids }
  }, widgets)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /UndoDesk/ }).first().click()
  for (const id of made.ids) await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 15_000 })
  return made
}

const stored = (p: Page, id: string): Promise<string> =>
  p.evaluate(async (wid) => ((await (window as unknown as { api: typeof window.api }).api.widgets.get(wid))?.content ?? '') as string, id)

/** ⌘Z (or ⇧⌘Z) on the desk: out of any field first, as a person clicking the desk would be. */
async function deskKey(p: Page, redo = false): Promise<void> {
  await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await p.keyboard.press(redo ? `${MOD}+Shift+z` : `${MOD}+z`)
}

test('WU-1 a task list of its own: add, tick, rename, due date and delete are each one ⌘Z', async () => {
  launched = await launchApp()
  const { window } = launched
  const { ids } = await deskWith(launched, [{ kind: 'task-list', content: JSON.stringify({ scope: 'own', filter: 'all', items: [] }) }])
  const id = ids[0]
  const list = window.locator(`[data-widget-id="${id}"]`)
  const items = async (): Promise<Array<{ title: string; done: boolean; dueAt: number | null }>> =>
    ((JSON.parse((await stored(window, id)) || '{}') as { items?: Array<{ title: string; done: boolean; dueAt: number | null }> }).items ?? []).map((i) => ({
      title: i.title,
      done: i.done,
      dueAt: i.dueAt
    }))

  await list.locator('[data-testid="own-task-add"]').click()
  await window.keyboard.type('Book flights')
  await window.keyboard.press('Enter')
  await expect.poll(items).toEqual([{ title: 'Book flights', done: false, dueAt: null }])

  await list.locator('[data-testid="own-task-toggle"]').click()
  await expect.poll(async () => (await items())[0]?.done).toBe(true)

  await list.locator('[data-testid="own-task-row"] span[title="Double-click to edit"]').dblclick()
  await window.keyboard.press(`${MOD}+a`)
  await window.keyboard.type('Book flights to Lisbon')
  await window.keyboard.press('Enter')
  await expect.poll(async () => (await items())[0]?.title).toBe('Book flights to Lisbon')

  await list.locator('[data-testid="own-task-row"] input[type="date"]').fill('2026-12-01')
  await expect.poll(async () => (await items())[0]?.dueAt).not.toBeNull()

  await list.locator('[data-testid="own-task-row"]').hover()
  await list.locator('[aria-label="Delete task"]').click()
  await expect.poll(items).toEqual([])

  // Last first: the delete, the date, the name, the tick, the add.
  await deskKey(window)
  await expect.poll(async () => (await items()).map((i) => i.title)).toEqual(['Book flights to Lisbon'])
  await deskKey(window)
  await expect.poll(async () => (await items())[0]?.dueAt).toBeNull()
  await deskKey(window)
  await expect.poll(async () => (await items())[0]?.title).toBe('Book flights')
  await deskKey(window)
  await expect.poll(async () => (await items())[0]?.done).toBe(false)
  await deskKey(window)
  await expect.poll(items).toEqual([])
  // ⇧⌘Z puts the add back.
  await deskKey(window, true)
  await expect.poll(items).toEqual([{ title: 'Book flights', done: false, dueAt: null }])
})

test('WU-2 the Diagram widget: an added box is one ⌘Z away; selecting a node is not a step', async () => {
  launched = await launchApp()
  const { window } = launched
  const graph = { nodes: [{ id: 'n1', type: 'shape', position: { x: 40, y: 40 }, data: { label: 'Start', shape: 'box', color: '#dbeafe' } }], edges: [] }
  const { ids } = await deskWith(launched, [{ kind: 'diagram', content: JSON.stringify(graph), width: 560, height: 380 }])
  const id = ids[0]
  const w = window.locator(`[data-widget-id="${id}"]`)
  const nodeCount = async (): Promise<number> => ((JSON.parse((await stored(window, id)) || '{}') as { nodes?: unknown[] }).nodes ?? []).length
  // First click makes the widget active (the desk's rule), then its toolbar adds.
  await w.locator('.react-flow').click({ position: { x: 300, y: 250 } })
  await w.getByTitle('Add Box').click()
  await expect.poll(nodeCount, { timeout: 5_000 }).toBe(2)
  // Select the first node and let the save run: that is not an edit.
  await w.locator('.react-flow__node').first().click()
  await window.waitForTimeout(900)
  await deskKey(window)
  await expect.poll(nodeCount, { timeout: 5_000 }).toBe(1)
  await expect(w.locator('.react-flow__node')).toHaveCount(1)
})

test('WU-3 an Image widget given a new picture: ⌘Z brings the old one back', async () => {
  launched = await launchApp()
  const { window } = launched
  const OLD = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg=='
  const NEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYPhfz8DAwMAAAA0AA//b9pHTAAAAAElFTkSuQmCC'
  const { ids } = await deskWith(launched, [{ kind: 'image', content: OLD }])
  const id = ids[0]
  const w = window.locator(`[data-widget-id="${id}"]`)
  await w.locator('[data-testid="image-widget-body"]').hover()
  await w.getByTitle('Change URL').click()
  const field = w.locator('input[placeholder="https://…/image.png"]')
  await field.fill(NEW)
  await field.press('Enter')
  await expect.poll(() => stored(window, id)).toBe(NEW)
  await deskKey(window)
  await expect.poll(() => stored(window, id)).toBe(OLD)
  await expect(w.locator('img')).toHaveAttribute('src', OLD)
})

test('WU-4 the Scratchpad: a stroke, then Clear; ⌘Z restores the board, then removes the stroke', async () => {
  launched = await launchApp()
  const { window } = launched
  const { ids } = await deskWith(launched, [{ kind: 'scratchpad', content: JSON.stringify({ strokes: [] }), width: 420, height: 340 }])
  const id = ids[0]
  const w = window.locator(`[data-widget-id="${id}"]`)
  const strokes = async (): Promise<number> => ((JSON.parse((await stored(window, id)) || '{}') as { strokes?: unknown[] }).strokes ?? []).length
  const surface = w.locator('.touch-none').first()
  const box = (await surface.boundingBox())!
  // First click makes it active; then a stroke.
  await window.mouse.click(box.x + 20, box.y + 20)
  await window.mouse.move(box.x + 60, box.y + 60)
  await window.mouse.down()
  for (let i = 1; i <= 8; i++) await window.mouse.move(box.x + 60 + i * 15, box.y + 60 + i * 8)
  await window.mouse.up()
  await expect.poll(strokes).toBe(1)
  await w.getByTitle('Clear').click()
  await expect.poll(strokes).toBe(0)
  await deskKey(window)
  await expect.poll(strokes).toBe(1)
  await deskKey(window)
  await expect.poll(strokes).toBe(0)
})

test('WU-4b the Scratchpad: one eraser drag across two strokes is one ⌘Z', async () => {
  launched = await launchApp()
  const { window } = launched
  const line = (y: number): { points: number[][]; color: string; size: number } => ({
    points: [60, 90, 120, 150, 180].map((x) => [x, y, 0.5]),
    color: '#1f2937',
    size: 4
  })
  const { ids } = await deskWith(launched, [{ kind: 'scratchpad', content: JSON.stringify({ strokes: [line(70), line(170)] }), width: 420, height: 340 }])
  const id = ids[0]
  const w = window.locator(`[data-widget-id="${id}"]`)
  const strokes = async (): Promise<number> => ((JSON.parse((await stored(window, id)) || '{}') as { strokes?: unknown[] }).strokes ?? []).length
  const surface = w.getByTestId('scratchpad-surface')
  const box = (await surface.boundingBox())!
  // Screen pixels per widget-local pixel (the desk may be zoomed).
  const scale = box.width / (await surface.evaluate((el) => (el as HTMLElement).offsetWidth))
  const at = (x: number, y: number): [number, number] => [box.x + x * scale, box.y + y * scale]
  // First click makes it active (it draws nothing); then the eraser.
  await window.mouse.click(...at(300, 300))
  await w.getByTitle('Eraser').click()
  expect(await strokes()).toBe(2)
  // One drag, down through both strokes.
  await window.mouse.move(...at(120, 30))
  await window.mouse.down()
  for (let y = 40; y <= 210; y += 10) await window.mouse.move(...at(120, y))
  await window.mouse.up()
  await expect.poll(strokes).toBe(0)
  await deskKey(window)
  await expect.poll(strokes).toBe(2)
  await deskKey(window, true)
  await expect.poll(strokes).toBe(0)
})

test('WU-5 duplicating three selected widgets is one step: one ⌘Z removes all three copies', async () => {
  launched = await launchApp()
  const { window } = launched
  const { deskId, ids } = await deskWith(launched, [
    { kind: 'sticky', content: 'One', width: 220, height: 180 },
    { kind: 'sticky', content: 'Two', width: 220, height: 180 },
    { kind: 'sticky', content: 'Three', width: 220, height: 180 }
  ])
  const count = (): Promise<number> =>
    window.evaluate(async (d) => (await (window as unknown as { api: typeof window.api }).api.widgets.listByTask(d)).length, deskId)
  await window.evaluate((sel) => (window as unknown as { __fbWidgets: { getState: () => { setSelection: (ids: string[]) => void } } }).__fbWidgets.getState().setSelection(sel), ids)
  await window.getByRole('button', { name: 'Duplicate selected' }).click()
  await expect.poll(count).toBe(6)
  await deskKey(window)
  await expect.poll(count).toBe(3)
  await deskKey(window, true)
  await expect.poll(count).toBe(6)
})
