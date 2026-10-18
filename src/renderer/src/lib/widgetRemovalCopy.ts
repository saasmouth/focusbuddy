// The words of the remove-or-delete question (lib/widgetRemoval.ts), kept
// apart from it so they unit-test without a renderer.

import type { Widget } from '@shared/types'

/** How many OTHER desks hold an instance, given the file's live instances. */
export function otherDeskCount(instances: ReadonlyArray<Pick<Widget, 'taskId'>>, thisTaskId: string): number {
  return new Set(instances.map((i) => i.taskId).filter((t) => t && t !== thisTaskId)).size
}

/** "It stays in Files" / "…and on 2 other desks". Pure, for the tests. */
export function removeHint(otherDesks: number): string {
  if (otherDesks <= 0) return 'It stays in Files.'
  return `It stays in Files and on ${otherDesks} other desk${otherDesks === 1 ? '' : 's'}.`
}

export const DELETE_HINT = 'Removes it from every desk and from Files. You can restore it from Trash.'

/** What a full-pane or Files "Move to Trash" says when the file is placed somewhere. */
export function trashFileBody(desks: number): string | undefined {
  if (desks <= 0) return undefined
  return `It is on ${desks} desk${desks === 1 ? '' : 's'} and will be removed from ${desks === 1 ? 'it' : 'them'} too. You can restore it from Trash, which puts it back.`
}

export const MANY_REMOVE_HINT = 'They stay in Files and on any other desk.'
export const MANY_DELETE_HINT = 'Removes them from every desk and from Files. You can restore them from Trash.'

/**
 * What deleting a multi-selection everywhere touches: each distinct live file
 * once (two instances of one file on this desk are one file), and the
 * widgets with no file here (desk-only kinds, an instance whose file is not on
 * this device), which can only be removed from the desk.
 */
export function removalPlan<W extends { id: string }>(
  ws: readonly W[],
  liveFileIdOf: (w: W) => string | null
): { fileIds: string[]; deskOnlyIds: string[] } {
  const fileIds: string[] = []
  const deskOnlyIds: string[] = []
  for (const w of ws) {
    const f = liveFileIdOf(w)
    if (!f) deskOnlyIds.push(w.id)
    else if (!fileIds.includes(f)) fileIds.push(f)
  }
  return { fileIds, deskOnlyIds }
}
