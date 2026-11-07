// "Download this desk on Plexii" -- the one door out of a shared desk.
//
// Owner, 2026-11-07: a public link opens shared rooms and desks with the whole
// app around them (menus, the side menu, the assistant), but a visitor may only
// look around, arrange the desk and drag apps, widgets, files and tools onto
// it. Anything else -- creating a desk or a room, AI, editing, settings --
// says "Download this desk on Plexii" and starts the download.
//
// Most of that is enforced where every call passes (src/web/api/readOnly.ts,
// at the bridge). This is for the doors that open no call: a settings panel, a
// body-double dialog, a sign-in prompt. The share page listens for the event
// (src/web/boot.tsx) and shows the gate; the desktop never sees it.
import { isShareRecipient } from './shareMode'

export const SHARE_GATE_EVENT = 'plexii:share-gate'

export interface ShareGateDetail {
  /** What the visitor tried, as a phrase: "Creating a desk", "AI". */
  what: string
}

/**
 * In a share window: show the gate for `what` and return true (the caller
 * stops). Anywhere else: false, and the caller carries on as normal.
 */
export function shareGate(what: string): boolean {
  if (!isShareRecipient()) return false
  try {
    window.dispatchEvent(new CustomEvent<ShareGateDetail>(SHARE_GATE_EVENT, { detail: { what } }))
  } catch {
    /* no window (a test): the caller still stops */
  }
  return true
}
