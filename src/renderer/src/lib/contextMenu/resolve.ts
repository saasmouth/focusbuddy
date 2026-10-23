// The single resolver. Every work widget surface calls resolveMenu(ctx) and
// hands the result to the kit (CanvasContextMenu). It collects the universal
// rows, the kind's provider rows, a host's per-instance rows and any plugin
// rows, places each in its §9.3 group (types.ts), and keeps the eight-row
// ceiling (E-6) by folding the least-needed rows into More actions ▸.
//
// The ceiling counts every top-level row above the destructive group,
// including Paste, kind-specific rows and header extras, and More actions
// itself. The destructive group is bounded separately by E-2 (at most three
// explicit rows: Archive · Remove from this desk · Move to Trash), because
// folding a destructive row into More would hide exactly what §9.3 wants last
// and unmistakable. Both numbers live here, in MENU_ROW_CEILING and the
// destructive builder, so a ruling is a one-line change.

import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import {
  MENU_GROUP_ORDER,
  MenuSection,
  type MenuContext,
  type MenuContribution,
  type MenuGroup,
  type UniversalKey
} from './types'
import { collectWidgetContribution, collectPluginContributions } from './registry'
import { buildAiAssistContribution } from './aiAssist'
import {
  buildAttention,
  buildObject,
  buildClipboard,
  buildArrange,
  buildPlexii,
  buildCreate,
  buildMore,
  buildDestructive
} from './universal'
import { MENU } from '@shared/menus/lexicon'

/**
 * E-1 (owner ruling): the head of the object group, in this order: Open rows
 * (contributions marked `opens`), then Add to Focus…. A ruling that reorders
 * them is a change to these two numbers. (The jump list's Rename, E-11, sits
 * above both; see universal.ts buildObject.)
 */
export const OBJECT_LEAD = { open: -1100, attention: -1000 } as const

/** E-6: top-level rows above the destructive group, More actions included. */
export const MENU_ROW_CEILING = 8

const NEVER = -Infinity

// How readily each universal row leaves the top level when the menu is over
// its ceiling: the highest folds first. The rows §9.3 names for every object
// (Add to Focus…, Copy, Paste, Ask PlexiiAssist) never fold. AI assist ▸ is
// kept ahead of the kind rows because folding it would push its tone and
// language leaves to a fourth level. Kind rows: the first one a kind offers
// ranks 3 (it is usually why the menu was opened), the rest 7. On a crowded
// text widget Save selection as snippet… is the first of §9.3's named rows to
// move into More actions.
const FOLD: Record<string, number> = {
  'core/attention': NEVER,
  'core/copy': NEVER,
  'core/paste': NEVER,
  'core/ask-assist': NEVER,
  'core/duplicate': 1,
  'core/ai-assist': 2,
  'core/save-snippet': 3.5,
  'core/open-file': 4,
  'core/insert-snippet': 5,
  'core/rename': 5,
  'core/front': 6,
  'core/share': 6,
  'core/duplicate-synced': 8
}
const FIRST_KIND_ROW_FOLD = 3
const KIND_ROW_FOLD = 7

// One row on its way to the menu: a contribution, or a raw kit item a host
// passed through (headerExtras).
interface Row {
  group: MenuGroup
  priority: number
  fold: number
  order: number
  c?: MenuContribution
  item?: CtxMenuItem
}

const passes = (c: MenuContribution, ctx: MenuContext): boolean => !c.predicate || c.predicate(ctx)

function groupOf(c: MenuContribution): MenuGroup {
  if (c.danger) return 'destructive'
  if (c.group) return c.group
  if (c.section === MenuSection.Destructive) return 'destructive'
  if (c.section === undefined || c.section === MenuSection.Context) return 'object'
  return 'more'
}

// A contribution as the kit draws it. Children recurse; a child's
// separatorBefore starts a run. A parent whose children all fell away is
// dropped (absent, never dead).
function toItem(c: MenuContribution, ctx: MenuContext): CtxMenuItem | null {
  let children: CtxMenuItem[] | undefined
  if (c.children) {
    children = []
    for (const k of c.children.filter((k) => passes(k, ctx))) {
      const item = toItem(k, ctx)
      if (!item) continue
      if (k.separatorBefore && children.length) children.push({ separator: true })
      children.push(item)
    }
    if (!children.length && !c.onSelect) return null
  }
  const disabled = c.enabled ? !c.enabled(ctx) : false
  const hint = disabled && c.disabledReason ? c.disabledReason(ctx) : undefined
  const isDanger = c.danger || groupOf(c) === 'destructive'
  return {
    label: c.label,
    icon: c.icon,
    shortcut: c.shortcut,
    ...(isDanger ? { danger: true } : {}),
    ...(c.checked !== undefined ? { checked: c.checked } : {}),
    ...(c.testid ? { testid: c.testid } : {}),
    ...(disabled ? { disabled: true, ...(hint ? { hint } : {}) } : {}),
    onClick: c.onSelect ? () => void c.onSelect?.(ctx) : undefined,
    children: children && children.length ? children : undefined
  }
}

function rowItem(r: Row, ctx: MenuContext): CtxMenuItem | null {
  if (r.item) return r.group === 'destructive' ? { ...r.item, danger: true } : r.item
  return r.c ? toItem(r.c, ctx) : null
}

const byPlace = (a: Row, b: Row): number =>
  MENU_GROUP_ORDER.indexOf(a.group) - MENU_GROUP_ORDER.indexOf(b.group) || a.priority - b.priority || a.order - b.order

// Rows as items with one separator between groups (inside More actions too).
function itemsWithSeparators(rows: Row[], ctx: MenuContext): CtxMenuItem[] {
  const out: CtxMenuItem[] = []
  let last: MenuGroup | null = null
  for (const r of rows) {
    const item = rowItem(r, ctx)
    if (!item) continue
    if (last !== null && r.group !== last) out.push({ separator: true })
    out.push(item)
    last = r.group
  }
  return out
}

export function resolveMenu(ctx: MenuContext): CtxMenuItem[] {
  const wc = ctx.object.type === 'widget' ? collectWidgetContribution(ctx.object.widget.kind, ctx) : { context: [], suppress: {} }
  const s: Partial<Record<UniversalKey, boolean>> = wc.suppress ?? {}

  const rows: Row[] = []
  let order = 0
  const add = (c: MenuContribution | null | undefined, fold?: number): void => {
    if (!c || !passes(c, ctx)) return
    const lead = c.opens ? OBJECT_LEAD.open : c.id === 'core/attention' ? OBJECT_LEAD.attention : null
    rows.push({
      group: groupOf(c),
      priority: lead ?? c.priority,
      fold: c.opens ? NEVER : (c.fold ?? fold ?? FOLD[c.id] ?? KIND_ROW_FOLD),
      order: order++,
      c
    })
  }

  // 1. Add to Focus… (second on an object with an Open row, first otherwise: OBJECT_LEAD).
  if (!s.attention) add(buildAttention(ctx))

  // Kind rows: the host's raw extras first (the old headerMenuExtras), then
  // its per-instance contributions, then the kind's registered provider rows.
  // Separators inside the extras are dropped: the groups draw their own.
  let kindRows = 0
  const kindFold = (): number => (kindRows++ === 0 ? FIRST_KIND_ROW_FOLD : KIND_ROW_FOLD)
  for (const item of ctx.headerExtras ?? []) {
    if (item.separator || !item.label) continue
    // A body's own "More actions ▸" (the custom widget's) merges into the one
    // the resolver builds: one More actions per menu, never two.
    if (item.label === MENU.moreActions.label && item.children?.length) {
      for (const child of item.children) {
        if (child.separator || !child.label) continue
        rows.push({ group: child.danger ? 'destructive' : 'more', priority: 50 + order, fold: KIND_ROW_FOLD, order: order++, item: child })
      }
      continue
    }
    const group: MenuGroup = item.danger ? 'destructive' : 'object'
    rows.push({ group, priority: -100 + order, fold: group === 'object' ? kindFold() : KIND_ROW_FOLD, order: order++, item })
  }
  for (const c of [...(ctx.contributions ?? []), ...[...wc.context].sort((a, b) => a.priority - b.priority)]) {
    const g = groupOf(c)
    add(c, g === 'more' || g === 'destructive' ? undefined : kindFold())
  }

  for (const c of buildObject(ctx, s)) add(c)
  for (const c of buildClipboard(ctx, s)) add(c)
  for (const c of buildArrange(ctx, s)) add(c)
  for (const c of buildPlexii(ctx, s)) add(c)
  if (!s['ai-assist']) add(buildAiAssistContribution(ctx))
  add(buildCreate(ctx, s))
  for (const c of buildMore(ctx, s)) add(c)
  // Marketplace plugin rows stay sandboxed under one parent in More actions.
  const plugins = s.advanced ? [] : collectPluginContributions(ctx)
  if (plugins.length) {
    add({ id: 'core/installed-tools', group: 'more', priority: 90, label: 'Installed tools', icon: 'extension', children: plugins })
  }
  for (const c of buildDestructive(ctx, s)) add(c)

  const top = rows.filter((r) => r.group !== 'more' && r.group !== 'destructive').sort(byPlace)
  const more = rows.filter((r) => r.group === 'more').sort(byPlace)
  const destructive = rows.filter((r) => r.group === 'destructive').sort(byPlace)

  // Keep the ceiling: fold the most foldable row (the later one on a tie)
  // until the top level fits, counting More actions once it is needed.
  const folded: Row[] = []
  const overCeiling = (): boolean => top.length + (more.length || folded.length ? 1 : 0) > MENU_ROW_CEILING
  while (overCeiling()) {
    let pick = -1
    for (let i = 0; i < top.length; i++) {
      if (top[i].fold === NEVER) continue
      if (pick < 0 || top[i].fold >= top[pick].fold) pick = i
    }
    if (pick < 0) break
    folded.push(...top.splice(pick, 1))
  }
  folded.sort(byPlace)

  const items = itemsWithSeparators(top, ctx)
  const moreChildren = [...itemsWithSeparators(folded, ctx)]
  const moreRest = itemsWithSeparators(more, ctx)
  if (moreRest.length) {
    if (moreChildren.length) moreChildren.push({ separator: true })
    moreChildren.push(...moreRest)
  }
  const moreRows = moreChildren.filter((i) => !i.separator)
  if (moreRows.length === 1) {
    // One row does not need a submenu of its own: it takes More's place.
    if (items.length) items.push({ separator: true })
    items.push(moreRows[0])
  } else if (moreRows.length > 1) {
    if (items.length) items.push({ separator: true })
    items.push({ label: MENU.moreActions.label, icon: 'more_horiz', testid: 'ctx-more-actions', children: moreChildren })
  }

  const danger = itemsWithSeparators(destructive, ctx).filter((i) => !i.separator)
  if (danger.length) {
    if (items.length) items.push({ separator: true })
    items.push(...danger)
  }
  return items
}
