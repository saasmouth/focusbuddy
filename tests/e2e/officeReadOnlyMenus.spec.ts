import { test, expect, type Page } from '@playwright/test'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, type LaunchedApp } from './_helpers'
import { signInWithFakeSignal } from './_fakeSignal'
import { ACTIVE } from '../../src/shared/productDomains'

// A VIEWER's Deck, Design and Diagrams, in the built app (readonly-menus-41).
//
// The only real read-only document these three apps have is a shared live
// document opened by a VIEWER: LiveDocEditorView reads `myRole` from the server
// and hands the editor `readOnly`. So this signs in with the local fake signal
// server (_fakeSignal: nothing reaches production), answers GET /livedocs/:id
// with the document and `myRole: 'viewer'`, and plays the Yjs room's part on
// the socket (a join gets an empty replay, so the editor seeds from the body).
// Everything from there on is the real view, the real editor, the real menus.
//
// For each app: a menu row that changes the document is OFF and says exactly
// "This document is read-only." (its command's gate), the ribbon control for
// the same command says the same, and one command that only READS the
// document is live and works.

const SENTENCE = 'This document is read-only.'
const API = new URL(ACTIVE.api)

interface App {
  name: string
  docType: 'slides' | 'design' | 'map'
  body: unknown
  /** The editor's ribbon, which shows once the live body has seeded. */
  bar: string
  /** Menu bar testid prefix. */
  menu: string
}

const APPS: App[] = [
  {
    name: 'Deck',
    docType: 'slides',
    body: { slides: [{ id: 's1', notes: '', elements: [{ id: 'e1', type: 'text', x: 300, y: 250, w: 400, h: 100, paragraphs: [{ runs: [{ text: 'Hello slide' }] }] }] }] },
    bar: 'slides-toolbar',
    menu: 'slides-menubar'
  },
  {
    name: 'Design',
    docType: 'design',
    body: {
      width: 800,
      height: 600,
      elements: [{ id: 'e1', type: 'shape', shape: 'rect', x: 40, y: 40, w: 200, h: 120, z: 1, fill: { type: 'solid', color: '#2563eb' } }]
    },
    bar: 'design-toolbar',
    menu: 'design-menubar'
  },
  {
    name: 'Diagrams',
    docType: 'map',
    body: { version: 1, nodes: [{ id: 'a', x: 200, y: 160, label: 'Node A', shape: 'process', color: '#336699' }], edges: [] },
    bar: 'diagram-toolbar',
    menu: 'draw-menubar'
  }
]

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
})

/** Open `app`'s document as a viewer of a shared live document. Returns the window and every body the app tried to store. */
async function openAsViewer(app: App): Promise<{ w: Page; writes: string[] }> {
  launched = await launchApp()
  const w = launched.window
  await waitForReady(w)
  await chooseCloudAiSource(w)
  await suppressFeatureSpotlights(w)
  const id = `ld-${app.docType}`
  const writes: string[] = []
  // The Yjs room: a join gets an empty replay (nothing was edited yet), so the
  // editor seeds itself from the body below. Any update the client sends is a
  // write and is recorded; so is any socket that reaches this handler at all.
  let roomJoined = false
  const onSocket: Parameters<Page['routeWebSocket']>[1] = (ws) => {
    ws.onMessage((raw) => {
      let msg: { type?: string; payload?: { docId?: string } }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.type === 'yjsJoin' && msg.payload?.docId === id) {
        roomJoined = true
        ws.send(JSON.stringify({ type: 'yjsSync', payload: { docId: id, updates: [] } }))
      }
      if (msg.type === 'yjsUpdate') writes.push('yjsUpdate')
    })
  }
  // The socket route takes effect for the first socket the seeded session
  // opens (launchApp's net guard puts the WebSocket mock in the page from its
  // first document), so there is no reload-and-sign-in-again any more.
  await signInWithFakeSignal(w, { name: { firstName: 'Vera', lastName: 'Viewer' }, onSocket })
  // Registered after the fake signal's catch-all, so these answer first.
  await w.route(
    (u) => u.origin === API.origin && u.pathname.startsWith(`/livedocs/${id}`),
    async (route) => {
      const req = route.request()
      if (req.method() !== 'GET') {
        writes.push(`${req.method()} ${new URL(req.url()).pathname}`)
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'viewer' }) })
      }
      const now = Date.now()
      const doc = {
        id,
        ownerAccountId: 'acc_owner',
        docType: app.docType,
        title: `Shared ${app.name}`,
        version: 1,
        updatedBy: null,
        createdAt: now,
        updatedAt: now,
        body: JSON.stringify(app.body),
        members: [
          { accountId: 'acc_owner', handle: 'owner', role: 'owner' },
          { accountId: 'acc_e2e', handle: 'e2e', role: 'viewer' }
        ],
        myRole: 'viewer'
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, doc }) })
    }
  )
  await w.evaluate((docId) => (window as unknown as { __fbView: { getState: () => { goLiveDoc: (x: string) => void } } }).__fbView.getState().goLiveDoc(docId), id)
  // Open the socket now the view is listening: on open it re-joins the room.
  await w.evaluate(() => (window as unknown as { __fbMessaging: { getState: () => { connect: (t: string) => Promise<void> } } }).__fbMessaging.getState().connect('e2e-fake-token'))
  await expect.poll(() => roomJoined, { message: 'the live room was joined through the local socket', timeout: 15_000 }).toBe(true)
  await expect(w.locator(`[data-testid="${app.bar}"]`)).toBeVisible({ timeout: 20_000 })
  // Seeding the empty room from the body is the view's own update (the server
  // refuses a viewer's anyway); from here on, anything sent is the viewer's.
  await w.waitForTimeout(500)
  writes.length = 0
  return { w, writes }
}

/** A menu row, as rendered: its label, whether it is off, and its reason. */
async function menuRow(w: Page, app: App, menu: string, label: string): Promise<{ off: boolean; hint: string }> {
  await w.locator(`[data-testid="${app.menu}-${menu}"]`).click()
  const list = w.locator(`[data-testid="${app.menu}-${menu}-list"]`)
  await expect(list).toBeVisible()
  const b = list.locator(':scope > button').filter({ has: w.locator('span.flex-1', { hasText: label }) }).first()
  await expect(b, `${app.name} › ${menu} › ${label}`).toHaveCount(1)
  const out = { off: await b.isDisabled(), hint: (await b.getAttribute('title')) ?? '' }
  // Closed by its own header, not Esc: Esc would also clear the selection.
  await w.locator(`[data-testid="${app.menu}-${menu}"]`).click()
  await expect(list).toBeHidden()
  return out
}

/** Select everything with the app's own Select all (read-only safe). */
async function selectAll(w: Page, app: App): Promise<void> {
  await w.locator(`[data-testid="${app.menu}-edit"]`).click()
  const list = w.locator(`[data-testid="${app.menu}-edit-list"]`)
  await list.locator(':scope > button').filter({ has: w.locator('span.flex-1', { hasText: 'Select all' }) }).first().click()
  await expect(list).toBeHidden()
}

test('Deck, as a viewer: Duplicate is off in the menu and the ribbon with the sentence; Check accessibility is live and runs', async () => {
  test.setTimeout(120_000)
  const app = APPS[0]!
  const { w, writes } = await openAsViewer(app)
  await expect(w.locator('[data-testid="slides-readonly-stage"]'), 'the viewer gets the read-only deck').toBeVisible()
  await selectAll(w, app)
  expect(await menuRow(w, app, 'edit', 'Duplicate')).toEqual({ off: true, hint: SENTENCE })
  // The ribbon says the same for the same command.
  await w.locator('[data-testid="slides-toolbar-tab-arrange"]').click()
  const group = w.locator('[data-testid="slides-group"]')
  await expect(group).toBeDisabled()
  await expect(group).toHaveAttribute('aria-label', `Group — ${SENTENCE}`)
  expect(await menuRow(w, app, 'format', 'Group')).toEqual({ off: true, hint: SENTENCE })
  // Check accessibility only reads the deck: live in the ribbon, and it runs.
  await w.locator('[data-testid="slides-toolbar-tab-review"]').click()
  const a11y = w.locator('[data-testid="slides-a11y-btn"]')
  await expect(a11y).toBeEnabled()
  await a11y.click()
  await expect(w.locator('[data-testid="slides-a11y-modal"]')).toBeVisible()
  expect(writes, 'a viewer wrote nothing').toEqual([])
})

test('Design, as a viewer: Duplicate and Insert › Text are off with the sentence; Save selection as snippet and Check accessibility are live and run', async () => {
  test.setTimeout(120_000)
  const app = APPS[1]!
  const { w, writes } = await openAsViewer(app)
  // Select the frame the way a person does (selecting is read-only safe).
  await w.locator('.react-draggable:has([data-testid="slide-element"])').first().click()
  expect(await menuRow(w, app, 'edit', 'Duplicate')).toEqual({ off: true, hint: SENTENCE })
  await w.locator('[data-testid="design-toolbar-tab-home"]').click()
  const dup = w.locator('[data-testid="design-duplicate"]')
  await expect(dup).toBeDisabled()
  await expect(dup).toHaveAttribute('aria-label', `Duplicate — ${SENTENCE}`)
  // Save selection as snippet only reads: live in the ribbon, and it opens its dialog.
  await w.locator('[data-testid="design-toolbar-tab-arrange"]').click()
  const save = w.locator('[data-testid="design-save-snippet"]')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(w.locator('[data-testid="save-snippet-dialog"]')).toBeVisible()
  // It holds the selected frame: a real read, not an empty draft.
  await expect(w.locator('[data-testid="save-snippet-empty"]')).toHaveCount(0)
  await w.keyboard.press('Escape')
  await expect(w.locator('[data-testid="save-snippet-dialog"]')).toBeHidden()
  // viewer-registry-41: Insert's rows were written by hand, live for a viewer.
  // From the registry now, each is off with the sentence.
  expect(await menuRow(w, app, 'insert', 'Text')).toEqual({ off: true, hint: SENTENCE })
  // Check accessibility only reads the design: live in Tools ▸ and on the
  // Review tab (it was a hand-written bar button, off for a viewer), and it
  // runs. Design reports in the bar's status slot; it has no panel of its own.
  expect(await menuRow(w, app, 'tools', 'Check accessibility')).toEqual({ off: false, hint: '' })
  await w.locator('[data-testid="design-toolbar-tab-review"]').click()
  const a11y = w.locator('[data-testid="design-a11y-check"]')
  await expect(a11y).toBeEnabled()
  await expect(w.locator('[data-testid="design-status-slot"]')).not.toContainText('Accessibility:')
  await a11y.click()
  await expect(w.locator('[data-testid="design-status-slot"]')).toContainText(/^Accessibility: /)
  expect(writes, 'a viewer wrote nothing').toEqual([])
})

test('Diagrams, as a viewer: Duplicate, Undo and right-click Edit text are off with the sentence; Copy style is live and runs; keys change nothing', async () => {
  test.setTimeout(120_000)
  const app = APPS[2]!
  const { w, writes } = await openAsViewer(app)
  await w.locator('.react-flow__node').first().click()
  expect(await menuRow(w, app, 'edit', 'Duplicate')).toEqual({ off: true, hint: SENTENCE })
  // Copy style only reads the selected shape: live in the menu, and it runs
  // (the menu closes on a run; an off row keeps it open).
  expect(await menuRow(w, app, 'edit', 'Copy style')).toEqual({ off: false, hint: '' })
  await w.locator(`[data-testid="${app.menu}-edit"]`).click()
  const list = w.locator(`[data-testid="${app.menu}-edit-list"]`)
  await list.locator(':scope > button').filter({ has: w.locator('span.flex-1', { hasText: 'Copy style' }) }).first().click()
  await expect(list).toBeHidden()
  // The ribbon agrees on both.
  await w.locator('[data-testid="diagram-toolbar-tab-shape"]').click()
  const copyStyle = w.getByRole('button', { name: /^Copy style/ })
  await expect(copyStyle).toBeEnabled()
  const pasteStyle = w.getByRole('button', { name: /^Paste style/ })
  await expect(pasteStyle).toBeDisabled()
  await expect(pasteStyle).toHaveAttribute('aria-label', `Paste style — ${SENTENCE}`)
  // viewer-registry-41: Undo was a hand-written row (off only with nothing to
  // undo, and silently); the right-click Edit text was live for a viewer.
  expect(await menuRow(w, app, 'edit', 'Undo')).toEqual({ off: true, hint: SENTENCE })
  const node = w.locator('.react-flow__node').first()
  await node.click({ button: 'right' })
  const editText = w.locator('[data-testid="diagram-context-menu"] [data-testid="ctx-dg-edit-text"]')
  await expect(editText).toBeDisabled()
  await expect(editText).toHaveAttribute('title', SENTENCE)
  await w.keyboard.press('Escape')
  await expect(w.locator('[data-testid="diagram-context-menu"]')).toBeHidden()
  // A viewer's keys: forward-delete and an arrow nudge used to change the
  // viewer's own copy (no gate in commands.handleKey). Now nothing moves.
  await node.click()
  const box = await node.boundingBox()
  await w.keyboard.press('ArrowRight')
  await w.keyboard.press('Delete')
  await w.waitForTimeout(400)
  await expect(w.locator('.react-flow__node')).toHaveCount(1)
  expect(await node.boundingBox(), 'the shape did not move').toEqual(box)
  expect(writes, 'a viewer wrote nothing').toEqual([])
})
