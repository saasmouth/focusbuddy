import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { objectMenu } from './objectMenu'

// Right-click on the side menu's rows and tiles (SPEC §9.3). These were
// silent (AUDIT §1.3): Home, Focus, Rooms, All desks, Trash and the other
// place rows, the People and PlexiiBrain rows, the app and tool tiles without a
// widget, and every connected app. A row is a place, so what it can do is what
// a click already does — Open — plus, for an app tile that has a work widget
// to become, Add to this desk. Nothing here is invented for the menu.

/** A place row or a connected-app tile: the one thing it does. */
export function navRowMenuItems(open: () => void): CtxMenuItem[] {
  return objectMenu({ object: [{ label: MENU.open.label, icon: 'chevron_right', testid: 'nav-menu-open', onClick: open }] })
}

export interface AppTileMenuInput {
  /** The tile's click. Files has three places to open instead (`files`). */
  open?: () => void
  files?: { beside: () => void; floating: () => void; fullScreen: () => void }
  /** The tile has a work widget to become: the no-drag twin of dragging it onto the desk. */
  addToDesk?: { deskOpen: boolean; add: () => void }
}

export function appTileMenuItems(m: AppTileMenuInput): CtxMenuItem[] {
  const object: CtxMenuItem[] = []
  if (m.files) {
    object.push(
      { label: 'Open beside', icon: 'dock_to_right', testid: 'files-open-beside', onClick: m.files.beside },
      { label: 'Open floating', icon: 'picture_in_picture_alt', testid: 'files-open-floating', onClick: m.files.floating },
      { label: 'Open full screen', icon: 'open_in_full', testid: 'files-open-fullscreen', onClick: m.files.fullScreen }
    )
  } else if (m.open) {
    object.push({ label: MENU.open.label, icon: 'chevron_right', testid: 'nav-menu-open', onClick: m.open })
  }
  if (m.addToDesk) {
    object.push(
      m.addToDesk.deskOpen
        ? { label: MENU.addToThisDesk.label, icon: 'add_to_queue', testid: 'ctx-add-to-this-desk', onClick: m.addToDesk.add }
        : { label: MENU.addToThisDesk.label, icon: 'add_to_queue', testid: 'ctx-add-to-this-desk', disabled: true, hint: 'Open a desk first' }
    )
  }
  return objectMenu({ object })
}
