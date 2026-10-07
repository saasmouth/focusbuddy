import Icon from './Icon'
import Modal from './plexi/Modal'
import { useUpgradePromptStore } from '../stores/upgradePrompt'
import { useStoredTier } from '../stores/capabilities'
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
// Signed out, or Stripe not configured on the server, still falls back to the
// pricing page: that is the honest option when there is no checkout to open.
export default function UpgradePromptModal(): JSX.Element | null {
  const reason = useUpgradePromptStore((s) => s.reason)
  const requiredTier = useUpgradePromptStore((s) => s.requiredTier)
  const dismiss = useUpgradePromptStore((s) => s.dismiss)
  const storedTier = useStoredTier()
  // Yearly is two months free on both paid plans ($9.95x12 = $119.40 against
  // $99; $14.95x12 = $179.40 against $149). The prices existed and the pricing
  // page advertised the saving, but nothing could actually buy it.
  const [interval, setInterval] = useState<'month' | 'year'>('month')

  if (!reason) return null

  // requiredTier is nullable in the store; the modal only renders with a
  // reason set, but narrow it here so the checkout call is well typed.
  const tier: 'pro' | 'team' = requiredTier === 'team' ? 'team' : 'pro'
  const tierName = tier === 'team' ? 'Team' : 'Pro'
  const openPricing = (): void => {
    window.open(PRICING_URL, '_blank', 'noopener,noreferrer')
    dismiss()
  }
  const startCheckout = async (): Promise<void> => {
    const token = useAccountStore.getState().sessionToken
    if (!token) {
      // No session to attach a subscription to. The pricing page's signup flow
      // is the right destination for someone who is not signed in.
      openPricing()
      return
    }
    const started = await startUpgrade(tier, interval, token).catch(() => null)
    if (started && (started.action === 'redirect' || started.action === 'portal') && started.url) {
      window.open(started.url, '_blank', 'noopener,noreferrer')
      dismiss()
      return
    }
    // 'pending' (Stripe unconfigured) or an error. Don't pretend it worked.
    openPricing()
  }

  return (
    <Modal
      onClose={dismiss}
      label={`A ${tierName} feature`}
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
              A {tierName} feature
            </h2>
          </div>
          <button
            onClick={dismiss}
            className="h-6 w-6 inline-flex items-center justify-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="text-xs text-[var(--ink-70)] mb-1 leading-relaxed" data-testid="upgrade-reason">
          {reason}
        </p>
        <p className="text-[11px] text-[var(--ink-50)] mb-4 leading-relaxed">
          {storedTier === 'free'
            ? `It's included on ${tierName}. Your 14-day trial unlocks everything if it's still active.`
            : `It's included on ${tierName}.`}
        </p>
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
              {iv === 'month' ? 'Monthly' : 'Yearly — 2 months free'}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-[var(--edge-soft)]">
          <button
            onClick={dismiss}
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
            Upgrade to {tierName}
          </button>
        </div>
    </Modal>
  )
}
