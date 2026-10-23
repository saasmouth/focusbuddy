import { create } from 'zustand'
import { detectCompletion, type CompletionOffer, type CompletionSignal } from '../lib/completionDetect'
import { useWorkItemStore } from './workItems'

// DEC-052 (Track D) — the offer surface's state. The contract, from the
// ruling, made structural:
// - NEVER auto-complete: the only writer is the toast's confirm, and it runs
//   the same accounted close path every surface uses.
// - NEVER nag: the (signal, item) pairing is checked against the ledger
//   before showing (once-ever), one offer holds the stage at a time (a new
//   one replaces — the knock pattern), and ignoring costs nothing (it slides
//   away and the pairing records 'ignored', never to return).

interface CompletionOfferStore {
  offer: CompletionOffer | null
  /** An emitter observed an action: record it, match it, maybe offer. */
  observe: (input: {
    kind: string
    targetKind?: string
    targetRef?: string
    payload?: string
  }) => Promise<void>
  resolve: (outcome: 'completed' | 'dismissed' | 'ignored') => void
}

const OFFER_TTL_MS = 12_000
let ttlTimer: number | null = null

export const useCompletionOffer = create<CompletionOfferStore>((set, get) => ({
  offer: null,
  observe: async (input) => {
    try {
      const recorded = await window.api.signals.record(input)
      const signal: CompletionSignal = {
        id: recorded.id,
        kind: input.kind,
        targetKind: input.targetKind ?? null,
        targetRef: input.targetRef ?? null,
        occurredAt: recorded.occurredAt
      }
      const items = useWorkItemStore.getState().items
      const offer = detectCompletion(signal, items)
      if (!offer) return
      // Once-ever: a pairing that was already prompted (or resolved) is done.
      const state = await window.api.signals.matchState(offer.signalId, offer.itemId)
      if (state?.promptedAt != null || state?.outcome != null) return
      await window.api.signals.markPrompted(offer.signalId, offer.itemId, offer.confidence)
      set({ offer })
      if (ttlTimer) window.clearTimeout(ttlTimer)
      ttlTimer = window.setTimeout(() => {
        // Sliding away unanswered is a zero-cost ignore.
        if (get().offer?.signalId === offer.signalId) get().resolve('ignored')
      }, OFFER_TTL_MS)
    } catch {
      /* an observation must never break the action that produced it */
    }
  },
  resolve: (outcome) => {
    const cur = get().offer
    if (!cur) return
    if (ttlTimer) {
      window.clearTimeout(ttlTimer)
      ttlTimer = null
    }
    set({ offer: null })
    void window.api.signals.outcome(cur.signalId, cur.itemId, outcome)
  }
}))

// Test-only handle so e2e specs can drive the completion toast without finishing a real work item.
// Same convention as __fbView / __fbMeetingRoom: a thin handle to the real
// store, so a spec drives the product rather than a stand-in for it.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __fbCompletionOffer?: typeof useCompletionOffer }).__fbCompletionOffer = useCompletionOffer
}
