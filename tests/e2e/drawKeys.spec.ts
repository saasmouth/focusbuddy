/**
 * WP-KEYS: PlexiiDraw answers to Illustrator's default keys, says once what
 * moved, and lists every shortcut in Edit › Keyboard shortcuts…, where a key
 * can be changed for this profile. Driven with real key presses in the real
 * app on a throwaway profile; results are read back from the stored document,
 * the DOM and the profile's storage.
 */

import { test, expect, type Page } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'
import {
  keepNoticesOutOfTheWay,
  openDocument,
  readStored,
  rectObject,
  runMenu,
  seedDrawDoc,
  stagePoint,
  v1Body,
  waitForSave
} from './_drawHelpers'

let app: LaunchedApp
let window: Page

test.beforeAll(async () => {
  app = await launchApp({ env: { PLEXI_APP: 'preview3' } })
  window = app.window
  await waitForReady(window)
  await keepNoticesOutOfTheWay(window)
})

test.afterAll(async () => {
  await app.dispose()
})

type Obj = { id: string; type: string; shapeKind?: string; text?: string }
type Layer = { kind: string; objects?: Obj[] }
async function objects(id: string): Promise<Obj[]> {
  return ((await readStored(window, id)).raw as { layers: Layer[] }).layers.flatMap(
    (l) => l.objects ?? []
  )
}
async function drag(from: [number, number], to: [number, number]): Promise<void> {
  const a = await stagePoint(window, 800, { x: from[0], y: from[1] })
  const b = await stagePoint(window, 800, { x: to[0], y: to[1] })
  await window.mouse.move(a.x, a.y)
  await window.mouse.down()
  for (let i = 1; i <= 4; i++)
    await window.mouse.move(a.x + ((b.x - a.x) * i) / 4, a.y + ((b.y - a.y) * i) / 4)
  await window.mouse.up()
}
async function click(x: number, y: number): Promise<void> {
  const p = await stagePoint(window, 800, { x, y })
  await window.mouse.click(p.x, p.y)
}
const toolPressed = (id: string) => window.locator(`[data-testid="draw-tool-${id}"]`)

test('KEY-1 the first open shows what moved, links to every shortcut, and stays dismissed for this profile', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  const notice = window.locator('[data-testid="draw-keys-notice"]')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('PlexiiDraw now uses Illustrator’s shortcuts')
  await expect(notice.locator('li')).toHaveCount(10)
  await expect(window.locator('[data-testid="draw-keys-notice-change-rect"]')).toContainText(
    'Rectangle R → M'
  )
  await expect(
    window.locator('[data-testid="draw-keys-notice-change-edit.duplicate"]')
  ).toContainText('Duplicate ⌘D → no key')

  await window.locator('[data-testid="draw-keys-notice-see-all"]').click()
  await expect(window.locator('[data-testid="draw-shortcuts-dialog"]')).toBeVisible()
  await window.keyboard.press('Escape') // leaves the search box
  await window.keyboard.press('Escape') // closes the dialog
  await expect(window.locator('[data-testid="draw-shortcuts-dialog"]')).toHaveCount(0)
  await expect(notice).toBeVisible()

  await window.locator('[data-testid="draw-keys-notice-dismiss"]').click()
  await expect(notice).toHaveCount(0)
  // Another drawing, and a reload of the window: the profile remembers.
  await openDocument(window, await seedDrawDoc(window, v1Body([])))
  await expect(window.locator('[data-testid="draw-studio"]')).toBeVisible()
  await expect(notice).toHaveCount(0)
  expect(
    await window.evaluate(() => localStorage.getItem('fb.draw.illustratorKeysNotice.v1'))
  ).toBe('dismissed')
})

test('KEY-2 M, L and \\ draw a rectangle, an ellipse and a line; R, O and S pick Rotate, Reflect and Scale', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('m')
  await drag([60, 60], [200, 160])
  await window.keyboard.press('l')
  await drag([260, 60], [400, 160])
  await window.keyboard.press('Backslash')
  await drag([460, 60], [600, 160])
  // WP-TRANSFORM delivered Illustrator's R, O and S.
  for (const [k, tool] of [['r', 'rotate'], ['o', 'reflect'], ['s', 'scale']]) {
    await window.keyboard.press(k)
    await expect(toolPressed(tool)).toHaveAttribute('aria-pressed', 'true')
  }
  await window.keyboard.press('Shift+E')
  await expect(toolPressed('eraser')).toHaveAttribute('aria-pressed', 'true')
  await window.keyboard.press('k')
  await expect(toolPressed('bucket')).toHaveAttribute('aria-pressed', 'true')
  // Shift+M is Illustrator's Shape Builder: it must not fall through to M.
  await window.keyboard.press('Shift+M')
  await expect(toolPressed('bucket')).toHaveAttribute('aria-pressed', 'true')
  await waitForSave(window)
  expect((await objects(id)).map((o) => o.shapeKind)).toEqual(['rect', 'ellipse', 'line'])
})

test('KEY-3 ⌘D is Transform Again (it repeats the last transform), Duplicate is in the Edit menu, ⌘] and ⇧⌘A work', async () => {
  const id = await seedDrawDoc(
    window,
    v1Body([rectObject('a', 100, 100, 100, 100), rectObject('b', 300, 100, 100, 100)])
  )
  await openDocument(window, id)
  await click(150, 150)
  // Nothing transformed yet: ⌘D has nothing to repeat and duplicates nothing.
  await window.keyboard.press('Meta+d')
  await waitForSave(window)
  expect(await objects(id)).toHaveLength(2)
  await runMenu(window, 'edit', 'Duplicate')
  await waitForSave(window)
  expect(await objects(id)).toHaveLength(3)
  // The copy is selected; send it to the back with ⇧⌘[ and it leads the stack.
  const copyId = (await objects(id))[2].id
  await window.keyboard.press('Meta+Shift+BracketLeft')
  await waitForSave(window)
  expect((await objects(id))[0].id).toBe(copyId)
  // ⌥→ nudges a copy; ⌘D then repeats that (another copy, one step further).
  await window.keyboard.press('Alt+ArrowRight')
  await window.keyboard.press('Meta+d')
  await waitForSave(window)
  expect(await objects(id)).toHaveLength(5)
  await window.keyboard.press('Meta+Shift+a')
  await window.keyboard.press('Delete')
  await waitForSave(window)
  expect(await objects(id)).toHaveLength(5)
})

test('KEY-4 ⌥⇧⌘K lists every shortcut, searchable; a remapped key works and survives a reload', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('Meta+Alt+Shift+k')
  const dialog = window.locator('[data-testid="draw-shortcuts-dialog"]')
  await expect(dialog).toBeVisible()
  await expect(window.locator('[data-testid="draw-shortcut-row-tool:rect"]')).toContainText('M')
  await expect(
    window.locator('[data-testid="draw-shortcut-row-reserved:tool:gradient"]')
  ).toContainText('Arrives with gradients and patterns')
  await window.locator('[data-testid="draw-shortcuts-search"]').fill('⌘D')
  await expect(window.locator('[data-testid^="draw-shortcut-row-"]')).toHaveCount(1)
  await expect(
    window.locator('[data-testid="draw-shortcut-row-command:object.transformAgain"]')
  ).toBeVisible()
  await window.locator('[data-testid="draw-shortcuts-search"]').fill('')

  await window.locator('[data-testid="draw-shortcut-edit-tool:rect"]').click()
  await window.keyboard.press('v')
  await expect(window.locator('[data-testid="draw-shortcut-message"]')).toHaveText(
    'V is already used by the Select tool.'
  )
  await window.keyboard.press('g')
  await expect(window.locator('[data-testid="draw-shortcut-message"]')).toContainText(
    'Illustrator uses G for Gradient tool'
  )
  await expect(window.locator('[data-testid="draw-shortcuts-set"]')).toHaveText(
    'Illustrator defaults, changed'
  )
  await window.locator('[data-testid="draw-shortcuts-search"]').press('Escape')
  await window.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  await window.reload()
  await waitForReady(window)
  await openDocument(window, id)
  await window.keyboard.press('g')
  await expect(toolPressed('rect')).toHaveAttribute('aria-pressed', 'true')
  await expect(toolPressed('rect')).toHaveAttribute('title', 'Rectangle (G)')
  await drag([100, 100], [300, 250])
  await waitForSave(window)
  expect((await objects(id)).map((o) => o.shapeKind)).toEqual(['rect'])

  // Back to Illustrator's keys.
  await window.keyboard.press('Meta+Alt+Shift+k')
  await window.locator('[data-testid="draw-shortcuts-reset-all"]').click()
  await expect(window.locator('[data-testid="draw-shortcuts-set"]')).toHaveText(
    'Illustrator defaults'
  )
  expect(await window.evaluate(() => localStorage.getItem('fb.draw.keyOverrides.v1'))).toBeNull()
  await window.locator('[data-testid="draw-shortcuts-search"]').press('Escape')
  await window.keyboard.press('Escape')
})

test('KEY-5 typing on the canvas types: M, L, K, V and ⌘D in a text box never fire a shortcut', async () => {
  const id = await seedDrawDoc(window, v1Body([]))
  await openDocument(window, id)
  await window.keyboard.press('t')
  await click(100, 100)
  const editor = window.locator('[data-testid="draw-text-editor"]')
  await expect(editor).toBeFocused()
  await window.keyboard.type('mlkv')
  await window.keyboard.press('Meta+d')
  await window.keyboard.press('Backspace')
  await expect(editor).toHaveValue('mlk')
  await expect(toolPressed('select')).toHaveAttribute('aria-pressed', 'true')
  await click(700, 550)
  await expect(editor).toHaveCount(0)
  await waitForSave(window)
  expect((await objects(id)).map((o) => o.text)).toEqual(['mlk'])
})

test('KEY-6 the menus show Illustrator’s keys', async () => {
  await openDocument(window, await seedDrawDoc(window, v1Body([rectObject('a', 10, 10, 50, 50)])))
  const shortcuts = async (menu: string): Promise<string[]> => {
    await window.locator(`[data-testid="draw-studio-menubar-${menu}"]`).click()
    const out = await window
      .locator(`[data-testid="draw-studio-menubar-${menu}-list"] > button`)
      .evaluateAll((els) =>
        els.map(
          (e) =>
            `${(e.querySelector('span.flex-1')?.firstChild?.textContent ?? '').trim()}=${e.querySelector('span.fb-tabular')?.textContent ?? ''}`
        )
      )
    await window.keyboard.press('Escape')
    return out
  }
  expect(await shortcuts('edit')).toEqual([
    'Undo=⌘Z',
    'Redo=⇧⌘Z',
    'Select all=⌘A',
    'Deselect=⇧⌘A',
    'Duplicate=',
    'Delete=⌫',
    'Keyboard shortcuts…=⌥⇧⌘K'
  ])
  expect(await shortcuts('view')).toEqual([
    'Fit to window=⌘0',
    'Zoom to 100%=⌘1',
    "Grid=⌘'",
    'Snap to edges=⌘U'
  ])
})
