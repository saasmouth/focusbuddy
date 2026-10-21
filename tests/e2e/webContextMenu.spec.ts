// E2E: right-click works on every surface web content renders on, with the
// same native menu (src/main/webContextMenu.ts), desk-only actions on the
// desk only.
//
// Owner's ask: "make sure the right click context menu works on the standalone
// browser as well as the browser when it is on a desk". Before 4.3.39-local.4
// only the desk's browser work widget had a menu outside editable fields; the
// standalone browser, connected apps and pop-ups showed nothing.
//
// A real right-click (sendInputEvent from main) on a local test page — a link,
// an image, selected text, an input and empty space — on each surface. Native
// menus cannot be read from Playwright, so the test hook (NODE_ENV=test +
// PLEXI_WEB_MENU_HOOK=1) records the menu main built instead of popping it up.
// Throwaway profile, preview app identity, localhost only.
import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { launchApp, waitForReady, type LaunchedApp } from './_helpers'

let launched: LaunchedApp | null = null
let server: Server | null = null
let origin = ''

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAQElEQVR4nO3OMQ0AAAjAMO5fNBYBAvpA0tQzTXOdnd8EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+GB0/AAG+Vt0WAAAAAElFTkSuQmCC'
const PAGE = `<!doctype html><title>Menu test</title>
<body style="margin:0;font:16px sans-serif">
<a id="link" href="/other.html" style="position:absolute;left:10px;top:10px">a link</a>
<img id="img" src="/img.png" width="64" height="64" style="position:absolute;left:10px;top:40px">
<p id="text" style="position:absolute;left:10px;top:120px;margin:0">Some selectable words here.</p>
<input id="field" value="teh text" style="position:absolute;left:10px;top:160px;width:160px">
<div id="empty" style="position:absolute;left:220px;top:220px;width:40px;height:40px"></div>
<script>window.openPop = () => !!window.open('/m.html?pop=1', 'pop', 'width=420,height=420')</script>
</body>`

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/img.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from(PNG, 'base64'))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(path === '/m.html' ? PAGE : '<!doctype html><title>Other</title>other')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
  origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
})
test.afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

type Entry = { type?: 'separator'; id?: string; label?: string; enabled?: boolean }
type Recorded = { surface: string; webContentsId: number; entries: Entry[] } | null

/** Find the web content showing `url` (exact, or with ?pop=1 for the pop-up). */
async function waitLoaded(app: ElectronApplication, url: string): Promise<void> {
  await expect
    .poll(
      () =>
        app.evaluate(({ webContents }, u) => {
          const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === u)
          return wc ? !wc.isLoading() : false
        }, url),
      { timeout: 20_000 }
    )
    .toBe(true)
}

/** Right-click the element `sel` in the page at `url`, as a person would; return the menu main built. */
async function rightClick(app: ElectronApplication, url: string, sel: string, opts: { select?: boolean; focus?: boolean } = {}): Promise<Recorded> {
  return app.evaluate(
    async ({ webContents }, { url, sel, opts }) => {
      const g = globalThis as unknown as { __plexiiLastWebMenu?: unknown }
      g.__plexiiLastWebMenu = null
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL() === url)
      if (!wc) throw new Error(`no web content at ${url}`)
      // The page has focus, as it does when a person is using it (a selection
      // in an unfocused frame reads as empty).
      wc.focus()
      const r = (await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const b = el.getBoundingClientRect();
          ${opts.select ? `const rg = document.createRange(); rg.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(rg);` : ''}
          ${opts.focus ? `el.focus(); el.select && el.select();` : ''}
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`,
        true
      )) as { x: number; y: number }
      // Input events are in device-independent pixels; the page lays out in
      // CSS pixels under the surface's zoom (the browser panel is at 90%).
      const z = wc.getZoomFactor()
      const at = { x: Math.round(r.x * z), y: Math.round(r.y * z) }
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'right', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'right', clickCount: 1 })
      for (let i = 0; i < 50 && !g.__plexiiLastWebMenu; i++) await new Promise((res) => setTimeout(res, 100))
      return (g.__plexiiLastWebMenu ?? null) as never
    },
    { url, sel, opts }
  )
}

const labels = (m: Recorded): string[] => (m?.entries ?? []).filter((e) => e.type !== 'separator').map((e) => e.label ?? '')

/** The five targets, checked on one surface. */
async function checkAll(app: ElectronApplication, url: string, surface: string): Promise<void> {
  const link = await rightClick(app, url, '#link')
  expect(link?.surface).toBe(surface)
  expect(labels(link)).toEqual(expect.arrayContaining(['Open link in default browser', 'Copy link address']))
  expect(labels(link)).toContain(surface === 'desk' ? 'Open link as a new browser work widget' : 'Open link')

  const img = await rightClick(app, url, '#img')
  expect(labels(img)).toEqual(expect.arrayContaining(['Save image as…', 'Copy image', 'Copy image address']))

  const text = await rightClick(app, url, '#text', { select: true })
  expect(labels(text)).toContain('Copy')

  const field = await rightClick(app, url, '#field', { focus: true })
  expect(labels(field)).toEqual(expect.arrayContaining(['Cut', 'Copy', 'Paste', 'Select all']))

  const empty = await rightClick(app, url, '#empty')
  expect(labels(empty)).toEqual(expect.arrayContaining(['Back', 'Forward', 'Reload']))

  // Desk actions on the desk only.
  for (const m of [link, img, text, field, empty]) {
    if (surface === 'desk') expect(labels(m)).toContain('More work widget actions…')
    else expect(labels(m).join('|')).not.toMatch(/work widget/)
  }
}

async function boot(env: Record<string, string> = {}): Promise<LaunchedApp> {
  launched = await launchApp({ env: { PLEXI_APP: 'preview3', PLEXI_WEB_MENU_HOOK: '1', ...env } })
  await waitForReady(launched.window)
  return launched
}

test('WCM-1 — standalone browser (the web panel): the full menu', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate((u) => (window as unknown as { __fbWebPanel: { getState: () => { openWeb: (u: string, o?: unknown) => void } } }).__fbWebPanel.getState().openWeb(u, { expanded: true }), url)
  await waitLoaded(app, url)
  await checkAll(app, url, 'browser')
})

test('WCM-2 — browser work widget on a desk: the same menu plus the desk actions', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate(async (u) => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'MenuDesk' })
    await api.widgets.create({ taskId: task.id, kind: 'webview', title: '', content: u, x: 60, y: 60, width: 640, height: 420 })
  }, url)
  await window.reload()
  await waitForReady(window)
  await window.getByRole('button', { name: /MenuDesk/ }).first().click()
  await waitLoaded(app, url)
  // The widget registers itself as a desk surface on dom-ready.
  await expect.poll(async () => (await rightClick(app, url, '#empty'))?.surface, { timeout: 10_000 }).toBe('desk')
  await checkAll(app, url, 'desk')
})

test('WCM-3 — a connected app (its own partition): the full menu, no desk actions', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate((src) => {
    const wv = document.createElement('webview')
    wv.setAttribute('partition', 'persist:connectedapp-e2e')
    wv.setAttribute('src', src)
    wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:420px;height:300px;z-index:1'
    document.body.appendChild(wv)
  }, url)
  await waitLoaded(app, url)
  await checkAll(app, url, 'connected-app')
})

for (const native of [false, true]) {
  test(`WCM-4${native ? 'b' : 'a'} — a pop-up ${native ? 'as a native window' : 'on the desk'}: the full menu`, async () => {
    const { app, window } = await boot(native ? { PLEXI_POPUPS_NATIVE: '1' } : {})
    const url = `${origin}/m.html`
    await window.evaluate((src) => {
      const wv = document.createElement('webview')
      wv.setAttribute('allowpopups', 'true')
      wv.setAttribute('src', src)
      wv.style.cssText = 'position:fixed;right:8px;bottom:8px;width:320px;height:200px;z-index:1'
      document.body.appendChild(wv)
    }, url)
    await waitLoaded(app, url)
    await app.evaluate(({ webContents }, u) => webContents.getAllWebContents().find((w) => w.getURL() === u)!.executeJavaScript('window.openPop()', true), url)
    const popUrl = `${url}?pop=1`
    await waitLoaded(app, popUrl)
    await checkAll(app, popUrl, 'popup')
  })
}

// ── 4.3.41: the standalone browsers, Add to desk, PlexiiAssist and AI Assist ──
// Owner: "Right click only offers copy, not AI tools or ability to add image,
// video or highlighted text to a new desk or existing desk."

type Flat = Array<{ id: string; label: string; enabled: boolean; path: string[] }>
const flat = (app: ElectronApplication): Promise<Flat> =>
  app.evaluate(() => ((globalThis as unknown as { __plexiiLastWebMenu?: { flat: Flat } }).__plexiiLastWebMenu?.flat ?? []) as never)
/** Choose an item of the menu just recorded, as a click on it would. */
const choose = (app: ElectronApplication, id: string): Promise<boolean> =>
  app.evaluate((_e, item) => (globalThis as unknown as { __plexiiRunWebMenuItem: (id: string) => boolean }).__plexiiRunWebMenuItem(item), id)

async function openWebPanel(window: LaunchedApp['window'], url: string): Promise<void> {
  await window.evaluate((u) => (window as unknown as { __fbWebPanel: { getState: () => { openWeb: (u: string, o?: unknown) => void } } }).__fbWebPanel.getState().openWeb(u, { expanded: true }), url)
}
async function makeDesks(window: LaunchedApp['window'], titles: string[]): Promise<string[]> {
  return window.evaluate(async (ts) => {
    const ids: string[] = []
    for (const t of ts) {
      ids.push((await window.api.nodes.create({ parentId: null, kind: 'task', title: t })).id)
      await new Promise((r) => setTimeout(r, 5)) // distinct updatedAt, so "most recent" is well defined
    }
    await (window as unknown as { __fbNodes: { getState: () => { refresh: () => Promise<void> } } }).__fbNodes.getState().refresh()
    return ids
  }, titles)
}
const widgetsOn = (window: LaunchedApp['window'], deskId: string): Promise<Array<{ kind: string; content: string; title: string }>> =>
  window.evaluate(async (id) => (await window.api.widgets.listByTask(id)).map((w) => ({ kind: w.kind, content: w.content, title: w.title })), deskId)

test('WCM-5 — the PlexiiOffice browser (standalone): the full menu, no desk-only items', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await window.evaluate((u) => {
    localStorage.setItem('plexi.officeBrowser.url', u)
    ;(window as unknown as { __fbView: { getState: () => { goOffice: (a: string) => void } } }).__fbView.getState().goOffice('browser')
  }, url)
  await waitLoaded(app, url)
  await checkAll(app, url, 'browser')
})

test('WCM-6 — Add image to desk: an existing desk, most recent first; one undoable action with a toast', async () => {
  const { app, window } = await boot()
  const [older, recent] = await makeDesks(window, ['Older desk', 'Research desk'])
  const url = `${origin}/m.html`
  await openWebPanel(window, url)
  await waitLoaded(app, url)
  await rightClick(app, url, '#img')
  const items = (await flat(app)).filter((e) => e.path[0] === 'Add image to desk')
  expect(items.map((e) => e.label)).toEqual(['New desk…', 'Research desk', 'Older desk'])
  expect(items.map((e) => e.id)).toEqual(['desk:image:new', `desk:image:${recent}`, `desk:image:${older}`])
  expect(await choose(app, `desk:image:${recent}`)).toBe(true)
  await expect.poll(async () => (await widgetsOn(window, recent)).map((w) => w.kind), { timeout: 10_000 }).toEqual(['image'])
  await expect(window.getByTestId('undo-toast-label')).toHaveText('Added image to Research desk')
  await expect(window.getByTestId('undo-toast-action')).toHaveText('Open desk')
  await window.getByTestId('undo-toast-undo').click()
  await expect.poll(async () => (await widgetsOn(window, recent)).length, { timeout: 10_000 }).toBe(0)
})

test('WCM-7 — Add selection to desk → New desk…: named from the page, the text lands as a sticky', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await openWebPanel(window, url)
  await waitLoaded(app, url)
  await rightClick(app, url, '#text', { select: true })
  expect(await choose(app, 'desk:selection:new')).toBe(true)
  const picker = window.getByTestId('add-to-desk-picker')
  await expect(picker).toBeVisible()
  await expect(window.getByTestId('add-to-desk-name')).toHaveValue('Menu test')
  await expect(window.getByTestId('add-to-desk-becomes')).toHaveText('Becomes a sticky work widget')
  await window.getByTestId('add-to-desk-name').fill('From the web')
  await window.getByTestId('add-to-desk-create').click()
  await expect(picker).toHaveCount(0)
  const findDesk = (): Promise<string | null> =>
    window.evaluate(async () => (await window.api.nodes.list()).find((n) => n.title === 'From the web' && n.kind === 'task')?.id ?? null)
  await expect.poll(findDesk, { timeout: 10_000 }).not.toBeNull()
  const deskId = (await findDesk())!
  await expect
    .poll(async () => (await widgetsOn(window, deskId)).map((w) => ({ kind: w.kind, content: w.content })), { timeout: 10_000 })
    .toEqual([{ kind: 'sticky', content: 'Some selectable words here.' }])
  await expect(window.getByTestId('undo-toast-label')).toHaveText('Added selection to a new desk, From the web')
  // One undo takes the new desk and its work widget away together.
  await window.getByTestId('undo-toast-undo').click()
  await expect.poll(async () => window.evaluate(async () => (await window.api.nodes.list()).some((n) => n.title === 'From the web')), { timeout: 10_000 }).toBe(false)
})

test('WCM-8 — many desks: Add link to desk → Choose a desk… searches them all', async () => {
  const { app, window } = await boot()
  const ids = await makeDesks(window, Array.from({ length: 11 }, (_, i) => `Desk ${String.fromCharCode(65 + i)}`))
  const url = `${origin}/m.html`
  await openWebPanel(window, url)
  await waitLoaded(app, url)
  await rightClick(app, url, '#link')
  const items = (await flat(app)).filter((e) => e.path[0] === 'Add link to desk')
  expect(items).toHaveLength(1 + 8 + 1) // New desk…, the 8 most recent, Choose a desk…
  expect(items[1].label).toBe('Desk K')
  expect(items.at(-1)!.label).toBe('Choose a desk…')
  expect(await choose(app, 'desk:link:choose')).toBe(true)
  await window.getByTestId('add-to-desk-search').fill('desk a')
  await expect(window.locator('[data-testid^="add-to-desk-desk-"]')).toHaveCount(1)
  await window.getByTestId(`add-to-desk-desk-${ids[0]}`).click()
  await expect.poll(async () => (await widgetsOn(window, ids[0])).map((w) => [w.kind, w.content]), { timeout: 10_000 }).toEqual([['webview', `${origin}/other.html`]])
  await expect(window.getByTestId('undo-toast-label')).toHaveText('Added link to Desk A')
})

test('WCM-9 — selected text: Ask PlexiiAssist stages the passage; AI Assist previews without writing to the page', async () => {
  const { app, window } = await boot()
  const url = `${origin}/m.html`
  await openWebPanel(window, url)
  await waitLoaded(app, url)
  await rightClick(app, url, '#text', { select: true })
  const ai = (await flat(app)).filter((e) => e.path[0] === 'AI Assist').map((e) => e.label)
  expect(ai).toEqual(expect.arrayContaining(['Summarise', 'Explain', 'Simplify', 'Rewrite', 'French', 'Formal', 'Custom Prompt…']))
  expect(await choose(app, 'ask-assist')).toBe(true)
  await expect
    .poll(() =>
      window.evaluate(() => {
        const chat = (window as unknown as { __fbChat: { getState: () => { draftDocByThread: Record<string, unknown> } } }).__fbChat.getState()
        return JSON.stringify(chat.draftDocByThread)
      }),
      { timeout: 10_000 }
    )
    .toMatch(/About this passage \(from Menu test.*Some selectable words here\./)
  await rightClick(app, url, '#text', { select: true })
  expect(await choose(app, 'ai:custom')).toBe(true)
  const preview = window.getByTestId('ai-assist-preview')
  await expect(preview).toBeVisible()
  // Custom Prompt waits for the instruction; nothing ran, nothing was written.
  await expect(window.getByTestId('ai-assist-run')).toBeDisabled()
  await expect(window.getByTestId('ai-assist-apply')).toHaveCount(0)
})

