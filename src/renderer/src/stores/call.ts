import { create } from 'zustand'
import { sendSocketMessage, setCallSocketHandler, type CallSocketEvent } from '../lib/messagingSocket'
import { notifyExternal } from '../lib/notify'
import { MeetingTrackRecorder } from '../lib/trackRecorder'
import { whisperEnabled } from '../lib/whisperPref'
import { mayCapture, type ConsentChoice, type ConsentEntry } from '../lib/meetingConsent'
import { useAccountStore } from './account'
import { useWrapupStore } from './wrapup'
import { personDisplayName } from '../lib/personName'
import { entitlementFor } from '../lib/entitlementReason'
import { promptUpgrade } from './upgradePrompt'

// PlexiCam: peer-to-peer live audio/video calls. The signal server only relays
// the SDP offer/answer and ICE candidates between two accounts in the same
// presence audience; the media itself flows directly peer to peer (the server
// never sees it). This is a 1:1 mesh call. It uses public STUN for NAT
// discovery, which works on most home and office networks. Reliable traversal of
// symmetric NATs and large multi-party rooms need a TURN server and an SFU; those
// are a server-infrastructure phase, not built here, and the UI says so honestly
// rather than pretending a call connected when it could not.

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]

export type CallStatus = 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected' | 'ended'
export type CallMedia = 'audio' | 'video'

interface Peer {
  accountId: string
  handle: string
  firstName?: string | null
  lastName?: string | null
}

interface CallStore {
  status: CallStatus
  callId: string | null
  peer: Peer | null
  media: CallMedia
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  muted: boolean
  cameraOff: boolean
  error: string | null
  // ── Calls consent (the M1 rule, 1:1-reduced). The old behaviour was the
  // SAME hole M1 closed for meetings: one side's whisper preference silently
  // recorded both voices, and the peer was never told. Now the preference
  // only expresses MY intent — it asks; it never captures the other side.
  /** True while this call is being recorded (by either side's machine). */
  transcribing: boolean
  /** Who is recording: 'me' (this machine holds the recorder) or 'peer'
   *  (their machine does — my client records nothing). */
  recordingBy: 'me' | 'peer' | null
  /** The peer's answer to MY request, when recordingBy === 'me'. */
  peerConsent: ConsentEntry | null
  /** A consent prompt awaiting MY answer, when the peer asked. */
  consentAsk: { byName: string } | null
  // True once init() has wired the socket handler, so we never double-register.
  ready: boolean

  init: () => void
  startCall: (peer: Peer, media: CallMedia) => Promise<void>
  accept: () => Promise<void>
  decline: () => void
  hangup: () => void
  toggleMute: () => void
  toggleCamera: () => void
  /** My answer to the peer's transcription request. */
  answerCallConsent: (choice: ConsentChoice) => void
  /** Requester-only: stop capturing now; the take still wraps up at call end. */
  stopTranscribing: () => void
}

// Non-serializable call internals live outside the store. Which side creates the
// offer is decided by the events received (the caller offers on callAccepted, the
// callee answers on receiving the offer), so no explicit role flag is needed.
let pc: RTCPeerConnection | null = null
// ICE candidates that arrive before the remote description is set are buffered.
let pendingCandidates: RTCIceCandidateInit[] = []
// The per-track call recorder (the M1/C1 foundation, reused): my mic and the
// peer's stream are separate attributed takes on one clock — the peer's is
// tapped ONLY once they consent. Exists only on the requesting side.
let recorder: MeetingTrackRecorder | null = null
// A take stopped mid-call (stopTranscribing) waits here for the wrap-up.
let heldTake: Awaited<ReturnType<MeetingTrackRecorder['stop']>> | null = null

function genCallId(): string {
  return `call-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

function signal(to: string, callId: string, data: unknown): void {
  sendSocketMessage({ type: 'callSignal', payload: { callId, to, data: JSON.stringify(data) } })
}

export const useCallStore = create<CallStore>((set, get) => {
  // Tear down the peer connection and local media, returning to idle.
  function cleanup(nextStatus: CallStatus): void {
    // Wrap up the call: stop the recording and, when the call actually ended
    // (not a decline), hand the audio to the summary + deliverables flow.
    if (recorder || heldTake) {
      const rec = recorder
      recorder = null
      const held = heldTake
      heldTake = null
      if (nextStatus === 'ended') {
        const title = `Call with ${personDisplayName(get().peer, 'someone')}`
        const peerName = personDisplayName(get().peer, 'Them')
        void (held ? Promise.resolve(held) : rec!.stop()).then((take) => {
          if (take.mixed && take.mixed.durationSec >= 2) {
            // The call rides the meeting pipeline now: attributed per-track
            // takes, on-device transcription (a consented recording must not
            // grow a silent third-party disclosure), the Record, the confirm
            // stop. begin() resolves errors internally; .catch is belt-and-
            // braces so nothing surfaces as unhandled after the call.
            void useWrapupStore
              .getState()
              .begin({
                title,
                buffer: take.mixed.buffer,
                mimeType: take.mixed.mimeType,
                durationSec: take.mixed.durationSec,
                tracks: take.tracks,
                speakers: { me: 'You', [get().peer?.accountId ?? 'peer']: peerName },
                forceLocalTranscription: true
              })
              .catch(() => {})
          }
        })
      } else if (rec) {
        void rec.stop()
      }
    }
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      try {
        pc.close()
      } catch {
        /* already closed */
      }
      pc = null
    }
    get().localStream?.getTracks().forEach((t) => t.stop())
    pendingCandidates = []
    set({
      status: nextStatus,
      localStream: null,
      remoteStream: null,
      muted: false,
      cameraOff: false,
      transcribing: false,
      recordingBy: null,
      peerConsent: null,
      consentAsk: null
    })
    // After a brief ended state, reset to idle so the overlay can dismiss.
    if (nextStatus === 'ended') {
      window.setTimeout(() => {
        if (get().status === 'ended') set({ status: 'idle', callId: null, peer: null, error: null })
      }, 1500)
    }
  }

  async function getMedia(media: CallMedia): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: media === 'video' })
  }

  // Build the RTCPeerConnection, attach local tracks, and wire ICE + remote track
  // handling. Shared by both the caller and the callee.
  function buildPc(peer: Peer, callId: string, local: MediaStream): RTCPeerConnection {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    for (const track of local.getTracks()) conn.addTrack(track, local)
    conn.onicecandidate = (e) => {
      if (e.candidate) signal(peer.accountId, callId, { kind: 'candidate', candidate: e.candidate.toJSON() })
    }
    const remote = new MediaStream()
    conn.ontrack = (e) => {
      for (const track of e.streams[0]?.getTracks() ?? [e.track]) remote.addTrack(track)
      // The peer's audio is deliberately NOT tapped here — capture waits
      // for their consent-response (see the callSignal consent branch). The
      // one exception: consent already arrived and the media came later
      // (renegotiation) — then the standing yes is applied to the new stream.
      if (get().recordingBy === 'me' && mayCapture(get().peerConsent ?? undefined) && recorder) {
        recorder.tap(peer.accountId, remote)
      }
      set({ remoteStream: remote })
    }
    conn.onconnectionstatechange = () => {
      const st = conn.connectionState
      if (st === 'connected') {
        set({ status: 'connected' })
        // My whisper preference expresses MY intent only. It starts a
        // recorder that captures MY mic, and it ASKS the peer — their stream
        // is tapped when (and only when) their consent arrives. The old code
        // captured both voices here, silently; that was the M1 hole in 1:1
        // form, and it is closed the same way: capture-on-answer, decline
        // honoured by construction (never tapped).
        if (whisperEnabled() && !recorder) {
          recorder = new MeetingTrackRecorder()
          recorder.tap('me', local)
          const myName = personDisplayName(useAccountStore.getState().account ?? {}, 'Your contact')
          set({ transcribing: true, recordingBy: 'me', peerConsent: 'pending' })
          signal(peer.accountId, callId, { kind: 'consent-request', byName: myName })
        }
      }
      else if (st === 'failed') {
        set({ error: 'The connection failed. Your network may need a TURN server.' })
        cleanup('ended')
      } else if (st === 'disconnected' || st === 'closed') {
        if (get().status !== 'ended') cleanup('ended')
      }
    }
    return conn
  }

  async function flushPendingCandidates(): Promise<void> {
    if (!pc) return
    for (const c of pendingCandidates) {
      try {
        await pc.addIceCandidate(c)
      } catch {
        /* a malformed candidate is non-fatal */
      }
    }
    pendingCandidates = []
  }

  async function onSocket(e: CallSocketEvent): Promise<void> {
    const state = get()
    if (e.type === 'callIncoming') {
      // Ignore a second incoming call while already busy: decline it honestly.
      if (state.status !== 'idle') {
        sendSocketMessage({ type: 'callDecline', payload: { callId: e.payload.callId, to: e.payload.from.accountId } })
        return
      }
      set({
        status: 'incoming',
        callId: e.payload.callId,
        peer: e.payload.from,
        media: e.payload.media,
        error: null
      })
      // Alert even if the app is focused — an incoming call is interruptive by
      // nature. Clicking just brings the window forward; the overlay handles answer.
      notifyExternal(`Incoming ${e.payload.media} call`, `${personDisplayName(e.payload.from, 'Someone')} is calling`, {
        force: true,
        tag: `call-${e.payload.callId}`
      })
      return
    }
    // All other events must match the active call.
    if (!state.callId || e.payload.callId !== state.callId) return
    if (e.type === 'callDeclined') {
      set({ status: 'ended', error: `${personDisplayName(state.peer, 'They')} declined the call.` })
      cleanup('ended')
      return
    }
    if (e.type === 'callEnded') {
      cleanup('ended')
      return
    }
    if (e.type === 'callAccepted') {
      // The callee accepted: the caller now creates and sends the offer.
      if (!pc || !state.peer) return
      set({ status: 'connecting' })
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      signal(state.peer.accountId, state.callId, { kind: 'offer', sdp: offer })
      return
    }
    if (e.type === 'callSignal') {
      if (!state.peer) return
      let data: { kind: string; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
      try {
        data = JSON.parse(e.payload.data)
      } catch {
        return
      }
      if (data.kind === 'offer' && data.sdp) {
        // Callee receives the offer, answers it.
        if (!pc) return
        set({ status: 'connecting' })
        await pc.setRemoteDescription(data.sdp)
        await flushPendingCandidates()
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        signal(state.peer.accountId, state.callId, { kind: 'answer', sdp: answer })
      } else if (data.kind === 'answer' && data.sdp) {
        if (!pc) return
        await pc.setRemoteDescription(data.sdp)
        await flushPendingCandidates()
      } else if (data.kind === 'candidate' && data.candidate) {
        if (pc && pc.remoteDescription) {
          try {
            await pc.addIceCandidate(data.candidate)
          } catch {
            /* non-fatal */
          }
        } else {
          pendingCandidates.push(data.candidate)
        }
      } else if (data.kind === 'consent-request') {
        // The peer wants their machine to transcribe this call. My own
        // whisper preference is a standing yes ("transcribe & summarise my
        // 1:1 calls") — it answers for me; otherwise the modal asks. Both-on
        // calls simply record on both machines, each side consented.
        const byName = (data as { byName?: string }).byName || personDisplayName(state.peer, 'Your contact')
        if (whisperEnabled()) {
          signal(state.peer.accountId, state.callId, { kind: 'consent-response', choice: 'accepted' })
          if (get().recordingBy !== 'me') set({ transcribing: true, recordingBy: 'peer' })
        } else {
          set({ consentAsk: { byName } })
        }
      } else if (data.kind === 'consent-response') {
        // Their answer to MY request. Capture starts HERE, never before —
        // and a decline means their stream is simply never tapped: the call
        // continues, the record holds only my side.
        const choice = (data as { choice?: ConsentChoice }).choice
        if (get().recordingBy !== 'me' || !choice) return
        set({ peerConsent: choice })
        if (mayCapture(choice) && recorder && get().remoteStream) {
          recorder.tap(state.peer.accountId, get().remoteStream)
        }
      } else if (data.kind === 'recording-stopped') {
        // The requester stopped capturing (or their side reset).
        if (get().recordingBy === 'peer') set({ transcribing: false, recordingBy: null })
      }
    }
  }

  return {
    status: 'idle',
    callId: null,
    peer: null,
    media: 'video',
    localStream: null,
    remoteStream: null,
    muted: false,
    cameraOff: false,
    error: null,
    transcribing: false,
    recordingBy: null,
    peerConsent: null,
    consentAsk: null,
    ready: false,

    init: () => {
      if (get().ready) return
      setCallSocketHandler((e) => void onSocket(e))
      set({ ready: true })
    },

    startCall: async (peer, media) => {
      if (get().status !== 'idle') return
      // Placing a call needs the 'calls' capability. Answering an incoming call
      // is not gated here (accept/decline are separate), only initiating one.
      const ent = entitlementFor('calls', 'Calls')
      if (!ent.enabled) {
        promptUpgrade(ent.reason)
        return
      }
      const callId = genCallId()
      set({ status: 'calling', callId, peer, media, error: null, remoteStream: null })
      try {
        const local = await getMedia(media)
        set({ localStream: local })
        pc = buildPc(peer, callId, local)
        sendSocketMessage({ type: 'callInvite', payload: { callId, to: peer.accountId, media } })
      } catch {
        set({ status: 'ended', error: 'Could not access your microphone or camera. Check system permissions.' })
        cleanup('ended')
      }
    },

    accept: async () => {
      const { status, peer, callId, media } = get()
      if (status !== 'incoming' || !peer || !callId) return
      try {
        const local = await getMedia(media)
        set({ localStream: local, status: 'connecting' })
        pc = buildPc(peer, callId, local)
        // Tell the caller we accepted; they will send the offer.
        sendSocketMessage({ type: 'callAccept', payload: { callId, to: peer.accountId } })
      } catch {
        sendSocketMessage({ type: 'callDecline', payload: { callId, to: peer.accountId } })
        set({ status: 'ended', error: 'Could not access your microphone or camera. Check system permissions.' })
        cleanup('ended')
      }
    },

    decline: () => {
      const { peer, callId } = get()
      if (peer && callId) sendSocketMessage({ type: 'callDecline', payload: { callId, to: peer.accountId } })
      cleanup('idle')
      set({ callId: null, peer: null })
    },

    hangup: () => {
      const { peer, callId } = get()
      if (peer && callId) sendSocketMessage({ type: 'callEnd', payload: { callId, to: peer.accountId } })
      cleanup('ended')
    },

    answerCallConsent: (choice) => {
      const { peer, callId, consentAsk } = get()
      if (!consentAsk || !peer || !callId) return
      set({ consentAsk: null })
      signal(peer.accountId, callId, { kind: 'consent-response', choice })
      if (mayCapture(choice)) set({ transcribing: true, recordingBy: 'peer' })
    },

    stopTranscribing: () => {
      const { peer, callId, recordingBy } = get()
      if (recordingBy !== 'me' || !recorder) return
      const rec = recorder
      recorder = null
      // The take-so-far survives to the wrap-up at call end; capture stops NOW.
      void rec.stop().then((take) => {
        heldTake = take
      })
      if (peer && callId) signal(peer.accountId, callId, { kind: 'recording-stopped' })
      set({ transcribing: false, recordingBy: null, peerConsent: null })
    },

    toggleMute: () => {
      const s = get().localStream
      if (!s) return
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

// Test-only handle so e2e specs can drive the call overlay (incoming, connected) without a peer or a real
// getUserMedia, neither of which exists headless.
// Same convention as __fbView / __fbMeetingRoom: a thin handle to the real
// store, so a spec drives the product rather than a stand-in for it.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbCall?: typeof useCallStore }).__fbCall = useCallStore
}
