// "You have started changing this — here is what happens to it."
//
// A share window lets its visitor work on the desk, and their work is deleted
// with the link. Saying so once in the offer card is not enough: by the time
// somebody is typing they have forgotten the card, and finding out afterwards
// is the version that makes people angry. So the window says it again at the
// only moment it is unambiguous — the first change they make.
//
// Once per session, not per edit. A warning that fires on every keystroke is a
// warning nobody reads.
export const SHARE_EDIT_EVENT = 'plexii:share-edited'

let announced = false

/** Called by the API bridge the first time this window changes anything. */
export function noteShareEdit(): void {
  if (announced) return
  announced = true
  try {
    window.dispatchEvent(new CustomEvent(SHARE_EDIT_EVENT))
  } catch {
    /* no window (a test, a worker): the caller carries on regardless */
  }
}

/** Has this window changed anything yet? Read by the bar when it mounts. */
export function hasEditedShare(): boolean {
  return announced
}

/** Test seam: forget that the warning has been shown. */
export function resetShareEditNotice(): void {
  announced = false
}
