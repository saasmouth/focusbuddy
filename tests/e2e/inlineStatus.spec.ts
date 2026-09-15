import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

// The reported bug, end to end: an inline status change has to stick.

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) {
    await launched.dispose()
    launched = null
  }
})

test('a status set inline survives, and a direct status write does not leave a stale state', async () => {
  launched = await launchApp()
  const { window } = launched
  await waitForReady(window)

  const r = await window.evaluate(async () => {
    const api = (window as unknown as { api: Record<string, any> }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'Desk' })
    const t = await api.nodes.create({ parentId: desk.id, kind: 'task', title: 'Task' })

    // Waiting and blocked both coarsen to 'open' — the case that used to be lost.
    await api.workItems.setState(t.id, 'waiting')
    const afterWaiting = (await api.workItems.list()).find((i: { id: string }) => i.id === t.id)

    await api.workItems.setState(t.id, 'blocked')
    const afterBlocked = (await api.workItems.list()).find((i: { id: string }) => i.id === t.id)

    // Now set the status DIRECTLY, the way the task table or calendar does.
    // The finer state must not survive if it no longer agrees.
    await api.nodes.update(t.id, { status: 'done' })
    const afterDirect = (await api.workItems.list()).find((i: { id: string }) => i.id === t.id)
    const node = (await api.nodes.list()).find((n: { id: string }) => n.id === t.id)

    return {
      waiting: afterWaiting?.workItemState,
      waitingStatus: afterWaiting?.status,
      blocked: afterBlocked?.workItemState,
      afterDirectState: afterDirect?.workItemState,
      afterDirectStatus: node?.status
    }
  })

  // The bug: these used to read back as 'open'.
  expect(r.waiting).toBe('waiting')
  expect(r.blocked).toBe('blocked')
  // ...while the coarse projection stays truthful.
  expect(r.waitingStatus).toBe('open')

  // A direct status write clears a state that no longer projects to it, so the
  // row never holds two answers.
  expect(r.afterDirectStatus).toBe('done')
  expect(r.afterDirectState).toBe('completed')
})
