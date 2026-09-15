import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Contacts should fill themselves in from what the workspace already knows.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('suggests people from task assignees, each saying why, and adds one', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'People desk' })
    const a = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Shoot' })
    const b = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Copy' })
    await api.nodes.update(a.id, { assignee: 'Priya Nair' })
    await api.nodes.update(b.id, { assignee: 'Priya Nair' })
    await api.widgets.create({
      taskId: desk.id, kind: 'contacts' as never, title: 'People',
      content: '', x: 100, y: 100, width: 400, height: 380
    })
    return desk.id
  })

  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)

  const widget = window.locator('[data-widget-kind="contacts"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  // The suggestions live in the add panel.
  await widget.getByTitle('Add someone').click()

  const sugg = widget.getByTestId('contact-suggestions')
  await expect(sugg).toBeVisible({ timeout: 5000 })
  await expect(sugg).toContainText('Priya Nair')
  // The reason is always shown — a suggestion without provenance is
  // indistinguishable from an invented person.
  await expect(sugg).toContainText('assigned 2 tasks here')

  await sugg.getByText('Priya Nair').click()
  await window.waitForTimeout(800)

  const stored = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const list = await api.contacts.listForNode(id)
    return list.map((c: { name: string; notes: string | null }) => ({ name: c.name, notes: c.notes }))
  }, deskId)
  expect(stored).toHaveLength(1)
  expect(stored[0].name).toBe('Priya Nair')
  // Where it came from is kept on the record.
  expect(stored[0].notes).toContain('task')

  // She is now a contact on the desk...
  await expect(widget).toContainText('Priya Nair')
  // ...and no longer suggested. With nothing left to suggest the block is
  // removed entirely rather than left as an empty heading.
  await expect(widget.getByTestId('contact-suggestions')).toHaveCount(0)
})

test('an address can be saved and reads back', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk' })
    const c = await api.contacts.create({
      name: 'Sarah Whitfield',
      email: 'sarah@example.com',
      address: '12 Ridge St\nDover Heights NSW 2030',
      nodeId: desk.id
    })
    const back = (await api.contacts.list()).find((x: { id: string }) => x.id === c.id)
    await api.contacts.update(c.id, { address: '9 New Rd' })
    const after = (await api.contacts.list()).find((x: { id: string }) => x.id === c.id)
    return { created: back?.address, updated: after?.address }
  })

  expect(r.created).toBe('12 Ridge St\nDover Heights NSW 2030')
  expect(r.updated).toBe('9 New Rd')
})
