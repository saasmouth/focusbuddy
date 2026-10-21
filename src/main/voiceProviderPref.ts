// Persisted voice-transcription provider preference.
//
// Stored in the same userData directory as the rest of the app's
// preferences, separate from the encrypted secrets envelope because
// it's NOT a secret — it's a routing flag the renderer can also read
// via IPC. Two values: 'cloud' (OpenAI Whisper API) or 'local'
// (Transformers.js ONNX whisper-tiny). Default = 'cloud' for new
// installs — gives a working transcription path out of the box as long
// as the user has set their OpenAI key, no model download wait.
//
// Persistence is a one-line JSON file rather than electron-store /
// conf so we keep zero new dependencies. Reads are cached after first
// load; writes are write-through (no debounce — preference flips are
// rare and the file is 30 bytes).

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TranscriptionProvider } from './ai/voiceNote'
import { localOnlyActive } from './ai/local/providerRouter'

interface PrefShape {
  provider: TranscriptionProvider
  v: 1
}

let cache: PrefShape | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'voice-provider.json')
}

function load(): PrefShape {
  if (cache) return cache
  try {
    if (!existsSync(filePath())) {
      cache = { provider: 'cloud', v: 1 }
      return cache
    }
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PrefShape>
    const provider: TranscriptionProvider =
      parsed.provider === 'local' || parsed.provider === 'cloud' ? parsed.provider : 'cloud'
    cache = { provider, v: 1 }
    return cache
  } catch {
    cache = { provider: 'cloud', v: 1 }
    return cache
  }
}

/**
 * The transcription engine to use now. While the AI source is "Local on this
 * device" it is always local Whisper, whatever this preference says: audio is
 * content, and cloud transcription would send it to OpenAI. The saved
 * preference is kept and applies again when the source is cloud.
 */
export function getTranscriptionProvider(): TranscriptionProvider {
  if (localOnlyActive()) return 'local'
  return load().provider
}

export interface TranscriptionProviderState {
  /** What the person picked in Settings (kept while Local holds it). */
  preferred: TranscriptionProvider
  /** What the next recording really uses. */
  effective: TranscriptionProvider
  /** True when the AI source is Local, which keeps transcription on this device. */
  heldLocal: boolean
}

/** The saved preference and the engine actually in force, so the UI never claims a switch that did not happen. */
export function transcriptionProviderState(): TranscriptionProviderState {
  const preferred = load().provider
  const heldLocal = localOnlyActive()
  return { preferred, effective: heldLocal ? 'local' : preferred, heldLocal }
}

export function setTranscriptionProvider(p: TranscriptionProvider): void {
  cache = { provider: p, v: 1 }
  try {
    writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[voiceProviderPref] save failed:', err)
  }
}
