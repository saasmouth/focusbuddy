import { useState } from 'react'
import Icon from './Icon'
import Modal from './plexi/Modal'
import { useAiCreditsStore, openAiSettings } from '../stores/aiCredits'
import { promptUpgrade } from '../stores/upgradePrompt'
import { TOP_UP_PACKS, formatCredits } from '@shared/aiCredits'

// The one prompt a credit refusal raises (growth spec section 2): "When the
// trial's credits run out, the app shows 'Trial credits used' with Upgrade and
// Top-up actions." The same modal covers spent credits after the trial, a
// model the plan does not include, and an unverified email. Mounted once in App;
// opened by stores/aiCredits from main's ai:creditEvent.

export default function CreditPromptModal(): JSX.Element | null {
  const prompt = useAiCreditsStore((s) => s.prompt)
  const status = useAiCreditsStore((s) => s.status)
  const dismiss = useAiCreditsStore((s) => s.dismissPrompt)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  if (!prompt) return null

  // email_not_verified opens the verification modal instead (stores/aiCredits).
  if (prompt.kind === 'verify_email') return null

  async function topUp(usd: number): Promise<void> {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const r = await window.api.ai.topUpCredits(usd)
      if (!r.ok) setNote(r.error ?? 'Could not start checkout.')
      else if (r.action === 'pending') setNote('Credit purchases are not switched on for this server yet.')
      else {
        setNote('Checkout opened in your browser. Your balance updates once payment completes.')
      }
    } finally {
      setBusy(false)
    }
  }

  function upgrade(reason: string, tier: 'pro' | 'proplus' = 'pro'): void {
    dismiss()
    promptUpgrade(reason, tier)
  }

  const title =
    prompt.kind === 'trial_used'
      ? 'Trial credits used'
      : prompt.kind === 'model_not_in_plan'
        ? 'That model is not on your plan'
        : 'AI credits used up'
  const body =
    prompt.kind === 'trial_used'
      ? 'Your trial’s AI credits are spent. Upgrade for a monthly allowance (Pro includes 800 credits a month), or add a credit pack. Everything else keeps working, and your own Anthropic key works on any plan.'
      : prompt.kind === 'model_not_in_plan'
        ? 'Opus runs on Pro+. Your plan’s models still work, and your own Anthropic key runs any model.'
        : prompt.next === 'upgrade'
          ? 'Your AI credits are spent for now. Upgrade for a larger monthly allowance, or add a credit pack.'
          : 'Your AI credits are spent for now. Add a credit pack, or wait for your monthly allowance to reset.'
  const showPacks = prompt.kind !== 'model_not_in_plan'
  const showUpgrade = prompt.kind !== 'out_of_credits' || prompt.next !== 'topup'

  return (
    <Modal onClose={dismiss} label={title} z={9998} className="fb-card max-w-sm w-full p-6" testId="credit-prompt-modal">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="h-8 w-8 inline-flex items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Icon name="toll" size={16} />
          </span>
          <h2 className="text-base font-semibold text-[var(--ink-100)]" data-testid="credit-prompt-title">
            {title}
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
      <p className="text-xs text-[var(--ink-70)] mb-3 leading-relaxed">{body}</p>
      {status?.balance !== null && status?.balance !== undefined && (
        <p className="fb-t-caption text-[var(--ink-50)] mb-3">Balance: {formatCredits(status.balance)}</p>
      )}
      {showPacks && (
        <div className="flex gap-1.5 mb-3">
          {TOP_UP_PACKS.map((p) => (
            <button
              key={p.usd}
              onClick={() => void topUp(p.usd)}
              disabled={busy}
              data-testid={`credit-prompt-topup-${p.usd}`}
              className="fb-btn-surface flex-1 rounded-[var(--radius-field)] py-1.5 text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-50 leading-tight"
            >
              <div className="text-xs font-medium">US${p.usd}</div>
              <div className="fb-t-caption text-[var(--ink-50)]">{p.credits.toLocaleString('en-US')} credits</div>
            </button>
          ))}
        </div>
      )}
      {note && <p className="fb-t-caption text-[var(--ink-50)] mb-3 leading-snug" data-testid="credit-prompt-note">{note}</p>}
      <div className="flex items-center justify-between gap-2 pt-3 border-t border-[var(--edge-soft)]">
        <button
          onClick={() => {
            dismiss()
            openAiSettings()
          }}
          className="text-xs px-2 py-1.5 rounded-md text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
          data-testid="credit-prompt-settings"
        >
          AI settings
        </button>
        {showUpgrade && (
          <button
            onClick={() =>
              prompt.kind === 'model_not_in_plan'
                ? upgrade('Opus on Plexii’s managed AI is part of Pro+.', 'proplus')
                : upgrade('A paid plan includes a monthly AI credit allowance.')
            }
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90"
            data-testid="credit-prompt-upgrade"
          >
            {prompt.kind === 'model_not_in_plan' ? 'Upgrade to Pro+' : 'Upgrade'}
          </button>
        )}
      </div>
    </Modal>
  )
}
