// Remove from this desk, or delete the work widget — docs/widget-files.md,
// "Remove or delete".
//
// A work widget is a file; a desk is where it is placed. So the × (the frame
// header, the dock chip, the context menu's Delete) asks which of the two the
// person means instead of guessing:
//
//   Remove from this desk  this desk's instance only, undoable as before; the
//                          file stays in Files and on any other desk.
//   Delete work widget     the file goes to Trash with every instance on every
//                          desk; restoring it from Trash puts them back.
//
// A desk-only kind has no file, so it keeps the single confirm. So does a
// widget whose file is not here (an instance on a desk shared with you, or a
// file still syncing): there is nothing this device could delete beyond it.

import type { Widget } from '@shared/types'
import { isWidgetFilePaneId, widgetFileIdFromGroup } from '@shared/widgetFiles'
import { confirmDialog, promptChoice } from '../components/plexi/PromptDialog'
import { useWidgetStore } from '../stores/widgets'
import { useWidgetFilesStore } from '../stores/widgetFiles'
import { widgetDisplayName } from './widgetDisplayName'
import { DELETE_HINT, otherDeskCount, removeHint, trashFileBody } from './widgetRemovalCopy'

export { DELETE_HINT, otherDeskCount, removeHint, trashFileBody }

function nameOf(w: Widget): string {
  return (w.title || '').trim() || widgetDisplayName(w)
}

/**
 * The file a desk widget is an instance of, when that file exists here and is
 * live. Null for a plain desk row and for an instance whose file this device
 * does not have.
 */
async function liveFileOf(w: Widget): Promise<{ id: string; title: string } | null> {
  // Read the link from main, not the store: the launch backfill (or another
  // device) may have filed this widget since the desk was loaded.
  let group = w.syncGroupId
  try {
    group = (await window.api.widgets.get(w.id))?.syncGroupId ?? group
  } catch {
    /* keep the store's */
  }
  const fileId = widgetFileIdFromGroup(group)
  if (!fileId) return null
  try {
    const f = await window.api.widgetFiles.get(fileId)
    return f && !f.trashed ? { id: f.id, title: f.title } : null
  } catch {
    return null
  }
}

/**
 * The × on a desk widget. Resolves with what happened, or null when the person
 * cancelled. Every surface that removes ONE widget goes through here.
 */
export async function removeWorkWidget(widget: Widget): Promise<'removed' | 'deleted' | null> {
  // The full-pane view's widget IS the file.
  if (isWidgetFilePaneId(widget.id)) {
    const fileId = widgetFileIdFromGroup(widget.id)
    return fileId && (await confirmTrashWidgetFile(fileId)) ? 'deleted' : null
  }
  const file = await liveFileOf(widget)
  if (!file) {
    const ok = await confirmDialog({ title: 'Delete this work widget?', confirmLabel: 'Delete', danger: true })
    if (!ok) return null
    await useWidgetStore.getState().remove(widget.id)
    return 'removed'
  }
  let others = 0
  try {
    others = otherDeskCount(await window.api.widgetFiles.instances(file.id), widget.taskId)
  } catch {
    others = 0
  }
  const choice = await promptChoice({
    title: `Remove or delete “${file.title || nameOf(widget)}”?`,
    choices: [
      { value: 'remove', label: 'Remove from this desk', hint: removeHint(others) },
      { value: 'delete', label: 'Delete work widget', hint: DELETE_HINT, danger: true }
    ]
  })
  if (choice === 'remove') {
    await useWidgetStore.getState().remove(widget.id)
    return 'removed'
  }
  if (choice === 'delete') {
    return (await useWidgetFilesStore.getState().trash(file.id)) ? 'deleted' : null
  }
  return null
}

/**
 * Several selected widgets at once (the context menu's "Delete N work
 * widgets"). Same two meanings, asked once for the lot.
 */
export async function removeWorkWidgets(ws: Widget[]): Promise<'removed' | 'deleted' | null> {
  if (ws.length === 1) return removeWorkWidget(ws[0])
  const liveFiles = new Set<string>()
  for (const w of ws) {
    const f = await liveFileOf(w)
    if (f) liveFiles.add(f.id)
  }
  const fileIds = [...liveFiles]
  const store = useWidgetStore.getState()
  if (fileIds.length === 0) {
    const ok = await confirmDialog({
      title: `Delete these ${ws.length} work widgets?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return null
    for (const w of ws) await store.remove(w.id)
    return 'removed'
  }
  const choice = await promptChoice({
    title: `Remove or delete ${ws.length} work widgets?`,
    choices: [
      { value: 'remove', label: 'Remove from this desk', hint: 'They stay in Files and on any other desk.' },
      {
        value: 'delete',
        label: `Delete ${ws.length} work widgets`,
        hint: 'Removes them from every desk and from Files. You can restore them from Trash.',
        danger: true
      }
    ]
  })
  if (choice === 'remove') {
    for (const w of ws) await store.remove(w.id)
    return 'removed'
  }
  if (choice === 'delete') {
    for (const id of fileIds) await useWidgetFilesStore.getState().trash(id)
    // A desk-only one in the selection has no file: it is simply removed.
    for (const w of ws) {
      const fid = widgetFileIdFromGroup(w.syncGroupId)
      if (!fid || !liveFiles.has(fid)) await store.remove(w.id)
    }
    return 'deleted'
  }
  return null
}

/**
 * "Move to Trash" on the file itself (the full-pane header, Files). Deleting a
 * file takes its desk instances with it, so when it is placed anywhere the
 * person is told so before it happens.
 */
export async function confirmTrashWidgetFile(fileId: string): Promise<boolean> {
  let desks = 0
  let title = ''
  try {
    const [instances, file] = await Promise.all([window.api.widgetFiles.instances(fileId), window.api.widgetFiles.get(fileId)])
    desks = new Set(instances.map((i) => i.taskId)).size
    title = file?.title ?? ''
  } catch {
    desks = 0
  }
  if (desks > 0) {
    const ok = await confirmDialog({
      title: `Delete “${title || 'this work widget'}”?`,
      body: trashFileBody(desks),
      confirmLabel: 'Delete work widget',
      danger: true
    })
    if (!ok) return false
  }
  return useWidgetFilesStore.getState().trash(fileId)
}
