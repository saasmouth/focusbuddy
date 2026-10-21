// With the AI source set to "Local on this device", clicking "Cloud" under
// Settings → AI → Voice · transcription provider used to say "Switched to Cloud
// Whisper (OpenAI)." while every recording still transcribed locally.
//
// That override is deliberate (voiceProviderPref.getTranscriptionProvider):
// audio is content, and the Local source promises nothing leaves the device.
// So the fix is in what the UI is told and says, not in the routing: main now
// reports the engine really in force, and the toggle shows that.
import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeProviderSwitch, HELD_LOCAL_NOTE } from '../../src/renderer/src/lib/voiceProviderSwitch'

const USERDATA = mkdtempSync(join(tmpdir(), 'plexii-voicepref-'))
vi.mock('electron', () => ({ app: { getPath: () => USERDATA } }))
let localOnly = false
vi.mock('../../src/main/ai/local/providerRouter', () => ({ localOnlyActive: () => localOnly }))

const root = join(__dirname, '../..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

describe('main reports the transcription engine really in force', () => {
  beforeEach(() => {
    localOnly = false
  })

  it('source Local + Cloud picked: the pick is saved, the effective engine stays local', async () => {
    const pref = await import('../../src/main/voiceProviderPref')
    localOnly = true
    pref.setTranscriptionProvider('cloud')
    expect(pref.getTranscriptionProvider()).toBe('local')
    expect(pref.transcriptionProviderState()).toEqual({ preferred: 'cloud', effective: 'local', heldLocal: true })
  })

  it('source cloud: the pick takes effect', async () => {
    const pref = await import('../../src/main/voiceProviderPref')
    pref.setTranscriptionProvider('cloud')
    expect(pref.transcriptionProviderState()).toEqual({ preferred: 'cloud', effective: 'cloud', heldLocal: false })
  })

  it('voice:setProvider returns that state, and voice:getProviderState serves it', () => {
    const ipc = read('src/main/ipc/index.ts')
    const start = ipc.indexOf("ipcMain.handle('voice:setProvider'")
    expect(start).toBeGreaterThan(-1)
    const handler = ipc.slice(start, ipc.indexOf('\n  })', start))
    expect(handler.match(/\.\.\.transcriptionProviderState\(\)/g)?.length).toBe(2)
    expect(ipc).toContain("ipcMain.handle('voice:getProviderState', () => transcriptionProviderState())")
  })
})

describe('what the toggle says after a click', () => {
  it('Cloud while Local holds transcription: no success message, highlight stays on Local', () => {
    const out = describeProviderSwitch('cloud', { ok: true, effective: 'local', heldLocal: true })
    expect(out.selected).toBe('local')
    expect(out.message).not.toMatch(/Switched/)
    expect(out.message).toContain('Nothing changed')
    expect(out.message).toContain('transcribe on this Mac')
    expect(out.message).not.toContain('—')
  })

  it('Cloud with a cloud source: says it switched and where audio goes', () => {
    const out = describeProviderSwitch('cloud', { ok: true, effective: 'cloud', heldLocal: false })
    expect(out).toEqual({ selected: 'cloud', message: 'Switched to Cloud Whisper. Future recordings are sent to OpenAI to transcribe.' })
  })

  it('Local: says it switched', () => {
    expect(describeProviderSwitch('local', { ok: true, effective: 'local', heldLocal: true }).message).toMatch(/^Switched to Local Whisper/)
  })

  it('a failed switch does not move the highlight', () => {
    expect(describeProviderSwitch('local', { ok: false, error: 'model failed to load' })).toEqual({
      selected: null,
      message: "Couldn't switch: model failed to load"
    })
  })

  it('the held note says what happens and how to change it', () => {
    expect(HELD_LOCAL_NOTE).toContain('recordings transcribe on this Mac')
    expect(HELD_LOCAL_NOTE).toContain('choose a cloud AI source')
    expect(HELD_LOCAL_NOTE).not.toContain('—')
  })

  it('the settings toggle uses it, disables Cloud while held, and no longer hard-codes the old claim', () => {
    const ui = read('src/renderer/src/components/settings/ApiKeysSection.tsx')
    expect(ui).not.toContain('Switched to Cloud Whisper (OpenAI).')
    expect(ui).toContain('describeProviderSwitch(next, result)')
    expect(ui).toContain("disabled={busy || heldLocal || provider === null || provider === 'unavailable'}")
    expect(ui).toContain('{HELD_LOCAL_NOTE}')
  })
})
