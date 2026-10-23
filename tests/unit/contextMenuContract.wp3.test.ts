// @vitest-environment node
// WP3's right-click surfaces held to the menu contract (SPEC §9.3–§9.5):
// Files (entry and empty area, flyout and full view), PlexiiAssist messages,
// the native menu on web content, and the app window's own text menu (M-q).
//
// Each menu is built by the code the app calls: lib/fileEntryMenu.ts (both
// Files surfaces call it), lib/chatMessageMenu.ts (ChatPanel), and the pure
// builders in main/webContextMenu.ts. Native templates are converted to the
// helper's shape (label, accelerator → hint through shortcutLabel, separators)
// so they meet exactly the same assertions as the kit's menus.
import { describe, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: {}, Menu: class {}, MenuItem: class {}, clipboard: {}, shell: {}, app: {}, ipcMain: { handle: () => undefined } }))
import type { FileEntry } from '../../src/shared/fields'
import type { CtxMenuItem } from '../../src/renderer/src/components/CanvasContextMenu'
import { shortcutLabel, type ShortcutKeys } from '../../src/shared/menus/shortcuts'
import { editableFieldItems } from '../../src/shared/menus/editableField'
import { expectMenuContract, groupsOf } from './_menuContract'
import { fileEntryMenu, filesAreaMenu, type FileEntryMenuActions, type FilesSurface } from '../../src/renderer/src/lib/fileEntryMenu'
import { chatMessageMenu, type ChatMessageMenuInput } from '../../src/renderer/src/lib/chatMessageMenu'
import { buildAppTextMenu, buildWebMenu, acceleratorFor, type WebMenuEntry, type WebMenuParams, type WebMenuContext, type TextMenuParams } from '../../src/main/webContextMenu'
import { AI_TEXT_ACTIONS } from '../../src/shared/aiTextActions'

const PLATFORM = 'darwin'
const noop = (): void => undefined

// ── Native template → the helper's shape ────────────────────────────────────

/** "Alt+Shift+CommandOrControl+V" → ['alt','shift','mod','v'], the inverse of acceleratorFor. */
function keysOf(acc: string): ShortcutKeys {
  const map: Record<string, string> = { CommandOrControl: 'mod', Control: 'ctrl', Alt: 'alt', Shift: 'shift' }
  const parts = acc.split('+')
  return [...parts.slice(0, -1).map((p) => map[p] ?? p), parts[parts.length - 1]!.toLowerCase()] as unknown as ShortcutKeys
}

function fromNative(entries: WebMenuEntry[]): CtxMenuItem[] {
  return entries.map((e) => {
    if ('type' in e) return { separator: true }
    if ('submenu' in e) return { label: e.label, children: fromNative(e.submenu) }
    return {
      label: e.label,
      disabled: !e.enabled,
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.accelerator ? { shortcut: shortcutLabel(keysOf(e.accelerator), PLATFORM) } : {})
    }
  })
}

// Names the helper's PROPER list does not know yet (reported to 2e): "AI
// Assist" is the feature's name (Assist as in PlexiiAssist), Files is a named
// place in the app (like Trash and Focus), Finder is macOS's.
const ALLOW = { allowCase: ['AI Assist', 'Show in full Files', 'Reveal in Finder'] }

// ── Files ───────────────────────────────────────────────────────────────────

const entry = (kind: FileEntry['kind'], extra: Partial<FileEntry> = {}): FileEntry =>
  ({ id: `${kind}-1`, parentId: null, kind, name: `A ${kind}`, createdAt: 1, updatedAt: 1, ...extra }) as FileEntry
const FILE = entry('file', { sizeBytes: 10 })
const FOLDER = entry('folder', { childCount: 2 })
const DOC = entry('doc', { docId: 'doc-1' })
const WIDGET_FILE = entry('doc', { docId: 'wf-1', docType: 'widget', name: 'Plan', widgetKind: 'table' } as Partial<FileEntry>)

const act: FileEntryMenuActions = {
  open: noop, rename: noop, addToDesk: noop, showInFiles: noop, exportWidgetFile: noop, reveal: noop,
  collaborateLive: noop, share: noop, shareWithTeam: noop, moveToTrash: noop, removeFromFolder: noop
}
const caps = { signedIn: true, canShareWithTeam: true, platform: PLATFORM }
const menuFor = (e: FileEntry, surface: FilesSurface, deskCount?: number): CtxMenuItem[] =>
  fileEntryMenu(e, surface, { ...caps, addToDeskCount: deskCount }, act)

describe('Files entry menu (one builder, full view and flyout)', () => {
  it('a file: object | share | Move to Trash (danger, last, behind a separator)', () => {
    const view = menuFor(FILE, 'view')
    expectMenuContract(view, { ...ALLOW, groups: [['Open', 'Rename', 'Reveal in Finder'], ['Share…', 'Share with team or group…'], ['Move to Trash']] })
    expect(view.at(-1)).toMatchObject({ label: 'Move to Trash', danger: true })
    // The flyout adds only what belongs to it: Add to this desk (a desk is open) and the way to the full view.
    const flyout = menuFor(FILE, 'flyout', 1)
    expectMenuContract(flyout, {
      ...ALLOW,
      groups: [['Open', 'Add to this desk', 'Show in full Files', 'Rename', 'Reveal in Finder'], ['Share…', 'Share with team or group…'], ['Move to Trash']]
    })
    expect(groupsOf(menuFor(FILE, 'flyout', 3))[0]).toContain('Add 3 items to this desk')
  })

  it('a folder: Collaborate live (off with a reason when signed out), and its soft delete is Move to Trash too', () => {
    expectMenuContract(menuFor(FOLDER, 'view'), {
      groups: [['Open', 'Rename', 'Collaborate live'], ['Share…', 'Share with team or group…'], ['Move to Trash']]
    })
    const signedOut = fileEntryMenu(FOLDER, 'view', { ...caps, signedIn: false }, act)
    expectMenuContract(signedOut)
    expect(signedOut.find((i) => i.label === 'Collaborate live')).toMatchObject({ disabled: true, hint: 'Sign in to collaborate live' })
    // Reveal names the platform's own file manager.
    expect(groupsOf(fileEntryMenu(FILE, 'view', { ...caps, platform: 'win32' }, act))[0]).toContain('Show in File Explorer')
    expectMenuContract(fileEntryMenu(FILE, 'view', { ...caps, platform: 'linux' }, act))
  })

  it('a filed document: Remove from folder (a placement; the document is untouched); a work widget file: Export… and Move to Trash', () => {
    expectMenuContract(menuFor(DOC, 'view'), { groups: [['Open', 'Rename'], ['Share…'], ['Remove from this folder']] })
    expectMenuContract(menuFor(WIDGET_FILE, 'view'), { groups: [['Open', 'Rename', 'Export…'], ['Move to Trash']] })
  })

  it('the flyout and the full view say the same thing for the same entry (F-14)', () => {
    const flyoutOnly = new Set(['Show in full Files'])
    for (const e of [FILE, FOLDER, DOC, WIDGET_FILE]) {
      const view = groupsOf(menuFor(e, 'view'))
      const flyout = groupsOf(menuFor(e, 'flyout')).map((g) => g.filter((l) => !flyoutOnly.has(l)))
      expect(flyout, e.kind).toEqual(view)
      expectMenuContract(menuFor(e, 'flyout'), ALLOW)
    }
  })

  it('the empty area: create here | Select all (SPEC §9.3 empty shape; Files has no clipboard of its own)', () => {
    const view = filesAreaMenu({ newFolder: noop, addFiles: noop, importFolder: noop, addDocument: noop, selectAll: noop })
    expectMenuContract(view, { groups: [['New folder', 'Add files…', 'Import folder…', 'Add document…'], ['Select all']] })
    const flyout = filesAreaMenu({ newFolder: noop, addFiles: noop, importFolder: noop, selectAll: noop })
    expectMenuContract(flyout, { groups: [['New folder', 'Add files…', 'Import folder…'], ['Select all']] })
    // An empty folder has nothing to select: the row is absent.
    expectMenuContract(filesAreaMenu({ newFolder: noop, addFiles: noop }), { groups: [['New folder', 'Add files…']] })
  })
})

// ── PlexiiAssist messages ───────────────────────────────────────────────────

const chat = (over: Partial<ChatMessageMenuInput>): CtxMenuItem[] =>
  chatMessageMenu(
    { role: 'assistant', selection: '', content: 'The answer.', deskOpen: true, retry: 'ready', canInsertIntoDoc: false, platform: PLATFORM, ...over },
    { addToFocus: noop, saveSelection: noop, copy: noop, askAbout: noop, retry: noop, insertIntoDoc: noop }
  )

describe('PlexiiAssist message menu', () => {
  it('an assistant reply with nothing selected: Add to Focus… · Retry | Copy (no hint: ⌘C copies only a selection)', () => {
    const m = chat({})
    expectMenuContract(m, { groups: [['Add to Focus…', 'Retry'], ['Copy']] })
    expect(m.find((i) => i.label === 'Copy')?.shortcut).toBeUndefined()
    expectMenuContract(chat({ canInsertIntoDoc: true }), { groups: [['Add to Focus…', 'Retry', 'Insert into document'], ['Copy']] })
    // While an answer is coming, Retry is off and says why.
    expect(chat({ retry: 'busy' }).find((i) => i.label === 'Retry')).toMatchObject({ disabled: true, hint: 'Wait for the current answer to finish' })
    expectMenuContract(chat({ retry: 'busy' }))
  })

  it('your own message: Copy', () => {
    expectMenuContract(chat({ role: 'user', retry: null }), { groups: [['Copy']] })
  })

  it('a selection: Add to Focus… · Save as sticky · Save as note | Copy ⌘C | Ask PlexiiAssist about this', () => {
    for (const role of ['user', 'assistant'] as const) {
      const m = chat({ role, selection: 'part of it' })
      expectMenuContract(m, {
        groups: [['Add to Focus…', 'Save selection as sticky', 'Save selection as note'], ['Copy'], ['Ask PlexiiAssist about this']]
      })
      expect(m.find((i) => i.label === 'Copy')?.shortcut).toBe('⌘C')
    }
    // No desk: the desk rows are off, with the reason.
    const noDesk = chat({ selection: 'x', deskOpen: false })
    expectMenuContract(noDesk)
    expect(noDesk.filter((i) => i.disabled).map((i) => i.hint)).toEqual(['Open a desk first', 'Open a desk first'])
  })
})

// ── Native: the app window's text menu (M-q) and web content (M-p) ──────────

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false }
const text = (over: Partial<TextMenuParams>): TextMenuParams => ({ selectionText: '', isEditable: true, editFlags: flags, misspelledWord: '', dictionarySuggestions: [], ...over })
const TEXT_SHAPE = [['Cut', 'Copy', 'Paste', 'Paste as plain text'], ['Select all']]
// What the focused surface offers (renderer lib/textMenuHandlers.ts answers main's query).
const ASK = { askAssist: true, saveSnippet: false } // the default: the generic ask route, no generic snippet flow
const NONE = { askAssist: false, saveSnippet: false }
const BOTH = { askAssist: true, saveSnippet: true } // an editor that registered a snippet handler (d8's office surfaces)

describe('the app window text menu (native, M-q)', () => {
  it('a composer with a selection: the text shape, then Ask PlexiiAssist about this', () => {
    const m = fromNative(buildAppTextMenu(text({ selectionText: 'draft words' }), { platform: PLATFORM, caps: ASK }))
    expectMenuContract(m, { groups: [...TEXT_SHAPE, ['Ask PlexiiAssist about this']] })
    expect(m.slice(0, 4).map((i) => i.shortcut)).toEqual(['⌘X', '⌘C', '⌘V', '⌥⇧⌘V'])
  })

  it('a surface that registered a snippet handler: Ask PlexiiAssist about this · Save selection as snippet…', () => {
    expectMenuContract(fromNative(buildAppTextMenu(text({ selectionText: 'x' }), { platform: PLATFORM, caps: BOTH })), {
      groups: [...TEXT_SHAPE, ['Ask PlexiiAssist about this', 'Save selection as snippet…']]
    })
    // Neither row without a selection.
    expectMenuContract(fromNative(buildAppTextMenu(text({}), { platform: PLATFORM, caps: BOTH })), { groups: TEXT_SHAPE })
  })

  it('says exactly what the renderer text menu says (editableField.ts): same labels, order and hints', () => {
    const ctx = { hasSelection: true, canPaste: true, isEditable: true, plexii: true }
    const plain = editableFieldItems(ctx, PLATFORM)
    const native = fromNative(buildAppTextMenu(text({ selectionText: 'x' }), { platform: PLATFORM, caps: BOTH })).filter((i) => !i.separator)
    expect(native.map((i) => [i.label, i.shortcut ?? ''])).toEqual(plain.map((i) => [i.label, i.shortcut]))
  })

  it("the assistant's own composer leaves out Ask PlexiiAssist (it would quote the draft over itself)", () => {
    expectMenuContract(fromNative(buildAppTextMenu(text({ selectionText: 'x' }), { platform: PLATFORM, caps: NONE })), { groups: TEXT_SHAPE })
  })

  it('a rename field on a misspelled word: suggestions and Add to dictionary first; nothing selected keeps Cut and Copy off with a reason', () => {
    const m = fromNative(buildAppTextMenu(text({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'] }), { platform: PLATFORM, caps: ASK }))
    expectMenuContract(m, { groups: [['the', 'ten', 'Add to dictionary'], ...TEXT_SHAPE] })
    expect(m.filter((i) => i.disabled).map((i) => [i.label, i.hint])).toEqual([['Cut', 'Select some text first'], ['Copy', 'Select some text first']])
  })

  it('read-only text with a selection: Copy | Ask PlexiiAssist about this; a click on chrome: no menu at all', () => {
    const ro = fromNative(buildAppTextMenu(text({ isEditable: false, selectionText: 'a heading' }), { platform: PLATFORM, caps: ASK }))
    expectMenuContract(ro, { groups: [['Copy'], ['Ask PlexiiAssist about this']] })
    expect(buildAppTextMenu(text({ isEditable: false }), { platform: PLATFORM, caps: ASK })).toEqual([])
  })

  it('accelerators come from the shared keys (mod is ⌘ on macOS, Ctrl elsewhere)', () => {
    expect(acceleratorFor(['alt', 'shift', 'mod', 'v'])).toBe('Alt+Shift+CommandOrControl+V')
    expect(shortcutLabel(keysOf(acceleratorFor(['mod', 'a'])), 'win32')).toBe('Ctrl+A')
  })
})

const web: WebMenuParams = { x: 1, y: 2, linkURL: '', srcURL: '', mediaType: 'none', selectionText: '', isEditable: false, editFlags: flags, misspelledWord: '', dictionarySuggestions: [] }
const desks = { listed: [{ id: 'd1', title: 'Desk 1' }], more: false }
const wctx = (surface: WebMenuContext['surface']): WebMenuContext => ({ surface, canGoBack: true, canGoForward: false, dev: false, desks: surface === 'desk' || surface === 'browser' ? desks : undefined })
const native = (p: Partial<WebMenuParams>, surface: WebMenuContext['surface'] = 'browser'): CtxMenuItem[] => fromNative(buildWebMenu({ ...web, ...p }, wctx(surface), PLATFORM))

describe('the web content menu (native, M-p)', () => {
  it('a link: open | Copy link (E-10) | Add link to desk | the desk’s own actions', () => {
    expectMenuContract(native({ linkURL: 'https://e.x/a' }, 'desk'), {
      groups: [['Open link as a new browser work widget', 'Open link in default browser'], ['Copy link'], ['Add link to desk'], ['More work widget actions…']]
    })
  })

  it('an image', () => {
    expectMenuContract(native({ mediaType: 'image', srcURL: 'https://e.x/i.png' }), {
      groups: [['Save image as…'], ['Copy image', 'Copy image address'], ['Add image to desk']]
    })
    expectMenuContract(native({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' }, 'popup'))
  })

  it('a text selection: Copy ⌘C | Select all ⌘A | Ask PlexiiAssist about this · AI Assist ▸ (the one set of eight) · Add selection to desk', () => {
    const m = native({ selectionText: 'some words' })
    expectMenuContract(m, { ...ALLOW, groups: [['Copy'], ['Select all'], ['Ask PlexiiAssist about this', 'AI Assist', 'Add selection to desk']] })
    expect(m.map((i) => i.shortcut).filter(Boolean)).toEqual(['⌘C', '⌘A'])
    const ai = m.find((i) => i.label === 'AI Assist')!.children!
    expect(groupsOf(ai)).toEqual([AI_TEXT_ACTIONS.map((a) => a.label), ['Change tone', 'Translate'], ['Custom prompt…']])
    expect(groupsOf(ai)[0]).toHaveLength(8)
  })

  it('an editable field: spelling | the text shape | Ask PlexiiAssist about this (browser surfaces)', () => {
    expectMenuContract(native({ isEditable: true, selectionText: 'teh', misspelledWord: 'teh', dictionarySuggestions: ['the'] }), {
      groups: [['the', 'Add to dictionary'], ...TEXT_SHAPE, ['Ask PlexiiAssist about this']]
    })
    // A connected app or a pop-up keeps the text shape without the Plexii row.
    expectMenuContract(native({ isEditable: true, selectionText: 'x' }, 'connected-app'), { groups: TEXT_SHAPE })
  })

  it('the page itself: Select all | Back · Forward · Reload | Add page to desk', () => {
    expectMenuContract(native({}), { groups: [['Select all'], ['Back', 'Forward', 'Reload'], ['Add page to desk']] })
  })
})
