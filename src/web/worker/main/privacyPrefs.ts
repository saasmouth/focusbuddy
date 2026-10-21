// Privacy switches in the cloud runtime: the defaults, read-only.
//
// On the desktop, src/main/privacyPrefs.ts keeps two per-device switches in a
// JSON file in Electron's userData (electron, node:fs, node:path). A tab has no
// userData and no file system, and the Worker reaches this module only through
// the Background AI gate (backgroundAiGate.ts, via document retrieval), so this
// variant reports the shipped defaults and refuses changes -- the same shape as
// ./settingsStore.ts and ./workItemsPref.ts.
//
// What the defaults mean here:
//   - backgroundAi OFF: background jobs never send content to a cloud provider
//     from the browser. The browser holds no provider key either, so this is
//     the answer the desktop gives a fresh install, not a weaker one.
//   - autoUpdateChecks ON: reported for completeness; a web page is updated by
//     being served, so nothing in the browser polls for releases.
//
// tests/unit/webBundleGraph.test.ts pins these to the desktop defaults.
import type * as Desktop from '../../../main/privacyPrefs'
import type { PrivacyPrefs } from '../../../main/privacyPrefs'

export type { PrivacyPrefs }

export const PRIVACY_DEFAULTS: Readonly<PrivacyPrefs> = Object.freeze({
  autoUpdateChecks: true,
  backgroundAi: false
})

const UNSUPPORTED = 'Privacy switches are per device and are set in the desktop app.'

export function getPrivacyPrefs(): PrivacyPrefs {
  return { ...PRIVACY_DEFAULTS }
}

export function setPrivacyPrefs(_patch: Partial<PrivacyPrefs>): PrivacyPrefs {
  throw new Error(UNSUPPORTED)
}

/** Nothing changes in the browser, so nothing is announced. */
export function onPrivacyPrefsChange(_fn: (p: PrivacyPrefs) => void): () => void {
  return () => {}
}

export function autoUpdateChecksEnabled(): boolean {
  return PRIVACY_DEFAULTS.autoUpdateChecks
}

export function backgroundAiEnabled(): boolean {
  return PRIVACY_DEFAULTS.backgroundAi
}

// Signature check against the desktop module (type-only; nothing is bundled).
;({
  PRIVACY_DEFAULTS,
  getPrivacyPrefs,
  setPrivacyPrefs,
  onPrivacyPrefsChange,
  autoUpdateChecksEnabled,
  backgroundAiEnabled
}) satisfies Pick<
  typeof Desktop,
  | 'PRIVACY_DEFAULTS'
  | 'getPrivacyPrefs'
  | 'setPrivacyPrefs'
  | 'onPrivacyPrefsChange'
  | 'autoUpdateChecksEnabled'
  | 'backgroundAiEnabled'
>
