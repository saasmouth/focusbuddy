// Spoken replies — the "Speak the AI's reply aloud" preference.
//
// Gated on TWO things, not one. The pref is necessary but not sufficient: the
// reply is spoken only when the turn STARTED with the user's voice. Reading a
// typed conversation aloud because a checkbox is ticked somewhere in Settings
// would be a surprise with no off switch in reach, and it would talk over the
// user in a meeting. Speak back when spoken to.
//
// The mark is set when a transcript stages in the composer and consumed by the
// reply to that turn. It expires, because a transcript staged, abandoned, and
// then followed an hour later by a typed question is not a voice turn.
//
// Dictation does not mark: typing words into a focused field produces no AI
// reply to read back.

const MARK_TTL_MS = 10 * 60 * 1000

let markedAt = 0
/** Spoken text, newest last — the test seam and the mute path both need it. */
let speaking: SpeechSynthesisUtterance | null = null

/** Note that the turn now in flight began as speech. */
export function markVoiceTurn(): void {
  markedAt = Date.now()
}

/** Forget any pending mark (cancelled capture, cleared composer). */
export function clearVoiceTurn(): void {
  markedAt = 0
}

/** Is the turn being answered one the user spoke? Consumes the mark. */
export function consumeVoiceTurn(): boolean {
  if (!markedAt) return false
  const fresh = Date.now() - markedAt < MARK_TTL_MS
  markedAt = 0
  return fresh
}

/**
 * Strip what does not survive being read out.
 *
 * A reply is written for the eye: citation markers, markdown emphasis, fenced
 * code and bare URLs are all noise in the ear, and a synthesiser reads a code
 * block character by character. Trimmed to a few sentences too — this is a
 * confirmation, not an audiobook, and SpeechSynthesis has no stop button on the
 * canvas.
 */
export function speakableText(raw: string, maxChars = 420): string {
  let t = raw
    // Fenced code: say that there is code rather than spelling it.
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    // Citation markers the prose uses for grounding chips.
    .replace(/\[\d+\]/g, '')
    // Links: keep the label, drop the target.
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' a link ')
    // Emphasis and headings.
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    // List bullets read as "star".
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (t.length <= maxChars) return t
  // Cut at a sentence end when there is one in reach, so it does not stop
  // mid-word.
  const cut = t.slice(0, maxChars)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  t = lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + '…'
  return t
}

/** Stop anything currently being spoken. */
export function stopSpeaking(): void {
  speaking = null
  try {
    window.speechSynthesis?.cancel()
  } catch {
    // Not available — nothing to stop.
  }
}

/**
 * Speak a reply, if the pref is on and this turn was spoken.
 *
 * Returns whether it spoke, so the caller can be tested without a synthesiser.
 */
export function speakReply(raw: string, opts: { voiceback: boolean }): boolean {
  if (!opts.voiceback) {
    // Still consume the mark: the turn is answered either way, and a stale
    // mark must not attach itself to the next reply.
    consumeVoiceTurn()
    return false
  }
  if (!consumeVoiceTurn()) return false
  const text = speakableText(raw)
  if (!text) return false
  const synth = window.speechSynthesis
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false
  try {
    // A new reply supersedes an older one still being read.
    synth.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    u.onend = (): void => {
      speaking = null
    }
    speaking = u
    synth.speak(u)
    return true
  } catch {
    return false
  }
}

/** Is a reply being read right now? */
export function isSpeaking(): boolean {
  return speaking !== null
}

/** Test seam. */
export function __resetVoicebackForTest(): void {
  markedAt = 0
  speaking = null
}
