// Applies an approved AI setup draft to a widget in that widget's own format.
// The draft is a flat list of item strings; how they become content depends on
// the widget kind, which the main process named via applyAs. A sticky gets
// checklist lines, a note gets note lines, markdown and a card get bullets.
// Kept pure (formatSetupItems) so the formatting is unit-testable.

import { useWidgetStore } from '../stores/widgets'
import type { Widget } from '@shared/types'

export type WidgetSetupApplyAs =
  | 'sticky-checklist'
  | 'note-lines'
  | 'markdown-bullets'
  | 'card-bullets'
  | 'mindmap-nodes'
  | 'diagram-nodes'
  // Structured kinds (the empty-widget setup assistant) — carry a typed payload,
  // not the flat item list.
  | 'page-doc'
  | 'webview-url'
  // One block of prose that REPLACES the content: a mail rule, an agent's
  // standing instruction, a living-doc brief. The rule IS the content, so a
  // second one appended underneath would mean nothing.
  | 'widget-text'
  // A validated PlexiDash chart config. Validated in the MAIN process against
  // the real tables before it ever reaches here — see validateChartConfig.
  | 'chart-config'
  // An id of a real object, already checked against the workspace in main.
  | 'widget-ref'
  // Just the widget's TITLE. For the kinds with genuinely nothing else to
  // configure — a calculator, a colour picker — where naming it for the desk
  // it sits on is the only honest thing AI can offer.
  | 'widget-title'

// The draft shape the setup preview/apply consumes. Mirrors the main-process
// WidgetSetupDraft (kept in sync by hand; the IPC return type is the contract).
export interface SetupDraft {
  /** applyAs 'widget-text' — the instruction itself. */
  text?: string
  /** applyAs 'chart-config' — already validated against the real tables. */
  chartConfig?: object
  /** applyAs 'widget-ref' — an id checked against the real workspace. */
  refId?: string
  /** What that reference is called, so the preview can name it. */
  refTitle?: string
  /** applyAs 'widget-title' — the proposed name. */
  title?: string
  applyAs?: WidgetSetupApplyAs
  items?: Array<{ id: string; text: string }>
  pageContent?: object
  url?: string
  summary?: string
}

// Widget kinds the setup assistant supports. Kept in sync with the main process
// WIDGET_SETUP_KINDS; the main process is the authoritative gate (an unsupported
// kind returns an error from suggestWidgetSetup).
export const SETUP_SUPPORTED_KINDS: ReadonlySet<string> = new Set([
  // MIRRORS the main process's WIDGET_SETUP_KINDS, which is the
  // authoritative gate — a kind listed here but not there routes the AI
  // button to an expert that refuses, which is worse than no button.
  'agent',
  'attention',
  'calculator',
  'card',
  'chart',
  'color',
  'custom',
  'diagram',
  'drive',
  'file',
  'gdoc',
  'gsheet',
  'gslide',
  'image',
  'image-gen',
  'inbound-hook',
  'inbox',
  'living-doc',
  'markdown',
  'mindmap',
  'minimap',
  'note',
  'page',
  'pdf',
  'portal',
  'scratchpad',
  'section',
  'sticky',
  'table',
  'task-link',
  'video',
  'voice-recorder',
  'webhook',
  'webview'
])

export function isSetupSupported(kind: string): boolean {
  return SETUP_SUPPORTED_KINDS.has(kind)
}

// Whether a widget is "empty" enough to offer the proactive "Set up with AI"
// affordance. Conservative: only when the widget clearly has no real content,
// so a populated widget is never nagged.
export function isWidgetEmptyForSetup(widget: Widget): boolean {
  if (!isSetupSupported(widget.kind)) return false
  if (widget.archived || widget.livingQuery) return false
  const content = (widget.content || '').trim()
  if (widget.kind === 'page') {
    if (!content) return true
    try {
      const doc = JSON.parse(content) as { content?: unknown[] }
      const nodes = Array.isArray(doc.content) ? doc.content : []
      if (nodes.length === 0) return true
      // A fresh page is often a single empty paragraph.
      if (nodes.length === 1) {
        const only = nodes[0] as { type?: string; content?: unknown[] }
        return only.type === 'paragraph' && (!only.content || only.content.length === 0)
      }
      return false
    } catch {
      return false
    }
  }
  // webview, text kinds, mindmap, diagram: empty when there is no content.
  return content.length === 0
}

// Text-format kinds whose items are appended to the widget's text content.
// Structured kinds (mindmap, diagram) are handled by their own JSON appliers.
type TextApplyAs = Exclude<
  WidgetSetupApplyAs,
  | 'mindmap-nodes'
  | 'diagram-nodes'
  | 'page-doc'
  | 'webview-url'
  | 'widget-text'
  | 'chart-config'
  | 'widget-ref'
  | 'widget-title'
>

// Turn the approved item texts into a block of content in a text widget's
// format. Mindmap is handled separately because its content is JSON.
export function formatSetupItems(applyAs: TextApplyAs, items: string[]): string {
  const clean = items.map((t) => t.trim()).filter(Boolean)
  if (clean.length === 0) return ''
  switch (applyAs) {
    case 'sticky-checklist':
      // Matches the sticky's own checklist syntax so the boxes are tickable.
      // Strip any leading checkbox or bullet the model already added.
      return clean.map((t) => `[ ] ${t.replace(/^(\[\s?\]\s*|[-*]\s+)/, '')}`).join('\n')
    case 'note-lines':
    case 'markdown-bullets':
    case 'card-bullets':
      return clean.map((t) => `- ${t.replace(/^[-*]\s+/, '')}`).join('\n')
  }
}

// Append the approved labels to a mind map's JSON as new children of the root,
// preserving the rest of the persisted state. Defends against an empty or
// malformed content by starting from a minimal valid tree.
export function applyMindmapNodes(content: string, labels: string[]): string {
  interface Node {
    id: string
    label: string
    kind: string
    children: Node[]
    attachedWidgetIds: string[]
    assignedAgentSlugs: string[]
    pendingChildren: Node[]
  }
  let state: { root?: Node; [k: string]: unknown } | null = null
  try {
    state = JSON.parse(content)
  } catch {
    state = null
  }
  if (!state || typeof state !== 'object' || !state.root) {
    state = {
      root: {
        id: 'root',
        label: 'New idea',
        kind: 'idea',
        children: [],
        attachedWidgetIds: [],
        assignedAgentSlugs: [],
        pendingChildren: []
      },
      selectedId: 'root',
      viewRootId: 'root',
      agentSuggestions: {},
      agentConversations: {},
      agentStats: {}
    }
  }
  const root = state.root as Node
  const newChildren: Node[] = labels
    .map((l) => l.trim())
    .filter(Boolean)
    .map((label) => ({
      id: makeNodeId(),
      label,
      kind: 'idea',
      children: [],
      attachedWidgetIds: [],
      assignedAgentSlugs: [],
      pendingChildren: []
    }))
  root.children = [...(root.children ?? []), ...newChildren]
  return JSON.stringify(state)
}

function makeNodeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `n-${Math.random().toString(36).slice(2)}`
}

// Append the approved labels to a diagram's JSON as new React-Flow shape nodes,
// laid out in a staggered grid so they do not stack. Preserves existing nodes
// and edges. Defends against empty/malformed content.
export function applyDiagramNodes(content: string, labels: string[]): string {
  interface RFNode {
    id: string
    type: string
    position: { x: number; y: number }
    data: { label: string; shape: string; color: string }
  }
  let state: { nodes?: RFNode[]; edges?: unknown[] } | null = null
  try {
    state = JSON.parse(content)
  } catch {
    state = null
  }
  if (!state || typeof state !== 'object') state = { nodes: [], edges: [] }
  const nodes = Array.isArray(state.nodes) ? (state.nodes as RFNode[]) : []
  const edges = Array.isArray(state.edges) ? state.edges : []
  const base = nodes.length
  const clean = labels.map((l) => l.trim()).filter(Boolean)
  const added: RFNode[] = clean.map((label, k) => {
    const seq = base + k
    return {
      id: makeNodeId(),
      type: 'shape',
      position: { x: 60 + (seq % 5) * 170, y: 60 + (seq % 6) * 110 },
      data: { label, shape: 'rounded', color: '#dbeafe' }
    }
  })
  return JSON.stringify({ nodes: [...nodes, ...added], edges })
}

// Append the approved items to the widget, preserving whatever is already there.
export async function applyWidgetSetup(
  widgetId: string,
  applyAs: WidgetSetupApplyAs,
  items: string[]
): Promise<void> {
  const store = useWidgetStore.getState()
  const w = store.widgets.find((x) => x.id === widgetId)
  if (!w) return
  if (applyAs === 'mindmap-nodes') {
    const nextJson = applyMindmapNodes(w.content || '', items)
    await store.update(widgetId, { content: nextJson })
    return
  }
  if (applyAs === 'diagram-nodes') {
    const nextJson = applyDiagramNodes(w.content || '', items)
    await store.update(widgetId, { content: nextJson })
    return
  }
  // Structured kinds (page, webview, …) are applied by applyStructuredSetup, not
  // here. Guard so the text formatter only sees the text apply-as values.
  if (
    applyAs === 'page-doc' ||
    applyAs === 'webview-url' ||
    applyAs === 'widget-text' ||
    applyAs === 'chart-config' ||
    applyAs === 'widget-ref' ||
    applyAs === 'widget-title'
  ) {
    return
  }
  const block = formatSetupItems(applyAs, items)
  if (!block) return
  const existing = (w.content || '').replace(/\s+$/, '')
  const next = existing ? `${existing}\n${block}` : block
  await store.update(widgetId, { content: next })
}

// Apply a STRUCTURED setup draft (page document, browser URL, …) to a widget.
// Unlike the text appliers above this REPLACES the empty widget's content with
// the proposed setup, which is the point of the empty-widget assistant. Writes
// directly through the widget store, the same path the AI builder accept uses.
export async function applyStructuredSetup(widgetId: string, draft: SetupDraft): Promise<boolean> {
  const store = useWidgetStore.getState()
  const w = store.widgets.find((x) => x.id === widgetId)
  if (!w) return false
  if (draft.applyAs === 'page-doc') {
    if (!draft.pageContent || typeof draft.pageContent !== 'object') return false
    await store.update(widgetId, { content: JSON.stringify(draft.pageContent) })
    return true
  }
  if (draft.applyAs === 'widget-ref') {
    const id = (draft.refId || '').trim()
    if (!id) return false
    // Safe unchecked HERE only because main validated the id against the real
    // workspace — the renderer is not where a reference is judged honest.
    await store.update(widgetId, { content: id })
    return true
  }
  if (draft.applyAs === 'widget-title') {
    const title = (draft.title || '').trim()
    if (!title) return false
    // Title ONLY. These kinds hold no configuration, so writing content would
    // be inventing a setting that does not exist.
    await store.update(widgetId, { title })
    return true
  }
  if (draft.applyAs === 'chart-config') {
    if (!draft.chartConfig) return false
    // Written as the widget's whole content, which is where ChartWidget reads
    // its config from. Safe to write unchecked HERE only because the main
    // process already validated it against the real tables — the renderer is
    // not the place that decides whether a chart config is honest.
    await store.update(widgetId, { content: JSON.stringify(draft.chartConfig) })
    return true
  }
  if (draft.applyAs === 'widget-text') {
    const text = (draft.text || '').trim()
    if (!text) return false
    // REPLACES rather than appends, unlike the list appliers: a rule or a
    // standing instruction is the whole content, not an item in it.
    await store.update(widgetId, { content: text })
    return true
  }
  if (draft.applyAs === 'webview-url') {
    const url = (draft.url || '').trim()
    if (!/^https?:\/\/\S+$/i.test(url)) return false
    await store.update(widgetId, { content: url })
    return true
  }
  return false
}

// True when the draft is a structured kind (handled by applyStructuredSetup)
// rather than the flat item list (applyWidgetSetup).
export function isStructuredApplyAs(applyAs: WidgetSetupApplyAs | null | undefined): boolean {
  return (
    applyAs === 'page-doc' ||
    applyAs === 'webview-url' ||
    applyAs === 'widget-text' ||
    applyAs === 'chart-config' ||
    applyAs === 'widget-ref' ||
    applyAs === 'widget-title'
  )
}
