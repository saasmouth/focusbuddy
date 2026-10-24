// E2E: WP3's right-click menus as a person meets them (SPEC §9.3, AUDIT M-n, M-o, M-q).
//
//   CM3-1  Files: a REAL right-click on an entry in the flyout and on the same
//          entry in the full Files view draws the one shared menu (groups,
//          separators, danger on Move to Trash), the empty area gets the empty
//          shape, the keyboard works and focus returns to the row. Light and dark.
//   CM3-2  PlexiiAssist: a REAL right-click on an assistant reply with nothing
//          selected now opens a menu (Add to Focus… · Retry | Copy), and Copy
//          copies the reply. Light and dark.
//   CM3-3  The app window's native text menu (M-q). Native menus cannot be read
//          or screenshotted from Playwright, so the main-process test hook
//          (NODE_ENV=test + PLEXI_WEB_MENU_HOOK=1) records what main built and
//          counts every 'context-menu' event the window received:
//          - a rename field and the composer get the §9.3 text shape;
//          - the assistant's own composer leaves out Ask PlexiiAssist (it
//            registered askAssist: false in lib/textMenuHandlers.ts);
//          - a kit menu (Files, chat) does NOT reach main: the page's
//            preventDefault suppresses Electron's event on this Electron;
//          - a click on chrome with nothing selected builds no menu;
//          - "Ask PlexiiAssist about this" from a field stages the quote.
import { test, expect, type Page, type ElectronApplication } from '@playwright/test'
import { mkdirSync } from 'fs'
import { launchApp, waitForReady, suppressFeatureSpotlights, chooseCloudAiSource, typeInComposer, type LaunchedApp } from './_helpers'

const SHOTS = '/private/tmp/claude-501/-Users-mymac-Desktop-My-Apps-06-Agentic-Starter-Kit--links-/496f07e8-34aa-467c-81bd-e6d13054477c/scratchpad/ctx-menus/wp3'
mkdirSync(SHOTS, { recursive: true })

let launched: LaunchedApp | null = null
test.afterEach(async () => {
  await launched?.dispose()
  launched = null
})

type Seed = { taskId: string; fileId: string; folderId: string }

async function boot(theme: 'light' | 'dark'): Promise<{ window: Page; app: ElectronApplication; seed: Seed }> {
  launched = await launchApp({ env: { PLEXI_WEB_MENU_HOOK: '1' } })
  const { window, app } = launched
  await waitForReady(window)
  const seed = (await window.evaluate(async () => {
    const api = (window as unknown as { api: typeof window.api }).api
    const task = await api.nodes.create({ parentId: null, kind: 'task', title: 'Menu desk' })
    const folder = await api.fileManager.createFolder(null, 'Alpha folder')
    const file = await api.files.ingestBuffer({ buffer: new TextEncoder().encode('a,b\n1,2\n').buffer, originalName: 'numbers.csv', mimeType: 'text/csv', parentId: null })
    return { taskId: task.id, fileId: file.id, folderId: folder.id }
  })) as Seed
  await window.evaluate((t) => localStorage.setItem('fb.theme.mode', t), theme)
  await suppressFeatureSpotlights(window)
  await window.reload()
  await waitForReady(window)
  await chooseCloudAiSource(window)
  return { window, app, seed }
}

async function goDesk(window: Page, id: string): Promise<void> {
  await window.evaluate((i: string) => (window as unknown as { __fbView: { getState: () => { goTask: (x: string) => void } } }).__fbView.getState().goTask(i), id)
  await window.waitForSelector('[data-canvas-surface="true"]', { timeout: 15_000 })
}

/** The open kit menu as it renders: groups of labels split at separators, and which labels are drawn as danger. */
async function renderedMenu(window: Page): Promise<{ groups: string[][]; danger: string[]; shortcuts: Record<string, string> }> {
  const menu = window.locator('[data-canvas-ctx-menu][role="menu"]').first()
  await expect(menu).toBeVisible()
  return menu.evaluate((root) => {
    const groups: string[][] = [[]]
    const danger: string[] = []
    const shortcuts: Record<string, string> = {}
    for (const child of Array.from(root.children)) {
      if (child.getAttribute('role') === 'separator') {
        groups.push([])
        continue
      }
      const btn = child.matches('button') ? child : child.querySelector('button')
      if (!btn) continue
      const labelEl = btn.querySelector('span.flex-1')
      const label = (labelEl?.firstChild?.textContent ?? '').trim()
      groups[groups.length - 1]!.push(label)
      if (btn.className.includes('text-red-600')) danger.push(label)
      const sc = btn.querySelector('span.font-mono')?.textContent
      if (sc) shortcuts[label] = sc
    }
    return { groups: groups.filter((g) => g.length), danger, shortcuts }
  })
}

/** Let the menu's entrance animation finish so the screenshot shows it as it rests. */
const settle = (window: Page): Promise<void> => window.waitForTimeout(400)

/** How many 'context-menu' events the app window has received (main test hook). */
const mainMenuEvents = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => ((globalThis as unknown as { __plexiiAppMenuEvents?: () => number }).__plexiiAppMenuEvents?.() ?? -1))

type AppMenu = { entries: Array<{ type?: string; id?: string; label?: string; enabled?: boolean; accelerator?: string }>; isEditable: boolean; hasSelection: boolean; caps: { askAssist: boolean; saveSnippet: boolean }; events: number } | null
async function lastAppMenu(app: ElectronApplication, after: number): Promise<AppMenu> {
  await expect.poll(() => mainMenuEvents(app), { timeout: 5000 }).toBeGreaterThan(after)
  // The template is built after one round trip to the page (the assistant opt-out).
  await expect
    .poll(() => app.evaluate(() => ((globalThis as unknown as { __plexiiAppTextMenu?: { events: number } }).__plexiiAppTextMenu?.events ?? 0)), { timeout: 5000 })
    .toBeGreaterThan(after)
  return app.evaluate(() => (globalThis as unknown as { __plexiiAppTextMenu?: AppMenu }).__plexiiAppTextMenu ?? null)
}
const nativeGroups = (m: AppMenu): string[][] => {
  const out: string[][] = [[]]
  for (const e of m?.entries ?? []) {
    if (e.type === 'separator') out.push([])
    else out[out.length - 1]!.push(e.label ?? '')
  }
  return out.filter((g) => g.length)
}

const FILE_GROUPS = [['Open', 'Rename', 'Reveal in Finder'], ['Share…'], ['Move to Trash']]

for (const theme of ['light', 'dark'] as const) {
  test(`CM3-1 Files: one menu in the flyout and the full view, empty area, keyboard (${theme})`, async () => {
    test.setTimeout(150_000)
    const { window, app, seed } = await boot(theme)
    await goDesk(window, seed.taskId)
    await window.locator('[data-testid="files-panel-toggle"]').click()
    const row = window.locator(`[data-testid="files-panel"] [data-entry-id="${seed.fileId}"]`)
    await expect(row).toBeVisible({ timeout: 10_000 })

    const before = await mainMenuEvents(app)
    expect(before).toBeGreaterThanOrEqual(0) // the hook is live
    await row.click({ button: 'right' })
    const flyout = await renderedMenu(window)
    // A desk is open: Add to this desk; the flyout's way to the full view.
    expect(flyout.groups).toEqual([['Open', 'Add to this desk', 'Show in full Files', 'Rename', 'Reveal in Finder'], ['Share…'], ['Move to Trash']])
    expect(flyout.danger).toEqual(['Move to Trash'])
    await settle(window)
    await window.screenshot({ path: `${SHOTS}/files-flyout-entry-${theme}.png` })

    // Keyboard: arrows move, Escape closes, focus returns to the row.
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Escape')
    await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)
    await expect(row).toBeFocused()
    // The kit menu took the right-click: Electron never offered it to main.
    expect(await mainMenuEvents(app)).toBe(before)

    // The same entry in the full Files view says the same thing, minus the flyout's own rows.
    await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goFiles: () => void } } }).__fbView.getState().goFiles())
    const full = window.locator(`[data-testid="file-entry-${seed.fileId}"]`)
    await expect(full).toBeVisible({ timeout: 10_000 })
    await full.click({ button: 'right' })
    const view = await renderedMenu(window)
    expect(view.groups).toEqual(FILE_GROUPS)
    expect(view.danger).toEqual(['Move to Trash'])
    await settle(window)
    await window.screenshot({ path: `${SHOTS}/files-view-entry-${theme}.png` })
    await window.keyboard.press('Escape')

    // A folder: Collaborate live uploads to the server; this profile is signed out, so it is off and says why.
    await window.locator(`[data-testid="file-entry-${seed.folderId}"]`).click({ button: 'right' })
    expect((await renderedMenu(window)).groups).toEqual([['Open', 'Rename', 'Collaborate live'], ['Share…'], ['Move to Trash']])
    await expect(window.locator('[data-testid="files-menu-live"]')).toBeDisabled()
    await expect(window.locator('[data-testid="files-menu-live"]')).toContainText('Sign in to collaborate live')
    await window.keyboard.press('Escape')

    // The empty area: create here | Select all.
    // Just under the last row, mid-width: the listing's own empty space (the
    // window's corners carry floating status chrome).
    const list = (await window.locator('[data-testid="files-list"]').boundingBox())!
    await window.mouse.click(list.x + list.width / 2, list.y + list.height + 40, { button: 'right' })
    const empty = await renderedMenu(window)
    expect(empty.groups).toEqual([['New folder', 'Add files…', 'Import folder…', 'Add document…'], ['Select all']])
    await settle(window)
    await window.screenshot({ path: `${SHOTS}/files-view-empty-${theme}.png` })
    await window.locator('[data-testid="files-menu-select-all"]').click()
    const rows = window.locator('[data-testid^="file-entry-"]')
    await expect(window.locator('[data-testid^="file-entry-"].bg-accent\\/10')).toHaveCount(await rows.count())
    expect(await mainMenuEvents(app)).toBe(before)

    // Move to Trash is the soft delete: the entry leaves the listing, and Undo brings it back.
    await full.click({ button: 'right' })
    await window.locator('[data-testid="files-menu-trash"]').click()
    await expect(full).toHaveCount(0)
    await window.locator('[data-testid="files-undo"]').click()
    await expect(full).toBeVisible()
  })

  test(`CM3-2 PlexiiAssist: a reply has a menu without a selection, and Copy copies it (${theme})`, async () => {
    test.setTimeout(120_000)
    const { window, app } = await boot(theme)
    await window.evaluate(() => window.dispatchEvent(new CustomEvent('fb:open-assistant')))
    await window.locator('[data-testid="assistant-tab-chat"]').click()
    await window.locator('[data-testid="assistant-panel"]').waitFor({ state: 'visible', timeout: 8000 })
    await app.evaluate(({ ipcMain }) => {
      try {
        ipcMain.removeHandler('chat:sendStream')
      } catch {
        /* first install */
      }
      ipcMain.handle('chat:sendStream', async (e, input: { requestId: string }) => {
        const ch = `chat:stream:${input.requestId}`
        const send = (type: string, payload: unknown): void => {
          if (!e.sender.isDestroyed()) e.sender.send(ch, { type, payload })
        }
        await new Promise((r) => setTimeout(r, 20))
        send('sources', { sources: [], elapsedMs: 5 })
        send('reply', 'The reply to copy.')
        send('complete', { ok: true, message: { role: 'assistant', content: 'The reply to copy.', ts: Date.now() } })
        return { ok: true }
      })
    })
    // "Ask" pins the intent (Auto may read a short line as a web search).
    await window.locator('[data-testid="assistant-panel"]').getByRole('button', { name: 'Ask', exact: true }).click()
    await typeInComposer(window, 'what does the plan say about hiring')
    await window.locator('button[aria-label="Send"]').click()
    const reply = window.locator('[data-testid="assistant-turn"]').filter({ hasText: 'The reply to copy.' }).last()
    await expect(reply).toBeVisible({ timeout: 10_000 })
    await window.evaluate(() => window.getSelection()?.removeAllRanges())

    const before = await mainMenuEvents(app)
    await reply.getByText('The reply to copy.').click({ button: 'right' })
    const m = await renderedMenu(window)
    expect(m.groups).toEqual([['Add to Focus…', 'Retry'], ['Copy']])
    expect(m.danger).toEqual([])
    await settle(window)
    await window.screenshot({ path: `${SHOTS}/chat-assistant-reply-${theme}.png` })
    expect(await mainMenuEvents(app)).toBe(before)

    await app.evaluate(({ clipboard }) => clipboard.writeText(''))
    await window.locator('[data-testid="chat-menu-copy"]').click()
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('The reply to copy.')

    // Your own message: Copy.
    await window.locator('[data-testid="user-turn"]').last().click({ button: 'right' })
    expect((await renderedMenu(window)).groups).toEqual([['Copy']])
    await window.keyboard.press('Escape')
  })
}

test('CM3-3 the app window text menu: fields get the native text shape; kit menus never reach main; chrome gets nothing', async () => {
  test.setTimeout(150_000)
  const { window, app, seed } = await boot('light')

  // A rename field in Files, its text selected as rename starts.
  await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goFiles: () => void } } }).__fbView.getState().goFiles())
  const full = window.locator(`[data-testid="file-entry-${seed.fileId}"]`)
  await expect(full).toBeVisible({ timeout: 10_000 })
  await full.click({ button: 'right' })
  await window.locator('[data-testid="files-menu-rename"]').click()
  const input = full.locator('input')
  await expect(input).toBeFocused()
  await input.evaluate((el: HTMLInputElement) => el.select())
  let n = await mainMenuEvents(app)
  await input.click({ button: 'right' })
  const rename = await lastAppMenu(app, n)
  expect(rename?.isEditable).toBe(true)
  expect(nativeGroups(rename)).toEqual([['Cut', 'Copy', 'Paste', 'Paste as plain text'], ['Select all'], ['Ask PlexiiAssist about this']])
  expect((rename?.entries ?? []).filter((e) => e.accelerator).map((e) => e.accelerator)).toEqual([
    'CommandOrControl+X',
    'CommandOrControl+C',
    'CommandOrControl+V',
    'Alt+Shift+CommandOrControl+V',
    'CommandOrControl+A'
  ])
  // No kit menu was drawn over it.
  await expect(window.locator('[data-canvas-ctx-menu]')).toHaveCount(0)

  expect(rename?.caps).toEqual({ askAssist: true, saveSnippet: false }) // no surface claimed it: the generic routes
  // "Ask PlexiiAssist about this" goes out on textMenu:action; with no surface
  // claiming it, the generic route stages the passage in the composer.
  const ran = await app.evaluate(() => (globalThis as unknown as { __plexiiRunAppTextMenuItem: (id: string) => boolean }).__plexiiRunAppTextMenuItem('ask-assist'))
  expect(ran).toBe(true)
  await window.locator('[data-testid="assistant-panel"]').waitFor({ state: 'visible', timeout: 8000 })
  await expect(window.locator('[data-testid="assistant-panel"] .ProseMirror').first()).toContainText('About this passage', { timeout: 8000 })
  await expect(window.locator('[data-testid="assistant-panel"] .ProseMirror').first()).toContainText('numbers')

  // The assistant's own composer: the text shape without Ask PlexiiAssist.
  const composer = window.locator('[data-testid="assistant-panel"] .ProseMirror').first()
  await composer.click()
  await window.keyboard.press('ControlOrMeta+a')
  n = await mainMenuEvents(app)
  await composer.click({ button: 'right' })
  const own = await lastAppMenu(app, n)
  expect(own?.isEditable).toBe(true)
  // Text IS selected, and still no Ask PlexiiAssist: the composer opts out.
  expect(own?.hasSelection).toBe(true)
  expect(own?.caps).toEqual({ askAssist: false, saveSnippet: false })
  expect(nativeGroups(own)).toEqual([['Cut', 'Copy', 'Paste', 'Paste as plain text'], ['Select all']])

  // Read-only text the person selected first: Copy | Ask PlexiiAssist about this.
  await window.keyboard.press('Escape')
  await window.evaluate(() => (window as unknown as { __fbView: { getState: () => { goFiles: () => void } } }).__fbView.getState().goFiles())
  const heading = window.locator('[data-testid="files-view"] h1')
  await heading.evaluate((el) => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    const r = document.createRange()
    r.selectNodeContents(el)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(r)
  })
  n = await mainMenuEvents(app)
  await heading.click({ button: 'right' })
  const ro = await lastAppMenu(app, n)
  expect(ro?.isEditable).toBe(false)
  expect(nativeGroups(ro)).toEqual([['Copy'], ['Ask PlexiiAssist about this']])

  // A click on chrome with nothing selected first: Electron reports it (on
  // macOS with the word under it selected), and main builds no menu.
  await window.keyboard.press('Escape')
  await window.evaluate(() => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.getSelection()?.removeAllRanges()
  })
  n = await mainMenuEvents(app)
  await window.locator('[data-testid="files-crumb-root"]').click({ button: 'right' })
  const chrome = await lastAppMenu(app, n)
  expect(chrome?.entries).toEqual([])
})
