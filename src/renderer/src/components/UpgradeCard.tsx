import { useState } from 'react'
import Icon from './Icon'
import { promptUpgrade } from '../stores/upgradePrompt'
import { useStoredTier } from '../stores/capabilities'
import { showsProUpsell } from '../lib/planDisplay'

// One shared Pro upsell card for the foot of every side menu (Desk sidebar,
// PlexiOffice, and the segment shells), so they all end the same way.
//
// Dismissal is session-only by design: the X hides the card for this app
// session (sessionStorage), and the next launch brings it back.
const DISMISS_KEY = 'fb.upgradeCard.dismissed'

export default function UpgradeCard({ label }: { label: string }): JSX.Element | null {
  // This checked nothing at all, and it is rendered unconditionally by the
  // sidebar, the PlexiOffice shell and every segment shell — so a paying Pro
  // or Team subscriber was asked to upgrade to Pro, on every screen, forever.
  //
  // storedTier, not effectiveTier: an active trial lifts effectiveTier to
  // 'team' for everybody, and hiding the upsell from people on a trial would
  // remove it from exactly the audience it exists for.
  const storedTier = useStoredTier()
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(DISMISS_KEY) === '1')
  if (!showsProUpsell(storedTier)) return null
  if (dismissed) return null
  return (
    <div
      className="relative rounded-[12px] bg-[rgb(var(--accent)/0.08)] shadow-[0_0_0_1px_rgb(var(--accent)/0.15),inset_0_1px_0_rgb(255_255_255/0.06)] p-3"
      data-testid="upgrade-card"
    >
      <button
        type="button"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1')
          setDismissed(true)
        }}
        title="Hide until the next launch"
        aria-label="Hide until the next launch"
        className="absolute top-1.5 right-1.5 h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] transition-colors"
        data-testid="upgrade-card-dismiss"
      >
        <Icon name="close" size={12} />
      </button>
      <div className="flex items-center gap-1.5 mb-1.5 pr-5">
        <Icon name="auto_awesome" size={14} className="text-[rgb(var(--accent))]" />
        <span className="text-[12px] font-semibold">{label}</span>
      </div>
      <button
        onClick={() => promptUpgrade(label)}
        className="w-full h-7 rounded-[8px] bg-[rgb(var(--accent))] text-white fb-t-label font-medium hover:bg-[rgb(var(--accent-hover))] fb-press shadow-[0_1px_2px_rgb(var(--accent)/0.25),inset_0_1px_0_rgb(255_255_255/0.15)]"
      >
        Upgrade Now
      </button>
    </div>
  )
}
