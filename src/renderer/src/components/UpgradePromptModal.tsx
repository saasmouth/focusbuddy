import Icon from './Icon'
import Modal from './plexi/Modal'
import { useUpgradePromptStore } from '../stores/upgradePrompt'
import { usePlan } from '../stores/capabilities'
import { planInfo, priceLabel, aiAllowanceLabel, type PaidPlanId, type PlanId } from '../lib/plans'
import { PRICING_URL } from '../lib/siteUrls'
import { useState } from 'react'
import { useAccountStore } from '../stores/account'
import { startUpgrade } from '../lib/accountClient'

// Single global modal for capability gates. Driven by useUpgradePromptStore;
// any gated action calls promptUpgrade('<reason>') and this renders. Mounted
// once in App so every gate shares one modal + consistent copy.
//
// Mirrors the TrialBadge TierPickerModal styling.
//
// The button starts a real Stripe checkout for the signed-in account. It used to
// open the public pricing page, whose Pro link goes to /account/signup — so a
// signed-in user who hit a gate was asked to create a SECOND account in order to
// pay for the one they already had, and no existing account could ever upgrade.
//
// Signed out falls back to the pricing page. Stripe not configured says so, with
// the pricing page offered beside it, rather than silently opening it.
//
// Plans and prices come from lib/plans.ts (growth spec section 1: Pro US$12,
// Pro+ US$25, Team US$15 a seat; yearly is ten months' price).
/**
 * The plans that unlock what the gate asked for. Pro+ and Team both include
 * everything in Pro; only Pro+ adds Opus; only Team adds the team features.
 * The plan the account is already on is never offered.
 */
export function eligiblePlans(required: PaidPlanId, current: PlanId): PaidPlanId[] {
  const unlocks: Record<PaidPlanId, PaidPlanId[]> = {
    pro: ['pro', 'proplus', 'team'],
    proplus: ['proplus'],
    team: ['team']
  }
  return unlocks[required].filter((p) => p !== current)
}

export default function UpgradePromptModal(): JSX.Element | null {
  const reason = useUpgradePromptStore((s) => s.reason)
  const requiredTier = useUpgradePromptStore((s) => s.requiredTier)
  const dismiss = useUpgradePromptStore((s) => s.dismiss)
  const plan = usePlan()
  // Yearly is two months free on every paid plan (US$120 against 12 x US$12,
  // and so on). The prices are in lib/plans.ts, pinned to the growth spec.
  const [interval, setInterval] = useState<'month' | 'year'>('month')
  const [picked, setPicked] = useState<PaidPlanId | null>(null)
  const [note, setNote] = useState<string | null>(null)

  if (!reason) return null

  const required: PaidPlanId = requiredTier ?? 'pro'
  const options = eligiblePlans(required, plan)
  const choice: PaidPlanId = picked && options.includes(picked) ? picked : (options[0] ?? required)
  const choiceInfo = planInfo(choice)
  const close = (): void => {
    setPicked(null)
    setNote(null)
    dismiss()
  }
  const openPricing = (): void => {
    window.open(PRICING_URL, '_blank', 'noopener,noreferrer')
    close()
  }
  const startCheckout = async (): Promise<void> => {
    const token = useAccountStore.getState().sessionToken
    if (!token) {
      // No session to attach a subscription to. The pricing page's signup flow
      // is the right destination for someone who is not signed in.
      openPricing()
      return
    }
    const started = await startUpgrade(choice, interval, token).catch(() => null)
    if (started && (started.action === 'redirect' || started.action === 'portal') && started.url) {
      window.open(started.url, '_blank', 'noopener,noreferrer')
      close()
      return
    }
    if (started?.action === 'pending') {
      // Stripe is not configured on this server. Say so instead of opening a
      // page that cannot take the payment.
      setNote('Checkout is not switched on for this server yet. The pricing page has the plans.')
      return
    }
    setNote('Could not start checkout. Check your connection and try again, or use the pricing page.')
  }

  return (
    <Modal
      onClose={close}
      label={`Upgrade to ${choiceInfo.name}`}
      z={9999}
      className="fb-card max-w-sm w-full p-6"
      testId="upgrade-prompt-modal"
    >
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Icon name="lock" size={16} />
            </span>
            <h2 className="text-base font-semibold text-[var(--ink-100)]">
              {options.length > 1 ? 'Upgrade your plan' : `A ${choiceInfo.name} feature`}
            </h2>
          </div>
          <button
            onClick={close}
            className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-xs text-[var(--ink-70)] mb-1 leading-relaxed" data-testid="upgrade-reason">
          {reason}
        </p>
        {plan === 'free' && (
          <p className="text-[11px] text-[var(--ink-50)] mb-3 leading-relaxed">
            A 14-day trial with everything unlocked starts when you verify your email.
          </p>
        )}
        <div className="space-y-1.5 mb-1" role="radiogroup" aria-label="Plan">
          {options.map((id) => {
            const p = planInfo(id)
            const on = id === choice
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setPicked(id)}
                data-testid={`upgrade-plan-${id}`}
                className={`w-full text-left rounded-md border px-3 py-2 transition-colors ${
                  on ? 'border-accent/50 bg-accent/5' : 'border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-semibold text-[var(--ink-100)]">{p.name}</span>
                  <span className="text-[11px] text-[var(--ink-70)]" data-testid={`upgrade-price-${id}`}>
                    {priceLabel(p, interval)}
                  </span>
                </div>
                <div className="text-[10.5px] text-[var(--ink-50)] leading-snug mt-0.5">{aiAllowanceLabel(p)}</div>
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1 pt-3 mt-1">
          {(['month', 'year'] as const).map((iv) => (
            <button
              key={iv}
              type="button"
              onClick={() => setInterval(iv)}
              aria-pressed={interval === iv}
              data-testid={`upgrade-interval-${iv}`}
              className={`text-[11px] px-2 py-1 rounded-md transition-colors ${
                interval === iv
                  ? 'bg-[var(--surface-sunken)] text-[var(--ink)]'
                  : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              {iv === 'month' ? 'Monthly' : 'Yearly, 2 months free'}
            </button>
          ))}
        </div>
        {note && (
          <p className="text-[11px] text-[var(--ink-50)] mt-2 leading-snug" data-testid="upgrade-note">
            {note}{' '}
            <button type="button" onClick={openPricing} className="text-accent hover:underline">
              Pricing page
            </button>
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--edge-soft)] mt-3">
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] transition-colors"
            data-testid="upgrade-later"
          >
            Maybe later
          </button>
          <button
            onClick={() => void startCheckout()}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
            data-testid="upgrade-start-checkout"
          >
            Upgrade to {choiceInfo.name}
          </button>
        </div>
    </Modal>
  )
}
