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

export type WebSurface = 'desk' | 'browser' | 'connected-app' | 'popup'

export interface WebMenuContext {
  surface: WebSurface
  canGoBack: boolean
  canGoForward: boolean
  /** Inspect element is offered in development builds only. */
  dev: boolean
}

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
  | 'more-desk'
  | 'inspect'
  | `spelling:${string}`

export type WebMenuEntry = { type: 'separator' } | { id: WebMenuAction; label: string; enabled: boolean }

const web = (u: string | undefined): boolean => !!u && /^https?:\/\//i.test(u)

/** The menu for one right-click. Pure: the same params and context always give the same menu. */
export function buildWebMenu(p: WebMenuParams, ctx: WebMenuContext): WebMenuEntry[] {
  const groups: WebMenuEntry[][] = []
  const item = (id: WebMenuAction, label: string, enabled = true): WebMenuEntry => ({ id, label, enabled })

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
    if (web(p.linkURL)) {
      groups.push([
        ctx.surface === 'desk' ? item('open-link-widget', 'Open link as a new browser work widget') : item('open-link', 'Open link'),
        item('open-link-external', 'Open link in default browser'),
        item('copy-link', 'Copy link address')
      ])
    }
    if (p.mediaType === 'image' && p.srcURL) {
      groups.push([
        item('save-image', 'Save image as…', web(p.srcURL) || p.srcURL.startsWith('data:') || p.srcURL.startsWith('blob:')),
        item('copy-image', 'Copy image'),
        item('copy-image-address', 'Copy image address', !p.srcURL.startsWith('data:'))
      ])
    }
    if (p.selectionText && p.selectionText.trim()) groups.push([item('copy', 'Copy', p.editFlags.canCopy)])
    if (!web(p.linkURL) && !(p.mediaType === 'image' && p.srcURL) && !(p.selectionText && p.selectionText.trim())) {
      groups.push([item('back', 'Back', ctx.canGoBack), item('forward', 'Forward', ctx.canGoForward), item('reload', 'Reload')])
      groups.push([item('select-all', 'Select all', p.editFlags.canSelectAll)])
    }
  }
  // The desk's own actions (send the selection or link to a note, Attention,
  // save media to the desk, AI Assist…) live in the work widget menu.
  if (ctx.surface === 'desk') groups.push([item('more-desk', 'More work widget actions…')])
  if (ctx.dev) groups.push([item('inspect', 'Inspect element')])

  const out: WebMenuEntry[] = []
  for (const g of groups) {
    if (g.length === 0) continue
    if (out.length) out.push({ type: 'separator' })
    out.push(...g)
  }
  return out
}

// ── Electron side ───────────────────────────────────────────────────────────

/** webContents id → surface, as the renderer registers its webviews (desk widgets, panels). */
const surfaces = new Map<number, WebSurface>()
const attached = new WeakSet<WebContents>()

/** Test hook (e2e, NODE_ENV=test only): the last menu built, instead of popping it up. */
export let lastWebMenu: { surface: WebSurface; webContentsId: number; entries: WebMenuEntry[] } | null = null
const testHook = (): boolean => process.env.NODE_ENV === 'test' && process.env.PLEXI_WEB_MENU_HOOK === '1'

export function registerWebMenuIpc(): void {
  ipcMain.handle('webMenu:setSurface', (_e, webContentsId: number, surface: WebSurface | null) => {
    if (typeof webContentsId !== 'number') return { ok: false }
    if (surface === null) surfaces.delete(webContentsId)
    else if (['desk', 'browser', 'connected-app', 'popup'].includes(surface)) surfaces.set(webContentsId, surface)
    return { ok: true }
  })
}

function hostWindow(contents: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? BrowserWindow.getAllWindows()[0] ?? null
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
      dev: !app.isPackaged && process.env.NODE_ENV !== 'test'
    })
    if (testHook()) {
      lastWebMenu = { surface, webContentsId: contents.id, entries }
      // Readable from Playwright's electronApp.evaluate (main process globals).
      ;(globalThis as unknown as { __plexiiLastWebMenu?: unknown }).__plexiiLastWebMenu = lastWebMenu
      return
    }
    const menu = new Menu()
    for (const e of entries) {
      if ('type' in e) menu.append(new MenuItem({ type: 'separator' }))
      else menu.append(new MenuItem({ label: e.label, enabled: e.enabled, click: () => run(contents, e.id, params) }))
    }
    const win = hostWindow(contents)
    menu.popup(win ? { window: win } : {})
  })
}

function run(contents: WebContents, id: WebMenuAction, p: ContextMenuParams): void {
  if (id.startsWith('spelling:')) {
    contents.replaceMisspelling(id.slice('spelling:'.length))
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
