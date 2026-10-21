import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import { whisperEnabled, setWhisperEnabled } from '../../lib/whisperPref'
import ModuleDashboard from '../ModuleDashboard'
import { bucketByWeek, periodDelta } from '../../lib/dashboardMetrics'
import { useMeetingsStore } from '../../stores/meetings'
import NewMeetingDialog from '../NewMeetingDialog'
import RecordDialog, { type RecordNotesDraft } from '../RecordDialog'
import MessageDialog from '../MessageDialog'
import type { PresencePeer } from '../../lib/messagingSocket'
import { usePresenceStore } from '../../stores/presence'
import { useAccountStore } from '../../stores/account'
import { useQuickCreate } from '../../stores/quickCreate'
import { startDm, uploadAttachment, sendMessage } from '../../lib/messagingClient'
import { useNodeStore } from '../../stores/nodes'
import { personDisplayName } from '../../lib/personName'
import { transcribeRecording } from '../../lib/transcribeRecording'
import type { CarriedItem, Meeting, TranscriptSearchHit, TranscriptSegment } from '@shared/meetings'
import { useGuestCaptureStore } from '../../stores/guestCapture'
import { useWrapupStore } from '../../stores/wrapup'
import { MeetingTrackRecorder } from '../../lib/trackRecorder'
import { markDeskOrigin, clearMeetingOrigin } from '../../lib/startMeeting'
import {
  ensureMicrophoneAccess,
  probeMicrophone,
  watchMicrophone,
  MIC_FAILED_MESSAGE,
  MIC_SILENCE_MESSAGE,
  type StartResult
} from '../../lib/micHealth'
import MicLevelPill from '../MicLevelPill'
import { fmtOffset } from '../../lib/transcriptMerge'
import { validateRecordSpans } from '../../lib/recordSpans'
import { validateCommitments, type ValidatedCommitment } from '../../lib/commitments'
import MeetingCommitmentsCard, { CarriedFromLastTime } from '../MeetingCommitmentsCard'
import { RECORD_TEMPLATES } from '../../lib/recordTemplates'
import { useViewStore } from '../../stores/view'
import type { FbNode } from '@shared/types'
import { useWorkItemStore } from '../../stores/workItems'
import { parseMeetingMomentUrl } from '../../lib/meetingLink'
import { CLASS_LABEL, isTerminalState } from '../../lib/attentionQueues'
import { RailCard, StatTile, StatusPill } from '../plexi'
import RecordSectionTitle, { RECORD_SECTION_BAND } from '../RecordSectionTitle'
import {
  speakerOrder,
  speakerColor,
  speakerInitials,
  spokenMsBySpeaker,
  speakerChanges,
  questionCount,
  transcriptSpanMs,
  timelineBands,
  segmentAtMs,
  filterSegments,
  fmtClock,
  fmtDuration
} from '../../lib/meetingRecordStats'

// PlexiMeet: meetings that turn into actions. Record a meeting and it is
// transcribed, summarised, and its action items extracted; or capture notes by
// hand. Action items become real tasks beside the work. Reads only real
// meetings; an empty history is honestly empty. Live transcription needs a
// configured key, surfaced plainly when it is missing.

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export default function PlexiMeetView(): JSX.Element {
  const meetings = useMeetingsStore((s) => s.meetings)
  const loaded = useMeetingsStore((s) => s.loaded)
  const load = useMeetingsStore((s) => s.load)
  const createMeeting = useMeetingsStore((s) => s.create)
  const updateMeeting = useMeetingsStore((s) => s.update)
  const removeMeeting = useMeetingsStore((s) => s.remove)

  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // M4 — Recall: segment hits across EVERY meeting for the current query.
  // The citation is the answer: a speaker, a timestamp and a door into the
  // Thread. Pure FTS — no model call sits between the question and the quote.
  const [recallHits, setRecallHits] = useState<TranscriptSearchHit[]>([])
  // A segment to land on once the detail's segments load (from a Recall hit
  // or an fb:open-meeting with a segmentId).
  const [pendingSegment, setPendingSegment] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [whisper, setWhisper] = useState(whisperEnabled())
  const [retention, setRetention] = useState<'0' | '7' | '30' | '90' | 'keep'>('30')
  useEffect(() => {
    void window.api.meetings.getAudioRetention().then(setRetention).catch(() => {})
  }, [])
  const recRef = useRef<{ rec: MeetingTrackRecorder; stream: MediaStream; draft: RecordNotesDraft | null; stopWatch: () => void } | null>(null)
  const [micState, setMicState] = useState<{ peak: number; silentMs: number }>({ peak: 0, silentMs: 0 })
  // DEC-118 — both record doors open the composer-twin dialog first; the
  // draft it hands over (title, notes, desk) rides the recording to the
  // meeting it becomes.
  const [recordDialog, setRecordDialog] = useState<'notes' | 'external' | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  // DEC-079 — an Attention item's "meeting" chip lands here: select the
  // meeting it points at so the transcript is on screen. The id is selected
  // even if the list is still loading — selection resolves when it arrives.
  useEffect(() => {
    function onOpen(e: Event): void {
      const id = (e as CustomEvent).detail?.id as string | undefined
      const segmentId = (e as CustomEvent).detail?.segmentId as string | undefined
      if (id) setSelectedId(id)
      // M4 — a caller may name the exact line: land the Thread on it.
      if (segmentId) setPendingSegment(segmentId)
    }
    window.addEventListener('fb:open-meeting', onOpen)
    return () => window.removeEventListener('fb:open-meeting', onOpen)
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return meetings
    return meetings.filter((m) => `${m.title} ${m.summary} ${m.transcript}`.toLowerCase().includes(q))
  }, [meetings, query])

  useEffect(() => {
    const q = query.trim()
    // Two characters is the floor — a single letter matches half the corpus
    // and the hit list would just be noise under the meeting rows.
    if (q.length < 2 || typeof window.api.meetings.searchSegments !== 'function') {
      setRecallHits([])
      return
    }
    let alive = true
    const t = setTimeout(() => {
      void window.api.meetings
        .searchSegments(q, 12)
        .then((hits) => {
          if (alive) setRecallHits(hits)
        })
        .catch(() => {
          if (alive) setRecallHits([])
        })
    }, 220)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  const selected = meetings.find((m) => m.id === selectedId) ?? null
  const now = Date.now()

  // DEC-130 — "Record notes" is the same recording as every other door now:
  // the per-track recorder, transcribed ON THIS MACHINE at the wrap-up (CR-11:
  // meeting audio never leaves it — the old path shipped it to a cloud
  // engine), which writes SEGMENTS (the Record's Thread, Recall, commitments
  // and analytics all read segments; a plain transcript lit none of them),
  // retains the take (CR-13, so Re-transcribe has fuel) and refuses to file a
  // meeting on silence. The desk picked in the dialog IS the container.
  //
  // And the microphone is checked before, and watched during: the operator's
  // three-minute "you you you you you you" record (2026-09-07) was a track of
  // digital zeros — macOS had not allowed the microphone, and nothing said so.
  async function startRecording(draft?: RecordNotesDraft): Promise<StartResult> {
    setError(null)
    const access = await ensureMicrophoneAccess()
    if (!access.ok) return access
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      // The dialog that opened this door reports the microphone itself and
      // stays open — a second banner behind it would say the same thing twice.
      return { ok: false, reason: 'failed', message: MIC_FAILED_MESSAGE }
    }
    const probe = await probeMicrophone(stream, 1200)
    if (probe.digitalSilence) {
      stream.getTracks().forEach((tr) => tr.stop())
      return { ok: false, reason: 'mic-silent', message: MIC_SILENCE_MESSAGE }
    }
    const rec = new MeetingTrackRecorder()
    rec.tap('me', stream)
    const stopWatch = watchMicrophone(stream, (s) => setMicState({ peak: s.peak, silentMs: s.silentMs }))
    recRef.current = { rec, stream, draft: draft ?? null, stopWatch }
    setMicState({ peak: 0, silentMs: 0 })
    setRecording(true)
    return { ok: true }
  }

  function stopRecording(): void {
    const cur = recRef.current
    recRef.current = null
    setRecording(false)
    if (!cur) return
    cur.stopWatch()
    void cur.rec.stop().then((take) => {
      cur.stream.getTracks().forEach((tr) => tr.stop())
      if (!take.mixed) {
        setError('Nothing was recorded — the recorder could not start on this machine.')
        return
      }
      const draft = cur.draft
      const title = draft?.title.trim() || `Meeting · ${fmtDate(Date.now())}`
      if (draft?.deskNodeId) markDeskOrigin(draft.deskNodeId, title)
      else clearMeetingOrigin()
      void useWrapupStore.getState().begin({
        title,
        buffer: take.mixed.buffer,
        mimeType: take.mixed.mimeType,
        durationSec: take.mixed.durationSec,
        tracks: take.tracks,
        speakers: { me: 'You' },
        // CR-11 — meeting-grade audio: on-device only, no cloud fallback.
        forceLocalTranscription: true,
        // The dialog's NOTES are the recorder's own words — `yours` spans on
        // the Record, never rewritten.
        notes: draft?.notes ?? '',
        moments: [],
        deskNodeId: draft?.deskNodeId ?? null
      })
    })
  }

  async function addManual(): Promise<void> {
    const created = await createMeeting({ title: 'New meeting' })
    if (created) setSelectedId(created.id)
  }

  // Live meeting + record-a-message wiring.
  const [showNew, setShowNew] = useState(false)
  const presencePeers = usePresenceStore((s) => s.peers)
  const token = useAccountStore((s) => s.sessionToken)
  const [messageDialog, setMessageDialog] = useState(false)
  const [msgTo, setMsgTo] = useState<{ accountId: string; handle: string; firstName?: string | null; lastName?: string | null } | null>(null)
  const [msgRecording, setMsgRecording] = useState(false)
  const [msgNote, setMsgNote] = useState<string | null>(null)
  const msgRecRef = useRef<MediaRecorder | null>(null)

  // Opening the New meeting dialog is the single entry point for starting or
  // scheduling a meeting, so the invite-by-email and schedule options are always
  // available no matter where the request comes from.
  function openNew(): void {
    setError(null)
    setShowNew(true)
  }

  // Global quick-create (Cmd+K "Start a meeting").
  const quickPending = useQuickCreate((s) => s.pending)
  useEffect(() => {
    if (quickPending === 'meet' && useQuickCreate.getState().consume('meet')) openNew()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickPending])

  // Record a short video message and send it to a teammate as a DM — the
  // "they're away, leave them something" path, like a quick Loom. Reuses the real
  // chat attachment pipeline (video kind), so a failure surfaces honestly rather
  // than pretending it sent. Falls back to audio only if there is no camera.
  // DEC-119 — opened from the Message dialog: the kind (video / voice) and
  // the text ride in; the dialog owns the microphone message and stays
  // open on false, so no view banner doubles it.
  async function recordMessageTo(peer: PresencePeer, opts: { text: string; video: boolean }): Promise<boolean> {
    setMsgNote(null)
    setError(null)
    let stream: MediaStream
    let isVideo = opts.video
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: opts.video })
    } catch {
      // Video asked for but no camera (or denied): a voice message still goes,
      // honestly labelled. No mic at all: the dialog reports it.
      if (!opts.video) return false
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        isVideo = false
      } catch {
        return false
      }
    }
    try {
      const rec = new MediaRecorder(stream)
      const chunks: Blob[] = []
      const startedAt = Date.now()
      const mime = rec.mimeType || (isVideo ? 'video/webm' : 'audio/webm')
      const kind = isVideo ? ('video' as const) : ('voice' as const)
      const name = isVideo ? 'message-video.webm' : 'message.webm'
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setMsgRecording(false)
        if (!token) {
          setError('Sign in to send a message.')
          return
        }
        const blob = new Blob(chunks, { type: mime })
        const peerName = personDisplayName(peer, peer.handle)
        setMsgNote(`Sending to ${peerName}…`)
        const conversationId = await startDm(token, peer.handle)
        if (!conversationId) {
          setMsgNote(null)
          setError(`Could not open a conversation with ${peerName}.`)
          return
        }
        const att = await uploadAttachment(token, conversationId, kind, await blob.arrayBuffer(), { name, mime, ext: 'webm' })
        if (!att) {
          setMsgNote(null)
          setError('Could not upload the message.')
          return
        }
        const sent = await sendMessage(token, conversationId, opts.text, {
          kind,
          id: att.id,
          name,
          mimeType: mime,
          sizeBytes: att.sizeBytes,
          durationMs: Date.now() - startedAt
        })
        setMsgNote(sent ? `Sent to ${peerName}.` : null)
        if (!sent) setError('Could not send the message.')
        setMsgTo(null)
      }
      msgRecRef.current = rec
      rec.start()
      setMsgTo(peer)
      setMsgRecording(true)
      return true
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      return false
    }
  }

  function stopMessage(): void {
    msgRecRef.current?.stop()
  }

  return (
    // The page reads like Home (operator direction, 2026-09-06): the same
    // paper-texture substrate the dashboard sits on (deliberately NOT
    // desk-paper — that pair caused Home's mid-screen seam and its
    // light-in-dark bug), Home's hero header with the module chip and the
    // primary as Home's accent button, and every surface below a floating
    // house card on the paper. Presentation ONLY: every testid, handler and
    // copy string is exactly where it was.
    //
    // DEC-134 — on a wide window the page is a WINDOW, not a scroll (the rule
    // DEC-132/133 gave the home tiles and the desk widgets): the hero stays
    // pinned, the rail is as tall as the floor and no taller, and the column
    // beside it scrolls on its own — or, with a meeting open, hands its
    // height to the Record so its panes scroll under their own headers. The
    // rail and the transcript used to stick to a page scroll under caps of
    // `calc(100vh - 460px)` and `calc(100vh - 140px)`, numbers the wrapping
    // hero and the footer could not see, so their bottom edges ran under the
    // footer with nothing to scroll. Below `lg` the columns stack and the
    // page scrolls, as before.
    <div className="h-full w-full flex flex-col overflow-y-auto lg:overflow-hidden paper-texture text-[var(--ink-100)]" data-testid="pleximeet-view">
      <div className="w-full max-w-[1440px] mx-auto px-8 pb-8 pt-8 lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
        {/* Hero — Home's greeting header idiom: title + subtitle left, doors right. */}
        <header className="flex items-start justify-between gap-4 flex-wrap mb-6 shrink-0" data-testid="meet-hero">
          <div className="flex items-center gap-3 min-w-0">
            <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-rose-500/10 text-rose-500 shadow-[inset_0_0_0_1px_rgb(244_63_94/0.18)]">
              <Icon name="groups" size={22} filled />
            </span>
            <div className="min-w-0">
              <h1 className="fb-display-hero text-[24px] leading-tight text-[var(--ink-100)]">PlexiiCall</h1>
              <p className="mt-1 text-[13px] text-[var(--ink-50)]">Meetings that turn into actions.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Secondary doors first, the primary last — Home's order. */}
            {recording ? (
              <>
                {/* DEC-130 — what the microphone is doing, while it runs. */}
                <MicLevelPill peak={micState.peak} silentMs={micState.silentMs} />
                <button
                  onClick={stopRecording}
                  data-testid="meet-stop"
                  className="inline-flex items-center gap-2 h-9 px-3.5 rounded-[10px] bg-red-500 text-white fb-t-body font-medium animate-pulse fb-press"
                >
                  <Icon name="stop_circle" size={16} /> Stop recording
                </button>
              </>
            ) : (
              <button
                onClick={() => setRecordDialog('notes')}
                data-testid="meet-record"
                className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)] disabled:opacity-50"
                title="Record audio, transcribe it and extract action items"
              >
                <Icon name="mic" size={16} /> Record notes
              </button>
            )}
            <button
              onClick={() => setRecordDialog('external')}
              data-testid="meet-record-external"
              className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
              title="Record a meeting happening outside Plexii (Zoom, Meet, Teams) — your mic + this machine's audio, transcribed locally"
            >
              <Icon name="radio_button_checked" size={16} /> Record external
            </button>
            {msgRecording && msgTo ? (
              <button
                onClick={stopMessage}
                data-testid="meet-message-stop"
                className="inline-flex items-center gap-2 h-9 px-3.5 rounded-[10px] bg-red-500 text-white fb-t-body font-medium animate-pulse fb-press"
                title="Stop and send the message"
              >
                <Icon name="stop_circle" size={16} /> Stop &amp; send to {personDisplayName(msgTo, msgTo.handle)}
              </button>
            ) : (
              <button
                onClick={() => setMessageDialog(true)}
                data-testid="meet-message"
                className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
                title="Record a quick message and send it to a teammate who is away"
              >
                <Icon name="voicemail" size={16} /> Message
              </button>
            )}
            <button
              onClick={() => void addManual()}
              data-testid="meet-add"
              className="inline-flex items-center justify-center h-9 w-9 fb-btn-surface fb-press text-[var(--ink-80)] disabled:opacity-50"
              title="Add a meeting from notes" aria-label="Add a meeting from notes"
            >
              <Icon name="edit_note" size={17} />
            </button>
            {/* Primary: a live, multi-party meeting — Home's accent primary
                (the same glow "Customize → Done" wears), not a module colour. */}
            <button
              onClick={openNew}
              data-testid="meet-start-live"
              className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-press rounded-[10px] bg-[rgb(var(--accent))] text-white shadow-[0_1px_2px_rgb(var(--accent)/0.25),0_4px_12px_-2px_rgb(var(--accent)/0.30)] hover:bg-[rgb(var(--accent-hover))]"
            >
              <Icon name="video_call" size={17} /> Start or schedule a meeting
            </button>
          </div>
        </header>

        {(error || msgNote) && (
          <div className="mb-4 space-y-2 shrink-0">
            {error && (
              <div className="px-3 py-2 rounded-[var(--radius-row)] bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[12px] leading-relaxed" data-testid="meet-error">
                {error}
              </div>
            )}
            {msgNote && (
              <div className="px-3 py-2 rounded-[var(--radius-row)] bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[12px] leading-relaxed" data-testid="meet-message-note">
                {msgNote}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col lg:flex-row gap-6 items-start lg:items-stretch lg:flex-1 lg:min-h-0">
          {/* Rail — Home's rail idiom: floating cards beside the Record. DEC-134:
              the rail stands as tall as the floor and no taller — the Meetings
              card hugs a short list and shrinks for a long one (the list
              scrolling under the pinned title and search) while the Recording
              card never gives up its height — so the last meeting and the
              retention control are always on screen. */}
          <aside className="w-full lg:w-[300px] shrink-0 flex flex-col gap-4 lg:min-h-0" data-testid="meet-rail">
            <RailCard
              title="Meetings"
              icon="groups"
              tone="rose"
              testId="meet-list-card"
              className="flex flex-col min-h-0"
              bodyClassName="px-2 pb-2 min-h-0 flex flex-col"
              trailing={loaded ? <span className="fb-tabular text-[12px] text-[var(--ink-40)]">{meetings.length}</span> : undefined}
            >
              <div className="px-1 pb-2 shrink-0">
                <div className="flex items-center gap-1.5 px-2.5 h-9 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-transparent focus-within:border-[rgb(var(--accent))] transition-colors">
                  <Icon name="search" size={14} className="text-[var(--ink-50)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search meetings"
                    data-testid="meet-search"
                    className="flex-1 bg-transparent text-[12px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
                  />
                </div>
              </div>
              <div className="min-h-0 overflow-y-auto max-h-[60vh] lg:max-h-none" data-testid="meet-list">
          {recallHits.length > 0 && (
            <div className="mb-2" data-testid="recall-hits">
              <div className="px-3 pt-1 pb-1 text-[10px] font-semibold tracking-wider text-[var(--ink-40)]">
                FROM THE TRANSCRIPTS
              </div>
              {recallHits.map((h) => (
                <button
                  key={h.segmentId}
                  onClick={() => {
                    setSelectedId(h.meetingId)
                    setPendingSegment(h.segmentId)
                  }}
                  data-testid={`recall-hit-${h.segmentId}`}
                  className="w-full text-left rounded-lg px-3 py-2 mb-0.5 hover:bg-[var(--surface-sunken)] transition-colors"
                >
                  <div className="text-[11.5px] text-[var(--ink-90)] leading-snug line-clamp-2">
                    <span className="fb-tabular text-[var(--ink-50)]">[{fmtOffset(h.startMs)}]</span>{' '}
                    <span className="font-medium">{h.speakerName || 'Unknown'}:</span> {h.text}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-[var(--ink-50)] truncate">{h.meetingTitle}</div>
                </button>
              ))}
            </div>
          )}
          {!loaded ? (
            <div className="px-3 py-10 flex items-center justify-center gap-2 text-[12px] text-[var(--ink-70)]">
              <Icon name="progress_activity" size={15} className="text-[rgb(var(--accent))] animate-spin" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <Icon name="forum" size={26} className="text-[var(--ink-30)]" />
              <p className="mt-2 text-[12px] text-[var(--ink-70)] leading-relaxed">
                {meetings.length === 0
                  ? 'No meetings yet. Record one or add notes, and the actions land beside your work.'
                  : 'Nothing matches that search.'}
              </p>
            </div>
          ) : (
            filtered.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                data-testid={`meet-row-${m.id}`}
                className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 fb-press transition-colors ${
                  m.id === selectedId
                    ? 'bg-[rgb(var(--accent)/0.10)] border border-[rgb(var(--accent)/0.30)] shadow-[inset_0_1px_0_rgb(255_255_255/0.35)]'
                    : 'hover:bg-[var(--surface-sunken)] border border-transparent'
                }`}
              >
                <div className="text-[13px] font-semibold text-[var(--ink-100)] truncate">{m.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-[var(--ink-70)] fb-tabular">
                  <span>{fmtDate(m.createdAt)}</span>
                  {m.actionItems.length > 0 && (
                    <span className="inline-flex items-center gap-0.5">
                      <Icon name="task_alt" size={11} /> {m.actionItems.length}
                    </span>
                  )}
                </div>
              </button>
            ))
          )}
              </div>
            </RailCard>

            {/* DEC-098 made meeting recording consent-only; the calls consent
                round closed the same hole for 1:1s. This preference now only
                expresses MY side: on a call it records my mic and ASKS the
                other person — their voice is captured when they say yes, and
                a decline is honoured by construction (never tapped). */}
            <RailCard className="shrink-0" bodyClassName="p-4 space-y-2" testId="meet-recording-card">
              <div className="text-[10px] font-semibold tracking-wider text-[var(--ink-40)]">RECORDING</div>
          <label
            className="flex items-center gap-2 px-0.5 text-[11.5px] text-[var(--ink-70)] cursor-pointer"
            title="Applies to 1:1 calls: your mic is recorded and the other person is asked before their voice is captured — declining keeps them out entirely. Meetings never auto-record."
          >
            <input
              type="checkbox"
              checked={whisper}
              onChange={(e) => {
                setWhisper(e.target.checked)
                setWhisperEnabled(e.target.checked)
              }}
              data-testid="meet-whisper-toggle"
              className="accent-[rgb(var(--accent))]"
            />
            <span>Transcribe &amp; summarise my 1:1 calls (the other person is asked)</span>
          </label>

          {/* M2c (CR-13) — audio retention. Local disk only, never uploaded. */}
          <label className="flex items-center justify-between gap-2 px-0.5 text-[11.5px] text-[var(--ink-70)]">
            <span
              className="whitespace-nowrap"
              title="Meeting audio stays on this machine and expires after this window. 'Keep' on a meeting overrides it."
            >
              Keep meeting audio
            </span>
            <select
              value={retention}
              onChange={(e) => {
                const v = e.target.value as '0' | '7' | '30' | '90' | 'keep'
                setRetention(v)
                void window.api.meetings.setAudioRetention(v)
              }}
              data-testid="meet-retention-select"
              className="fb-field bg-[var(--surface-sunken)] px-1.5 py-1 text-[11.5px] max-w-[150px] truncate"
            >
              <option value="0">never (discard at wrap-up)</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="keep">forever</option>
            </select>
          </label>
            </RailCard>
          </aside>

          {/* Detail — DEC-134: on a wide window the column scrolls on its own
              under the pinned hero (the dashboard), or hands its height to the
              Record, which pins its header and timeline and scrolls its panes. */}
          <div
            className={`flex-1 min-w-0 w-full ${selected ? 'lg:min-h-0 lg:flex lg:flex-col' : 'lg:min-h-0 lg:overflow-y-auto'}`}
            data-testid="meet-main"
          >
        {selected ? (
          <MeetingDetail
            key={selected.id}
            meeting={selected}
            initialSegmentId={pendingSegment}
            onJumpConsumed={() => setPendingSegment(null)}
            onChange={(patch) => void updateMeeting(selected.id, patch)}
            onDelete={() => {
              void removeMeeting(selected.id)
              setSelectedId(null)
            }}
          />
        ) : (
          <ModuleDashboard
            moduleKey="meet"
            embedded
            title="Meetings"
            subtitle="Record a meeting and it becomes a summary, a transcript and real action items"
            icon="groups"
            accentClass="text-rose-500"
            stats={[
              {
                icon: 'groups',
                label: 'Meetings',
                value: meetings.length,
                tone: 'rose',
                delta: periodDelta(meetings.map((m) => m.createdAt), 7 * 86400000, now),
                sparkline: bucketByWeek(meetings.map((m) => m.createdAt), 8, now)
              },
              { icon: 'task_alt', label: 'Action items', value: meetings.reduce((n, m) => n + m.actionItems.length, 0), tone: 'accent' },
              {
                icon: 'schedule',
                label: 'Avg length',
                value: (() => {
                  const d = meetings.map((m) => m.durationSec).filter((s): s is number => typeof s === 'number')
                  return d.length ? `${Math.round(d.reduce((a, c) => a + c, 0) / d.length / 60)}m` : '—'
                })(),
                tone: 'sky'
              },
              { icon: 'description', label: 'Transcribed', value: meetings.filter((m) => m.transcript.trim().length > 0).length, tone: 'violet' }
            ]}
            timeline={{
              title: 'Meetings over time',
              points: bucketByWeek(meetings.map((m) => m.createdAt), 8, now),
              bucketLabel: 'last 8 weeks',
              unit: 'meetings',
              tone: 'rose',
              emptyHint: 'Hold your first meeting to see your cadence here.'
            }}
            breakdown={{
              title: 'Capture',
              icon: 'donut_small',
              items: [
                { label: 'Transcribed', value: meetings.filter((m) => m.transcript.trim().length > 0).length, tone: 'violet' as const },
                { label: 'Notes only', value: meetings.filter((m) => m.transcript.trim().length === 0).length, tone: 'stone' as const }
              ].filter((i) => i.value > 0),
              emptyHint: 'No meetings yet.'
            }}
            recentItems={{
              label: 'Recent meetings',
              items: meetings.slice(0, 6).map((m) => ({
                id: m.id,
                title: m.title,
                subtitle: m.summary ? m.summary.slice(0, 90) : m.actionItems.length ? `${m.actionItems.length} action item(s)` : 'No summary yet',
                meta: fmtDate(m.createdAt),
                status: m.actionItems.length ? { tone: 'accent' as const, label: `${m.actionItems.length} actions` } : undefined,
                onOpen: () => setSelectedId(m.id)
              })),
              onCreate: openNew,
              createLabel: 'Start a meeting',
              emptyHint: 'Start a live meeting and invite your teammates, or record notes and a message to send. Action items become real tasks.'
            }}
          />
        )}
          </div>
        </div>
      </div>

      {showNew && <NewMeetingDialog onClose={() => setShowNew(false)} />}
      {messageDialog && (
        <MessageDialog
          peers={Object.values(presencePeers)}
          onClose={() => setMessageDialog(false)}
          onStart={(d) => recordMessageTo(d.to, { text: d.text, video: d.video })}
        />
      )}
      {recordDialog && (
        <RecordDialog
          initialMode={recordDialog}
          onClose={() => setRecordDialog(null)}
          onStartNotes={(d) => startRecording(d)}
          onStartExternal={(d) =>
            useGuestCaptureStore.getState().start({ title: d.title, notes: d.notes, micOnly: d.micOnly })
          }
        />
      )}
    </div>
  )
}

// The meeting Record, reorganised (operator direction, 2026-09-06): the
// transcript is ALWAYS on screen — tagged by speaker, searchable, and every
// timestamp a link — beside three renderings of what the meeting produced.
// The tabs are Overview (the Brief + summary, organised by section), Action
// items (commitments with a checkbox and a bell) and Analytics (facts derived
// from the segments). A speaker timeline sits above both; clicking it moves
// through the call by jumping the transcript.
//
// Provenance is unchanged and is the entire trust model (M2b):
//   yours    — full ink, no marker. The user's words, never rewritten.
//   heard    — normal ink with a hairline left rule and its timestamp;
//              clicking jumps to the moment in the transcript.
//   inferred — lighter ink, no rule, no anchor. The machine's guess LOOKS
//              like a guess (the same accent-vs-ink doctrine as capture).
type RecordView = 'commitments' | 'brief' | 'analytics'

// DEC-136/137 — every section title inside the Record (all three renderings)
// sits on RecordSectionTitle's band: see components/RecordSectionTitle.tsx.

/** The state of a filed work item as the list exposes it. */
function itemState(i: FbNode): string {
  return (i.workItemState ?? (i as { state?: string | null }).state ?? i.status ?? 'open') as string
}

function MeetingDetail({
  meeting,
  onChange,
  onDelete,
  initialSegmentId,
  onJumpConsumed
}: {
  meeting: Meeting
  onChange: (patch: { title?: string; summary?: string; transcript?: string; actionItems?: string[] }) => void
  onDelete: () => void
  // M4 — a Recall hit names its line: once segments load, the transcript
  // scrolls to it. Consumed exactly once so later renders stay put.
  initialSegmentId?: string | null
  onJumpConsumed?: () => void
}): JSX.Element {
  const createNode = useNodeStore((s) => s.create)
  const [title, setTitle] = useState(meeting.title)
  const [summary, setSummary] = useState(meeting.summary)
  const [transcript, setTranscript] = useState(meeting.transcript)
  const [showTranscript, setShowTranscript] = useState(false)
  const [madeTasks, setMadeTasks] = useState<Record<number, boolean>>({})
  // M2b — Commitments (Action items) opens by default: the person who just
  // left the room is the most common reader and needs the shortest artifact
  // (S3-DEC-022). Overview sits first in the tab order; the default needn't.
  const [view, setView] = useState<RecordView>('commitments')
  // The engine-repair door: the retained takes re-run through the CURRENT
  // local engine (the model ruling moved wrap-ups to whisper-base after tiny
  // looped a real recording), replacing segments, transcript and summary.
  // Audio never leaves the machine — same decode path as the wrap-up.
  const [retranscribing, setRetranscribing] = useState<string | null>(null)
  // M5 — series memory: the previous instance and what it left open, plus
  // the Q14 per-series brief knob. Database facts; absent for ad-hoc meetings.
  const [carried, setCarried] = useState<CarriedItem[]>([])
  const [lastMeeting, setLastMeeting] = useState<{ id: string; title: string; createdAt: number } | null>(null)
  const [seriesBriefs, setSeriesBriefs] = useState<boolean | null>(null)
  const [seriesShare, setSeriesShare] = useState<boolean | null>(null)
  const [segments, setSegments] = useState<TranscriptSegment[]>([])
  const threadRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  // The transcript panel's own state: who, what, and where we are in the call.
  const [speakerFilter, setSpeakerFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  useEffect(() => {
    if (!meeting.seriesId || typeof window.api.meetings.prep !== 'function') return
    let alive = true
    void window.api.meetings
      .prep({ seriesId: meeting.seriesId, excludeMeetingId: meeting.id })
      .then((prep) => {
        if (!alive) return
        setCarried(prep.carried)
        setLastMeeting(prep.lastMeeting)
      })
      .catch(() => {})
    void window.api.meetings
      .getSeriesPrefs(meeting.seriesId)
      .then((prefs) => {
        if (!alive) return
        setSeriesBriefs(prefs.briefs)
        setSeriesShare(prefs.shareBriefs)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [meeting.id, meeting.seriesId])

  useEffect(() => {
    let alive = true
    setSegments([])
    setSpeakerFilter(null)
    setQuery('')
    setActiveSegmentId(null)
    void window.api.meetings.segments(meeting.id).then((s) => {
      if (alive) setSegments(s)
    })
    return () => {
      alive = false
    }
  }, [meeting.id])
  // 1/2/3 pick the rendering (SPEC-003 §3.10) and "/" lands in the transcript
  // search — never while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement).isContentEditable) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '1') setView('brief')
      if (e.key === '2') setView('commitments')
      if (e.key === '3') setView('analytics')
      if (e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const fmtMs = fmtClock
  // M2c — audio presence + the per-meeting keep override (CR-13), export,
  // template rebuild, and the door to the meeting's desk (S3-DEC-020).
  const [audio, setAudio] = useState<{ present: boolean; files: number; bytes: number; kept: boolean } | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  // M3 — extraction for PAST meetings: the same confirm stop, on demand.
  const [extracting, setExtracting] = useState(false)
  const [foundCommitments, setFoundCommitments] = useState<ValidatedCommitment[] | null>(null)
  const selfId = useAccountStore((s) => s.account?.id ?? '')
  async function findCommitments(): Promise<void> {
    if (extracting || segments.length === 0) return
    setExtracting(true)
    try {
      const roster = [
        ...new Map(
          segments
            .filter((s) => s.speakerAccountId)
            .map((s) => [s.speakerAccountId as string, { accountId: s.speakerAccountId as string, name: s.speakerName }])
        ).values()
      ]
      const ex = await window.api.meetings.extractCommitments({
        title: meeting.title,
        notes: (meeting.record?.spans ?? [])
          .filter((s) => s.tier === 'yours')
          .map((s) => s.text)
          .join('\n'),
        segments: segments.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          speakerName: s.speakerName,
          speakerAccountId: s.speakerAccountId,
          text: s.text
        })),
        roster
      })
      setFoundCommitments(ex.ok ? validateCommitments(ex.commitments, segments, selfId) : [])
    } finally {
      setExtracting(false)
    }
  }
  const [exported, setExported] = useState<string | null>(null)
  const refreshMeetings = useMeetingsStore((s) => s.load)
  const goTask = useViewStore((s) => s.goTask)
  useEffect(() => {
    let alive = true
    setAudio(null)
    setExported(null)
    void window.api.meetings.audioInfo(meeting.id).then((a) => {
      if (alive) setAudio(a)
    })
    return () => {
      alive = false
    }
  }, [meeting.id])
  async function rebuildBrief(sections: string[]): Promise<void> {
    if (rebuilding || segments.length === 0) return
    setRebuilding(true)
    try {
      const enh = await window.api.meetings.enhanceRecord({
        title: meeting.title,
        // yours spans were minted at wrap-up from the live notes; reuse their
        // text as context — the user's words are already in the record.
        notes: (meeting.record?.spans ?? [])
          .filter((s) => s.tier === 'yours')
          .map((s) => s.text)
          .join('\n'),
        sections,
        segments: segments.map((s) => ({ id: s.id, startMs: s.startMs, speakerName: s.speakerName, text: s.text }))
      })
      if (enh.ok) {
        const yours = (meeting.record?.spans ?? []).filter((s) => s.tier === 'yours')
        const spans = [...yours, ...validateRecordSpans(enh.spans, segments)]
        await window.api.meetings.update(meeting.id, { record: { spans, generatedAt: Date.now() } })
        await refreshMeetings()
      }
    } finally {
      setRebuilding(false)
    }
  }
  // M4 — consume a named landing line once its segment exists on screen.
  useEffect(() => {
    if (!initialSegmentId || segments.length === 0) return
    if (!segments.some((s) => s.id === initialSegmentId)) return
    jumpToSegment(initialSegmentId)
    onJumpConsumed?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSegmentId, segments])

  // Land on a line: it becomes the active moment, any filter that would hide
  // it is cleared, and the transcript scrolls it to centre. The transcript
  // is always mounted now, so no view switch is needed.
  const jumpToSegment = (segmentId: string): void => {
    const target = segments.find((s) => s.id === segmentId)
    if (target) {
      if (speakerFilter && (target.speakerName?.trim() || 'Speaker') !== speakerFilter) setSpeakerFilter(null)
      if (query.trim() && !target.text.toLowerCase().includes(query.trim().toLowerCase())) setQuery('')
    }
    setActiveSegmentId(segmentId)
    setTimeout(() => {
      threadRef.current
        ?.querySelector(`[data-segment-id="${segmentId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
  }

  async function retranscribe(): Promise<void> {
    if (retranscribing) return
    setRetranscribing('Loading the saved audio…')
    try {
      const takes = await window.api.meetings.loadAudioTakes(meeting.id)
      if (!takes.length) {
        setRetranscribing(null)
        return
      }
      const drafts: Array<{
        speakerAccountId: string | null
        speakerName: string
        startMs: number
        endMs: number
        text: string
        confidence: number | null
      }> = []
      for (let i = 0; i < takes.length; i++) {
        const take = takes[i]
        setRetranscribing(`Transcribing on-device — ${take.speaker} (${i + 1} of ${takes.length})…`)
        const buf = take.bytes.buffer.slice(
          take.bytes.byteOffset,
          take.bytes.byteOffset + take.bytes.byteLength
        ) as ArrayBuffer
        const r = await transcribeRecording(buf, take.mimeType, { forceLocal: true })
        if (!r.ok) {
          setRetranscribing(null)
          return
        }
        const segs = r.segments ?? [
          { startMs: 0, endMs: Math.round((r.durationSec ?? 0) * 1000), text: r.transcript, confidence: null }
        ]
        for (const s of segs) {
          if (!s.text.trim()) continue
          drafts.push({
            speakerAccountId: null,
            speakerName: take.speaker,
            startMs: take.offsetMs + s.startMs,
            endMs: take.offsetMs + s.endMs,
            text: s.text.trim(),
            confidence: s.confidence
          })
        }
      }
      drafts.sort((a, b) => a.startMs - b.startMs)
      const saved = await window.api.meetings.saveSegments(meeting.id, drafts)
      const transcriptText = drafts
        .map((d) => `[${fmtOffset(d.startMs)}] ${d.speakerName}: ${d.text}`)
        .join('\n')
      setRetranscribing('Summarising…')
      const sum = await window.api.voiceNote
        .process({ transcript: transcriptText, mode: 'summary' })
        .catch(() => null)
      onChange({ transcript: transcriptText, ...(sum?.ok ? { summary: sum.text } : {}) })
      setTranscript(transcriptText)
      if (sum?.ok) setSummary(sum.text)
      setSegments(saved)
      // The commitments door reopens over the corrected transcript.
      setFoundCommitments(null)
    } finally {
      setRetranscribing(null)
    }
  }

  async function makeTask(idx: number, text: string): Promise<void> {
    await createNode({ kind: 'task', title: text, parentId: null }).catch(() => null)
    setMadeTasks((m) => ({ ...m, [idx]: true }))
  }

  // ── The Attention side of Action items ───────────────────────────────────
  // Filed items are the work items that POINT at this meeting (DEC-079's
  // sourceRef). The checkbox closes one with the house terminal state; the
  // bell on a legacy line files it — with the meeting as its source, so its
  // chip in the queue is a door straight back here.
  const allItems = useWorkItemStore((s) => s.items)
  const refreshItems = useWorkItemStore((s) => s.refresh)
  const setItemState = useWorkItemStore((s) => s.setState)
  const createItem = useWorkItemStore((s) => s.create)
  // Re-read on every open: a dismissal or a snooze expiry that happened
  // elsewhere (the queue, another session, the main process) must show
  // here without a reload — one list call per open.
  useEffect(() => {
    void refreshItems()
  }, [meeting.id, refreshItems])
  const filedItems = useMemo(
    () =>
      allItems.filter((i) => {
        if (i.sourceRef !== meeting.id) return false
        const st = itemState(i)
        return st !== 'dismissed' && st !== 'archived'
      }),
    [allItems, meeting.id]
  )
  // A summary line the bell has filed now lives in the list above with a
  // real checkbox — it is not repeated below. Matched on the exact text, so
  // dismissing the item from Attention returns the line to the summary.
  const unfiledLegacy = useMemo(() => {
    const filedTitles = new Set(filedItems.map((i) => i.title.trim().toLowerCase()))
    return meeting.actionItems
      .map((text, i) => ({ text, i }))
      .filter(({ text }) => !filedTitles.has(text.trim().toLowerCase()))
  }, [meeting.actionItems, filedItems])
  // In-flight guard only: once the item exists the line is promoted out of
  // this list by `unfiledLegacy`, and if it is later dismissed the line comes
  // back with a live bell — no sticky "already sent" state to go stale.
  const [filing, setFiling] = useState<Record<number, boolean>>({})
  // The store refreshes the row and raises fb:workitems-changed itself, so
  // the badge and the queue learn of both without a second call.
  async function toggleItemDone(i: FbNode): Promise<void> {
    const done = isTerminalState(itemState(i))
    await setItemState(i.id, done ? 'open' : 'completed')
  }
  async function sendLegacyToAttention(idx: number, text: string): Promise<void> {
    if (filing[idx]) return
    setFiling((m) => ({ ...m, [idx]: true }))
    try {
      await createItem({
        title: text,
        notes: `From the meeting “${meeting.title}”.`,
        parentId: meeting.deskNodeId ?? null,
        intentClass: 'to_do',
        dueAt: null,
        confidence: 1,
        approvalState: 'approved',
        wiOrigin: 'human',
        sourceType: 'meeting',
        sourceRef: meeting.id
      }).catch(() => null)
    } finally {
      setFiling((m) => ({ ...m, [idx]: false }))
    }
  }

  // ── Derived facts: speakers, timeline, analytics ─────────────────────────
  const speakers = useMemo(() => speakerOrder(segments), [segments])
  const colorOf = (name: string): string => speakerColor(name, speakers)
  const totalMs = useMemo(
    () => Math.max(transcriptSpanMs(segments), (meeting.durationSec ?? 0) * 1000),
    [segments, meeting.durationSec]
  )
  const bands = useMemo(() => timelineBands(segments, totalMs), [segments, totalMs])
  const visibleSegments = useMemo(
    () => filterSegments(segments, { speaker: speakerFilter, query }),
    [segments, speakerFilter, query]
  )
  const spokenMs = useMemo(() => spokenMsBySpeaker(segments), [segments])
  const spokenTotal = [...spokenMs.values()].reduce((a, b) => a + b, 0)
  const activeSegment = segments.find((s) => s.id === activeSegmentId) ?? null
  // Moments on the timeline: heard spans of the Record (filled) and filed
  // items that carry a moment anchor (hollow). Both are doors.
  const markers = useMemo(() => {
    const out: Array<{
      key: string
      ms: number
      segmentId: string
      kind: 'heard' | 'item'
      label: string
      section?: string
      itemId?: string
    }> = []
    // Two heard entries may cite the SAME line (a real Record did) — the key
    // carries the span's position so React never sees twins.
    ;(meeting.record?.spans ?? []).forEach((s, idx) => {
      if (s.tier === 'heard' && s.segmentId && s.startMs != null)
        out.push({
          key: `h-${s.segmentId}-${idx}`,
          ms: s.startMs,
          segmentId: s.segmentId,
          kind: 'heard',
          label: s.text,
          section: s.section ?? 'Notes'
        })
    })
    for (const i of filedItems) {
      const m = parseMeetingMomentUrl(i.sourceUrl)
      if (m?.segmentId) {
        const seg = segments.find((s) => s.id === m.segmentId)
        if (seg) out.push({ key: `i-${i.id}`, ms: seg.startMs, segmentId: seg.id, kind: 'item', label: i.title, itemId: i.id })
      }
    }
    return out
  }, [meeting.record, filedItems, segments])
  // The reverse door — links run both ways. A transcript line that anchors
  // a Brief entry or an action item wears a chip; the chip opens that
  // rendering and scrolls to the entry, the way the entry jumps to the line.
  const recordRef = useRef<HTMLDivElement | null>(null)
  function openAnchor(a: { kind: 'heard' | 'item'; section?: string; itemId?: string }): void {
    const sel =
      a.kind === 'heard'
        ? `[data-brief-section="${CSS.escape(a.section ?? 'Notes')}"]`
        : `[data-testid="meet-item-${a.itemId ?? ''}"]`
    setView(a.kind === 'heard' ? 'brief' : 'commitments')
    setTimeout(() => recordRef.current?.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
  }

  function seekTimeline(e: React.MouseEvent<HTMLDivElement>): void {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const hit = segmentAtMs(segments, frac * totalMs)
    if (hit) jumpToSegment(hit.id)
  }

  const whenLine = fmtDate(meeting.createdAt)
  const durationLine = totalMs > 0 ? fmtDuration(totalMs) : null
  const captureState: { tone: 'emerald' | 'stone'; label: string } =
    segments.length > 0
      ? { tone: 'emerald', label: 'Transcribed' }
      : meeting.transcript.trim()
        ? { tone: 'stone', label: 'Transcript pasted' }
        : { tone: 'stone', label: 'Notes only' }

  // Highlight the search hits inside a line without touching the text.
  function highlight(text: string): React.ReactNode {
    const q = query.trim()
    if (!q) return text
    const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'))
    return parts.map((part, i) =>
      part.toLowerCase() === q.toLowerCase() ? (
        <mark key={i} className="bg-[rgb(var(--accent)/0.18)] text-inherit rounded-[3px] px-0.5">
          {part}
        </mark>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const tabs = [
    ['brief', 'Overview', '1'],
    ['commitments', 'Action items', '2'],
    ['analytics', 'Analytics', '3']
  ] as const
  const actionCount = filedItems.length + (foundCommitments?.length ?? 0) + unfiledLegacy.length

  return (
    <div className="flex flex-col lg:flex-1 lg:min-h-0" data-testid="meet-detail">
      {/* ── Header: the title, its facts beneath, the doors as quiet surface
          buttons on the right — on a house card. DEC-116 set the title bare
          on the paper; DEC-135 (operator: "add a filled-in colored block
          behind it similar to the timeline block, just for that header title
          field") gives it the Timeline card's own material, edge to edge with
          the cards below it. ───────────────────────────────────────────── */}
      <header className="fb-card px-4 py-3.5 flex items-start justify-between gap-4 flex-wrap mb-4 shrink-0" data-testid="meet-detail-header">
        <div className="min-w-0 flex-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== meeting.title && onChange({ title })}
            className="w-full bg-transparent fb-display-hero text-[22px] leading-tight text-[var(--ink-100)] outline-none"
            data-testid="meet-title"
          />
          {/* ── Meta: state, when, how long, who ─────────────────────────── */}
          <div className="mt-1.5 flex items-center gap-3 flex-wrap" data-testid="meet-meta">
            <StatusPill tone={captureState.tone} label={captureState.label} />
            <span className="text-[12.5px] text-[var(--ink-60)] fb-tabular">{whenLine}</span>
            {durationLine && (
              <>
                <span className="text-[var(--ink-30)]">·</span>
                <span className="text-[12.5px] text-[var(--ink-60)] fb-tabular">{durationLine}</span>
              </>
            )}
            {speakers.length > 0 && (
              <span className="inline-flex items-center gap-2" data-testid="meet-speakers">
                <span className="flex -space-x-1.5">
                  {speakers.map((name) => (
                    // The ring is the card's own fill now (DEC-135), so the
                    // overlapping avatars keep a clean separator on it.
                    <span
                      key={name}
                      title={name}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[9.5px] font-bold text-white ring-2 ring-[var(--surface-raised)]"
                      style={{ backgroundColor: colorOf(name) }}
                    >
                      {speakerInitials(name)}
                    </span>
                  ))}
                </span>
                <span className="text-[12px] text-[var(--ink-50)] fb-tabular">
                  {speakers.length} {speakers.length === 1 ? 'speaker' : 'speakers'}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {meeting.deskNodeId && (
            <button
              onClick={() => goTask(meeting.deskNodeId!)}
              className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
              title="Open this meeting's desk — its documents live there"
              data-testid="meet-open-desk"
            >
              <Icon name="desk" size={16} /> Desk
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              aria-expanded={exportOpen}
              className="inline-flex items-center gap-2 h-9 px-3.5 fb-t-body font-medium fb-btn-surface fb-press text-[var(--ink-80)]"
              title="Export this Record — notes, brief, action items and transcript, provenance kept"
              data-testid="meet-export"
            >
              <Icon name="download" size={16} /> Export
              <Icon name="expand_more" size={14} className={`transition-transform ${exportOpen ? 'rotate-180' : ''}`} />
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-10 z-20 fb-card p-1 min-w-[200px]" onMouseLeave={() => setExportOpen(false)}>
                <button
                  onClick={() => {
                    setExportOpen(false)
                    void window.api.meetings.export(meeting.id, 'markdown').then((r) => r.ok && setExported(r.path ?? null))
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                  data-testid="meet-export-md"
                >
                  Markdown (.md) — readable, provenance kept
                </button>
                <button
                  onClick={() => {
                    setExportOpen(false)
                    void window.api.meetings.export(meeting.id, 'json').then((r) => r.ok && setExported(r.path ?? null))
                  }}
                  className="w-full text-left px-2.5 py-1.5 rounded-md text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                  data-testid="meet-export-json"
                >
                  JSON — the full record, segments and audio manifest
                </button>
              </div>
            )}
          </div>
          <button
            onClick={onDelete}
            className="inline-flex items-center justify-center h-9 w-9 fb-btn-surface fb-press text-[var(--ink-50)] hover:text-red-600"
            title="Delete meeting — its transcript segments and audio go with it" aria-label="Delete meeting"
            data-testid="meet-delete"
          >
            <Icon name="delete" size={16} />
          </button>
        </div>
      </header>

      {/* ── Timeline: who was talking when; click to move through the call ── */}
      {segments.length > 0 && (
        <RailCard
          title="Timeline"
          icon="timeline"
          tone="rose"
          testId="meet-timeline"
          className="mb-4 shrink-0"
          bodyClassName="px-4 pb-3"
          trailing={
            <span className="flex items-center gap-4 min-w-0">
              <span className="text-[12.5px] fb-tabular text-[var(--ink-70)]">
                {activeSegment ? fmtMs(activeSegment.startMs) : '0:00'}
                <span className="text-[var(--ink-30)]"> / </span>
                {fmtMs(totalMs)}
              </span>
              <span className="flex items-center gap-3 text-[11.5px] text-[var(--ink-60)]">
                {speakers.map((name) => (
                  <button
                    key={name}
                    onClick={() => setSpeakerFilter((cur) => (cur === name ? null : name))}
                    className={`inline-flex items-center gap-1.5 fb-press ${speakerFilter === name ? 'text-[var(--ink-100)] font-medium' : ''}`}
                    title={`Show only ${name} in the transcript`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(name) }} />
                    {name}
                  </button>
                ))}
              </span>
            </span>
          }
        >
          <div
            className="relative h-9 rounded-[var(--radius-chip)] overflow-hidden bg-[var(--surface-sunken)] cursor-pointer"
            onClick={seekTimeline}
            title="Click the timeline to move through the call"
            data-testid="meet-timeline-bar"
          >
            {bands.map((b) => (
              <span
                key={b.id}
                className={`absolute top-0 h-full transition-opacity ${
                  speakerFilter && speakerFilter !== b.speaker ? 'opacity-25' : 'opacity-90'
                } ${activeSegmentId === b.id ? 'ring-2 ring-inset ring-[var(--ink-100)]' : ''}`}
                style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, backgroundColor: colorOf(b.speaker) }}
                title={`[${fmtMs(b.startMs)}] ${b.speaker}`}
              />
            ))}
            {activeSegment && (
              <span
                className="absolute top-0 h-full w-0.5 bg-[var(--ink-100)] pointer-events-none"
                style={{ left: `${Math.min(100, (activeSegment.startMs / totalMs) * 100)}%` }}
              />
            )}
          </div>
          {markers.length > 0 && (
            <div className="relative h-4 mt-1" data-testid="meet-timeline-markers">
              {markers.map((m) => (
                <button
                  key={m.key}
                  onClick={() => jumpToSegment(m.segmentId)}
                  title={`[${fmtMs(m.ms)}] ${m.kind === 'heard' ? 'Heard: ' : 'Action item: '}${m.label}`}
                  className="absolute -translate-x-1/2 top-0.5 h-2.5 w-2.5 rotate-45 fb-press"
                  style={{
                    left: `${Math.min(100, (m.ms / totalMs) * 100)}%`,
                    backgroundColor: m.kind === 'heard' ? 'rgb(var(--accent))' : 'transparent',
                    border: m.kind === 'heard' ? 'none' : '1.5px solid var(--ink-60)'
                  }}
                />
              ))}
            </div>
          )}
          <div className="mt-1.5 flex items-center justify-between text-[10.5px] text-[var(--ink-40)] fb-tabular">
            <span>0:00</span>
            <span className="text-[var(--ink-40)]">Click the timeline to move through the call</span>
            <span>{fmtMs(totalMs)}</span>
          </div>
        </RailCard>
      )}

      {/* ── Two columns: renderings left, transcript always on the right ──── */}
      {/* DEC-134 — the two panes share the window's remaining height: each
          hugs short content and caps at the floor (max-h-full of the row), the
          Record scrolling its renderings under the pinned title and segmented
          control, the Transcript scrolling its thread under the pinned search
          and speaker chips. */}
      <div className="flex flex-col lg:flex-row gap-4 items-start lg:flex-1 lg:min-h-0">
        <div className="flex-1 min-w-0 w-full lg:min-h-0 lg:max-h-full lg:flex lg:flex-col" ref={recordRef}>
          <RailCard
            title="Record"
            icon="article"
            tone="accent"
            testId="meet-record-pane"
            className="overflow-hidden flex flex-col min-h-0"
            bodyClassName="px-0 pb-0 min-h-0 overflow-y-auto"
            trailing={
              /* M2b — the segmented control: three renderings, one Record. */
              <div className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--surface-sunken)] shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)]" data-testid="record-views">
              {tabs.map(([v, label, key]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  data-testid={`record-view-${v}`}
                  title={`${label} — press ${key}`}
                  className={`h-7 px-3 rounded-full text-[12.5px] font-medium fb-press transition-colors inline-flex items-center gap-1.5 ${
                    view === v
                      ? 'bg-[rgb(var(--accent))] text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25),0_1px_2px_rgb(0_0_0/0.15)]'
                      : 'text-[var(--ink-60)] hover:text-[var(--ink-100)]'
                  }`}
                >
                  {label}
                  {v === 'commitments' && actionCount > 0 && (
                    <span className={`fb-tabular rounded-full px-1.5 text-[10px] ${view === v ? 'bg-white/20 text-white' : 'bg-[var(--surface-raised)] text-[var(--ink-60)]'}`}>
                      {actionCount}
                    </span>
                  )}
                </button>
              ))}
              </div>
            }
          >
          {/* ── Action items ─────────────────────────────────────────────── */}
          {view === 'commitments' && (
            <div className="px-4 py-4 space-y-5" data-testid="rendering-commitments">
              <p className="text-[12.5px] text-[var(--ink-50)] leading-snug">
                Pulled from the transcript. Checking one off marks it complete everywhere in Plexii; the bell adds it to Focus with a link back to the moment it was said.
              </p>
              {carried.length > 0 && (
                <CarriedFromLastTime
                  items={carried}
                  lastTitle={lastMeeting?.title}
                  lastAt={lastMeeting?.createdAt}
                  band
                />
              )}
              {segments.length > 0 && foundCommitments === null && (
                <button
                  onClick={() => void findCommitments()}
                  disabled={extracting}
                  className="fb-btn-surface inline-flex items-center gap-1.5 text-[12px] h-8 px-3 text-[var(--ink-90)] fb-press disabled:opacity-50"
                  data-testid="find-commitments"
                  title="Extract commitments from the transcript — they go through the confirm stop, never silently into Focus"
                >
                  <Icon name="auto_awesome" size={14} className="text-[rgb(var(--accent))]" />
                  {extracting ? 'Reading the transcript…' : 'Find commitments'}
                </button>
              )}
              {foundCommitments !== null &&
                (foundCommitments.length > 0 ? (
                  <MeetingCommitmentsCard
                    commitments={foundCommitments}
                    meetingId={meeting.id}
                    meetingTitle={meeting.title}
                    deskNodeId={meeting.deskNodeId}
                    onFiled={() => {
                      setFoundCommitments(null)
                      void refreshItems()
                    }}
                  />
                ) : (
                  <p className="text-[12.5px] text-[var(--ink-50)]">
                    Nothing in this transcript reads as a commitment — an honest zero, not a failure.
                  </p>
                ))}

              {filedItems.length > 0 && (
                <div data-testid="meet-filed-items">
                  <RecordSectionTitle>In Focus</RecordSectionTitle>
                  <div className="divide-y divide-[var(--edge-soft)]">
                    {filedItems.map((i) => {
                      const done = isTerminalState(itemState(i))
                      const moment = parseMeetingMomentUrl(i.sourceUrl)
                      const seg = moment?.segmentId ? segments.find((s) => s.id === moment.segmentId) : null
                      return (
                        <div key={i.id} className="flex items-start gap-3 py-2.5" data-testid={`meet-item-${i.id}`}>
                          <button
                            onClick={() => void toggleItemDone(i)}
                            aria-pressed={done}
                            title={done ? 'Completed — click to reopen' : 'Mark complete everywhere in Plexii'}
                            data-testid={`meet-item-done-${i.id}`}
                            className={`mt-0.5 h-5 w-5 shrink-0 rounded-full border-[1.5px] inline-flex items-center justify-center fb-press transition-colors ${
                              done
                                ? 'bg-emerald-500 border-emerald-500 text-white'
                                : 'border-[var(--edge-strong)] hover:border-[rgb(var(--accent))]'
                            }`}
                          >
                            {done && <Icon name="check" size={13} />}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className={`text-[13.5px] leading-snug ${done ? 'line-through text-[var(--ink-50)]' : 'text-[var(--ink-100)]'}`}>
                              {i.title}
                            </div>
                            <div className="mt-1 flex items-center gap-2 flex-wrap text-[11.5px] text-[var(--ink-50)]">
                              {i.intentClass && (
                                <span className="rounded-full bg-[var(--surface-sunken)] px-2 py-0.5 text-[var(--ink-70)]">
                                  {CLASS_LABEL[i.intentClass] ?? i.intentClass}
                                </span>
                              )}
                              {i.dueAt && (
                                <span className="fb-tabular">
                                  due {new Date(i.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                </span>
                              )}
                              {seg && (
                                <button
                                  onClick={() => jumpToSegment(seg.id)}
                                  className="fb-tabular text-[rgb(var(--accent))] hover:underline fb-press"
                                  data-testid={`meet-item-moment-${i.id}`}
                                >
                                  {fmtMs(seg.startMs)} in transcript
                                </button>
                              )}
                            </div>
                          </div>
                          <span
                            className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-[rgb(var(--accent))]"
                            title="This task is in Focus and points back at this meeting"
                          >
                            <Icon name="notifications" size={14} filled /> In Focus
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {meeting.actionItems.length === 0 && filedItems.length === 0 && foundCommitments === null ? (
                <p className="text-[13px] text-[var(--ink-50)]">
                  Nothing was committed to in this meeting — or nothing was recorded. Owners and
                  tasks in Focus arrive with extraction.
                </p>
              ) : (
                unfiledLegacy.length > 0 && (
                  <div data-testid="meet-legacy-items">
                    <RecordSectionTitle>From the summary</RecordSectionTitle>
                    <div className="divide-y divide-[var(--edge-soft)]">
                      {unfiledLegacy.map(({ text: item, i }) => (
                        <div key={i} className="flex items-start gap-3 py-2.5">
                          {/* Hollow: this line has no state of its own yet — the
                              bell gives it one, and a real checkbox, above. */}
                          <Icon name="radio_button_unchecked" size={18} className="mt-0.5 text-[var(--ink-30)] shrink-0" />
                          <span className="flex-1 text-[13.5px] leading-snug text-[var(--ink-90)]">{item}</span>
                          <button
                            onClick={() => void sendLegacyToAttention(i, item)}
                            disabled={!!filing[i]}
                            className="inline-flex items-center gap-1 text-[11px] h-7 px-2 rounded-full fb-press transition-colors text-[var(--ink-50)] hover:text-[rgb(var(--accent))] hover:bg-[rgb(var(--accent)/0.08)] disabled:opacity-50"
                            title="Add to Focus — it will point back at this meeting"
                            data-testid={`meet-legacy-bell-${i}`}
                          >
                            <Icon name="notifications" size={14} />
                            {filing[i] ? 'Adding…' : 'Add to Focus'}
                          </button>
                          <button
                            onClick={() => void makeTask(i, item)}
                            disabled={madeTasks[i]}
                            className="fb-btn-surface shrink-0 inline-flex items-center gap-1 text-[11px] h-7 px-2 text-[var(--ink-90)] disabled:opacity-50"
                            title="Make a desk for this"
                            data-testid={`meet-make-task-${i}`}
                          >
                            <Icon name={madeTasks[i] ? 'check' : 'add_task'} size={13} /> {madeTasks[i] ? 'Added' : 'Desk'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {/* ── Overview: the Brief, organised by section ─────────────────── */}
          {view === 'brief' && (
            <div className="px-4 py-4 space-y-4" data-testid="rendering-brief-outer">
              <section>
                <RecordSectionTitle>Summary</RecordSectionTitle>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  onBlur={() => summary !== meeting.summary && onChange({ summary })}
                  placeholder="The summary appears here after recording, or write your own."
                  className="w-full min-h-[72px] resize-y rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-transparent focus:border-[rgb(var(--accent))] px-3 py-2.5 text-[13.5px] leading-relaxed text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none transition-colors"
                  data-testid="meet-summary"
                />
              </section>
              {/* M2c (§3.5) — rebuild the Brief under a different template. The
                  Commitments rendering is never templated: its shape is the
                  product. yours spans survive every rebuild untouched. */}
              {segments.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap" data-testid="record-templates">
                  <span className="text-[11px] text-[var(--ink-40)] mr-1">Brief as</span>
                  {RECORD_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      disabled={rebuilding}
                      onClick={() => void rebuildBrief(tpl.sections)}
                      title={`Rebuild the Brief as “${tpl.name}” — sections: ${tpl.sections.join(' · ')}`}
                      className="h-7 px-2.5 rounded-full text-[11.5px] fb-press bg-[var(--surface-sunken)] text-[var(--ink-70)] hover:text-[var(--ink-100)] disabled:opacity-50"
                    >
                      {rebuilding ? '…' : tpl.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {view === 'brief' && (
            <div className="px-4 pb-4" data-testid="rendering-brief">
              {meeting.record && meeting.record.spans.length > 0 ? (
                <div className="space-y-5">
                  {/* yours first — the reader's own words lead. */}
                  {meeting.record.spans.filter((s) => s.tier === 'yours').length > 0 && (
                    <div className="space-y-1" data-testid="brief-yours">
                      <RecordSectionTitle>Your notes</RecordSectionTitle>
                      {meeting.record.spans
                        .filter((s) => s.tier === 'yours')
                        .map((s, i) => (
                          <p key={`y${i}`} className="text-[13.5px] leading-relaxed text-[var(--ink-100)]">
                            {s.text}
                          </p>
                        ))}
                    </div>
                  )}
                  {[...new Set(meeting.record.spans.filter((s) => s.tier !== 'yours').map((s) => s.section ?? 'Notes'))].map(
                    (section) => (
                      <section key={section} data-brief-section={section}>
                        <RecordSectionTitle>{section}</RecordSectionTitle>
                        <div className="space-y-1.5">
                          {meeting.record!.spans
                            .filter((s) => s.tier !== 'yours' && (s.section ?? 'Notes') === section)
                            .map((s, i) =>
                              s.tier === 'heard' && s.segmentId ? (
                                <button
                                  key={`h${i}`}
                                  onClick={() => jumpToSegment(s.segmentId!)}
                                  title={s.startMs != null ? `Heard at ${fmtMs(s.startMs)} — click to jump to the moment` : undefined}
                                  data-tier="heard"
                                  className="flex w-full items-start gap-3 text-left text-[13px] leading-relaxed text-[var(--ink-90)] border-l-2 border-[var(--edge-strong)] pl-2.5 hover:border-[rgb(var(--accent))] fb-press"
                                >
                                  <span className="flex-1">{s.text}</span>
                                  {s.startMs != null && (
                                    <span className="fb-tabular text-[11px] text-[var(--ink-40)] shrink-0 pt-0.5">{fmtMs(s.startMs)}</span>
                                  )}
                                </button>
                              ) : (
                                <p key={`i${i}`} data-tier="inferred" className="flex items-start gap-3 text-[13px] leading-relaxed text-[var(--ink-50)] pl-2.5">
                                  <span className="flex-1">{s.text}</span>
                                  <span className="text-[10px] uppercase tracking-wider text-[var(--ink-30)] shrink-0 pt-1" title="No transcript anchor — the machine's reading">inferred</span>
                                </p>
                              )
                            )}
                        </div>
                      </section>
                    )
                  )}
                </div>
              ) : (
                <p className="text-[13px] text-[var(--ink-50)]">
                  {meeting.summary
                    ? 'The Brief is built when a recorded meeting ends — the summary above is what this meeting has.'
                    : 'No record yet — it is built when a recorded meeting ends.'}
                </p>
              )}
              {/* The plain transcript text stays editable for notes-only
                  meetings (paste your own); with segments present it is the
                  same fact rendered twice, so it folds away. */}
              <section className="mt-5">
                <button
                  onClick={() => setShowTranscript((v) => !v)}
                  aria-expanded={showTranscript || segments.length === 0}
                  className={`${RECORD_SECTION_BAND} w-full flex items-center gap-1.5 text-[13.5px] font-semibold tracking-tight text-[var(--ink-100)] fb-press`}
                  data-record-section-title
                >
                  <Icon name="expand_more" size={14} className={`transition-transform ${showTranscript || segments.length === 0 ? 'rotate-180' : ''}`} />
                  Plain transcript text
                </button>
                {(showTranscript || segments.length === 0) && (
                  <textarea
                    value={transcript}
                    onChange={(e) => setTranscript(e.target.value)}
                    onBlur={() => transcript !== meeting.transcript && onChange({ transcript })}
                    placeholder="The full transcript appears here after recording, or paste your own."
                    className="w-full min-h-[140px] resize-y rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-transparent focus:border-[rgb(var(--accent))] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--ink-90)] placeholder:text-[var(--ink-50)] outline-none transition-colors"
                  />
                )}
              </section>
            </div>
          )}

          {/* ── Analytics: facts from the segments, never scores ──────────── */}
          {view === 'analytics' && (
            <div className="px-4 py-4 space-y-5" data-testid="rendering-analytics">
              {segments.length === 0 ? (
                <p className="text-[13px] text-[var(--ink-50)]">
                  Analytics need an attributed transcript. Record a meeting and they appear here — empty is an honest answer, not a failure.
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
                    <StatTile icon="schedule" label="Duration" value={fmtDuration(totalMs)} tone="accent" />
                    <StatTile icon="swap_horiz" label="Speaker changes" value={speakerChanges(segments)} tone="sky" />
                    <StatTile icon="help" label="Questions asked" value={questionCount(segments)} tone="violet" />
                    <StatTile icon="notes" label="Lines" value={segments.length} tone="stone" />
                  </div>
                  <section data-testid="meet-who-spoke">
                    <RecordSectionTitle>Who spoke</RecordSectionTitle>
                    <p className="text-[12px] text-[var(--ink-50)] mb-2.5">
                      Share of the transcript by speaker — a fact from the attributed lines, not a score. Click a name to read only them.
                    </p>
                    <div className="space-y-2">
                      {speakers.map((name) => {
                        const ms = spokenMs.get(name) ?? 0
                        const pct = spokenTotal > 0 ? Math.round((ms / spokenTotal) * 100) : 0
                        return (
                          <button
                            key={name}
                            onClick={() => setSpeakerFilter((cur) => (cur === name ? null : name))}
                            className={`w-full flex items-center gap-3 fb-press rounded-md px-1 py-0.5 ${speakerFilter === name ? 'bg-[rgb(var(--accent)/0.08)]' : 'hover:bg-[var(--surface-sunken)]'}`}
                            data-testid={`meet-speaker-share-${name}`}
                          >
                            <span className="inline-flex items-center gap-1.5 w-28 shrink-0 text-[13px] text-[var(--ink-90)] truncate">
                              <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: colorOf(name) }} />
                              {name}
                            </span>
                            <span className="flex-1 h-2 rounded-full bg-[var(--surface-sunken)] overflow-hidden">
                              <span className="block h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: colorOf(name) }} />
                            </span>
                            <span className="fb-tabular text-[12px] text-[var(--ink-60)] w-24 text-right shrink-0">
                              {pct}% · {fmtMs(ms)}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                  {markers.length > 0 && (
                    <section>
                      <RecordSectionTitle>Moments</RecordSectionTitle>
                      <p className="text-[12px] text-[var(--ink-50)] mb-2">
                        Where the Record and your action items point into the call. Each one opens the line.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {[...markers]
                          .sort((a, b) => a.ms - b.ms)
                          .map((m) => (
                            <button
                              key={m.key}
                              onClick={() => jumpToSegment(m.segmentId)}
                              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] fb-press bg-[var(--surface-sunken)] text-[var(--ink-70)] hover:text-[var(--ink-100)] max-w-[260px]"
                              title={m.label}
                            >
                              <span className="fb-tabular text-[var(--ink-40)]">{fmtMs(m.ms)}</span>
                              <span className="truncate">{m.label}</span>
                            </button>
                          ))}
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          )}
          </RailCard>
        </div>

        {/* ── Transcript: always visible, tagged, searchable, linked ────────── */}
        <RailCard
          title="Transcript"
          icon="subtitles"
          tone="sky"
          testId="meet-transcript-pane"
          className="w-full lg:w-[44%] lg:max-w-[560px] shrink-0 flex flex-col lg:min-h-0 lg:max-h-full"
          bodyClassName="flex-1 min-h-0 flex flex-col"
          trailing={
            segments.length > 0 ? (
              <span className="fb-tabular text-[12px] text-[var(--ink-40)]">
                {visibleSegments.length === segments.length
                  ? `${segments.length} ${segments.length === 1 ? 'line' : 'lines'}`
                  : `${visibleSegments.length} of ${segments.length}`}
              </span>
            ) : undefined
          }
        >
          <div className="px-3 pb-2 border-b border-[var(--edge-soft)] space-y-2">
            <div className="flex items-center gap-1.5 px-2.5 h-9 rounded-[var(--radius-field)] bg-[var(--surface-sunken)] border border-transparent focus-within:border-[rgb(var(--accent))] transition-colors">
              <Icon name="search" size={14} className="text-[var(--ink-50)]" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the transcript"
                className="flex-1 bg-transparent text-[12.5px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] outline-none"
                data-testid="meet-transcript-search"
              />
              {query ? (
                <button onClick={() => setQuery('')} className="text-[var(--ink-40)] hover:text-[var(--ink-100)]" aria-label="Clear search">
                  <Icon name="close" size={14} />
                </button>
              ) : (
                <kbd className="text-[10.5px] text-[var(--ink-40)] px-1.5 py-0.5 rounded bg-[var(--surface-raised)] border border-[var(--edge-soft)]">/</kbd>
              )}
            </div>
            {speakers.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="meet-speaker-chips">
                <button
                  onClick={() => setSpeakerFilter(null)}
                  className={`h-7 px-2.5 rounded-full text-[11.5px] fb-press transition-colors ${
                    speakerFilter === null
                      ? 'bg-[var(--ink-100)] text-[var(--surface-raised)]'
                      : 'bg-[var(--surface-sunken)] text-[var(--ink-70)] hover:text-[var(--ink-100)]'
                  }`}
                  data-testid="meet-speaker-chip-all"
                >
                  All speakers
                </button>
                {speakers.map((name) => (
                  <button
                    key={name}
                    onClick={() => setSpeakerFilter((cur) => (cur === name ? null : name))}
                    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[11.5px] fb-press border transition-colors ${
                      speakerFilter === name
                        ? 'border-[var(--ink-100)] text-[var(--ink-100)] bg-[var(--surface-raised)]'
                        : 'border-[var(--edge-soft)] text-[var(--ink-70)] hover:text-[var(--ink-100)]'
                    }`}
                    data-testid={`meet-speaker-chip-${name}`}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorOf(name) }} />
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2" data-testid="rendering-thread" ref={threadRef}>
            {segments.length > 0 ? (
              visibleSegments.length > 0 ? (
                <div className="space-y-0.5">
                  {visibleSegments.map((s) => {
                    const name = s.speakerName?.trim() || 'Speaker'
                    const active = s.id === activeSegmentId
                    const rowAnchors = markers.filter((m) => m.segmentId === s.id)
                    // One chip per door: two Brief entries under the same
                    // section that cite this line open the same place.
                    const rowChips = rowAnchors.filter(
                      (a, i, all) =>
                        all.findIndex((b) => b.kind === a.kind && (a.kind === 'heard' ? b.section === a.section : b.itemId === a.itemId)) === i
                    )
                    return (
                      <div
                        key={s.id}
                        data-segment-id={s.id}
                        onClick={() => setActiveSegmentId(s.id)}
                        className={`flex items-start gap-3 rounded-lg px-2 py-2 transition-colors cursor-default ${
                          active ? 'bg-[rgb(var(--accent)/0.10)]' : 'hover:bg-[var(--surface-sunken)]'
                        } ${s.confidence != null && s.confidence < 0.5 ? 'opacity-60' : ''}`}
                        title={
                          s.confidence != null
                            ? `Engine confidence ${(s.confidence * 100).toFixed(0)}%`
                            : 'Engine confidence unknown (on-device)'
                        }
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            jumpToSegment(s.id)
                          }}
                          className="fb-tabular text-[11px] text-[var(--ink-40)] hover:text-[rgb(var(--accent))] w-10 shrink-0 pt-0.5 text-left fb-press"
                          title="Move the timeline here"
                        >
                          {fmtMs(s.startMs)}
                        </button>
                        <div className="flex-1 min-w-0">
                          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: colorOf(name) }}>
                            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colorOf(name) }} />
                            {name}
                          </span>
                          <div className="text-[13px] leading-relaxed text-[var(--ink-90)]">{highlight(s.text)}</div>
                          {rowChips.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1" data-testid={`meet-row-anchors-${s.id}`}>
                              {rowChips.map((a) => (
                                <button
                                  key={a.key}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    openAnchor(a)
                                  }}
                                  className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full text-[10.5px] font-medium bg-[rgb(var(--accent)/0.08)] text-[rgb(var(--accent))] hover:bg-[rgb(var(--accent)/0.14)] fb-press"
                                  title={
                                    a.kind === 'heard'
                                      ? `This line is the source of a Brief entry under ${a.section} — open it`
                                      : `This line is where “${a.label}” was committed to — open the action item`
                                  }
                                >
                                  <Icon name={a.kind === 'heard' ? 'article' : 'task_alt'} size={11} />
                                  {a.kind === 'heard' ? `In Brief · ${a.section}` : 'Action item'}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="px-2 py-6 text-[12.5px] text-[var(--ink-50)]" data-testid="meet-transcript-empty-filter">
                  {query.trim()
                    ? `Nothing in the transcript matches “${query.trim()}”${speakerFilter ? ` from ${speakerFilter}` : ''}.`
                    : `${speakerFilter} has no lines in this transcript.`}
                </p>
              )
            ) : meeting.transcript ? (
              <pre className="whitespace-pre-wrap px-2 text-[12.5px] leading-relaxed text-[var(--ink-80)] font-[inherit]">
                {meeting.transcript}
              </pre>
            ) : (
              <p className="px-2 py-6 text-[13px] text-[var(--ink-50)]">No transcript for this meeting.</p>
            )}
          </div>
        </RailCard>
      </div>

      {/* ── Footer facts: series knobs, audio on disk, export receipt ──────── */}
      {/* M5 (Q14) — the per-series brief knob, on the series meeting itself:
          a series whose briefs are noise gets silenced here, and the wrap-up
          asks before minting the next one. */}
      {meeting.seriesId && seriesBriefs !== null && (
        <div className="mt-4">
          <label className="flex items-center gap-2 text-[11.5px] text-[var(--ink-50)] cursor-pointer" data-testid="series-briefs-row">
            <input
              type="checkbox"
              checked={seriesBriefs}
              onChange={(e) => {
                const next = e.target.checked
                setSeriesBriefs(next)
                void window.api.meetings
                  .setSeriesPrefs(meeting.seriesId!, { briefs: next })
                  .catch(() => setSeriesBriefs(!next))
              }}
              className="accent-[rgb(var(--accent))]"
              data-testid="series-briefs-toggle"
            />
            <span>Brief me after each meeting in this series</span>
          </label>
          {/* Q14, the delivery half — OFF by default: sending is its own
              act. On: the wrap-up DMs the brief to the other attendees
              (server-persisted, so an away teammate meets it on next open);
              whether it FILES on their side is their own per-series choice. */}
          {seriesShare !== null && (
            <label className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--ink-50)] cursor-pointer" data-testid="series-share-row">
              <input
                type="checkbox"
                checked={seriesShare}
                onChange={(e) => {
                  const next = e.target.checked
                  setSeriesShare(next)
                  void window.api.meetings
                    .setSeriesPrefs(meeting.seriesId!, { shareBriefs: next })
                    .catch(() => setSeriesShare(!next))
                }}
                className="accent-[rgb(var(--accent))]"
                data-testid="series-share-toggle"
              />
              <span>Send the brief to the other attendees too</span>
            </label>
          )}
        </div>
      )}
      {(audio?.present || exported) && (
        <div className="mt-3 space-y-1.5">
          {audio?.present && (
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--ink-50)]" data-testid="meet-audio-row">
              <Icon name="graphic_eq" size={13} className="shrink-0" />
              <span className="flex-1">
                {audio.files} audio track{audio.files === 1 ? '' : 's'} on this machine (
                {(audio.bytes / 1_000_000).toFixed(1)} MB) — never uploaded.
              </span>
              <button
                onClick={() =>
                  void window.api.meetings.keepAudio(meeting.id, !audio.kept).then(() =>
                    window.api.meetings.audioInfo(meeting.id).then(setAudio)
                  )
                }
                className={`fb-press text-[11px] px-2 py-0.5 rounded-full ${
                  audio.kept ? 'bg-accent/15 text-[rgb(var(--accent))]' : 'bg-[var(--surface-sunken)] text-[var(--ink-60)]'
                }`}
                title={audio.kept ? 'Kept forever — click to return to the retention window' : 'Keep this meeting’s audio past the retention window'}
                data-testid="meet-keep-audio"
              >
                {audio.kept ? 'Kept' : 'Keep'}
              </button>
              <button
                onClick={() => void window.api.meetings.revealAudio(meeting.id)}
                className="fb-press text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-100)]"
                title="Show the audio files in Finder"
              >
                Reveal
              </button>
              <button
                onClick={() => void retranscribe()}
                disabled={!!retranscribing}
                className="fb-press text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-100)] disabled:opacity-50"
                title="Run the saved audio through the current on-device engine again — segments, transcript and summary are rewritten; audio never leaves this machine"
                data-testid="meet-retranscribe"
              >
                {retranscribing ?? 'Re-transcribe'}
              </button>
            </div>
          )}
          {exported && (
            <div className="text-[11.5px] text-[var(--ink-50)]" data-testid="meet-exported">
              Exported to {exported}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
