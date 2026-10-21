// The keyboard, end to end: turning a keyboard event into a keymap string on
// any layout, resolving it against the commands, the tools, the reserved
// Illustrator keys and the person's own remappings, and writing a key the way
// the platform writes it (⇧⌘Z on a Mac, Shift+Ctrl+Z on Windows).

import type { DrawTool } from '../editor/types'
import { drawTools } from '../tools/registry'
import { KEYMAP, RESERVED_KEYS } from './keymap'

// ── Platform ─────────────────────────────────────────────────────────────────

export type KeyPlatform = 'mac' | 'win'

function detectPlatform(): KeyPlatform {
  if (typeof navigator === 'undefined') return 'mac'
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || ''
  return /mac|iphone|ipad/i.test(p) ? 'mac' : 'win'
}

let platform: KeyPlatform = detectPlatform()

export function keyPlatform(): KeyPlatform {
  return platform
}

/** For tests, and for nothing else. */
export function setKeyPlatform(p: KeyPlatform): void {
  platform = p
}

// ── Event -> key string ──────────────────────────────────────────────────────

/** The unshifted US character on each punctuation key, by KeyboardEvent.code. */
const CODE_CHARS: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  IntlBackslash: '\\'
}

export interface KeyEventLike {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey?: boolean
  shiftKey: boolean
}

/**
 * The key itself, without modifiers: a letter from `key` when it is one (so
 * AZERTY's A is A), otherwise the physical key from `code` (Option+D on a Mac
 * types '∂', Shift+] types '}', Shift+1 on AZERTY types '1' -- each is still
 * the D, ] or 1 key), otherwise `key` lower-cased ('escape', 'arrowleft', 'f1').
 */
export function baseKey(e: { key: string; code?: string }): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase()
  const code = e.code ?? ''
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  if (CODE_CHARS[code]) return CODE_CHARS[code]
  if (e.key === ' ') return 'space'
  return e.key.toLowerCase()
}

/** `mod+alt+shift+<key>`, the form keymap.ts is written in. */
export function eventKeyString(
  e: KeyEventLike,
  opts: { shift?: boolean; alt?: boolean } = {}
): string {
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if ((opts.alt ?? true) && e.altKey) parts.push('alt')
  if ((opts.shift ?? true) && e.shiftKey) parts.push('shift')
  parts.push(baseKey(e))
  return parts.join('+')
}

/** Split a key string into its modifiers and key. */
export function parseKeyString(k: string): {
  mod: boolean
  alt: boolean
  shift: boolean
  key: string
} {
  // The key itself may be '+' (numpad plus), so split off known prefixes only.
  let rest = k
  const take = (m: string): boolean => {
    if (rest.startsWith(`${m}+`) && rest.length > m.length + 1) {
      rest = rest.slice(m.length + 1)
      return true
    }
    return false
  }
  const mod = take('mod')
  const alt = take('alt')
  const shift = take('shift')
  return { mod, alt, shift, key: rest }
}

// ── Key string -> label ──────────────────────────────────────────────────────

const MAC_NAMES: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
  backspace: '⌫',
  delete: '⌦',
  enter: '↩',
  escape: 'Esc',
  tab: '⇥',
  space: 'Space'
}
const WIN_NAMES: Record<string, string> = {
  arrowleft: 'Left',
  arrowright: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  backspace: 'Backspace',
  delete: 'Del',
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space'
}

/**
 * A key string written for people: ⌥⇧⌘K on a Mac (Apple's modifier order),
 * Alt+Shift+Ctrl+K on Windows (the order Adobe's Windows menus use).
 */
export function formatKey(k: string, p: KeyPlatform = platform): string {
  const { mod, alt, shift, key } = parseKeyString(k)
  const names = p === 'mac' ? MAC_NAMES : WIN_NAMES
  const keyLabel =
    names[key] ??
    (/^f\d+$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : key)
  if (p === 'mac') return `${alt ? '⌥' : ''}${shift ? '⇧' : ''}${mod ? '⌘' : ''}${keyLabel}`
  return [alt && 'Alt', shift && 'Shift', mod && 'Ctrl', keyLabel].filter(Boolean).join('+')
}

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * A tool's `key` ('M', '\\', 'Shift+E') as a key string ('m', '\\', 'shift+e'),
 * or null when it has none. Tools never take ⌘ or Alt chords.
 */
export function toolKeyString(key: string | undefined): string | null {
  if (!key) return null
  const m = /^(Shift\+)?(.)$/.exec(key)
  if (!m) return null
  return `${m[1] ? 'shift+' : ''}${m[2].toLowerCase()}`
}

// ── Remapping (per profile) ──────────────────────────────────────────────────

/**
 * The person's own keys: a command or tool id -> its key string, or null for
 * "no key". Kept in localStorage, which Electron keeps per profile.
 */
export interface KeyOverrides {
  commands: Record<string, string | null>
  tools: Record<string, string | null>
}

export const OVERRIDES_STORAGE_KEY = 'fb.draw.keyOverrides.v1'

const EMPTY: KeyOverrides = { commands: {}, tools: {} }
let overrides: KeyOverrides = loadOverrides()
const listeners = new Set<() => void>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function cleanMap(v: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  if (!isRecord(v)) return out
  for (const [id, k] of Object.entries(v))
    if (k === null || (typeof k === 'string' && k.length > 0 && k.length < 40)) out[id] = k
  return out
}

export function loadOverrides(): KeyOverrides {
  try {
    const raw = storage()?.getItem(OVERRIDES_STORAGE_KEY)
    if (!raw) return EMPTY
    const v = JSON.parse(raw) as unknown
    if (!isRecord(v)) return EMPTY
    return { commands: cleanMap(v.commands), tools: cleanMap(v.tools) }
  } catch {
    return EMPTY
  }
}

export function keyOverrides(): KeyOverrides {
  return overrides
}

export function setKeyOverrides(next: KeyOverrides): void {
  overrides = { commands: { ...next.commands }, tools: { ...next.tools } }
  effective = null
  const s = storage()
  try {
    if (!Object.keys(overrides.commands).length && !Object.keys(overrides.tools).length)
      s?.removeItem(OVERRIDES_STORAGE_KEY)
    else s?.setItem(OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Storage full or blocked: the remap still applies for this session.
  }
  for (const l of listeners) l()
}

/** Re-read the stored remappings (another window changed them, or a test reset storage). */
export function reloadKeyOverrides(): void {
  overrides = loadOverrides()
  effective = null
  for (const l of listeners) l()
}

export function subscribeKeyOverrides(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// ── The effective keymap ─────────────────────────────────────────────────────

export type KeyTarget =
  { kind: 'command'; id: string; prevent: boolean } | { kind: 'tool'; id: string }

let effective: Map<string, KeyTarget> | null = null

/** Every live key -> what it does: the defaults, the tools' keys, then the person's remappings on top. */
export function effectiveKeymap(
  tools: DrawTool[] = drawTools(),
  o: KeyOverrides = overrides
): Map<string, KeyTarget> {
  if (tools === drawTools() && o === overrides && effective) return effective
  const map = new Map<string, KeyTarget>()
  for (const [k, [id, flag]] of Object.entries(KEYMAP))
    if (!(id in o.commands)) map.set(k, { kind: 'command', id, prevent: flag === 'prevent' })
  for (const t of tools) {
    if (t.id in o.tools) continue
    const k = toolKeyString(t.key)
    if (k && !map.has(k)) map.set(k, { kind: 'tool', id: t.id })
  }
  // A remapping wins over whatever had the key by default.
  for (const [id, k] of Object.entries(o.commands))
    if (k) map.set(k, { kind: 'command', id, prevent: true })
  for (const [id, k] of Object.entries(o.tools)) if (k) map.set(k, { kind: 'tool', id })
  if (tools === drawTools() && o === overrides) effective = map
  return map
}

/** The keys that run a command now, best first (Delete before Backspace on Windows, as Illustrator labels it). */
export function commandKeys(id: string): string[] {
  const keys: string[] = []
  for (const [k, t] of effectiveKeymap()) if (t.kind === 'command' && t.id === id) keys.push(k)
  // The simplest chord first (⌘N before ⌥⌘N for New), and a letter chord
  // before a function key (⌘X, not F2, labels Cut, as in Illustrator's menus).
  const weight = (k: string): number => {
    const p = parseKeyString(k)
    return (
      Number(p.mod) +
      Number(p.alt) +
      Number(p.shift) +
      (/^f\d+$/.test(p.key) ? 3.5 : 0) +
      (platform === 'win' && k === 'backspace' ? 0.5 : 0)
    )
  }
  keys.sort((a, b) => weight(a) - weight(b))
  return keys
}

/** The key that selects a tool now, or null. */
export function toolKey(id: string): string | null {
  for (const [k, t] of effectiveKeymap()) if (t.kind === 'tool' && t.id === id) return k
  return null
}

/** The label a menu shows for a command: its live key, or null when it has none. */
export function commandShortcutLabel(id: string): string | null {
  const [k] = commandKeys(id)
  return k ? formatKey(k) : null
}

/** The label a toolbox tooltip shows for a tool: its live key, or null. */
export function toolShortcutLabel(id: string): string | null {
  const k = toolKey(id)
  return k ? formatKey(k) : null
}

// ── Resolving a key press ────────────────────────────────────────────────────

export type KeyResolution =
  KeyTarget | { kind: 'reserved'; key: string; id: string; label: string } | null

/** Keys whose Alt version means nothing different, so Alt may be ignored on them (Alt+arrow still nudges). */
const ALT_TOLERANT = /^(arrow(left|right|up|down)|backspace|delete|escape|enter|tab)$/

/**
 * What a key press does. Tried in order: the exact chord; without Shift (the
 * command reads Shift itself, as the nudges do; and Shift+A still picks A's
 * tool); without Alt on the navigation keys. A chord Illustrator reserves for
 * a feature still to come stops the search and does nothing -- Shift+M is the
 * Shape Builder in Illustrator, so here it is not the Rectangle tool's M.
 */
export function resolveKey(e: KeyEventLike): KeyResolution {
  const map = effectiveKeymap()
  const base = baseKey(e)
  const candidates = [eventKeyString(e)]
  if (e.shiftKey) candidates.push(eventKeyString(e, { shift: false }))
  if (e.altKey && ALT_TOLERANT.test(base)) {
    candidates.push(eventKeyString(e, { alt: false }))
    if (e.shiftKey) candidates.push(eventKeyString(e, { alt: false, shift: false }))
  }
  for (const k of candidates) {
    const hit = map.get(k)
    if (hit) return hit
    const r = RESERVED_KEYS[k]
    if (r) return { kind: 'reserved', key: k, id: r[0], label: r[1] }
  }
  return null
}

// ── Checking a remap ─────────────────────────────────────────────────────────

/** Keys that cannot be given to anything: they belong to typing, the app or the OS. */
const UNASSIGNABLE = new Set([
  'mod+q',
  'mod+w',
  'mod+h',
  'mod+m',
  'mod+tab',
  'mod+space',
  'space',
  'escape',
  'tab',
  'mod+,',
  'mod+k',
  'mod+shift+k',
  'mod+/'
])

export interface RemapCheck {
  /** Why the key cannot be used; absent when it can. */
  error?: string
  /** Something the person should know, without stopping them. */
  note?: string
}

/**
 * Whether `key` may become the key of command or tool `id`. Clashes with a key
 * already doing something else are refused (the person resets or remaps that
 * one first), as Illustrator's dialog warns on a key already in use.
 */
export function checkRemap(
  kind: 'command' | 'tool',
  id: string,
  key: string,
  describe: (t: KeyTarget) => string
): RemapCheck {
  const p = parseKeyString(key)
  if (!p.key || /^(meta|control|alt|shift|os|capslock|dead|process|unidentified)$/.test(p.key))
    return { error: 'Press a key together with any modifiers.' }
  if (UNASSIGNABLE.has(key))
    return { error: `${formatKey(key)} is kept for the app and cannot be remapped.` }
  if (kind === 'tool' && (p.mod || p.alt))
    return { error: 'Tool keys are a single key, or Shift with a key, as in Illustrator.' }
  const holder = effectiveKeymap().get(key)
  if (holder && !(holder.kind === kind && holder.id === id))
    return { error: `${formatKey(key)} is already used by ${describe(holder)}.` }
  const r = RESERVED_KEYS[key]
  if (r)
    return {
      note: `Illustrator uses ${formatKey(key)} for ${r[1]}, which PlexiiDraw does not have yet.`
    }
  return {}
}
