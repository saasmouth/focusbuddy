// The right-click menu for web content, everywhere web content renders:
// the standalone browser (web panel, PlexiiOffice browser), a browser work
// widget on a desk (and in focus mode), connected apps, other embedded
// webviews, and desk pop-ups (on the desk or as native windows).
//
// Before 4.3.39-local.4 only the browser work widget on a desk had a menu
// outside editable fields: everything else was forwarded to a renderer menu
// that only knew desk widgets, and dropped. Pop-ups had no menu at all. Now
// every surface gets the same NATIVE menu (Menu.popup from main, so it works
// over a webview and over a WebContentsView), built from the click's params
// by one pure function, with the desk's own actions offered on the desk only.
//
// buildWebMenu() is pure (tested in tests/unit/webContextMenu.test.ts); the
// Electron side only maps item ids to actions and pops the menu up.
import { BrowserWindow, Menu, MenuItem, clipboard, shell, app, ipcMain, type ContextMenuParams, type WebContents } from 'electron'
import { AI_LANGUAGES, AI_TONES, WEB_SELECTION_AI_ACTIONS, aiTextAction } from '@shared/aiTextActions'
import type { DeskTarget, WebMenuCommand } from '@shared/webMenu'

export type { DeskTarget, WebMenuCommand }

export type WebSurface = 'desk' | 'browser' | 'connected-app' | 'popup'

export interface WebMenuContext {
  surface: WebSurface
  canGoBack: boolean
  canGoForward: boolean
  /** Inspect element is offered in development builds only. */
  dev: boolean
  /**
   * The desks "Add … to desk" lists, most recently changed first (already
   * capped), and whether more exist than are listed (then "Choose a desk…"
   * opens the searchable picker). Absent: no Add to desk items at all.
   */
  desks?: { listed: Array<{ id: string; title: string }>; more: boolean }
}

/** The surfaces that offer Add to desk and the AI text actions: the standalone browser and the browser work widget. */
export const WORK_SURFACES: readonly WebSurface[] = ['browser', 'desk']


/** Most desks the submenu lists by name before "Choose a desk…" takes over. */
export const DESKS_LISTED = 8

export type WebMenuParams = Pick<
  ContextMenuParams,
  'x' | 'y' | 'linkURL' | 'srcURL' | 'mediaType' | 'selectionText' | 'isEditable' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions'
>

export type WebMenuAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'open-link'
  | 'open-link-widget'
  | 'open-link-external'
  | 'copy-link'
  | 'save-image'
  | 'copy-image'
  | 'copy-image-address'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'select-all'
  | 'add-to-dictionary'
  | 'copy-video-address'
  | 'more-desk'
  | 'inspect'
  | 'ask-assist'
  | `spelling:${string}`
  /** desk:<target>:<desk id | new | choose> */
  | `desk:${DeskTarget}:${string}`
  /** ai:<command> — an action id, tone:<Tone>, translate:<Language>, custom-tone, custom-language, custom */
  | `ai:${string}`

export type WebMenuEntry =
  | { type: 'separator' }
  | { id: WebMenuAction; label: string; enabled: boolean }
  | { label: string; submenu: WebMenuEntry[] }

const web = (u: string | undefined): boolean => !!u && /^https?:\/\//i.test(u)

/** Join groups with single separators: never one at either end, never two in a row. */
function joinGroups(groups: WebMenuEntry[][]): WebMenuEntry[] {
  const out: WebMenuEntry[] = []
  for (const g of groups) {
    if (g.length === 0) continue
    if (out.length) out.push({ type: 'separator' })
    out.push(...g)
  }
  return out
}

const DESK_TARGET_LABEL: Record<DeskTarget, string> = {
  selection: 'Add selection to desk',
  image: 'Add image to desk',
  video: 'Add video to desk',
  link: 'Add link to desk',
  page: 'Add page to desk'
}

/** "Add <thing> to desk" ▸ New desk…, the recent desks, Choose a desk… */
function deskSubmenu(target: DeskTarget, desks: NonNullable<WebMenuContext['desks']>): WebMenuEntry {
  const item = (id: WebMenuAction, label: string): WebMenuEntry => ({ id, label, enabled: true })
  return {
    label: DESK_TARGET_LABEL[target],
    submenu: joinGroups([
      [item(`desk:${target}:new`, 'New desk…')],
      desks.listed.map((d) => item(`desk:${target}:${d.id}`, d.title.trim() || 'Untitled desk')),
      desks.more ? [item(`desk:${target}:choose`, 'Choose a desk…')] : []
    ])
  }
}

/** PlexiiAssist and the AI text actions, for selected text. */
function aiGroup(): WebMenuEntry[] {
  const item = (id: WebMenuAction, label: string): WebMenuEntry => ({ id, label, enabled: true })
  const direct = WEB_SELECTION_AI_ACTIONS.map((id) => item(`ai:${id}`, aiTextAction(id)?.label ?? id))
  return [
    item('ask-assist', 'Ask PlexiiAssist about this'),
    {
      label: 'AI Assist',
      submenu: joinGroups([
        direct,
        [
          { label: 'Change Tone', submenu: [...AI_TONES.map((t) => item(`ai:tone:${t}`, t)), { type: 'separator' }, item('ai:custom-tone', 'Custom tone…')] },
          {
            label: 'Translate',
            submenu: [...AI_LANGUAGES.map((l) => item(`ai:translate:${l}`, l)), { type: 'separator' }, item('ai:custom-language', 'Custom language…')]
          }
        ],
        [item('ai:custom', 'Custom Prompt…')]
      ])
    }
  ]
}

/** The menu for one right-click. Pure: the same params and context always give the same menu. */
export function buildWebMenu(p: WebMenuParams, ctx: WebMenuContext): WebMenuEntry[] {
  const groups: WebMenuEntry[][] = []
  const item = (id: WebMenuAction, label: string, enabled = true): WebMenuEntry => ({ id, label, enabled })
  // Add to desk and the AI text actions belong to the browser surfaces only:
  // not to connected apps (a signed-in app is not a page you are reading) or
  // pop-ups (sign-in windows).
  const work = WORK_SURFACES.includes(ctx.surface)
  const desks = work ? ctx.desks : undefined
  const selected = !!(p.selectionText && p.selectionText.trim())
  const image = p.mediaType === 'image' && !!p.srcURL
  const video = p.mediaType === 'video'

  if (p.isEditable) {
    const spelling: WebMenuEntry[] = (p.dictionarySuggestions ?? []).slice(0, 5).map((s) => item(`spelling:${s}`, s))
    if (p.misspelledWord) spelling.push(item('add-to-dictionary', 'Add to dictionary'))
    if (spelling.length) groups.push(spelling)
    groups.push([item('undo', 'Undo', p.editFlags.canUndo), item('redo', 'Redo', p.editFlags.canRedo)])
    groups.push([
      item('cut', 'Cut', p.editFlags.canCut),
      item('copy', 'Copy', p.editFlags.canCopy),
      item('paste', 'Paste', p.editFlags.canPaste),
      item('select-all', 'Select all', p.editFlags.canSelectAll)
    ])
  } else {
    // What this click is on, most specific first; each gets its own actions
    // and, on the browser surfaces, its own "Add … to desk".
    const adds: WebMenuEntry[] = []
    if (selected) {
      groups.push([item('copy', 'Copy', p.editFlags.canCopy)])
      if (work) groups.push(aiGroup())
      if (desks) adds.push(deskSubmenu('selection', desks))
    }
    if (web(p.linkURL)) {
      groups.push([
        ctx.surface === 'desk' ? item('open-link-widget', 'Open link as a new browser work widget') : item('open-link', 'Open link'),
        item('open-link-external', 'Open link in default browser'),
        item('copy-link', 'Copy link address')
      ])
      if (desks) adds.push(deskSubmenu('link', desks))
    }
    if (image) {
      groups.push([
        item('save-image', 'Save image as…', web(p.srcURL) || p.srcURL.startsWith('data:') || p.srcURL.startsWith('blob:')),
        item('copy-image', 'Copy image'),
        item('copy-image-address', 'Copy image address', !p.srcURL.startsWith('data:'))
      ])
      if (desks) adds.push(deskSubmenu('image', desks))
    }
    if (video) {
      // A streamed video (blob:) has no address worth copying; Add to desk
      // then places the page it plays on.
      if (web(p.srcURL)) groups.push([item('copy-video-address', 'Copy video address')])
      if (desks) adds.push(deskSubmenu('video', desks))
    }
    if (!web(p.linkURL) && !image && !video && !selected) {
      groups.push([item('back', 'Back', ctx.canGoBack), item('forward', 'Forward', ctx.canGoForward), item('reload', 'Reload')])
      groups.push([item('select-all', 'Select all', p.editFlags.canSelectAll)])
      if (desks) adds.push(deskSubmenu('page', desks))
    }
    groups.push(adds)
  }
  // The desk's own actions (send the selection or link to a note, Attention,
  // save media to the desk, AI Assist…) live in the work widget menu.
  if (ctx.surface === 'desk') groups.push([item('more-desk', 'More work widget actions…')])
  if (ctx.dev) groups.push([item('inspect', 'Inspect element')])

  return joinGroups(groups)
}

/** Every leaf item, submenus flattened (tests and the test hook read this). */
export function flattenWebMenu(entries: WebMenuEntry[]): Array<{ id: WebMenuAction; label: string; enabled: boolean; path: string[] }> {
  const out: Array<{ id: WebMenuAction; label: string; enabled: boolean; path: string[] }> = []
  const walk = (es: WebMenuEntry[], path: string[]): void => {
    for (const e of es) {
      if ('type' in e) continue
      if ('submenu' in e) walk(e.submenu, [...path, e.label])
      else out.push({ ...e, path })
    }
  }
  walk(entries, [])
  return out
}

// ── Electron side ───────────────────────────────────────────────────────────

/** webContents id → surface, as the renderer registers its webviews (desk widgets, panels). */
const surfaces = new Map<number, WebSurface>()
const attached = new WeakSet<WebContents>()

/** Test hook (e2e, NODE_ENV=test only): the last menu built, instead of popping it up. */
export let lastWebMenu: { surface: WebSurface; webContentsId: number; entries: WebMenuEntry[]; flat: ReturnType<typeof flattenWebMenu> } | null = null
const testHook = (): boolean => process.env.NODE_ENV === 'test' && process.env.PLEXI_WEB_MENU_HOOK === '1'

/** The desks a menu lists: set by index.ts from the database (most recently changed first). */
type DeskSource = () => Array<{ id: string; title: string }>
let deskSource: DeskSource = () => []
export function setWebMenuDeskSource(fn: DeskSource): void {
  deskSource = fn
}
function desksForMenu(): NonNullable<WebMenuContext['desks']> {
  let all: Array<{ id: string; title: string }> = []
  try {
    all = deskSource()
  } catch {
    all = [] // a menu never fails over its desk list; New desk… still works
  }
  return { listed: all.slice(0, DESKS_LISTED), more: all.length > DESKS_LISTED }
}

export function registerWebMenuIpc(): void {
  ipcMain.handle('webMenu:setSurface', (_e, webContentsId: number, surface: WebSurface | null) => {
    if (typeof webContentsId !== 'number') return { ok: false }
    if (surface === null) surfaces.delete(webContentsId)
    else if (['desk', 'browser', 'connected-app', 'popup'].includes(surface)) surfaces.set(webContentsId, surface)
    return { ok: true }
  })
}

/** Test hook only: run an item of the last recorded menu as if it had been clicked (native menus cannot be clicked from Playwright). */
function runRecorded(id: string): boolean {
  const contents = lastContents
  if (!testHook() || !lastWebMenu || !lastParams || !contents || contents.isDestroyed()) return false
  if (!lastWebMenu.flat.some((e) => e.id === id && e.enabled)) return false
  run(contents, id as WebMenuAction, lastParams)
  return true
}

let lastParams: ContextMenuParams | null = null
let lastContents: WebContents | null = null

function hostWindow(contents: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? BrowserWindow.getAllWindows()[0] ?? null
}

function toMenu(entries: WebMenuEntry[], contents: WebContents, params: ContextMenuParams): Menu {
  const menu = new Menu()
  for (const e of entries) {
    if ('type' in e) menu.append(new MenuItem({ type: 'separator' }))
    else if ('submenu' in e) menu.append(new MenuItem({ label: e.label, submenu: toMenu(e.submenu, contents, params) }))
    else menu.append(new MenuItem({ label: e.label, enabled: e.enabled, click: () => run(contents, e.id, params) }))
  }
  return menu
}

/**
 * Give one webContents the menu. `fallback` is its surface when the renderer
 * has not registered it (pop-ups are always 'popup'; connected-app partitions
 * are 'connected-app'; any other webview is a browser).
 */
export function attachWebContextMenu(contents: WebContents, fallback: WebSurface): void {
  if (attached.has(contents)) return
  attached.add(contents)
  contents.on('destroyed', () => surfaces.delete(contents.id))
  contents.on('context-menu', (_event, params) => {
    const surface = surfaces.get(contents.id) ?? fallback
    const nav = contents.navigationHistory
    const entries = buildWebMenu(params, {
      surface,
      canGoBack: nav?.canGoBack() ?? false,
      canGoForward: nav?.canGoForward() ?? false,
      dev: !app.isPackaged && process.env.NODE_ENV !== 'test',
      desks: WORK_SURFACES.includes(surface) ? desksForMenu() : undefined
    })
    if (testHook()) {
      lastWebMenu = { surface, webContentsId: contents.id, entries, flat: flattenWebMenu(entries) }
      lastParams = params
      lastContents = contents
      // Readable from Playwright's electronApp.evaluate (main process globals).
      const g = globalThis as unknown as { __plexiiLastWebMenu?: unknown; __plexiiRunWebMenuItem?: (id: string) => boolean }
      g.__plexiiLastWebMenu = lastWebMenu
      g.__plexiiRunWebMenuItem = runRecorded
      return
    }
    const win = hostWindow(contents)
    toMenu(entries, contents, params).popup(win ? { window: win } : {})
  })
}

/** Turn an Add to desk item into its command, from the click's params. Pure; exported for tests. */
export function deskCommandFor(id: `desk:${string}`, p: Pick<ContextMenuParams, 'selectionText' | 'linkURL' | 'srcURL' | 'mediaType'>, page: { url: string; title: string }): WebMenuCommand | null {
  const m = /^desk:(selection|image|video|link|page):(.+)$/.exec(id)
  if (!m) return null
  const target = m[1] as DeskTarget
  const base = { command: 'add-to-desk' as const, target, desk: m[2], pageUrl: page.url, pageTitle: page.title }
  switch (target) {
    case 'selection':
      return p.selectionText?.trim() ? { ...base, text: p.selectionText.trim() } : null
    case 'image':
      return p.srcURL ? { ...base, url: p.srcURL } : null
    case 'video':
      // A streamed video (blob:, MediaSource) cannot be fetched again: the
      // page that plays it is what goes on the desk.
      return { ...base, url: web(p.srcURL) ? p.srcURL : undefined }
    case 'link':
      return web(p.linkURL) ? { ...base, url: p.linkURL } : null
    case 'page':
      return web(page.url) ? { ...base, url: page.url } : null
  }
}

function sendCommand(contents: WebContents, cmd: WebMenuCommand): void {
  hostWindow(contents)?.webContents.send('webMenu:command', cmd)
}

function run(contents: WebContents, id: WebMenuAction, p: ContextMenuParams): void {
  if (id.startsWith('spelling:')) {
    contents.replaceMisspelling(id.slice('spelling:'.length))
    return
  }
  const page = { url: contents.getURL(), title: contents.getTitle() }
  if (id.startsWith('desk:')) {
    const cmd = deskCommandFor(id as `desk:${string}`, p, page)
    if (cmd) sendCommand(contents, cmd)
    return
  }
  if (id.startsWith('ai:')) {
    const text = p.selectionText?.trim()
    if (text) sendCommand(contents, { command: 'ai', ai: id.slice(3), text, pageUrl: page.url, pageTitle: page.title })
    return
  }
  if (id === 'ask-assist') {
    const text = p.selectionText?.trim()
    if (text) sendCommand(contents, { command: 'ask-assist', text, pageUrl: page.url, pageTitle: page.title })
    return
  }
  switch (id) {
    case 'back':
      contents.navigationHistory.goBack()
      return
    case 'forward':
      contents.navigationHistory.goForward()
      return
    case 'reload':
      contents.reload()
      return
    case 'open-link':
      if (web(p.linkURL)) void contents.loadURL(p.linkURL)
      return
    case 'open-link-widget':
      // The browser work widget turns this into a new widget beside itself.
      hostWindow(contents)?.webContents.send('webview:link-clicked', { sourceWebContentsId: contents.id, url: p.linkURL })
      return
    case 'open-link-external':
      if (web(p.linkURL)) void shell.openExternal(p.linkURL)
      return
    case 'copy-link':
      clipboard.writeText(p.linkURL)
      return
    case 'save-image':
      contents.downloadURL(p.srcURL)
      return
    case 'copy-image':
      contents.copyImageAt(p.x, p.y)
      return
    case 'copy-image-address':
    case 'copy-video-address':
      clipboard.writeText(p.srcURL)
      return
    case 'undo':
      contents.undo()
      return
    case 'redo':
      contents.redo()
      return
    case 'cut':
      contents.cut()
      return
    case 'copy':
      contents.copy()
      return
    case 'paste':
      contents.paste()
      return
    case 'select-all':
      contents.selectAll()
      return
    case 'add-to-dictionary':
      contents.session.addWordToSpellCheckerDictionary(p.misspelledWord)
      return
    case 'more-desk':
      // The unified work widget menu, as before, at the click position.
      hostWindow(contents)?.webContents.send('webview:context-menu', {
        webContentsId: contents.id,
        x: p.x,
        y: p.y,
        selectionText: p.selectionText || undefined,
        linkURL: p.linkURL || undefined,
        srcURL: p.srcURL || undefined,
        mediaType: p.mediaType
      })
      return
    case 'inspect':
      contents.inspectElement(p.x, p.y)
      return
  }
}
