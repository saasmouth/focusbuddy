// "Open This Room in Plexii", version 2 (F4, 2026-11-20), in the real app: a
// room's Plexii widget and document files come in LIVE (docs/PLEXIILITE-ROOM-
// HANDOFF.md, "Version 2"; main/liteRoomReceiver.ts).
//
// The room is tests/fixtures/plexiilite-room-v2.json on disk: a sticky
// (.plexii-sticky), a document (.plexii-doc) and a plain file, the Plexii files
// copied from tests/fixtures/widget-files. PlexiiLite's data folder is a
// throwaway one (FB_TEST_LITE_DATA, honoured only under the harness), and the
// link arrives as macOS delivers it, an open-url event in main. Signal is
// answered locally: never production.
//
//   LV-1  On yes, the sticky is a work widget file placed as a linked instance,
//         the document a document placed as its Office widget, both filed in the
//         room's Files folder; the plain file is a file. The summary says so.
//   LV-2  A marked file that isn't a Plexii file Plexii can read comes in as a
//         plain file, and the summary names it.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

const ID = '7d2e4f6a-1b3c-4d5e-8f70-a1b2c3d4e5f6'
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/plexiilite-room-v2.json'), 'utf8')) as Record<string, unknown>
const EXAMPLES = resolve(__dirname, '../fixtures/widget-files')

let launched: LaunchedApp | null = null
let base = ''
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  if (base) rmSync(base, { recursive: true, force: true })
  base = ''
})

/** A throwaway PlexiiLite data folder, and the v2 fixture's room on disk. */
function makeRoom(patchFiles: (room: string) => void = () => {}): { lite: string; room: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-e2e-literoom-v2-')))
  const lite = join(base, 'PlexiiLite')
  const room = join(base, 'Venue')
  mkdirSync(join(lite, 'handoff'), { recursive: true })
  mkdirSync(room)
  copyFileSync(join(EXAMPLES, 'example.plexii-sticky'), join(room, 'Call the venue.plexii-sticky'))
  copyFileSync(join(EXAMPLES, 'example.plexii-doc'), join(room, 'Launch plan.plexii-doc'))
  writeFileSync(join(room, 'notes.txt'), 'first line\n')
  patchFiles(room)
  const f = JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>
  f.folder = room
  f.createdAt = new Date().toISOString()
  writeFileSync(join(lite, 'handoff', `${ID}.json`), JSON.stringify(f))
  return { lite, room }
}

async function signIn(window: Page): Promise<void> {
  const api = new URL(ACTIVE.api)
  await window.route(
    (u) => u.origin === api.origin,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unavailable' }) })
  )
  await window.routeWebSocket((u) => u.host === api.host, () => {})
  await window.evaluate(() => {
    const store = (window as unknown as { __fbAccount: { setState: (s: object) => void } }).__fbAccount
    store.setState({
      account: { id: 'acct-e2e-lite-v2', email: 'lite@example.com', handle: 'lite', firstName: 'Robin', lastName: 'Lee' },
      sessionToken: 'e2e-session-token'
    })
  })
}

/** The native question, stood in for and answered yes; each ask recorded. */
async function answerYes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __liteAsks: Array<{ message: string; detail: string }> }
    g.__liteAsks = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as { message: string; detail: string }
      g.__liteAsks.push({ message: o.message, detail: o.detail })
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
}
const asks = (app: ElectronApplication): Promise<Array<{ message: string; detail: string }>> =>
  app.evaluate(() => (globalThis as unknown as { __liteAsks?: Array<{ message: string; detail: string }> }).__liteAsks ?? [])
const sendLink = (app: ElectronApplication): Promise<void> =>
  app.evaluate(({ app: a }, u) => {
    a.emit('open-url', { preventDefault() {} }, u)
  }, `plexii://lite-room?id=${ID}`)

type W = { id: string; kind: string; title: string; content: string; syncGroupId: string | null; x: number; y: number; width: number; height: number }
type Api = {
  nodes: { list(): Promise<Array<{ id: string; title: string; kind: string }>> }
  widgets: { listByTask(id: string): Promise<W[]> }
  documents: { list(): Promise<Array<{ id: string; title: string; docType: string }>> }
  fileManager: { list(parentId: string | null): Promise<Array<{ id: string; name: string; kind: string; docId?: string }>> }
}
const desks = (window: Page) => window.evaluate(() => (window as unknown as { api: Api }).api.nodes.list())
const widgetsOf = (window: Page, deskId: string): Promise<W[]> => window.evaluate((d) => (window as unknown as { api: Api }).api.widgets.listByTask(d), deskId)
const documents = (window: Page) => window.evaluate(() => (window as unknown as { api: Api }).api.documents.list())
const filesIn = (window: Page, parentId: string | null) => window.evaluate((p) => (window as unknown as { api: Api }).api.fileManager.list(p), parentId)
const deskNamed = async (window: Page, title: string): Promise<string | null> => (await desks(window)).find((n) => n.kind === 'task' && n.title === title)?.id ?? null

async function bringIn(app: ElectronApplication, window: Page): Promise<{ deskId: string; widgets: W[] }> {
  await answerYes(app)
  await signIn(window)
  await sendLink(app)
  await expect.poll(async () => (await asks(app)).length, { timeout: 15_000 }).toBe(1)
  await expect.poll(() => deskNamed(window, 'Venue'), { timeout: 15_000 }).not.toBeNull()
  const deskId = (await deskNamed(window, 'Venue'))!
  await expect.poll(async () => (await widgetsOf(window, deskId)).length, { timeout: 10_000 }).toBe(3)
  return { deskId, widgets: await widgetsOf(window, deskId) }
}

test('LV-1 a room\'s sticky and document come in live, filed in the room\'s Files folder; the plain file is a file', async () => {
  test.setTimeout(90_000)
  const { lite, room } = makeRoom()
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  const { widgets } = await bringIn(app, window)

  const [q] = await asks(app)
  expect(q!.message).toBe('Bring “Venue” into Plexii?')
  expect(q!.detail).toContain('2 of them are Plexii files: they come in as work widgets and documents you can edit.')

  const sticky = widgets.find((w) => w.kind === 'sticky')!
  expect(sticky.title).toBe('Call the venue')
  expect(sticky.content).toBe('Call the venue about Thursday: two more chairs.')
  expect(sticky.syncGroupId).toMatch(/^wf:/) // an instance of its new work widget file
  expect([sticky.x, sticky.y, sticky.width, sticky.height]).toEqual([60, 60, 280, 220])
  const doc = widgets.find((w) => w.kind === 'doc')!
  expect(doc.title).toBe('Launch plan')
  const docs = await documents(window)
  expect(docs.find((d) => d.id === doc.content)).toMatchObject({ title: 'Launch plan', docType: 'doc' })
  expect(widgets.find((w) => w.title === 'notes.txt')!.kind).toBe('file')

  // All three in the room's Files folder: the document, the work widget file, and Plexii's copy of the plain file.
  const folder = (await filesIn(window, null)).find((e) => e.kind === 'folder' && e.name === 'Venue')!
  expect(folder).toBeTruthy()
  const inFolder = await filesIn(window, folder.id)
  expect(inFolder.some((e) => e.docId === doc.content)).toBe(true)
  expect(inFolder.some((e) => e.docId === sticky.syncGroupId!.slice('wf:'.length))).toBe(true)
  expect(inFolder.some((e) => e.name === 'notes.txt')).toBe(true)

  await expect(window.getByText('3 files brought in from “Venue”, 2 of them as work widgets and documents you can edit.')).toBeVisible({ timeout: 10_000 })
  // The sticky shows its words on the desk.
  await expect(window.getByText('Call the venue about Thursday: two more chairs.').first()).toBeVisible({ timeout: 10_000 })
  // The room is as it was.
  expect(readFileSync(join(room, 'Launch plan.plexii-doc'), 'utf8')).toBe(readFileSync(join(EXAMPLES, 'example.plexii-doc'), 'utf8'))
})

test('LV-2 a marked file that is not a Plexii file Plexii can read comes in as a plain file, and the summary names it', async () => {
  test.setTimeout(90_000)
  const { lite } = makeRoom((room) =>
    writeFileSync(join(room, 'Launch plan.plexii-doc'), JSON.stringify({ type: 'plexii.document.doc', version: 1, title: 'x', docType: 'doc', body: { nope: 1 } }))
  )
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  const { widgets } = await bringIn(app, window)
  expect(widgets.map((w) => w.kind).sort()).toEqual(['file', 'file', 'sticky'])
  expect(widgets.find((w) => w.title === 'Launch plan.plexii-doc')!.kind).toBe('file')
  await expect(
    window.getByText('3 files brought in from “Venue”, 1 of them as a work widget or document you can edit. Launch plan.plexii-doc came in as a plain file: it couldn’t be read as a Plexii file.')
  ).toBeVisible({ timeout: 10_000 })
})
