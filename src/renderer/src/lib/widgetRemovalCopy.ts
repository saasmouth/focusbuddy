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
