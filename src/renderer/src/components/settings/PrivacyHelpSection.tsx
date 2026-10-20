import { useState } from 'react'
import Icon from '../Icon'
import {
  crashReportsEnabled,
  setCrashReportsEnabled,
  setTelemetryEnabled,
  telemetryEnabled
} from '../../lib/telemetryPrefs'
import { HELP_BASE, PRICING_URL } from '../../lib/siteUrls'

// Privacy + Help. Both reporting switches are opt-in and start OFF: nothing is
// reported unless the person ticks a box here (lib/telemetryPrefs). Every
// sentence below is checked against docs/network-inventory.md, which lists each
// host the app contacts; change one and the other must change with it.

const PRIVACY_GUIDE = `${HELP_BASE}/settings-privacy`

// What leaves this computer, in the inventory's order. Plain facts, including
// the ones that are not flattering (icons via Google, no end-to-end encryption).
const LEAVES: string[] = [
  'Signed in, your rooms, desks, work widgets, tables, time blocks and files sync to your PlexiiDesk account, and your documents too while Documents sync is on. Sync is encrypted in transit but not end to end, so our server can read what it stores.',
  'Sharing, PlexiiChat, PlexiiCall and live desks go through our server to the people you include.',
  'AI on Plexii AI credits goes through our server to Anthropic. With your own key, requests go straight to Anthropic or OpenAI. Chat web search sends your question to DuckDuckGo unless you turn the globe off.',
  'Mail and calendars you connect talk straight to your provider.',
  'Icons for links and connected apps come from Google’s favicon service, which sees each site’s address. Map work widgets load map tiles from OpenStreetMap.',
  'The app checks dl.plexiidesk.com for updates.'
]

export default function PrivacyHelpSection(): JSX.Element {
  const [shareUsage, setShareUsage] = useState(telemetryEnabled())
  const [shareCrashes, setShareCrashes] = useState(crashReportsEnabled())

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-4" data-testid="settings-privacy">
      <div>
        <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-2">
          Privacy
        </div>
        <p className="mb-2.5 text-[12px] text-[var(--ink-70)] leading-relaxed" data-testid="privacy-reporting-default">
          Usage data and crash reports are off unless you turn them on. Each switch applies to this computer, takes
          effect at once, and sends only while you are signed in.
        </p>
        <div className="space-y-2.5">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={shareUsage}
              onChange={(e) => {
                setShareUsage(e.target.checked)
                setTelemetryEnabled(e.target.checked)
              }}
              data-testid="privacy-usage-toggle"
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span className="text-[12px] text-[var(--ink-70)] leading-relaxed">
              <span className="text-[var(--ink-90)] font-medium">Share usage data</span>
              <span className="block">
                A summary of counts sent to PlexiiDesk: your app version, Mac or Windows, how many work widgets of each
                type, desks and folders you have, focus sessions and minutes, AI requests with their tokens and estimated
                cost, and your onboarding progress. Never titles or contents.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={shareCrashes}
              onChange={(e) => {
                setShareCrashes(e.target.checked)
                setCrashReportsEnabled(e.target.checked)
              }}
              data-testid="privacy-crash-toggle"
              className="mt-0.5 h-4 w-4 accent-accent"
            />
            <span className="text-[12px] text-[var(--ink-70)] leading-relaxed">
              <span className="text-[var(--ink-90)] font-medium">Send crash reports</span>
              <span className="block">
                Details of errors the app recorded, sent to PlexiiDesk: the error message, where in the app it happened
                and your version. An error message can quote text that was on screen.
              </span>
            </span>
          </label>
        </div>
        <div className="mt-3 fb-t-caption text-[var(--ink-50)] leading-relaxed" data-testid="privacy-what-leaves">
          <p className="mb-1">
            Your work is saved on this computer first. The app has no third-party analytics or advertising trackers.
            What does leave this computer:
          </p>
          <ul className="list-disc pl-4 space-y-0.5">
            {LEAVES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <button
            onClick={() => void window.api.files.openExternal(PRIVACY_GUIDE)}
            data-testid="privacy-guide"
            className="mt-1.5 underline underline-offset-2 hover:text-accent transition-colors"
          >
            The full list, with how to turn each one off
          </button>
        </div>
      </div>

      <div>
        <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-2">
          Help &amp; support
        </div>
        <div className="space-y-1.5">
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('fb:onboarding-hub'))}
            data-testid="help-replay-onboarding"
            className="fb-btn-surface w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-field)] text-[12px] text-[var(--ink-70)] hover:border-accent hover:text-accent transition-colors"
          >
            <Icon name="explore" size={14} /> Take a tour / replay onboarding
          </button>
          <button
            onClick={() => void window.api.files.openExternal(HELP_BASE)}
            data-testid="help-guides"
            className="fb-btn-surface w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-field)] text-[12px] text-[var(--ink-70)] hover:border-accent hover:text-accent transition-colors"
          >
            <Icon name="help" size={14} /> Help &amp; guides
          </button>
          <button
            onClick={() => void window.api.files.openExternal(PRICING_URL)}
            data-testid="help-pricing"
            className="fb-btn-surface w-full inline-flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-field)] text-[12px] text-[var(--ink-70)] hover:border-accent hover:text-accent transition-colors"
          >
            <Icon name="sell" size={14} /> Plans &amp; pricing
          </button>
        </div>
        <p className="mt-2 fb-t-caption text-[var(--ink-50)] leading-relaxed">
          Stuck on something? The guides cover the common questions.
        </p>
      </div>
    </div>
  )
}
