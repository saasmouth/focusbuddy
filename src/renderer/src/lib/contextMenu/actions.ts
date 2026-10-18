// Concrete handlers the universal providers bind to. Each is a thin wrapper
// over primitives that already exist: createConnectedTool for spawn-and-link,
// the widget store for create/update/remove/archive/bringToFront, the catalog
// for defaults, and the AI Assist preview store for the inline transform flow.
// Keeping them here means the providers stay declarative and the store calls
// live in one auditable place.

import type { PinZone, WidgetKind } from '@shared/types'
import { useWidgetStore } from '../../stores/widgets'
import { removeWorkWidget, removeWorkWidgets } from '../widgetRemoval'
import { contentForIndependentCopy } from '../copyWidgetContent'
import { recordActionWithToast } from '../../stores/actionHistory'
import { useAiAssistPreview } from '../../stores/aiAssistPreview'
import { catalogFor } from '../widgetCatalog'
import { createConnectedTool, createAgentFromSources } from '../createConnectedTool'
import { canCreateWidget } from '../gating'
import { useCapabilityStore } from '../../stores/capabilities'
import { promptUpgrade } from '../../stores/upgradePrompt'
import type { MenuContext } from './types'

// The text a context can offer for seeding or AI work: the selection if there
// is one, otherwise the source widget's own content when it is a text widget.
const TEXT_KINDS: WidgetKind[] = ['sticky', 'note', 'markdown', 'page', 'card', 'living-doc']

export function isTextKind(kind: WidgetKind): boolean {
  return TEXT_KINDS.includes(kind)
}

export function sourceWidget(ctx: MenuContext) {
  if (ctx.object.type === 'widget') return ctx.object.widget
  return null
}

// The text AI Assist or a seed should operate on, and whether it is the whole
// widget content (versus a sub-selection).
export function workingText(ctx: MenuContext): { text: string; whole: boolean } {
  if (ctx.selection?.text && ctx.selection.text.trim()) {
    return { text: ctx.selection.text, whole: false }
  }
  const w = sourceWidget(ctx)
  if (w && isTextKind(w.kind)) return { text: w.content || '', whole: true }
  return { text: '', whole: true }
}

export function hasWorkableText(ctx: MenuContext): boolean {
  return workingText(ctx).text.trim().length > 0
}

// ── Create / Convert ─────────────────────────────────────────────────────────

// Spawn a new widget. From a widget or a selection it spawns connected and
// seeded; from empty canvas it drops at the click point.
export async function createWidget(ctx: MenuContext, kind: WidgetKind, seedText?: string): Promise<void> {
  const entry = catalogFor(kind)
  // Capability gate, same as the widget palette: a Pro-locked kind prompts to
  // upgrade instead of silently creating. Applies to the whole create + connect
  // menu (curated and Advanced alike), closing the gap where right-click could
  // spawn a gated kind ungated.
  if (!canCreateWidget(useCapabilityStore.getState().capabilities, kind)) {
    promptUpgrade(`The ${entry?.label ?? 'this'} work widget is a Pro feature.`)
    return
  }
  const src = sourceWidget(ctx)
  if (src) {
    await createConnectedTool({
      sourceWidgetId: src.id,
      kind,
      content: seedText && isTextKind(kind) ? seedText.slice(0, 2000) : undefined
    })
    return
  }
  // Empty canvas (or multi): drop at the click point.
  if (!ctx.taskId) return
  const w = entry?.defaultWidth ?? 280
  const h = entry?.defaultHeight ?? 200
  await useWidgetStore.getState().create({
    taskId: ctx.taskId,
    kind,
    title: entry?.label ?? '',
    content: seedText && isTextKind(kind) ? seedText.slice(0, 2000) : entry?.defaultContent ?? '',
    x: Math.round(ctx.canvasPoint.x - w / 2),
    y: Math.round(ctx.canvasPoint.y - 20),
    width: w,
    height: h,
    color: kind === 'sticky' ? '#fef08a' : null
  })
}

// Convert is the same spawn-and-link, but seeded from the whole source content
// rather than just a sub-selection, because a conversion reinterprets the whole
// object. On a text selection Create and Convert collapse to the same operation,
// which is why the resolver merges them into one "Turn into" submenu there.
export async function convertWidget(ctx: MenuContext, kind: WidgetKind): Promise<void> {
  const { text } = workingText(ctx)
  await createWidget(ctx, kind, text)
}

// ── Organise ─────────────────────────────────────────────────────────────────

export async function bringToFront(ctx: MenuContext): Promise<void> {
  const store = useWidgetStore.getState()
  if (ctx.object.type === 'multi') {
    for (const w of ctx.object.widgets) await store.bringToFront(w.id)
    return
  }
  const w = sourceWidget(ctx)
  if (w) await store.bringToFront(w.id)
}

export async function ejectFromSection(ctx: MenuContext): Promise<void> {
  const w = sourceWidget(ctx)
  if (w) await useWidgetStore.getState().update(w.id, { parentSectionId: null })
}

// Flag a widget as a Decision (spec §37): create a human-owned Decision that
// references this widget and its desk, so a later material change to the widget
// raises Decision Risk against it (the red health frame) and the desk shows it in
// decisions-at-risk. Undoable: undo cancels the Decision. This is the entry point
// that activates the decision-risk surface.
export async function flagAsDecision(ctx: MenuContext): Promise<void> {
  const w = sourceWidget(ctx)
  if (!w) return
  const api = window.api?.decisions
  if (!api?.create) return
  const title = w.title && w.title.trim() ? w.title.trim() : `Decision on ${w.kind}`
  const related = [w.id, ctx.taskId].filter((x): x is string => !!x)
  const affected = ctx.taskId ? [ctx.taskId] : []
  const create = async (): Promise<string | null> => {
    const d = await api.create({ title, relatedObjectIds: related, affectedDeskIds: affected })
    return d?.id ?? null
  }
  let id = await create()
  if (!id) return
  recordActionWithToast({
    label: 'Flagged as a decision',
    undo: async () => {
      if (id) await api.cancel?.(id)
    },
    redo: async () => {
      id = await create()
    }
  })
}

// Bulk "Automate with an agent" for a multi-selection: spawn one agent and wire
// every selected widget into it, so the agent runs its instruction over all of
// them at once. Undo is provided by the underlying create + link actions (each
// records its own history entry), matching the single-widget create-and-connect
// flow — no separate composite wrapper.
export async function automateWithAgent(ctx: MenuContext): Promise<void> {
  if (ctx.object.type !== 'multi') return
  const ids = ctx.object.widgets.map((w) => w.id)
  if (ids.length === 0) return
  await createAgentFromSources(ids)
}

// ── Share ────────────────────────────────────────────────────────────────────

export async function copyText(ctx: MenuContext): Promise<void> {
  let toCopy = ''
  if (ctx.object.type === 'multi') {
    toCopy = ctx.object.widgets
      .filter((w) => isTextKind(w.kind) && w.content.trim())
      .map((w) => w.content)
      .join('\n\n')
  } else {
    const { text } = workingText(ctx)
    toCopy = text || sourceWidget(ctx)?.content || ''
  }
  if (!toCopy) return
  try {
    await navigator.clipboard.writeText(toCopy)
  } catch {
    // Clipboard can be blocked; fail quietly rather than break the menu.
  }
}

// ── Advanced ─────────────────────────────────────────────────────────────────

export async function duplicateWidget(ctx: MenuContext): Promise<void> {
  const w = sourceWidget(ctx)
  if (!w) return
  // A duplicate is a new, independent work widget file (docs/widget-files.md).
  await useWidgetStore.getState().create({
    taskId: w.taskId,
    kind: w.kind,
    title: w.title,
    content: await contentForIndependentCopy(w.kind, w.content),
    x: w.x + 28,
    y: w.y + 28,
    width: w.width,
    height: w.height,
    color: w.color
  })
}

// ── Destructive ──────────────────────────────────────────────────────────────

export async function archiveWidget(ctx: MenuContext): Promise<void> {
  const w = sourceWidget(ctx)
  if (w) await useWidgetStore.getState().archive(w.id)
}

export async function deleteWidget(ctx: MenuContext): Promise<void> {
  // Remove from this desk, or delete the work widget everywhere — the same
  // question the frame's × asks (docs/widget-files.md, "Remove or delete").
  if (ctx.object.type === 'multi') {
    const done = await removeWorkWidgets(ctx.object.widgets)
    if (done) useWidgetStore.getState().clearSelection()
    return
  }
  const w = sourceWidget(ctx)
  if (w) await removeWorkWidget(w)
}

// ── AI Assist ────────────────────────────────────────────────────────────────

// Open the preview for an AI Assist action. The preview component runs the IPC
// and applies the result; this only stages the request.
export function runAiAssist(
  ctx: MenuContext,
  label: string,
  instruction: string,
  awaitInput = false
): void {
  const w = sourceWidget(ctx)
  if (!w) return
  const { text, whole } = workingText(ctx)
  if (!text.trim()) return
  useAiAssistPreview.getState().start({
    label,
    instruction,
    sourceWidgetId: w.id,
    sourceKind: w.kind,
    text,
    wholeContent: whole,
    awaitInput
  })
}

// ── Pin / Recolor (previously store-only, now exposed in the right-click menu) ─
// Ported from Caleb's desk-UX branch. The pin/recolor capabilities already exist
// in the widget store (pinToZone/unpinWidget/update{color}); these thin wrappers
// surface them in the universal context menu.

// The four corner zones a widget can dock to, and their user-facing labels.
export const PIN_ZONES: Array<{ zone: PinZone; label: string; icon: string }> = [
  { zone: 'tl', label: 'Top left', icon: 'north_west' },
  { zone: 'tr', label: 'Top right', icon: 'north_east' },
  { zone: 'bl', label: 'Bottom left', icon: 'south_west' },
  { zone: 'br', label: 'Bottom right', icon: 'south_east' }
]

export async function pinWidgetToZone(ctx: MenuContext, zone: PinZone): Promise<void> {
  const w = sourceWidget(ctx)
  if (w) await useWidgetStore.getState().pinToZone(w.id, zone)
}

export async function unpinWidget(ctx: MenuContext): Promise<void> {
  const w = sourceWidget(ctx)
  if (w) await useWidgetStore.getState().unpinWidget(w.id)
}

// The canonical widget colour swatches (matches StickyWidget's palette), plus a
// "clear" that removes any custom colour.
export const RECOLOR_SWATCHES: Array<{ color: string; label: string }> = [
  { color: '#fef08a', label: 'Yellow' },
  { color: '#fbcfe8', label: 'Pink' },
  { color: '#bae6fd', label: 'Blue' },
  { color: '#bbf7d0', label: 'Green' },
  { color: '#fed7aa', label: 'Orange' }
]

export async function recolorWidget(ctx: MenuContext, color: string | null): Promise<void> {
  const store = useWidgetStore.getState()
  if (ctx.object.type === 'multi') {
    for (const w of ctx.object.widgets) await store.update(w.id, { color })
    return
  }
  const w = sourceWidget(ctx)
  if (w) await store.update(w.id, { color })
}
