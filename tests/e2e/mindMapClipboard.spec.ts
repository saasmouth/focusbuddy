// Copy and paste in a mind map (owner, 2026-11-19: "check for similar issues
// with all other widgets and fix").
//
//   MM-1  Choose a node, ⌘C: the branch goes out as an indented outline (text
//         and a nested list).
//   MM-2  Choose a node, ⌘V an indented list: it comes in as branches under
//         that node, and no widget appears on the desk (⌘V used to make a new
//         desk widget: a node click left nothing focused). One ⌘Z undoes it.
//
// The clipboard is the test's own (_clipboardStub.ts), never the system one.
import { test, expect } from '@playwright/test'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { installClipboardStub, setStubClipboard, stubClipboard, MOD, installMainClipboardStub } from './_clipboardStub'

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

const node = (id: string, label: string, children: unknown[] = []) => ({ id, label, kind: 'idea', children, attachedWidgetIds: [], assignedAgentSlugs: [], pendingChildren: [] })
const MAP = { root: node('root', 'Plan', [node('a', 'Research', [node('a1', 'Interviews')])]), selectedId: 'root', viewRootId: 'root' }

interface Label { label: string; children: Label[] }

async function open(l: LaunchedApp): Promise<{ widgetId: string }> {
  const { window } = l
  await waitForReady(window)
  const ids = await window.evaluate(async (content) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'MapClipDesk' })
    const w = await api.widgets.create({ taskId: desk.id, kind: 'mindmap', title: 'Map', content, x: 100, y: 80, width: 760, height: 460 })
    return { widgetId: w.id }
  }, JSON.stringify(MAP))
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /MapClipDesk/ }).first().click()
  await window.waitForSelector(`[data-widget-id="${ids.widgetId}"] [data-testid="mindmap-node-a"]`, { timeout: 15_000 })
  await installClipboardStub(window)
  return ids
}

async function tree(l: LaunchedApp, widgetId: string): Promise<Label> {
  return l.window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const w = await api.widgets.get(id)
    type N = { label: string; children: N[] }
    const strip = (n: N): N => ({ label: n.label, children: n.children.map(strip) })
    return strip(JSON.parse(w!.content).root)
  }, widgetId)
}

test('MM-1 a chosen branch copies as an indented outline', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { widgetId } = await open(launched)
  await launched.window.locator(`[data-widget-id="${widgetId}"] [data-testid="mindmap-node-a"]`).click()
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => (await stubClipboard(launched!.window)).data['text/plain']).toBe('Research\n\tInterviews')
  expect((await stubClipboard(launched.window)).data['text/html']).toContain('<ul><li>Research<ul><li>Interviews</li></ul></li></ul>')
})

test('MM-2 an outline pasted onto a node comes in as its branches, not as a desk widget; one ⌘Z undoes it', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { widgetId } = await open(launched)
  const widgets = launched.window.locator('[data-canvas-surface] [data-widget-id]')
  await expect(widgets).toHaveCount(1)
  await setStubClipboard(launched.window, { 'text/plain': '- Budget\n  - Quotes\n  - Invoices\n- Timeline' })
  await launched.window.locator(`[data-widget-id="${widgetId}"] [data-testid="mindmap-node-root"]`).click()
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(() => tree(launched!, widgetId)).toEqual({
    label: 'Plan',
    children: [
      { label: 'Research', children: [{ label: 'Interviews', children: [] }] },
      { label: 'Budget', children: [{ label: 'Quotes', children: [] }, { label: 'Invoices', children: [] }] },
      { label: 'Timeline', children: [] }
    ]
  })
  await expect(widgets).toHaveCount(1)
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(async () => (await tree(launched!, widgetId)).children.map((c) => c.label)).toEqual(['Research'])
})
