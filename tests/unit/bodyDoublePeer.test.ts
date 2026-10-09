import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Peer body double: a stranger is matched by preference and the pair meet in a
// private PlexiiMeet room. Three layers are pinned here:
//   1. the per-mode media rules (what the camera/mic/chat do in each mode),
//   2. RemoteMatcher's handling of the wire protocol (token, room, refusals,
//      and the difference between "partner left" and "we lost the line"),
//   3. the store that ties a match to the meeting room and ends both together.
// The server side of the same contract is tested in focusbuddy-signal
// (tests/bodyDoubleMatcherUnit.mjs, tests/bodyDoubleFlow.mjs).

// ── Store dependencies, replaced with the thinnest honest fakes ─────────────
const account = { sessionToken: 'tok-123' as string | null }
vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: { getState: () => account }
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'http://signal.test', wsUrl: 'ws://signal.test/ws' }
}))

interface FakeMeeting {
  roomId: string | null
  status: 'idle' | 'joining' | 'in'
  bodyDouble: { mode: string; partnerHandle: string } | null
  error: string | null
  joinBodyDouble: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
}
const meeting: FakeMeeting = {
  roomId: null,
  status: 'idle',
  bodyDouble: null,
  error: null,
  joinBodyDouble: vi.fn(),
  leave: vi.fn()
}
vi.mock('../../src/renderer/src/stores/meetingRoom', () => ({
  useMeetingRoomStore: { getState: () => meeting }
}))

import { bodyDoubleMedia, bodyDoubleRoomTitle, BODY_DOUBLE_INTRO_MS } from '../../src/renderer/src/lib/bodyDoubleMedia'
import { RemoteMatcher, UNREACHABLE_MESSAGE, type Matcher, type MatcherEvents } from '../../src/renderer/src/lib/bodyDoubleMatcher'
import {
  usePeerBodyDoubleStore,
  __setBodyDoubleMatcher,
  PARTNER_LEFT_TOAST,
  CONNECTION_LOST_TOAST
} from '../../src/renderer/src/stores/peerBodyDouble'

// ── 1. Media rules ───────────────────────────────────────────────────────────
describe('bodyDoubleMedia — what each preference opens', () => {
  it('silent never opens a microphone and has no chat', () => {
    expect(bodyDoubleMedia('silent')).toEqual({ audio: false, startMuted: true, introMs: null, chat: false })
  })
  it('intros only: mic live for the intro, then auto-muted', () => {
    const plan = bodyDoubleMedia('greetings')
    expect(plan.audio).toBe(true)
    expect(plan.startMuted).toBe(false)
    expect(plan.introMs).toBe(BODY_DOUBLE_INTRO_MS)
    expect(plan.chat).toBe(true)
  })
  it('a little chat is fine: mic present but starts muted', () => {
    expect(bodyDoubleMedia('light')).toEqual({ audio: true, startMuted: true, introMs: null, chat: true })
  })
  it('happy to talk: mic live, no intro limit', () => {
    expect(bodyDoubleMedia('open')).toEqual({ audio: true, startMuted: false, introMs: null, chat: true })
  })
  it('the room title names the partner by handle only', () => {
    expect(bodyDoubleRoomTitle('QuietCedar34')).toBe('Body double · QuietCedar34')
  })
})

// ── 2. RemoteMatcher over a fake socket ──────────────────────────────────────
class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  closed = false
  private listeners: Record<string, Array<(e: unknown) => void>> = {}
  addEventListener(type: string, cb: (e: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  send(raw: string): void {
    this.sent.push(JSON.parse(raw))
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  // Test drivers
  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }
  receive(msg: unknown): void {
    this.emit('message', { data: JSON.stringify(msg) })
  }
  drop(): void {
    this.readyState = 3
    this.emit('close', {})
  }
  private emit(type: string, e: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(e)
  }
}

function events(): MatcherEvents & { [K in keyof MatcherEvents]: ReturnType<typeof vi.fn> } {
  return {
    onPartnerMatched: vi.fn(),
    onChatMessage: vi.fn(),
    onPartnerLeft: vi.fn(),
    onError: vi.fn(),
    onConnectionLost: vi.fn()
  }
}

describe('RemoteMatcher — the wire protocol', () => {
  let sockets: FakeSocket[]
  let matcher: RemoteMatcher
  beforeEach(() => {
    sockets = []
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
    matcher = new RemoteMatcher('ws://signal.test/ws', () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s as unknown as WebSocket
    })
  })

  it('announces with the session token, mode, handle and working-on', async () => {
    const ev = events()
    const p = matcher.startLooking({ mode: 'light', handle: 'QuietCedar34', workingOn: 'thesis', token: 'tok-1' }, ev)
    sockets[0].open()
    await p
    expect(sockets[0].sent[0]).toEqual({
      type: 'announce',
      payload: { mode: 'light', handle: 'QuietCedar34', workingOn: 'thesis', token: 'tok-1' }
    })
  })

  it('omits the token when there is none (never sends an empty one)', async () => {
    const p = matcher.startLooking({ mode: 'silent', handle: 'CalmHeron55', workingOn: null, token: null }, events())
    sockets[0].open()
    await p
    expect(sockets[0].sent[0].payload).not.toHaveProperty('token')
  })

  it('a match carries the pair room; an older server without it means text-only', async () => {
    const ev = events()
    const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, ev)
    sockets[0].open()
    await p
    const partner = { handle: 'BrightOwl88', workingOn: 'slides', joinedAt: 5 }
    sockets[0].receive({ type: 'matched', payload: { partner, meeting: { roomId: 'bd-xyz' } } })
    expect(ev.onPartnerMatched).toHaveBeenLastCalledWith(partner, { roomId: 'bd-xyz' })
    sockets[0].receive({ type: 'matched', payload: { partner } })
    expect(ev.onPartnerMatched).toHaveBeenLastCalledWith(partner, null)
  })

  it('partner leaving ends the request and closes the socket', async () => {
    const ev = events()
    const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, ev)
    sockets[0].open()
    await p
    sockets[0].receive({ type: 'partnerLeft' })
    expect(ev.onPartnerLeft).toHaveBeenCalledTimes(1)
    expect(sockets[0].closed).toBe(true)
    // The close that follows our own close is not a lost connection.
    sockets[0].drop()
    expect(ev.onConnectionLost).not.toHaveBeenCalled()
  })

  it('a coded refusal is reported with its code; uncoded server noise is not', async () => {
    const ev = events()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, ev)
    sockets[0].open()
    await p
    sockets[0].receive({ type: 'error', payload: { message: 'Bad message.' } })
    expect(ev.onError).not.toHaveBeenCalled()
    sockets[0].receive({ type: 'error', payload: { message: 'Pro and Team only.', code: 'bd_not_entitled' } })
    expect(ev.onError).toHaveBeenCalledWith({ code: 'bd_not_entitled', message: 'Pro and Team only.' })
    expect(sockets[0].closed).toBe(true)
    warn.mockRestore()
  })

  it('an unexpected drop after connecting is a lost connection, never "partner left"', async () => {
    const ev = events()
    const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, ev)
    sockets[0].open()
    await p
    sockets[0].drop()
    expect(ev.onConnectionLost).toHaveBeenCalledTimes(1)
    expect(ev.onPartnerLeft).not.toHaveBeenCalled()
  })

  it('an unreachable service rejects the request', async () => {
    const ev = events()
    const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, ev)
    sockets[0].drop()
    await expect(p).rejects.toThrow(UNREACHABLE_MESSAGE)
    expect(ev.onConnectionLost).not.toHaveBeenCalled()
  })

  it('end, block and cancel each send their message, then close', async () => {
    for (const [action, type] of [
      ['endSession', 'end'],
      ['block', 'block'],
      ['stopLooking', 'cancel']
    ] as const) {
      const p = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, events())
      const sock = sockets[sockets.length - 1]
      sock.open()
      await p
      await matcher[action]()
      expect(sock.sent.at(-1)).toEqual({ type })
      expect(sock.closed).toBe(true)
    }
  })

  it('a new request never reuses, or hears from, the previous socket', async () => {
    const first = events()
    const p1 = matcher.startLooking({ mode: 'open', handle: 'A1aaa', token: 't' }, first)
    sockets[0].open()
    await p1
    const second = events()
    const p2 = matcher.startLooking({ mode: 'open', handle: 'B2bbb', token: 't' }, second)
    sockets[1].open()
    await p2
    expect(sockets[0].closed).toBe(true)
    sockets[0].receive({ type: 'matched', payload: { partner: { handle: 'Ghost11', workingOn: null, joinedAt: 1 }, meeting: null } })
    expect(first.onPartnerMatched).not.toHaveBeenCalled()
    expect(second.onPartnerMatched).not.toHaveBeenCalled()
  })
})

// ── 3. The store: match → room → end, together ───────────────────────────────
function fakeMatcher(): Matcher & { events: MatcherEvents | null; [k: string]: unknown } {
  const m = {
    events: null as MatcherEvents | null,
    startLooking: vi.fn(async (_req, ev: MatcherEvents) => {
      m.events = ev
    }),
    stopLooking: vi.fn(async () => {}),
    sendChat: vi.fn(),
    endSession: vi.fn(async () => {}),
    block: vi.fn(async () => {})
  }
  return m as unknown as Matcher & { events: MatcherEvents | null }
}

const PARTNER = { handle: 'SteadyWren66', workingOn: 'grant report', joinedAt: 1 }

describe('peer body double store', () => {
  let m: ReturnType<typeof fakeMatcher>
  beforeEach(() => {
    m = fakeMatcher()
    __setBodyDoubleMatcher(m)
    account.sessionToken = 'tok-123'
    Object.assign(meeting, { roomId: null, status: 'idle', bodyDouble: null, error: null })
    meeting.joinBodyDouble = vi.fn(async (roomId: string, room: { mode: string; partnerHandle: string }) => {
      Object.assign(meeting, { roomId, status: 'in', bodyDouble: room })
      return true
    })
    meeting.leave = vi.fn(() => Object.assign(meeting, { roomId: null, status: 'idle', bodyDouble: null }))
    usePeerBodyDoubleStore.setState({
      status: 'idle',
      mode: null,
      workingOn: null,
      myHandle: null,
      partner: null,
      meetingRoomId: null,
      videoIssue: null,
      chat: [],
      toast: null,
      error: null
    })
  })
  afterEach(() => __setBodyDoubleMatcher(null))

  const s = () => usePeerBodyDoubleStore.getState()

  it('asks for sign-in instead of searching when signed out', async () => {
    account.sessionToken = null
    await s().startLooking('open', null)
    expect(m.startLooking).not.toHaveBeenCalled()
    expect(s().status).toBe('idle')
    expect(s().error?.code).toBe('bd_sign_in')
  })

  it('sends the preference and the token to the matcher', async () => {
    await s().startLooking('greetings', 'inbox triage')
    expect(s().status).toBe('looking')
    const req = (m.startLooking as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(req).toMatchObject({ mode: 'greetings', workingOn: 'inbox triage', token: 'tok-123' })
    expect(req.handle).toMatch(/^[A-Za-z][A-Za-z0-9]{2,31}$/)
  })

  it('a match records the room; starting the session joins it with the agreed mode', async () => {
    await s().startLooking('light', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-1' })
    expect(s().status).toBe('matched')
    expect(s().meetingRoomId).toBe('bd-1')
    expect(meeting.joinBodyDouble).not.toHaveBeenCalled() // nobody is on camera before they choose to start
    await s().enterConnected()
    expect(s().status).toBe('connected')
    expect(meeting.joinBodyDouble).toHaveBeenCalledWith('bd-1', { mode: 'light', partnerHandle: 'SteadyWren66' })
    expect(s().videoIssue).toBeNull()
  })

  it('a text-only match never opens a room', async () => {
    await s().startLooking('light', null)
    m.events!.onPartnerMatched(PARTNER, null)
    await s().enterConnected()
    expect(meeting.joinBodyDouble).not.toHaveBeenCalled()
    expect(s().status).toBe('connected')
  })

  it('another live meeting is never interrupted; the session says why there is no video', async () => {
    Object.assign(meeting, { roomId: 'meet-standup', status: 'in', bodyDouble: null })
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-2' })
    await s().enterConnected()
    expect(meeting.joinBodyDouble).not.toHaveBeenCalled()
    expect(meeting.leave).not.toHaveBeenCalled()
    expect(s().videoIssue).toMatch(/another meeting/)
  })

  it('a camera refusal is reported, and retry works once fixed', async () => {
    meeting.joinBodyDouble = vi.fn(async () => {
      meeting.error = 'Could not access your camera. Check system permissions.'
      return false
    })
    await s().startLooking('silent', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-3' })
    await s().enterConnected()
    expect(s().videoIssue).toBe('Could not access your camera. Check system permissions.')
    meeting.joinBodyDouble = vi.fn(async (roomId: string, room: { mode: string; partnerHandle: string }) => {
      Object.assign(meeting, { roomId, status: 'in', bodyDouble: room })
      return true
    })
    await s().retryVideo()
    expect(meeting.joinBodyDouble).toHaveBeenCalledWith('bd-3', { mode: 'silent', partnerHandle: 'SteadyWren66' })
    expect(s().videoIssue).toBeNull()
  })

  it('the partner leaving ends the session AND leaves the room, with an honest notice', async () => {
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-4' })
    await s().enterConnected()
    m.events!.onPartnerLeft()
    expect(meeting.leave).toHaveBeenCalledTimes(1)
    expect(s().status).toBe('idle')
    expect(s().toast).toBe(PARTNER_LEFT_TOAST)
  })

  it('losing our own connection never blames the partner', async () => {
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-5' })
    await s().enterConnected()
    m.events!.onConnectionLost()
    expect(s().toast).toBe(CONNECTION_LOST_TOAST)
    expect(meeting.leave).toHaveBeenCalledTimes(1)
  })

  it('losing the connection while searching is an error, not a session ending', async () => {
    await s().startLooking('open', null)
    m.events!.onConnectionLost()
    expect(s().status).toBe('idle')
    expect(s().toast).toBeNull()
    expect(s().error?.code).toBe('bd_unreachable')
  })

  it('a refusal from the server returns to idle with its code', async () => {
    await s().startLooking('open', null)
    m.events!.onError({ code: 'bd_not_entitled', message: 'Body double is included with the Pro and Team plans.' })
    expect(s().status).toBe('idle')
    expect(s().error).toEqual({ code: 'bd_not_entitled', message: 'Body double is included with the Pro and Team plans.' })
  })

  it('an unreachable service is reported, not left spinning', async () => {
    ;(m.startLooking as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(UNREACHABLE_MESSAGE))
    await s().startLooking('open', null)
    expect(s().status).toBe('idle')
    expect(s().error).toEqual({ code: 'bd_unreachable', message: UNREACHABLE_MESSAGE })
  })

  it('End leaves the room and tells the matcher', async () => {
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-6' })
    await s().enterConnected()
    await s().endSession()
    expect(meeting.leave).toHaveBeenCalledTimes(1)
    expect(m.endSession).toHaveBeenCalledTimes(1)
    expect(s().status).toBe('idle')
    expect(s().meetingRoomId).toBeNull()
  })

  it('Block ends the session, leaves the room and blocks through the matcher', async () => {
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-7' })
    await s().enterConnected()
    await s().blockPartner()
    expect(m.block).toHaveBeenCalledTimes(1)
    expect(meeting.leave).toHaveBeenCalledTimes(1)
    expect(s().status).toBe('idle')
    expect(s().toast).toMatch(/not be matched with them again/)
  })

  it('ending never touches an unrelated meeting the person is in', async () => {
    await s().startLooking('open', null)
    m.events!.onPartnerMatched(PARTNER, { roomId: 'bd-8' })
    // They never started the session, and are in some other meeting.
    Object.assign(meeting, { roomId: 'meet-other', status: 'in', bodyDouble: null })
    await s().endSession()
    expect(meeting.leave).not.toHaveBeenCalled()
  })

  it('chat is sent and shown optimistically, trimmed', async () => {
    await s().startLooking('light', null)
    m.events!.onPartnerMatched(PARTNER, null)
    await s().enterConnected()
    s().sendChat('  hello there  ')
    expect(m.sendChat).toHaveBeenCalledWith('hello there')
    expect(s().chat.at(-1)?.text).toBe('hello there')
    expect(s().chat.at(-1)?.senderHandle).toBe(s().myHandle)
  })
})
