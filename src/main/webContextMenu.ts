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
import { AI_LANGUAGES, AI_MENU_LABELS, AI_TEXT_ACTIONS, AI_TONES } from '@shared/aiTextActions'
import { MENU } from '@shared/menus/lexicon'
import type { ShortcutKeys } from '@shared/menus/shortcuts'
import { editableFieldItems, type EditableFieldItemId } from '@shared/menus/editableField'
import type { DeskTarget, WebMenuCommand } from '@shared/webMenu'
import { DEFAULT_TEXT_MENU_CAPS, TEXT_MENU_CHANNEL, TEXT_MENU_QUERY, type TextMenuCaps, type TextMenuCommand, type TextMenuQueryResult } from '@shared/textMenu'

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

/** The click on text, for the text-field menu (a web page's field, or any field in the app window). */
export type TextMenuParams = Pick<WebMenuParams, 'selectionText' | 'isEditable' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions'>

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
  | 'paste-plain'
  | 'select-all'
  | 'add-to-dictionary'
  | 'copy-video-address'
  | 'more-desk'
  | 'inspect'
  | 'ask-assist'
  | 'save-snippet'
  | `spelling:${string}`
  /** desk:<target>:<desk id | new | choose> */
  | `desk:${DeskTarget}:${string}`
  /** ai:<command> — an action id, tone:<Tone>, translate:<Language>, custom-tone, custom-language, custom */
  | `ai:${string}`

export type WebMenuEntry =
  | { type: 'separator' }
  | {
      id: WebMenuAction
      label: string
      enabled: boolean
      /** The key hint, as an Electron accelerator; shown only for a key that is bound (SPEC §9.4), never registered by the menu. */
      accelerator?: string
      /** Why the item is off (SPEC §9.5), shown as the item's tooltip. */
      hint?: string
    }
  | { label: string; submenu: WebMenuEntry[] }

/**
 * A shared key combination as an Electron accelerator, so a native menu shows
 * the same hint the renderer's menus draw with shortcutLabel(): mod is ⌘ on
 * macOS and Ctrl elsewhere, exactly as in shortcuts.ts. Pure; exported for tests.
 */
export function acceleratorFor(keys: ShortcutKeys): string {
  const names: Record<string, string> = { mod: 'CommandOrControl', ctrl: 'Control', alt: 'Alt', shift: 'Shift' }
  const keyNames: Record<string, string> = { backspace: 'Backspace', delete: 'Delete', enter: 'Enter', escape: 'Escape', tab: 'Tab', left: 'Left', right: 'Right', up: 'Up', down: 'Down', space: 'Space', plus: 'Plus', minus: '-' }
  const mods = keys.slice(0, -1).map((m) => names[m as string] ?? m)
  const raw = keys[keys.length - 1] as string
  const key = keyNames[raw.toLowerCase()] ?? (raw.length === 1 ? raw.toUpperCase() : raw)
  return [...mods, key].join('+')
}

/** A shared action's accelerator, or undefined when it has no bound key. */
const acceleratorOf = (id: keyof typeof MENU): string | undefined => {
  const keys = (MENU[id] as { keys?: ShortcutKeys }).keys
  return keys ? acceleratorFor(keys) : undefined
}

/**
 * Each text-field row and the Electron role that does it. The menu calls the
 * role's own webContents method (contents.cut(), .pasteAndMatchStyle(), …),
 * which is what the role runs, so the action is the OS's; the rows themselves
 * stay plain items so their enabled state follows the click's editFlags.
 */
export const TEXT_FIELD_ROLE: Partial<Record<EditableFieldItemId, 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll'>> = {
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  pasteAsPlainText: 'pasteAndMatchStyle',
  selectAll: 'selectAll'
}
const TEXT_FIELD_ACTION: Partial<Record<EditableFieldItemId, WebMenuAction>> = {
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  pasteAsPlainText: 'paste-plain',
  selectAll: 'select-all',
  askAssistAboutThis: 'ask-assist',
  saveAsSnippet: 'save-snippet'
}

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

/** AI Assist ▸: the one set of eight (AUDIT E-12), then tone and language, then a prompt of your own. */
function aiSubmenu(): WebMenuEntry {
  const item = (id: WebMenuAction, label: string): WebMenuEntry => ({ id, label, enabled: true })
  return {
    label: AI_MENU_LABELS.aiAssist,
    submenu: joinGroups([
      AI_TEXT_ACTIONS.map((a) => item(`ai:${a.id}`, a.label)),
      [
        { label: AI_MENU_LABELS.changeTone, submenu: [...AI_TONES.map((t) => item(`ai:tone:${t}`, t)), { type: 'separator' }, item('ai:custom-tone', AI_MENU_LABELS.customTone)] },
        {
          label: AI_MENU_LABELS.translate,
          submenu: [...AI_LANGUAGES.map((l) => item(`ai:translate:${l}`, l)), { type: 'separator' }, item('ai:custom-language', AI_MENU_LABELS.customLanguage)]
        }
      ],
      [item('ai:custom', AI_MENU_LABELS.customPrompt)]
    ])
  }
}

/** Spelling suggestions and Add to dictionary, when the click is on a misspelled word (Electron supplies both). */
function spellingGroup(p: TextMenuParams): WebMenuEntry[] {
  const out: WebMenuEntry[] = (p.dictionarySuggestions ?? []).slice(0, 5).map((s) => ({ id: `spelling:${s}` as WebMenuAction, label: s, enabled: true }))
  if (p.misspelledWord) out.push({ id: 'add-to-dictionary', label: 'Add to dictionary', enabled: true })
  return out
}

/**
 * The text shape (SPEC §9.3), from the same plain data the renderer's menus use
 * (shared/menus/editableField.ts), so a field in the app, a field on a web page
 * and a text menu drawn by the kit say exactly the same thing:
 *   Cut · Copy · Paste · Paste as plain text | Select all | Ask PlexiiAssist about this
 *   · Save selection as snippet…
 * as groups. Enabled states follow the click's editFlags. Each Plexii row is
 * offered only where it can run (`assist`, `snippet`); otherwise absent (SPEC §9.5).
 */
export function textFieldGroups(p: TextMenuParams, opts: { platform: string; assist: boolean; snippet?: boolean; selectAll?: boolean }): WebMenuEntry[][] {
  const selected = !!(p.selectionText && p.selectionText.trim())
  const rows = editableFieldItems({ hasSelection: selected, canPaste: p.editFlags.canPaste, isEditable: p.isEditable, plexii: opts.assist || !!opts.snippet }, opts.platform)
  const flags: Partial<Record<EditableFieldItemId, boolean>> = {
    cut: p.editFlags.canCut,
    copy: p.editFlags.canCopy,
    paste: p.editFlags.canPaste,
    pasteAsPlainText: p.editFlags.canPaste,
    selectAll: p.editFlags.canSelectAll
  }
  const groups: WebMenuEntry[][] = [[]]
  for (const r of rows) {
    const id = TEXT_FIELD_ACTION[r.id]
    if (!id) continue // no route for it here: absent, never dead
    if (r.id === 'selectAll' && opts.selectAll === false) continue
    if (r.id === 'askAssistAboutThis' && !opts.assist) continue
    if (r.id === 'saveAsSnippet' && !opts.snippet) continue
    if (r.separatorBefore && groups[groups.length - 1]!.length) groups.push([])
    const enabled = r.enabled && (flags[r.id] ?? true)
    groups[groups.length - 1]!.push({
      id,
      label: r.label,
      enabled,
      ...(r.shortcut ? { accelerator: acceleratorOf(r.id as keyof typeof MENU) } : {}),
      ...(enabled ? {} : { hint: r.hint ?? (r.id === 'selectAll' ? 'Nothing to select' : 'Not available here') })
    })
  }
  return groups
}

/** The menu for one right-click. Pure: the same params and context always give the same menu. */
export function buildWebMenu(p: WebMenuParams, ctx: WebMenuContext, platform: string = process.platform): WebMenuEntry[] {
  const item = (id: WebMenuAction, label: string, enabled = true): WebMenuEntry => ({ id, label, enabled })
  // Add to desk and the AI text actions belong to the browser surfaces only:
  // not to connected apps (a signed-in app is not a page you are reading) or
  // pop-ups (sign-in windows).
  const work = WORK_SURFACES.includes(ctx.surface)
  const desks = work ? ctx.desks : undefined
  const selected = !!(p.selectionText && p.selectionText.trim())
  const image = p.mediaType === 'image' && !!p.srcURL
  const video = p.mediaType === 'video'
  const link = web(p.linkURL)
  const background = !link && !image && !video && !selected

  // Groups in the order of SPEC §9.3: what was clicked | clipboard | select all |
  // view (page history) | Plexii | the desk's own actions | Inspect.
  const object: WebMenuEntry[] = []
  const clip: WebMenuEntry[] = []
  const view: WebMenuEntry[] = []
  const plexii: WebMenuEntry[] = []
  const groups: WebMenuEntry[][] = []

  if (p.isEditable) {
    groups.push(spellingGroup(p))
    groups.push(...textFieldGroups(p, { platform, assist: work }))
  } else {
    if (link) {
      object.push(
        ctx.surface === 'desk' ? item('open-link-widget', 'Open link as a new browser work widget') : item('open-link', 'Open link'),
        item('open-link-external', 'Open link in default browser')
      )
    }
    if (image) {
      const savable = web(p.srcURL) || p.srcURL.startsWith('data:') || p.srcURL.startsWith('blob:')
      object.push({ ...item('save-image', 'Save image as…', savable), ...(savable ? {} : { hint: 'This image cannot be downloaded' }) })
    }
    // Selected text gets the text shape (Copy | Select all | Ask PlexiiAssist
    // about this); its clipboard row leads the clipboard group.
    const text = selected ? textFieldGroups(p, { platform, assist: work }) : []
    const isAsk = (g: WebMenuEntry[]): boolean => g.some((e) => 'id' in e && e.id === 'ask-assist')
    if (text[0]) clip.push(...text[0])
    if (link) clip.push(item('copy-link', MENU.copyLink.label))
    if (image) {
      clip.push(item('copy-image', 'Copy image'))
      const data = p.srcURL.startsWith('data:')
      clip.push({ ...item('copy-image-address', 'Copy image address', !data), ...(data ? { hint: 'This image has no address of its own' } : {}) })
    }
    // A streamed video (blob:) has no address worth copying; Add to desk
    // then places the page it plays on.
    if (video && web(p.srcURL)) clip.push(item('copy-video-address', 'Copy video address'))
    groups.push(object, clip)
    if (selected) groups.push(...text.slice(1).filter((g) => !isAsk(g)))
    if (background) {
      groups.push([{ ...item('select-all', MENU.selectAll.label, p.editFlags.canSelectAll), accelerator: acceleratorOf('selectAll') }])
      view.push(item('back', 'Back', ctx.canGoBack), item('forward', 'Forward', ctx.canGoForward), item('reload', 'Reload'))
      // History items say why when they cannot go anywhere (SPEC §9.5).
      for (const v of view) if ('id' in v && !v.enabled) v.hint = v.id === 'back' ? 'Nothing to go back to' : 'Nothing to go forward to'
      groups.push(view)
    }
    // Plexii: Ask PlexiiAssist about this and AI Assist on selected text,
    // then "Add … to desk", one per thing clicked.
    if (selected && work) plexii.push(...text.filter(isAsk).flat(), aiSubmenu())
    if (desks) {
      if (selected) plexii.push(deskSubmenu('selection', desks))
      if (link) plexii.push(deskSubmenu('link', desks))
      if (image) plexii.push(deskSubmenu('image', desks))
      if (video) plexii.push(deskSubmenu('video', desks))
      if (background) plexii.push(deskSubmenu('page', desks))
    }
    groups.push(plexii)
  }
  // The desk's own actions (send the selection or link to a note, Attention,
  // save media to the desk…) live in the work widget menu.
  if (ctx.surface === 'desk') groups.push([item('more-desk', 'More work widget actions…')])
  if (ctx.dev) groups.push([item('inspect', 'Inspect element')])

  return joinGroups(groups)
}

/**
 * The right-click menu on TEXT in the app window itself (AUDIT M-q, F-1): a
 * composer, a rename field, a search box, read-only text with a selection.
 * Before this the app window showed nothing at all on text. Spelling first when
 * the word is misspelled, then the text shape (SPEC §9.3). Anything else (a
 * click on chrome with no selection) gets no menu: [] means none pops up.
 *
 * Read-only text drops Select all: in the app window it would select the whole
 * app shell, which is not a text action (absent, SPEC §9.5).
 */
export function buildAppTextMenu(p: TextMenuParams, opts: { platform: string; caps: TextMenuCaps }): WebMenuEntry[] {
  const selected = !!(p.selectionText && p.selectionText.trim())
  if (!p.isEditable && !selected) return []
  return joinGroups([
    spellingGroup(p),
    ...textFieldGroups(p, { platform: opts.platform, assist: opts.caps.askAssist, snippet: opts.caps.saveSnippet, selectAll: p.isEditable })
  ])
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

function toMenu(entries: WebMenuEntry[], click: (id: WebMenuAction) => void): Menu {
  const menu = new Menu()
  for (const e of entries) {
    if ('type' in e) menu.append(new MenuItem({ type: 'separator' }))
    else if ('submenu' in e) menu.append(new MenuItem({ label: e.label, submenu: toMenu(e.submenu, click) }))
    else
      menu.append(
        new MenuItem({
          label: e.label,
          enabled: e.enabled,
          // A hint only: the key is bound where it works (the Edit menu, the
          // page), so the context menu must not register it a second time.
          ...(e.accelerator ? { accelerator: e.accelerator, registerAccelerator: false } : {}),
          ...(e.hint ? { toolTip: e.hint } : {}),
          click: () => click(e.id)
        })
      )
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
    toMenu(entries, (id) => run(contents, id, params)).popup(win ? { window: win } : {})
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
    case 'paste-plain':
      contents.pasteAndMatchStyle()
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

// ── The app window's own text menu (AUDIT M-q) ───────────────────────────────

/**
 * Test hook (NODE_ENV=test + PLEXI_WEB_MENU_HOOK=1): every 'context-menu' event
 * the app window received, and the last text menu built. Electron does not
 * emit the event at all when the page called preventDefault (a menu the
 * renderer draws with the kit), so the count is how an e2e proves the two
 * never both open.
 */
export let lastAppTextMenu: { entries: WebMenuEntry[]; flat: ReturnType<typeof flattenWebMenu>; isEditable: boolean; hasSelection: boolean; caps: TextMenuCaps } | null = null
let appMenuEvents = 0

/**
 * Ask the page (renderer lib/textMenuHandlers.ts) which Plexii rows the focused
 * surface offers, and whether the text was selected before this right-click.
 * Only asked when text is selected (both rows need a selection). A page that
 * does not answer in time gets the defaults: the generic ask route.
 */
async function queryPage(params: ContextMenuParams, contents: WebContents): Promise<TextMenuQueryResult> {
  const none = { askAssist: false, saveSnippet: false, selectedBefore: false }
  if (!(params.selectionText && params.selectionText.trim())) return none
  const fallback = { ...DEFAULT_TEXT_MENU_CAPS, selectedBefore: true }
  try {
    const q = `(typeof window.${TEXT_MENU_QUERY} === 'function' ? window.${TEXT_MENU_QUERY}() : null)`
    const r = (await Promise.race([contents.mainFrame.executeJavaScript(q), new Promise((res) => setTimeout(() => res(null), 250))])) as Partial<TextMenuQueryResult> | null
    if (!r || typeof r !== 'object') return fallback
    return { askAssist: r.askAssist === true, saveSnippet: r.saveSnippet === true, selectedBefore: r.selectedBefore !== false }
  } catch {
    return fallback
  }
}

function runApp(contents: WebContents, id: WebMenuAction, p: ContextMenuParams): void {
  if (id === 'ask-assist' || id === 'save-snippet') {
    // The renderer decides who does it: the surface that registered for the
    // focused element, else the generic flow (shared/textMenu.ts).
    const cmd: TextMenuCommand = {
      action: id === 'ask-assist' ? 'askAssist' : 'saveSnippet',
      selectionText: p.selectionText ?? '',
      isEditable: p.isEditable,
      ...(p.frame && p.frame !== contents.mainFrame ? { frameId: p.frame.routingId } : {})
    }
    contents.send(TEXT_MENU_CHANNEL, cmd)
    return
  }
  run(contents, id, p)
}

/**
 * Give the app window the text menu. Electron emits 'context-menu' only when
 * the page did not preventDefault, so every menu the renderer draws (the kit)
 * keeps sole ownership of its right-click; this fills the rest: text fields,
 * editors' text (Write's page, a cell or text box being edited) and selected
 * text. Web content (webviews, pop-ups) is separate webContents with its own
 * menu (attachWebContextMenu).
 */
export function attachAppTextMenu(contents: WebContents): void {
  if (attached.has(contents)) return
  attached.add(contents)
  contents.on('context-menu', (_event, params) => {
    appMenuEvents++
    void (async () => {
      const page = await queryPage(params, contents)
      if (contents.isDestroyed()) return
      const caps: TextMenuCaps = { askAssist: page.askAssist, saveSnippet: page.saveSnippet }
      // Read-only text: only a selection the person made. The word macOS
      // selects under a right-click on a label is not one (no menu on chrome).
      const entries = !params.isEditable && !page.selectedBefore ? [] : buildAppTextMenu(params, { platform: process.platform, caps })
      if (testHook()) {
        lastAppTextMenu = { entries, flat: flattenWebMenu(entries), isEditable: params.isEditable, hasSelection: !!params.selectionText?.trim(), caps }
        const g = globalThis as unknown as { __plexiiAppTextMenu?: unknown; __plexiiRunAppTextMenuItem?: (id: string) => boolean }
        g.__plexiiAppTextMenu = { ...lastAppTextMenu, events: appMenuEvents }
        g.__plexiiRunAppTextMenuItem = (id: string): boolean => {
          if (!lastAppTextMenu?.flat.some((e) => e.id === id && e.enabled) || contents.isDestroyed()) return false
          runApp(contents, id as WebMenuAction, params)
          return true
        }
        return
      }
      if (entries.length === 0) return
      const win = BrowserWindow.fromWebContents(contents)
      toMenu(entries, (id) => runApp(contents, id, params)).popup(win ? { window: win } : {})
    })()
  })
  if (testHook()) {
    const g = globalThis as unknown as { __plexiiAppMenuEvents?: () => number }
    g.__plexiiAppMenuEvents = () => appMenuEvents
  }
}
