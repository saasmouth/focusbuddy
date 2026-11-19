// An office editor in a work widget keeps to itself (owner, 2026-11-19: "check
// for similar issues with all other widgets and fix").
//
// Deck, Design, Draw and Diagrams listen for keys and clipboard events on the
// whole window, as the full-screen editors they also are. On a desk they acted
// whenever no text field had focus:
//
//   DS-1  ⌘V on the desk pastes onto the desk, and NOT also into a Deck sitting
//         on it (the Deck used to gain a text box too).
//   DS-2  ⌘Z on the desk after that undoes the desk's paste. (The Deck took ⌘Z
//         for its own undo and the desk's undo stood down.)
//   DS-3  Working in the Deck still works: choose its slide, ⌘A selects its
//         elements, ⌘C copies them.
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

async function open(l: LaunchedApp): Promise<{ deskId: string; deckWidgetId: string; docId: string }> {
  const { window } = l
  await waitForReady(window)
  const ids = await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const desk = await api.nodes.create({ parentId: null, kind: 'task', title: 'ScopeDesk' })
    const text = (id: string, x: number, words: string) => ({
      id, type: 'text', x, y: 120, w: 400, h: 80, z: 1, styleRole: 'body', fontFamily: 'Inter, system-ui, sans-serif', vAlign: 'top',
      paragraphs: [{ runs: [{ text: words, fontSize: 32, color: '#111111' }], align: 'left' }]
    })
    const doc = (await api.documents.create({
      docType: 'slides',
      title: 'Scope deck',
      body: {
        schemaVersion: 2, theme: 'plexi', size: { w: 1280, h: 720 },
        slides: [{ id: 's1', schemaVersion: 2, layout: 'blank', notes: '', transition: 'fade', background: { type: 'solid', color: '#ffffff' }, elements: [text('a', 80, 'One'), text('b', 640, 'Two')] }]
      }
    } as never)) as { id: string }
    const w = await api.widgets.create({ taskId: desk.id, kind: 'slides', title: 'Scope deck', content: doc.id, x: 520, y: 60, width: 640, height: 460 } as never)
    return { deskId: desk.id, deckWidgetId: w.id, docId: doc.id }
  })
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /ScopeDesk/ }).first().click()
  await window.waitForSelector(`[data-widget-id="${ids.deckWidgetId}"] [data-testid="slides-shell"]`, { timeout: 20_000 })
  await installClipboardStub(window)
  return ids
}

const deckElements = (l: LaunchedApp, docId: string): Promise<number> =>
  l.window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const d = (await api.documents.get(id)) as { body?: { slides?: Array<{ elements?: unknown[] }> } } | null
    return d?.body?.slides?.[0]?.elements?.length ?? -1
  }, docId)
const deskWidgets = (l: LaunchedApp, deskId: string): Promise<number> =>
  l.window.evaluate(async (id) => {
    const api = (window as unknown as { api: typeof window.api }).api
    return (await api.widgets.listByTask(id)).length
  }, deskId)

/** Press the bare desk, left of the Deck: focus leaves every widget. */
async function pressDesk(l: LaunchedApp): Promise<void> {
  const surface = l.window.locator('[data-canvas-surface="true"]').first()
  const b = (await surface.boundingBox())!
  await l.window.mouse.click(b.x + 120, b.y + b.height - 120)
  await l.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

test('DS-1/2 ⌘V on the desk is the desk\'s alone, and ⌘Z undoes it', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { deskId, docId } = await open(launched)
  // The Deck was worked in first, so it has been the focused editor.
  await launched.window.locator('[data-testid="slides-shell"]').first().click({ position: { x: 300, y: 200 } })
  expect(await deckElements(launched, docId)).toBe(2)
  const before = await deskWidgets(launched, deskId)

  await pressDesk(launched)
  await setStubClipboard(launched.window, { 'text/plain': 'Hello desk' })
  await launched.window.keyboard.press(`${MOD}+v`)
  await expect.poll(() => deskWidgets(launched!, deskId)).toBe(before + 1)
  await launched.window.waitForTimeout(600)
  expect(await deckElements(launched, docId)).toBe(2)

  // The pasted note opens for typing; pressing the desk again leaves it, and
  // ⌘Z is the desk's: it takes the paste back, and the Deck keeps out of it.
  await pressDesk(launched)
  await launched.window.keyboard.press(`${MOD}+z`)
  await expect.poll(() => deskWidgets(launched!, deskId)).toBe(before)
  expect(await deckElements(launched, docId)).toBe(2)
})

test('DS-3 working in the Deck still works: ⌘A then ⌘C copies its elements', async () => {
  launched = await launchApp()
  await installMainClipboardStub(launched.app)
  const { deckWidgetId } = await open(launched)
  const canvas = launched.window.locator(`[data-widget-id="${deckWidgetId}"] [data-testid="slides-shell"]`)
  await canvas.click({ position: { x: 300, y: 200 } })
  await launched.window.keyboard.press(`${MOD}+a`)
  await launched.window.keyboard.press(`${MOD}+c`)
  await expect.poll(async () => Object.keys((await stubClipboard(launched!.window)).data).length).toBeGreaterThan(0)
  const data = (await stubClipboard(launched.window)).data
  expect(data['text/plain'] ?? '').toContain('One')
  expect(data['text/plain'] ?? '').toContain('Two')
})
