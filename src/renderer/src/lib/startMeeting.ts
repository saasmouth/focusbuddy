import { useViewStore } from '../stores/view'
import { useMeetingRoomStore } from '../stores/meetingRoom'
import { entitlementFor } from './entitlementReason'
import { promptUpgrade } from '../stores/upgradePrompt'

// Block a meeting from starting when PlexiMeet is not entitled. Navigating to the
// meetings view is already covered by MainPane's backbone, but these launchers
// also open a live room as a side effect from outside PlexiMeet, so they check
// the same 'meet' capability here and surface the reason instead of starting one.
function meetBlocked(): boolean {
  const ent = entitlementFor('meet', 'Meetings')
  if (ent.enabled) return false
  promptUpgrade(ent.reason)
  return true
}

// One launcher for starting a meeting from anywhere in the app — a document, a
// sheet, a slide deck, a drawing, a design, a chat, a desk, or the calendar.
// Every surface calls launchMeeting() so the behaviour is identical no matter
// where it starts from: navigate to the meeting view and open a live room.
//
// The origin is remembered so the end-of-meeting wrap-up can suggest a logical
// place to save what comes out of the conversation. A meeting started from a
// desk defaults its transcript and follow-ups to that desk's folder; one started
// from a document defaults near that document. The origin is advisory — the user
// always confirms where things land — so it is fine for it to be absent.

export type MeetingOrigin =
  | { kind: 'doc'; id: string; title: string }
  | { kind: 'sheet'; id: string; title: string }
  | { kind: 'slides'; id: string; title: string }
  | { kind: 'draw'; id: string; title: string }
  | { kind: 'design'; id: string; title: string }
  | { kind: 'chat'; channelId: string; title: string }
  | { kind: 'desk'; nodeId: string; title: string }
  | {
      kind: 'calendar'
      title: string
      // M5 — series identity + staging facts ride the origin from the booked
      // block: the wrap-up stamps them onto the meeting record, and the Stage
      // assembles prep from them. All optional — an external-calendar join or
      // a bare deep link has none, and prep quietly shows nothing.
      blockId?: string
      seriesId?: string | null
      agenda?: string | null
      invitees?: string[]
    }
  | { kind: 'standalone'; title: string }

let currentOrigin: MeetingOrigin | null = null

export function getMeetingOrigin(): MeetingOrigin | null {
  return currentOrigin
}

// Cleared by the wrap-up flow once it has read the origin, so a later meeting
// started from a plain "Start a meeting" button does not inherit a stale source.
export function clearMeetingOrigin(): void {
  currentOrigin = null
}

// An origin is a shareable artifact when a meeting started from it can grant its
// attendees access to that artifact. Chat, the calendar and a plain start have
// no single artifact to share, so they start the room directly.
export function isShareableArtifactOrigin(origin: MeetingOrigin | null | undefined): boolean {
  return (
    !!origin &&
    (origin.kind === 'doc' ||
      origin.kind === 'sheet' ||
      origin.kind === 'slides' ||
      origin.kind === 'draw' ||
      origin.kind === 'design' ||
      origin.kind === 'desk')
  )
}

// Launch a meeting. From a shareable artifact this opens the start-meeting
// dialog so the user can add attendees and choose what access they get to the
// artifact before the room opens. From anywhere else it starts the room
// immediately. Returns the room id when it starts one directly, else null.
export async function launchMeeting(origin?: MeetingOrigin): Promise<string | null> {
  if (meetBlocked()) return null
  currentOrigin = origin ?? { kind: 'standalone', title: 'Meeting' }
  if (origin && isShareableArtifactOrigin(origin)) {
    // Lazy import to avoid a static cycle between the launcher and the store.
    const { useMeetingLaunchStore } = await import('../stores/meetingLaunch')
    useMeetingLaunchStore.getState().open(origin)
    return null
  }
  const title = origin?.title?.trim() || 'Meeting'
  useViewStore.getState().goMeetings()
  return useMeetingRoomStore.getState().start(title)
}

// Start the room for an artifact meeting once the dialog has collected its
// details. Sharing of the artifact to the attendees is handled by the dialog
// (via meetingShare) so this only has to open the room.
export async function startArtifactMeeting(origin: MeetingOrigin): Promise<string | null> {
  if (meetBlocked()) return null
  currentOrigin = origin
  useViewStore.getState().goMeetings()
  return useMeetingRoomStore.getState().start(origin.title?.trim() || 'Meeting')
}

// Join a specific, already-known room — the host and every invitee of a
// scheduled calendar meeting open the SAME room id, so this is what the "Join"
// button on a calendar meeting and the plexii://meet?room= deep link both call.
export async function joinMeetingRoom(
  roomId: string,
  title?: string,
  meta?: { blockId?: string; seriesId?: string | null; agenda?: string | null; invitees?: string[] }
): Promise<void> {
  if (meetBlocked()) return
  currentOrigin = { kind: 'calendar', title: title || 'Meeting', ...meta }
  useViewStore.getState().goMeetings()
  await useMeetingRoomStore.getState().join(roomId, title || 'Meeting')
}

// M6 — guest capture records an EXTERNAL meeting (Zoom/Meet/Teams); there is
// no room to join, but the wrap-up still stamps series identity from the
// origin, so an external series meeting gets prep and "carried from last
// time" exactly like a native one.
export function markCalendarOrigin(meta: {
  title: string
  blockId?: string
  seriesId?: string | null
  agenda?: string | null
  invitees?: string[]
}): void {
  currentOrigin = { kind: 'calendar', ...meta }
}

// DEC-130 — "Record notes" with a desk picked in its dialog (DEC-118): the
// recording's origin is THAT desk, so the wrap-up files its folder under it
// and stands the Record on it instead of minting a new desk.
export function markDeskOrigin(nodeId: string, title: string): void {
  currentOrigin = { kind: 'desk', nodeId, title }
}

// A fresh room id for a scheduled meeting, matching the live-room format so the
// same id is valid whether the room is opened now or later.
export function newMeetingRoomId(): string {
  const rand = (): string =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  return `meet-${rand()}-${rand()}`
}
