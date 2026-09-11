// Is this window someone's 48-hour copy of a shared desk?
//
// A recipient's edits must never travel back to the sender. That is already true
// by accident — they have no account, and the sync loop only starts for one —
// but "no credential, so the request would fail" is a weaker promise than the
// product makes. Somebody adds an anonymous fallback one day and the guarantee
// quietly becomes false.
//
// So share mode is stated, and the sync paths consult it directly. The flag is
// set by the cloud entry before the renderer is imported, and it is read rather
// than passed because the modules that must honour it are deep in the renderer
// and have no business taking a parameter for it.
const KEY = 'fb.share.recipient'

/** Mark this window a share recipient. Never unset for the life of the tab. */
export function markShareRecipient(token: string): void {
  try {
    sessionStorage.setItem(KEY, token)
  } catch {
    /* private mode; the in-memory fallback below still holds */
  }
  memo = token
}

let memo: string | null = null

/** The share token this window is showing, or null for an ordinary window. */
export function shareRecipientToken(): string | null {
  if (memo) return memo
  try {
    memo = sessionStorage.getItem(KEY)
  } catch {
    memo = null
  }
  return memo
}

export function isShareRecipient(): boolean {
  return shareRecipientToken() !== null
}
