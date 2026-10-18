// The assistant's delete-widget action — docs/widget-files.md, "Remove or
// delete".
//
// Every standalone work widget is a file that can sit on several desks, so
// "delete" has two meanings, and the proposal says which (`scope`):
//
//   'desk' (the default)  this desk's copy only, exactly the × menu's "Remove
//                         from this desk". The file stays in Files and on any
//                         other desk. Undoable.
//   'everywhere'          the × menu's "Delete work widget": the file goes to
//                         Trash with every copy on every desk, through the same
//                         useWidgetFilesStore.trashMany the × uses, so its
//                         Undo, its undo step and its Trash restore are the
//                         same too.
//
// Both are reached only through applyProposal, and delete-widget is a GATED
// kind (actionExecutor GATED_KINDS): it always waits for the person's Apply.
// This module never reports a deletion it did not make.

import type { ActionProposal, Widget } from '@shared/types'
import { widgetFileIdFromGroup } from '@shared/widgetFiles'
import { useWidgetStore } from '../stores/widgets'
import { useWidgetFilesStore } from '../stores/widgetFiles'

type DeleteP = Extract<ActionProposal, { kind: 'delete-widget' }>

export interface DeleteApplyResult {
  ok: boolean
  message: string
}

/** The widget as main has it (the link may be newer than the store's copy). */
async function deskWidget(id: string): Promise<Widget | null> {
  let row: Widget | null = null
  try {
    row = (await window.api.widgets.get(id)) ?? null
  } catch {
    row = null
  }
  return row ?? useWidgetStore.getState().widgets.find((w) => w.id === id) ?? null
}

/** A file id, when that file exists on this device and is not in Trash. */
async function liveFile(id: string | null): Promise<string | null> {
  if (!id) return null
  try {
    const f = await window.api.widgetFiles.get(id)
    return f && !f.trashed ? f.id : null
  } catch {
    return null
  }
}

/** What a proposal's card says it will do, before it is applied. */
export function deleteWidgetVerb(p: Pick<DeleteP, 'scope'>): string {
  return p.scope === 'everywhere' ? 'Delete everywhere' : 'Remove from this desk'
}

export async function applyDeleteWidget(p: DeleteP): Promise<DeleteApplyResult> {
  const everywhere = p.scope === 'everywhere'
  const widget = await deskWidget(p.widgetId)
  // The widget's file, or, for 'everywhere', a file named directly by its
  // documentId (from the documents list) with no desk copy in hand.
  const fileId = await liveFile(widget ? widgetFileIdFromGroup(widget.syncGroupId) : everywhere ? p.widgetId : null)

  if (!widget && !fileId) {
    return { ok: false, message: `No work widget found with id ${p.widgetId.slice(0, 8)}… — nothing was removed.` }
  }

  if (everywhere && fileId) {
    const n = await useWidgetFilesStore.getState().trashMany([fileId])
    if (n === 0) return { ok: false, message: `Could not delete ${p.label}.` }
    return { ok: true, message: `Deleted ${p.label}: it is in Trash, with its copies on every desk` }
  }

  // Remove from this desk (or a work widget with no file here, for which
  // removing it IS all there is to delete).
  if (!widget) return { ok: false, message: `${p.label} is not on a desk, so there is nothing to remove from one.` }
  await useWidgetStore.getState().remove(widget.id)
  if (fileId) return { ok: true, message: `Removed ${p.label} from this desk — it stays in Files` }
  return {
    ok: true,
    message: everywhere
      ? `Removed ${p.label} — it only lived on this desk, so that deleted it`
      : `Removed ${p.label}`
  }
}
