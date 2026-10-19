import { useEffect } from 'react'
import Icon from './Icon'
import PlexiiMark from './brand/PlexiiMark'
import { markReleaseSeen, type ChangelogEntry } from '../lib/changelog'

// First-run "What's new in vX.Y.Z" modal. Shown once per version on the first
// launch after an update (see getPendingReleaseEntry). Summarises the release
// and links to the help-centre articles for the new features. Dismissing it
// records the version as seen so it never reappears for this version.

interface Props {
  entry: ChangelogEntry
  onClose: () => void
}

function openHelp(href: string): void {
  // Open the support page in the user's browser, not inside the app shell.
  try {
    void window.api.files.openExternal(href)
  } catch {
    // best effort — never block dismissing the modal
  }
}

export default function ReleaseModal({ entry, onClose }: Props): JSX.Element {
  useEffect(() => {
    markReleaseSeen(entry.version)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [entry.version, onClose])

  const versionLabel = entry.version ? `v${entry.version}` : ''

  return (
    <div
      className="fb-scrim fixed inset-0 z-[200] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="fb-card flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`What's new in PlexiiDesk ${versionLabel}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-[var(--edge-soft)] px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-accent">
              <PlexiiMark height={14} motion="once" title={null} />
              Updated {versionLabel}
            </div>
            <h2 className="mt-1 text-lg font-semibold text-[var(--ink-100)]">
              What&apos;s new
            </h2>
          </div>
          <button
            onClick={onClose}
            className="icon-btn"
            aria-label="Close"
            title="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {entry.summary && (
            <p className="text-sm leading-relaxed text-[var(--ink-70)]">{entry.summary}</p>
          )}

          <ul className="mt-4 space-y-2.5">
            {entry.highlights.map((h, i) => (
              <li key={i} className="flex gap-2.5 text-sm text-[var(--ink-70)]">
                <Icon name="check_circle" size={16} className="mt-0.5 shrink-0 text-accent" />
                <span className="leading-snug">{h}</span>
              </li>
            ))}
          </ul>

          {entry.links && entry.links.length > 0 && (
            <div className="mt-5">
              <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--ink-40)]">
                Learn more
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {entry.links.map((l) => (
                  <button
                    key={l.href}
                    onClick={() => openHelp(l.href)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent/10"
                  >
                    {l.label}
                    <Icon name="open_in_new" size={13} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-[var(--edge-soft)] px-5 py-3">
          <button onClick={onClose} className="btn-primary text-sm">
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}
