import { create } from 'zustand'
import {
  getMe,
  login as serverLogin,
  logout as serverLogout,
  signup as serverSignup,
  updateProfile as serverUpdateProfile,
  type AuthResult,
  type ServerAccount
} from '../lib/accountClient'

// Account store — single source of truth for "am I signed in, and as who?"
// on the renderer.
//
// Lifecycle:
//   1. App boots → init() loads the cached session from main (encrypted
//      via safeStorage). If present, validates it against /accounts/me.
//      Valid → account populated. Invalid (network or expired) → cleared.
//   2. User signs up / logs in → store saves session via IPC to main
//      (which encrypts + persists), populates account.
//   3. User signs out → wipes the session from main + local memory + the
//      cached email (their choice — they explicitly left).
//
// The store also tracks `bootStatus` so the launch modal knows when it's
// safe to render — we don't want to flash the sign-in modal for half a
// second before realizing the user is already signed in.

export type BootStatus = 'idle' | 'loading' | 'ready'

interface AccountStore {
  bootStatus: BootStatus
  // The plain session token (decrypted) — used as the Authorization
  // bearer for inbox + future cloud-sync calls. Null when signed out.
  sessionToken: string | null
  account: ServerAccount | null
  // Wall-clock ms when the user last clicked "Continue without account"
  // in the launch modal. Lets the modal throttle re-prompts to ~weekly.
  skippedAt: number | null
  // App starts made with no account. Past ANON_LAUNCH_LIMIT, the launch modal
  // stops offering a way past itself.
  anonLaunches: number
  cachedEmail: string | null
  // Loaded once on app boot. Validates the cached session, populates
  // account. Idempotent; safe to call multiple times.
  init: () => Promise<void>
  // Sign up via the server, persist + populate on success.
  signup: (input: {
    email: string
    password: string
    handle?: string | null
    firstName?: string | null
    lastName?: string | null
  }) => Promise<AuthResult>
  // Log in via the server, persist + populate on success.
  login: (input: { email: string; password: string; code?: string }) => Promise<AuthResult>
  // Update the signed-in user's real name. Returns true on success.
  updateName: (input: { firstName: string | null; lastName: string | null }) => Promise<boolean>
  // Sign out — wipe local + main session, tell the server to invalidate.
  signOut: () => Promise<void>
  // Tell main to remember the user dismissed the launch modal.
  setSkipped: (skipped: boolean) => Promise<void>
  // Adopt a session token handed off from the web flow via the
  // haptyx:// URL scheme. Validates the token against the server,
  // persists it locally if valid, returns the new account. The token
  // is the same shape as `signup`/`login` produce, so this method is
  // just "skip the password step because the web already proved it."
  adoptHandoff: (input: {
    sessionToken: string
    email: string | null
  }) => Promise<AuthResult>
}

export const useAccountStore = create<AccountStore>((set, get) => ({
  bootStatus: 'idle',
  sessionToken: null,
  account: null,
  skippedAt: null,
  anonLaunches: 0,
  cachedEmail: null,

  init: async () => {
    if (get().bootStatus !== 'idle') return
    set({ bootStatus: 'loading' })
    try {
      const cached = await window.api.account.load()
      set({
        skippedAt: cached.skippedAt,
        anonLaunches: cached.anonLaunches ?? 0,
        cachedEmail: cached.cachedEmail
      })
      if (!cached.sessionToken) {
        set({ bootStatus: 'ready' })
        return
      }
      // Validate against the server. Only wipe the local session when the server
      // EXPLICITLY rejects the token (expired or revoked). A network failure
      // must never sign the user out: keep the cached session, let the app run
      // offline, and retry validation in the background until it succeeds.
      const me = await getMe(cached.sessionToken)
      if (me.status === 'unauthenticated') {
        await window.api.account.clearSession()
        set({ sessionToken: null, account: null, bootStatus: 'ready' })
        return
      }
      if (me.status === 'unreachable') {
        // Could not reach the server to validate. Stay signed in on the cached
        // token (cachedEmail already set above covers UI that needs the email),
        // mark ready so the workspace is usable, and revalidate shortly.
        set({ sessionToken: cached.sessionToken, bootStatus: 'ready' })
        void revalidateSessionSoon(cached.sessionToken)
        return
      }
      set({
        sessionToken: cached.sessionToken,
        account: me.account,
        bootStatus: 'ready'
      })
    } catch (err) {
      // Surface but don't crash — the user can still use the app offline.
      // eslint-disable-next-line no-console
      console.warn('[accountStore.init] failed:', err)
      set({ bootStatus: 'ready' })
    }
  },

  signup: async (input) => {
    const result = await serverSignup(input)
    if (result.ok) {
      await window.api.account.saveSession({
        token: result.sessionToken,
        email: result.account.email
      })
      set({
        sessionToken: result.sessionToken,
        account: result.account,
        skippedAt: null,
        cachedEmail: result.account.email
      })
    }
    return result
  },

  updateName: async (input) => {
    const token = get().sessionToken
    if (!token) return false
    const updated = await serverUpdateProfile(token, input)
    if (!updated) return false
    set({ account: updated })
    return true
  },

  login: async (input) => {
    const result = await serverLogin(input)
    if (result.ok) {
      await window.api.account.saveSession({
        token: result.sessionToken,
        email: result.account.email
      })
      set({
        sessionToken: result.sessionToken,
        account: result.account,
        skippedAt: null,
        cachedEmail: result.account.email
      })
    }
    return result
  },

  signOut: async () => {
    const cur = get().sessionToken
    if (cur) {
      // Fire-and-forget — even if the server is unreachable, we proceed
      // with the local wipe so the user isn't stuck "signed in" locally.
      void serverLogout(cur)
    }
    await window.api.account.clearSession()
    set({ sessionToken: null, account: null })
  },

  setSkipped: async (skipped) => {
    await window.api.account.setSkipped(skipped)
    set({ skippedAt: skipped ? Date.now() : null })
  },

  adoptHandoff: async ({ sessionToken, email }) => {
    // Validate the token by asking the server who it belongs to.
    // If the token is expired/forged the server returns null and we
    // surface a normal failed-auth result so the caller can show the
    // launch modal.
    const me = await getMe(sessionToken)
    if (me.status !== 'ok') {
      return {
        ok: false,
        error:
          me.status === 'unreachable'
            ? 'Could not reach the server to finish signing in. Check your connection and try again.'
            : 'Sign-in link expired. Sign in again from the website.',
        code: 'INVALID_CREDENTIALS'
      }
    }
    const account = me.account
    // Mismatched email-hint is non-fatal — the server's account row is
    // authoritative. We log it once for debug.
    if (email && email.toLowerCase() !== account.email.toLowerCase()) {
      // eslint-disable-next-line no-console
      console.warn('[accountStore.adoptHandoff] email hint mismatch', email, account.email)
    }
    // Persisting can fail on a machine with no OS secure storage (we refuse to
    // write the token in plaintext now). That must not block sign-in: keep the
    // session in memory for this run and carry on.
    await window.api.account.saveSession({ token: sessionToken, email: account.email }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[accountStore.adoptHandoff] session not persisted (no secure storage):', err)
    })
    set({
      sessionToken,
      account,
      skippedAt: null,
      cachedEmail: account.email
    })
    return { ok: true, sessionToken, account }
  }
}))

// Retry session validation after an offline boot. We keep the user signed in on
// a network failure and quietly re-check until the server is reachable, so a
// transient outage never logs anyone out. Bounded backoff; stops once the token
// is confirmed, explicitly rejected, or the user signs out / the token changes.
async function revalidateSessionSoon(token: string, attempt = 0): Promise<void> {
  const delayMs = Math.min(30_000, 3_000 * 2 ** attempt) // 3s, 6s, 12s, 24s, 30s…
  await new Promise((r) => setTimeout(r, delayMs))
  // Bail if the user signed out or the token changed while we waited.
  if (useAccountStore.getState().sessionToken !== token) return
  const me = await getMe(token)
  if (me.status === 'ok') {
    useAccountStore.setState({ account: me.account })
    return
  }
  if (me.status === 'unauthenticated') {
    await window.api.account.clearSession()
    useAccountStore.setState({ sessionToken: null, account: null })
    return
  }
  // Still unreachable — keep retrying, capped so we never loop forever.
  if (attempt < 10 && useAccountStore.getState().sessionToken === token) {
    void revalidateSessionSoon(token, attempt + 1)
  }
}

// Expose the account store on window so e2e specs can read the session token to
// drive REST-only flows (e.g. creating + sharing a live folder). A thin handle to
// the real store, not a mock; it changes nothing about how the app behaves.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbAccount?: typeof useAccountStore }).__fbAccount = useAccountStore
}
