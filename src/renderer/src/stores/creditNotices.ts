// The credit-earned notices (share credit, 4.3.52): what the card in the
// bottom-right corner shows (components/CreditEarnedCard.tsx).
//
// A notice arrives live on the account socket the moment the credit lands, and
// the server keeps every one it has not been told was seen (GET
// /account/notices), so a credit earned while the app was closed is still
// celebrated at the next launch. Each stays until the person dismisses it;
// dismissing tells the server (POST /account/notices/:id/seen). A dismissal
// the server did not take is retried at the next load, and never shown again.
import { create } from 'zustand'
import { setCreditEarnedHandler } from '../lib/messagingSocket'
import { fetchCreditNotices, formatUsd, markCreditNoticeSeen, parseCreditNotice, type CreditNotice } from '../lib/creditNotices'
import { notifyExternal } from '../lib/notify'
import { useAccountStore } from './account'
import { useCapabilityStore } from './capabilities'

interface CreditNoticesState {
  /** Unseen notices, newest first. */
  notices: CreditNotice[]
  /** The notice that just arrived live, for the card's one celebration. */
  arrivedId: string | null
  /** Dismissed here: never shown again this session, even if a list still has it. */
  dismissedIds: string[]
  /** Dismissed, but the server has not confirmed it yet: retried at the next load. */
  unsentSeenIds: string[]
  ready: boolean
  /** Install the socket handler (once). */
  init: () => void
  /** Add one notice (from the socket, or a list). */
  add: (notice: CreditNotice, opts?: { live?: boolean }) => void
  /** Fetch the unseen ones from the server. */
  load: () => Promise<void>
  /** The person closed it: gone from the card, and marked seen. */
  dismiss: (id: string) => Promise<void>
  /** Signed out: nothing of the last account stays on screen. */
  reset: () => void
}

const byNewest = (a: CreditNotice, b: CreditNotice): number => b.createdAt - a.createdAt

export const useCreditNoticesStore = create<CreditNoticesState>((set, get) => ({
  notices: [],
  arrivedId: null,
  dismissedIds: [],
  unsentSeenIds: [],
  ready: false,

  init: () => {
    if (get().ready) return
    setCreditEarnedHandler((payload) => {
      const notice = parseCreditNotice(payload)
      if (notice) get().add(notice, { live: true })
    })
    set({ ready: true })
  },

  add: (notice, opts = {}) => {
    const s = get()
    if (s.dismissedIds.includes(notice.id) || s.notices.some((n) => n.id === notice.id)) return
    set({ notices: [...s.notices, notice].sort(byNewest), arrivedId: opts.live ? notice.id : s.arrivedId })
    // In the background, a system notification too (skipped while the app has focus).
    if (opts.live) notifyExternal(`You earned ${formatUsd(notice.usd)} of Plexii credit`, notice.text, { tag: `credit-${notice.id}` })
  },

  load: async () => {
    // First, the dismissals the server has not confirmed.
    const unsent = get().unsentSeenIds
    if (unsent.length) {
      const results = await Promise.all(unsent.map(async (id) => ((await markCreditNoticeSeen(id)) ? null : id)))
      set({ unsentSeenIds: results.filter((id): id is string => id !== null) })
    }
    const fetched = await fetchCreditNotices()
    // Not fetched (offline, signed out): keep what is on screen; the server
    // still has them, so the next load shows them.
    if (!fetched) return
    for (const n of fetched) get().add(n)
  },

  dismiss: async (id) => {
    set((s) => ({
      notices: s.notices.filter((n) => n.id !== id),
      dismissedIds: s.dismissedIds.includes(id) ? s.dismissedIds : [...s.dismissedIds, id],
      arrivedId: s.arrivedId === id ? null : s.arrivedId
    }))
    if (!(await markCreditNoticeSeen(id))) set((s) => ({ unsentSeenIds: s.unsentSeenIds.includes(id) ? s.unsentSeenIds : [...s.unsentSeenIds, id] }))
  },

  reset: () => set({ notices: [], arrivedId: null, dismissedIds: [], unsentSeenIds: [] })
}))

/** How often a focus of the window reloads the list (the socket carries them live). */
export const RELOAD_ON_FOCUS_MS = 5 * 60_000

/**
 * Wire the notices to the session (called once from App):
 * - the socket handler;
 * - a load when a signed-in session's server says it has notices (launch,
 *   sign-in, an account switch), and on a window focus at most every
 *   RELOAD_ON_FOCUS_MS, for any a dropped socket missed;
 * - nothing of an account left on screen after it signs out or switches.
 * Returns the uninstall.
 */
export function installCreditNotices(): () => void {
  useCreditNoticesStore.getState().init()
  let token: string | null = null
  let hadFeature = false
  let lastLoad = 0
  const sync = (focus: boolean): void => {
    const nextToken = useAccountStore.getState().sessionToken
    const has = useCapabilityStore.getState().serverFeatures.includes('creditEarned')
    if (nextToken !== token) {
      if (token) useCreditNoticesStore.getState().reset()
      token = nextToken
      hadFeature = false
    }
    if (!token || !has) {
      hadFeature = has
      return
    }
    const fresh = !hadFeature
    hadFeature = true
    if (!fresh && !(focus && Date.now() - lastLoad >= RELOAD_ON_FOCUS_MS)) return
    lastLoad = Date.now()
    void useCreditNoticesStore.getState().load()
  }
  const unsubCaps = useCapabilityStore.subscribe(() => sync(false))
  const unsubAccount = useAccountStore.subscribe(() => sync(false))
  const onFocus = (): void => sync(true)
  window.addEventListener('focus', onFocus)
  sync(false)
  return () => {
    unsubCaps()
    unsubAccount()
    window.removeEventListener('focus', onFocus)
  }
}

