import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The unification, driven through the real app: a task filed on a desk is an
// item in Attention, and closing it from Attention is the same row the desk's
// task list reads.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('desk tasks appear in Attention and close to the same record', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const result = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Campaign desk' })
    const a = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Write the brief' })
    const b = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Book the shoot' })
    const sub = await api.nodes.create({ parentId: a.id, kind: 'task', title: 'Draft intro' })

    const before = await api.workItems.list()
    // Close one from the Attention side.
    await api.workItems.setState(a.id, 'completed')
    const after = await api.workItems.list()
    // ...and read it back through the NODE api, which is what the desk uses.
    const nodes = await api.nodes.list()
    const closed = nodes.find((n: { id: string }) => n.id === a.id)

    return {
      deskId: desk.id,
      aId: a.id,
      ids: before.map((i: { id: string }) => i.id),
      titles: before.map((i: { title: string }) => i.title),
      queueOf: before.map((i: { id: string; intentClass?: string }) => [i.id, i.intentClass]),
      statesBefore: before.map((i: { id: string; workItemState?: string }) => [i.id, i.workItemState]),
      statusAfterOnNode: closed?.status ?? null,
      stateAfterInAttention:
        after.find((i: { id: string }) => i.id === a.id)?.workItemState ?? null,
      subPresent: before.some((i: { id: string }) => i.id === sub.id),
      deskPresent: before.some((i: { id: string }) => i.id === desk.id),
      bId: b.id
    }
  })

  // Every task on the desk is an attention item...
  expect(result.titles).toContain('Write the brief')
  expect(result.titles).toContain('Book the shoot')
  // ...including subtasks, which are still work.
  expect(result.subPresent).toBe(true)
  // ...but the desk itself is not an item to be done.
  expect(result.deskPresent).toBe(false)

  // A desk task with no declared intent lands in To Do.
  expect(Object.fromEntries(result.queueOf)[result.aId]).toBe('to_do')
  expect(Object.fromEntries(result.statesBefore)[result.aId]).toBe('open')

  // Closing it in Attention is the same row the desk reads.
  expect(result.statusAfterOnNode).toBe('done')
  expect(result.stateAfterInAttention).toBe('completed')

  // One record: the attention item's id IS the task's id.
  expect(result.ids).toContain(result.aId)
})
