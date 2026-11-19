// Pasting a list into a task list (owner, 2026-11-19: "check for similar issues
// with all other widgets and fix").
//
//   TL-1  On a desk's task list, paste lines (a bullet, a ticked one) into "Add
//         a task": one task per line, marks gone, the ticked one done. One ⌘Z
//         takes them all away. (Several lines used to make ONE task.)
//   TL-2  The same in a list of its own ("Tasks"): one item per line, one ⌘Z.
//   TL-3  On the Free plan every task is a desk and three is the limit: a
//         longer paste adds what fits, offers the upgrade, and leaves nothing
//         half-typed in the box.
//
// The clipboard is the test's own (_clipboardStub.ts), never the system one.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, setStubClipboard, MOD } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const LIST = '- Buy milk\n2. Call Ann\n[x] Renew passport\n• Pack\n\n* Book flights'

async function openDesk(l: LaunchedApp, content: string): Promise<{ deskId: string; widgetId: string }> {
  const { window } = l
  await waitForReady(window)
  const ids = await window.evaluate(async (c) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'ListPasteDesk' })
    const w = await api.widgets.create({ taskId: desk.id, kind: 'task-list', title: 'Tasks', content: c, x: 120, y: 100, width: 360, height: 420 })
    return { deskId: desk.id, widgetId: w.id }
  }, content)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /ListPasteDesk/ }).first().click()
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"]`, { timeout: 15_000 })
  await installClipboardStub(window)
  await setStubClipboard(window, { 'text/plain': LIST })
  return ids
}

async function blurAndUndo(l: LaunchedApp): Promise<void> {
  await l.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await l.window.keyboard.press(`${MOD}+z`)
}

test('TL-1 a desk task list: pasted lines are tasks, and one ⌘Z removes them', async () => {
  launched = await launchApp()
  const { deskId, widgetId } = await openDesk(launched, '')
  await setStubClipboard(launched.window, { 'text/plain': '- Buy milk\n[x] Renew passport' })
  const tasks = (): Promise<Array<{ title: string; status: string }>> =>
    launched!.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return (await api.nodes.list()).filter((n) => n.parentId === id && n.kind === 'task').map((n) => ({ title: n.title, status: n.status }))
    }, deskId)
  const box = launched.window.locator(`[data-widget-id="${widgetId}"] input[placeholder="Add a task to this desk"]`)
  await box.click()
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(async () => (await tasks()).map((t) => t.title).sort()).toEqual(['Buy milk', 'Renew passport'])
  expect((await tasks()).find((t) => t.title === 'Renew passport')?.status).toBe('done')
  // Nothing was left typed in the box.
  await expect(box).toHaveValue('')
  await blurAndUndo(launched)
  await expect.poll(async () => (await tasks()).length).toBe(0)
})

test('TL-3 on Free, a long paste adds what fits under the desk limit and offers the upgrade', async () => {
  launched = await launchApp()
  const { deskId, widgetId } = await openDesk(launched, '')
  const count = (): Promise<number> =>
    launched!.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      return (await api.nodes.list()).filter((n) => n.parentId === id && n.kind === 'task').length
    }, deskId)
  const box = launched.window.locator(`[data-widget-id="${widgetId}"] input[placeholder="Add a task to this desk"]`)
  await box.click()
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect(launched.window.getByRole('dialog', { name: 'Upgrade to Pro' })).toBeVisible({ timeout: 10_000 })
  // The desk itself is one of the three; two tasks fit.
  expect(await count()).toBe(2)
  await expect(box).toHaveValue('')
})

test('TL-2 a list of its own: one item per pasted line, and one ⌘Z', async () => {
  launched = await launchApp()
  const { widgetId } = await openDesk(launched, JSON.stringify({ scope: 'own', filter: 'all', items: [] }))
  const items = (): Promise<Array<{ title: string; done: boolean }>> =>
    launched!.window.evaluate(async (id) => {
      const api = (window as unknown as { api: typeof window.api }).api
      const w = await api.widgets.get(id)
      return (JSON.parse(w?.content || '{}').items ?? []).map((i: { title: string; done: boolean }) => ({ title: i.title, done: i.done }))
    }, widgetId)
  await launched.window.locator(`[data-widget-id="${widgetId}"] [data-testid="own-task-add"]`).click()
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(items).toEqual([
    { title: 'Buy milk', done: false },
    { title: 'Call Ann', done: false },
    { title: 'Renew passport', done: true },
    { title: 'Pack', done: false },
    { title: 'Book flights', done: false }
  ])
  await blurAndUndo(launched)
  await expect.poll(async () => (await items()).length).toBe(0)
})
