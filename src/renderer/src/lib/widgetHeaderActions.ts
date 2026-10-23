// The work-widget header's action row: which buttons fit, and what a modifier
// click on one of them means.
//
// ONE RULE FOR EVERY KIND. At a sticky's default 240px the eight header tools
// (AI, rename, link, pin, shrink, grow, expand, remove) used to take ~200px of
// a 224px row: the title shrank to nothing and about 16px was left to grab the
// widget by. Rather than hide tools per kind, the row is folded by priority:
// measure what the header can spare after a minimum title and a minimum grab
// area, show as many of the highest-priority tools as fit, and put the rest
// behind a "…" overflow menu. A wide widget shows everything, as before.
//
// MODIFIER CLICKS. Shift on a work widget means "add to / remove from the
// selection" and ⌘/Ctrl while zoomed out means "dive in" (WidgetFrame's
// mousedown capture). Since 55ea2b30 the frame's click capture swallows a
// shift-click so the control it lands on does not also run; that same capture
// now swallows the ⌘/Ctrl dive too, and both decisions come from
// resolveModifierClick below, shared with the mousedown handler.

/** Every tool the header row can carry. */
export type HeaderActionId = 'ai' | 'rename' | 'link' | 'pin' | 'shrink' | 'grow' | 'expand' | 'remove'

/**
 * Most important first. The first ones stay on the header longest.
 *
 * - AI: the one tool the header exists to offer on every kind (it was moved to
 *   the front of the row for that reason).
 * - Expand: the way into a roomier view, which a narrow widget needs most.
 * - Remove: the close mark people expect on the frame itself.
 * - Pin: placement, used often on small reference widgets.
 * - Rename: also a double-click on the title, so it has a second way in.
 * - Link: a deliberate, occasional gesture.
 * - Grow / Shrink: fine-grained sizing; the resize edges do the same job.
 */
export const HEADER_ACTION_PRIORITY: readonly HeaderActionId[] = [
  'ai',
  'expand',
  'remove',
  'pin',
  'rename',
  'link',
  'grow',
  'shrink'
]

/** Where each tool sits in the row, left to right, whatever is folded. */
export const HEADER_ACTION_ORDER: readonly HeaderActionId[] = [
  'ai',
  'rename',
  'link',
  'pin',
  'shrink',
  'grow',
  'expand',
  'remove'
]

/** A header tool is an h-6 w-6 button. */
export const HEADER_BUTTON_PX = 24
/** The row's gap-0.5. */
export const HEADER_GAP_PX = 2
/** The least header a person can always grab the widget by. */
export const HEADER_MIN_GRAB_PX = 40
/** The least room the title keeps (it truncates with an ellipsis below its natural width). */
export const HEADER_MIN_TITLE_PX = 48

/** Width of a row of `n` header buttons. */
export function rowWidth(n: number): number {
  return n <= 0 ? 0 : n * HEADER_BUTTON_PX + (n - 1) * HEADER_GAP_PX
}

/**
 * How many pixels the action row may take.
 *
 * `headerInner` is the header's content box (padding excluded); `fixedLeft` is
 * everything in the title cluster that is not the title text (the kind chip,
 * the bell, the pin mark…), which never shrinks. What is left after the
 * minimum title and the minimum grab area is the action row's budget.
 */
export function headerActionBudget(headerInner: number, fixedLeft: number): number {
  return Math.max(0, Math.floor(headerInner - fixedLeft - HEADER_MIN_TITLE_PX - HEADER_MIN_GRAB_PX))
}

export interface HeaderFold {
  /** Shown on the header, in row order. */
  visible: HeaderActionId[]
  /** In the "…" menu, in row order. Empty when everything fits (no "…" then). */
  overflow: HeaderActionId[]
}

/**
 * Split the tools present on this widget into header buttons and overflow.
 *
 * `budget` null means the header has not been measured (first paint, or a
 * detached node): show everything, as the row always did. When every present
 * tool fits, nothing folds and there is no "…". Otherwise the "…" button takes
 * its own slot from the budget and the highest-priority tools fill the rest; a
 * budget too small even for "…" still gets "…", so no tool ever becomes
 * unreachable.
 */
export function foldHeaderActions(present: readonly HeaderActionId[], budget: number | null): HeaderFold {
  const inRowOrder = (ids: Iterable<HeaderActionId>): HeaderActionId[] => {
    const set = new Set(ids)
    return HEADER_ACTION_ORDER.filter((id) => set.has(id))
  }
  const all = inRowOrder(present)
  if (budget === null || rowWidth(all.length) <= budget) return { visible: all, overflow: [] }
  const byPriority = HEADER_ACTION_PRIORITY.filter((id) => all.includes(id))
  let keep = 0
  // k visible buttons plus the "…" button.
  while (keep < byPriority.length && rowWidth(keep + 2) <= budget) keep++
  const visible = inRowOrder(byPriority.slice(0, keep))
  const overflow = inRowOrder(byPriority.slice(keep))
  return { visible, overflow }
}

export interface ModifierState {
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

export interface ModifierContext {
  /** Desk zoom; ⌘/Ctrl-click dives only when zoomed out below 80%. */
  zoom: number
  /** Section children never join a desk selection and never dive. */
  isChildOfSection: boolean
  /** Screen-pinned widgets never join a desk selection. */
  isPinned: boolean
}

export interface ModifierClick {
  /** 'select' and 'dive' are the desk's own meanings; 'plain' is an ordinary click. */
  kind: 'plain' | 'select' | 'dive'
  /** Toggle this widget in the desk selection. */
  toggleSelection: boolean
  /** Zoom to this widget (⌘/Ctrl-click while zoomed out). */
  dive: boolean
  /** Run the clicked header button's own action. Only a plain click does. */
  runAction: boolean
}

/**
 * What a click with these modifiers means on a work widget.
 *
 * Shift is the selection gesture on the desk: on a widget that can join the
 * selection it toggles it and the clicked control does NOT run. A pinned
 * widget or a section child cannot join the selection, so there shift has no
 * desk meaning and the click is plain (WidgetFrame's rule since 55ea2b30).
 * ⌘/Ctrl dives into the widget only when zoomed out below 80%, matching the
 * frame; at ordinary zoom it has no desk meaning and the click is plain. Alt
 * has no desk meaning on a widget, so it is plain too.
 */
export function resolveModifierClick(mods: ModifierState, ctx: ModifierContext): ModifierClick {
  if (mods.shiftKey && !ctx.isChildOfSection && !ctx.isPinned) {
    return { kind: 'select', toggleSelection: true, dive: false, runAction: false }
  }
  if ((mods.metaKey || mods.ctrlKey) && ctx.zoom < 0.8 && !ctx.isChildOfSection) {
    return { kind: 'dive', toggleSelection: false, dive: true, runAction: false }
  }
  return { kind: 'plain', toggleSelection: false, dive: false, runAction: true }
}

/** The parts of a click event the capture handler reads and acts on. */
export interface SwallowableClick extends ModifierState {
  preventDefault(): void
  stopPropagation(): void
}

/**
 * WidgetFrame's click CAPTURE handler: stop a modifier click that already did
 * its desk job on mousedown (select, or dive), so the control it landed on —
 * a header button, a "…" menu item, a picker option — never runs its action.
 * A plain click passes through untouched. Returns true when it stopped one.
 */
export function swallowModifierClick(e: SwallowableClick, ctx: ModifierContext): boolean {
  if (resolveModifierClick(e, ctx).runAction) return false
  e.stopPropagation()
  e.preventDefault()
  return true
}
