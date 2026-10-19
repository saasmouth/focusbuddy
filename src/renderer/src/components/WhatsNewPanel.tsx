import { useEffect, useRef } from 'react'
import {
  CHANGELOG,
  formatAbsoluteDate,
  formatRelativeTime,
  markChangelogSeen
} from '../lib/changelog'
import Icon from './Icon'

interface Props {
  onClose: () => void
}

const TAG_STYLES: Record<string, { label: string; cls: string }> = {
  feature: {
    label: 'New',
    cls: 'bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300'
  },
  polish: {
    label: 'Polish',
    cls: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
  },
  fix: {
    label: 'Fix',
    cls: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400'
  },
  design: {
    label: 'Design',
    cls: 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400'
  }
}

export default function WhatsNewPanel({ onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    markChangelogSeen()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fb-scrim fixed inset-0 z-[180] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        className="fb-card fb-press w-full max-w-lg mx-4 overflow-hidden flex flex-col max-h-[85vh]"
      >
        <div className="px-5 py-4 border-b border-[var(--edge-soft)] flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2">
            <Icon name="auto_awesome" size={18} className="text-accent" />
            <h3 className="text-base font-semibold text-[var(--ink-100)]">
              What's new in PlexiiDesk
            </h3>
          </div>
          <button onClick={onClose} className="icon-btn" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-5">
          {CHANGELOG.map((entry, i) => {
            const tag = entry.tag ? TAG_STYLES[entry.tag] : null
            return (
              <article key={`${entry.date}-${i}`} className="relative">
                {/* Timeline dot */}
                <div className="absolute -left-1 top-1.5 w-2 h-2 rounded-full bg-accent" />
                <div className="pl-4 border-l-2 border-[var(--edge-soft)] ml-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    {tag && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${tag.cls}`}>
                        {tag.label}
                      </span>
                    )}
                    <span
                      className="text-[11px] text-[var(--ink-50)] font-mono"
                      title={new Date(entry.date).toLocaleString()}
                    >
                      {formatAbsoluteDate(entry.date)}
                      <span className="ml-1.5 text-[var(--ink-40)]">
                        · {formatRelativeTime(entry.date)}
                      </span>
                    </span>
                  </div>
                  <h4 className="text-sm font-semibold text-[var(--ink-100)] mb-2">
                    {entry.title}
                  </h4>
                  <ul className="space-y-1.5">
                    {entry.highlights.map((h, hi) => (
                      <li
                        key={hi}
                        className="text-[13px] text-[var(--ink-70)] leading-relaxed flex gap-2"
                      >
                        <Icon
                          name="arrow_right"
                          size={14}
                          className="text-[var(--ink-40)] mt-0.5 shrink-0"
                        />
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            )
          })}
        </div>

        <div className="px-5 py-3 border-t border-[var(--edge-soft)] bg-[var(--surface-sunken)] text-[11px] text-[var(--ink-50)] shrink-0 flex justify-between items-center">
          <span>You're up to date.</span>
          <button onClick={onClose} className="btn-ghost">
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
