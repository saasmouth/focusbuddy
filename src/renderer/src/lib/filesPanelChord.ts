// ⌥⌘F (Ctrl+Alt+F on Windows and Linux): open or close Files beside your work.
//
// Matched on `code`, not `key`: with Option held, macOS turns F into "ƒ", so a
// `key === 'f'` test never fires on a Mac. Shift is excluded because Draw binds
// ⌥⇧⌘F. AltGr is excluded because on several European Windows layouts
// Ctrl+Alt IS AltGr, and AltGr+F types a character there; stealing it would
// stop someone typing.

export interface ChordKey {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  getModifierState?: (k: string) => boolean
}

export function isFilesPanelChord(e: ChordKey): boolean {
  if (e.code !== 'KeyF') return false
  if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return false
  if (e.repeat) return false
  try {
    if (e.getModifierState?.('AltGraph')) return false
  } catch {
    /* hosts without modifier state: no AltGr */
  }
  return true
}

/** The chord as people read it on this platform. */
export function filesPanelChordLabel(platform: string | undefined): string {
  return platform === 'darwin' ? '⌥⌘F' : 'Ctrl+Alt+F'
}
