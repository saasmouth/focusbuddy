import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'

// The right-click shape of SPEC §9.3, for the menus built outside the office
// apps (desks, rooms, side-menu rows, tray tabs, Home cards, Focus rows).
//
// A builder hands over its rows sorted into the contract's named groups and
// gets back one CtxMenuItem[] with the groups in the contract's order, exactly
// one separator between non-empty groups, the destructive rows last and styled
// as danger, and the eight-item ceiling kept by folding the tail of the object
// group into "More actions ▸" (E-6). Ordering by name instead of by position is
// the point: a surface cannot put Share above Open, or Move to Trash above a
// separator, by accident.

export interface ObjectMenuGroups {
  /** §9.3 group 1: Add to Focus… first (CR-09), Open, Rename, kind rows. */
  object?: CtxMenuItem[]
  /** Group 2: Cut · Copy · Paste · Paste as plain text · Duplicate. */
  clipboard?: CtxMenuItem[]
  /** Group 3: layered objects only. */
  arrange?: CtxMenuItem[]
  /** Group 4: Save selection as snippet… · Ask PlexiiAssist · Add to Focus… (when not in group 1). */
  plexii?: CtxMenuItem[]
  /** Rows that always live under "More actions ▸", whatever the count. */
  more?: CtxMenuItem[]
  /** Group 6: Archive · Remove from ‹container› · Move to Trash. Marked danger here. */
  destructive?: CtxMenuItem[]
}

/** E-6: top-level rows a right-click menu may show before folding. One place, so a ruling is a one-line change. */
export const MENU_CEILING = 8

export function objectMenu(g: ObjectMenuGroups): CtxMenuItem[] {
  let object = [...(g.object ?? [])]
  const more = [...(g.more ?? [])]
  const fixed = (g.clipboard?.length ?? 0) + (g.arrange?.length ?? 0) + (g.plexii?.length ?? 0) + (g.destructive?.length ?? 0)
  // Fold from the END of the object group: Add to Focus… and Open stay put,
  // the rarer kind rows move under More actions ▸.
  const count = (): number => object.length + fixed + (more.length ? 1 : 0)
  while (count() > MENU_CEILING && object.length > 1) {
    more.unshift(object.pop() as CtxMenuItem)
  }
  const groups: CtxMenuItem[][] = [
    object,
    g.clipboard ?? [],
    g.arrange ?? [],
    g.plexii ?? [],
    more.length ? [{ label: MENU.moreActions.label, icon: 'more_horiz', testid: 'ctx-more-actions', children: more }] : [],
    (g.destructive ?? []).map((it) => ({ ...it, danger: true }))
  ]
  const out: CtxMenuItem[] = []
  for (const group of groups) {
    if (!group.length) continue
    if (out.length) out.push({ separator: true })
    out.push(...group)
  }
  return out
}

/**
 * Before opening a menu from a right-click: put focus on the thing clicked (the
 * nearest focusable element, or the first one inside the row), so the kit's
 * focus return lands a keyboard user back on it when the menu closes. A
 * right-click alone does not always move focus, and a row that is a plain div
 * never takes it.
 */
export function focusInvoker(e: { target: EventTarget | null; currentTarget: EventTarget | null }): void {
  const from = e.target instanceof HTMLElement ? e.target : null
  const row = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  const focusable = 'button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
  const el = (from?.closest(focusable) as HTMLElement | null) ?? (row?.matches(focusable) ? row : (row?.querySelector(focusable) as HTMLElement | null))
  el?.focus({ preventScroll: true })
}
