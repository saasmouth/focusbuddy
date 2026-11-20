/**
 * Double-click a .plexii-* file in Finder or Explorer and Plexii opens it (F3,
 * 2026-11-20), in the real app.
 *
 * The file arrives the way the OS hands it to a running app: macOS's open-file
 * event, or (Windows) a second instance's argv, emitted in the main process.
 * The files are copies of tests/fixtures/widget-files in a throwaway folder.
 *
 *   PF-1  A file opened before anyone is signed in is read AT ONCE and waits:
 *         nothing is brought in. Once signed in, it comes in as a copy, into
 *         Files and onto the desk on screen, and a notice says so.
 *   PF-2  With no desk on screen, a document file is opened in its editor.
 *   PF-3  Windows: files in a second instance's argv come in the same way; a
 *         work widget file goes on the desk as an instance of its new file.
 *   PF-4  A damaged file and one that is gone are named with the reason, and
 *         nothing is made from either.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { launchApp, openNewDesk, gotoView, waitForReady, type LaunchedApp } from './_helpers'
import { ACTIVE } from '../../src/shared/productDomains'

const FIXTURES = resolve(__dirname, '../fixtures/widget-files')
let launched: LaunchedApp | null = null
let dir = ''
test.beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'plexii-e2e-openfile-')))
})
test.afterEach(async () => {
  if (launched) await launched.dispose()
  launched = null
  rmSync(dir, { recursive: true, force: true })
})

/** A copy of a fixture, under the name a person would have saved it as. */
const fixture = (type: string, name: string): string => {
  const p = join(dir, name)
  copyFileSync(join(FIXTURES, `example.plexii-${type}`), p)
  return p
}

const openFile = (app: ElectronApplication, path: string): Promise<boolean> =>
  app.evaluate(({ app: a }, p) => {
    let prevented = false
    a.emit('open-file', { preventDefault: () => (prevented = true) }, p)
    return prevented
  }, path)

async function signIn(window: Page): Promise<void> {
  // Signal answered locally as "temporarily unavailable" (as liteRoom.spec does): never production.
  const api = new URL(ACTIVE.api)
  await window.route(
    (u) => u.origin === api.origin,
    (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unavailable' }) })
  )
  await window.routeWebSocket((u) => u.host === api.host, () => {})
  await window.evaluate(() => {
    const store = (window as unknown as { __fbAccount: { setState: (s: object) => void } }).__fbAccount
    store.setState({
      account: { id: 'acct-e2e-openfile', email: 'open@example.com', handle: 'open', firstName: 'Robin', lastName: 'Lee' },
      // No session token: what these specs test is gated on the account alone, and
      // without a token the app starts no sync, messaging or credit check, so
      // nothing can reach for a production host. (With a token, the shared
      // workspace sync was once caught by the net guard's session layer under
      // load, in the 4.3.54 RC's full run.)
      sessionToken: null
    })
  })
}

type Doc = { id: string; title: string; docType: string }
type W = { id: string; kind: string; title: string; content: string; syncGroupId: string | null }
type Api = {
  documents: { list(): Promise<Doc[]> }
  widgets: { listByTask(id: string): Promise<W[]> }
  fileManager: { list(parentId: string | null): Promise<Array<{ docId?: string; name: string }>> }
}
const docs = (window: Page): Promise<Doc[]> => window.evaluate(async () => (await (window as unknown as { api: Api }).api.documents.list()) ?? [])
const docsTitled = async (window: Page, title: string): Promise<Doc[]> => (await docs(window)).filter((d) => d.title === title)
const widgetsOn = (window: Page, deskId: string): Promise<W[]> => window.evaluate((d) => (window as unknown as { api: Api }).api.widgets.listByTask(d), deskId)
const inFiles = (window: Page, docId: string): Promise<boolean> =>
  window.evaluate(async (id) => ((await (window as unknown as { api: Api }).api.fileManager.list(null)) ?? []).some((e) => e.docId === id), docId)
const view = (window: Page) =>
  window.evaluate(() => (window as unknown as { __fbView: { getState(): { view: Record<string, unknown> } } }).__fbView.getState().view)

test('PF-1 a file opened before sign-in is read at once and waits; once signed in it comes in as a copy, into Files and onto the desk on screen', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Planning')

  const path = fixture('sheet', 'Supplies.plexii-sheet')
  expect(await openFile(app, path)).toBe(true) // claimed: macOS does not also try another app
  // Read at once: the file can go (a Mail attachment does) and Plexii still has it.
  await window.waitForTimeout(500)
  rmSync(path)
  await window.waitForTimeout(1500)
  expect(await docsTitled(window, 'Supplies')).toEqual([])

  await signIn(window)
  await expect.poll(async () => (await docsTitled(window, 'Supplies')).length, { timeout: 15_000 }).toBe(1)
  const [doc] = await docsTitled(window, 'Supplies')
  expect(doc!.docType).toBe('sheet')
  expect(await inFiles(window, doc!.id)).toBe(true)
  // On the desk on screen: the spreadsheet's Office widget, pointing AT the new document.
  await expect.poll(async () => (await widgetsOn(window, deskId)).filter((w) => w.kind === 'sheet' && w.content === doc!.id).length, { timeout: 10_000 }).toBe(1)
  await expect(window.getByText('Opened “Supplies”. A copy is in Files and on this desk.')).toBeVisible({ timeout: 10_000 })
  // The desk is still the view: nothing navigated away from it.
  expect(await view(window)).toMatchObject({ kind: 'task', taskId: deskId })
})

test('PF-2 with no desk on screen, a document file is opened in its editor', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  await signIn(window)
  await gotoView(window, 'goFiles')

  expect(await openFile(app, fixture('sheet', 'Supplies.plexii-sheet'))).toBe(true)
  await expect.poll(async () => (await docsTitled(window, 'Supplies')).length, { timeout: 15_000 }).toBe(1)
  const [doc] = await docsTitled(window, 'Supplies')
  await expect.poll(() => view(window), { timeout: 10_000 }).toEqual({ kind: 'document', documentId: doc!.id })
  await expect(window.locator('[data-testid="sheet-grid"]')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('[data-testid="cell-1-0"]')).toContainText('Pens')
  await expect(window.getByText('Opened “Supplies”. A copy is in Files.')).toBeVisible({ timeout: 10_000 })
})

test('PF-3 Windows: files in a second instance’s argv come in the same way, a work widget as an instance of its new file', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  await signIn(window)
  const deskId = await openNewDesk(window, 'Venue')
  const before = (await docs(window)).length

  const sticky = fixture('sticky', 'Call the venue.plexii-sticky')
  const doc = fixture('doc', 'Launch plan.plexii-doc')
  await app.evaluate(({ app: a }, argv) => {
    a.emit('second-instance', {}, argv, '/')
  }, ['C:\\Program Files\\PlexiiDesk\\PlexiiDesk.exe', '--original-process-start-time=1', sticky, doc])

  await expect.poll(async () => (await docs(window)).length - before, { timeout: 15_000 }).toBe(2)
  await expect
    .poll(async () => (await widgetsOn(window, deskId)).map((w) => w.kind).sort(), { timeout: 10_000 })
    .toEqual(['doc', 'sticky'])
  const stickyWidget = (await widgetsOn(window, deskId)).find((w) => w.kind === 'sticky')!
  expect(stickyWidget.content).toBe('Call the venue about Thursday: two more chairs.')
  // An instance of the new work widget file, not a desk-only copy.
  expect(stickyWidget.syncGroupId).toMatch(/^wf:/)
  await expect(window.getByText('Opened 2 Plexii files. Copies are in Files and on this desk.')).toBeVisible({ timeout: 10_000 })
})

test('PF-4 a damaged file and one that is gone are named with the reason, and nothing is made from either', async () => {
  test.setTimeout(90_000)
  launched = await launchApp()
  const { app, window } = launched
  await waitForReady(window)
  const deskId = await openNewDesk(window, 'Checks')
  const before = (await docs(window)).length

  const bad = join(dir, 'Broken.plexii-sheet')
  writeFileSync(bad, JSON.stringify({ type: 'plexii.document.sheet', version: 1, title: 'Not a sheet', docType: 'sheet', body: { hello: 'world' } }))
  expect(await openFile(app, bad)).toBe(true)
  expect(await openFile(app, join(dir, 'Gone.plexii-doc'))).toBe(true)
  // A file Plexii doesn't import is left for macOS to give to another app.
  expect(await openFile(app, join(dir, 'notes.txt'))).toBe(false)
  // Both waiting, then taken together once someone is signed in: one notice names both.
  await window.waitForTimeout(1000)
  await signIn(window)

  const notice = window.getByTestId('notice-toast')
  await expect(notice).toContainText('“Broken.plexii-sheet” could not be opened: This spreadsheet file is damaged: its contents are not a Plexii spreadsheet.', { timeout: 15_000 })
  await expect(notice).toContainText('“Gone.plexii-doc” could not be opened: It isn’t there any more.')
  expect((await docs(window)).length).toBe(before)
  expect(await widgetsOn(window, deskId)).toEqual([])
})
