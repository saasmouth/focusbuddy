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
// the metered proxy; 'byok' forces the user's own Anthropic key; 'openai' the
// user's own OpenAI key. 'local' runs AI on the on-device model that ships
// inside the app (Settings → AI → Local on this device); in that mode nothing
// about a prompt or its content is sent to any AI service, which
// providerRouter.ts and egressGuard.ts enforce.
//
// 'local' is the default (owner decision, 4.3.39): an install that has never
// chosen a source runs on the device. A choice already saved ('auto' included)
// is kept, so an existing user's AI does not change under them on update.
export type AiMode = 'auto' | 'credits' | 'byok' | 'local' | 'openai'
export const DEFAULT_AI_MODE: AiMode = 'local'
const AI_MODES: readonly AiMode[] = ['auto', 'credits', 'byok', 'local', 'openai']

/** The OpenAI models the person picked per tier (fast / standard / best). */
export interface OpenAIModelChoice {
  fast?: string
  standard?: string
  best?: string
}

// Per-feature exceptions to the AI source (see src/shared/localAi.ts for the
// feature list). Absent → the feature follows aiMode.
export type AiFeatureRoute = 'local' | 'cloud' | 'anthropic' | 'openai' | 'credits'
export type AiFeatureRoutes = Partial<Record<string, AiFeatureRoute>>
const FEATURE_ROUTES: readonly AiFeatureRoute[] = ['local', 'cloud', 'anthropic', 'openai', 'credits']

interface Envelope {
  // Base64-encoded ciphertext from safeStorage.encryptString.
  keys: Partial<Record<SecretName, string>>
  // Which AI source the user has chosen. Optional for forward-compat with
  // envelopes that never chose (absent → DEFAULT_AI_MODE).
  aiMode?: AiMode
  // Which one-time AI-source migrations this profile has had (AI_MODE_MIGRATION).
  aiModeMigration?: number
  // The "local AI is now built in" notice: shown once, then dismissed. `from`
  // is the source before the migration (null: none was stored).
  localAiIntro?: { pending: boolean; from: AiMode | null }
  // OpenAI model per tier when OpenAI is a source. Optional; absent → defaults
  // in src/main/ai/local/openaiClient.ts.
  openaiModels?: OpenAIModelChoice
  // Per-feature AI source overrides. Optional; absent → none.
  aiFeatureRoutes?: AiFeatureRoutes
  // The on-device model tier the user chose ('compact' | 'standard'). Optional;
  // absent → the tier recommended for this machine's RAM.
  localModelTier?: string
  // Local AI routing policy ('measured' | 'local-first'); absent → the default
  // in src/shared/localAi.ts.
  localAiPolicy?: string
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
      // A fresh profile: the migration's result (source 'local', the one-time
      // notice) is written by the first save, like any other setting.
      migrateAiMode(cache)
      return cache
    }
    const raw = readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Envelope>
    cache = {
      keys: parsed.keys && typeof parsed.keys === 'object' ? parsed.keys : {},
      ...(AI_MODES.includes(parsed.aiMode as AiMode) ? { aiMode: parsed.aiMode as AiMode } : {}),
      ...(parsed.openaiModels && typeof parsed.openaiModels === 'object'
        ? { openaiModels: sanitiseOpenAIModels(parsed.openaiModels) }
        : {}),
      ...(parsed.aiFeatureRoutes && typeof parsed.aiFeatureRoutes === 'object'
        ? { aiFeatureRoutes: sanitiseRoutes(parsed.aiFeatureRoutes) }
        : {}),
      ...(typeof parsed.localModelTier === 'string' ? { localModelTier: parsed.localModelTier } : {}),
      ...(parsed.localAiPolicy === 'measured' || parsed.localAiPolicy === 'local-first'
        ? { localAiPolicy: parsed.localAiPolicy }
        : {}),
      ...(typeof parsed.aiModeMigration === 'number' ? { aiModeMigration: parsed.aiModeMigration } : {}),
      ...(parsed.localAiIntro && typeof parsed.localAiIntro === 'object'
        ? {
            localAiIntro: {
              pending: parsed.localAiIntro.pending === true,
              from: AI_MODES.includes(parsed.localAiIntro.from as AiMode) ? (parsed.localAiIntro.from as AiMode) : null
            }
          }
        : {}),
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
    // Never write over a file that could not be read: it may hold keys. The
    // migration applies in memory for this run only.
    migrateAiMode(cache)
    return cache
  }
  if (migrateAiMode(cache)) {
    try {
      save()
    } catch {
      /* applied in memory for this run; written by the next save */
    }
  }
  return cache
}

/**
 * One-time, versioned AI-source migration (4.3.39: local AI ships inside the
 * app and is the default). Runs once per profile:
 *   - no stored source, or the old default 'auto'  → 'local'
 *   - an explicit 'byok', 'openai' or 'credits'    → left alone: that person
 *     chose a keyed or paid engine, and moving them to a 4B model silently
 *     would be wrong ('credits' that cannot serve a request falls back to the
 *     device for that request only — providerRouter.withCreditFallback)
 *   - 'local'                                      → unchanged
 * Per-feature overrides are never touched. Everyone gets the one-time "local
 * AI is now built in" notice, with a one-click switch. Returns true when the
 * envelope changed. Exported for tests; pure apart from its argument.
 */
export const AI_MODE_MIGRATION = 1
export function migrateAiMode(env: { aiMode?: AiMode; aiModeMigration?: number; localAiIntro?: { pending: boolean; from: AiMode | null } }): boolean {
  if ((env.aiModeMigration ?? 0) >= AI_MODE_MIGRATION) return false
  const from = env.aiMode ?? null
  if (from === null || from === 'auto') env.aiMode = 'local'
  env.localAiIntro = { pending: true, from }
  env.aiModeMigration = AI_MODE_MIGRATION
  return true
}

/** The one-time local-AI notice, if it is still to be shown. */
export function getLocalAiIntro(): { pending: boolean; from: AiMode | null; mode: AiMode } {
  load()
  return { pending: cache.localAiIntro?.pending === true, from: cache.localAiIntro?.from ?? null, mode: getAiMode() }
}

export function dismissLocalAiIntro(): void {
  load()
  cache.localAiIntro = { pending: false, from: cache.localAiIntro?.from ?? null }
  save()
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

/** The user's chosen AI source. Defaults to DEFAULT_AI_MODE ('local'). */
export function getAiMode(): AiMode {
  load()
  return cache.aiMode ?? DEFAULT_AI_MODE
}

function sanitiseOpenAIModels(raw: unknown): OpenAIModelChoice {
  const out: OpenAIModelChoice = {}
  for (const k of ['fast', 'standard', 'best'] as const) {
    const v = (raw as Record<string, unknown>)[k]
    if (typeof v === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(v)) out[k] = v
  }
  return out
}

/** The OpenAI models chosen per tier (only those set). */
export function getOpenAIModels(): OpenAIModelChoice {
  load()
  return { ...(cache.openaiModels ?? {}) }
}

export function setOpenAIModels(models: OpenAIModelChoice): void {
  load()
  cache.openaiModels = sanitiseOpenAIModels({ ...(cache.openaiModels ?? {}), ...models })
  save()
}

/** Persist the AI-source choice. */
export function setAiMode(mode: AiMode): void {
  load()
  cache.aiMode = mode
  save()
}

function sanitiseRoutes(raw: unknown): AiFeatureRoutes {
  const out: AiFeatureRoutes = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (FEATURE_ROUTES.includes(v as AiFeatureRoute)) out[k] = v as AiFeatureRoute
  }
  return out
}

/** Per-feature AI source overrides. */
export function getAiFeatureRoutes(): AiFeatureRoutes {
  load()
  return { ...(cache.aiFeatureRoutes ?? {}) }
}

/** Set (or with null, clear) one feature's AI source override. */
export function setAiFeatureRoute(feature: string, route: AiFeatureRoute | null): void {
  load()
  const next = { ...(cache.aiFeatureRoutes ?? {}) }
  if (route === null) delete next[feature]
  else next[feature] = route
  cache.aiFeatureRoutes = next
  save()
}

/** The local routing policy the person chose, or null for the default. */
export function getLocalAiPolicy(): 'measured' | 'local-first' | null {
  load()
  return cache.localAiPolicy === 'measured' || cache.localAiPolicy === 'local-first' ? cache.localAiPolicy : null
}

export function setLocalAiPolicy(policy: 'measured' | 'local-first' | null): void {
  load()
  if (policy) cache.localAiPolicy = policy
  else delete cache.localAiPolicy
  save()
}

/** The chosen on-device model tier, or null for "recommended". */
export function getLocalModelTier(): string | null {
  load()
  return cache.localModelTier ?? null
}

export function setLocalModelTier(tier: string | null): void {
  load()
  if (tier) cache.localModelTier = tier
  else delete cache.localModelTier
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
