import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { objectMenu } from './objectMenu'

// Right-click on a Focus row (SPEC §9.3): the Focus page's queue rows and the
// Attention work widget's rows. Silent until now (AUDIT §1.3). Every row here
// is a door the row already has as a hover or chip button — nothing is added
// for the menu — so a keyboard or a right-click reaches what a hover did.
//
// Order: Open (the item's own editor), its desk and its source, then the
// queue verbs (Snooze, Assign…, Detach); Copy; Ask PlexiiAssist (the "Start it
// with Plexii" door: a chat prefilled from this item, never sent); and Archive
// last. A work item has no hard delete (R008), so Archive is its whole
// destructive group.

export interface FocusRowActions {
  /** The item's editor ("Open the task"). */
  open: () => void
  /** The desk it lives on. */
  openDesk?: () => void
  /** The source door: a meeting moment, the message, or the web page it was marked on. */
  openSource?: { label: string; run: () => void }
  snooze?: () => void
  /** Team workspaces: choose who it is for (opens the editor). */
  assign?: () => void
  /** A subtask: take it out of its group. */
  detach?: () => void
  /** A detached item (its desk was deleted): pick a new desk. */
  moveToDesk?: () => void
  /** Title and notes, verbatim. */
  copy?: () => void
  askAssist?: () => void
  archive?: () => void
}

/** The source door's label, by what kind of place it opens. */
export function focusSourceLabel(kind: 'meeting' | 'message' | 'page'): string {
  return kind === 'meeting' ? 'Open meeting moment' : kind === 'message' ? 'Open message' : 'Open source page'
}

export function focusRowMenuItems(a: FocusRowActions): CtxMenuItem[] {
  const id = (k: string): string => `focus-menu-${k}`
  const object: CtxMenuItem[] = [{ label: MENU.open.label, icon: 'open_in_new', testid: id('open'), onClick: a.open }]
  if (a.openDesk) object.push({ label: 'Open desk', icon: 'desk', testid: id('desk'), onClick: a.openDesk })
  if (a.openSource) object.push({ label: a.openSource.label, icon: 'link', testid: id('source'), onClick: a.openSource.run })
  if (a.moveToDesk) object.push({ label: 'Move to a desk…', icon: 'drive_file_move', testid: id('move'), onClick: a.moveToDesk })
  if (a.snooze) object.push({ label: 'Snooze until tomorrow', icon: 'snooze', testid: id('snooze'), onClick: a.snooze })
  if (a.assign) object.push({ label: 'Assign…', icon: 'person_add', testid: id('assign'), onClick: a.assign })
  if (a.detach) object.push({ label: 'Detach from its group', icon: 'link_off', testid: id('detach'), onClick: a.detach })
  return objectMenu({
    object,
    clipboard: a.copy ? [{ label: MENU.copy.label, icon: 'content_copy', testid: id('copy'), onClick: a.copy }] : [],
    plexii: a.askAssist ? [{ label: MENU.askAssist.label, icon: 'auto_awesome', testid: id('ask'), onClick: a.askAssist }] : [],
    destructive: a.archive ? [{ label: MENU.archive.label, icon: 'archive', testid: id('archive'), onClick: a.archive }] : []
  })
}
