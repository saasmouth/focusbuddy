import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// The reported context-menu bugs: clicking outside did not dismiss the menu (you
// had to press Esc), and re-opening stacked extra instances. Root cause was the
// dismiss listener re-arming its 50ms timer on every parent re-render so it
// often never attached. We verify a single menu opens, re-opening replaces
// rather than stacks, and a click outside dismisses it.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedSticky(l: LaunchedApp): Promise<string> {
  const { window } = l
  await waitForReady(window)
  const id = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const t = await api.nodes.create({ parentId: null, kind: 'task', title: 'CtxDismissTest' })
    const w = await api.widgets.create({
      taskId: t.id,
      kind: 'sticky',
      title: '',
      content: 'hello world',
      x: 200,
      y: 200,
      width: 240,
      height: 200
    })
    return w.id
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /CtxDismissTest/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 8000 })
  await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 8000 })
  return id
}

const menuCount = async (l: LaunchedApp): Promise<number> =>
  l.window.locator('[data-canvas-ctx-menu]').count()

async function openHeaderMenu(l: LaunchedApp, id: string, x: number): Promise<void> {
  await l.window.click(`[data-widget-id="${id}"] .widget-handle`, { button: 'right', position: { x, y: 8 } })
  await l.window.waitForSelector('[data-canvas-ctx-menu]', { timeout: 4000 })
  await l.window.waitForTimeout(120) // let the dismiss listener arm (50ms)
}

test('CTX-1 — re-opening the menu does not stack instances', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const id = await seedSticky(launched)
  await openHeaderMenu(launched, id, 80)
  expect(await menuCount(launched)).toBe(1)
  // Right-click the header again WITHOUT pressing Esc. The first menu covers the
  // header on screen, so dispatch the contextmenu directly (this is exactly what
  // a real second right-click at an uncovered spot does). Must reposition to ONE
  // menu, not stack a second.
  await window.evaluate((wid) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`) as HTMLElement
    h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 90, clientY: 90, button: 2 }))
  }, id)
  await window.waitForTimeout(350)
  expect(await menuCount(launched)).toBe(1)
})

test('CTX-2 — clicking outside dismisses the menu', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const id = await seedSticky(launched)
  await openHeaderMenu(launched, id, 80)
  expect(await menuCount(launched)).toBe(1)

  // Click a point definitely outside the menu rect (and on the canvas surface).
  const pt = await window.evaluate(() => {
    const el = document.querySelector('[data-canvas-ctx-menu]') as HTMLElement
    const r = el.getBoundingClientRect()
    // Left of the menu if there is room, else right of it; vertically centred.
    const x = r.left > 120 ? r.left - 60 : Math.min(window.innerWidth - 20, r.right + 60)
    return { x: Math.round(x), y: Math.round(r.top + r.height / 2) }
  })
  await window.mouse.click(pt.x, pt.y)
  await window.waitForTimeout(300)
  expect(await menuCount(launched)).toBe(0)
})
