import { test, expect } from '@playwright/test'
import { launchApp, type LaunchedApp, waitForReady } from './_helpers'

// Canvas multi-select:
//   • Shift+click a widget toggles it in the selection.
//   • Shift+drag a marquee over the desk selects everything it overlaps.
//   • The floating selection toolbar offers Group-into-section / Duplicate /
//     Delete / Clear; ⌘/Ctrl+A selects all, Esc clears.
//   • "Group into section" wraps the selected widgets in a new section.

let launched: LaunchedApp | null = null

test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seedStickiesAndOpen(
  l: LaunchedApp,
  positions: Array<{ x: number; y: number }>
): Promise<{ taskId: string; ids: string[] }> {
  const { window } = l
  await waitForReady(window)
  const seeded = await window.evaluate(async (pts: Array<{ x: number; y: number }>) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Multiselect test' })
    const ids: string[] = []
    for (let i = 0; i < pts.length; i++) {
      const w = await api.widgets.create({
        taskId: task.id,
        kind: 'sticky',
        title: `s${i}`,
        content: `s${i}`,
        x: pts[i].x,
        y: pts[i].y,
        width: 160,
        height: 120
      })
      ids.push(w.id)
    }
    return { taskId: task.id, ids }
  }, positions)

  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /Multiselect test/ }).first().click()
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 5_000 })
  for (const id of seeded.ids) {
    await window.waitForSelector(`[data-widget-id="${id}"]`, { timeout: 5_000 })
  }
  await window.waitForTimeout(250)
  return seeded
}

async function shiftClick(l: LaunchedApp, id: string): Promise<void> {
  // Real Shift+mousedown→mouseup on the HEADER (react-rnd's drag handle), at the
  // title (left) area — the header CENTRE is an icon button, so we target the
  // left. This is the exact gesture a user makes and, unlike a synthetic click,
  // exercises react-rnd's onDragStart path (where header shift-select is wired).
  const pt = await l.window.evaluate((wid: string) => {
    const h = document.querySelector(`[data-widget-id="${wid}"] .widget-handle`)
    const target = h ?? document.querySelector(`[data-widget-id="${wid}"]`)
    const b = (target as HTMLElement).getBoundingClientRect()
    return { x: b.left + 26, y: b.top + (h ? b.height / 2 : 44) }
  }, id)
  await l.window.keyboard.down('Shift')
  await l.window.mouse.click(pt.x, pt.y)
  await l.window.keyboard.up('Shift')
  await l.window.waitForTimeout(150)
}

async function stickiesOf(
  l: LaunchedApp,
  taskId: string
): Promise<Array<{ id: string; kind: string; parentSectionId: string | null; x: number; y: number }>> {
  return l.window.evaluate(async (tid: string) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const all = await api.widgets.listByTask(tid)
    return all.map((w) => ({
      id: w.id,
      kind: w.kind,
      parentSectionId: w.parentSectionId ?? null,
      x: w.x,
      y: w.y
    }))
  }, taskId)
}

test('shift+click selects two widgets and the toolbar shows the count', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { ids } = await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 360, y: 120 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  const toolbarText = await window.evaluate(() => document.body.innerText)
  expect(toolbarText).toContain('2 selected')
})

test('Group into section wraps the shift-selected widgets in a new section', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedStickiesAndOpen(launched, [
    { x: 140, y: 140 },
    { x: 380, y: 160 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  // Click the toolbar's "Group into a section" button.
  const clicked = await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      'button[title="Group into a section"]'
    )
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(500)

  const widgets = await stickiesOf(launched, taskId)
  const section = widgets.find((w) => w.kind === 'section')
  expect(section).toBeTruthy()
  // Both stickies now belong to the new section.
  const stickies = widgets.filter((w) => w.kind === 'sticky')
  expect(stickies.length).toBe(2)
  for (const s of stickies) expect(s.parentSectionId).toBe(section!.id)
})

test('Delete removes every selected widget', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 360, y: 120 }
  ])

  await shiftClick(launched, ids[0])
  await shiftClick(launched, ids[1])

  const clicked = await window.evaluate(() => {
    const btn = document.querySelector<HTMLButtonElement>('button[aria-label="Delete selected"]')
    if (!btn) return false
    btn.click()
    return true
  })
  expect(clicked).toBe(true)
  await window.waitForTimeout(500)

  const widgets = await stickiesOf(launched, taskId)
  expect(widgets.filter((w) => w.kind === 'sticky').length).toBe(0)
})

test('Cmd+A selects all desk widgets; Esc clears the selection', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 360, y: 120 },
    { x: 600, y: 120 }
  ])

  await window.evaluate(() => {
    document.body.focus()
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true })
    )
  })
  await window.waitForTimeout(150)
  expect(await window.evaluate(() => document.body.innerText)).toContain('3 selected')

  await window.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await window.waitForTimeout(150)
  expect(await window.evaluate(() => document.body.innerText)).not.toContain('selected')
})

test('shift+drag marquee selects the widgets it overlaps', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  await seedStickiesAndOpen(launched, [
    { x: 120, y: 120 },
    { x: 360, y: 140 }
  ])

  // Drag a Shift+marquee from an empty top-left corner across both stickies.
  await window.evaluate(() => {
    const surf = document.querySelector('[data-canvas-surface="true"]') as HTMLElement
    const r = surf.getBoundingClientRect()
    const opts = (cx: number, cy: number, shift: boolean) => ({
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerId: 1,
      shiftKey: shift,
      clientX: r.left + cx,
      clientY: r.top + cy
    })
    surf.dispatchEvent(new PointerEvent('pointerdown', opts(20, 20, true)))
    surf.dispatchEvent(new PointerEvent('pointermove', opts(600, 420, true)))
    surf.dispatchEvent(new PointerEvent('pointerup', opts(600, 420, false)))
  })
  await window.waitForTimeout(200)

  expect(await window.evaluate(() => document.body.innerText)).toContain('2 selected')
})
