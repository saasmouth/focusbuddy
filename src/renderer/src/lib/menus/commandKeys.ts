import { actionKeys } from '@shared/menus/lexicon'
import type { Modifier, ShortcutKeys } from '@shared/menus/shortcuts'
import { menuPlatform } from './menuAction'
import type { OfficeCommand } from './officeCommand'

// Keys driven BY the command registry, so a key an app advertises is a key the
// app really binds.
//
// Every office menu shows its hint from the command's `keys`. Until this
// existed the BINDING was written separately, by hand, in the app's keydown
// handler — and PlexiiCells proved what that costs: Format ▸ Text offered
// Bold ⌘B, Italic ⌘I and Underline ⌘U, and Clear formatting offered ⌘\, and
// the grid bound none of the four. The menu said the key worked; pressing it
// did nothing at all.
//
// Matching the event against the same `keys` the hint is formatted from means
// the two cannot disagree: a command with a key is reachable by that key, and
// a command with no key shows no hint.
//
// A disabled command is not run — so a viewer pressing ⌘B changes nothing,
// without every app having to remember to check.

/** Modifiers exactly as the event has them, so ⌘B does not fire on ⇧⌘B. */
function modifiersMatch(keys: ShortcutKeys, e: KeyLikeEvent, mac: boolean): boolean {
  const want = new Set(keys.slice(0, -1) as Modifier[])
  // `mod` is ⌘ on macOS and Ctrl elsewhere. A combination naming both `mod`
  // and `ctrl` off macOS wants the one Ctrl key, which is why this is a set.
  const wantMeta = mac && want.has('mod')
  const wantCtrl = want.has('ctrl') || (!mac && want.has('mod'))
  return (
    !!e.metaKey === wantMeta &&
    !!e.ctrlKey === wantCtrl &&
    !!e.altKey === want.has('alt') &&
    !!e.shiftKey === want.has('shift')
  )
}

/** The named keys whose `event.key` is not simply the token. */
const EVENT_KEY: Record<string, string> = {
  backspace: 'backspace',
  delete: 'delete',
  enter: 'enter',
  escape: 'escape',
  tab: 'tab',
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
  space: ' ',
  plus: '+',
  minus: '-'
}

/** Only what a match needs, so a test does not have to build a real event. */
export interface KeyLikeEvent {
  key: string
  /** The physical key. Brackets and digits are read by it: Shift turns ] into } and 1 into ! (so ⇧⌘] and ⇧1 would never match by `key`). */
  code?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

const BY_CODE: Record<string, string> = { ']': 'BracketRight', '[': 'BracketLeft', '/': 'Slash', '\\': 'Backslash' }

function keyMatches(keys: ShortcutKeys, e: KeyLikeEvent): boolean {
  const raw = String(keys[keys.length - 1]).toLowerCase()
  if ((EVENT_KEY[raw] ?? raw) === e.key.toLowerCase()) return true
  if (!e.code) return false
  if (BY_CODE[raw] === e.code) return true
  return /^[0-9]$/.test(raw) && e.code === `Digit${raw}`
}

/**
 * The command this event is the key for, or null. A command that is off is
 * never returned: a viewer's ⌘B has no binding to find, which is the same
 * answer its greyed menu row gives.
 */
export function matchCommand(
  commands: OfficeCommand[],
  e: KeyLikeEvent,
  platform: string = menuPlatform()
): OfficeCommand | null {
  const mac = platform === 'darwin' || platform === 'mac'
  for (const c of commands) {
    // Bound elsewhere (the menu bar, the platform's clipboard events): never twice.
    if (c.keyOwner) continue
    const keys = actionKeys({ label: c.label, keys: c.keys, otherKeys: c.otherKeys }, platform)
    if (!keys) continue
    if (!keyMatches(keys, e)) continue
    if (!modifiersMatch(keys, e, mac)) continue
    if (c.enabled && !c.enabled()) return null
    return c
  }
  return null
}

/**
 * Run the command this event is the key for. Returns true when one was run, so
 * the caller can `preventDefault()` and stop — and false when nothing matched,
 * so the event goes on to whatever else wants it.
 */
export function runCommandKey(
  commands: OfficeCommand[],
  e: KeyLikeEvent,
  platform: string = menuPlatform()
): boolean {
  const c = matchCommand(commands, e, platform)
  if (!c) return false
  c.run()
  return true
}
