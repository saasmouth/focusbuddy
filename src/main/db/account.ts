import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Account session persistence — main-process only.
//
// We keep two facts on disk:
//   1. The session token issued by the signal server's /accounts/login (or
//      /accounts/signup). Encrypted at rest via Electron's safeStorage
//      (macOS Keychain / Windows DPAPI / GNOME keyring). The renderer
//      never sees the encryption key; main encrypts on save, decrypts
//      on load, and hands the plain token to the renderer over IPC.
//   2. A "skippedAt" timestamp the user gets when they dismiss the launch
//      modal with "Continue without account". We use this to avoid
//      re-prompting them every launch — but we DO re-prompt once a week
//      so people who eventually want an account don't have to hunt for
//      the option in Settings.
//
// The renderer never touches the file directly — IPC is the contract.

interface AccountState {
  // Base64-encoded encrypted session token. Null when no session exists.
  encryptedToken: string | null
  // Wall-clock ms when the user last clicked "Continue without account".
  // Used by the renderer to decide whether to show the launch modal.
  skippedAt: number | null
  // Cached email for the "Welcome back, you@example.com" UX. Plaintext —
  // safe to surface unauthenticated. Used as the default value in the
  // login field after a sign-out so the user only re-types their password.
  cachedEmail: string | null
}

const EMPTY: AccountState = {
  encryptedToken: null,
  skippedAt: null,
  cachedEmail: null
}

function fileFor(): string {
  return join(app.getPath('userData'), 'account-session.json')
}

// DEC-060 — caches, because this module sits on the hot path.
//
// `loadAccountState()` is called by localActor(), which is called by
// emitObjectEvent — so EVERY Object Event was doing a synchronous macOS
// Keychain decrypt. On a boot replay that is hundreds of round trips to
// securityd, and the first one raises the authorization prompt that blocked the
// main thread before the window was ever shown: the app looked dead, CDP went
// unresponsive, and the prompt itself had no visible parent window.
//
// Main is the only writer of this file, so caching the parse is safe; both
// caches are dropped in write().
let stateCache: AccountState | null = null
let tokenCache: { cipher: string; plain: string | null } | null = null

// DEC-060 — the tripwire.
//
// A Keychain read before the window is on screen is the shape of the bug that
// cost days to find: safeStorage blocks the main thread waiting on securityd,
// macOS raises an authorization prompt, and the prompt has no visible parent to
// attach to. The app is not crashed and not busy — it sits at 0% CPU with the
// port open and nothing painted, which reads as "hung for no reason".
//
// The cause is fixed (nothing on the boot path decrypts any more), so this only
// fires if a future change puts it back. Loud beats silent: this line in the log
// names the problem outright instead of leaving someone to sample the process.
let uiVisible = false
export function markUiVisible(): void {
  uiVisible = true
}

function read(): AccountState {
  if (stateCache) return stateCache
  const path = fileFor()
  if (!existsSync(path)) return { ...EMPTY }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AccountState>
    stateCache = {
      encryptedToken: parsed.encryptedToken ?? null,
      skippedAt: parsed.skippedAt ?? null,
      cachedEmail: parsed.cachedEmail ?? null
    }
    return stateCache
  } catch {
    return { ...EMPTY }
  }
}

function write(state: AccountState): void {
  stateCache = null
  tokenCache = null
  const path = fileFor()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8')
}

// ── Public API (called from IPC handlers) ───────────────────────────────

export interface PublicAccountState {
  // Plain session token (decrypted). Null if there's none, or if
  // decryption failed (e.g. user migrated machines).
  sessionToken: string | null
  skippedAt: number | null
  cachedEmail: string | null
}

/**
 * DEC-060 — the email, WITHOUT touching the OS keychain.
 *
 * `cachedEmail` is stored in plaintext by design (see the field comment: "safe
 * to surface unauthenticated"), so reading it never needed a decrypt. But every
 * caller went through loadAccountState(), which eagerly decrypts the session
 * token whether or not the caller wants it — so identifying the local actor for
 * an Event paid for a Keychain round trip it had no use for.
 *
 * Anything that only needs to know WHO the user is should call this. Only a
 * caller that genuinely needs the session token should reach for
 * loadAccountState().
 */
export function accountEmail(): string | null {
  return read().cachedEmail
}

export function loadAccountState(): PublicAccountState {
  const state = read()
  let sessionToken: string | null = null
  if (state.encryptedToken) {
    // Decrypt once per stored ciphertext. A repeat call is answered from memory
    // rather than by asking securityd again.
    if (tokenCache && tokenCache.cipher === state.encryptedToken) {
      return { sessionToken: tokenCache.plain, skippedAt: state.skippedAt, cachedEmail: state.cachedEmail }
    }
    if (!uiVisible) {
      console.warn(
        '[account] DEC-060: OS keychain decrypt requested BEFORE the window was shown. ' +
          'If the OS prompts for authorization here it will block the main thread ' +
          'behind a dialog with no visible parent, and the app will appear hung. ' +
          'Move this read after the window is visible, or use accountEmail().'
      )
    }
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = Buffer.from(state.encryptedToken, 'base64')
        sessionToken = safeStorage.decryptString(buf)
      } else {
        // Encryption unavailable on this platform — fall back to the
        // raw value (which we'd have stored plain anyway in that case).
        // safeStorage availability is checked at save time, so this
        // branch only fires if the OS keyring went away between sessions.
        sessionToken = state.encryptedToken
      }
    } catch {
      sessionToken = null
    }
    tokenCache = { cipher: state.encryptedToken, plain: sessionToken }
  }
  return {
    sessionToken,
    skippedAt: state.skippedAt,
    cachedEmail: state.cachedEmail
  }
}

export function saveSession(token: string, email: string | null): void {
  const cur = read()
  if (!safeStorage.isEncryptionAvailable()) {
    // Match the mail-password and API-key stores: refuse to persist a session
    // token in plaintext when OS encryption is unavailable, rather than
    // silently writing it raw. The session stays in memory for this run only.
    throw new Error('OS secure storage is unavailable, so the session cannot be saved securely on this device.')
  }
  const encryptedToken = safeStorage.encryptString(token).toString('base64')
  write({
    encryptedToken,
    // Saving a session implicitly clears the skip flag — the user is
    // now actively engaged with their account.
    skippedAt: null,
    cachedEmail: email ?? cur.cachedEmail
  })
}

export function clearSession(): void {
  const cur = read()
  write({
    encryptedToken: null,
    skippedAt: cur.skippedAt,
    cachedEmail: cur.cachedEmail
  })
}

// Record that the user dismissed the launch modal. The renderer uses
// `skippedAt` to throttle re-prompts to about once a week.
export function setSkipped(skipped: boolean): void {
  const cur = read()
  write({
    encryptedToken: cur.encryptedToken,
    skippedAt: skipped ? Date.now() : null,
    cachedEmail: cur.cachedEmail
  })
}

// Update the cached email — called after a successful login/signup so
// the next launch's login field can be pre-filled.
export function setCachedEmail(email: string | null): void {
  const cur = read()
  write({
    encryptedToken: cur.encryptedToken,
    skippedAt: cur.skippedAt,
    cachedEmail: email
  })
}
