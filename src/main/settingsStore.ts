// Settings store — user-managed secrets that previously lived in a .env file.
//
// The Anthropic API key is the only secret in v1; the file is laid out so
// adding more (OpenAI fallback, third-party widget keys) is trivial.
//
// Storage:
//   - userData/secrets.json holds an envelope { keys: { anthropic: <b64> } }
//   - Each value is encrypted via Electron's `safeStorage` (Keychain on macOS,
//     DPAPI on Windows, kernel keyring on Linux) so a raw read of the file
//     yields ciphertext.
//   - safeStorage availability is checked at boot; if encryption isn't
//     available (rare — usually only on Linux without a keyring), we refuse
//     to write and surface a clear error to the renderer.
//
// The renderer NEVER receives the plaintext key. It can:
//   - Check whether a key is set (`has(name)`).
//   - See the last-4 of the stored key (`hint(name)`) for confirmation.
//   - Save a new key (plaintext → encrypted in main, persisted to disk).
//   - Clear a key.
//   - Trigger a "test" call that hits the provider's smallest endpoint and
//     reports success/failure without ever streaming the key back.
//
// The main-process AI client reads the plaintext only on demand inside
// anthropic.ts via `getSecret('anthropic')`, never caches it across config
// changes, and re-issues the SDK client when the key rotates.

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// API keys the user supplies. `anthropic` was v1's only secret; `openai`
// was added when the voice/video → transcription pipeline landed (Whisper
// API). Adding a new secret = adding it here + a row in the API Keys
// settings panel. Existing envelopes are forward-compatible (missing
// keys just resolve to null).
export type SecretName = 'anthropic' | 'openai' | 'tenor' | 'pexels' | 'removebg'

// How the app sources AI: 'auto' prefers PlexiDesk credits when the user is
// signed in and has balance, falling back to their own key; 'credits' forces
// the metered proxy; 'byok' forces the user's own key. 'auto' is the default
// so a fresh signup gets the trial-credit experience with zero setup, while a
// power user who pastes a key keeps using it.
export type AiMode = 'auto' | 'credits' | 'byok'

interface Envelope {
  // Base64-encoded ciphertext from safeStorage.encryptString.
  keys: Partial<Record<SecretName, string>>
  // Which AI source the user has chosen. Optional for forward-compat with
  // pre-credits envelopes (absent → 'auto').
  aiMode?: AiMode
  // True when web pop-ups should open as separate OS windows instead of on the
  // desk (Settings → Advanced). Optional; absent → false (on the desk).
  popupsNative?: boolean
  // False when connected apps should NOT be kept signed in between launches
  // (Settings → Advanced). Optional; absent → true (kept signed in). Stored
  // only when off, so every existing envelope reads as the default.
  keepAppsSignedIn?: boolean
  // Schema version — lets future migrations detect old envelopes.
  v: 1
}

let cache: Envelope = { keys: {}, v: 1 }
let loaded = false

function filePath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): Envelope {
  if (loaded) return cache
  loaded = true
  try {
    if (!existsSync(filePath())) {
      cache = { keys: {}, v: 1 }
      return cache
    }
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Envelope>
    cache = {
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      aiMode: parsed.aiMode === 'credits' || parsed.aiMode === 'byok' ? parsed.aiMode : 'auto',
      ...(parsed.popupsNative === true ? { popupsNative: true } : {}),
      ...(parsed.keepAppsSignedIn === false ? { keepAppsSignedIn: false } : {}),
      v: 1
    }
  } catch (err) {
    // Don't blow up boot if the file is corrupt — just start with an empty
    // envelope and surface the error via console. The renderer's Settings
    // UI can re-save the key.
    // eslint-disable-next-line no-console
    console.error('[settingsStore] load failed:', err)
    cache = { keys: {}, v: 1 }
  }
  return cache
}

function save() {
  try {
    writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf-8')
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[settingsStore] save failed:', err)
    throw err
  }
}

/** Whether safeStorage can actually encrypt on this machine. */
export function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/** Persist an API key. Throws if encryption isn't available. */
export function setSecret(name: SecretName, plaintext: string): void {
  load()
  const value = plaintext.trim()
  if (!value) {
    delete cache.keys[name]
    save()
    return
  }
  if (!encryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable on this machine. ' +
      'PlexiiDesk will not store an API key in plaintext. ' +
      'Try setting a keychain password (macOS) or installing libsecret (Linux).'
    )
  }
  const encrypted = safeStorage.encryptString(value)
  cache.keys[name] = encrypted.toString('base64')
  save()
}

/** Read the plaintext key, or null if none stored. */
export function getSecret(name: SecretName): string | null {
  load()
  const ct = cache.keys[name]
  if (!ct) return null
  if (!encryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(ct, 'base64'))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[settingsStore] decrypt failed for ${name}:`, err)
    return null
  }
}

/** Wipe a key. */
export function clearSecret(name: SecretName): void {
  load()
  delete cache.keys[name]
  save()
}

/** Renderer-safe: is a key set, and what are its last 4 chars? */
export function hint(name: SecretName): { hasKey: boolean; last4: string | null } {
  const plaintext = getSecret(name)
  if (!plaintext) return { hasKey: false, last4: null }
  return { hasKey: true, last4: plaintext.slice(-4) }
}

/**
 * Resolve the Anthropic key for runtime use. Settings store wins; falls back
 * to process.env so developers running the dev build with a `.env` file keep
 * working. The order is deliberate: a user-set key in the app should always
 * override an env var, so power users can rotate without restarting.
 */
export function resolveAnthropicKey(): string | null {
  const fromStore = getSecret('anthropic')
  if (fromStore) return fromStore
  const fromEnv = process.env.ANTHROPIC_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null
}

/** Whether the user has stored their own Anthropic key (not the env fallback). */
export function hasOwnAnthropicKey(): boolean {
  return Boolean(getSecret('anthropic'))
}

/** The user's chosen AI source. Defaults to 'auto'. */
export function getAiMode(): AiMode {
  load()
  return cache.aiMode ?? 'auto'
}

/** Persist the AI-source choice. */
export function setAiMode(mode: AiMode): void {
  load()
  cache.aiMode = mode
  save()
}

/** Whether web pop-ups open as separate OS windows (the pre-4.3.31 behaviour). */
export function getPopupsNative(): boolean {
  load()
  return cache.popupsNative === true
}

/** Persist the native-pop-up choice. */
export function setPopupsNative(native: boolean): void {
  load()
  if (native) cache.popupsNative = true
  else delete cache.popupsNative
  save()
}

/**
 * Whether connected apps' session cookies are kept between launches (on by
 * default). Off restores plain browser behaviour: session cookies end at quit.
 */
export function getKeepAppsSignedIn(): boolean {
  load()
  return cache.keepAppsSignedIn !== false
}

/** Persist the keep-signed-in choice. */
export function setKeepAppsSignedIn(keep: boolean): void {
  load()
  if (keep) delete cache.keepAppsSignedIn
  else cache.keepAppsSignedIn = false
  save()
}

/**
 * Resolve the OpenAI key — same precedence rules as the Anthropic key.
 * Used today by the audio transcription IPC (Whisper API). Returns null
 * if the user hasn't set one, so callers can surface a "set up
 * transcription" UI affordance instead of throwing.
 */
export function resolveOpenAIKey(): string | null {
  const fromStore = getSecret('openai')
  if (fromStore) return fromStore
  const fromEnv = process.env.OPENAI_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null
}

/**
 * Resolve the Tenor (GIF search) key — same precedence rules. GIF search needs a
 * key from Google's Tenor API; without one the picker shows an honest empty state
 * rather than fabricating results.
 */
export function resolveTenorKey(): string | null {
  const fromStore = getSecret('tenor')
  if (fromStore) return fromStore
  const fromEnv = process.env.TENOR_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null
}

/**
 * Resolve the Pexels (stock photo) key — same precedence rules. Stock photo
 * search needs a free Pexels API key; without one the picker shows an honest
 * "add a key" state rather than fabricating results.
 */
export function resolvePexelsKey(): string | null {
  const fromStore = getSecret('pexels')
  if (fromStore) return fromStore
  const fromEnv = process.env.PEXELS_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null
}

/**
 * Resolve the remove.bg (background removal) key — same precedence rules.
 * Background removal calls the remove.bg API; without a key the action reports an
 * honest "add a key" state and changes nothing.
 */
export function resolveRemoveBgKey(): string | null {
  const fromStore = getSecret('removebg')
  if (fromStore) return fromStore
  const fromEnv = process.env.REMOVEBG_API_KEY
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null
}
