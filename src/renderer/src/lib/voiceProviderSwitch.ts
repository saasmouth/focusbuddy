// What the transcription toggle (Settings → AI, "Voice · transcription
// provider") says after a click, decided from what main reports as really in
// force rather than from what was clicked.
//
// While the AI source is "Local on this device", main keeps transcription on
// this device whatever the toggle says (voiceProviderPref.getTranscriptionProvider:
// audio is content, and cloud transcription would send it to OpenAI). The
// saved pick is kept and applies again once the source is a cloud option. So a
// click on Cloud in that state changes nothing about the next recording, and
// the toggle must say that instead of "Switched to Cloud Whisper".

export type TranscriptionEngine = 'cloud' | 'local'

export interface ProviderSwitchResult {
  ok: boolean
  error?: string
  effective?: TranscriptionEngine
  heldLocal?: boolean
}

/** Shown under the toggle whenever the Local AI source is holding transcription on this device. */
export const HELD_LOCAL_NOTE =
  'AI is set to run on this device, so recordings transcribe on this Mac with Local Whisper and no audio is sent to OpenAI. To use Cloud transcription, choose a cloud AI source above.'

/**
 * The engine to highlight and the message to show after asking main to switch.
 * `selected` is null when the switch failed and the highlight should not move.
 */
export function describeProviderSwitch(
  requested: TranscriptionEngine,
  result: ProviderSwitchResult
): { selected: TranscriptionEngine | null; message: string } {
  if (!result.ok) return { selected: null, message: `Couldn't switch: ${result.error ?? 'unknown error'}` }
  // An older main process returns no state; trust the request as before.
  const effective = result.effective ?? requested
  if (effective !== requested) {
    return {
      selected: effective,
      message:
        result.heldLocal === true
          ? `Nothing changed: ${HELD_LOCAL_NOTE}`
          : `Nothing changed: recordings still transcribe ${effective === 'local' ? 'on this Mac' : 'with OpenAI'}.`
    }
  }
  return {
    selected: effective,
    message:
      effective === 'local'
        ? 'Switched to Local Whisper. Future recordings transcribe on this Mac.'
        : 'Switched to Cloud Whisper. Future recordings are sent to OpenAI to transcribe.'
  }
}
