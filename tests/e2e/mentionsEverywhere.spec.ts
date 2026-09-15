import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// @ is not a sticky feature. Every prose field offers it, and a reference
// typed into any of them is the same record.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function seed(window: LaunchedApp['window'], kinds: string[]) {
  return window.evaluate(async (ks) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Writing desk' })
    let x = 80
    for (const k of ks) {
      await api.widgets.create({
        taskId: desk.id,
        kind: k as never,
        title: '',
        // The card stores JSON; an empty string is not a card.
        content: k === 'card' ? JSON.stringify({ title: 'Card', body: '', accent: '#6366f1' }) : '',
        x,
        y: 80,
        width: 340,
        height: 260
      })
      x += 380
    }
    return desk.id
  }, kinds)
}

async function open(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
}

// The prose widgets that should all behave identically.
for (const kind of ['note', 'card', 'sticky']) {
  test(`@ offers candidates in a ${kind} widget`, async () => {
    launched = await launchApp()
    const { window } = launched
    await waitForReady(window)
    const deskId = await seed(window, [kind])
    await open(window, deskId)

    const widget = window.locator(`[data-widget-kind="${kind}"]`).first()
    await expect(widget).toBeVisible({ timeout: 10_000 })

    // Each of these opens its editor on click; the sticky starts in one.
    const box = widget.locator('textarea').first()
    if ((await box.count()) === 0) {
      await widget.click()
    }
    const field = widget.locator('textarea').first()
    await expect(field).toBeVisible({ timeout: 5000 })
    await field.click()
    await field.type('see @ridge')

    await expect(window.locator('[data-testid="mention-picker"]')).toBeVisible({ timeout: 5000 })
    await expect(window.locator('[data-testid="mention-picker"]')).toContainText('Ridgeway Campaign')
  })
}

test('@ offers candidates in a task’s notes', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Task desk' })
    await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'NOTEDTASK' })
    await api.widgets.create({
      taskId: desk.id, kind: 'task-list' as never, title: 'Tasks',
      content: '', x: 100, y: 100, width: 460, height: 420
    })
    return desk.id
  })
  await open(window, deskId)

  const widget = window.locator('[data-widget-kind="task-list"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByText('NOTEDTASK').click()

  const notes = widget.locator('textarea').first()
  await expect(notes).toBeVisible({ timeout: 5000 })
  await notes.click()
  await notes.type('about @ridge')
  await expect(window.locator('[data-testid="mention-picker"]')).toBeVisible({ timeout: 5000 })
})

test('@ works in a rich-text document, and the link navigates', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const target = await api.nodes.create({ parentId: null, kind: 'task', title: 'Ridgeway Campaign' })
    const doc = await api.documents.create({ docType: 'doc', title: 'Brief' })
    return { targetId: target.id, docId: doc.id }
  })

  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goDocument: (i: string) => void } } }
    w.__fbView?.getState().goDocument(id)
  }, ids.docId)
  await window.waitForTimeout(2500)

  const body = window.locator('.ProseMirror').first()
  await expect(body).toBeVisible({ timeout: 15_000 })
  await body.click()
  await window.keyboard.type('see @ridge')

  const picker = window.locator('[data-testid="mention-picker"]')
  await expect(picker).toBeVisible({ timeout: 5000 })
  await expect(picker).toContainText('Ridgeway Campaign')

  await picker.getByText('Ridgeway Campaign').click()
  await window.waitForTimeout(500)

  // It becomes a real link, so it renders, copies and exports with no special
  // handling — and it carries the plexii href.
  const href = await window.evaluate(
    () =>
      (document.querySelector('.ProseMirror a[href^="plexii://"]') as HTMLAnchorElement | null)
        ?.getAttribute('href') ?? null
  )
  expect(href).toContain(`plexii://desk/${ids.targetId}`)

  // And clicking it goes there, rather than opening the link-edit popover.
  await window.locator('.ProseMirror a[href^="plexii://"]').first().click()
  await window.waitForTimeout(800)
  const view = await window.evaluate(() => {
    const w = window as unknown as { __fbView?: { getState: () => { view: { taskId?: string } } } }
    return w.__fbView?.getState().view
  })
  expect(view?.taskId).toBe(ids.targetId)
})
