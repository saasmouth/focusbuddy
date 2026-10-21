// Which key a shortcut means.
//
// Normally e.key, which follows the user's keyboard layout (⌘A on AZERTY is the
// key labelled A, not the US position). But with Option/Alt held, macOS reports
// the COMPOSED character, so ⌥⌘C arrives as 'ç' and ⌥⌘V as '√', and a check for
// 'c' never matches. With Alt held, the physical key code is the only reliable
// signal, so letters fall back to it there and only there.
export function shortcutKey(e: Pick<KeyboardEvent, 'key' | 'code' | 'altKey'>): string {
  if (e.altKey && /^Key[A-Z]$/.test(e.code)) return e.code.slice(3).toLowerCase()
  return e.key.toLowerCase()
}
