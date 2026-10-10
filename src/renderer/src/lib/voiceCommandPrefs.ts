// Renderer-side view of the voice command preferences.
//
// The prefs live in the main process (voiceCommandPref.ts, a JSON file in
// userData) because they outlive a window. But the capture pipeline needs them
// SYNCHRONOUSLY: startHold runs inside a pointer gesture and cannot await an
// IPC round trip before deciding whether this is a walkie-talkie hold or a
// hands-free latch. So they are cached here, refreshed on every write, and read
// synchronously thereafter.
//
// Until this module existed the prefs were written by Settings and read by
// nobody — three controls that saved, reloaded correctly, and changed nothing.
// The write-through plus subscription is what makes a change take effect on the
// NEXT gesture rather than after a restart: a mode switch you have to relaunch
// the app to feel is indistinguishable from one that does not work.

export type VoiceCommandMode = 'press-hold' | 'click-toggle'

export interface VoiceCommandPrefs {
  commandMode: VoiceCommandMode
  autoStopSilenceMs: number
  voiceback: boolean
}

// Mirrors the main-process defaults. Duplicated deliberately: this is the value
// used for the gesture that happens BEFORE the first load resolves, and it must
// be the conservative one — press-hold cannot leave a mic open by accident.
const DEFAULTS: VoiceCommandPrefs = {
  commandMode: 'press-hold',
  autoStopSilenceMs: 5000,
  voiceback: true,
}

let cached: VoiceCommandPrefs = { ...DEFAULTS }
let loaded = false
const subscribers = new Set<(p: VoiceCommandPrefs) => void>()

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn({ ...cached })
    } catch {
      // A broken subscriber must not take the others down with it.
    }
  }
}

/** The current prefs, synchronously. Safe to call inside an event handler. */
export function getVoiceCommandPrefsSync(): VoiceCommandPrefs {
  return { ...cached }
}

/**
 * Load from the main process. Idempotent, and safe to call from several places
 * on startup — the first call wins and the rest are no-ops.
 */
export async function loadVoiceCommandPrefs(): Promise<VoiceCommandPrefs> {
  if (loaded) return { ...cached }
  try {
    const p = await window.api.voiceCommand.getPrefs()
    cached = {
      commandMode: p.commandMode === 'click-toggle' ? 'click-toggle' : 'press-hold',
      autoStopSilenceMs:
        typeof p.autoStopSilenceMs === 'number' &&
        p.autoStopSilenceMs >= 1000 &&
        p.autoStopSilenceMs <= 30000
          ? p.autoStopSilenceMs
          : DEFAULTS.autoStopSilenceMs,
      voiceback: typeof p.voiceback === 'boolean' ? p.voiceback : DEFAULTS.voiceback,
    }
    loaded = true
    notify()
  } catch {
    // Keep the defaults. A failed read must not disable the mic.
  }
  return { ...cached }
}

/** Write through to the main process and update every live reader. */
export async function patchVoiceCommandPrefs(
  patch: Partial<VoiceCommandPrefs>,
): Promise<VoiceCommandPrefs> {
  // Optimistic, so a gesture in the same tick as the click already sees it.
  cached = { ...cached, ...patch }
  loaded = true
  notify()
  try {
    const next = await window.api.voiceCommand.setPrefs(patch)
    cached = {
      commandMode: next.commandMode === 'click-toggle' ? 'click-toggle' : 'press-hold',
      autoStopSilenceMs: next.autoStopSilenceMs,
      voiceback: next.voiceback,
    }
    notify()
  } catch {
    // The optimistic value stands for this session; the next load corrects it.
  }
  return { ...cached }
}

/** Subscribe to changes. Returns an unsubscribe. */
export function subscribeVoiceCommandPrefs(fn: (p: VoiceCommandPrefs) => void): () => void {
  subscribers.add(fn)
  fn({ ...cached })
  return () => {
    subscribers.delete(fn)
  }
}

/** Test seam: reset the module between cases. */
export function __resetVoiceCommandPrefsForTest(next?: Partial<VoiceCommandPrefs>): void {
  cached = { ...DEFAULTS, ...next }
  loaded = false
  subscribers.clear()
}
