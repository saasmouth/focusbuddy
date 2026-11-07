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
  nodes: ReadonlyArray<{ id: string; kind: string; archived?: boolean | null; parent_id?: string | null; parentId?: string | null }>,
  wantedId: string | null
): string | null {
  const landing = shareLanding(nodes, wantedId)
  return landing?.kind === 'desk' ? landing.id : null
}

type LandingNode = { id: string; kind: string; archived?: boolean | null; parent_id?: string | null; parentId?: string | null }

/**
 * Where a share window lands: a desk, or -- for a link to a ROOM -- that room.
 *
 * A room link's bundle names the room (a 'folder' node) as its root. Opening
 * that id as a desk showed the room as an empty desk ("This desk has no
 * objects yet"), with every desk the sender shared hidden inside it. So a room
 * opens as a room -- its desks as cards -- unless it holds exactly one desk,
 * which opens straight away.
 *
 * Null while the nodes are still loading, which the caller must treat as "not
 * yet": navigating to an id the store has not seen shows nothing.
 */
export function shareLanding(
  nodes: ReadonlyArray<LandingNode>,
  wantedId: string | null
): { kind: 'desk' | 'room'; id: string } | null {
  const parentOf = (n: LandingNode): string | null => n.parentId ?? n.parent_id ?? null
  const desks = nodes.filter((n) => n.kind === 'task' && !n.archived)
  const exact = wantedId ? nodes.find((n) => n.id === wantedId) : undefined
  if (exact && exact.kind === 'task') return { kind: 'desk', id: exact.id }
  if (exact && exact.kind === 'folder') {
    const inside = desks.filter((d) => parentOf(d) === exact.id)
    if (inside.length === 1) return { kind: 'desk', id: inside[0].id }
    return { kind: 'room', id: exact.id }
  }
  // A link that NAMES its desk opens that desk or nothing ("not yet": the
  // caller waits for the nodes to change). This browser can hold desks from
  // several links, so "the first desk here" may be somebody else's: the owner's
  // Lesson Planning link opened a different desk, "Year 2 grant report", from
  // an earlier link (2026-11-07), when Lesson Planning was hidden by the
  // workspace filter (worker/shareCopy adoptVisitorScope). Only a link that
  // names nothing -- minted before the id travelled -- falls back.
  if (wantedId) return null
  return desks.length > 0 ? { kind: 'desk', id: desks[0].id } : null
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
