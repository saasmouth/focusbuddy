// Reading a Build with AI reply into work-widget suggestions. Pure — no DB, no
// Electron — so every recovery path is unit tested (tests/unit/deskBuildParse).
//
// Two things this exists for:
//
// 1. Nothing complete is thrown away. A desk is one JSON object holding every
//    work widget. If the reply stops early (the output limit, a dropped stream)
//    or one widget comes back malformed, JSON.parse fails on the whole thing.
//    Until 4.3.45 that discarded every finished, configured widget behind "AI
//    returned invalid JSON" — the generation paid for, and nothing shown. Here
//    each widget in the array is read on its own, and only the unreadable ones
//    are dropped (and counted, so the caller can say so).
//
// 2. Pages are written as markdown. The model sends `pageMarkdown`, and it
//    becomes the Tiptap page document here. The same page as Tiptap JSON costs
//    several times the output tokens — every run of text wrapped in
//    {"type":"text","text":…} — and every one of those braces is a chance to
//    break the reply. A `pageContent` document sent directly is kept as is.

import type { AiBuildSuggestion, WidgetKind } from '@shared/types'
import { extractJson } from './chatJson'
import { markdownToTiptap } from './markdownToTiptap'

/** The kinds a suggestion may have: what the canvas can render from a build. */
export const BUILD_KINDS: readonly WidgetKind[] = [
  'sticky',
  'note',
  'markdown',
  'webview',
  'pdf',
  'gdoc',
  'gsheet',
  'gslide',
  'email',
  'calculator',
  'color',
  'image',
  'video',
  'timer',
  'section',
  'task-link',
  'local-app-launcher',
  'file',
  'field',
  'page',
  'table'
]

export type DeskBuildParse =
  | {
      ok: true
      intent?: string
      suggestions: AiBuildSuggestion[]
      /** True when the reply was not valid JSON as a whole and widgets were read one by one. */
      recovered: boolean
      /** Widgets that were started but could not be read (cut off, or malformed). */
      dropped: number
    }
  | { ok: false; reason: 'no-json' }
  | { ok: false; reason: 'unreadable'; dropped: number }

export function parseDeskBuild(text: string): DeskBuildParse {
  const whole = readWhole(text)
  if (whole) {
    const suggestions = normaliseAll(whole.suggestions)
    return { ok: true, intent: whole.intent, suggestions, recovered: false, dropped: 0 }
  }
  if (!/[{[]/.test(text)) return { ok: false, reason: 'no-json' }
  const salvaged = salvage(text)
  if (salvaged.items.length === 0) return { ok: false, reason: 'unreadable', dropped: salvaged.dropped }
  return {
    ok: true,
    intent: salvaged.intent,
    suggestions: normaliseAll(salvaged.items),
    recovered: true,
    dropped: salvaged.dropped
  }
}

function readWhole(text: string): { intent?: string; suggestions: unknown[] } | null {
  const raw = extractJson(text)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { intent?: unknown; suggestions?: unknown }
    if (!v || typeof v !== 'object' || !Array.isArray(v.suggestions)) return null
    return { intent: typeof v.intent === 'string' ? v.intent : undefined, suggestions: v.suggestions }
  } catch {
    return null
  }
}

/**
 * Walk the "suggestions" array element by element. Each element is cut out by
 * a string-aware bracket scan (a brace or quote inside a string never ends it)
 * and parsed on its own. A partial element at the end — the reply stopped
 * there — counts as dropped.
 */
function salvage(text: string): { intent?: string; items: unknown[]; dropped: number } {
  const items: unknown[] = []
  let dropped = 0
  const key = text.indexOf('"suggestions"')
  const intent = readStringField(key >= 0 ? text.slice(0, key) : text, 'intent')
  if (key < 0) return { intent, items, dropped }
  let i = text.indexOf('[', key)
  if (i < 0) return { intent, items, dropped }
  i++
  while (i < text.length) {
    const ch = text[i]
    if (ch === ']') break
    if (ch !== '{') {
      i++
      continue
    }
    const end = closingBrace(text, i)
    if (end < 0) {
      dropped++ // cut off inside this widget
      break
    }
    try {
      items.push(JSON.parse(text.slice(i, end + 1)))
    } catch {
      dropped++
    }
    i = end + 1
  }
  return { intent, items, dropped }
}

/** Index of the brace that closes the object opening at `start`, or -1 when it never closes. */
function closingBrace(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return ch === '}' ? i : -1
    }
  }
  return -1
}

function readStringField(s: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(s)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return undefined
  }
}

/** Every renderable suggestion, pages converted, ids unique. */
function normaliseAll(raw: unknown[]): AiBuildSuggestion[] {
  const out: AiBuildSuggestion[] = []
  const used = new Set<string>()
  for (const r of raw) {
    const s = normaliseOne(r)
    if (!s) continue
    // Selection in the builder is keyed by id: two cards sharing one would
    // toggle together, and a missing one would make React warn.
    let id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : ''
    if (!id || used.has(id)) {
      let n = out.length + 1
      while (used.has(`s${n}`)) n++
      id = `s${n}`
    }
    used.add(id)
    out.push({ ...s, id })
  }
  return out
}

function normaliseOne(raw: unknown): AiBuildSuggestion | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = { ...(raw as Record<string, unknown>) }
  if (typeof s.kind !== 'string' || !BUILD_KINDS.includes(s.kind as WidgetKind)) return null
  if (typeof s.title !== 'string') s.title = ''
  if (typeof s.reason !== 'string') s.reason = ''
  if (s.kind === 'page') {
    const doc = s.pageContent as { content?: unknown } | undefined
    const hasDoc = !!doc && typeof doc === 'object' && Array.isArray(doc.content)
    if (!hasDoc && typeof s.pageMarkdown === 'string' && s.pageMarkdown.trim()) {
      s.pageContent = markdownToTiptap(s.pageMarkdown)
    }
  }
  // Never passed on: the renderer reads pageContent only.
  delete s.pageMarkdown
  return s as unknown as AiBuildSuggestion
}
