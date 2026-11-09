// "Open This Room in Plexii", the app end (main/liteRoomReceiver.ts,
// components/LiteRoomEffects.tsx; the contract is docs/PLEXIILITE-ROOM-HANDOFF.md).
//
// PlexiiLite describes a room in its own data folder and opens
// plexii://lite-room?id=<id>. The app keeps the id until someone is signed in,
// reads that one file, ASKS (a native sheet, answered here by standing in for
// dialog.showMessageBox), and only on yes copies the files into a new desk named
// after the folder, laid out as the room was.
//
// PlexiiLite's data folder is a throwaway one (FB_TEST_LITE_DATA, honoured only
// under the harness): the owner's PlexiiLite is never read. The link arrives the
// way macOS delivers it to a running app: an open-url event in the main process.
// A test Plexii never registers itself for plexii:// (shared/deepLink.ts
// claimsDeepLinks), so nothing here can take the owner's links.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

let launched: LaunchedApp | null = null
let base = ''
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  if (base) rmSync(base, { recursive: true, force: true })
  base = ''
})

const ID = '6f1c2e9a-0b7d-4c3e-9a51-2d8f4b6c7e10'
const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, '../fixtures/plexiilite-room-v1.json'), 'utf8')) as Record<string, unknown>
// A 1x1 violet PNG: a real picture, so the file widget's picture loads (and could be re-fitted).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4X8LwHwAFAwJ/qZ5KuwAAAABJRU5ErkJggg==', 'base64')

interface Ask {
  message: string
  detail: string
  buttons: string[]
}

/** A throwaway PlexiiLite data folder, and the room on disk the fixture describes (the recording in iCloud is NOT on disk: it must never be looked for). */
function makeRoom(patch: (f: Record<string, unknown>) => void = () => {}, id = ID): { lite: string; room: string } {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-e2e-literoom-')))
  const lite = join(base, 'PlexiiLite')
  const room = join(base, 'Launch')
  mkdirSync(join(lite, 'handoff'), { recursive: true })
  mkdirSync(join(room, 'Ideas'), { recursive: true })
  writeFileSync(join(room, 'budget.csv'), 'item,cost\npaper,3\n')
  writeFileSync(join(room, 'notes.txt'), 'first line\n')
  writeFileSync(join(room, 'photo.png'), PNG)
  writeFileSync(join(room, 'plan.md'), '# Plan\n\nShip the thing.\n')
  writeFileSync(join(room, 'Ideas', 'idea.md'), '# An idea\n')
  const f = JSON.parse(JSON.stringify(FIXTURE)) as Record<string, unknown>
  f.folder = room
  f.name = 'Launch'
  f.createdAt = new Date().toISOString()
  // The browser window opens on the harness's dead local port, never a production host (the net guard).
  ;(f.pages as Record<string, unknown>[])[0]!.url = 'http://127.0.0.1:9/'
  patch(f)
  writeFileSync(join(lite, 'handoff', `${id}.json`), JSON.stringify(f))
  return { lite, room }
}

/** Signal answered locally as "temporarily unavailable" once someone is signed in (as deskHandoff.spec does). */
async function signalUnavailable(window: Page): Promise<void> {
  const api = new URL(ACTIVE.api)
  await window.route(
    (u) => u.origin === api.origin,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unavailable' }) })
  )
  await window.routeWebSocket((u) => u.host === api.host, () => {})
}

/** The native question, stood in for: every ask recorded, answered with `button`. */
async function answerWith(app: ElectronApplication, button: 0 | 1): Promise<void> {
  await app.evaluate(({ dialog }, b) => {
    const g = globalThis as unknown as { __liteAsks: Ask[] }
    g.__liteAsks = []
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as Ask
      g.__liteAsks.push({ message: o.message, detail: o.detail, buttons: o.buttons })
      return { response: b, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  }, button)
}
const asks = (app: ElectronApplication): Promise<Ask[]> => app.evaluate(() => (globalThis as unknown as { __liteAsks?: Ask[] }).__liteAsks ?? [])

const sendLink = (app: ElectronApplication, url: string): Promise<void> =>
  app.evaluate(({ app: electronApp }, u) => {
    electronApp.emit('open-url', { preventDefault() {} }, u)
  }, url)

async function signIn(window: Page): Promise<void> {
  await window.evaluate(() => {
    const store = (window as unknown as { __fbAccount: { setState: (s: object) => void } }).__fbAccount
    store.setState({
      account: { id: 'acct-e2e-lite', email: 'lite@example.com', handle: 'lite', firstName: 'Robin', lastName: 'Lee' },
      sessionToken: 'e2e-session-token'
    })
  })
}

type Widgets = Array<{ id: string; kind: string; title: string; content: string; x: number; y: number; width: number; height: number; zIndex: number }>
type Entries = Array<{ id: string; name: string; kind: string }>
/** window.api, typed loosely for the calls this spec makes. */
type Api = {
  nodes: { list(): Promise<Array<{ id: string; title: string; kind: string }>> }
  widgets: { listByTask(id: string): Promise<Widgets> }
  files: { get(id: string): Promise<{ originalName: string; sizeBytes: number } | null> }
  fileManager: { list(parentId: string | null): Promise<Entries> }
  liteRoom: { pending(): Promise<{ id: string; at: number } | null> }
  deskLayout: { load(u: string, d: string, c: string): Promise<{ workcentre?: { cols: number; items: Record<string, unknown> } } | null> }
}

const desksNamed = (window: Page, title: string): Promise<string[]> =>
  window.evaluate(async (t) => (await (window as unknown as { api: Api }).api.nodes.list()).filter((n) => n.kind === 'task' && n.title === t).map((n) => n.id), title)
const widgetsOf = (window: Page, deskId: string): Promise<Widgets> => window.evaluate((d) => (window as unknown as { api: Api }).api.widgets.listByTask(d), deskId)
const fileOf = (window: Page, id: string) => window.evaluate((i) => (window as unknown as { api: Api }).api.files.get(i), id)
const filesIn = (window: Page, parentId: string | null): Promise<Entries> => window.evaluate((p) => (window as unknown as { api: Api }).api.fileManager.list(p), parentId)
const pending = (window: Page) => window.evaluate(() => (window as unknown as { api: Api }).api.liteRoom.pending())

test('LR-1 a room handed over before sign-in waits; once signed in Plexii asks, and on yes brings it in as a desk laid out as it was', async () => {
  test.setTimeout(90_000)
  const { lite, room } = makeRoom()
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  await answerWith(app, 0)
  await signalUnavailable(window)

  await sendLink(app, `plexii://lite-room?id=${ID}`)
  await expect.poll(() => pending(window)).toMatchObject({ id: ID })
  // Nobody signed in: nothing asked, nothing made.
  await window.waitForTimeout(1500)
  expect(await asks(app)).toEqual([])
  expect(await desksNamed(window, 'Launch')).toEqual([])

  await signIn(window)
  await expect.poll(async () => (await asks(app)).length, { timeout: 15_000 }).toBe(1)
  const [q] = await asks(app)
  expect(q!.message).toBe('Bring “Launch” into Plexii?')
  expect(q!.buttons).toEqual(['Bring In', 'Cancel'])
  expect(q!.detail).toContain(`with its own copy of 4 files (${27 + 11 + 69 + 26} bytes) and 1 browser window from ${room}`)
  expect(q!.detail).toContain('The folder and its files aren’t changed')
  expect(q!.detail).toContain('• talk.mov. Only in iCloud, so Plexii doesn’t download it.')
  expect(q!.detail).toContain('• Ideas. A folder: only the files directly in the room come in.')

  // A new desk named after the folder, opened.
  await expect.poll(() => desksNamed(window, 'Launch'), { timeout: 15_000 }).toHaveLength(1)
  const [deskId] = await desksNamed(window, 'Launch')
  await expect
    .poll(() => window.evaluate(() => (window as unknown as { __fbView: { getState(): { view: { kind: string; taskId?: string } } } }).__fbView.getState().view))
    .toEqual({ kind: 'task', taskId: deskId })
  await expect(window.getByText('4 files and 1 browser window brought in from “Launch”; 2 left out: talk.mov (only in iCloud), Ideas (a folder).')).toBeVisible({ timeout: 10_000 })

  // Each file a file on the desk, at its place from PlexiiLite's Desk, in its stacking order; the page a browser.
  const widgets = (await widgetsOf(window, deskId!)).sort((a, b) => a.zIndex - b.zIndex)
  expect(widgets.map((w) => [w.title, w.kind, w.x, w.y, w.width, w.height])).toEqual([
    ['budget.csv', 'file', 540, 60, 520, 340],
    ['plan.md', 'file', 60, 60, 440, 440],
    ['photo.png', 'file', 60, 540, 340, 260],
    ['Plexii', 'webview', 440, 540, 560, 400],
    ['notes.txt', 'file', 60, 988, 320, 240]
  ])
  expect(widgets.find((w) => w.kind === 'webview')!.content).toBe('http://127.0.0.1:9/')
  // Plexii's own copies, byte for byte, in a Files folder named after the room.
  for (const w of widgets.filter((x) => x.kind === 'file')) {
    const f = await fileOf(window, w.content)
    expect(f, w.title).toMatchObject({ originalName: w.title, sizeBytes: readFileSync(join(room, w.title)).length })
  }
  const roots = await filesIn(window, null)
  const folder = roots.find((e) => e.kind === 'folder' && e.name === 'Launch')
  expect(folder).toBeTruthy()
  expect((await filesIn(window, folder!.id)).map((e) => e.name).sort()).toEqual(['budget.csv', 'notes.txt', 'photo.png', 'plan.md'])

  // The picture is shown and keeps the size it was brought in at (a drop's size is the only one re-fitted).
  await expect(window.locator('img[alt="photo.png"]').first()).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(1000)
  const photo = (await widgetsOf(window, deskId!)).find((w) => w.title === 'photo.png')!
  expect([photo.width, photo.height]).toEqual([340, 260])

  // The link is spent; PlexiiLite's file is left where it was, and the folder as it was.
  expect(await pending(window)).toBeNull()
  expect(readdirSync(join(lite, 'handoff'))).toEqual([`${ID}.json`])
  expect(readdirSync(room).sort()).toEqual(['Ideas', 'budget.csv', 'notes.txt', 'photo.png', 'plan.md'])
  expect(readFileSync(join(room, 'plan.md'), 'utf8')).toBe('# Plan\n\nShip the thing.\n')
  // The same link again brings nothing more in.
  await sendLink(app, `plexii://lite-room?id=${ID}`)
  await expect(window.getByText('That room from PlexiiLite has already been brought in.')).toBeVisible({ timeout: 10_000 })
  expect(await desksNamed(window, 'Launch')).toHaveLength(1)
  expect(await asks(app)).toHaveLength(1)
})

test('LR-2 Cancel brings nothing in: no desk, no files, and the person is told', async () => {
  test.setTimeout(60_000)
  const { lite } = makeRoom()
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  await answerWith(app, 1)
  await signalUnavailable(window)
  await signIn(window)
  const filesBefore = (await filesIn(window, null)).length
  await sendLink(app, `plexii://lite-room?id=${ID}`)
  await expect.poll(async () => (await asks(app)).length, { timeout: 15_000 }).toBe(1)
  await expect(window.getByText('Nothing was brought in from “Launch”.')).toBeVisible({ timeout: 10_000 })
  expect(await desksNamed(window, 'Launch')).toEqual([])
  expect((await filesIn(window, null)).length).toBe(filesBefore)
  expect(await pending(window)).toBeNull()
})

test('LR-3 an unknown id, or a handoff that breaks the contract: never asked, nothing brought in, a clear message', async () => {
  test.setTimeout(60_000)
  const { lite } = makeRoom((f) => ((f.tiles as Record<string, unknown>[])[0]!.relPath = '../../.ssh/id_rsa'))
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  await answerWith(app, 0)
  await signalUnavailable(window)
  await signIn(window)
  await sendLink(app, 'plexii://lite-room?id=0d9e7c3b-5a1f-4e2d-8c6b-9f0a1b2c3d4e')
  await expect(window.getByText('That room from PlexiiLite isn’t there any more', { exact: false })).toBeVisible({ timeout: 10_000 })
  await sendLink(app, `plexii://lite-room?id=${ID}`)
  await expect(window.getByText('That room from PlexiiLite couldn’t be trusted in full', { exact: false })).toBeVisible({ timeout: 10_000 })
  // Not a link this app takes at all: ignored.
  await sendLink(app, 'plexii://lite-room?id=../../handoff/x')
  await window.waitForTimeout(1000)
  expect(await asks(app)).toEqual([])
  expect(await desksNamed(window, 'Launch')).toEqual([])
  expect(await pending(window)).toBeNull()
})

test('LR-4 a room shown in PlexiiLite\'s Workcentre opens in Plexii\'s Workcentre, cell for cell', async () => {
  test.setTimeout(90_000)
  const { lite } = makeRoom((f) => (f.view = 'workcentre'))
  launched = await launchApp({ env: { FB_TEST_LITE_DATA: lite } })
  const { app, window } = launched
  await waitForReady(window)
  await answerWith(app, 0)
  await signalUnavailable(window)
  await signIn(window)
  await sendLink(app, `plexii://lite-room?id=${ID}`)
  await expect.poll(() => desksNamed(window, 'Launch'), { timeout: 20_000 }).toHaveLength(1)
  const [deskId] = await desksNamed(window, 'Launch')
  await expect(window.locator('[data-testid="workcentre-view"]')).toBeVisible({ timeout: 15_000 })
  const widgets = await widgetsOf(window, deskId!)
  const idOf = (title: string): string => widgets.find((w) => w.title === title)!.id
  const stored = await window.evaluate(
    ([d]) => (window as unknown as { api: Api }).api.deskLayout.load('acct-e2e-lite', d!, 'desktop'),
    [deskId] as const
  )
  // What PlexiiLite's Workcentre had, under the new widgets (the view may have tiled the never-placed file too).
  expect(stored?.workcentre?.items[idOf('plan.md')]).toMatchObject({ x: 0, y: 0, w: 4, h: 12 })
  expect(stored?.workcentre?.items[idOf('budget.csv')]).toMatchObject({ x: 4, y: 0, w: 5, h: 9 })
  expect(stored?.workcentre?.items[idOf('photo.png')]).toMatchObject({ w: 3, h: 7, fixW: true })
})
