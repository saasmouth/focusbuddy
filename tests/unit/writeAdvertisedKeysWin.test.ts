// @vitest-environment node
// GUARD: no TipTap extension may claim a key PlexiiWrite advertises elsewhere.
//
// The one that did: @tiptap/extension-highlight binds Mod-Shift-h to
// toggleHighlight, and PlexiiWrite's Edit menu advertises ⇧⌘H for Find and
// replace (lexicon E-14). Highlight shows that key nowhere — it is a toolbar
// button — so an unadvertised default was shadowing an advertised binding.
//
// It used to be hidden by accident. DocEditor's editorProps.handleKeyDown
// intercepted ⇧⌘H by hand, and prosemirror-view's `someProp` checks `_props`
// BEFORE the plugin keymaps (confirmed in the installed version), so the
// hand-written branch ran first and Highlight never saw the key. When keys
// moved onto the command registry and Find / Find and replace / Print /
// Keyboard shortcuts became keyOwner 'menubar' — correctly, so one press cannot
// fire twice — that accidental shield went away: the matcher now skips ⇧⌘H, the
// handler returns false, Highlight's keymap runs, calls preventDefault, and
// MenuBarShell's listener (which bails on defaultPrevented) never opens Find
// and replace. Pressing ⇧⌘H highlighted the selection instead.
//
// So the fix belongs in the extension, not in another hand-written branch: the
// key is advertised for Find and replace, and nothing else may take it.

import { describe, expect, it } from 'vitest'
import { buildDocExtensions } from '../../src/renderer/src/components/documents/editor/extensions'
import { MENU } from '../../src/shared/menus/lexicon'
import { shortcutLabel } from '../../src/shared/menus/shortcuts'

/** ProseMirror key names for the combinations PlexiiWrite advertises in a menu. */
const ADVERTISED: Record<string, string> = {
  'Mod-Shift-h': 'findAndReplace',
  'Mod-f': 'find',
  'Mod-p': 'print',
  'Mod-/': 'keyboardShortcuts'
}

type Ext = {
  name?: string
  config?: { addKeyboardShortcuts?: () => Record<string, unknown> }
  parent?: Ext
}

/**
 * The keys an extension EFFECTIVELY declares, resolved the way TipTap resolves
 * them. getExtensionField falls through to `parent` only while the child leaves
 * the field undefined, so an `extend({ addKeyboardShortcuts })` that does not
 * call `this.parent?.()` REPLACES the parent's keys rather than adding to them.
 * Walking the whole chain would therefore report keys the editor never binds —
 * and would make this guard impossible to satisfy by the only correct fix.
 *
 * The handlers are never invoked, only their keys read, so a stub `this` is
 * enough.
 */
function keysOf(ext: Ext): string[] {
  let e: Ext | undefined = ext
  while (e && e.config?.addKeyboardShortcuts === undefined && e.parent) e = e.parent
  const fn = e?.config?.addKeyboardShortcuts
  if (typeof fn !== 'function') return []
  try {
    const stub = { editor: { commands: new Proxy({}, { get: () => () => true }) }, options: {}, name: e?.name, parent: () => ({}) }
    return Object.keys(fn.call(stub as never) ?? {})
  } catch {
    // Unreadable without a live editor: reported rather than silently treated
    // as declaring nothing, so this guard cannot pass by failing to look.
    return ['(unreadable)']
  }
}

describe('PlexiiWrite’s extensions', () => {
  const exts = buildDocExtensions() as unknown as Ext[]

  it('builds a real extension list to check', () => {
    expect(exts.length, 'the extensions really built').toBeGreaterThan(20)
    // Non-vacuous: at least one extension does declare keys, so an empty result
    // below would mean something, rather than the reader having failed.
    const all = exts.flatMap(keysOf)
    expect(all.length, 'some extension declares a shortcut').toBeGreaterThan(5)
  })

  it.each(Object.entries(ADVERTISED))('leaves %s to the menu action it is advertised for (%s)', (key, action) => {
    const claimants = exts.filter((e) => keysOf(e).includes(key)).map((e) => e.name ?? '(unnamed)')
    const hint = shortcutLabel((MENU[action as keyof typeof MENU] as { keys: never }).keys, 'darwin')
    expect(
      claimants,
      `${hint} is advertised for "${(MENU[action as keyof typeof MENU] as { label: string }).label}"; ` +
        `these extensions also bind it and would win, because prosemirror checks plugin keymaps ` +
        `after editorProps and the registry now leaves this key to the menu bar`
    ).toEqual([])
  })

  it('still has Highlight, as a toolbar action without a key', () => {
    // The fix removes Highlight's shortcut, not Highlight: the mark and its
    // button stay, and doc-highlight has no `keys`, so no hint is shown for it.
    const hl = exts.find((e) => e.name === 'highlight')
    expect(hl, 'Highlight is still installed').toBeTruthy()
    expect(keysOf(hl as Ext), 'and declares no key of its own').toEqual([])
  })
})
