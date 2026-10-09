import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon'
import { useMeetingRoomStore, type DockSide } from '../stores/meetingRoom'
import { consentSummary } from '../lib/meetingConsent'
import { getMeetingOrigin } from '../lib/startMeeting'
import type { MeetingPrep } from '@shared/meetings'
import { useAccountStore } from '../stores/account'
import { useVideoBlocked, CAMERA_BLOCKED_HINT } from '../lib/useVideoBlocked'
import { usePresenceStore } from '../stores/presence'
import { personDisplayName, personInitials } from '../lib/personName'
import { usePeerBodyDoubleStore } from '../stores/peerBodyDouble'
import type { BodyDoubleMode } from '@shared/types'

// PlexiMeet live room, mounted once at the app root. Two presentations:
//  - 'stage': the classic fullscreen room (video gallery + controls).
//  - 'collaborate': the meeting docks to one edge as a movable panel so the rest
//    of Plexii stays the focus and the user can navigate anywhere while the call
//    keeps running (the room lives in a global store, so it survives navigation).
// Nothing is faked: a tile shows "connecting" until its peer connection is up,
// and a peer that drops is removed rather than frozen.
//
// A body-double room (store.bodyDouble) is the same room with a narrower door:
// the partner is a stranger, so recording, invites, screen sharing and the
// notes pane are not offered; the microphone follows the agreed mode; and
// leaving ends the body-double session itself, with an option to block.

// The mode, stated in words in the room, so neither side has to remember what
// they agreed to. Greetings counts its intro down, then says the mic is off.
function bodyDoubleModeLine(mode: BodyDoubleMode, introLeftMs: number | null, muted: boolean): string {
  switch (mode) {
    case 'silent':
      return 'Silent · no microphone, just company'
    case 'greetings': {
      if (introLeftMs !== null && introLeftMs > 0) {
        const s = Math.ceil(introLeftMs / 1000)
        return `Intros · your mic mutes in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
      }
      return muted ? 'Intros done · mic muted, unmute to say goodbye' : 'Intros done · mic is on'
    }
    case 'light':
      return muted ? 'A little chat · mic muted, unmute for a quick word' : 'A little chat · mic is on'
    case 'open':
      return 'Happy to talk · mic and chat are open'
  }
}

function Video({
  stream,
  muted,
  mirrored,
  contain
}: {
  stream: MediaStream | null
  muted?: boolean
  mirrored?: boolean
  // Screens are shown whole (object-contain) so nothing is cropped; camera tiles
  // fill their frame (object-cover).
  contain?: boolean
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    // DEC-078 — autoPlay alone does NOT start playback in this Electron build
    // when srcObject lands after mount: the element stayed paused at
    // readyState 0 with a live, enabled track attached (measured over CDP),
    // which is exactly "video never turns on". VoiceRecorderWidget learned
    // the same lesson earlier and plays explicitly; these tiles now do too.
    if (stream) {
      void el.play().catch(() => {
        // A rejected play (rare) retries once metadata arrives.
        el.onloadedmetadata = () => {
          el.onloadedmetadata = null
          void el.play().catch(() => {})
        }
      })
    }
  }, [stream])
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full ${contain ? 'object-contain' : 'object-cover'} ${mirrored ? 'scale-x-[-1]' : ''}`}
    />
  )
}

function ControlButton({
  icon,
  label,
  active,
  danger,
  small,
  onClick
}: {
  icon: string
  label: string
  active?: boolean
  danger?: boolean
  small?: boolean
  onClick: () => void
}): JSX.Element {
  const size = small ? 'h-9 w-9' : 'h-11 w-11'
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex ${size} items-center justify-center rounded-full fb-press transition-colors shadow-[inset_0_1px_0_rgb(255_255_255/0.12)] ${
        danger
          ? 'bg-gradient-to-b from-rose-500 to-rose-600 text-white hover:from-rose-400'
          : active
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-white/10 text-white hover:bg-white/20'
      }`}
    >
      <Icon name={icon} size={small ? 17 : 20} />
    </button>
  )
}

export default function MeetingOverlay(): JSX.Element | null {
  const status = useMeetingRoomStore((s) => s.status)
  const title = useMeetingRoomStore((s) => s.title)
  const localStream = useMeetingRoomStore((s) => s.localStream)
  const screenStream = useMeetingRoomStore((s) => s.screenStream)
  const sharingScreen = useMeetingRoomStore((s) => s.sharingScreen)
  const participants = useMeetingRoomStore((s) => s.participants)
  const muted = useMeetingRoomStore((s) => s.muted)
  const cameraOff = useMeetingRoomStore((s) => s.cameraOff)
  const error = useMeetingRoomStore((s) => s.error)
  const incomingInvite = useMeetingRoomStore((s) => s.incomingInvite)
  const layout = useMeetingRoomStore((s) => s.layout)
  const dockSide = useMeetingRoomStore((s) => s.dockSide)
  const transcribing = useMeetingRoomStore((s) => s.transcribing)
  const recordingBy = useMeetingRoomStore((s) => s.recordingBy)
  const liveLines = useMeetingRoomStore((s) => s.liveLines)
  const setLiveOpen = useMeetingRoomStore((s) => s.setLiveOpen)
  const consent = useMeetingRoomStore((s) => s.consent)
  const consentAsk = useMeetingRoomStore((s) => s.consentAsk)
  const notes = useMeetingRoomStore((s) => s.notes)
  const moments = useMeetingRoomStore((s) => s.moments)
  const setNotes = useMeetingRoomStore((s) => s.setNotes)
  const markMoment = useMeetingRoomStore((s) => s.markMoment)
  const answerConsent = useMeetingRoomStore((s) => s.answerConsent)
  const leave = useMeetingRoomStore((s) => s.leave)
  const invite = useMeetingRoomStore((s) => s.invite)
  const toggleMute = useMeetingRoomStore((s) => s.toggleMute)
  const toggleCamera = useMeetingRoomStore((s) => s.toggleCamera)
  const acceptInvite = useMeetingRoomStore((s) => s.acceptInvite)
  const dismissInvite = useMeetingRoomStore((s) => s.dismissInvite)
  const setLayout = useMeetingRoomStore((s) => s.setLayout)
  const setDockSide = useMeetingRoomStore((s) => s.setDockSide)
  const setTranscribing = useMeetingRoomStore((s) => s.setTranscribing)
  const toggleScreenShare = useMeetingRoomStore((s) => s.toggleScreenShare)
  const bodyDouble = useMeetingRoomStore((s) => s.bodyDouble)
  const introEndsAt = useMeetingRoomStore((s) => s.introEndsAt)
  const endBodyDouble = usePeerBodyDoubleStore((s) => s.endSession)
  const blockBodyDouble = usePeerBodyDoubleStore((s) => s.blockPartner)

  // Greetings: tick once a second while the intro counts down.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (introEndsAt === null) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [introEndsAt])
  const modeLine = bodyDouble
    ? bodyDoubleModeLine(bodyDouble.mode, introEndsAt === null ? null : introEndsAt - now, muted)
    : null

  const presencePeers = usePresenceStore((s) => s.peers)
  const [showInvite, setShowInvite] = useState(false)
  // M1 — the Stage is notes-first: the pane opens with the room (stage
  // layout) and its content is the highest-signal input the system gets.
  const [showNotes, setShowNotes] = useState(true)
  const [showTranscriptNote, setShowTranscriptNote] = useState(false)
  const myId = useAccountStore((s) => s.account?.id ?? '')
  // DEC-078 — a live-but-muted local video track means the OS is refusing
  // frames (TCC denial): show the honest state, never a black rectangle.
  const cameraBlocked = useVideoBlocked(localStream)

  const remote = useMemo(() => Object.values(participants), [participants])

  // M1 (§3.8) — the state, named in words, continuously. Never an icon alone.
  const consentLine = useMemo(() => {
    const nameOf = (id: string): string => {
      if (id === myId) return 'you'
      const p = participants[id]
      return p ? personDisplayName(p, p.handle) : 'someone'
    }
    return consentSummary(transcribing, consent, nameOf)
  }, [transcribing, consent, participants, myId])

  // M1 — the Stage grammar: ⌘⇧M marks the moment without breaking typing;
  // ⌘⇧T answers honestly about the transcript. Active for the whole meeting.
  useEffect(() => {
    if (status !== 'in') return
    function onKey(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      if (e.key.toLowerCase() === 'm') {
        e.preventDefault()
        markMoment()
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        setShowTranscriptNote((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, markMoment])

  // M4 — the live tap follows the pane: decode runs only while the initiator
  // has the transcript pane open. Closing it (or the recording ending)
  // detaches every processor — the cost is view-driven, never ambient.
  useEffect(() => {
    const wantLive = showTranscriptNote && transcribing && recordingBy === myId
    setLiveOpen(wantLive)
    return () => setLiveOpen(false)
  }, [showTranscriptNote, transcribing, recordingBy, myId, setLiveOpen])

  const liveScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = liveScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [liveLines])

  // M5 (P5) — staging: when the room came from a booked calendar block, the
  // Stage assembles prep from database facts — the agenda, the previous
  // instance's still-open items, and each attendee's open items. Fetched
  // once per room; an ad-hoc meeting has no origin block and shows nothing.
  const [prep, setPrep] = useState<MeetingPrep | null>(null)
  const [prepOpen, setPrepOpen] = useState(true)
  useEffect(() => {
    if (status !== 'in') {
      setPrep(null)
      return
    }
    const origin = getMeetingOrigin()
    if (origin?.kind !== 'calendar') return
    if (!origin.seriesId && !origin.agenda && !origin.invitees?.length) return
    if (typeof window.api.meetings.prep !== 'function') return
    let alive = true
    void window.api.meetings
      .prep({ seriesId: origin.seriesId ?? null, invitees: origin.invitees ?? [], agenda: origin.agenda ?? null })
      .then((data) => {
        if (!alive) return
        if (data.agenda || data.carried.length || data.attendees.length) setPrep(data)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [status])

  // Active screen shares to present: my own (when sharing) plus any peer who is
  // presenting. These render whole (object-contain), separate from camera tiles.
  const screens = useMemo(() => {
    const list: Array<{ id: string; label: string; stream: MediaStream; me: boolean }> = []
    if (sharingScreen && screenStream) list.push({ id: 'me', label: 'You', stream: screenStream, me: true })
    for (const p of remote) {
      if (p.screenStream) list.push({ id: p.accountId, label: personDisplayName(p, p.handle), stream: p.screenStream, me: false })
    }
    return list
  }, [sharingScreen, screenStream, remote])
  const invitable = useMemo(
    () => Object.values(presencePeers).filter((p) => !participants[p.accountId]),
    [presencePeers, participants]
  )

  // Escape leaves the meeting ONLY in stage mode. In collaborate mode the user is
  // navigating Plexii with the meeting docked, so Escape must not drop the call.
  // A body-double session is never ended by a stray Escape: it docks instead.
  useEffect(() => {
    if (status === 'idle' || layout !== 'stage') return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (bodyDouble) setLayout('collaborate')
      else leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, layout, leave, bodyDouble, setLayout])

  // Incoming invite while not in a room: a compact ringing card.
  if (status === 'idle' && incomingInvite) {
    return (
      // Video stage: forced-dark chrome; white hairlines are relative to the stage, not the theme.
      <div className="fixed bottom-5 right-5 z-[200] w-[320px] rounded-2xl bg-stone-900 text-white shadow-2xl border border-white/10 p-4" data-testid="meeting-invite">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-[15px] font-semibold">
            {personInitials(incomingInvite.from)}
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold truncate">{personDisplayName(incomingInvite.from, 'Someone')}</p>
            <p className="text-[12px] text-white/60 truncate">invited you to {incomingInvite.title ?? 'a meeting'}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button onClick={dismissInvite} data-testid="meeting-invite-dismiss" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white/10 text-white text-[13px] font-medium hover:bg-white/20">
            Dismiss
          </button>
          <button onClick={() => void acceptInvite()} data-testid="meeting-invite-join" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-500 text-white text-[13px] font-medium hover:bg-emerald-600">
            <Icon name="video_call" size={16} /> Join
          </button>
        </div>
      </div>
    )
  }

  if (status === 'idle') return null

  const tileCount = remote.length + 1
  const collaborate = layout === 'collaborate'
  const horizontal = collaborate && (dockSide === 'top' || dockSide === 'bottom')

  const invitePicker = showInvite && (
    <>
      <div className="fixed inset-0 z-[201]" onClick={() => setShowInvite(false)} />
      <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[202] w-64 rounded-xl bg-stone-800 border border-white/10 shadow-xl p-2 max-h-72 overflow-auto" data-testid="meeting-invite-picker">
        <p className="px-2 py-1 text-[11px] text-white/50">Invite a teammate who is online</p>
        {invitable.length === 0 ? (
          <p className="px-2 py-3 text-[12px] text-white/50 text-center">No teammates online to invite right now.</p>
        ) : (
          invitable.map((p) => (
            <button
              key={p.accountId}
              onClick={() => { invite({ accountId: p.accountId, handle: p.handle }); setShowInvite(false) }}
              data-testid={`meeting-invite-${p.accountId}`}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/10 text-left"
            >
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-white">{personInitials(p)}</span>
              <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] text-white truncate">{personDisplayName(p, p.handle)}</span>
                {(p.status === 'away' || p.status === 'busy') && <span className="block text-[10px] text-white/40">{p.status}</span>}
              </span>
              <Icon name="add" size={15} className="text-white/60" />
            </button>
          ))
        )}
      </div>
    </>
  )

  // Self + remote camera tiles, shared by all layouts. 'grid' is the full stage
  // grid, 'mini' the docked panel, 'strip' the horizontal filmstrip shown under a
  // presentation.
  const tiles = (variant: 'grid' | 'mini' | 'strip'): JSX.Element => {
    const compact = variant !== 'grid'
    const frame =
      variant === 'grid'
        ? 'min-h-[140px]'
        : variant === 'strip'
          ? 'h-full w-auto aspect-video shrink-0'
          : horizontal
            ? 'h-full aspect-video shrink-0'
            : 'w-full shrink-0 aspect-video'
    const avatar = compact ? 'h-10 w-10 text-[15px]' : 'h-16 w-16 text-[22px]'
    return (
      <>
        <div className={`relative rounded-xl overflow-hidden bg-stone-900 border border-white/10 ${frame}`}>
          {localStream && !cameraOff && !cameraBlocked ? (
            <Video stream={localStream} muted mirrored />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5" title={cameraBlocked ? CAMERA_BLOCKED_HINT : undefined}>
              <span className={`inline-flex ${avatar} items-center justify-center rounded-full bg-white/10 font-semibold text-white`}>You</span>
              {cameraBlocked && !cameraOff && (
                <span
                  className="inline-flex items-center gap-1 text-[10.5px] text-amber-300/90 bg-amber-500/10 rounded px-1.5 py-0.5"
                  data-testid="camera-blocked-note"
                >
                  <Icon name="videocam_off" size={11} /> Camera blocked by macOS
                </span>
              )}
            </div>
          )}
          <span className="absolute bottom-1.5 left-1.5 text-[11px] text-white/90 bg-black/40 rounded px-1.5 py-0.5">You{muted ? ' · muted' : ''}</span>
        </div>
        {remote.map((p) => (
          <div key={p.accountId} className={`relative rounded-xl overflow-hidden bg-stone-900 border border-white/10 ${frame}`} data-testid={`meeting-tile-${p.accountId}`}>
            {p.stream ? (
              <Video stream={p.stream} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <span className={`inline-flex ${avatar} items-center justify-center rounded-full bg-white/10 font-semibold text-white`}>{personInitials(p)}</span>
                <span className="text-[11px] text-white/50">{p.connected ? 'No video' : 'Connecting…'}</span>
              </div>
            )}
            <span className="absolute bottom-1.5 left-1.5 text-[11px] text-white/90 bg-black/40 rounded px-1.5 py-0.5">{personDisplayName(p, p.handle)}</span>
          </div>
        ))}
      </>
    )
  }

  // Screen-share tiles, shown whole. `mini` sizes them for the docked panel.
  const screenTiles = (mini: boolean): JSX.Element => (
    <>
      {screens.map((s) => (
        <div
          key={`screen-${s.id}`}
          className={`relative rounded-xl overflow-hidden bg-black border border-rose-400/30 ${mini ? (horizontal ? 'h-full aspect-video shrink-0' : 'w-full shrink-0 aspect-video') : 'min-h-[140px]'}`}
          data-testid={`meeting-screen-${s.id}`}
        >
          <Video stream={s.stream} muted={s.me} contain />
          <span className="absolute bottom-1.5 left-1.5 text-[11px] text-white/90 bg-black/50 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
            <Icon name="screen_share" size={12} className="text-rose-300" />
            {s.me ? 'Your screen' : `${s.label} · screen`}
          </span>
        </div>
      ))}
    </>
  )

  // M1 (§3.8) — someone wants to record: ask, in the room, before a sample
  // of your audio is captured. Three honest answers; no fourth.
  const consentModal = consentAsk && (
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50" data-testid="consent-modal">
      <div className="w-[380px] rounded-2xl bg-stone-900 text-white border border-white/10 shadow-2xl p-5">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-rose-500/20">
            <Icon name="radio_button_checked" size={18} className="text-rose-400" />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">{consentAsk.byName} wants to record</p>
            <p className="text-[12px] text-white/60">Nothing of yours is captured until you answer.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-1.5">
          <button
            onClick={() => answerConsent('accepted')}
            data-testid="consent-accept"
            className="h-10 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-[13px] font-semibold"
          >
            Record me
          </button>
          <button
            onClick={() => answerConsent('no-transcript')}
            data-testid="consent-no-transcript"
            className="h-10 rounded-lg bg-white/10 hover:bg-white/20 text-[13px]"
            title="Your audio is recorded for replay, but excluded from the written transcript"
          >
            Record me, but leave me out of the transcript
          </button>
          <button
            onClick={() => answerConsent('declined')}
            data-testid="consent-decline"
            className="h-10 rounded-lg bg-white/10 hover:bg-white/20 text-[13px] text-white/80"
            title="Your audio is never captured — the record will say so"
          >
            Don’t record me
          </button>
        </div>
      </div>
    </div>
  )

  // M1 — the Stage pane: a notepad, not a transcript viewer. Blank by
  // default; your words are saved verbatim and never rewritten.
  const fmtMoment = (ms: number): string => {
    const s = Math.floor(ms / 1000)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  const notesPane = (
    <div className="w-[300px] shrink-0 flex flex-col rounded-xl bg-stone-900/90 border border-white/10 overflow-hidden" data-testid="meeting-notes-pane">
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-chip)] bg-white/10 text-white/80">
          <Icon name="edit_note" size={14} />
        </span>
        <span className="text-[12px] font-semibold text-white/90 flex-1 tracking-tight">Notes — yours, verbatim</span>
        {moments.length > 0 && (
          <span className="text-[10.5px] text-amber-300/90" data-testid="moment-count">⚑ {moments.length}</span>
        )}
      </div>
      {prep && (
        <div className="border-b border-white/10" data-testid="meeting-prep">
          <button
            onClick={() => setPrepOpen((v) => !v)}
            className="w-full px-3 py-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wider text-white/50 hover:text-white/80"
            data-testid="meeting-prep-toggle"
          >
            <Icon name={prepOpen ? 'expand_more' : 'chevron_right'} size={13} />
            PREP
          </button>
          {prepOpen && (
            <div className="px-3 pb-2 max-h-[180px] overflow-y-auto space-y-2">
              {prep.agenda && (
                <div className="text-[11.5px] text-white/70 leading-snug" data-testid="prep-agenda">
                  <span className="text-white/40">To settle:</span> {prep.agenda}
                </div>
              )}
              {prep.carried.length > 0 && (
                <div data-testid="prep-carried">
                  <div className="text-[10px] text-white/40 mb-0.5">
                    Carried from {prep.lastMeeting?.title || 'last time'} — still open
                  </div>
                  {prep.carried.slice(0, 6).map((it) => (
                    <div key={it.id} className="text-[11.5px] text-white/70 leading-snug truncate">
                      · {it.title}
                    </div>
                  ))}
                </div>
              )}
              {prep.attendees.map((a) => (
                <div key={a.invitee} data-testid="prep-attendee">
                  <div className="text-[10px] text-white/40 mb-0.5">Open with {a.invitee}</div>
                  {a.items.slice(0, 3).map((it) => (
                    <div key={it.id} className="text-[11.5px] text-white/70 leading-snug truncate">
                      · {it.title}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={'Type anything. Or nothing.'}
        data-testid="meeting-notes"
        className="flex-1 min-h-0 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-relaxed text-white outline-none placeholder:text-white/30"
      />
      {moments.length > 0 && (
        <div className="px-3 py-1.5 border-t border-white/10 flex flex-wrap gap-1">
          {moments.map((m, i) => (
            <span key={i} className="text-[10.5px] text-amber-300/90 bg-amber-500/10 rounded px-1.5 py-0.5">⚑ {fmtMoment(m)}</span>
          ))}
        </div>
      )}
      {showTranscriptNote && !transcribing && (
        <div className="px-3 py-2 border-t border-white/10 text-[11px] text-white/50" data-testid="transcript-note">
          Nothing is being recorded or transcribed. Start a recording (everyone will be asked) and ⌘⇧T shows the words live.
        </div>
      )}
      {showTranscriptNote && transcribing && recordingBy !== myId && (
        <div className="px-3 py-2 border-t border-white/10 text-[11px] text-white/50" data-testid="transcript-note-remote">
          Only the recording machine hears the room — your transcript arrives with the Record after the call. Your ⚑ moments will anchor into it.
        </div>
      )}
      {showTranscriptNote && transcribing && recordingBy === myId && (
        <div className="border-t border-white/10" data-testid="live-transcript">
          <div className="px-3 pt-2 text-[10px] font-semibold tracking-wider text-white/40">
            LIVE · rough and local — the Record is written at wrap-up
          </div>
          <div ref={liveScrollRef} className="px-3 py-2 max-h-[140px] overflow-y-auto">
            {liveLines.length === 0 ? (
              <div className="text-[11px] text-white/40">Listening — lines appear as people speak.</div>
            ) : (
              liveLines.slice(-12).map((l, i) => (
                <div key={i} className="text-[11.5px] text-white/80 leading-snug mb-1">
                  <span className="text-white/40 fb-tabular">[{fmtMoment(l.atMs)}]</span>{' '}
                  <span className="font-medium text-white/60">{l.name}:</span> {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="px-3 py-1.5 border-t border-white/10 text-[10.5px] text-white/40">
        ⌘⇧M mark moment · ⌘⇧T transcript
      </div>
    </div>
  )

  // Body-double controls: what presence with a stranger needs, and no more.
  const bodyDoubleControls = (small: boolean): JSX.Element => (
    <div className={`relative flex items-center justify-center gap-2 ${small ? '' : 'gap-3'}`} data-testid="body-double-controls">
      {bodyDouble?.mode !== 'silent' && (
        <ControlButton small={small} icon={muted ? 'mic_off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={!muted} onClick={toggleMute} />
      )}
      <ControlButton small={small} icon={cameraOff ? 'videocam_off' : 'videocam'} label={cameraOff ? 'Turn camera on' : 'Turn camera off'} active={!cameraOff} onClick={toggleCamera} />
      <ControlButton
        small={small}
        icon={collaborate ? 'fullscreen' : 'fullscreen_exit'}
        label={collaborate ? 'Expand to full screen' : 'Dock to the side'}
        onClick={() => setLayout(collaborate ? 'stage' : 'collaborate')}
      />
      <ControlButton small={small} icon="block" label="End and never match with them again" onClick={() => void blockBodyDouble()} />
      <ControlButton small={small} icon="call_end" label="End body double session" danger onClick={() => void endBodyDouble()} />
    </div>
  )

  const controls = (small: boolean): JSX.Element => bodyDouble ? bodyDoubleControls(small) : (
    <div className={`relative flex items-center justify-center gap-2 ${small ? '' : 'gap-3'}`}>
      <ControlButton small={small} icon={muted ? 'mic_off' : 'mic'} label={muted ? 'Unmute' : 'Mute'} active={!muted} onClick={toggleMute} />
      <ControlButton small={small} icon={cameraOff ? 'videocam_off' : 'videocam'} label={cameraOff ? 'Turn camera on' : 'Turn camera off'} active={!cameraOff} onClick={toggleCamera} />
      <ControlButton
        small={small}
        icon={sharingScreen ? 'stop_screen_share' : 'screen_share'}
        label={sharingScreen ? 'Stop sharing your screen' : 'Share your screen'}
        active={sharingScreen}
        onClick={() => void toggleScreenShare()}
      />
      <ControlButton
        small={small}
        icon={transcribing ? 'stop_circle' : 'radio_button_checked'}
        label={
          !transcribing
            ? 'Start recording — everyone will be asked'
            : recordingBy === myId
              ? 'Stop recording'
              : 'Recording — only the person who started it can stop it'
        }
        active={transcribing}
        onClick={() => {
          if (transcribing && recordingBy !== myId) return
          setTranscribing(!transcribing)
        }}
      />
      <ControlButton
        small={small}
        icon="edit_note"
        label={showNotes ? 'Hide notes' : 'Notes'}
        active={showNotes}
        onClick={() => setShowNotes((v) => !v)}
      />
      <div className="relative">
        <ControlButton small={small} icon="person_add" label="Invite people" active={showInvite} onClick={() => setShowInvite((v) => !v)} />
        {invitePicker}
      </div>
      <ControlButton
        small={small}
        icon={collaborate ? 'fullscreen' : 'fullscreen_exit'}
        label={collaborate ? 'Expand to full screen' : 'Collaborate (dock to the side)'}
        onClick={() => setLayout(collaborate ? 'stage' : 'collaborate')}
      />
      <ControlButton small={small} icon="call_end" label="Leave meeting" danger onClick={leave} />
    </div>
  )

  // ── Collaborate: docked panel on the chosen edge, Plexii stays interactive ──
  if (collaborate) {
    const sideCls: Record<DockSide, string> = {
      left: 'top-0 bottom-0 left-0 w-[300px] flex-col border-r',
      right: 'top-0 bottom-0 right-0 w-[300px] flex-col border-l',
      top: 'top-0 left-0 right-0 h-[210px] flex-col border-b',
      bottom: 'bottom-0 left-0 right-0 h-[210px] flex-col border-t'
    }
    const dockButtons: Array<{ side: DockSide; icon: string }> = [
      { side: 'left', icon: 'arrow_back' },
      { side: 'top', icon: 'arrow_upward' },
      { side: 'bottom', icon: 'arrow_downward' },
      { side: 'right', icon: 'arrow_forward' }
    ]
    return (
      <div
        className={`fixed z-[200] flex bg-stone-950/95 backdrop-blur border-white/10 text-white shadow-2xl ${sideCls[dockSide]}`}
        role="dialog"
        aria-label="Meeting"
        data-testid="meeting-window"
        data-meeting-layout="collaborate"
        data-dock-side={dockSide}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 shrink-0">
          <Icon name={bodyDouble ? 'diversity_3' : 'groups'} size={16} className={bodyDouble ? 'text-emerald-400' : 'text-rose-400'} filled />
          <span className="text-[13px] font-semibold truncate flex-1 min-w-0">{title || 'Meeting'}</span>
          <span className="text-[11px] text-white/50" data-testid="meeting-count">{tileCount}</span>
          {/* Dock-side picker */}
          <div className="flex items-center gap-0.5">
            {dockButtons.map((d) => (
              <button
                key={d.side}
                onClick={() => setDockSide(d.side)}
                title={`Dock ${d.side}`}
                data-testid={`meeting-dock-${d.side}`}
                className={`h-6 w-6 inline-flex items-center justify-center rounded ${dockSide === d.side ? 'bg-white/20' : 'hover:bg-white/10'}`}
              >
                <Icon name={d.icon} size={14} />
              </button>
            ))}
          </div>
        </div>
        {modeLine && (
          <div className="px-3 py-1 text-[10.5px] text-emerald-300/90 bg-emerald-500/10 text-center shrink-0" data-testid="body-double-mode-line">
            {modeLine}
          </div>
        )}
        <div className={`flex-1 min-h-0 p-2 overflow-auto flex gap-2 ${horizontal ? 'flex-row' : 'flex-col'}`}>
          {screenTiles(true)}
          {tiles('mini')}
        </div>
        {transcribing && (
          <div className="px-3 py-1 text-[10.5px] text-rose-300/90 bg-rose-500/10 text-center shrink-0" data-testid="consent-line-mini">
            {consentLine}
          </div>
        )}
        {error && <div className="px-3 py-1 text-[11px] text-rose-300 bg-rose-500/10 text-center shrink-0">{error}</div>}
        <div className="px-2 py-2 border-t border-white/10 shrink-0">{controls(true)}</div>
        {consentModal}
      </div>
    )
  }

  // ── Stage: the classic fullscreen room ──
  const cols = Math.ceil(Math.sqrt(tileCount))
  return (
    <div className="fixed inset-0 z-[200] bg-stone-950/95 flex flex-col" role="dialog" aria-modal="true" aria-label="Meeting" data-testid="meeting-window" data-meeting-layout="stage">
      <div className="flex items-center gap-3 px-5 py-3 text-white">
        <Icon name={bodyDouble ? 'diversity_3' : 'groups'} size={20} className={bodyDouble ? 'text-emerald-400' : 'text-rose-400'} filled />
        <h2 className="text-[15px] font-semibold truncate">{title || 'Meeting'}</h2>
        <span className="text-[12px] text-white/50" data-testid="meeting-count">
          {tileCount} {tileCount === 1 ? 'person' : 'people'}
        </span>
        {status === 'joining' && <span className="text-[12px] text-white/50">Joining…</span>}
        {/* M1 (§3.8) — the state named in words, for everyone, continuously.
            A body-double room is never recorded, so it states its mode instead. */}
        {modeLine ? (
          <span className="text-[11px] text-emerald-300/90" data-testid="body-double-mode-line">
            {modeLine}
          </span>
        ) : (
          <span
            className={`text-[11px] inline-flex items-center gap-1.5 ${transcribing ? 'text-rose-300' : 'text-white/40'}`}
            data-testid="consent-line"
          >
            {transcribing && <span className="h-1.5 w-1.5 rounded-full bg-rose-400 animate-pulse" />}
            {consentLine}
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 px-5 pb-2 flex gap-3 overflow-hidden">
        {screens.length > 0 ? (
          // Presentation layout: the shared screen(s) take the stage; people
          // become a filmstrip underneath so the content is the focus.
          <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
            <div
              className="flex-1 min-h-0 grid gap-3"
              style={{ gridTemplateColumns: `repeat(${Math.min(screens.length, 2)}, minmax(0, 1fr))` }}
            >
              {screenTiles(false)}
            </div>
            <div className="shrink-0 h-28 flex gap-3 overflow-x-auto pb-1">
              {tiles('strip')}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="grid gap-3 h-full" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {tiles('grid')}
            </div>
          </div>
        )}
        {showNotes && !bodyDouble && notesPane}
      </div>

      {error && <div className="px-5 py-2 text-[12px] text-rose-300 bg-rose-500/10 text-center">{error}</div>}

      <div className="py-4">{controls(false)}</div>
      {consentModal}
    </div>
  )
}
