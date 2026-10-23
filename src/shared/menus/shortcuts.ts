// One shortcut-hint format for every menu (SPEC §9.4). Plain data, no DOM:
// main's native menus and the renderer's menus both call it.
//
// macOS: Apple's modifier order ⌃⌥⇧⌘ as glyphs, then the key ("⇧⌘Z", never
// "⌘⇧Z"). Elsewhere: "Ctrl+Shift+Z". `mod` is ⌘ on macOS and Ctrl elsewhere.
// Show a hint only for a key that is actually bound.

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'mod'
export type ShortcutKeys = readonly [...Modifier[], string]

const MAC_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'mod']
const MAC_GLYPH: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
const OTHER_ORDER: Modifier[] = ['mod', 'ctrl', 'alt', 'shift']
const OTHER_NAME: Record<Modifier, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const KEY_GLYPH: Record<string, [mac: string, other: string]> = {
  backspace: ['⌫', 'Backspace'],
  delete: ['⌦', 'Del'],
  enter: ['↩', 'Enter'],
  escape: ['⎋', 'Esc'],
  tab: ['⇥', 'Tab'],
  left: ['←', 'Left'],
  right: ['→', 'Right'],
  up: ['↑', 'Up'],
  down: ['↓', 'Down'],
  space: ['Space', 'Space'],
  plus: ['+', '+'],
  minus: ['−', '-']
}

/** The hint for a key combination on this platform, e.g. ['shift','mod','z'] → "⇧⌘Z" / "Ctrl+Shift+Z". */
export function shortcutLabel(keys: ShortcutKeys, platform: string): string {
  const mac = platform === 'darwin' || platform === 'mac'
  const mods = keys.slice(0, -1) as Modifier[]
  const raw = keys[keys.length - 1] as string
  const known = KEY_GLYPH[raw.toLowerCase()]
  const key = known ? known[mac ? 0 : 1] : raw.length === 1 ? raw.toUpperCase() : raw
  if (mac) return MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_GLYPH[m]).join('') + key
  // Ctrl appears once even if both mod and ctrl were named.
  const names = [...new Set(OTHER_ORDER.filter((m) => mods.includes(m)).map((m) => OTHER_NAME[m]))]
  return [...names, key].join('+')
}
