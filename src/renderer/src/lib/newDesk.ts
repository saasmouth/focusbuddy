// One door for "new desk", wherever it is clicked.
//
// There were two different behaviours. The sidebar's New desk button opened the
// set-up dialog — name it, pick the Room to file it in, date pre-filled. But
// the Desks index, the Home create chip and the suite launcher each called
// nodes.create() directly with the literal title "New desk" and navigated
// straight there, so the same words did two different things depending on where
// you clicked, and three of the four entry points gave you an untitled desk
// filed nowhere.
//
// The sidebar already listened for `fb:command-new-task` (DeskGallery used it),
// and the listener already honoured a parentId, so this is that path made
// canonical rather than a new mechanism.
//
// The event is CANCELABLE and the sidebar's handler calls preventDefault().
// That is how a caller can tell whether a set-up dialog actually exists on the
// current surface: if nothing claimed the event there is no sidebar mounted, and
// a silent no-op would be a dead button — worse than the direct create this
// replaces. So `requestNewDesk` reports whether it was handled and the caller
// falls back.

/**
 * Ask for the new-desk set-up dialog, optionally pre-filing into a Room.
 *
 * @returns true if a surface opened the dialog; false if nothing handled it,
 *          in which case the caller should create the desk directly.
 */
export function requestNewDesk(parentId: string | null = null): boolean {
  const ev = new CustomEvent('fb:command-new-task', {
    detail: { parentId, kind: 'task' },
    cancelable: true
  })
  window.dispatchEvent(ev)
  return ev.defaultPrevented
}
