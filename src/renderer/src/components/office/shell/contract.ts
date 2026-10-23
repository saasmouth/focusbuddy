// The rail and tab contract (SPEC §3.9): "left side tool menus, and top
// settings, they should all work the same" (owner, 4.3.41-local.2). Every
// office app declares its rail and tabs as data with a ROLE per item; these
// pure checks read the roles (never labels, which the lexicon owns) and return
// the ways an app breaks the one order. tests/unit/officeRailTabContract runs
// them over all six apps, so a new item in the wrong place fails there.

import type { BarTab, TabRole } from './ContextBar'
import type { BarKind, BarSemantic } from './primitives'
import { railSlots, type RailItem, type RailRole } from './ToolRail'

/** The tooltip hint of a lockable create tool (double-click keeps it armed, SPEC §3.2). */
export const ARMED_HINT = 'double-click to keep it selected'

/** Rail sections in order: Navigate · Create · Insert · App · bottom panels · AI. */
export const RAIL_SECTION: Record<RailRole, number> = {
  select: 0,
  navigate: 0,
  hand: 0,
  text: 1,
  shape: 1,
  create: 1,
  image: 2,
  insert: 2,
  app: 3,
  panel: 4,
  ai: 5
}

/**
 * The rail `group` for an item of this role: section × 100 plus an app's own
 * sub-group, so the shared sort (group, then order) can never put a section
 * out of place whatever numbers an app uses inside it.
 */
export const railGroup = (role: RailRole, sub = 0): number => RAIL_SECTION[role] * 100 + sub

/** Tab ranks: Home · Insert · Arrange|Layout · app tabs (View too) · Review. Contextual tabs come after all of them. */
export const TAB_RANK: Record<TabRole, number> = { home: 0, insert: 1, arrange: 2, layout: 2, app: 3, view: 3, review: 4 }

/**
 * A lockable create tool (Text, the shapes): click arms it, placing returns to
 * Select, double-click keeps it armed until Esc or V (SPEC §3.2). One factory,
 * so the lock and its hint cannot drift between apps.
 */
export function armedTool<C>(o: {
  id: string
  label: string
  icon: string
  role: 'text' | 'shape' | 'create'
  order: number
  arm: (c: C, lock: boolean) => void
  testid: string
  shortcut?: string
  flyout?: string
  readOnlySafe?: boolean
  sub?: number
}): RailItem<C> {
  return {
    id: o.id,
    label: o.label,
    icon: o.icon,
    kind: 'tool',
    role: o.role,
    group: railGroup(o.role, o.sub),
    order: o.order,
    shortcut: o.shortcut,
    flyout: o.flyout,
    readOnlySafe: o.readOnlySafe,
    optionsHint: ARMED_HINT,
    onSelect: (c) => o.arm(c, false),
    onOptions: (c) => o.arm(c, true),
    testid: o.testid
  }
}

/** Every way a rail breaks the one order (empty = it keeps it). Pure. */
export function railViolations<C>(items: RailItem<C>[], ctx: C): string[] {
  const out: string[] = []
  const visible = items.filter((i) => !(typeof i.hidden === 'function' ? i.hidden(ctx) : i.hidden))
  for (const i of visible) {
    if (!i.role) out.push(`${i.id}: no role`)
    if (i.kind === 'toggle' && !i.pressed) out.push(`${i.id}: a toggle without host pressed state`)
    if (i.dialog && i.kind === 'panel') out.push(`${i.id}: a modal opener typed as a panel (aria-controls would dangle)`)
    if (i.role === 'panel' && i.kind !== 'panel') out.push(`${i.id}: role panel but kind ${i.kind}`)
    if ((i.role === 'panel' || i.role === 'ai') && i.pinned !== 'bottom') out.push(`${i.id}: ${i.role} not pinned to the bottom`)
    if (i.pinned === 'bottom' && i.role !== 'panel' && i.role !== 'ai') out.push(`${i.id}: pinned to the bottom but role ${i.role}`)
    if ((i.role === 'text' || i.role === 'shape') && i.kind === 'tool' && (!i.onOptions || i.optionsHint !== ARMED_HINT))
      out.push(`${i.id}: an armed ${i.role} tool without the double-click lock`)
  }
  if (out.length) return out
  const slots = railSlots(visible, ctx)
  const roles = slots.map((s) => s.shown.role!)
  for (const s of slots) {
    const r = new Set(s.members.map((m) => RAIL_SECTION[m.role!]))
    if (r.size > 1) out.push(`${s.key}: a flyout mixing sections`)
  }
  for (let i = 1; i < slots.length; i++) {
    if (RAIL_SECTION[roles[i]!] < RAIL_SECTION[roles[i - 1]!]) out.push(`${slots[i]!.key} (${roles[i]}) comes after ${slots[i - 1]!.key} (${roles[i - 1]})`)
  }
  const idx = (pred: (r: RailRole) => boolean): number[] => roles.flatMap((r, i) => (pred(r) ? [i] : []))
  const sel = idx((r) => r === 'select')
  if (sel.length && sel[0] !== 0) out.push('Select is not the first slot')
  const hand = idx((r) => r === 'hand')
  const nav = idx((r) => r === 'navigate' || r === 'select')
  if (hand.length && nav.some((n) => n > hand[0]!)) out.push('Hand is not after the selection tools')
  const text = idx((r) => r === 'text')
  const shape = idx((r) => r === 'shape')
  const create = idx((r) => r === 'create')
  if (text.length && [...shape, ...create].some((n) => n < text[0]!)) out.push('Text is not the first create tool')
  if (shape.length && create.some((n) => n < shape[0]!)) out.push('the Shapes flyout is not right after Text')
  const image = idx((r) => r === 'image')
  const insert = idx((r) => r === 'insert')
  if (image.length && insert.some((n) => n < image[0]!)) out.push('Image does not lead the inserts')
  const ai = idx((r) => r === 'ai')
  if (ai.length && ai[ai.length - 1] !== slots.length - 1) out.push('AI is not the last slot')
  return out
}

/** Every way a tab list breaks the one tab order (empty = it keeps it). Pure. */
export function tabViolations<C>(tabs: BarTab<C>[]): string[] {
  const out: string[] = []
  const ids = new Set<string>()
  for (const t of tabs) {
    if (ids.has(t.id)) out.push(`${t.id}: duplicate tab id`)
    ids.add(t.id)
    if (t.contextual && !t.when) out.push(`${t.id}: contextual without when`)
    if (!t.contextual && t.when) out.push(`${t.id}: conditional but not marked contextual`)
    if (!t.contextual && !t.role) out.push(`${t.id}: a permanent tab without a role`)
  }
  if (tabs[0]?.role !== 'home') out.push('the first tab is not Home')
  let seenContextual = false
  let rank = -1
  for (const t of tabs) {
    if (t.contextual) {
      seenContextual = true
      continue
    }
    if (seenContextual) out.push(`${t.id}: a permanent tab after a contextual one`)
    const r = t.role ? TAB_RANK[t.role] : 99
    if (r < rank) out.push(`${t.id} (${t.role}) is out of order`)
    rank = Math.max(rank, r)
  }
  return out
}

/** The canonical order of a tab's text controls. */
export const TEXT_ORDER: BarSemantic[] = ['font-family', 'font-size', 'bold', 'italic', 'underline', 'text-color', 'align-left', 'align-center', 'align-right']

const REQUIRED_KIND: Record<BarSemantic, BarKind> = {
  'font-family': 'font',
  'font-size': 'number',
  bold: 'toggle',
  italic: 'toggle',
  underline: 'toggle',
  'text-color': 'color',
  'align-left': 'toggle',
  'align-center': 'toggle',
  'align-right': 'toggle'
}

/** A control an app genuinely cannot have, with the reason (SPEC §5a/§9 exceptions). Named, never a silent pass. */
export interface ControlException {
  semantic: BarSemantic
  reason: string
}

/**
 * Every way the text controls rendered under `root` break the control-type
 * rule: a missing control (unless excepted), the wrong primitive, a duplicate,
 * the wrong order, or a B/I/U shortcut hint that disagrees with whether the key
 * is actually bound (§9.4: a hint only for a bound key). Pure over the DOM.
 */
export function controlViolations(root: ParentNode, opts: { exceptions?: ControlException[]; bound?: Partial<Record<'bold' | 'italic' | 'underline', boolean>> } = {}): string[] {
  const out: string[] = []
  const excepted = new Set((opts.exceptions ?? []).map((e) => e.semantic))
  const els = [...root.querySelectorAll<HTMLElement>('[data-bar-semantic]')]
  const order: BarSemantic[] = []
  for (const sem of TEXT_ORDER) {
    const found = els.filter((e) => e.dataset.barSemantic === sem)
    if (excepted.has(sem)) {
      if (found.length) out.push(`${sem}: listed as an exception but present`)
      continue
    }
    if (!found.length) {
      out.push(`${sem}: missing`)
      continue
    }
    if (found.length > 1) out.push(`${sem}: ${found.length} copies`)
    const el = found[0]!
    const kind = el.dataset.barKind === 'custom' && el.querySelector('[data-bar-kind="font"]') ? 'font' : el.dataset.barKind
    if (kind !== REQUIRED_KIND[sem]) out.push(`${sem}: a ${kind}, not a ${REQUIRED_KIND[sem]}`)
    if (sem === 'bold' || sem === 'italic' || sem === 'underline') {
      const hinted = /\(.+\)$/.test(el.getAttribute('aria-label') ?? '')
      const bound = opts.bound?.[sem] ?? false
      if (hinted !== bound) out.push(`${sem}: ${hinted ? 'shows a shortcut that is not bound' : 'its bound shortcut is not shown'}`)
    }
  }
  for (const e of els) {
    const sem = e.dataset.barSemantic as BarSemantic
    if (TEXT_ORDER.includes(sem) && !order.includes(sem)) order.push(sem)
  }
  const expected = TEXT_ORDER.filter((s) => order.includes(s))
  if (order.join() !== expected.join()) out.push(`text controls out of order: ${order.join(', ')}`)
  return out
}
