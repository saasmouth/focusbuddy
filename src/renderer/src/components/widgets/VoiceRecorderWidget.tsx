import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActionProposal, AppliedProposal, Widget, WidgetKind } from '@shared/types'
import ProposalCards from '../ProposalCards'
import WidgetFrame from './WidgetFrame'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import { useWidgetStore } from '../../stores/widgets'
import { useNodeStore } from '../../stores/nodes'
import { useFilesStore } from '../../stores/files'

// Voice/video-note recorder + AI pipeline widget.
//
// Lifecycle states:
//   - idle            : empty widget — pick audio/video, then "Start"
//   - recording       : MediaRecorder running, live captions stream
//                       from the browser's SpeechRecognition (free,
//                       not stored); shows duration + Stop
//   - transcribing    : audio/video stopped, authoritative pass via
//                       Whisper (cloud or local)
//   - processing      : Anthropic post-process (clean/summary/diarise)
//   - ready           : transcript shown, mode toggle + actions panel
//   - error           : whisper/process failed; "Try again" button
//
// Persistence: the whole state above (except live captions) is
// serialised into widget.content as JSON so reload restores the
// transcript + last mode result + cached proposals + capture mode.
// The recording itself lives in the files store (fb-file://) so the
// user can replay it any time as audio or video.

type ProcessMode = 'full' | 'cleaned' | 'summary' | 'diarised'
type CaptureMode = 'audio' | 'video'

interface PersistedState {
  // fb_files.id of the recorded media. Null until first recording finishes.
  fileId: string | null
  // What was captured — drives the replay control choice (<audio> vs
  // <video>) and the icon on the kicker button when re-recording.
  captureMode: CaptureMode
  // Raw Whisper output. Source of truth for processing modes.
  transcript: string
  // Detected language code (cloud-only — local Whisper tiny doesn't
  // reliably surface this).
  language: string | null
  // Duration in seconds.
  durationSec: number | null
  // Last mode the user selected. Determines which processed text is cached.
  mode: ProcessMode
  // Last processed output for `mode`. Avoids re-paying for a clean/summary/
  // diarise on every widget remount.
  processedText: string
  // Cached extracted proposals from the LAST extractActions call. Cleared
  // when transcript changes (i.e. a re-recording).
  proposals: ActionProposal[]
}

const EMPTY_STATE: PersistedState = {
  fileId: null,
  captureMode: 'audio',
  transcript: '',
  language: null,
  durationSec: null,
  mode: 'summary',
  processedText: '',
  proposals: []
}

interface Props {
  widget: Widget
  inline?: boolean
}

export default function VoiceRecorderWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  // IMPORTANT: use the STORE's create action, not window.api.widgets.create
  // directly. The store wraps the IPC AND pushes the new widget into the
  // local widgets array so it renders immediately. The raw IPC writes to
  // SQLite without telling the store, leaving the canvas blank until the
  // task reloads — that was the "Send to doesn't do anything" bug.
  const createWidget = useWidgetStore((s) => s.create)
  const activeTaskId = useNodeStore((s) => s.activeTaskId)
  const allWidgets = useWidgetStore((s) => s.widgets)
  const blobUrl = useFilesStore((s) => s.blobUrl)

  // Hydrate from widget.content (or empty state if it's a fresh widget).
  const persisted = useRef<PersistedState>(parsePersisted(widget.content))
  const [state, setState] = useState<PersistedState>(persisted.current)

  function persist(next: PersistedState): void {
    persisted.current = next
    setState(next)
    void update(widget.id, { content: JSON.stringify(next) })
  }

  const [phase, setPhase] = useState<
    'idle' | 'recording' | 'transcribing' | 'processing' | 'extracting' | 'ready' | 'error'
  >(state.transcript ? 'ready' : 'idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [recDuration, setRecDuration] = useState(0)
  // Live captions stream from Web Speech API during recording. Not
  // persisted — purely a UX preview. The authoritative transcript comes
  // from Whisper on stop.
  const [liveCaption, setLiveCaption] = useState<string>('')
  // Applied-state for the shared ProposalCards (the approval-card standard).
  const [appliedProposals, setAppliedProposals] = useState<Record<string, AppliedProposal>>({})

  // ── Recording machinery ──────────────────────────────────────────────────
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const durationTimerRef = useRef<number | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    return () => {
      stopStream()
      if (durationTimerRef.current !== null) {
        window.clearInterval(durationTimerRef.current)
      }
      stopLiveCaptions()
    }
  }, [])

  function stopStream(): void {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop()
      } catch {
        // already stopped
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    recorderRef.current = null
  }

  function startLiveCaptions(): void {
    // The Web Speech API is Chromium-only and ships in Electron. It
    // sends short audio segments to Google's STT cloud service and
    // returns interim + final results. We use this purely as a real-
    // time UX preview — no audio bytes are stored by us OR by Google
    // beyond the inflight request.
    const SR =
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
        .webkitSpeechRecognition ||
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor })
        .SpeechRecognition
    if (!SR) return // gracefully degrade — recording still works, just no live captions
    try {
      const rec = new SR()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = navigator.language || 'en-US'
      let finalText = ''
      let interimText = ''
      rec.onresult = (event: SpeechRecognitionResultListEvent) => {
        interimText = ''
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i]
          if (r.isFinal) finalText += r[0].transcript + ' '
          else interimText += r[0].transcript
        }
        setLiveCaption((finalText + ' ' + interimText).trim())
      }
      rec.onerror = (): void => {
        // Don't surface this — live captions are a non-essential
        // preview. The Whisper pass on stop produces the real
        // transcript regardless.
      }
      rec.start()
      recognitionRef.current = rec
    } catch {
      // unsupported on this build — skip
    }
  }

  function stopLiveCaptions(): void {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore
      }
      recognitionRef.current = null
    }
  }

  async function startRecording(captureMode: CaptureMode): Promise<void> {
    setErrorMsg(null)
    setErrorReason(null)
    setLiveCaption('')
    try {
      const constraints: MediaStreamConstraints = {
        audio: true,
        video: captureMode === 'video' ? { width: 640, height: 360 } : false
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      streamRef.current = stream
      chunksRef.current = []

      const mr = new MediaRecorder(stream)
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      mr.onstop = () => {
        const mimeType = mr.mimeType || (captureMode === 'video' ? 'video/webm' : 'audio/webm')
        const blob = new Blob(chunksRef.current, { type: mimeType })
        chunksRef.current = []
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null
        void onRecordingFinished(blob, captureMode)
      }
      mr.start(250)
      recorderRef.current = mr

      // Persist the captureMode + flip the phase so RecordingState
      // mounts. The video preview's srcObject gets attached by the
      // useEffect below — we can't do it synchronously here because the
      // <video> element doesn't exist until RecordingState renders.
      persist({ ...state, captureMode })
      setPhase('recording')
      setRecDuration(0)
      durationTimerRef.current = window.setInterval(() => {
        setRecDuration((d) => d + 1)
      }, 1000)
      startLiveCaptions()
    } catch (err) {
      setPhase('error')
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(
        captureMode === 'video'
          ? `Camera + microphone access denied or unavailable: ${msg}. ` +
              `On macOS: System Settings → Privacy & Security → Camera + Microphone → make sure PlexiiDesk is allowed.`
          : `Microphone access denied or unavailable: ${msg}`
      )
    }
  }

  // Wire the live stream into the <video> preview element AFTER
  // RecordingState mounts. Doing this inside startRecording fails:
  // the ref is still null at that point because the video element
  // doesn't exist until phase === 'recording'. This effect fires
  // exactly when both ref and stream are available.
  useEffect(() => {
    if (
      phase === 'recording' &&
      state.captureMode === 'video' &&
      videoPreviewRef.current &&
      streamRef.current
    ) {
      const videoEl = videoPreviewRef.current
      videoEl.srcObject = streamRef.current
      void videoEl.play().catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[VoiceRecorderWidget] video preview play failed:', err)
      })
    }
  }, [phase, state.captureMode])

  function stopRecording(): void {
    if (durationTimerRef.current !== null) {
      window.clearInterval(durationTimerRef.current)
      durationTimerRef.current = null
    }
    stopLiveCaptions()
    stopStream()
  }

  async function onRecordingFinished(blob: Blob, captureMode: CaptureMode): Promise<void> {
    setPhase('transcribing')
    const buffer = await blob.arrayBuffer()

    // Persist the recording to the files store first (so the user can
    // replay it even if Whisper fails downstream).
    let fileId: string | null = null
    try {
      const file = await window.api.files.ingestBuffer({
        buffer,
        originalName: `voice-note-${Date.now()}.${blob.type.includes('webm') ? 'webm' : 'm4a'}`,
        mimeType: blob.type || (captureMode === 'video' ? 'video/webm' : 'audio/webm')
      })
      fileId = file.id
    } catch (err) {
      setPhase('error')
      setErrorMsg(`Could not save recording: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // eslint-disable-next-line no-console
    console.log(
      `[VoiceRecorderWidget] transcribing ${buffer.byteLength} bytes (mime=${blob.type || 'auto'})`
    )

    // The local Whisper backend needs pre-decoded PCM samples
    // (Float32Array @ 16kHz mono) because Node main doesn't have
    // Web Audio API. Decoding happens here in the renderer where
    // AudioContext is available. For cloud, raw bytes are smaller
    // over IPC and the Whisper API accepts compressed audio
    // directly, so we skip decoding entirely.
    let samples: Float32Array | undefined
    let sampleRate: number | undefined
    try {
      const provider = await window.api.voiceNote.getProvider()
      if (provider === 'local') {
        const decoded = await decodeToMono16k(buffer)
        samples = decoded.samples
        sampleRate = decoded.sampleRate
      }
    } catch (err) {
      // Provider lookup or decoding failed — log but don't bail. If
      // we have raw bytes we'll try the cloud path; if local was the
      // intended provider, the main side will return a clear error.
      // eslint-disable-next-line no-console
      console.warn('[VoiceRecorderWidget] provider/decode pre-step failed:', err)
    }

    let transcribed:
      | { ok: true; transcript: string; durationSec: number | null; language: string | null }
      | { ok: false; error: string; reason?: 'no_key' | 'network' | 'api' | 'unknown' | 'model_load' | 'decode' }
    try {
      transcribed = await window.api.voiceNote.transcribe({
        buffer,
        mimeType: blob.type || (captureMode === 'video' ? 'video/webm' : 'audio/webm'),
        samples,
        sampleRate
      })
    } catch (err) {
      // Reached when the IPC handler doesn't exist on main (renderer
      // running new code, main running old). Without this catch the
      // promise rejects, the widget stays pinned in 'transcribing', and
      // the user sees an infinite spinner.
      // eslint-disable-next-line no-console
      console.error('[VoiceRecorderWidget] transcribe IPC failed:', err)
      setPhase('error')
      setErrorMsg(
        `Transcription unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
          'If this is the first time you\'ve seen it, quit PlexiiDesk (⌘Q) and reopen — ' +
          'the renderer is running new code that the main process hasn\'t loaded yet.'
      )
      setErrorReason('unknown')
      persist({ ...EMPTY_STATE, fileId, captureMode, mode: state.mode })
      return
    }
    if (!transcribed.ok) {
      setPhase('error')
      setErrorMsg(transcribed.error)
      setErrorReason(transcribed.reason ?? null)
      persist({ ...EMPTY_STATE, fileId, captureMode, mode: state.mode })
      return
    }

    setPhase('processing')
    const [processed, extracted] = await Promise.all([
      window.api.voiceNote.process({
        transcript: transcribed.transcript,
        mode: state.mode
      }),
      window.api.voiceNote.extractActions({ transcript: transcribed.transcript })
    ])

    const next: PersistedState = {
      fileId,
      captureMode,
      transcript: transcribed.transcript,
      language: transcribed.language,
      durationSec: transcribed.durationSec ?? recDuration,
      mode: state.mode,
      processedText: processed.ok ? processed.text : transcribed.transcript,
      proposals: extracted.ok ? extracted.proposals : []
    }
    persist(next)
    setLiveCaption('')
    setPhase('ready')
  }

  async function switchMode(nextMode: ProcessMode): Promise<void> {
    if (nextMode === state.mode) return
    if (nextMode === 'full') {
      persist({ ...state, mode: 'full', processedText: state.transcript })
      return
    }
    setPhase('processing')
    const result = await window.api.voiceNote.process({
      transcript: state.transcript,
      mode: nextMode
    })
    if (!result.ok) {
      setPhase('error')
      setErrorMsg(result.error)
      setErrorReason(result.reason ?? null)
      return
    }
    persist({ ...state, mode: nextMode, processedText: result.text })
    setPhase('ready')
  }

  // ── Action proposals ─────────────────────────────────────────────────────
  // Apply is owned by the shared ProposalCards (the approval-card standard) — it
  // handles resolvedIds batching correctly (the old bespoke applyAll here passed
  // no resolvedIds, so a create-table + add-table-row batch from one note failed).
  // This widget only removes a card when it's dismissed/consumed.
  function dismiss(id: string): void {
    persist({
      ...state,
      proposals: state.proposals.filter((p) => p.id !== id)
    })
  }

  // ── Destination picker (+ append-to-existing) ────────────────────────────
  const [destinationOpen, setDestinationOpen] = useState(false)

  async function spawnNewWidget(targetKind: WidgetKind): Promise<void> {
    if (!activeTaskId) {
      setErrorMsg('Open a task before sending — work widgets need a parent task.')
      return
    }
    const text = state.processedText || state.transcript
    if (!text.trim()) {
      setErrorMsg('Nothing to send — record + transcribe first.')
      return
    }
    try {
      await createWidget({
        taskId: activeTaskId,
        kind: targetKind,
        title:
          state.mode === 'summary'
            ? 'Voice note summary'
            : state.mode === 'cleaned'
              ? 'Voice note (cleaned)'
              : state.mode === 'diarised'
                ? 'Voice note (diarised)'
                : 'Voice note transcript',
        content: text,
        x: widget.x + 40,
        y: widget.y + 40,
        width: defaultsFor(targetKind).w,
        height: defaultsFor(targetKind).h
      })
      setDestinationOpen(false)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[VoiceRecorderWidget] spawnNewWidget failed:', err)
      setErrorMsg(
        `Could not create work widget: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async function appendToWidget(target: Widget): Promise<void> {
    const text = state.processedText || state.transcript
    if (!text.trim()) return
    const separator = (target.content || '').trim().length > 0 ? '\n\n' : ''
    const banner = `--- Voice note (${state.mode}) · ${new Date().toLocaleString()} ---\n`
    const next = (target.content || '') + separator + banner + text
    await update(target.id, { content: next })
    setDestinationOpen(false)
  }

  // List of widgets on the current task that can accept appended text.
  // Page widget uses Tiptap JSON for its content, so a raw-text append
  // doesn't render usefully — exclude it from v1.
  const appendableWidgets = useMemo(
    () =>
      allWidgets.filter(
        (w) =>
          w.id !== widget.id &&
          !w.archived &&
          (w.kind === 'sticky' || w.kind === 'note' || w.kind === 'markdown')
      ),
    [allWidgets, widget.id]
  )

  // ── Replay (audio or video depending on captureMode) ─────────────────────
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!state.fileId) {
      setMediaUrl(null)
      return
    }
    void blobUrl(state.fileId).then((url) => {
      if (!cancelled) setMediaUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [state.fileId, blobUrl])

  // ────────────────────────────────────────────────────────────────────────
  const body = (
    <div className="h-full w-full bg-[var(--surface-sunken)] flex flex-col overflow-hidden relative">
      {phase === 'idle' && (
        <IdleState onStart={(m) => void startRecording(m)} />
      )}
      {phase === 'recording' && (
        <RecordingState
          durationSec={recDuration}
          captureMode={state.captureMode}
          videoRef={videoPreviewRef}
          liveCaption={liveCaption}
          onStop={stopRecording}
        />
      )}
      {(phase === 'transcribing' || phase === 'processing' || phase === 'extracting') && (
        <BusyState
          label={
            phase === 'transcribing'
              ? 'Transcribing audio…'
              : phase === 'processing'
                ? state.mode === 'diarised'
                  ? 'Identifying speakers…'
                  : 'Cleaning up the text…'
                : 'Extracting tasks…'
          }
        />
      )}
      {phase === 'error' && (
        <ErrorState
          message={errorMsg ?? 'Something went wrong.'}
          reason={errorReason}
          canRetry={state.fileId !== null}
          onRetry={() => {
            if (!state.fileId) {
              void startRecording(state.captureMode)
              return
            }
            void retryTranscription(state.fileId)
          }}
          onRecordAgain={() => void startRecording(state.captureMode)}
        />
      )}
      {phase === 'ready' && (
        <ReadyState
          state={state}
          mediaUrl={mediaUrl}
          onSwitchMode={(m) => void switchMode(m)}
          activeTaskId={activeTaskId}
          appliedProposals={appliedProposals}
          onApplied={(id, a) => setAppliedProposals((prev) => ({ ...prev, [id]: a }))}
          onConsume={dismiss}
          onRecordAgain={(m) => void startRecording(m)}
          onOpenDestinationPicker={() => setDestinationOpen(true)}
        />
      )}
      {destinationOpen && (
        <DestinationPicker
          appendableWidgets={appendableWidgets}
          onClose={() => setDestinationOpen(false)}
          onPickNew={(k) => void spawnNewWidget(k)}
          onPickAppend={(w) => void appendToWidget(w)}
        />
      )}
    </div>
  )

  async function retryTranscription(fileId: string): Promise<void> {
    setErrorMsg(null)
    setErrorReason(null)
    setPhase('transcribing')
    const read = await window.api.files.read(fileId)
    if (!read) {
      setPhase('error')
      setErrorMsg('Recording file is missing on disk. Record again.')
      return
    }
    // Same decode-if-local dance as onRecordingFinished. We don't
    // share the code because the two callsites have different blob
    // sources and slightly different error handling — duplication is
    // cheaper than the helper plumbing.
    let samples: Float32Array | undefined
    let sampleRate: number | undefined
    try {
      const provider = await window.api.voiceNote.getProvider()
      if (provider === 'local') {
        const decoded = await decodeToMono16k(read.buffer)
        samples = decoded.samples
        sampleRate = decoded.sampleRate
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[VoiceRecorderWidget] retry decode failed:', err)
    }
    const transcribed = await window.api.voiceNote.transcribe({
      buffer: read.buffer,
      mimeType: read.mimeType,
      samples,
      sampleRate
    })
    if (!transcribed.ok) {
      setPhase('error')
      setErrorMsg(transcribed.error)
      setErrorReason(transcribed.reason ?? null)
      return
    }
    setPhase('processing')
    const [processed, extracted] = await Promise.all([
      window.api.voiceNote.process({
        transcript: transcribed.transcript,
        mode: state.mode
      }),
      window.api.voiceNote.extractActions({ transcript: transcribed.transcript })
    ])
    persist({
      fileId,
      captureMode: state.captureMode,
      transcript: transcribed.transcript,
      language: transcribed.language,
      durationSec: transcribed.durationSec ?? state.durationSec,
      mode: state.mode,
      processedText: processed.ok ? processed.text : transcribed.transcript,
      proposals: extracted.ok ? extracted.proposals : []
    })
    setPhase('ready')
  }

  if (inline) return body
  return (
    <WidgetFrame
      widget={widget}
      headerLabel={state.captureMode === 'video' ? 'Video note' : 'Voice note'}
      headerAccent="bg-stone-300/60 dark:bg-white/[0.09]"
    >
      {body}
    </WidgetFrame>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function IdleState({
  onStart
}: {
  onStart: (m: CaptureMode) => void
}): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
      <div
        className="h-12 w-12 rounded-full bg-accent/15 inline-flex items-center justify-center text-accent"
        aria-hidden="true"
      >
        <Icon name="mic" size={24} />
      </div>
      <div className="text-[12px] text-[var(--ink-70)] text-center">
        Record → AI transcribes, summarises, suggests tasks.
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onStart('audio')}
          className="text-[11px] px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 inline-flex items-center gap-1.5"
          data-testid="voice-start"
        >
          <Icon name="mic" size={14} />
          Voice
        </button>
        <button
          type="button"
          onClick={() => onStart('video')}
          className="text-[11px] px-3 py-1.5 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:opacity-90 inline-flex items-center gap-1.5"
          data-testid="voice-start-video"
        >
          <Icon name="videocam" size={14} />
          Video
        </button>
      </div>
    </div>
  )
}

function RecordingState({
  durationSec,
  captureMode,
  videoRef,
  liveCaption,
  onStop
}: {
  durationSec: number
  captureMode: CaptureMode
  videoRef: React.RefObject<HTMLVideoElement>
  liveCaption: string
  onStop: () => void
}): JSX.Element {
  return (
    <div className="flex-1 flex flex-col p-2 gap-2 min-h-0">
      {captureMode === 'video' && (
        <div className="rounded-md overflow-hidden bg-black flex items-center justify-center min-h-[120px] max-h-[40%]">
          <video
            ref={videoRef}
            muted // we already capture audio via the stream — don't double up
            playsInline
            className="w-full h-full object-contain"
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="relative">
          <div className="h-8 w-8 rounded-full bg-red-500/20 inline-flex items-center justify-center text-red-600 dark:text-red-400 animate-pulse">
            <Icon name={captureMode === 'video' ? 'videocam' : 'mic'} size={16} />
          </div>
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-red-500 animate-ping" />
        </div>
        <div className="text-[12px] font-mono text-[var(--ink-70)] tabular-nums">
          {formatDuration(durationSec)}
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onStop}
          className="text-[11px] px-3 py-1.5 rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:opacity-90 inline-flex items-center gap-1.5"
          data-testid="voice-stop"
        >
          <Icon name="stop" size={14} />
          Stop
        </button>
      </div>
      <div
        className="flex-1 min-h-0 overflow-y-auto text-[11px] leading-relaxed text-[var(--ink-70)] italic whitespace-pre-wrap"
        data-testid="voice-live-caption"
      >
        {liveCaption || (
          <span className="not-italic text-[10px] text-[var(--ink-40)]">
            Live captions (browser STT, not stored) appear here as you speak.
            The authoritative transcript runs on Whisper after Stop.
          </span>
        )}
      </div>
    </div>
  )
}

function BusyState({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4">
      <Icon name="autorenew" size={20} className="text-[var(--ink-40)] animate-spin" />
      <div className="text-[11px] text-[var(--ink-50)]">{label}</div>
    </div>
  )
}

function ErrorState({
  message,
  reason,
  canRetry,
  onRetry,
  onRecordAgain
}: {
  message: string
  reason: string | null
  canRetry: boolean
  onRetry: () => void
  onRecordAgain: () => void
}): JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
      <Icon name="error_outline" size={20} className="text-red-500" />
      <div className="text-[11px] text-[var(--ink-70)]">{message}</div>
      {reason === 'no_key' && (
        <div className="text-[10px] text-[var(--ink-50)] leading-snug max-w-[260px]">
          Open Settings → AI · API keys to add the missing key, or switch the
          transcription provider to Local.
        </div>
      )}
      <div className="flex gap-1.5 mt-1">
        {canRetry && (
          <button
            onClick={onRetry}
            className="text-[11px] px-2.5 py-1 rounded-md bg-[var(--surface-sunken)] hover:opacity-90"
          >
            Try again
          </button>
        )}
        <button
          onClick={onRecordAgain}
          className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90"
        >
          Record new
        </button>
      </div>
    </div>
  )
}

function ReadyState({
  state,
  mediaUrl,
  onSwitchMode,
  activeTaskId,
  appliedProposals,
  onApplied,
  onConsume,
  onRecordAgain,
  onOpenDestinationPicker
}: {
  state: PersistedState
  mediaUrl: string | null
  onSwitchMode: (m: ProcessMode) => void
  activeTaskId: string | null
  appliedProposals: Record<string, AppliedProposal>
  onApplied: (id: string, applied: AppliedProposal) => void
  onConsume: (id: string) => void
  onRecordAgain: (m: CaptureMode) => void
  onOpenDestinationPicker: () => void
}): JSX.Element {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2 py-1.5 border-b border-[var(--edge-soft)] flex items-center gap-1 flex-wrap">
        <ModeButton current={state.mode} value="summary" label="Summary" onClick={onSwitchMode} />
        <ModeButton current={state.mode} value="cleaned" label="Cleaned" onClick={onSwitchMode} />
        <ModeButton current={state.mode} value="diarised" label="Speakers" onClick={onSwitchMode} />
        <ModeButton current={state.mode} value="full" label="Full" onClick={onSwitchMode} />
        <div className="flex-1" />
        {state.durationSec !== null && (
          <span className="text-[10px] font-mono tabular-nums text-[var(--ink-50)]">
            {formatDuration(Math.round(state.durationSec))}
            {state.language && ` · ${state.language}`}
          </span>
        )}
        <button
          onClick={() => onRecordAgain(state.captureMode)}
          title={
            state.captureMode === 'video'
              ? 'Record a new video note (replaces this one)'
              : 'Record a new voice note (replaces this one)'
          }
          className="h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-50)] hover:bg-[var(--surface-sunken)]"
        >
          <Icon name={state.captureMode === 'video' ? 'videocam' : 'mic'} size={13} />
        </button>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-3 py-2 text-[12px] text-[var(--ink-90)] whitespace-pre-wrap leading-relaxed"
        data-testid="voice-processed-text"
      >
        {state.processedText || state.transcript || '(empty)'}
      </div>

      {mediaUrl && (
        <div className="px-2 py-1 border-t border-[var(--edge-soft)]">
          {state.captureMode === 'video' ? (
            <video
              src={mediaUrl}
              controls
              className="w-full max-h-[160px] object-contain bg-black rounded-sm"
              preload="metadata"
            />
          ) : (
            <audio src={mediaUrl} controls className="w-full h-8" preload="metadata" />
          )}
        </div>
      )}

      {state.proposals.length > 0 && (
        <div className="border-t border-[var(--edge-soft)] px-2 py-1.5 max-h-[180px] overflow-y-auto">
          <div className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold mb-1">
            AI proposed actions · {state.proposals.length}
          </div>
          {/* The shared approval-card surface (standard accept/approve). */}
          <ProposalCards
            proposals={state.proposals}
            activeTaskId={activeTaskId}
            appliedProposals={appliedProposals}
            onApplied={onApplied}
            onConsume={onConsume}
          />
        </div>
      )}

      <div className="px-2 py-1.5 border-t border-[var(--edge-soft)] flex items-center justify-between gap-2">
        <button
          onClick={onOpenDestinationPicker}
          className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--surface-sunken)] text-[var(--ink-90)] hover:opacity-90"
          data-testid="voice-send-to"
        >
          <Icon name="ios_share" size={12} />
          Send to…
        </button>
        <span className="text-[10px] text-[var(--ink-40)]">
          {state.processedText.length || state.transcript.length} chars
        </span>
      </div>
    </div>
  )
}

function ModeButton({
  current,
  value,
  label,
  onClick
}: {
  current: ProcessMode
  value: ProcessMode
  label: string
  onClick: (v: ProcessMode) => void
}): JSX.Element {
  const active = current === value
  return (
    <button
      onClick={() => onClick(value)}
      className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
        active
          ? 'bg-accent text-white'
          : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
      }`}
      data-testid={`voice-mode-${value}`}
    >
      {label}
    </button>
  )
}

function DestinationPicker({
  appendableWidgets,
  onClose,
  onPickNew,
  onPickAppend
}: {
  appendableWidgets: Widget[]
  onClose: () => void
  onPickNew: (kind: WidgetKind) => void
  onPickAppend: (target: Widget) => void
}): JSX.Element {
  const [tab, setTab] = useState<'new' | 'existing'>('new')
  const dests: Array<{ kind: WidgetKind; label: string; icon: string }> = [
    { kind: 'sticky', label: 'Sticky', icon: 'sticky_note_2' },
    { kind: 'note', label: 'Note', icon: 'description' },
    { kind: 'markdown', label: 'Markdown', icon: 'subject' },
    { kind: 'page', label: 'Page', icon: 'description' }
  ]
  return (
    <div
      className="fb-scrim absolute inset-0 z-30 flex items-center justify-center p-3"
      onClick={onClose}
    >
      <div
        className="fb-card fb-press w-full max-w-[320px] p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1.5 px-1">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--ink-50)] font-semibold">
            Where should this text go?
          </span>
          <button
            onClick={onClose}
            className="h-5 w-5 inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-70)]"
          >
            <Icon name="close" size={11} />
          </button>
        </div>
        <div className="flex gap-1 mb-2 px-1">
          <button
            onClick={() => setTab('new')}
            className={`flex-1 text-[10px] px-2 py-1 rounded transition-colors ${
              tab === 'new'
                ? 'bg-accent text-white'
                : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
            data-testid="voice-dest-tab-new"
          >
            New work widget
          </button>
          <button
            onClick={() => setTab('existing')}
            className={`flex-1 text-[10px] px-2 py-1 rounded transition-colors ${
              tab === 'existing'
                ? 'bg-accent text-white'
                : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
            }`}
            data-testid="voice-dest-tab-existing"
            disabled={appendableWidgets.length === 0}
            title={
              appendableWidgets.length === 0
                ? 'No appendable work widgets (sticky / note / markdown) on this canvas yet'
                : ''
            }
          >
            Append to existing ({appendableWidgets.length})
          </button>
        </div>
        {tab === 'new' ? (
          <div className="grid grid-cols-2 gap-1 px-1 pb-1">
            {dests.map((d) => (
              <button
                key={d.kind}
                onClick={() => onPickNew(d.kind)}
                className="fb-btn-surface flex flex-col items-center gap-0.5 px-2 py-2 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-[var(--ink-70)]"
                data-testid={`voice-dest-${d.kind}`}
              >
                <PlexiiIcon kind="widget" id={d.kind} size={20} fallback={d.icon} fallbackClassName="text-[var(--ink-70)]" />
                <span className="text-[10px] font-medium">{d.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="max-h-[260px] overflow-y-auto px-1 pb-1 space-y-1">
            {appendableWidgets.map((w) => (
              <button
                key={w.id}
                onClick={() => onPickAppend(w)}
                className="fb-btn-surface w-full flex items-center gap-1.5 px-2 py-1.5 hover:border-accent hover:bg-accent/5 dark:hover:bg-accent/10 text-left"
                data-testid={`voice-dest-append-${w.id}`}
              >
                <PlexiiIcon
                  kind="widget"
                  id={w.kind}
                  size={15}
                  fallback={iconForKind(w.kind)}
                  fallbackClassName="text-[var(--ink-50)]"
                  className="shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-medium text-[var(--ink-90)] truncate">
                    {w.title || w.kind}
                  </div>
                  <div className="text-[10px] text-[var(--ink-50)] truncate">
                    {(w.content || '').slice(0, 80) || 'empty'}
                  </div>
                </div>
                <Icon name="add" size={12} className="text-accent shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decode a compressed audio buffer (webm/opus, mp4/aac, wav, etc.) into
 * a mono 16kHz Float32Array suitable for Whisper. Uses the Chromium
 * AudioContext available in Electron's renderer; the equivalent
 * doesn't exist in Node main, which is why this lives renderer-side.
 *
 * If the AudioContext samples at a rate other than 16kHz (Chromium
 * defaults to 48kHz on most macs), we ask for 16kHz directly via the
 * constructor; if the construct succeeds, decodeAudioData hands back
 * an AudioBuffer already at the requested rate.
 *
 * We downmix to mono by averaging channels — Whisper was trained on
 * mono and dropping channels rather than averaging would silently
 * halve the signal for stereo inputs.
 */
async function decodeToMono16k(
  arrayBuffer: ArrayBuffer
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const TARGET_RATE = 16000
  // Some Chromium builds reject sampleRate in AudioContext constructor
  // if the hardware doesn't support it. We catch that and fall back to
  // a plain AudioContext + manual resample.
  let ctx: AudioContext
  try {
    ctx = new AudioContext({ sampleRate: TARGET_RATE })
  } catch {
    ctx = new AudioContext()
  }
  // decodeAudioData needs a copy of the buffer because some browsers
  // detach the source. ArrayBuffer.slice() does this cheaply.
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0))
  const channels = audioBuffer.numberOfChannels
  const length = audioBuffer.length
  const mono = new Float32Array(length)
  if (channels === 1) {
    mono.set(audioBuffer.getChannelData(0))
  } else {
    // Average channels into mono. Two channels is the common case; the
    // loop handles surround too without branching.
    for (let c = 0; c < channels; c++) {
      const data = audioBuffer.getChannelData(c)
      for (let i = 0; i < length; i++) mono[i] += data[i] / channels
    }
  }
  await ctx.close().catch(() => {})

  // If the AudioContext managed to honour 16kHz, we're done. If it
  // returned a different rate (some hardware/Chromium combos ignore
  // the requested rate), do a cheap linear resample down to 16k.
  if (audioBuffer.sampleRate === TARGET_RATE) {
    return { samples: mono, sampleRate: TARGET_RATE }
  }
  const ratio = audioBuffer.sampleRate / TARGET_RATE
  const newLength = Math.floor(length / ratio)
  const resampled = new Float32Array(newLength)
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * ratio
    const idx0 = Math.floor(srcIdx)
    const idx1 = Math.min(idx0 + 1, length - 1)
    const t = srcIdx - idx0
    resampled[i] = mono[idx0] * (1 - t) + mono[idx1] * t
  }
  return { samples: resampled, sampleRate: TARGET_RATE }
}

function parsePersisted(raw: string | null | undefined): PersistedState {
  if (!raw) return EMPTY_STATE
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>
    return {
      ...EMPTY_STATE,
      ...parsed,
      // Forward-compat: old persisted state didn't have captureMode.
      captureMode: parsed.captureMode === 'video' ? 'video' : 'audio',
      // Defensive: mode must be one of the allowed enums.
      mode:
        parsed.mode === 'full' ||
        parsed.mode === 'cleaned' ||
        parsed.mode === 'summary' ||
        parsed.mode === 'diarised'
          ? parsed.mode
          : 'summary',
      proposals: Array.isArray(parsed.proposals) ? (parsed.proposals as ActionProposal[]) : []
    }
  } catch {
    return EMPTY_STATE
  }
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function defaultsFor(kind: WidgetKind): { w: number; h: number } {
  switch (kind) {
    case 'sticky':
      return { w: 240, h: 200 }
    case 'note':
      return { w: 360, h: 280 }
    case 'markdown':
      return { w: 460, h: 360 }
    case 'page':
      return { w: 480, h: 400 }
    default:
      return { w: 360, h: 280 }
  }
}

function iconForKind(kind: WidgetKind): string {
  switch (kind) {
    case 'sticky':
      return 'sticky_note_2'
    case 'note':
      return 'description'
    case 'markdown':
      return 'subject'
    case 'page':
      return 'description'
    default:
      return 'widgets'
  }
}

// ── Web Speech API minimal type shims ──────────────────────────────────────
// Electron's TS lib doesn't ship these — Chromium implements them but
// the DOM types we use elsewhere don't include the prefixed variant.
// We declare the narrow surface we actually call.

interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechRecognitionResultListEvent) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike
}

interface SpeechRecognitionAlternative {
  transcript: string
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternative
  isFinal: boolean
}

interface SpeechRecognitionResultListEvent {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
