import { useEffect, useState } from 'react'
import Icon from '../Icon'
import {
  crashReportsEnabled,
  setCrashReportsEnabled,
  setTelemetryEnabled,
  telemetryEnabled
} from '../../lib/telemetryPrefs'
import { pushPrivacyChoices } from '../../lib/privacyServer'
import { localOnlyMode, setLocalOnlyMode } from '../../lib/localOnlyMode'
import { useAccountStore } from '../../stores/account'
import { HELP_BASE, PRICING_URL } from '../../lib/siteUrls'

// Privacy + Help. Every switch here says what it sends and where, and the
// defaults are the private ones except update checks (on, and said so):
//
//   usage data, crash reports      off  (lib/telemetryPrefs; the server enforces it too)
//   check for updates              on   (main/privacyPrefs.ts → autoUpdate.ts)
//   background AI tasks            off  (main/privacyPrefs.ts → backgroundAiGate.ts)
//   keep this device local         off  (lib/localOnlyMode → workspaceSync, cloudDocsSync)
//
// Every sentence below is checked against docs/network-inventory.md, which lists
// each host the app contacts; change one and the other must change with it.

const PRIVACY_GUIDE = `${HELP_BASE}/settings-privacy`

// What leaves this computer, in the inventory's order. Plain facts, including
// the ones that are not flattering (no end-to-end encryption).
const LEAVES: string[] = [
  'Signed in, your rooms, desks, work widgets, tables, time blocks and files sync to your PlexiiDesk account, and your documents too while Documents sync is on, unless you keep this device local (below). Sync is encrypted in transit but not end to end, so our server can read what it stores.',
  'Sharing, PlexiiChat, PlexiiCall, live desks and workspaces you share with other people go through our server to the people you include.',
  'AI on Plexii AI credits goes through our server to Anthropic. With your own key, requests go straight to Anthropic or OpenAI when you use an AI feature, and in the background only if you turn on Background AI tasks. Chat web search sends your message to DuckDuckGo only while the globe in the chat is on; it starts off.',
  'Mail and calendars you connect talk straight to your provider.',
  'Icons for links and connected apps are fetched from the linked site itself and kept on this computer. Map work widgets load map tiles from OpenStreetMap. Fonts ship with the app.',
  'Update checks download a small version file from dl.plexiidesk.com (PlexiiOffice: GitHub), unless you turn them off.'
]

type UpdateKind = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'

function updateLine(kind: UpdateKind | null, version?: string): string | null {
  switch (kind) {
    case 'checking':
      return 'Checking…'
    case 'none':
      return 'You have the latest version.'
    case 'available':
    case 'ready':
      return version ? `Version ${version} is available.` : 'An update is available.'
    case 'downloading':
      return 'Downloading the update…'
    case 'error':
      return 'The check did not complete. Try again later.'
    default:
      return null
  }
}

function Switch({
  checked,
  onChange,
  testId,
  title,
  children
}: {
  checked: boolean
  onChange: (on: boolean) => void
  testId: string
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
        className="mt-0.5 h-4 w-4 accent-accent"
      />
      <span className="text-[12px] text-[var(--ink-70)] leading-relaxed">
        <span className="text-[var(--ink-90)] font-medium">{title}</span>
        <span className="block">{children}</span>
      </span>
    </label>
  )
}

export default function PrivacyHelpSection(): JSX.Element {
  const token = useAccountStore((s) => s.sessionToken)
  const accountId = useAccountStore((s) => s.account?.id ?? null)
  const [shareUsage, setShareUsage] = useState(telemetryEnabled())
  const [shareCrashes, setShareCrashes] = useState(crashReportsEnabled())
  // Main-process switches. Shown at their defaults until main answers.
  const [autoUpdates, setAutoUpdates] = useState(true)
  const [backgroundAi, setBackgroundAi] = useState(false)
  const [keepLocal, setKeepLocal] = useState(localOnlyMode())
  const [localNote, setLocalNote] = useState<string | null>(null)
  const [update, setUpdate] = useState<{ kind: UpdateKind; version?: string } | null>(null)

  useEffect(() => {
    let live = true
    void window.api?.privacy
      ?.getPrefs()
      .then((p) => {
        if (!live) return
        setAutoUpdates(p.autoUpdateChecks)
        setBackgroundAi(p.backgroundAi)
      })
      .catch(() => {})
    const off = window.api?.update?.onState?.((st) => {
      const v = (st as { version?: string }).version
      setUpdate({ kind: st.kind as UpdateKind, version: v })
    })
    return () => {
      live = false
      off?.()
    }
  }, [])

  function reportingChanged(): void {
    // The server enforces the same opt-in, so it is told at once.
    if (token) void pushPrivacyChoices(token, { force: true, accountKey: accountId ?? undefined })
  }

  function setMainPref(patch: { autoUpdateChecks?: boolean; backgroundAi?: boolean }): void {
    void window.api?.privacy
      ?.setPrefs(patch)
      .then((p) => {
        setAutoUpdates(p.autoUpdateChecks)
        setBackgroundAi(p.backgroundAi)
      })
      .catch(() => {})
  }

  async function changeKeepLocal(on: boolean): Promise<void> {
    if (on) {
      setLocalOnlyMode(true)
      setKeepLocal(true)
      setLocalNote(null)
      return
    }
    // Resuming: keep a copy of this computer's workspace first, because on
    // resume the other device's version wins where both changed an item.
    const snap = await window.api?.backup?.snapshotBeforeSyncResume?.().catch(() => null)
    if (!snap || !snap.ok) {
      setLocalNote(
        'Sync was not turned back on: a backup of this computer could not be saved first. Try again, or make a backup in Settings > Data > Backup.'
      )
      return
    }
    setLocalOnlyMode(false)
    setKeepLocal(false)
    const name = snap.path.split(/[\\/]/).pop()
    setLocalNote(`Sync resumed. A backup of this computer was saved first (${name}, in the backups folder).`)
  }

  const updateStatus = updateLine(update?.kind ?? null, update?.version)

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-soft)] space-y-4" data-testid="settings-privacy">
      <div>
        <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-2">
          Privacy
        </div>
        <p className="mb-2.5 text-[12px] text-[var(--ink-70)] leading-relaxed" data-testid="privacy-reporting-default">
          Usage data and crash reports are off unless you turn them on. Each switch applies to this computer and takes
          effect at once; reports are sent only while you are signed in, and our server refuses them from anyone who
          has not turned them on.
        </p>
        <div className="space-y-2.5">
          <Switch
            checked={shareUsage}
            onChange={(on) => {
              setShareUsage(on)
              setTelemetryEnabled(on)
              reportingChanged()
            }}
            testId="privacy-usage-toggle"
            title="Share usage data"
          >
            A summary of counts sent to PlexiiDesk: your app version, Mac or Windows, how many work widgets of each type,
            desks and folders you have, focus sessions and minutes, AI requests with their tokens and estimated cost, and
            your onboarding progress. Never titles or contents.
          </Switch>
          <Switch
            checked={shareCrashes}
            onChange={(on) => {
              setShareCrashes(on)
              setCrashReportsEnabled(on)
              reportingChanged()
            }}
            testId="privacy-crash-toggle"
            title="Send crash reports"
          >
            Details of errors the app recorded, sent to PlexiiDesk: the error message, where in the app it happened and
            your version. An error message can quote text that was on screen.
          </Switch>
          <div>
            <Switch
              checked={autoUpdates}
              onChange={(on) => {
                setAutoUpdates(on)
                setMainPref({ autoUpdateChecks: on })
              }}
              testId="privacy-updates-toggle"
              title="Check for updates automatically"
            >
              On by default. At launch, every 6 hours and when the computer wakes, the app downloads a small version file
              from dl.plexiidesk.com (PlexiiOffice: GitHub). The request carries no account or device identifier, only
              what any download reveals, such as your IP address. Off, you only hear about updates when you check.
            </Switch>
            <div className="pl-[26px] mt-1 flex items-center gap-2">
              <button
                onClick={() => {
                  setUpdate({ kind: 'checking' })
                  void window.api?.update?.check?.()
                }}
                data-testid="privacy-updates-check-now"
                className="fb-btn-surface inline-flex items-center gap-1 px-2 py-1 rounded-[var(--radius-field)] fb-t-caption text-[var(--ink-70)] hover:border-accent hover:text-accent transition-colors"
              >
                <Icon name="refresh" size={12} /> Check now
              </button>
              {updateStatus && (
                <span className="fb-t-caption text-[var(--ink-50)]" data-testid="privacy-updates-status">
                  {updateStatus}
                </span>
              )}
            </div>
          </div>
          <Switch
            checked={backgroundAi}
            onChange={(on) => {
              setBackgroundAi(on)
              setMainPref({ backgroundAi: on })
            }}
            testId="privacy-background-ai-toggle"
            title="Background AI tasks"
          >
            Off by default. On, the app sends your content to an AI provider without you asking each time, using your
            own API key: names for untitled items (up to 40 at each launch, the first 400 characters of each, to
            Anthropic), and search embeddings (the text of your documents and knowledge entries as they change, and your
            search questions, to OpenAI). Off, untitled items are named only from their own text and search matches
            words. Work a local model does on this computer is not affected by this switch.
          </Switch>
          <div>
            <Switch
              checked={keepLocal}
              onChange={(on) => void changeKeepLocal(on)}
              testId="privacy-keep-local-toggle"
              title="Keep this device local: don't sync"
            >
              Your personal workspace stops syncing: rooms, desks, work widgets, documents, tables, time blocks, files and
              synced preferences stay on this computer only, and changes from your other devices stop arriving here. You
              stay signed in for your plan. Workspaces and desks you share with other people, sharing, PlexiiChat,
              PlexiiCall and live desks still go through our server. What is already on our server stays there until you
              delete it (Account &gt; Delete my account and data).
            </Switch>
            {keepLocal && (
              <p
                className="pl-[26px] mt-1 fb-t-caption text-amber-700 dark:text-amber-400 leading-relaxed"
                data-testid="privacy-keep-local-warning"
              >
                Using more than one device? They will drift apart. When you turn sync back on, this computer&apos;s
                changes upload, and where an item also changed on another device, that device&apos;s version wins. A
                backup of this computer is saved first.
              </p>
            )}
            {localNote && (
              <p className="pl-[26px] mt-1 fb-t-caption text-[var(--ink-50)]" data-testid="privacy-keep-local-note">
                {localNote}
              </p>
            )}
          </div>
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
