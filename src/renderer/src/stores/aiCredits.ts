// The renderer's view of the AI credit balance and the prompts a refusal
// raises. Main owns the numbers (src/main/ai/creditMode.ts); this mirrors them
// for the meter and listens for ai:creditEvent so a refusal deep inside any AI
// call becomes one clear prompt: "Trial credits used", "Credits used up",
// "That model is on Pro+", or "Verify your email".

import { create } from 'zustand'
import { isTrialCreditsExhausted, type AiCreditStatus, type AiCreditEvent } from '@shared/aiCredits'
import { useCapabilityStore } from './capabilities'
import { useVerifyEmailStore } from './verifyEmail'

export type CreditPromptKind = 'trial_used' | 'out_of_credits' | 'model_not_in_plan' | 'verify_email'

interface AiCreditsStore {
  status: AiCreditStatus | null
  prompt: { kind: CreditPromptKind; next: 'upgrade' | 'topup' | null } | null
  refresh: () => Promise<void>
  /** Main's cached status, without a network read. */
  sync: () => Promise<void>
  dismissPrompt: () => void
  /** Map a refusal to the prompt to show. Exposed for tests. */
  handleEvent: (e: AiCreditEvent) => void
}

/** Which prompt a refusal deserves, given the account's trial and plan. */
export function promptFor(
  e: Pick<AiCreditEvent, 'error' | 'next'>,
  ctx: { trialActive: boolean; plan: string | null; balance: number | null }
): CreditPromptKind {
  if (e.error === 'email_not_verified') return 'verify_email'
  if (e.error === 'model_not_in_plan') return 'model_not_in_plan'
  const storedPlan = ctx.plan === 'pro' || ctx.plan === 'proplus' || ctx.plan === 'team' ? ctx.plan : 'free'
  return isTrialCreditsExhausted({
    trialActive: ctx.trialActive,
    storedPlan,
    error: { error: e.error, next: e.next, allowedModel: null },
    balance: ctx.balance
  })
    ? 'trial_used'
    : 'out_of_credits'
}

export const useAiCreditsStore = create<AiCreditsStore>((set, get) => ({
  status: null,
  prompt: null,
  refresh: async () => {
    try {
      const status = await window.api.ai.refreshCredits()
      set({ status })
    } catch {
      /* keep the last known status rather than inventing one */
    }
  },
  sync: async () => {
    try {
      set({ status: await window.api.ai.getStatus() })
    } catch {
      /* ignore */
    }
  },
  dismissPrompt: () => set({ prompt: null }),
  handleEvent: (e) => {
    const caps = useCapabilityStore.getState()
    const kind = promptFor(e, { trialActive: caps.trial.active, plan: caps.plan, balance: e.status.balance })
    if (kind === 'verify_email') {
      // Its own flow: the code-entry modal, not a credits prompt.
      set({ status: e.status })
      useVerifyEmailStore.getState().open()
      return
    }
    // One prompt at a time: a burst of refusals (a multi-call feature failing
    // on every call) must not stack or re-open a prompt the person just closed
    // for the same reason.
    const cur = get().prompt
    set({ status: e.status, prompt: cur ?? { kind, next: e.next } })
  }
}))

/** Subscribe to main's credit events. Called once from App. */
export function installCreditEventWatcher(): () => void {
  const off = window.api.ai.onCreditEvent((e) => useAiCreditsStore.getState().handleEvent(e))
  void useAiCreditsStore.getState().sync()
  return off
}

/** Open Settings on the AI tab, where the balance and top-ups live. */
export function openAiSettings(): void {
  window.dispatchEvent(new CustomEvent('fb:open-settings', { detail: { tab: 'ai' } }))
}
