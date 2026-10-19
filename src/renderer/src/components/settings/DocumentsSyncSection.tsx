import { useState } from 'react'
import { cloudDocsEnabled, setCloudDocsEnabled } from '@office'
import { useAccountStore } from '@runtime'

// Settings toggle for cloud-document sync. When on (the default) and signed in,
// documents sync to the account so they're available in PlexiDesk, the
// standalone PlexiOffice app, and the mobile web app. Unticking opts out;
// documents are then local-only.
export default function DocumentsSyncSection(): JSX.Element {
  const [on, setOn] = useState(() => cloudDocsEnabled())
  const signedIn = !!useAccountStore((s) => s.sessionToken)

  function toggle(next: boolean): void {
    setCloudDocsEnabled(next)
    setOn(next)
  }

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-2">
      <div className="fb-t-caption uppercase tracking-wider text-[var(--ink-40)]">Documents sync</div>
      <label className="flex items-center justify-between py-1 cursor-pointer">
        <span className="text-xs text-[var(--ink-70)]">
          Sync documents to your account <span className="text-[var(--ink-40)]">(on by default)</span>
        </span>
        <input
          type="checkbox"
          data-testid="settings-clouddocs-toggle"
          checked={on}
          onChange={(e) => toggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-accent cursor-pointer"
        />
      </label>
      <p className="fb-t-caption text-[var(--ink-50)] leading-relaxed">
        {on
          ? signedIn
            ? 'Your documents sync across PlexiiDesk and PlexiiOffice. Local copies stay on this device too.'
            : 'Sign in above to start syncing — until then documents stay on this device.'
          : 'Documents are stored only on this device. Turn on to make them available in PlexiiOffice and on your other devices.'}
      </p>
    </div>
  )
}
