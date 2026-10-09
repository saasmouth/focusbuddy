// Capability store — caches the per-tier resolved capability map for
// the signed-in user, refreshed on auth change + window focus + an
// imperative `refresh()` call. Consumers read via `useCapability(key)`.
//
// Why a store + not a hook-only fetch: multiple features (body double,
// AI features, marketplace) read capabilities simultaneously. A single
// shared cache avoids N parallel fetches on every render.
//
// Fallback behavior:
//   - Signed in + fetch succeeded → server-resolved values
//   - Signed in + fetch failed → local-snapshot values for the
//     account's tier (degrades to "I think the user has Pro" if the
//     account-meta lookup was stale, which is acceptable while the
//     server is unreachable)
//   - Signed out → local-snapshot values for 'free' tier

import { create } from 'zustand'
import {
  CAPABILITY_DEFAULTS,
  type CapabilityValue,
  type TierId
} from '../lib/capabilityDefaults'
import { canCreateMore, canCreateWidget, limitFor } from '../lib/gating'
import { signalConfig } from '../lib/signalConfig'
import { useAccountStore } from './account'
import { useOrgStore, PERSONAL_ORG_ID } from './org'

// Trial envelope shape from /account/capabilities. The desktop reads
// this to render the footer badge and the "Trial ended" modal. Server
// is the source of truth; we never compute days locally because clock
// drift on the user's machine would silently mis-state the deadline.
export interface TrialState {
  active: boolean
  daysLeft: number
  startedAt: number | null
  expiresAt: number | null
}

interface CapabilityStore {
  // The TIER actually being applied right now (e.g. 'team' if trial is
  // active even though storedTier is 'free'). This is what consumers
  // gate against. The legacy `tier` field aliases this for back-compat.
  tier: TierId
  effectiveTier: TierId
  // The TIER stored against the account (the post-trial fallback).
  // Useful for upgrade UX so we can show "You're currently on Free —
  // upgrade to Pro to keep these features after your trial."
  storedTier: TierId
  trial: TrialState
  capabilities: Record<string, CapabilityValue>
  // Per-capability provenance from the server ('default'|'tier'|'org'|'user').
  // Lets the UI explain WHY an app is off: a 'user' source is an admin
  // restriction (no upsell), anything else is a licensing gap (offer upgrade).
  sources: Record<string, CapabilitySource>
  // The signed-in user's role in the ACTIVE org, so a locked-app upsell can be
  // role-aware (only owners/admins get an actionable upgrade CTA). Null in
  // Personal or when not in an org.
  orgRole: string | null
  loadedAt: number | null
  error: string | null
  refresh: () => Promise<void>
  /** Resolve a single capability synchronously — used by `useCapability`. */
  get: (key: string) => CapabilityValue
}

export type CapabilitySource = 'default' | 'tier' | 'org' | 'user'

const DEFAULT_TRIAL: TrialState = {
  active: false,
  daysLeft: 0,
  startedAt: null,
  expiresAt: null
}

function localMap(tier: TierId): Record<string, CapabilityValue> {
  const out: Record<string, CapabilityValue> = {}
  for (const [key, perTier] of Object.entries(CAPABILITY_DEFAULTS)) {
    out[key] = perTier[tier]
  }
  return out
}

// ── Dev-only tier override ───────────────────────────────────────────────
// Testing the Pro/Team surface normally requires being logged in against the
// dev signal so the server resolves your tier. That coupling is a constant
// papercut while iterating locally (a stale session token silently drops you
// to free and every Pro widget locks). This escape hatch lets a DEV build
// force a tier from the Settings → Developer toggle, resolved entirely from
// the local capability snapshot with no network. It is gated on
// `import.meta.env.DEV`, so it cannot affect a packaged production build.
const DEV_TIER_KEY = 'fb.dev.forceTier'

export function readDevForcedTier(): TierId | null {
  if (!import.meta.env.DEV) return null
  try {
    const v = localStorage.getItem(DEV_TIER_KEY)
    return v === 'free' || v === 'pro' || v === 'team' ? v : null
  } catch {
    return null
  }
}

/** Set (or clear, with null) the dev tier override and re-resolve capabilities. */
export function setDevForcedTier(tier: TierId | null): void {
  try {
    if (tier) localStorage.setItem(DEV_TIER_KEY, tier)
    else localStorage.removeItem(DEV_TIER_KEY)
  } catch {
    /* localStorage unavailable — nothing to persist */
  }
  void useCapabilityStore.getState().refresh()
}

export const useCapabilityStore = create<CapabilityStore>((set, get) => ({
  tier: 'free',
  effectiveTier: 'free',
  storedTier: 'free',
  trial: DEFAULT_TRIAL,
  capabilities: localMap('free'),
  sources: {},
  orgRole: null,
  loadedAt: null,
  error: null,
  refresh: async () => {
    // Dev override wins over everything (login state, network). DEV-only.
    const forced = readDevForcedTier()
    if (forced) {
      set({
        tier: forced,
        effectiveTier: forced,
        storedTier: forced,
        trial: DEFAULT_TRIAL,
        capabilities: localMap(forced),
        loadedAt: Date.now(),
        error: null
      })
      return
    }
    const token = useAccountStore.getState().sessionToken
    if (!token) {
      set({
        tier: 'free',
        effectiveTier: 'free',
        storedTier: 'free',
        trial: DEFAULT_TRIAL,
        capabilities: localMap('free'),
        sources: {},
        orgRole: null,
        loadedAt: null,
        error: null
      })
      return
    }
    try {
      // Resolve entitlements against the active org so org-level licensing
      // applies. Personal has no org layer.
      const activeOrgId = useOrgStore.getState().activeOrgId
      const orgQ = activeOrgId && activeOrgId !== PERSONAL_ORG_ID ? `?orgId=${encodeURIComponent(activeOrgId)}` : ''
      const res = await fetch(`${signalConfig.httpUrl}/account/capabilities${orgQ}`, {
        headers: { authorization: `Bearer ${token}` }
      })
      if (!res.ok) {
        if (res.status === 401) {
          // The session token is expired or revoked. Staying here would leave
          // the user silently stranded on whatever plan we last cached (almost
          // always Free), with no signal that re-auth would fix it. Clear the
          // dead session so the app reflects signed-out and the sign-in prompt
          // becomes reachable, and resolve capabilities to the signed-out Free
          // map explicitly.
          set({
            tier: 'free',
            effectiveTier: 'free',
            storedTier: 'free',
            trial: DEFAULT_TRIAL,
            capabilities: localMap('free'),
            sources: {},
            orgRole: null,
            loadedAt: Date.now(),
            error: 'session-expired'
          })
          const acct = useAccountStore.getState()
          if (acct.sessionToken) void acct.signOut()
          return
        }
        set({ error: `HTTP ${res.status}` })
        return
      }
      const body = (await res.json()) as {
        ok: boolean
        tier?: TierId
        // New richer fields. Older servers omit these — desktop falls
        // back to the legacy `tier`-only shape so a downgraded server
        // (or pinned old build) keeps working.
        storedTier?: TierId
        effectiveTier?: TierId
        trial?: TrialState
        capabilities?: Record<string, CapabilityValue>
        sources?: Record<string, CapabilitySource>
        orgRole?: string | null
      }
      if (!body.ok || !body.tier || !body.capabilities) {
        set({ error: 'Unexpected /account/capabilities shape' })
        return
      }
      const effectiveTier = body.effectiveTier ?? body.tier
      const storedTier = body.storedTier ?? body.tier
      const trial = body.trial ?? DEFAULT_TRIAL
      set({
        tier: effectiveTier,
        effectiveTier,
        storedTier,
        trial,
        capabilities: body.capabilities,
        sources: body.sources ?? {},
        orgRole: body.orgRole ?? null,
        loadedAt: Date.now(),
        error: null
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
  get: (key: string): CapabilityValue => {
    const map = get().capabilities
    return map[key] ?? false
  }
}))

/**
 * Hook — reactive read of the user's trial state. Returns the envelope
 * the server sent (active flag, days left, expiry). Renderer-side UI
 * uses this to decide whether to show the footer badge / lapsed modal.
 */
export function useTrial(): TrialState {
  return useCapabilityStore((s) => s.trial)
}

/** Hook — current stored tier, for upgrade-affordance copy. */
export function useStoredTier(): TierId {
  return useCapabilityStore((s) => s.storedTier)
}

/**
 * Initialise the capability subscription:
 *   - Refresh whenever the account session changes (login, logout,
 *     adoptHandoff).
 *   - Refresh on window focus so admin matrix edits propagate quickly.
 * Called once from App.tsx on mount.
 */
export function installCapabilityWatcher(): () => void {
  const unsubAccount = useAccountStore.subscribe((s, prev) => {
    if (s.sessionToken !== prev.sessionToken) {
      void useCapabilityStore.getState().refresh()
    }
  })
  const onFocus = (): void => {
    void useCapabilityStore.getState().refresh()
  }
  window.addEventListener('focus', onFocus)
  // Kick off an immediate fetch (uses whatever session is loaded).
  void useCapabilityStore.getState().refresh()
  return () => {
    unsubAccount()
    window.removeEventListener('focus', onFocus)
  }
}

/**
 * Hook — reactive read of a single capability. Returns the resolved
 * value (boolean / number / string). Use as `useCapability('body_double')`.
 */
export function useCapability(key: string): CapabilityValue {
  return useCapabilityStore((s) => s.capabilities[key] ?? false)
}

/** Convenience: true if the capability resolves truthy. */
export function useCapabilityEnabled(key: string): boolean {
  const v = useCapability(key)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v > 0
  if (typeof v === 'string') return v.length > 0 && v.toLowerCase() !== 'off'
  return false
}

// ── Gating hooks (thin wrappers over the pure decision layer) ────────────
// These let UI gate against the live, admin-overridable capability map
// using the exact same logic the unit tests cover. UI must use these
// rather than re-deriving limits/booleans inline.

/** The numeric limit for a capability (null = unlimited). */
export function useCapabilityLimit(key: string): number | null {
  return useCapabilityStore((s) => limitFor(s.capabilities, key))
}

/** Whether the user may create one more of a limited resource. */
export function useCanCreateMore(key: string, currentCount: number): boolean {
  return useCapabilityStore((s) => canCreateMore(s.capabilities, key, currentCount))
}

/** Whether the user may create a widget of this catalog kind. */
export function useCanCreateWidget(kind: string): boolean {
  return useCapabilityStore((s) => canCreateWidget(s.capabilities, kind))
}

// Expose the capability store on window, the same thin handle as __fbView and
// __fbWidgets, so e2e specs can drive an edition's feature set directly. It is
// the real store, not a mock: nothing about how the app behaves changes.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbCapabilities?: typeof useCapabilityStore }).__fbCapabilities =
    useCapabilityStore
}
