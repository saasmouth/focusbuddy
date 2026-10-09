import { create } from 'zustand'
import { sendSocketMessage, setMeetingSocketHandler, type MeetingSocketEvent } from '../lib/messagingSocket'
import { notifyExternal } from '../lib/notify'
import { MeetingTrackRecorder } from '../lib/trackRecorder'
import {
  initialConsent,
  isConsentWire,
  mayCapture,
  type ConsentChoice,
  type ConsentMap,
  type ConsentWire
} from '../lib/meetingConsent'
import { saveMeetingNotesDoc } from '../lib/meetingWrapup'
import { useWrapupStore } from './wrapup'
import { useAccountStore } from './account'
import { personDisplayName } from '../lib/personName'
import { bodyDoubleMedia, bodyDoubleRoomTitle } from '../lib/bodyDoubleMedia'
import type { BodyDoubleMode } from '@shared/types'

// PlexiMeet live rooms: a multi-party meeting built as a WebRTC mesh. Each member
// holds one peer connection to every other member; the signal server only relays
// the roster and the SDP/ICE, never the media. Glare is avoided by a single rule:
// whoever joins a room sends the offer to everyone already there, and existing
// members only ever answer. This suits small meetings (a handful of people on
// normal networks); large rooms and hard NATs want a TURN server and an SFU,
// which are a server-infrastructure phase, and the UI says so honestly rather
// than faking a connection that did not form.
//
// Screen sharing rides the same mesh. When a member shares, the screen video is
// added as an extra track (its own MediaStream) to every peer connection and the
// mesh is renegotiated live. Only the sharer initiates that renegotiation, and a
// perfect-negotiation-lite glare guard (a deterministic polite flag) keeps the
// rare case of two people sharing at once from wedging a connection. The initial
// join offer/answer flow is untouched. Receivers tell a screen stream from a
// camera stream by a small announce message that names the screen stream id and
// is always sent before the renegotiation offer over the same ordered socket.

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

export type MeetingStatus = 'idle' | 'joining' | 'in'

export interface MeetingParticipant {
  accountId: string
  handle: string
  firstName?: string | null
  lastName?: string | null
  stream: MediaStream | null
  // The peer's shared screen, when they are presenting. Null otherwise. Kept
  // separate from `stream` (their camera) so both can render at once.
  screenStream: MediaStream | null
  connected: boolean
}

export interface MeetingInvite {
  roomId: string
  from: { accountId: string; handle: string; firstName?: string | null; lastName?: string | null }
  title: string | null
}

// How the live meeting is presented. 'stage' is the classic fullscreen room;
// 'collaborate' docks the meeting to one edge as a movable panel so the rest of
// Plexii stays the focus and the user can navigate around while the call runs.
export type MeetingLayout = 'stage' | 'collaborate'
export type DockSide = 'left' | 'right' | 'top' | 'bottom'

// A body-double room: a private two-person room the matching service minted
// for two strangers. It is still a PlexiiMeet mesh, with stricter rules — the
// microphone follows the agreed mode, and nothing that would expose either
// person further (recording, invites, screen sharing, saved notes) is offered.
export interface BodyDoubleRoom {
  mode: BodyDoubleMode
  partnerHandle: string
}

const DOCK_KEY = 'fb.meet.dockSide'
function loadDockSide(): DockSide {
  try {
    const v = localStorage.getItem(DOCK_KEY)
    return v === 'left' || v === 'top' || v === 'bottom' ? v : 'right'
  } catch {
    return 'right'
  }
}

interface MeetingRoomStore {
  roomId: string | null
  title: string | null
  status: MeetingStatus
  localStream: MediaStream | null
  // The local screen the user is currently sharing (getDisplayMedia), or null.
  screenStream: MediaStream | null
  sharingScreen: boolean
  participants: Record<string, MeetingParticipant>
  muted: boolean
  cameraOff: boolean
  error: string | null
  incomingInvite: MeetingInvite | null
  ready: boolean
  // Presentation of the live room (see MeetingLayout). dockSide is remembered.
  layout: MeetingLayout
  dockSide: DockSide
  // M1 (S3-DEC-024) — recording state under consent. `transcribing` kept as
  // the UI-facing name; it is true only after someone explicitly STARTED a
  // recording. No preference, calendar rule or rejoin ever sets it.
  transcribing: boolean
  /** Who started the recording (accountId), when one is live. */
  recordingBy: string | null
  /** Per-participant consent, self included (S3-DEC-024). */
  consent: ConsentMap
  /** A consent prompt awaiting MY answer, when someone else started. */
  consentAsk: { by: string; byName: string } | null
  // M4 — the live transcript pane (⌘⇧T while recording). Lines exist only
  // on the initiator's client: capture happens on the machine that holds the
  // recorder, so only it can hear anything to decode. Rough by design — the
  // wrap-up's per-track pass writes the Record; this is a courtesy view.
  liveOpen: boolean
  liveLines: Array<{ accountId: string; name: string; atMs: number; text: string }>
  /** The Stage notepad — my words, verbatim, saved on leave. */
  notes: string
  /** ⌘⇧M anchors: ms offsets on the meeting clock (recording t0 when live,
   *  join time otherwise — a moment is a moment either way). */
  moments: number[]
  joinedAtMs: number | null
  /** Set while the live room is a body-double pairing (see BodyDoubleRoom). */
  bodyDouble: BodyDoubleRoom | null
  /** Greetings mode: when the intro ends and the mic auto-mutes. */
  introEndsAt: number | null

  init: () => void
  setLayout: (layout: MeetingLayout) => void
  setDockSide: (side: DockSide) => void
  /** Start the consent flow + recording, or stop a recording I started. */
  setTranscribing: (on: boolean) => void
  /** Open/close the live transcript pane; the PCM tap follows it. */
  setLiveOpen: (open: boolean) => void
  answerConsent: (choice: ConsentChoice) => void
  setNotes: (text: string) => void
  markMoment: () => void
  start: (title?: string) => Promise<string | null>
  join: (roomId: string, title?: string) => Promise<void>
  /** Join a body-double pair room. Resolves true once in the room; false when
   *  another meeting is live or the camera/mic could not be opened (`error`
   *  then says which). */
  joinBodyDouble: (roomId: string, room: BodyDoubleRoom) => Promise<boolean>
  invite: (peer: { accountId: string; handle: string }) => void
  leave: () => void
  toggleMute: () => void
  toggleCamera: () => void
  startScreenShare: () => Promise<void>
  stopScreenShare: () => void
  toggleScreenShare: () => Promise<void>
  dismissInvite: () => void
  acceptInvite: () => Promise<void>
}

// Non-serializable mesh internals live outside the store: one RTCPeerConnection
// per remote member, plus its buffer of ICE candidates that arrived early, a
// glare guard, and a deterministic politeness flag.
interface PeerConn {
  pc: RTCPeerConnection
  pending: RTCIceCandidateInit[]
  makingOffer: boolean
  polite: boolean
}
let peers = new Map<string, PeerConn>()
// The RTCRtpSender carrying my screen track to each peer, so I can removeTrack
// on stop. Keyed by the peer's accountId.
let screenSenders = new Map<string, RTCRtpSender>()
// The screen stream id each peer has announced they are sharing, so ontrack can
// route their screen track to `screenStream` instead of merging it into camera.
let announcedScreenSid = new Map<string, string>()
// M1 — the per-track recorder (C1, ruled foundation): one attributed take
// per consented participant plus a mixed blob for the legacy wrap-up.
let recorder: MeetingTrackRecorder | null = null
// Greetings mode: the timer that mutes the mic when the intro window passes.
let introTimer: ReturnType<typeof setTimeout> | null = null

function genRoomId(): string {
  return `meet-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

export const useMeetingRoomStore = create<MeetingRoomStore>((set, get) => {
  function signalTo(to: string, data: unknown): void {
    const roomId = get().roomId
    if (!roomId) return
    sendSocketMessage({ type: 'meetingSignal', payload: { roomId, to, data: JSON.stringify(data) } })
  }

  /** M1 — the initiator's authoritative consent snapshot, to every peer. */
  function broadcastConsentState(consent: ConsentMap): void {
    const me = useAccountStore.getState().account?.id ?? ''
    for (const id of Object.keys(get().participants)) {
      signalTo(id, { kind: 'consent-state', by: me, consent })
    }
  }

  // Create (or fetch) the peer connection for a member, wiring local tracks, ICE
  // and the remote track sink. Idempotent: a second call returns the existing one.
  function ensurePeer(
    accountId: string,
    handle: string,
    firstName?: string | null,
    lastName?: string | null
  ): PeerConn {
    const found = peers.get(accountId)
    if (found) return found
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const local = get().localStream
    if (local) for (const track of local.getTracks()) pc.addTrack(track, local)
    // If I am already sharing when this peer appears, the screen is NOT added
    // here: on the answerer side of a fresh connection createAnswer cannot add a
    // new m-line, so the track would silently never arrive. Instead the sharer
    // pushes the screen via an explicit follow-up renegotiation once the base
    // connection is up (see the offer branch in onSocket, and startScreenShare).
    // The peer's camera+mic accumulate into one stream; a screen share arrives on
    // its own stream id and is kept apart.
    const camera = new MediaStream()
    pc.onicecandidate = (e) => {
      if (e.candidate) signalTo(accountId, { kind: 'candidate', candidate: e.candidate.toJSON() })
    }
    pc.ontrack = (e) => {
      const inbound = e.streams[0]
      const p = get().participants[accountId]
      if (!p) return
      if (inbound && announcedScreenSid.get(accountId) === inbound.id) {
        // This is the peer's shared screen. Do not mix it into the recording.
        set({ participants: { ...get().participants, [accountId]: { ...p, screenStream: inbound } } })
        return
      }
      for (const track of inbound ? inbound.getTracks() : [e.track]) {
        if (!camera.getTracks().some((t) => t.id === track.id)) camera.addTrack(track)
      }
      // M1 — capture this peer ONLY if they have consented (S3-DEC-024).
      // 'pending' is a no until they answer; 'declined' is a no forever.
      if (recorder && mayCapture(get().consent[accountId])) recorder.tap(accountId, camera)
      set({ participants: { ...get().participants, [accountId]: { ...p, stream: camera } } })
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      const p = get().participants[accountId]
      if (!p) return
      if (st === 'connected') {
        set({ participants: { ...get().participants, [accountId]: { ...p, connected: true } } })
      } else if (st === 'failed' || st === 'closed' || st === 'disconnected') {
        set({ participants: { ...get().participants, [accountId]: { ...p, connected: false } } })
      }
    }
    const myId = useAccountStore.getState().account?.id ?? ''
    const conn: PeerConn = { pc, pending: [], makingOffer: false, polite: myId < accountId }
    peers.set(accountId, conn)
    // Register the participant tile immediately (so it shows "connecting").
    if (!get().participants[accountId]) {
      set({
        participants: {
          ...get().participants,
          [accountId]: { accountId, handle, firstName, lastName, stream: null, screenStream: null, connected: false }
        }
      })
    }
    return conn
  }

  // Sharer-initiated renegotiation, used when a screen track is added or removed
  // on a live connection. Only ever called by the member who changed their own
  // tracks; the glare guard in onSocket handles the rare simultaneous case.
  async function renegotiate(accountId: string): Promise<void> {
    const conn = peers.get(accountId)
    if (!conn) return
    try {
      conn.makingOffer = true
      const offer = await conn.pc.createOffer()
      await conn.pc.setLocalDescription(offer)
      signalTo(accountId, { kind: 'offer', sdp: offer })
    } catch {
      /* renegotiation failed for this peer; their screen tile just won't update */
    } finally {
      conn.makingOffer = false
    }
  }

  // Deliver my current screen to one peer via a sharer-initiated renegotiation.
  // Safe to call for a peer that already has it (no-op) and only when sharing.
  // Announce is sent before the offer so the receiver routes the incoming track.
  function pushScreenTo(accountId: string): void {
    const display = get().screenStream
    if (!display) return
    const st = display.getVideoTracks()[0]
    const conn = peers.get(accountId)
    if (!st || !conn || screenSenders.has(accountId)) return
    signalTo(accountId, { kind: 'screen', on: true, sid: display.id })
    try {
      screenSenders.set(accountId, conn.pc.addTrack(st, display))
    } catch {
      return
    }
    void renegotiate(accountId)
  }

  function dropPeer(accountId: string): void {
    const conn = peers.get(accountId)
    if (conn) {
      conn.pc.onicecandidate = null
      conn.pc.ontrack = null
      conn.pc.onconnectionstatechange = null
      try {
        conn.pc.close()
      } catch {
        /* already closed */
      }
      peers.delete(accountId)
    }
    screenSenders.delete(accountId)
    announcedScreenSid.delete(accountId)
    const rest = { ...get().participants }
    delete rest[accountId]
    set({ participants: rest })
  }

  function teardown(): void {
    if (introTimer) clearTimeout(introTimer)
    introTimer = null
    for (const id of [...peers.keys()]) dropPeer(id)
    peers = new Map()
    screenSenders = new Map()
    announcedScreenSid = new Map()
    get().localStream?.getTracks().forEach((t) => t.stop())
    get().screenStream?.getTracks().forEach((t) => t.stop())
    set({
      roomId: null,
      title: null,
      status: 'idle',
      localStream: null,
      screenStream: null,
      sharingScreen: false,
      participants: {},
      muted: false,
      cameraOff: false,
      transcribing: false,
    liveOpen: false,
    liveLines: [],
      recordingBy: null,
      consent: {},
      consentAsk: null,
      notes: '',
      moments: [],
      joinedAtMs: null,
      bodyDouble: null,
      introEndsAt: null,
      // Next meeting starts on the stage; dockSide preference is kept.
      layout: 'stage'
    })
  }

  // Open the camera (and the mic, when asked) and announce the join. Shared by
  // ordinary meetings and body-double rooms; resolves with status 'in' on
  // success, or back at 'idle' with `error` saying what the OS refused.
  async function enterRoom(
    roomId: string,
    title: string | null,
    media: { audio: boolean },
    bodyDouble: BodyDoubleRoom | null
  ): Promise<void> {
    set({ status: 'joining', error: null, roomId, title, participants: {}, bodyDouble })
    try {
      const local = await navigator.mediaDevices.getUserMedia({ audio: media.audio, video: true })
      // M1 (S3-DEC-024) — recording is OFF until a person starts it, in the
      // room, through the consent flow. The old behaviour (a saved
      // preference silently starting capture at join, with no one told) is
      // deliberately gone and must not return: no preference, calendar rule
      // or rejoin ever starts a recording.
      set({ localStream: local, status: 'in', incomingInvite: null, joinedAtMs: Date.now() })
      // Announce; the server replies with the roster and we offer to each member.
      sendSocketMessage({ type: 'meetingJoin', payload: { roomId, title: title ?? undefined } })
    } catch {
      set({
        status: 'idle',
        roomId: null,
        bodyDouble: null,
        error: media.audio
          ? 'Could not access your microphone or camera. Check system permissions.'
          : 'Could not access your camera. Check system permissions.'
      })
    }
  }

  async function flush(conn: PeerConn): Promise<void> {
    for (const c of conn.pending) {
      try {
        await conn.pc.addIceCandidate(c)
      } catch {
        /* a malformed candidate is non-fatal */
      }
    }
    conn.pending = []
  }

  async function onSocket(e: MeetingSocketEvent): Promise<void> {
    const state = get()
    // An invite can arrive while idle; everything else is for the active room.
    if (e.type === 'meetingInvited') {
      if (state.roomId === e.payload.roomId) return // already in it
      set({ incomingInvite: e.payload })
      notifyExternal('Meeting invite', `${personDisplayName(e.payload.from, 'Someone')} invited you to ${e.payload.title ?? 'a meeting'}`, {
        force: true,
        tag: `meet-${e.payload.roomId}`
      })
      return
    }
    if (!state.roomId || e.payload.roomId !== state.roomId) return

    if (e.type === 'meetingRoster') {
      // I just joined: offer to everyone already here (I am the newcomer).
      for (const peer of e.payload.peers) {
        const conn = ensurePeer(peer.accountId, peer.handle, peer.firstName, peer.lastName)
        try {
          const offer = await conn.pc.createOffer()
          await conn.pc.setLocalDescription(offer)
          signalTo(peer.accountId, { kind: 'offer', sdp: offer })
        } catch {
          /* offer failed for this peer; the tile will stay disconnected */
        }
      }
      return
    }
    if (e.type === 'meetingPeerJoined') {
      // A newcomer arrived after me: prepare a connection but wait for their offer.
      ensurePeer(e.payload.peer.accountId, e.payload.peer.handle, e.payload.peer.firstName, e.payload.peer.lastName)
      // M1 — recording live and I started it: the newcomer is asked before a
      // single sample of theirs is captured (they join as 'pending').
      const me = useAccountStore.getState().account?.id ?? ''
      if (get().transcribing && get().recordingBy === me) {
        const myName = personDisplayName(useAccountStore.getState().account ?? {}, 'The host')
        const next = { ...get().consent, [e.payload.peer.accountId]: 'pending' as const }
        set({ consent: next })
        signalTo(e.payload.peer.accountId, { kind: 'consent-request', by: me, byName: myName })
        broadcastConsentState(next)
      }
      return
    }
    if (e.type === 'meetingPeerLeft') {
      recorder?.untap(e.payload.accountId)
      dropPeer(e.payload.accountId)
      return
    }
    if (e.type === 'meetingSignal') {
      const from = e.payload.from
      let data: {
        kind: string
        sdp?: RTCSessionDescriptionInit
        candidate?: RTCIceCandidateInit
        handle?: string
        on?: boolean
        sid?: string
      }
      try {
        data = JSON.parse(e.payload.data)
      } catch {
        return
      }
      // Screen announce/withdraw. Sent ahead of the renegotiation SDP so the
      // receiver knows which incoming stream id is a screen before ontrack fires.
      if (data.kind === 'screen') {
        if (data.on && data.sid) {
          announcedScreenSid.set(from, data.sid)
        } else {
          announcedScreenSid.delete(from)
          const p = get().participants[from]
          if (p && p.screenStream) {
            set({ participants: { ...get().participants, [from]: { ...p, screenStream: null } } })
          }
        }
        return
      }
      // M1 — the consent handshake rides the same relay as SDP/ICE (no server
      // changes). Handled before ensurePeer: consent messages must not mint
      // peer connections.
      if (isConsentWire(data as { kind?: string })) {
        const wire = data as unknown as ConsentWire
        if (wire.kind === 'consent-request') {
          // Someone started recording; I owe an answer. Until I give one I am
          // 'pending' and my audio is not captured anywhere.
          set({
            transcribing: true,
            recordingBy: wire.by,
            consentAsk: { by: wire.by, byName: wire.byName },
            consent: { ...get().consent, [wire.by]: 'accepted' }
          })
        } else if (wire.kind === 'consent-response') {
          const next = { ...get().consent, [from]: wire.choice }
          set({ consent: next })
          // If I hold the recorder and they consented, start capturing them NOW.
          if (recorder && mayCapture(wire.choice)) {
            const p = get().participants[from]
            if (p?.stream) recorder.tap(from, p.stream)
          }
          if (recorder && wire.choice === 'declined') recorder.untap(from)
        } else if (wire.kind === 'consent-state') {
          // The initiator's authoritative snapshot (so late joiners and every
          // header agree on the same words).
          set({ transcribing: true, recordingBy: wire.by, consent: wire.consent })
          const me = useAccountStore.getState().account?.id ?? ''
          if (wire.consent[me] === 'pending' && !get().consentAsk) {
            const initiator = get().participants[wire.by]
            set({ consentAsk: { by: wire.by, byName: initiator ? personDisplayName(initiator, initiator.handle) : 'The host' } })
          }
        } else if (wire.kind === 'recording-stopped') {
          set({ transcribing: false, recordingBy: null, consent: {}, consentAsk: null, liveOpen: false, liveLines: [] })
        }
        return
      }
      const existing = get().participants[from]
      const conn = ensurePeer(from, existing?.handle ?? from, existing?.firstName, existing?.lastName)
      if (data.kind === 'offer' && data.sdp) {
        // Perfect-negotiation-lite: if an offer collides with one I'm making,
        // the impolite peer ignores it and the polite peer accepts (Chromium
        // rolls back implicitly inside setRemoteDescription). The initial join
        // answerer is stable and not making an offer, so it never ignores.
        const offerCollision = conn.makingOffer || conn.pc.signalingState !== 'stable'
        if (!conn.polite && offerCollision) return
        try {
          await conn.pc.setRemoteDescription(data.sdp)
        } catch {
          return
        }
        await flush(conn)
        const answer = await conn.pc.createAnswer()
        await conn.pc.setLocalDescription(answer)
        signalTo(from, { kind: 'answer', sdp: answer })
        // If I am sharing my screen, this peer's base connection is now up, so
        // push the screen to them as a follow-up offer (the answer above could
        // not carry a new m-line). No-op if they already have it.
        if (get().sharingScreen) pushScreenTo(from)
      } else if (data.kind === 'answer' && data.sdp) {
        try {
          await conn.pc.setRemoteDescription(data.sdp)
        } catch {
          return
        }
        await flush(conn)
      } else if (data.kind === 'candidate' && data.candidate) {
        if (conn.pc.remoteDescription) {
          try {
            await conn.pc.addIceCandidate(data.candidate)
          } catch {
            /* non-fatal */
          }
        } else {
          conn.pending.push(data.candidate)
        }
      }
    }
  }

  return {
    roomId: null,
    title: null,
    status: 'idle',
    localStream: null,
    screenStream: null,
    sharingScreen: false,
    participants: {},
    muted: false,
    cameraOff: false,
    error: null,
    incomingInvite: null,
    ready: false,
    layout: 'stage',
    dockSide: loadDockSide(),
    transcribing: false,
    liveOpen: false,
    liveLines: [],
    recordingBy: null,
    consent: {},
    consentAsk: null,
    notes: '',
    moments: [],
    joinedAtMs: null,
    bodyDouble: null,
    introEndsAt: null,

    setLayout: (layout) => set({ layout }),
    setDockSide: (side) => {
      try {
        localStorage.setItem(DOCK_KEY, side)
      } catch {
        /* ignore */
      }
      set({ dockSide: side })
    },
    // M1 (S3-DEC-024) — start recording THROUGH consent, or stop one I
    // started. Starting: I consent by the act itself; everyone present is
    // prompted and captured only once they answer yes. No preference is
    // written here — a meeting recording is a per-meeting act, never a
    // default (the old code both persisted a global pref and captured every
    // peer instantly, untold; both behaviours are deliberately gone).
    setTranscribing: (on) => {
      // A body-double partner is a stranger: their session is never recorded.
      if (get().bodyDouble) return
      const me = useAccountStore.getState().account?.id ?? ''
      if (on && !recorder && get().status === 'in') {
        // M2 (CR-11) — meeting audio transcribes on-device, so warm the
        // local model NOW: the download/load cost is paid while the meeting
        // runs, never appended to its end. Fire-and-forget; a failure
        // surfaces at wrap-up with an honest error, not a silent cloud send.
        void window.api.voiceNote.preloadLocal().catch(() => {})
        recorder = new MeetingTrackRecorder()
        const local = get().localStream
        if (local) recorder.tap(me || 'me', local)
        const others = Object.keys(get().participants)
        const consent = initialConsent(me, others)
        set({ transcribing: true, recordingBy: me, consent })
        const myName = personDisplayName(useAccountStore.getState().account ?? {}, 'The host')
        for (const id of others) signalTo(id, { kind: 'consent-request', by: me, byName: myName })
      } else if (!on && recorder && get().recordingBy === me) {
        recorder.disableLive()
        void recorder.stop()
        recorder = null
        for (const id of Object.keys(get().participants)) signalTo(id, { kind: 'recording-stopped' })
        set({ transcribing: false, recordingBy: null, consent: {}, consentAsk: null, liveOpen: false, liveLines: [] })
      }
      // Anyone else's recording is not mine to stop; the button is disabled
      // for non-initiators in the UI, and this is the belt to that brace.
    },

    // M4 — the live pane owns the decode cost: opening it attaches the PCM
    // taps (consent inherited from the recorder's choke point), closing it
    // detaches them. Nothing decodes while nobody is watching.
    setLiveOpen: (open) => {
      set({ liveOpen: open })
      if (!recorder) return
      if (!open) {
        recorder.disableLive()
        return
      }
      const me = useAccountStore.getState().account?.id ?? ''
      recorder.enableLive((accountId, pcm) => {
        const atMs = Date.now() - (recorder?.startedAt ?? Date.now())
        void window.api.voiceNote
          .transcribeLive(pcm.buffer as ArrayBuffer)
          .then((r) => {
            if (!r.ok || !r.text) return
            const who =
              accountId === me || accountId === 'me'
                ? 'You'
                : personDisplayName(
                    get().participants[accountId] ?? {},
                    get().participants[accountId]?.handle ?? 'Someone'
                  )
            set({
              liveLines: [
                ...get().liveLines,
                { accountId, name: who, atMs, text: r.text }
              ].slice(-60)
            })
          })
          .catch(() => {})
      })
    },

    // My answer to someone else's recording. 'declined' means my audio is
    // never captured — enforced on the RECORDING client via the response
    // (their tap() choke point), and my own client never taps anything.
    answerConsent: (choice) => {
      const ask = get().consentAsk
      if (!ask) return
      const me = useAccountStore.getState().account?.id ?? ''
      set({ consentAsk: null, consent: { ...get().consent, [me]: choice } })
      for (const id of Object.keys(get().participants)) {
        signalTo(id, { kind: 'consent-response', choice })
      }
    },

    setNotes: (text) => set({ notes: text }),

    // ⌘⇧M — a timestamped anchor on the meeting clock. Needs no recording
    // and no model: offsets resolve against the transcript when it exists
    // (M2), and stand alone as "minute 14 mattered" until then.
    markMoment: () => {
      const t0 = recorder?.startedAt ?? get().joinedAtMs
      if (t0 == null) return
      set({ moments: [...get().moments, Date.now() - t0] })
    },

    init: () => {
      if (get().ready) return
      setMeetingSocketHandler((e) => void onSocket(e))
      set({ ready: true })
    },

    start: async (title) => {
      if (get().status !== 'idle') return null
      const roomId = genRoomId()
      await get().join(roomId, title)
      return get().status === 'in' ? roomId : null
    },

    join: async (roomId, title) => {
      if (get().status !== 'idle') return
      await enterRoom(roomId, title ?? null, { audio: true }, null)
    },

    // A body-double room docks to the side (collaborate) so the session sits
    // beside the work instead of covering it. The mic follows the mode.
    joinBodyDouble: async (roomId, room) => {
      if (get().status !== 'idle') {
        set({ error: 'Leave your current meeting to see your body double.' })
        return false
      }
      const plan = bodyDoubleMedia(room.mode)
      await enterRoom(roomId, bodyDoubleRoomTitle(room.partnerHandle), { audio: plan.audio }, room)
      if (get().status !== 'in' || get().roomId !== roomId) return false
      const local = get().localStream
      if (plan.startMuted) local?.getAudioTracks().forEach((t) => (t.enabled = false))
      set({ muted: plan.startMuted, layout: 'collaborate' })
      if (plan.introMs !== null) {
        set({ introEndsAt: Date.now() + plan.introMs })
        introTimer = setTimeout(() => {
          introTimer = null
          if (get().roomId !== roomId) return
          get().localStream?.getAudioTracks().forEach((t) => (t.enabled = false))
          set({ muted: true, introEndsAt: null })
        }, plan.introMs)
      }
      return true
    },

    invite: (peer) => {
      const { roomId, title } = get()
      if (!roomId) return
      // Nobody is rung into a body-double room (the server refuses it too).
      if (get().bodyDouble) return
      sendSocketMessage({ type: 'meetingInvite', payload: { roomId, to: peer.accountId, title: title ?? undefined } })
    },

    // Share a screen or window into the meeting. Opens the OS picker (via the
    // main-process display-media handler), then adds the screen track to every
    // peer and renegotiates. Switches to collaborate mode so the user can keep
    // navigating Plexii while it is shared, which is the point of sharing your
    // own workspace. Nothing is faked: if the user cancels the picker or denies
    // the OS permission, we surface that and stay unshared.
    startScreenShare: async () => {
      if (get().sharingScreen || get().status !== 'in') return
      // A stranger never sees your screen; body doubling shares presence only.
      if (get().bodyDouble) return
      let display: MediaStream
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      } catch {
        set({ error: 'Screen share was cancelled or not permitted.' })
        return
      }
      const track = display.getVideoTracks()[0]
      if (!track) {
        display.getTracks().forEach((t) => t.stop())
        return
      }
      // The OS "Stop sharing" overlay ends the track directly; mirror that back
      // into app state so the button and tiles update.
      track.onended = () => {
        void get().stopScreenShare()
      }
      // Set state first so pushScreenTo sees the stream, then deliver to every
      // current peer as a sharer-initiated renegotiation.
      set({ screenStream: display, sharingScreen: true, error: null, layout: 'collaborate' })
      for (const accountId of [...peers.keys()]) pushScreenTo(accountId)
    },

    stopScreenShare: () => {
      const display = get().screenStream
      if (!get().sharingScreen && !display) return
      for (const [accountId, conn] of peers) {
        const sender = screenSenders.get(accountId)
        if (sender) {
          try {
            conn.pc.removeTrack(sender)
          } catch {
            /* already gone */
          }
        }
        screenSenders.delete(accountId)
        signalTo(accountId, { kind: 'screen', on: false })
        void renegotiate(accountId)
      }
      display?.getTracks().forEach((t) => t.stop())
      set({ screenStream: null, sharingScreen: false })
    },

    toggleScreenShare: async () => {
      if (get().sharingScreen) get().stopScreenShare()
      else await get().startScreenShare()
    },

    leave: () => {
      const roomId = get().roomId
      const title = get().title || 'Meeting'
      const notes = get().notes
      const moments = get().moments
      const me = useAccountStore.getState().account?.id ?? ''
      // The initiator leaving ends the recording for everyone — say so.
      if (recorder && get().recordingBy === me) {
        for (const id of Object.keys(get().participants)) signalTo(id, { kind: 'recording-stopped' })
      }
      if (roomId) sendSocketMessage({ type: 'meetingLeave', payload: { roomId } })
      // Stop the recording and hand the take to the wrap-up: the mixed blob
      // feeds today's transcription; the per-track takes ride along as the
      // M2 foundation (attributed transcription).
      const rec = recorder
      recorder = null
      if (rec) {
        rec.disableLive()
        // M2 — resolve names for attribution NOW, from the roster we hold;
        // after teardown the map is gone.
        const speakers: Record<string, string> = {}
        const selfName = personDisplayName(useAccountStore.getState().account ?? {}, 'You')
        speakers[me || 'me'] = selfName
        if (me) speakers.me = selfName
        for (const p of Object.values(get().participants)) {
          speakers[p.accountId] = personDisplayName(p, p.handle)
        }
        // Q14 — the roster with handles survives teardown too, so a series
        // meeting's brief can be DM'd to the other attendees at wrap-up.
        const attendees = Object.values(get().participants).map((p) => ({
          accountId: p.accountId,
          handle: p.handle
        }))
        void rec.stop().then((take) => {
          if (take.mixed && take.mixed.durationSec >= 2) {
            void useWrapupStore.getState().begin({
              title,
              buffer: take.mixed.buffer,
              mimeType: take.mixed.mimeType,
              durationSec: take.mixed.durationSec,
              tracks: take.tracks,
              speakers,
              // CR-11 — this is MEETING audio: on-device only, no fallback.
              forceLocalTranscription: true,
              notes,
              moments,
              attendees
            })
          }
        })
      } else if (!get().bodyDouble && (notes.trim() || moments.length)) {
        // Notes without a recording are still the meeting's record — the
        // Stage is notes-first, recording-optional. Saved verbatim.
        void saveMeetingNotesDoc(title, notes, moments, Date.now())
      }
      teardown()
    },

    acceptInvite: async () => {
      const inv = get().incomingInvite
      if (!inv) return
      set({ incomingInvite: null })
      if (get().status !== 'idle') get().leave()
      await get().join(inv.roomId, inv.title ?? undefined)
    },

    dismissInvite: () => set({ incomingInvite: null }),

    toggleMute: () => {
      const s = get().localStream
      if (!s) return
      // Silent body doubling never opened a microphone; there is nothing to unmute.
      if (s.getAudioTracks().length === 0) return
      const next = !get().muted
      s.getAudioTracks().forEach((t) => (t.enabled = !next))
      set({ muted: next })
    },

    toggleCamera: () => {
      const s = get().localStream
      if (!s) return
      const next = !get().cameraOff
      s.getVideoTracks().forEach((t) => (t.enabled = !next))
      set({ cameraOff: next })
    }
  }
})

// Test-only handle so e2e specs can drive the meeting overlay (collaborate mode,
// dock side, screen share) without a real getUserMedia call, which is
// unavailable headless. Same convention as __fbView / __fbAgentRun: a thin
// handle to the real store.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbMeetingRoom?: typeof useMeetingRoomStore }).__fbMeetingRoom =
    useMeetingRoomStore
}
