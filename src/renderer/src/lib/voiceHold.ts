import { useEffect } from 'react'
import { create } from 'zustand'
import { getDictationTarget, dictateInto, initDictationTracker } from './dictation'
import { useAssistantChrome } from '../stores/assistantChrome'
import { useChatStore, NEW_CHAT_KEY } from '../stores/chat'
import { getVoiceCommandPrefsSync, loadVoiceCommandPrefs } from './voiceCommandPrefs'
import { markVoiceTurn, clearVoiceTurn, stopSpeaking } from './voiceback'

// Hold-to-talk into the mascot (A3, R7 + R17 + R18). One capture engine for
// both gestures — holding the assistant pill and holding Cmd+Shift+Space —
// replacing the retired bottom-center voice bar.
//
// The R17 law: on release, NOTHING fires. The transcript stages in the
// mascot composer under the R11 preview strip — glance, fix, Enter — so the
// spoken word runs the SAME intent routing as every typed door. Two survivors
// from the old FAB, kept deliberately: dictation (an editable was focused
// when the hold began → the transcript types in verbatim, Whisper's words,
// never an AI echo) and the wake word ("Plexii, …" / "Hey Plexii, …" addresses
// the assistant even from inside a text field; the prefix is stripped).
//
// Hard-won capture rules carried from the FAB (do not relearn):
// - Non-reentrant: a second start while one capture is in flight would spin
//   up a second MediaRecorder whose interleaved chunks corrupt the webm.
// - The release-during-getUserMedia race: a too-quick tap must not leave a
//   recorder running with no way to stop it.
// - The local provider needs samples pre-decoded in the renderer (16kHz
//   mono Float32Array) — AudioContext does not exist in the main process.

export type VoiceHoldPhase = 'idle' | 'listening' | 'transcribing'

interface VoiceHoldState {
  phase: VoiceHoldPhase
  error: string | null
  clearError: () => void
}

export const useVoiceHold = create<VoiceHoldState>((set) => ({
  phase: 'idle',
  error: null,
  clearError: () => set({ error: null })
}))

const WAKE = /^\s*(hey\s+)?plexii?\b[,:]?\s*/i

// Module-level capture state — one capture at a time, by design.
let capturing = false
let armed = false
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let dictationTarget: HTMLElement | null = null

// Hands-free state (commandMode 'click-toggle'). `latched` means the gesture
// that started this capture has already ended and the mic is deliberately
// still open — so a pointerup or keyup must NOT stop it. Without this flag the
// two modes collapse back into one and the preference does nothing.
let latched = false
let silenceCtx: AudioContext | null = null
let silenceRaf: number | null = null

/** Is the mic open and holding itself open? Lets the pill offer a stop. */
export function isLatched(): boolean {
  return latched && capturing
}

// Below this RMS a frame counts as silence. Measured on normalised float
// samples: room tone sits under 0.01, speech peaks an order of magnitude
// above it. Deliberately low — cutting someone off mid-sentence is far worse
// than listening a second too long.
const SILENCE_RMS = 0.012
// Nothing auto-stops until speech has actually been heard: a user who clicks
// and then takes a breath would otherwise be stopped by their own hesitation.
// Pure silence instead runs to this ceiling and ends, so a latched mic can
// never stay open indefinitely.
const NO_SPEECH_CEILING_MS = 20_000

function teardownSilenceDetector(): void {
  if (silenceRaf !== null) {
    cancelAnimationFrame(silenceRaf)
    silenceRaf = null
  }
  const ctx = silenceCtx
  silenceCtx = null
  if (ctx) void ctx.close().catch(() => undefined)
}

/**
 * Watch the live stream and stop the capture once it has been quiet for
 * `silenceMs`, having first heard something.
 *
 * An AnalyserNode on the same MediaStream the recorder is using: it observes,
 * it does not consume, so the recording itself is unaffected.
 */
function armSilenceDetector(src: MediaStream, silenceMs: number): void {
  teardownSilenceDetector()
  let ctx: AudioContext
  try {
    const AC: typeof AudioContext =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
    if (!AC) return
    ctx = new AC()
  } catch {
    // No AudioContext available: fall back to a hard stop so the mic cannot be
    // left open forever, even though it cannot hear the silence itself.
    window.setTimeout(() => {
      if (capturing && latched) void stopHold()
    }, silenceMs + NO_SPEECH_CEILING_MS)
    return
  }
  silenceCtx = ctx
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 1024
  const node = ctx.createMediaStreamSource(src)
  node.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  const startedAt = performance.now()
  let heardSpeech = false
  let quietSince: number | null = null

  function tick(): void {
    // The capture ended by some other route (a second press, Escape): stop.
    if (!capturing || silenceCtx !== ctx) {
      teardownSilenceDetector()
      return
    }
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    const rms = Math.sqrt(sum / buf.length)
    const now = performance.now()
    if (rms >= SILENCE_RMS) {
      heardSpeech = true
      quietSince = null
    } else if (quietSince === null) {
      quietSince = now
    }
    if (heardSpeech && quietSince !== null && now - quietSince >= silenceMs) {
      teardownSilenceDetector()
      void stopHold()
      return
    }
    if (!heardSpeech && now - startedAt >= NO_SPEECH_CEILING_MS) {
      // Twenty seconds of room tone. End it — the transcript will be empty and
      // stopHold says so, which is the honest outcome.
      teardownSilenceDetector()
      void stopHold()
      return
    }
    silenceRaf = requestAnimationFrame(tick)
  }
  silenceRaf = requestAnimationFrame(tick)
}

function setState(phase: VoiceHoldPhase, error: string | null = null): void {
  useVoiceHold.setState({ phase, error })
}

async function decodeToMono16k(arrayBuffer: ArrayBuffer): Promise<Float32Array> {
  const AC: typeof AudioContext =
    (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!
  const ctx = new AC({ sampleRate: 16000 })
  const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0))
  let mono: Float32Array
  if (decoded.numberOfChannels === 1) {
    mono = decoded.getChannelData(0)
  } else {
    const len = decoded.length
    mono = new Float32Array(len)
    const ch0 = decoded.getChannelData(0)
    const ch1 = decoded.getChannelData(1)
    for (let i = 0; i < len; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5
  }
  await ctx.close()
  return mono
}

// Stage the transcript in the mascot composer for review (R17). The store
// draft covers the closed-panel path — ChatPanel's restoreDraft loads it the
// moment the editor mounts; the window event covers the already-open panel,
// whose mounted editor fills live. Both fire; the mount path is guarded by
// loadedDraftKey so nothing doubles.
function stageInComposer(text: string): void {
  const chat = useChatStore.getState()
  const key = chat.activeConversationId ?? NEW_CHAT_KEY
  chat.setThreadDraft(key, {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })
  const chrome = useAssistantChrome.getState()
  chrome.openPanel()
  chrome.setTab('chat')
  window.dispatchEvent(new CustomEvent('fb:composer-stage', { detail: text }))
}

export async function startHold(): Promise<void> {
  if (capturing) return
  capturing = true
  armed = true
  latched = false
  chunks = []
  // Talking over a reply that is still being read aloud means the user is done
  // listening to it.
  stopSpeaking()
  // Captured at START — the hold gesture must not steal focus (the pill
  // preventDefaults its pointerdown; a held key never moves focus), so the
  // editable the user was in is still active here.
  dictationTarget = getDictationTarget()
  useVoiceHold.setState({ error: null })
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    // Released during the async getUserMedia (a too-quick tap): free the mic
    // and bail — nothing recorded, nothing stuck.
    if (!armed) {
      s.getTracks().forEach((t) => t.stop())
      capturing = false
      setState('idle')
      return
    }
    stream = s
    const mr = new MediaRecorder(s)
    mr.ondataavailable = (e): void => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    mr.start(250)
    recorder = mr
    setState('listening')
    // Hands-free: the mic stays open past the end of the gesture and closes
    // itself when the room goes quiet. THIS is the whole of the click-toggle
    // preference — without it the setting saved a value nothing consulted.
    if (getVoiceCommandPrefsSync().commandMode === 'click-toggle') {
      latched = true
      armSilenceDetector(s, getVoiceCommandPrefsSync().autoStopSilenceMs)
    }
  } catch (err) {
    const e = err as Error
    capturing = false
    latched = false
    setState(
      'idle',
      e?.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow it in System Settings → Privacy & Security → Microphone, then try again. (In dev the app appears as “Electron”.)'
        : e?.name === 'NotFoundError'
          ? 'No microphone found. Connect one and try again.'
          : e?.message || 'Microphone unavailable.'
    )
  }
}

export async function stopHold(): Promise<void> {
  armed = false
  latched = false
  teardownSilenceDetector()
  const rec = recorder
  if (!rec) {
    // getUserMedia still in flight — startHold's race guard cleans up.
    return
  }
  await new Promise<void>((resolve) => {
    const t = window.setTimeout(resolve, 600) // hard cap on the final chunk
    rec.onstop = (): void => {
      window.clearTimeout(t)
      resolve()
    }
    try {
      if (rec.state !== 'inactive') rec.stop()
    } catch {
      resolve()
    }
  })
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  recorder = null

  if (chunks.length === 0) {
    capturing = false
    setState('idle', 'No audio captured. Hold the mascot a moment longer while you speak.')
    return
  }
  setState('transcribing')
  try {
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const buf = await blob.arrayBuffer()
    const provider = await window.api.voiceNote.getProvider()
    const res =
      provider === 'local'
        ? await window.api.voiceNote.transcribe({
            samples: await decodeToMono16k(buf),
            sampleRate: 16000
          })
        : await window.api.voiceNote.transcribe({ buffer: buf, mimeType: 'audio/webm' })
    if (!res.ok) {
      setState('idle', res.error)
      return
    }
    const text = res.transcript.trim()
    if (!text) {
      setState('idle', 'Nothing heard — try again a little closer to the mic.')
      return
    }
    const hasWake = WAKE.test(text)
    // Dictation survivor: an editable was focused and the assistant was NOT
    // addressed → type the words in verbatim and finish.
    if (!hasWake && dictationTarget && dictateInto(dictationTarget, text)) {
      setState('idle')
      // Heard-you (AI-18): one wink from the mascot — the words landed.
      window.dispatchEvent(new Event('fb:plexii-moment'))
      return
    }
    stageInComposer(hasWake ? text.replace(WAKE, '').trim() || text : text)
    // This turn began as speech, so its reply is eligible to be spoken back
    // (subject to the voiceback pref). Marked here and nowhere else: the
    // dictation branch above returns before this point, because typing words
    // into a field produces no reply to read.
    markVoiceTurn()
    setState('idle')
    window.dispatchEvent(new Event('fb:plexii-moment'))
  } catch (err) {
    setState('idle', (err as Error)?.message || 'Transcription failed.')
  } finally {
    dictationTarget = null
    chunks = []
    capturing = false
  }
}

/**
 * The gesture ended (pointerup, keyup). What that MEANS depends on the mode.
 *
 * press-hold   : release sends — the walkie-talkie the label promises.
 * click-toggle : release changes nothing; the mic is latched open and closes
 *                on silence or on a second press.
 */
export async function releaseHold(): Promise<void> {
  if (latched && capturing) return
  await stopHold()
}

/**
 * Press once to start, press again to stop — for the keyboard chord, and for a
 * press on the pill while it is already listening.
 */
export async function toggleHold(): Promise<'started' | 'stopped' | 'busy'> {
  if (useVoiceHold.getState().phase === 'transcribing') return 'busy'
  if (capturing) {
    await stopHold()
    return 'stopped'
  }
  await startHold()
  return 'started'
}

export function cancelHold(): void {
  armed = false
  latched = false
  teardownSilenceDetector()
  clearVoiceTurn()
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  } catch {
    // already stopped
  }
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
  recorder = null
  chunks = []
  dictationTarget = null
  capturing = false
  setState('idle')
}

// The keyboard half of the gesture (R18): hold Cmd+Shift+Space to listen,
// release to stage — physically the same gesture as holding the mascot.
// Escape cancels a live capture; losing window focus cancels too (a hold
// cannot meaningfully continue into another app).
export function useVoiceHoldKeys(): void {
  useEffect(() => {
    initDictationTracker()
    // The capture engine reads these synchronously inside the gesture, so they
    // have to be in hand before the first one.
    void loadVoiceCommandPrefs()
    function onKeyDown(e: KeyboardEvent): void {
      if (e.code === 'Space' && e.metaKey && e.shiftKey && !e.repeat) {
        e.preventDefault()
        // In hands-free mode the chord is a TOGGLE: tap to start, tap to stop.
        // In walkie-talkie mode it is the hold it has always been.
        if (getVoiceCommandPrefsSync().commandMode === 'click-toggle') {
          void toggleHold()
        } else {
          void startHold()
        }
        return
      }
      if (e.key === 'Escape' && useVoiceHold.getState().phase === 'listening') {
        e.preventDefault()
        cancelHold()
      }
    }
    function onKeyUp(e: KeyboardEvent): void {
      if (useVoiceHold.getState().phase !== 'listening' && !capturing) return
      // Releasing ANY leg of the chord ends the hold — unless the mic is
      // latched, in which case releaseHold deliberately does nothing.
      if (e.code === 'Space' || e.key === 'Meta' || e.key === 'Shift') {
        void releaseHold()
      }
    }
    function onBlur(): void {
      // A latched capture survives a blur: hands-free means the user can look
      // somewhere else while they talk. A HELD capture cannot — the key or
      // pointer release will never arrive.
      if (useVoiceHold.getState().phase === 'listening' && !latched) cancelHold()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
}
