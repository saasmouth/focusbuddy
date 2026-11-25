import type { Widget, WidgetKind } from '@shared/types'

// The display name for a widget, used by the frame header and the dev metrics
// overlay. Precedence: a manual title the user typed wins; otherwise we inherit
// a name from the widget's own content (the first line of a note, the hostname
// of a browser); otherwise we fall back to whatever label the widget kind passed
// (often already content-derived, e.g. a table's title) and finally a friendly
// kind name. Kept pure and framework-free so it unit-tests without React.

// Kinds whose `content` is plain/markdown text — the first non-empty line is the
// natural name.
const TEXT_KINDS = new Set<WidgetKind>(['sticky', 'note', 'markdown', 'card', 'scratchpad'])

// Kinds whose `content` is a URL — the hostname is the natural name.
const URL_KINDS = new Set<WidgetKind>([
  'webview',
  'image',
  'video',
  'pdf',
  'gdoc',
  'gsheet',
  'gslide',
  'email'
])

const KIND_LABELS: Partial<Record<WidgetKind, string>> = {
  webview: 'Browser',
  sticky: 'Sticky',
  note: 'Note',
  markdown: 'Markdown',
  card: 'Card',
  scratchpad: 'Scratchpad',
  table: 'Table',
  page: 'Page',
  field: 'Field',
  mindmap: 'Mind map',
  diagram: 'Diagram',
  portal: 'Portal',
  agent: 'Agent'
}

// The first line of a text body, stripped of common markdown lead-ins (heading
// hashes, bullets, task checkboxes, blockquote marks) and inline emphasis marks,
// so "## Pricing notes" reads as "Pricing notes".
export function firstLineOf(content: string): string {
  for (const raw of (content || '').split(/\r?\n/)) {
    const line = raw
      .replace(/^﻿/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^>\s+/, '')
      .replace(/[*_`~]/g, '')
      .trim()
    if (line) return line
  }
  return ''
}

// Hostname of a URL (with or without a scheme), www. stripped. Empty when the
// content isn't URL-like.
export function hostnameOf(url: string): string {
  const u = (url || '').trim()
  if (!u) return ''
  try {
    return new URL(u.includes('://') ? u : `https://${u}`).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// First text node of a Tiptap JSON document (the `page` widget's content shape).
function firstTextFromTiptap(content: string): string {
  try {
    const doc = JSON.parse(content) as unknown
    let found = ''
    const walk = (node: unknown): void => {
      if (found || node == null || typeof node !== 'object') return
      const n = node as { text?: unknown; content?: unknown }
      if (typeof n.text === 'string' && n.text.trim()) {
        found = n.text.trim()
        return
      }
      if (Array.isArray(n.content)) for (const child of n.content) walk(child)
    }
    walk(doc)
    return found
  } catch {
    return ''
  }
}

// The name inherited from a widget's own content, or '' when the kind has no
// natural content-derived name.
export function deriveWidgetName(widget: Pick<Widget, 'kind' | 'content'>): string {
  if (TEXT_KINDS.has(widget.kind)) return firstLineOf(widget.content)
  if (widget.kind === 'page') {
    return firstTextFromTiptap(widget.content) || firstLineOf(widget.content)
  }
  if (URL_KINDS.has(widget.kind)) return hostnameOf(widget.content)
  return ''
}

export function truncateName(s: string, max = 60): string {
  const t = (s || '').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1).trimEnd()}…`
}

// The label to show for a widget. `fallbackLabel` is the kind-specific header
// string the widget already computes (e.g. a table title, a field label); it's
// used only when there's no manual title and no content-derived name.
export function widgetDisplayName(
  widget: Pick<Widget, 'kind' | 'content' | 'title'>,
  fallbackLabel = ''
): string {
  const manual = (widget.title || '').trim()
  if (manual) return truncateName(manual)
  const derived = deriveWidgetName(widget)
  if (derived) return truncateName(derived)
  const fb = (fallbackLabel || '').trim()
  if (fb) return fb
  return KIND_LABELS[widget.kind] ?? 'Work widget'
}
