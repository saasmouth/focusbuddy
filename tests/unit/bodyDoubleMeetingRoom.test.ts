import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The meeting store's body-double room: the real store, with its socket and
// recorder seams replaced. Pins what each preference actually opens (the mic
// is never requested in silent mode), the intro auto-mute, and the doors a
// stranger's room keeps shut — recording, invites, screen share, saved notes.

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = []
vi.mock('../../src/renderer/src/lib/messagingSocket', () => ({
  sendSocketMessage: (msg: { type: string; payload?: Record<string, unknown> }) => sent.push(msg),
  setMeetingSocketHandler: () => {}
}))
vi.mock('../../src/renderer/src/lib/notify', () => ({ notifyExternal: () => {} }))
vi.mock('../../src/renderer/src/lib/trackRecorder', () => ({
  MeetingTrackRecorder: vi.fn()
}))
const saveNotes = vi.fn()
vi.mock('../../src/renderer/src/lib/meetingWrapup', () => ({ saveMeetingNotesDoc: (...a: unknown[]) => saveNotes(...a) }))
vi.mock('../../src/renderer/src/stores/wrapup', () => ({ useWrapupStore: { getState: () => ({ begin: vi.fn() }) } }))
vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: { getState: () => ({ account: { id: 'me-acct', firstName: 'Real', lastName: 'Name' } }) }
}))

import { useMeetingRoomStore } from '../../src/renderer/src/stores/meetingRoom'
import { BODY_DOUBLE_INTRO_MS } from '../../src/renderer/src/lib/bodyDoubleMedia'

interface FakeTrack {
  kind: 'audio' | 'video'
  enabled: boolean
  stopped: boolean
  stop: () => void
}
function track(kind: 'audio' | 'video'): FakeTrack {
  const t: FakeTrack = { kind, enabled: true, stopped: false, stop: () => (t.stopped = true) }
  return t
}
function stream(tracks: FakeTrack[]): MediaStream {
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video')
  } as unknown as MediaStream
}

let constraints: MediaStreamConstraints[] = []
let lastTracks: FakeTrack[] = []
let refuse = false

beforeEach(() => {
  sent.length = 0
  constraints = []
  refuse = false
  saveNotes.mockClear()
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (c: MediaStreamConstraints) => {
        constraints.push(c)
        if (refuse) throw new Error('NotAllowedError')
        lastTracks = [track('video'), ...(c.audio ? [track('audio')] : [])]
        return stream(lastTracks)
      }),
      getDisplayMedia: vi.fn()
    }
  })
})

afterEach(() => {
  if (useMeetingRoomStore.getState().status !== 'idle') useMeetingRoomStore.getState().leave()
  useMeetingRoomStore.setState({ error: null })
  vi.useRealTimers()
})

const room = () => useMeetingRoomStore.getState()
const audio = () => lastTracks.find((t) => t.kind === 'audio')

describe('joinBodyDouble — the mic follows the preference', () => {
  it('silent: camera only — the microphone is never requested', async () => {
    expect(await room().joinBodyDouble('bd-s', { mode: 'silent', partnerHandle: 'CalmHeron55' })).toBe(true)
    expect(constraints).toEqual([{ audio: false, video: true }])
    expect(audio()).toBeUndefined()
    expect(room().muted).toBe(true)
    // Nothing to unmute.
    room().toggleMute()
    expect(room().muted).toBe(true)
  })

  it('a little chat: mic opened but muted from the start', async () => {
    await room().joinBodyDouble('bd-l', { mode: 'light', partnerHandle: 'KindLark77' })
    expect(constraints).toEqual([{ audio: true, video: true }])
    expect(audio()?.enabled).toBe(false)
    expect(room().muted).toBe(true)
    room().toggleMute()
    expect(audio()?.enabled).toBe(true)
  })

  it('happy to talk: mic live', async () => {
    await room().joinBodyDouble('bd-o', { mode: 'open', partnerHandle: 'BrightOwl88' })
    expect(audio()?.enabled).toBe(true)
    expect(room().muted).toBe(false)
    expect(room().introEndsAt).toBeNull()
  })

  it('intros only: mic live, then muted when the intro window passes', async () => {
    vi.useFakeTimers()
    await room().joinBodyDouble('bd-g', { mode: 'greetings', partnerHandle: 'GentleFinch99' })
    expect(audio()?.enabled).toBe(true)
    expect(room().introEndsAt).not.toBeNull()
    vi.advanceTimersByTime(BODY_DOUBLE_INTRO_MS - 1)
    expect(audio()?.enabled).toBe(true)
    vi.advanceTimersByTime(1)
    expect(audio()?.enabled).toBe(false)
    expect(room().muted).toBe(true)
    expect(room().introEndsAt).toBeNull()
    // They may still unmute to say goodbye.
    room().toggleMute()
    expect(audio()?.enabled).toBe(true)
  })

  it('the intro timer dies with the room', async () => {
    vi.useFakeTimers()
    await room().joinBodyDouble('bd-g2', { mode: 'greetings', partnerHandle: 'GentleFinch99' })
    const tracks = lastTracks
    room().leave()
    vi.advanceTimersByTime(BODY_DOUBLE_INTRO_MS)
    expect(room().muted).toBe(false) // teardown reset; the timer did not fire into a dead room
    expect(tracks.every((t) => t.stopped)).toBe(true)
  })
})

describe('joinBodyDouble — the room', () => {
  it('joins the pair room docked beside the work, titled by handle only', async () => {
    await room().joinBodyDouble('bd-r', { mode: 'open', partnerHandle: 'SteadyWren66' })
    expect(room().status).toBe('in')
    expect(room().layout).toBe('collaborate')
    expect(room().title).toBe('Body double · SteadyWren66')
    expect(room().bodyDouble).toEqual({ mode: 'open', partnerHandle: 'SteadyWren66' })
    expect(sent).toContainEqual({ type: 'meetingJoin', payload: { roomId: 'bd-r', title: 'Body double · SteadyWren66' } })
  })

  it('a refused camera reports why and leaves no half-open room', async () => {
    refuse = true
    expect(await room().joinBodyDouble('bd-x', { mode: 'silent', partnerHandle: 'CalmHeron55' })).toBe(false)
    expect(room().status).toBe('idle')
    expect(room().roomId).toBeNull()
    expect(room().bodyDouble).toBeNull()
    expect(room().error).toBe('Could not access your camera. Check system permissions.')
  })

  it('never barges into a meeting already in progress', async () => {
    await room().join('meet-standup', 'Standup')
    expect(await room().joinBodyDouble('bd-y', { mode: 'open', partnerHandle: 'BrightOwl88' })).toBe(false)
    expect(room().roomId).toBe('meet-standup')
    expect(room().bodyDouble).toBeNull()
  })
})

describe('a stranger’s room keeps its doors shut', () => {
  beforeEach(async () => {
    await room().joinBodyDouble('bd-d', { mode: 'open', partnerHandle: 'BrightOwl88' })
    sent.length = 0
  })

  it('cannot be recorded', () => {
    room().setTranscribing(true)
    expect(room().transcribing).toBe(false)
  })

  it('cannot ring anyone in', () => {
    room().invite({ accountId: 'teammate', handle: 'teammate' })
    expect(sent.some((m) => m.type === 'meetingInvite')).toBe(false)
  })

  it('cannot share a screen', async () => {
    await room().startScreenShare()
    expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled()
    expect(room().sharingScreen).toBe(false)
  })

  it('saves no notes document on leave, and resets for the next meeting', () => {
    room().setNotes('something typed')
    room().leave()
    expect(saveNotes).not.toHaveBeenCalled()
    expect(sent).toContainEqual({ type: 'meetingLeave', payload: { roomId: 'bd-d' } })
    expect(room().bodyDouble).toBeNull()
    expect(room().layout).toBe('stage')
  })
})
