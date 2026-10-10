import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  speakableText,
  markVoiceTurn,
  consumeVoiceTurn,
  clearVoiceTurn,
  speakReply,
  __resetVoicebackForTest
} from '../../src/renderer/src/lib/voiceback'

// "Settings › Advanced › Voice command: the settings save, but nothing reads
// them."
//
// All three controls were real: they persisted to voice-command.json, reloaded
// correctly, and were read by exactly one thing — the IPC handler that served
// them back to the settings panel that wrote them. The capture engine never
// asked. So the mode buttons, the silence slider and the voiceback checkbox
// were a closed loop with the user on both ends of it.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const hold = read('renderer/src/lib/voiceHold.ts')
const settings = read('renderer/src/components/SettingsPanel.tsx')

describe('the capture engine reads the preferences', () => {
  it('consults the mode when deciding what a release means', () => {
    expect(hold).toContain("getVoiceCommandPrefsSync().commandMode === 'click-toggle'")
  })

  it('arms a real silence detector with the configured interval', () => {
    // Not a fixed timeout: the slider value is the argument.
    expect(hold).toContain('armSilenceDetector(s, getVoiceCommandPrefsSync().autoStopSilenceMs)')
    // And it measures the signal rather than assuming silence.
    expect(hold).toContain('getFloatTimeDomainData')
    expect(hold).toContain('SILENCE_RMS')
  })

  it('will not auto-stop before it has heard anything', () => {
    // Otherwise a pause before speaking ends the capture the user just started.
    expect(hold).toContain('heardSpeech')
    expect(hold).toContain('NO_SPEECH_CEILING_MS')
  })

  it('a latched mic ignores the release that would end a hold', () => {
    expect(hold).toContain('export async function releaseHold')
    expect(hold).toContain('if (latched && capturing) return')
  })

  it('the keyboard chord toggles in hands-free mode and holds otherwise', () => {
    const keys = hold.slice(hold.indexOf('export function useVoiceHoldKeys'))
    expect(keys).toContain('void toggleHold()')
    expect(keys).toContain('void startHold()')
    expect(keys).toContain('void releaseHold()')
  })

  it('loads the prefs before the first gesture can need them', () => {
    expect(hold).toContain('void loadVoiceCommandPrefs()')
  })

  it('a latched capture survives losing window focus, a held one does not', () => {
    expect(hold).toContain("phase === 'listening' && !latched) cancelHold()")
  })
})

describe('settings writes where the engine reads', () => {
  it('goes through the shared module, not straight to IPC', () => {
    // Writing straight to IPC left the renderer cache stale, so a mode change
    // only took effect after a relaunch — indistinguishable from not working.
    expect(settings).toContain('patchVoiceCommandPrefs(patch)')
    expect(settings).toContain('subscribeVoiceCommandPrefs')
    expect(settings).not.toContain('window.api.voiceCommand.setPrefs')
  })

  it('no longer tells the user to press a mic that was removed', () => {
    // The floating mic retired with the bottom-center voice bar, and the
    // Apply/Dismiss proposals it described retired with the voiceCommand
    // engine. The copy outlived both.
    expect(settings).not.toContain('Press the floating mic')
    expect(settings).not.toContain('Apply or Dismiss')
    expect(settings).toContain('Hold the Plexii mascot')
  })
})

describe('voiceback speaks only when spoken to', () => {
  beforeEach(() => __resetVoicebackForTest())

  it('does not speak a turn the user typed', () => {
    expect(speakReply('All done.', { voiceback: true })).toBe(false)
  })

  it('consumes the mark even when the pref is off, so it cannot leak forward', () => {
    markVoiceTurn()
    expect(speakReply('x', { voiceback: false })).toBe(false)
    // The mark is gone: the NEXT turn is not treated as spoken.
    expect(consumeVoiceTurn()).toBe(false)
  })

  it('a cancelled capture leaves no mark behind', () => {
    markVoiceTurn()
    clearVoiceTurn()
    expect(consumeVoiceTurn()).toBe(false)
  })

  it('a mark is consumed once, not once per reply', () => {
    markVoiceTurn()
    expect(consumeVoiceTurn()).toBe(true)
    expect(consumeVoiceTurn()).toBe(false)
  })
})

describe('what gets read aloud', () => {
  it('drops citation markers', () => {
    expect(speakableText('Revenue rose [1] last quarter [12].')).toBe(
      'Revenue rose last quarter .'
    )
  })

  it('says there is code rather than spelling it out', () => {
    const out = speakableText('Try this:\n```ts\nconst x = 1\n```\nDone.')
    expect(out).toContain('code omitted')
    expect(out).not.toContain('const x')
  })

  it('keeps a link label and drops the target', () => {
    expect(speakableText('See [the docs](https://example.com/a/b).')).toBe('See the docs.')
  })

  it('strips emphasis and heading marks', () => {
    expect(speakableText('## Summary\n**bold** and _thin_')).toBe('Summary bold and thin')
  })

  it('trims at a sentence end rather than mid-word', () => {
    const long = 'One two three. ' + 'Four five six. '.repeat(40)
    const out = speakableText(long, 60)
    expect(out.length).toBeLessThanOrEqual(61)
    expect(out.endsWith('.')).toBe(true)
  })

  it('leaves a short reply exactly as it reads', () => {
    expect(speakableText('Created three sticky notes.')).toBe('Created three sticky notes.')
  })
})
