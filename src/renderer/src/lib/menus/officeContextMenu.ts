import type { CtxMenuItem } from '../../components/CanvasContextMenu'
import { MENU, type MenuAction, type MenuActionId } from '@shared/menus/lexicon'
import { menuAction } from './menuAction'

// The two kit right-click shapes of SPEC §9.3, built once so every office app
// lays them out the same way: the same groups in the same order, the same
// labels, icons and hints as the menu bar. An app passes only the actions it
// really has; a group with nothing in it is left out, and so is its separator.
// (Text is the third shape, and it is native: editableField.ts, via main.)

type Act = () => void

/** A shared action as a right-click row: the lexicon's label and hint, the kit's icon. */
export function sharedRow(id: MenuActionId, onClick: Act, extra: Partial<CtxMenuItem> = {}): CtxMenuItem {
  const a = menuAction(id)
  // The icon is the lexicon's (§9.3), so this row and the menu bar's look alike.
  return { label: a.label, shortcut: a.shortcut, icon: (MENU[id] as MenuAction).icon, onClick, testid: `ctx-${id}`, ...extra }
}

const NOTHING_TO_PASTE = 'Nothing to paste'

/** Non-empty groups joined by single separators. */
export function joinGroups(groups: CtxMenuItem[][]): CtxMenuItem[] {
  const out: CtxMenuItem[] = []
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ separator: true })
    out.push(...g)
  }
  return out
}

export interface ObjectMenuSpec {
  /** 1. What can be done to this object (Edit text, Route ▸…). */
  object?: CtxMenuItem[]
  /** 2. Clipboard. Paste shows disabled with a reason when there is nothing to paste. */
  cut?: Act
  copy?: Act
  paste?: Act
  canPaste?: boolean
  duplicate?: Act
  /** 3. Arrange, for layered objects. */
  bringToFront?: Act
  sendToBack?: Act
  group?: Act
  ungroup?: Act
  /** 4. Plexii. */
  saveAsSnippet?: Act
  askAssist?: Act
  /** 5. Everything else, behind More actions ▸. */
  more?: CtxMenuItem[]
  /** 6. Delete (⌫), in the danger colour, last. */
  del?: Act
}

/** Right-click on an object: a shape, an element, a node, a cell (SPEC §9.3). */
export function objectMenu(s: ObjectMenuSpec): CtxMenuItem[] {
  const opt = (id: MenuActionId, f?: Act, extra?: Partial<CtxMenuItem>): CtxMenuItem[] => (f ? [sharedRow(id, f, extra)] : [])
  return joinGroups([
    s.object ?? [],
    [
      ...opt('cut', s.cut),
      ...opt('copy', s.copy),
      ...opt('paste', s.paste, s.canPaste === false ? { disabled: true, hint: NOTHING_TO_PASTE } : {}),
      ...opt('duplicate', s.duplicate)
    ],
    [...opt('bringToFront', s.bringToFront), ...opt('sendToBack', s.sendToBack), ...opt('group', s.group), ...opt('ungroup', s.ungroup)],
    [...opt('saveAsSnippet', s.saveAsSnippet), ...opt('askAssistAboutThis', s.askAssist)],
    s.more?.length ? [{ label: menuAction('moreActions').label, icon: 'more_horiz', children: s.more, testid: 'ctx-moreActions' }] : [],
    opt('delete', s.del, { danger: true })
  ])
}

export interface CanvasMenuSpec {
  paste?: Act
  canPaste?: boolean
  insertSnippet?: Act
  /** Create here: Add text here, Add a box here… */
  create?: CtxMenuItem[]
  selectAll?: Act
  /** View: Fit, Zoom to selection… */
  view?: CtxMenuItem[]
}

/** Right-click on empty canvas or page (SPEC §9.3). */
export function canvasMenu(s: CanvasMenuSpec): CtxMenuItem[] {
  return joinGroups([
    [
      ...(s.paste ? [sharedRow('paste', s.paste, s.canPaste === false ? { disabled: true, hint: NOTHING_TO_PASTE } : {})] : []),
      ...(s.insertSnippet ? [sharedRow('insertSnippet', s.insertSnippet)] : [])
    ],
    s.create ?? [],
    s.selectAll ? [sharedRow('selectAll', s.selectAll)] : [],
    s.view ?? []
  ])
}
