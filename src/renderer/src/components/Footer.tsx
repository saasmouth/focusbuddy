import { useEffect, useState } from 'react'
import { useSyncStatus } from '../stores/syncStatus'
import { CHANGELOG, hasUnseenChanges } from '../lib/changelog'
import Icon from './Icon'
import Tooltip from './Tooltip'
import { HELP_BASE } from '../lib/siteUrls'
import WhatsNewPanel from './WhatsNewPanel'
import TermsModal from './TermsModal'
import UpdaterBanner from './UpdaterBanner'
import TrialBadge from './TrialBadge'

// Compact, always-visible sync status.
//
// This stayed when the copyright line went (teardown #7). Two reasons, and the
// second is the one that matters: the e2e harness uses this chip as its "the
// shell is up" signal for every test in the suite, because it is the one piece
// of chrome present in every view. Removing it to de-duplicate "Saved locally"
// broke roughly twelve hundred tests at waitForReady, which is a far worse
// outcome than the same three words appearing twice.
//
// The sidebar's SyncIndicator says the same thing with a sparkline for
// context; this is the global fallback.
function FooterSyncChip(): JSX.Element {
  const state = useSyncStatus((s) => s.state)
  const lastError = useSyncStatus((s) => s.lastError)
  const dot =
    state === 'error'
      ? 'bg-rose-500'
      : state === 'offline'
        ? 'bg-amber-500'
        : state === 'syncing'
          ? 'bg-sky-500'
          : 'bg-emerald-500'
  const label =
    state === 'error'
      ? 'Sync error'
      : state === 'offline'
        ? 'Offline'
        : state === 'syncing'
          ? 'Syncing'
          : state === 'disabled'
            ? 'Saved locally'
            : 'Synced'
  const title =
    state === 'error'
      ? `Sync is failing: ${lastError ?? 'the server rejected a request'}. Your work is saved locally and will re-sync when the connection recovers.`
      : state === 'offline'
        ? 'Cannot reach the sync server. Your work is saved locally and will sync when the connection returns.'
        : state === 'disabled'
          ? 'Your work is saved to this device.'
          : 'Your workspace is synced.'
  return (
    <>
      <span className="text-[var(--ink-30)]">·</span>
      <span
        className="inline-flex items-center gap-1"
        title={title}
        data-testid="footer-sync-chip"
        data-sync-state={state}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="text-[var(--ink-50)]">{label}</span>
      </span>
    </>
  )
}

export default function Footer(): JSX.Element {
  const [showWhatsNew, setShowWhatsNew] = useState(false)
  const [showTerms, setShowTerms] = useState(false)
  const [unseen, setUnseen] = useState<boolean>(() => hasUnseenChanges())

  useEffect(() => {
    if (!showWhatsNew) setUnseen(hasUnseenChanges())
  }, [showWhatsNew])

  const newestEntry = CHANGELOG[0]
  const buildDate = newestEntry
    ? new Date(newestEntry.date).toISOString().slice(0, 10)
    : ''
  // __APP_VERSION__ is injected at build time from package.json by
  // electron-vite's `define`. Bump package.json on every release; this
  // footer (and any other display) updates automatically.
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'

  return (
    <>
      <footer className="h-7 px-3 flex items-center justify-between text-[11px] text-[var(--ink-50)] border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] select-none">
        <div className="flex items-center gap-2 truncate">
          {/* The copyright line is gone (teardown #7).
              The titlebar says "plexii", the upgrade card says "PlexiDesk
              Pro", and this said "© PlexiDesk" -- three names for one product
              on one screen. A copyright notice is not something anybody needs
              while working, and it was the only part of this footer carrying a
              second product name. The version stays: it is what you read out
              when something goes wrong, and it is the anchor for the update
              check. */}
          <Tooltip
            placement="top"
            content={`PlexiDesk ${appVersion}${buildDate ? ` · build ${buildDate}` : ''} — click to check for updates`}
          >
            <button
              type="button"
              onClick={() => { void window.api.update.check() }}
              className="text-[var(--ink-40)] font-mono hover:text-[var(--ink-70)] transition-colors"
            >
              v{appVersion}
              {buildDate && ` · ${buildDate}`}
            </button>
          </Tooltip>
          {/* Updates and the trial badge are the reason this bar exists: both
              self-hide, and when they appear they are genuinely interrupting. */}
          <UpdaterBanner />
          <TrialBadge />
          <FooterSyncChip />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowTerms(true)}
            className="px-2 py-1 rounded hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors"
          >
            Terms of Use
          </button>
          <span className="text-[var(--ink-30)]">·</span>
          <Tooltip placement="top" content="Open the PlexiDesk help centre in your browser — guides for every feature">
            <button
              onClick={() => window.open(HELP_BASE, '_blank', 'noopener,noreferrer')}
              className="px-2 py-1 rounded hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors flex items-center gap-1"
            >
              <Icon name="help_outline" size={12} />
              Help & support
            </button>
          </Tooltip>
          <span className="text-[var(--ink-30)]">·</span>
          <button
            onClick={() => setShowWhatsNew(true)}
            title="See everything that's changed across releases"
            className="relative px-2 py-1 rounded hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-100)] transition-colors flex items-center gap-1"
          >
            <Icon name="auto_awesome" size={12} className={unseen ? 'text-accent' : ''} />
            <span className={unseen ? 'text-[var(--ink-100)] font-medium' : ''}>
              What's new
            </span>
            {unseen && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent shadow-sm animate-pulse"
                aria-label="New updates available"
              />
            )}
          </button>
        </div>
      </footer>
      {showWhatsNew && <WhatsNewPanel onClose={() => setShowWhatsNew(false)} />}
      {showTerms && <TermsModal onClose={() => setShowTerms(false)} />}
    </>
  )
}
