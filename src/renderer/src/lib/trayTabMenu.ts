import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { objectMenu } from './objectMenu'
import { MENU } from '@shared/menus/lexicon'

// The open tray's tab menu (SPEC §9.3 on the context-menu kit). It used to be
// its own popover: no roles, no arrow keys, no Escape, and it closed when the
// pointer left it, so a keyboard could not use it at all (AUDIT §3f).
//
// Wording is the browser's (E-9): "Pin tab", "Close other tabs", "Close all
// tabs". Closing only takes the tab out of the strip — nothing is deleted —
// but it is still the placement-removing group, so it sits last behind its
// own separator like every other "Remove from ‹container›".

export const TRAY_LABELS = {
  pinTab: MENU.pinTab.label,
  unpinTab: MENU.unpinTab.label,
  sendToDesk: 'Send to desk',
  closeTab: MENU.closeTab.label,
  closeOtherTabs: MENU.closeOtherTabs.label,
  closeAllTabs: MENU.closeAllTabs.label
} as const

export interface TrayTabMenuInput {
  /** The entry key, for test ids (`tray-menu-<key>-…`). */
  entryKey: string
  pinned: boolean
  onTogglePin: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  /** Documents only: the desks it can be filed onto. Absent for anything else. */
  sendTo?: { desks: Array<{ id: string; title: string }>; send: (deskId: string) => void }
  /** Other tabs exist to close (Close other tabs applies but not right now otherwise). */
  hasOthers: boolean
}

export function trayTabMenuItems(m: TrayTabMenuInput): CtxMenuItem[] {
  const id = (k: string): string => `tray-menu-${m.entryKey}-${k}`
  const object: CtxMenuItem[] = [
    { label: m.pinned ? TRAY_LABELS.unpinTab : TRAY_LABELS.pinTab, icon: 'push_pin', testid: id('pin'), onClick: m.onTogglePin }
  ]
  if (m.sendTo) {
    object.push(
      m.sendTo.desks.length
        ? {
            label: TRAY_LABELS.sendToDesk,
            icon: 'desk',
            testid: `tray-send-${m.entryKey}`,
            children: m.sendTo.desks.map((d) => ({
              label: d.title || 'Untitled desk',
              icon: 'desk',
              testid: `tray-send-${m.entryKey}-${d.id}`,
              onClick: () => m.sendTo?.send(d.id)
            }))
          }
        : { label: TRAY_LABELS.sendToDesk, icon: 'desk', testid: `tray-send-${m.entryKey}`, disabled: true, hint: 'No desks to send it to yet' }
    )
  }
  return objectMenu({
    object,
    destructive: [
      { label: TRAY_LABELS.closeTab, icon: 'close', testid: id('close'), onClick: m.onClose },
      m.hasOthers
        ? { label: TRAY_LABELS.closeOtherTabs, icon: 'tab_close', testid: id('close-others'), onClick: m.onCloseOthers }
        : { label: TRAY_LABELS.closeOtherTabs, icon: 'tab_close', testid: id('close-others'), disabled: true, hint: 'No other unpinned tabs to close' },
      { label: TRAY_LABELS.closeAllTabs, icon: 'clear_all', testid: id('close-all'), onClick: m.onCloseAll }
    ]
  })
}
