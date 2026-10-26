// Owner, 4.3.44:
//   "the embed should show just the file output itself, not the whole editor
//    ... a user should be able to enter an edit mode"            → EP-1
//   "remove it from the embed parent, without delete being the only option" → EP-2
//   "resize embedded things, similar to the Workcentre"           → EP-3
//   "remove things from Workcentre ... without delete"            → EP-4
//   "all edits persist between focus mode, the widget on a desk, the embed,
//    and by itself. It should save everywhere, not drop content." → EP-5..EP-7
//   "the default size of the embed should be the same as the content"  → EP-3, EP-8
import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, type LaunchedApp } from './_helpers'
import { MENU } from '../../src/shared/menus/lexicon'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

type Api = typeof window.api

async function go(window: Page, fn: string, id?: string): Promise<void> {
  await window.evaluate(
    ([f, i]) => (window as unknown as { __fbView: { getState: () => Record<string, (x?: string) => void> } }).__fbView.getState()[f](i),
    [fn, id] as const
  )
}

async function docWith(window: Page, title: string, widgetId: string, attrs: Record<string, unknown> = {}): Promise<string> {
  return window.evaluate(
    async ([t, wid, a]) => {
      const api = (window as unknown as { api: Api }).api
      const d = (await api.documents.create({
        docType: 'doc',
        title: t,
        body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Above the embed' }] }, { type: 'widgetEmbed', attrs: { widgetId: wid, ...a } }] }
      } as never)) as { id: string }
      return d.id
    },
    [title, widgetId, attrs] as const
  )
}

async function editToggle(window: Page): Promise<void> {
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await embed.hover()
  await embed.locator('[data-testid="embed-edit-toggle"]').click()
}

test('EP-1 an embedded diagram shows the diagram only; Edit opens the editor, Done returns to the output', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const docId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const map = (await api.documents.create({
      docType: 'map',
      title: 'Flow',
      body: { nodes: [{ id: 'a', x: 0, y: 0, label: 'Start here', shape: 'terminator', color: '#7c3aed' }, { id: 'b', x: 260, y: 0, label: 'Then this', shape: 'process', color: '#2563eb' }], edges: [{ id: 'e', source: 'a', target: 'b' }] }
    } as never)) as { id: string }
    const d = (await api.documents.create({ docType: 'doc', title: 'Host', body: { type: 'doc', content: [{ type: 'widgetEmbed', attrs: { widgetId: `doc:${map.id}` } }] } } as never)) as { id: string }
    return d.id
  })
  await go(window, 'goDocument', docId)
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await expect(embed.locator('[data-testid="embed-output"] img')).toBeVisible({ timeout: 10_000 })
  // No editor chrome at rest: no React Flow canvas, no menu bar.
  await expect(embed.locator('.react-flow')).toHaveCount(0)
  await expect(embed.getByRole('menubar')).toHaveCount(0)

  await editToggle(window)
  await expect(embed.locator('.react-flow')).toBeVisible({ timeout: 10_000 })
  await expect(embed.locator('[data-testid="embed-output"]')).toHaveCount(0)

  await editToggle(window) // Done
  await expect(embed.locator('[data-testid="embed-output"] img')).toBeVisible({ timeout: 10_000 })
})

test('EP-2 Remove takes the embed out of the document and leaves the original', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const fileId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    return ((await api.widgetFiles.create({ kind: 'sticky', content: 'Keep me' } as never, {} as never)) as { id: string }).id
  })
  const docId = await docWith(window, 'Remove host', `wf:${fileId}`)
  await go(window, 'goDocument', docId)
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await expect(embed).toBeVisible({ timeout: 10_000 })
  await embed.hover()
  await embed.locator('[data-testid="embed-remove"]').click()
  await expect(window.locator('[data-testid="widget-embed"]')).toHaveCount(0)
  const file = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Api }).api
    const f = await api.widgetFiles.get(id)
    return { exists: !!f, content: f?.content ?? null }
  }, fileId)
  expect(file).toEqual({ exists: true, content: 'Keep me' })
})

test('EP-3 an embed resizes from its corner and keeps that size after reopening', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const fileId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    return ((await api.widgetFiles.create({ kind: 'note', content: 'A note with some text' } as never, {} as never)) as { id: string }).id
  })
  const docId = await docWith(window, 'Resize host', `wf:${fileId}`)
  await go(window, 'goDocument', docId)
  const box = window.locator('[data-testid="embed-box"]').first()
  await expect(box).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(800)
  const corner = box.locator('[data-testid="embed-resize-corner"]')
  await corner.scrollIntoViewIfNeeded()
  const before = (await box.boundingBox())!
  const c = (await corner.boundingBox())!
  await window.mouse.move(c.x + c.width / 2, c.y + c.height / 2)
  await window.mouse.down()
  for (let i = 1; i <= 10; i++) await window.mouse.move(c.x + c.width / 2 - i * 12, c.y + c.height / 2 + i * 15)
  await window.mouse.up()
  await expect.poll(async () => (await box.boundingBox())!.height, { timeout: 3_000 }).toBeGreaterThan(before.height + 100)
  const resized = (await box.boundingBox())!

  await window.waitForTimeout(1500) // the document's save debounce
  await go(window, 'goHome')
  await go(window, 'goDocument', docId)
  const again = window.locator('[data-testid="embed-box"]').first()
  await expect(again).toBeVisible({ timeout: 10_000 })
  const after = (await again.boundingBox())!
  expect(Math.abs(after.height - resized.height), 'the height was not kept').toBeLessThan(4)
  expect(Math.abs(after.width - resized.width), 'the width was not kept').toBeLessThan(4)
})

test('EP-4 a Workcentre tile can be hidden without deleting it, and shown again', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, ids } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Hide desk' })
    const a = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Stays', x: 40, y: 40, width: 240, height: 200 } as never)) as { id: string }
    const b = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Hide me', x: 320, y: 40, width: 240, height: 200 } as never)) as { id: string }
    return { taskId: task.id, ids: [a.id, b.id] }
  })
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await go(window, 'goTask', taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  await window.locator('[data-testid="view-selector-btn"]').first().click()
  await window.locator('[data-testid="view-opt-workcentre"]').click()
  await expect(window.locator(`[data-testid="workcentre-tile-${ids[1]}"]`)).toBeVisible({ timeout: 10_000 })

  await window.locator(`[data-testid="workcentre-hide-${ids[1]}"]`).click()
  await expect(window.locator(`[data-testid="workcentre-tile-${ids[1]}"]`)).toHaveCount(0)
  await expect(window.locator(`[data-testid="workcentre-tile-${ids[0]}"]`)).toBeVisible()
  const still = await window.evaluate(async ([t, id]) => {
    const api = (window as unknown as { api: Api }).api
    return (await api.widgets.listByTask(t)).some((w) => w.id === id && !w.archived)
  }, [taskId, ids[1]] as const)
  expect(still, 'hiding deleted the widget').toBe(true)

  await window.locator('[data-testid="workcentre-show-hidden"]').click()
  await expect(window.locator(`[data-testid="workcentre-tile-${ids[1]}"]`)).toBeVisible({ timeout: 5_000 })
})

test('EP-5 a work widget file: changes elsewhere show in the embed, and editing there keeps them', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const fileId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    return ((await api.widgetFiles.create({ kind: 'sticky', content: 'First line' } as never, {} as never)) as { id: string }).id
  })
  const docId = await docWith(window, 'File host', `wf:${fileId}`)
  await go(window, 'goDocument', docId)
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await expect(embed).toContainText('First line', { timeout: 10_000 })

  // Edited somewhere else (Focus mode, a desk, the full-pane view all write here).
  await window.evaluate(async (id) => {
    const w = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: { content: string }) => Promise<unknown> } } }).__fbWidgets
    await w.getState().update(`wf:${id}`, { content: 'First line\nAdded elsewhere' })
  }, fileId)
  await expect(embed, 'the embed showed a stale copy').toContainText('Added elsewhere', { timeout: 5_000 })

  // Now edit in the embed: it must start from the newer content, not overwrite it.
  await editToggle(window)
  await embed.locator('.fb-sticky-rendered').first().click()
  const ta = embed.locator('textarea').first()
  await expect(ta).toBeVisible({ timeout: 5_000 })
  await ta.press('End')
  await ta.press('Meta+ArrowDown')
  await ta.type('\nAdded in the embed')
  await window.waitForTimeout(1200)
  await editToggle(window) // Done

  await expect
    .poll(async () => window.evaluate(async (id) => (await (window as unknown as { api: Api }).api.widgetFiles.get(id))?.content ?? '', fileId), { timeout: 5_000 })
    .toContain('Added in the embed')
  const saved = await window.evaluate(async (id) => (await (window as unknown as { api: Api }).api.widgetFiles.get(id))?.content ?? '', fileId)
  expect(saved, 'the embed overwrote the change made elsewhere').toContain('Added elsewhere')
  expect(saved).toContain('First line')
})

test('EP-6 a desk widget: an edit on the desk shows in the embed, and an edit in the embed shows on the desk and in Focus mode', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { taskId, wid } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Persist desk' })
    const w = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Desk start', x: 80, y: 80, width: 260, height: 220 } as never)) as { id: string }
    return { taskId: task.id, wid: w.id }
  })
  // Edited on the desk first.
  await window.evaluate(async (id) => {
    await (window as unknown as { api: Api }).api.widgets.update(id, { content: 'Desk start\nEdited on the desk' } as never)
  }, wid)
  const docId = await docWith(window, 'Desk widget host', wid)
  await go(window, 'goDocument', docId)
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await expect(embed).toContainText('Edited on the desk', { timeout: 10_000 })
  // Changed on the desk while the embed is on screen: the embed follows.
  await window.evaluate(async (id) => {
    const w = (window as unknown as { __fbWidgets: { getState: () => { update: (id: string, p: { content: string }) => Promise<unknown> } } }).__fbWidgets
    await w.getState().update(id, { content: 'Desk start\nEdited on the desk\nWhile it was open' })
  }, wid)
  await expect(embed, 'the embed showed a stale copy').toContainText('While it was open', { timeout: 5_000 })

  await editToggle(window)
  await embed.locator('.fb-sticky-rendered').first().click()
  const ta = embed.locator('textarea').first()
  await expect(ta).toBeVisible({ timeout: 5_000 })
  await ta.press('Meta+ArrowDown')
  await ta.type('\nEdited in the embed')
  await window.waitForTimeout(1200)
  await editToggle(window)

  await expect
    .poll(async () => window.evaluate(async ([t, id]) => (await (window as unknown as { api: Api }).api.widgets.listByTask(t)).find((w) => w.id === id)?.content ?? '', [taskId, wid] as const), { timeout: 5_000 })
    .toContain('Edited in the embed')

  // On the desk, and in Focus mode, the same content.
  await suppressFeatureSpotlights(window)
  await go(window, 'goTask', taskId)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
  const onDesk = window.locator(`[data-widget-id="${wid}"]`).first()
  await expect(onDesk).toContainText('Edited in the embed', { timeout: 10_000 })
  await expect(onDesk).toContainText('Edited on the desk')
  await window.evaluate((id) => (window as unknown as { __fbWidgets: { getState: () => { setFocused: (i: string) => void } } }).__fbWidgets.getState().setFocused(id), wid)
  const focus = window.locator('[data-testid="widget-focus-mode"]')
  await expect(focus).toContainText('Edited in the embed', { timeout: 10_000 })

  // And back the other way: an edit made in Focus mode shows in the embed.
  await focus.locator('.fb-sticky-rendered').first().click()
  const fta = focus.locator('textarea').first()
  await expect(fta).toBeVisible({ timeout: 5_000 })
  await fta.press('Meta+ArrowDown')
  await fta.type('\nEdited in Focus mode')
  await window.waitForTimeout(1200)
  await focus.getByRole('button', { name: 'Close full view' }).first().click()
  await expect(focus).toHaveCount(0)
  await go(window, 'goDocument', docId)
  const embedAgain = window.locator('[data-testid="widget-embed"]').first()
  await expect(embedAgain).toContainText('Edited in Focus mode', { timeout: 10_000 })
  await expect(embedAgain).toContainText('Edited in the embed')
  await expect(embedAgain).toContainText('Edited on the desk')
  await expect(embedAgain).toContainText('While it was open')
})

test('EP-7 an embedded spreadsheet edited in place shows the value when opened on its own', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const sheetId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const s = (await api.documents.create({ docType: 'sheet', title: 'Numbers', body: { version: 2, activeSheet: 0, sheets: [{ id: 't1', name: 'Sheet1', columns: ['A', 'B'], rows: [['Item', 'Amount'], ['Rent', '1200']] }] } } as never)) as { id: string }
    return s.id
  })
  const docId = await docWith(window, 'Sheet host', `doc:${sheetId}`)
  await go(window, 'goDocument', docId)
  const embed = window.locator('[data-testid="widget-embed"]').first()
  await expect(embed.locator('[data-testid="embed-output"]')).toBeVisible({ timeout: 10_000 })
  await editToggle(window)
  await expect(embed.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 10_000 })
  await embed.locator('[data-testid="sheet-grid"]').click({ position: { x: 60, y: 70 } })
  await window.keyboard.type('Power 310')
  await window.keyboard.press('Enter')
  await window.waitForTimeout(1500)
  await editToggle(window)

  await expect
    .poll(async () => window.evaluate(async (id) => JSON.stringify((await (window as unknown as { api: Api }).api.documents.get(id))?.body ?? ''), sheetId), { timeout: 8_000 })
    .toContain('Power 310')
  await go(window, 'goDocument', sheetId)
  await expect(window.locator('[data-testid="sheet-grid"]').first()).toContainText('Power 310', { timeout: 10_000 })
})

test('EP-8 a work widget inserted into a deck takes the shape of its content, not a fixed box', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)
  const { wid, deckId } = await window.evaluate(async () => {
    const api = (window as unknown as { api: Api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Tall sticky desk' })
    // Twice as tall as it is wide.
    const w = (await api.widgets.create({ taskId: task.id, kind: 'sticky', content: 'Tall', x: 40, y: 40, width: 200, height: 400 } as never)) as { id: string }
    const deck = (await api.documents.create({ docType: 'slides', title: 'Shape deck', body: { slides: [{ id: 's1', notes: '', elements: [] }] } } as never)) as { id: string }
    return { wid: w.id, deckId: deck.id }
  })
  await go(window, 'goDocument', deckId)
  await expect(window.locator('[data-testid="slide-canvas"]')).toBeVisible({ timeout: 10_000 })
  await window.locator('[data-testid="slides-menubar-insert"]').click()
  await window.locator('[data-testid="slides-menubar-insert-list"]').getByRole('button', { name: MENU.workWidgetFromDesk.label }).click()
  await expect(window.locator('[data-testid="widget-picker"]')).toBeVisible({ timeout: 5_000 })
  await window.locator(`[data-testid="widget-picker-item-${wid}"]`).click()

  await expect
    .poll(
      async () =>
        window.evaluate(async (id) => {
          const d = (await (window as unknown as { api: Api }).api.documents.get(id)) as { body: { slides: Array<{ elements?: Array<{ type: string; w: number; h: number }> }> } } | null
          const e = d?.body.slides[0]?.elements?.find((x) => x.type === 'widget')
          return e ? `${e.w}x${e.h}` : ''
        }, deckId),
      { timeout: 8_000 }
    )
    .not.toBe('')
  const size = await window.evaluate(async (id) => {
    const d = (await (window as unknown as { api: Api }).api.documents.get(id)) as { body: { slides: Array<{ elements?: Array<{ type: string; w: number; h: number }> }> } } | null
    return d!.body.slides[0]!.elements!.find((x) => x.type === 'widget')!
  }, deckId)
  // Tall content: taller than wide, at the content's 2:1, inside the slide.
  expect(size.h, `placed at ${size.w}x${size.h}`).toBeGreaterThan(size.w)
  expect(size.h / size.w).toBeCloseTo(2, 1)
  expect(size.h).toBeLessThanOrEqual(720)
})
