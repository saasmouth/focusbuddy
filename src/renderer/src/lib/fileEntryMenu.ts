// The Files right-click menus, built once for both places Files shows up
// (AUDIT M-n, F-14): the full Files view and the Files flyout / float. Before
// this each drew its own list and they drifted (the flyout had no Share or
// Reveal, the full view no Add to this desk, and both called the soft delete
// "Delete"). Now both ask this module, so the same entry says the same thing
// in both; the only rows that differ are the ones that only make sense in one
// place, named in `surface`:
//   flyout only:  Show in full Files (it opens the full view) and, with a desk
//                 open, Add to this desk (the flyout's own ⌘↩).
//
// Groups (SPEC §9.3), split by separators:
//   entry:  Open · [Add to this desk] · [Show in full Files] · Rename · kind rows
//           (Export… / Reveal in Finder / Collaborate live) | Share… · Share with
//           team or group… | Move to Trash  (or Remove from folder, for a
//           document filed here: the document itself is untouched)
//   empty area: New folder · Add files… · Import folder… · Add document… | Select all
//
// Files has no clipboard of its own (no cut, copy, paste or duplicate of an
// entry), so the clipboard group is absent rather than offered and dead.
// "Move to Trash" is the soft delete with undo (main/db/files.ts deleteEntry):
// a folder goes with its contents and comes back with them.

import type { FileEntry } from '@shared/fields'
import type { CtxMenuItem } from '../components/CanvasContextMenu'
import { MENU } from '@shared/menus/lexicon'
import { isWidgetFileEntry } from './fileEntryType'

export type FilesSurface = 'view' | 'flyout'

// TODO(§9 lexicon): move to MENU.removeFromFolder (removeFromLabel has no 'folder' container yet).
export const REMOVE_FROM_FOLDER_LABEL = 'Remove from folder'

export const FILES_MENU_LABELS = {
  showInFiles: 'Show in full Files',
  export: 'Export…',
  collaborateLive: 'Collaborate live',
  shareWithTeam: 'Share with team or group…',
  newFolder: 'New folder',
  addFiles: 'Add files…',
  importFolder: 'Import folder…',
  addDocument: 'Add document…'
} as const

/** The OS file manager's own words for showing a file in it (shell.showItemInFolder does the work). */
export function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in File Explorer'
  return 'Show in folder'
}

export interface FileEntryMenuCaps {
  /** Signed in (Collaborate live uploads the folder to the server). */
  signedIn: boolean
  /** A team org to share into exists and this is the personal Drive. */
  canShareWithTeam: boolean
  /** Flyout with a desk open: how many entries "Add to this desk" places (the selection when the entry is in it). */
  addToDeskCount?: number
  platform: string
}

export interface FileEntryMenuActions {
  open: () => void
  rename: () => void
  addToDesk?: () => void
  showInFiles?: () => void
  exportWidgetFile: (docId: string) => void
  reveal: () => void
  collaborateLive: () => void
  share: () => void
  shareWithTeam: () => void
  /** The soft delete (a widget file asks first when it sits on a desk). */
  moveToTrash: () => void
  /** Take a filed document's pointer out of this folder. */
  removeFromFolder: () => void
}

/** The menu for one Files entry. */
export function fileEntryMenu(entry: FileEntry, surface: FilesSurface, caps: FileEntryMenuCaps, act: FileEntryMenuActions): CtxMenuItem[] {
  const object: CtxMenuItem[] = [{ label: MENU.open.label, icon: 'open_in_new', testid: 'files-menu-open', onClick: act.open }]
  if (surface === 'flyout' && caps.addToDeskCount && act.addToDesk) {
    const n = caps.addToDeskCount
    object.push({
      label: n > 1 ? `Add ${n} items to this desk` : MENU.addToThisDesk.label,
      icon: 'add_to_queue',
      // ⌘↩ does this in the flyout's list, but MENU.addToThisDesk carries no
      // key (it is bound only here), so no hint until it does (asked of d8).
      testid: 'files-menu-add-to-desk',
      onClick: act.addToDesk
    })
  }
  if (surface === 'flyout' && act.showInFiles) object.push({ label: FILES_MENU_LABELS.showInFiles, icon: 'open_in_full', testid: 'files-menu-show', onClick: act.showInFiles })
  object.push({ label: MENU.rename.label, icon: 'edit', testid: 'files-menu-rename', onClick: act.rename })

  const share: CtxMenuItem[] = []
  const widgetFile = isWidgetFileEntry(entry) && entry.docId ? entry.docId : null
  if (widgetFile) {
    // A work widget file is its own thing, not a pointer to an office document:
    // it exports as its .plexii-* type and goes to the Trash, file and all.
    object.push({ label: FILES_MENU_LABELS.export, icon: 'ios_share', testid: 'files-menu-export', onClick: () => act.exportWidgetFile(widgetFile) })
  } else {
    if (entry.kind === 'file') object.push({ label: revealLabel(caps.platform), icon: 'folder_open', testid: 'files-menu-reveal', onClick: act.reveal })
    // Promote a whole folder to a live, checked-out shared folder.
    if (entry.kind === 'folder' && caps.signedIn) object.push({ label: FILES_MENU_LABELS.collaborateLive, icon: 'group', testid: 'files-menu-live', onClick: act.collaborateLive })
    // The share dialog: a folder shares its documents, a filed document as
    // itself, a raw file with its bytes (a document needs its docId).
    if (entry.kind !== 'doc' || entry.docId) share.push({ label: MENU.share.label, icon: 'link', testid: 'files-menu-share', onClick: act.share })
    // Moving it into a team org; a filed document syncs as its own document, so not for doc pointers.
    if (caps.canShareWithTeam && entry.kind !== 'doc') share.push({ label: FILES_MENU_LABELS.shareWithTeam, icon: 'group_add', testid: 'files-menu-share-team', onClick: act.shareWithTeam })
  }

  const destructive: CtxMenuItem =
    entry.kind === 'doc' && !widgetFile
      ? { label: REMOVE_FROM_FOLDER_LABEL, icon: 'folder_off', danger: true, testid: 'files-menu-remove', onClick: act.removeFromFolder }
      : { label: MENU.moveToTrash.label, icon: 'delete', danger: true, testid: 'files-menu-trash', onClick: act.moveToTrash }

  return joinGroups([object, share, [destructive]])
}

export interface FilesAreaMenuActions {
  newFolder: () => void
  addFiles: () => void
  importFolder?: () => void
  addDocument?: () => void
  /** Absent when there is nothing to select. */
  selectAll?: () => void
}

/** The menu on the empty part of a Files listing (SPEC §9.3, the empty shape: create here | Select all). */
export function filesAreaMenu(act: FilesAreaMenuActions): CtxMenuItem[] {
  const create: CtxMenuItem[] = [
    { label: FILES_MENU_LABELS.newFolder, icon: 'create_new_folder', testid: 'files-menu-new-folder', onClick: act.newFolder },
    { label: FILES_MENU_LABELS.addFiles, icon: 'upload_file', testid: 'files-menu-add-files', onClick: act.addFiles }
  ]
  if (act.importFolder) create.push({ label: FILES_MENU_LABELS.importFolder, icon: 'drive_folder_upload', testid: 'files-menu-import-folder', onClick: act.importFolder })
  if (act.addDocument) create.push({ label: FILES_MENU_LABELS.addDocument, icon: 'post_add', testid: 'files-menu-add-doc', onClick: act.addDocument })
  // No key selects every entry in Files, so no hint (SPEC §9.4).
  const select: CtxMenuItem[] = act.selectAll ? [{ label: MENU.selectAll.label, icon: 'select_all', testid: 'files-menu-select-all', onClick: act.selectAll }] : []
  return joinGroups([create, select])
}

function joinGroups(groups: CtxMenuItem[][]): CtxMenuItem[] {
  const out: CtxMenuItem[] = []
  for (const g of groups) {
    if (!g.length) continue
    if (out.length) out.push({ separator: true })
    out.push(...g)
  }
  return out
}

/**
 * A right-click inside a text field (an entry's rename box) belongs to the
 * field: the app's native text menu (Cut, Copy, Paste…) answers it, so the
 * Files handlers leave it alone (and do not preventDefault).
 */
export function isTextFieldTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('input, textarea, [contenteditable=""], [contenteditable="true"]')
}
