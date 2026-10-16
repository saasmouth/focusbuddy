// Global "upgrade to unlock" prompt. Any gated action (a locked widget
// tile, hitting the desk limit, a Pro-only feature) calls promptUpgrade()
// with a short reason; the single <UpgradePromptModal/> mounted in App
// renders it. Centralising this means every gate uses the same modal and
// copy instead of each feature rolling its own.

import { create } from 'zustand'
import type { PaidPlanId } from '../lib/plans'

interface UpgradePromptStore {
  // The feature/reason being gated, or null when the modal is closed.
  reason: string | null
  // Optional: the tier that would unlock it (for copy like "available on Pro").
  requiredTier: PaidPlanId | null
  promptUpgrade: (reason: string, requiredTier?: PaidPlanId) => void
  dismiss: () => void
}

export const useUpgradePromptStore = create<UpgradePromptStore>((set) => ({
  reason: null,
  requiredTier: null,
  promptUpgrade: (reason, requiredTier = 'pro') => set({ reason, requiredTier }),
  dismiss: () => set({ reason: null, requiredTier: null })
}))

/** Imperative helper for non-component call sites (stores, handlers). */
export function promptUpgrade(reason: string, requiredTier: PaidPlanId = 'pro'): void {
  useUpgradePromptStore.getState().promptUpgrade(reason, requiredTier)
}
