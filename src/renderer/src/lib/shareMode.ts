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
import { readPresentation, type SharePresentation } from '@shared/sitePresentation'

const KEY = 'fb.share.recipient'
const DESK_KEY = 'fb.share.desk'

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

/**
 * Which desk this window was sent.
 *
 * The recipient's workspace holds exactly one, but the app still opens on its
 * home view by default -- so without this a share link loaded Plexii and left
 * the visitor looking at an empty dashboard, wondering where the desk was.
 */
let deskMemo: string | null = null

export function setShareDeskId(deskId: string): void {
  try {
    sessionStorage.setItem(DESK_KEY, deskId)
  } catch {
    /* private mode; the in-memory value still serves this tab */
  }
  deskMemo = deskId
}

export function shareDeskId(): string | null {
  if (deskMemo) return deskMemo
  try {
    deskMemo = sessionStorage.getItem(DESK_KEY)
  } catch {
    deskMemo = null
  }
  return deskMemo
}

/**
 * Which desk a share window should open.
 *
 * The bundle names one, but a recipient's workspace is built from that bundle
 * alone, so falling back to the only desk in it is both safe and the right
 * answer when the id is missing — a link minted before the id travelled, or a
 * browser that refused sessionStorage.
 *
 * Returns null while the nodes are still loading, which the caller must treat
 * as "not yet" rather than "nothing": navigating to a desk the store has not
 * seen shows an empty canvas.
 */
export function deskToOpen(
  nodes: ReadonlyArray<{ id: string; kind: string; archived?: boolean | null }>,
  wantedId: string | null
): string | null {
  if (wantedId) {
    const exact = nodes.find((n) => n.id === wantedId)
    if (exact) return exact.id
  }
  const desks = nodes.filter((n) => n.kind === 'task' && !n.archived)
  return desks.length > 0 ? desks[0].id : null
}

// ── How the sender presented the desk ────────────────────────────────────────
//
// The view the link opens in (and whether it is the only one), and what each
// website on it shows -- see shared/sitePresentation.ts. The share page puts it
// here from the link's record before the renderer loads, beside the desk id.
const PRESENTATION_KEY = 'fb.share.presentation'
let presentationMemo: SharePresentation | null | undefined

export function setSharePresentation(p: SharePresentation | null): void {
  presentationMemo = p
  try {
    if (p) sessionStorage.setItem(PRESENTATION_KEY, JSON.stringify(p))
    else sessionStorage.removeItem(PRESENTATION_KEY)
  } catch {
    /* private mode; the in-memory value still serves this tab */
  }
}

/** The sender's presentation, in a share window that has one; null anywhere else. */
export function sharePresentation(): SharePresentation | null {
  if (!isShareRecipient()) return null
  if (presentationMemo !== undefined) return presentationMemo
  try {
    presentationMemo = readPresentation(JSON.parse(sessionStorage.getItem(PRESENTATION_KEY) ?? 'null'), null)
  } catch {
    presentationMemo = null
  }
  return presentationMemo
}
