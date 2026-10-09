import { create } from 'zustand'
import type {
  BodyDoubleChatMessage,
  BodyDoubleError,
  BodyDoubleMode,
  BodyDoublePartner,
  BodyDoubleStatus
} from '@shared/types'
import { generateHandle } from '../lib/bodyDoubleHandle'
import {
  LocalMockMatcher,
  RemoteMatcher,
  UNREACHABLE_MESSAGE,
  type Matcher
} from '../lib/bodyDoubleMatcher'
import { signalConfig } from '../lib/signalConfig'
import { useAccountStore } from './account'
import { useMeetingRoomStore } from './meetingRoom'

// Peer body double: one session from "Find a partner" to the end.
//
//   idle → looking → matched → connected → idle
//
// When both partners are signed in, the matching service mints a private
// PlexiiMeet room for the pair and both learn it in the match. Starting the
// session joins that room through the ordinary meeting store, docked beside
// the work, with the microphone set by the shared mode (lib/bodyDoubleMedia).
// The session and the room end together, from whichever side ends first:
// End, Skip, block, the partner leaving, or a dropped connection.

// Singleton matcher instance — created lazily on first use. Feature-flag
// chooses LocalMockMatcher (dev only: two windows on one machine, no server)
// vs RemoteMatcher (WebSocket to the hosted signaling service).
//
// Lives outside the store so hot-module-reload doesn't churn it on every
// renderer save.
let matcher: Matcher | null = null
function getMatcher(): Matcher {
  if (!matcher) {
    matcher = signalConfig.useRemote
      ? new RemoteMatcher(signalConfig.wsUrl)
      : new LocalMockMatcher()
  }
  return matcher
}

/** Test seam: swap the matcher (and reset it with null). */
export function __setBodyDoubleMatcher(m: Matcher | null): void {
  matcher = m
}

// What the person sees when a session ends without them ending it.
export const PARTNER_LEFT_TOAST = 'Your partner ended the session.'
export const CONNECTION_LOST_TOAST = 'Lost the connection to the matching service, so the session ended.'

interface State {
  status: BodyDoubleStatus
  // Mode the user picked when starting the request — preserved across the
  // looking/matched/connected transitions so the UI can render "you're in
  // light-conversation mode" badges, etc.
  mode: BodyDoubleMode | null
  workingOn: string | null
  // Local handle (generated when entering looking). Kept in store so we can
  // display "you are X" in the active session.
  myHandle: string | null
  partner: BodyDoublePartner | null
  // The pair's private PlexiiMeet room, or null for a text-only session (the
  // dev mock, or a server that predates pair rooms).
  meetingRoomId: string | null
  // Why the video did not open for this session, when it did not. The session
  // itself carries on as text; this tells the person what happened.
  videoIssue: string | null
  // Chat history of the active session. Cleared between sessions.
  chat: BodyDoubleChatMessage[]
  // Soft notice — set on partner-left / connection-lost so the UI can say
  // what happened without a modal interruption.
  toast: string | null
  // Why the last request was refused, with a code the dialog acts on.
  error: BodyDoubleError | null
}

interface Actions {
  startLooking: (mode: BodyDoubleMode, workingOn: string | null) => Promise<void>
  cancelLooking: () => Promise<void>
  sendChat: (text: string) => void
  endSession: () => Promise<void>
  // End the session and never be matched with this partner again.
  blockPartner: () => Promise<void>
  dismissToast: () => void
  dismissError: () => void
  // Transition matched → connected once the user clicks "Start session"
  // after seeing the partner intro, and open the pair's video room.
  enterConnected: () => Promise<void>
  // Retry opening the video room after it failed (permissions fixed, or the
  // other meeting has ended).
  retryVideo: () => Promise<void>
}

const CLEARED = {
  status: 'idle' as const,
  partner: null,
  meetingRoomId: null,
  videoIssue: null,
  chat: [],
  mode: null,
  workingOn: null
}

// Leave the pair's room if — and only if — it is the room the meeting store
// is in. An unrelated meeting the person joined meanwhile is never touched.
function leavePairRoom(roomId: string | null): void {
  if (!roomId) return
  const meeting = useMeetingRoomStore.getState()
  if (meeting.roomId === roomId && meeting.bodyDouble) meeting.leave()
}

export const usePeerBodyDoubleStore = create<State & Actions>((set, get) => {
  async function openVideo(): Promise<void> {
    const { meetingRoomId, mode, partner } = get()
    if (!meetingRoomId || !mode || !partner) return
    const meeting = useMeetingRoomStore.getState()
    if (meeting.roomId === meetingRoomId) return // already in it
    if (meeting.status !== 'idle') {
      set({ videoIssue: 'You are in another meeting. Leave it to see your body double.' })
      return
    }
    set({ videoIssue: null })
    const ok = await meeting.joinBodyDouble(meetingRoomId, { mode, partnerHandle: partner.handle })
    // The session may have ended while the camera prompt was up.
    if (get().meetingRoomId !== meetingRoomId) {
      leavePairRoom(meetingRoomId)
      return
    }
    if (!ok) set({ videoIssue: useMeetingRoomStore.getState().error ?? 'The video could not be opened.' })
  }

  // The session ended from outside (partner, drop): tear down and say why.
  function endedRemotely(toast: string): void {
    leavePairRoom(get().meetingRoomId)
    set({ ...CLEARED, toast })
  }

  return {
    status: 'idle',
    mode: null,
    workingOn: null,
    myHandle: null,
    partner: null,
    meetingRoomId: null,
    videoIssue: null,
    chat: [],
    toast: null,
    error: null,

    startLooking: async (mode, workingOn) => {
      if (get().status !== 'idle') return
      // Matching strangers into a video room needs an account: the server
      // checks the plan and admits only the two matched members. The dev mock
      // has no server and runs without one.
      const token = useAccountStore.getState().sessionToken
      if (signalConfig.useRemote && !token) {
        set({ error: { code: 'bd_sign_in', message: 'Sign in to find a body double.' } })
        return
      }
      const handle = generateHandle()
      set({
        status: 'looking',
        mode,
        workingOn,
        myHandle: handle,
        partner: null,
        meetingRoomId: null,
        videoIssue: null,
        chat: [],
        toast: null,
        error: null
      })
      const m = getMatcher()
      try {
        await m.startLooking(
          { mode, workingOn, handle, token },
          {
            onPartnerMatched: (partner, meeting) => {
              set({ status: 'matched', partner, meetingRoomId: meeting?.roomId ?? null })
            },
            onChatMessage: (msg) => {
              set({ chat: [...get().chat, msg] })
            },
            onPartnerLeft: () => endedRemotely(PARTNER_LEFT_TOAST),
            onError: (error) => {
              leavePairRoom(get().meetingRoomId)
              set({ ...CLEARED, error })
            },
            onConnectionLost: () => {
              // Lost while still looking: nobody left, the search just stopped.
              if (get().status === 'looking') {
                set({ ...CLEARED, error: { code: 'bd_unreachable', message: UNREACHABLE_MESSAGE } })
                return
              }
              endedRemotely(CONNECTION_LOST_TOAST)
            }
          }
        )
      } catch (err) {
        set({
          ...CLEARED,
          error: { code: 'bd_unreachable', message: err instanceof Error ? err.message : UNREACHABLE_MESSAGE }
        })
      }
    },

    cancelLooking: async () => {
      await getMatcher().stopLooking()
      set({ ...CLEARED })
    },

    enterConnected: async () => {
      if (get().status !== 'matched') return
      set({ status: 'connected' })
      await openVideo()
    },

    retryVideo: async () => {
      if (get().status !== 'connected') return
      await openVideo()
    },

    sendChat: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const handle = get().myHandle
      if (!handle) return
      if (get().status !== 'connected' && get().status !== 'matched') return
      getMatcher().sendChat(trimmed)
      // Optimistic — show our own message immediately. The matcher only
      // echoes messages to the OTHER side; this is the local insertion so
      // the chat scroll reflects what we said.
      set({
        chat: [
          ...get().chat,
          {
            id: Math.random().toString(36).slice(2, 10),
            senderHandle: handle,
            text: trimmed,
            ts: Date.now()
          }
        ]
      })
    },

    endSession: async () => {
      const roomId = get().meetingRoomId
      set({ ...CLEARED })
      leavePairRoom(roomId)
      await getMatcher().endSession()
    },

    blockPartner: async () => {
      const roomId = get().meetingRoomId
      set({ ...CLEARED, toast: 'Session ended. You will not be matched with them again.' })
      leavePairRoom(roomId)
      await getMatcher().block()
    },

    dismissToast: () => set({ toast: null }),
    dismissError: () => set({ error: null })
  }
})
