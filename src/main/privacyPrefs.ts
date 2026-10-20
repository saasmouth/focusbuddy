// Per-device privacy switches the main process enforces.
//
//   autoUpdateChecks — check dl.plexiidesk.com (PlexiiOffice: GitHub releases)
//     for a new version at launch and every 6 hours. ON by default, because an
//     app that never hears about security fixes is worse for the person than
//     one GET of a static file; the switch says so plainly and turning it off is
//     honoured everywhere (autoUpdate.ts). "Check now" works either way.
//
//   backgroundAi — let the app send the person's own content to an AI provider
//     WITHOUT a click: the title backfill (untitled items' text → Anthropic, at
//     launch) and the embeddings sweep (document and knowledge text → OpenAI,
//     every 5 minutes). OFF by default. A cloud provider is used only while this
//     is on; a local model on this computer is not gated, since nothing leaves.
//     The gate sits at the two call sites in index.ts (backgroundAiGate.ts).
//
// Same persistence pattern as workItemsPref.ts: one small JSON file in userData,
// cached after the first read, written through on set. Not a secret. A missing
// file or a missing field reads as the default.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PrivacyPrefs {
  autoUpdateChecks: boolean
  backgroundAi: boolean
}

export const PRIVACY_DEFAULTS: Readonly<PrivacyPrefs> = Object.freeze({
  autoUpdateChecks: true,
  backgroundAi: false
})

let cache: PrivacyPrefs | null = null
const listeners = new Set<(p: PrivacyPrefs) => void>()

function filePath(): string {
  return join(app.getPath('userData'), 'privacy-prefs.json')
}

/** Normalise whatever is on disk: only a real boolean overrides a default. */
export function normalisePrivacyPrefs(raw: unknown): PrivacyPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    autoUpdateChecks:
      typeof o.autoUpdateChecks === 'boolean' ? o.autoUpdateChecks : PRIVACY_DEFAULTS.autoUpdateChecks,
    backgroundAi: typeof o.backgroundAi === 'boolean' ? o.backgroundAi : PRIVACY_DEFAULTS.backgroundAi
  }
}

export function getPrivacyPrefs(): PrivacyPrefs {
  if (cache) return { ...cache }
  try {
    cache = existsSync(filePath())
      ? normalisePrivacyPrefs(JSON.parse(readFileSync(filePath(), 'utf-8')))
      : { ...PRIVACY_DEFAULTS }
  } catch {
    cache = { ...PRIVACY_DEFAULTS }
  }
  return { ...cache }
}

export function setPrivacyPrefs(patch: Partial<PrivacyPrefs>): PrivacyPrefs {
  const next = normalisePrivacyPrefs({ ...getPrivacyPrefs(), ...patch })
  cache = next
  try {
    writeFileSync(filePath(), JSON.stringify({ ...next, v: 1 }, null, 2), 'utf-8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[privacyPrefs] save failed:', err)
  }
  for (const fn of listeners) {
    try {
      fn({ ...next })
    } catch {
      /* a listener's failure must not undo the person's choice */
    }
  }
  return { ...next }
}

/** Called after every change. Returns an unsubscribe. */
export function onPrivacyPrefsChange(fn: (p: PrivacyPrefs) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function autoUpdateChecksEnabled(): boolean {
  return getPrivacyPrefs().autoUpdateChecks
}

export function backgroundAiEnabled(): boolean {
  return getPrivacyPrefs().backgroundAi
}

/** Test seam: forget the cached copy so the next read hits the file again. */
export function __resetPrivacyPrefsCache(): void {
  cache = null
}
