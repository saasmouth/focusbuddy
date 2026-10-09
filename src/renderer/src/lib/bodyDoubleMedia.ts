import type { BodyDoubleMode } from '@shared/types'

// What a body-double session opens, per mode. Both partners picked the same
// mode (the matcher pairs exact modes only), so these rules hold for both
// sides of every call.
//
// The camera is on in every mode: seeing someone else at their desk is the
// presence body doubling is for, and either side can turn theirs off. The
// microphone is what the modes are about:
//   silent    — never opened. Not muted: absent, so nothing can be heard by
//               accident and the OS never shows a mic-in-use indicator.
//   greetings — open for the intro, then muted automatically once the intro
//               window passes. Either side may unmute to say goodbye.
//   light     — open but muted at the start; unmute for a quick word.
//   open      — open and live.

export interface BodyDoubleMediaPlan {
  /** Whether the microphone is requested at all. */
  audio: boolean
  /** Whether the microphone starts muted (only meaningful when audio). */
  startMuted: boolean
  /** How long the intro lasts before the mic auto-mutes, or null for never. */
  introMs: number | null
  /** Whether text chat belongs to this mode (the server enforces the same). */
  chat: boolean
}

export const BODY_DOUBLE_INTRO_MS = 2 * 60 * 1000

export function bodyDoubleMedia(mode: BodyDoubleMode): BodyDoubleMediaPlan {
  switch (mode) {
    case 'silent':
      return { audio: false, startMuted: true, introMs: null, chat: false }
    case 'greetings':
      return { audio: true, startMuted: false, introMs: BODY_DOUBLE_INTRO_MS, chat: true }
    case 'light':
      return { audio: true, startMuted: true, introMs: null, chat: true }
    case 'open':
      return { audio: true, startMuted: false, introMs: null, chat: true }
  }
}

// The meeting title both sides see: the partner's pseudonymous handle and
// nothing else about them.
export function bodyDoubleRoomTitle(partnerHandle: string): string {
  return `Body double · ${partnerHandle}`
}
