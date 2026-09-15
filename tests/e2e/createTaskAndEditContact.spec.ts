import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// Two reported faults: no way to create a plain TASK from the app chrome (it
// always made a desk), and no way to EDIT a contact at all.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

async function openDesk(window: LaunchedApp['window'], deskId: string): Promise<void> {
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  await window.waitForTimeout(1200)
}

test('the new-task dialog can make a task on the current desk, not only a desk', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    return (await api.nodes.create({ parentId: null, kind: 'task', title: 'Home desk' })).id
  })
  await openDesk(window, deskId)

  await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:command-new-task')))
  const placement = window.getByTestId('newnode-placement')
  await expect(placement).toBeVisible({ timeout: 5000 })
  await expect(placement).toContainText('Home desk')

  await window.getByTestId('newnode-this-desk').click()
  await window.getByTestId('newnode-name').fill('A REAL TASK')
  await window.getByRole('button', { name: /Create/ }).first().click()
  await window.waitForTimeout(1200)

  const made = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const all = await api.nodes.list()
    const t = all.find((n: { title: string }) => n.title === 'A REAL TASK')
    return { found: Boolean(t), parentId: t?.parentId ?? null, deskId: id }
  }, deskId)

  expect(made.found).toBe(true)
  // The point: it is a task ON the desk, not another top-level desk.
  expect(made.parentId).toBe(made.deskId)
})

test('a contact can be edited, and the change sticks', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'People desk' })
    const c = await api.contacts.create({
      name: 'Sarah Whitfeld', // misspelt on purpose
      email: 'sarah@x.com',
      nodeId: desk.id
    })
    await api.widgets.create({
      taskId: desk.id, kind: 'contacts' as never, title: 'People',
      content: '', x: 100, y: 100, width: 400, height: 380
    })
    return { deskId: desk.id, contactId: c.id }
  })
  await openDesk(window, ids.deskId)

  const widget = window.locator('[data-widget-kind="contacts"]').first()
  await expect(widget).toBeVisible({ timeout: 10_000 })
  await widget.getByText('Sarah Whitfeld').click()
  await widget.getByTestId('contact-edit-open').click()

  const form = widget.getByTestId('contact-edit')
  await expect(form).toBeVisible()
  await form.getByPlaceholder('Name').fill('Sarah Whitfield')
  await form.getByPlaceholder('Phone').fill('0412 345 678')
  await form.getByPlaceholder('Address').fill('12 Ridge St')
  await widget.getByTestId('contact-edit-save').click()
  await window.waitForTimeout(900)

  const stored = await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const c = (await api.contacts.list()).find((x: { id: string }) => x.id === id)
    return { name: c?.name, phone: c?.phone, address: c?.address, email: c?.email }
  }, ids.contactId)

  expect(stored.name).toBe('Sarah Whitfield')
  expect(stored.phone).toBe('0412 345 678')
  expect(stored.address).toBe('12 Ridge St')
  // Untouched fields survive an edit.
  expect(stored.email).toBe('sarah@x.com')
})
