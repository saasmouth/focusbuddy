// The single resolver. Every surface calls resolveMenu(ctx) and hands the
// result straight to CanvasContextMenu. It collects contributions, applies
// predicates, and folds them into the eight canonical bands under a hard
// top-level ceiling of eight.
//
// The ceiling is honoured deterministically, which is the decision the spec's
// critic flagged as load-bearing. Each section occupies at most one top-level
// slot. Context may inline up to two rows. Create and Convert share one slot,
// which also resolves their overlap. Sparse middle sections inline as a single
// row; richer ones become a submenu parent. Worst case is therefore
// Context(2) + AiAssist + Create/Convert + Organise + Share + Advanced +
// Destructive = 8, and it never exceeds that regardless of how rich the object
// is. The Attention row (always offered since DEC-144) takes one of the two
// Context slots when present: Attention + Context(1) + … = 8.

import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import { MenuSection, type MenuContext, type MenuContribution, type WidgetContribution } from './types'
import { collectWidgetContribution, collectPluginContributions } from './registry'
import { buildAiAssistContribution } from './aiAssist'
import {
  buildAttention,
  buildCreate,
  buildConvert,
  buildOrganise,
  buildShare,
  buildAdvanced,
  buildDestructive
} from './universal'

const passes = (c: MenuContribution, ctx: MenuContext): boolean => !c.predicate || c.predicate(ctx)

// Map a contribution to the renderer's item shape, binding the click and
// resolving the disabled state. Children recurse.
function toItem(c: MenuContribution, ctx: MenuContext): CtxMenuItem {
  const disabled = c.enabled ? !c.enabled(ctx) : false
  const reason = disabled && c.disabledReason ? c.disabledReason(ctx) : undefined
  const kids = c.children?.filter((k) => passes(k, ctx)).map((k) => toItem(k, ctx))
  return {
    label: reason ? `${c.label} (${reason})` : c.label,
    icon: c.icon,
    shortcut: c.shortcut,
    disabled: disabled || (!!kids && kids.length === 0 && !c.onSelect),
    onClick: c.onSelect ? () => void c.onSelect?.(ctx) : undefined,
    children: kids && kids.length ? kids : undefined
  }
}

function sortByPriority(a: MenuContribution, b: MenuContribution): number {
  return a.priority - b.priority
}

// Fold a middle section into a single top-level slot: nothing when empty, one
// inlined row when it has exactly one action, otherwise a submenu parent.
function sectionSlot(
  rows: MenuContribution[],
  parentLabel: string,
  parentIcon: string,
  ctx: MenuContext
): CtxMenuItem | null {
  const live = rows.filter((r) => passes(r, ctx)).sort(sortByPriority)
  if (live.length === 0) return null
  if (live.length === 1) return toItem(live[0], ctx)
  return {
    label: parentLabel,
    icon: parentIcon,
    children: live.map((r) => toItem(r, ctx))
  }
}

// Context band: inline up to two highest-priority rows; if there are more, keep
// the single most important inlined and fold the remainder into one More
// submenu, so the band never claims more than `max` top-level slots (two, or
// one when the Attention row already took the band's other slot).
function contextSlots(rows: MenuContribution[], ctx: MenuContext, max: 1 | 2): CtxMenuItem[] {
  const live = rows.filter((r) => passes(r, ctx)).sort(sortByPriority)
  if (live.length === 0) return []
  if (live.length <= max) return live.map((r) => toItem(r, ctx))
  const inline = max - 1
  return [
    ...live.slice(0, inline).map((r) => toItem(r, ctx)),
    { label: 'More actions', icon: 'more_horiz', children: live.slice(inline).map((r) => toItem(r, ctx)) }
  ]
}

// Build the combined Create / Convert slot. The two share one top-level slot:
// a Create parent whose children are the create offerings, then a separator,
// then the convert offerings. This guarantees the eight-item ceiling and
// dissolves the Create/Convert overlap the brief risked.
function createConvertSlot(ctx: MenuContext, suppress: WidgetContribution['suppress']): CtxMenuItem | null {
  // Create and Convert act on a single object; a multi-selection only gets bulk
  // actions.
  if (ctx.object.type === 'multi') return null
  const createParent = suppress?.create ? null : buildCreate(ctx)[0]
  const convertRows = suppress?.convert ? [] : buildConvert(ctx).flatMap((c) => c.children ?? [])
  if (!createParent && convertRows.length === 0) return null

  const children: CtxMenuItem[] = []
  if (createParent?.children) {
    for (const k of createParent.children) children.push(toItem(k, ctx))
  }
  if (convertRows.length) {
    if (children.length) children.push({ separator: true })
    // DEC-041: "Turn this into" was false — the source is never replaced or
    // removed; a NEW widget appears beside it carrying a copy of the text.
    children.push({ label: 'Copy into', disabled: true })
    for (const k of convertRows) {
      const item = toItem(k, ctx)
      children.push(item)
    }
  }
  // DEC-041: the wire IS the feature — every entry here spawns a widget AND
  // links it to this one — so the label finally says so.
  return { label: 'Create & link', icon: 'add', children }
}

// Destructive band: one slot. A single destructive row inlines; two or more
// (Archive then Delete) fold under one Remove parent.
function destructiveSlot(rows: MenuContribution[], ctx: MenuContext): CtxMenuItem | null {
  const live = rows.filter((r) => passes(r, ctx)).sort(sortByPriority)
  if (live.length === 0) return null
  if (live.length === 1) return toItem(live[0], ctx)
  return { label: 'Remove', icon: 'delete', children: live.map((r) => toItem(r, ctx)) }
}

function contextBand(ctx: MenuContext): WidgetContribution {
  if (ctx.object.type === 'widget') {
    return collectWidgetContribution(ctx.object.widget.kind, ctx)
  }
  return { context: [], suppress: {} }
}

export function resolveMenu(ctx: MenuContext): CtxMenuItem[] {
  const wc = contextBand(ctx)
  const suppress = wc.suppress ?? {}

  const slots: CtxMenuItem[] = []

  // 0. Attention — FIRST, above everything (CR-09 D-A, operator ruling).
  // Marking the object you just right-clicked is the most common reason to
  // open this menu; burying it under Create/Convert made it unreachable.
  const attn = buildAttention(ctx)
  const attnTaken = !!attn && !suppress['attention']
  if (attnTaken) slots.push(toItem(attn, ctx))

  // 1. Context — kind-specific header extras (a widget's own rows) first, then
  // the registered context-band rows.
  if (ctx.headerExtras && ctx.headerExtras.length) {
    slots.push(...ctx.headerExtras)
  }
  const ctxSlots = contextSlots(wc.context, ctx, attnTaken ? 1 : 2)
  slots.push(...ctxSlots)

  // 2. AI Assist
  if (!suppress['ai-assist']) {
    const ai = buildAiAssistContribution(ctx)
    if (ai) {
      const item = toItem(ai, ctx)
      if (item.children && item.children.length) slots.push(item)
    }
  }

  // 3-4. Create + Convert (one combined slot)
  const cc = createConvertSlot(ctx, suppress)
  if (cc && cc.children && cc.children.length) slots.push(cc)

  // 5. Organise
  if (!suppress.organise) {
    const s = sectionSlot(buildOrganise(ctx), 'Organise', 'tune', ctx)
    if (s) slots.push(s)
  }

  // 6. Share
  if (!suppress.share) {
    const s = sectionSlot(buildShare(ctx), 'Share', 'ios_share', ctx)
    if (s) slots.push(s)
  }

  // 7. Advanced (plus any marketplace plugin actions, sandboxed under here)
  if (!suppress.advanced) {
    const advanced = [...buildAdvanced(ctx)]
    const plugins = collectPluginContributions(ctx)
    if (plugins.length) {
      advanced.push({
        id: 'core/advanced/installed-tools',
        section: MenuSection.Advanced,
        priority: 90,
        label: 'Installed tools',
        icon: 'extension',
        children: plugins
      })
    }
    const s = sectionSlot(advanced, 'Advanced', 'more_horiz', ctx)
    if (s) slots.push(s)
  }

  // 8. Destructive (always last)
  if (!suppress.destructive) {
    const d = destructiveSlot(buildDestructive(ctx), ctx)
    if (d) {
      if (slots.length) slots.push({ separator: true })
      slots.push(d)
    }
  }

  return slots
}
