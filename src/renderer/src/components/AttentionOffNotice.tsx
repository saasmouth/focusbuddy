// "Attention is off on this device" — shown where work items would be
// created, before anyone tries, once the capability is known to be off.
// The Attention layer ships off; its switch is in Settings → AI.
export default function AttentionOffNotice({ what = 'save this as a work item', className = '' }: { what?: string; className?: string }): JSX.Element {
  return (
    <div
      className={`fb-t-caption text-[var(--ink-70)] leading-snug rounded-[var(--radius-field)] border border-[var(--edge-soft)] px-2.5 py-1.5 ${className}`}
      data-testid="attention-off-notice"
      role="note"
    >
      Attention is off on this device, so Plexii can’t {what}.{' '}
      <button
        type="button"
        className="underline text-[var(--ink-100)]"
        onClick={() => window.dispatchEvent(new CustomEvent('fb:open-settings', { detail: { tab: 'ai' } }))}
      >
        Turn on Attention in Settings
      </button>
    </div>
  )
}
