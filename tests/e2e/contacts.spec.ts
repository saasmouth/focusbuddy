import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// A contact is a record and a desk link is a link. The behaviour that matters:
// the same person can be on several desks, and taking them off one must not
// erase them from the others.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a contact is shared across desks, and unlinking is not deleting', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const deskA = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk A' })
    const deskB = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk B' })

    const sarah = await api.contacts.create({
      name: 'Sarah Whitfield',
      email: 'sarah@example.com',
      role: 'Conveyancer',
      kind: 'guest',
      nodeId: deskA.id
    })
    // The same record put on a second desk.
    await api.contacts.link(sarah.id, deskB.id)

    const onA = await api.contacts.listForNode(deskA.id)
    const onB = await api.contacts.listForNode(deskB.id)
    const desks = await api.contacts.desks(sarah.id)

    // Take her off A only.
    await api.contacts.unlink(sarah.id, deskA.id)
    const afterA = await api.contacts.listForNode(deskA.id)
    const afterB = await api.contacts.listForNode(deskB.id)
    const stillExists = (await api.contacts.list()).some(
      (c: { id: string }) => c.id === sarah.id
    )

    return {
      sarahId: sarah.id,
      onA: onA.map((c: { id: string }) => c.id),
      onB: onB.map((c: { id: string }) => c.id),
      deskCount: desks.length,
      afterA: afterA.length,
      afterB: afterB.length,
      stillExists,
      kind: sarah.kind,
      role: sarah.role
    }
  })

  expect(r.onA).toContain(r.sarahId)
  expect(r.onB).toContain(r.sarahId)
  // One record, two desks — not two rows.
  expect(r.deskCount).toBe(2)
  expect(r.kind).toBe('guest')
  expect(r.role).toBe('Conveyancer')

  expect(r.afterA).toBe(0)
  // Off one desk, still on the other, and still a contact.
  expect(r.afterB).toBe(1)
  expect(r.stillExists).toBe(true)
})

test('deleting a contact removes it everywhere, and linking twice is a no-op', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk' })
    const c = await api.contacts.create({ name: 'David Chen', kind: 'guest', nodeId: desk.id })
    await api.contacts.link(c.id, desk.id)
    await api.contacts.link(c.id, desk.id)
    const once = await api.contacts.listForNode(desk.id)
    await api.contacts.remove(c.id)
    return {
      duplicates: once.length,
      afterDelete: (await api.contacts.listForNode(desk.id)).length,
      gone: !(await api.contacts.list()).some((x: { id: string }) => x.id === c.id)
    }
  })

  // Putting somebody on a desk twice is a no-op, not a second row.
  expect(r.duplicates).toBe(1)
  expect(r.afterDelete).toBe(0)
  expect(r.gone).toBe(true)
})

test('the contacts widget shows the desk’s people and an honest empty state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const deskId = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'People desk' })
    await api.widgets.create({
      taskId: desk.id, kind: 'contacts' as never, title: 'Contacts',
      content: '', x: 120, y: 120, width: 360, height: 320
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
  await expect(widget).toContainText('Nobody on this desk yet')

  // Add one through the real API; the widget reads the same store.
  await window.evaluate(async (id) => {
    const api = (window as unknown as { api: Record<string, any> }).api
    await api.contacts.create({ name: 'Emma Wilson', role: 'Vendor', kind: 'guest', nodeId: id })
  }, deskId)
  await window.reload()
  await waitForReady(window)
  await window.evaluate((id) => {
    const w = window as unknown as { __fbView?: { getState: () => { goTask: (i: string) => void } } }
    w.__fbView?.getState().goTask(id)
  }, deskId)
  await expect(window.locator('[data-widget-kind="contacts"]').first()).toContainText('Emma Wilson', {
    timeout: 10_000
  })
})

test('deleting a desk removes the people FROM it, never the people', async () => {
  // This is the claim the ciDeleteSiteLock pin makes about contact_links'
  // ON DELETE CASCADE. Asserting it in a comment is not the same as proving it.
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const deskA = await api.nodes.create({ parentId: null, kind: 'task', title: 'Doomed desk' })
    const deskB = await api.nodes.create({ parentId: null, kind: 'task', title: 'Surviving desk' })
    const c = await api.contacts.create({ name: 'Priya Nair', kind: 'guest', nodeId: deskA.id })
    await api.contacts.link(c.id, deskB.id)

    await api.nodes.deletePermanent(deskA.id)

    return {
      contactStillExists: (await api.contacts.list()).some((x: { id: string }) => x.id === c.id),
      stillOnB: (await api.contacts.listForNode(deskB.id)).length,
      desks: (await api.contacts.desks(c.id)).length
    }
  })

  expect(r.contactStillExists).toBe(true)
  expect(r.stillOnB).toBe(1)
  // The link to the deleted desk is gone; the one to the surviving desk is not.
  expect(r.desks).toBe(1)
})
