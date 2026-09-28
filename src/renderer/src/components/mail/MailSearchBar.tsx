import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import type { MailCoverage, MailSearchFilter, MailSearchResultItem } from '@shared/types'

// Finding an email.
//
// Before this there was no way to find one at all: no text search, no filters. Not
// a missing widget — a missing capability, in the app whose whole job is the thing.
//
// It searches the LOCAL store rather than the mail server. That is not a shortcut:
// the store carries the body and the text extracted from attachments, so this finds
// a message by a phrase buried in a PDF, which an IMAP SEARCH cannot do. It is also
// instant, and works with no connection.
//
// The cost is that the store only covers what the sweep has read, which is why
// every result set reports its coverage. A search over 200 of 4,000 messages that
// presents itself as a search of the mailbox is the same class of lie as an empty
// state pretending to be a real one.

/** Filters worth a single tap. Anything rarer belongs in a saved tag. */
const QUICK: Array<{ key: keyof MailSearchFilter; label: string; icon: string }> = [
  { key: 'unreadOnly', label: 'Unread', icon: 'mark_email_unread' },
  { key: 'flaggedOnly', label: 'Flagged', icon: 'flag' },
  { key: 'withAttachments', label: 'Has file', icon: 'attach_file' }
]

const WINDOWS: Array<{ days: number | null; label: string }> = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 365, label: 'Year' },
  { days: null, label: 'Any time' }
]

function coverageLine(c: MailCoverage, count: number): string {
  if (!c.connected) return 'No mailbox connected.'
  const back =
    c.oldestDate && !c.headersComplete
      ? ` back to ${new Date(c.oldestDate).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`
      : ''
  const scope = c.headersComplete
    ? `all ${c.messages.toLocaleString()} messages`
    : `${c.messages.toLocaleString()} messages${back}`
  const found = `${count} ${count === 1 ? 'match' : 'matches'}`
  // Named plainly when the sweep is still running: the honest reading of "no
  // matches" is different when there is mail nobody has read yet.
  const more = c.headersComplete ? '' : ' · still reading older mail'
  return `${found} in ${scope}${more}`
}

export default function MailSearchBar({
  onResults
}: {
  /** null results mean "not searching" — show the live mailbox instead. */
  onResults: (items: MailSearchResultItem[] | null, coverage: MailCoverage | null) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<MailSearchFilter>({})
  const [coverage, setCoverage] = useState<MailCoverage | null>(null)
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const active = useMemo(() => {
    const f = filter
    return (
      query.trim().length > 0 ||
      !!f.unreadOnly ||
      !!f.flaggedOnly ||
      !!f.withAttachments ||
      (f.sinceDays ?? null) !== null ||
      !!f.from?.length
    )
  }, [query, filter])

  // Debounced, and every run is tagged so a slow earlier search cannot overwrite a
  // newer one's results — typing fast otherwise leaves the list showing the answer
  // to a prefix of what was asked.
  const runId = useRef(0)
  useEffect(() => {
    if (!active) {
      runId.current += 1
      setCoverage(null)
      setError(null)
      onResults(null, null)
      return
    }
    const mine = ++runId.current
    setBusy(true)
    const t = setTimeout(() => {
      void window.api.mail
        .searchStored(query, filter, { limit: 200 })
        .then((r) => {
          if (mine !== runId.current) return
          if (!r.ok) {
            setError(r.error)
            onResults([], null)
            return
          }
          setError(null)
          setCoverage(r.coverage)
          setCount(r.items.length)
          onResults(r.items, r.coverage)
        })
        .catch((e: Error) => {
          if (mine !== runId.current) return
          setError(e.message)
        })
        .finally(() => {
          if (mine === runId.current) setBusy(false)
        })
    }, 180)
    return () => clearTimeout(t)
    // onResults is a stable callback from the parent; including it would re-run the
    // search on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filter, active])

  const toggle = (key: keyof MailSearchFilter): void =>
    setFilter((f) => ({ ...f, [key]: f[key] ? undefined : true }))

  const clear = (): void => {
    setQuery('')
    setFilter({})
  }

  const chip = (on: boolean): string =>
    `px-2 py-0.5 rounded-full fb-t-caption border transition-colors ${
      on
        ? 'bg-accent/15 border-accent/50 text-accent'
        : 'border-[var(--edge-soft)] text-[var(--ink-60)] hover:text-[var(--ink-100)]'
    }`

  return (
    <div className="px-3 pt-2 pb-2 border-b border-[var(--edge-soft)] flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Icon
            name={busy ? 'progress_activity' : 'search'}
            size={14}
            className={`absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-60)] ${busy ? 'animate-spin' : ''}`}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sender, subject, body, attachments"
            data-testid="mail-search-input"
            aria-label="Search mail"
            className="w-full pl-7 pr-7 py-1 rounded-md bg-[var(--surface-2)] border border-[var(--edge-soft)] fb-t-caption text-[var(--ink-100)] placeholder:text-[var(--ink-60)] focus:outline-none focus:border-accent/60"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--ink-60)] hover:text-[var(--ink-100)]"
              title="Clear the search text"
              aria-label="Clear search text"
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`icon-btn ${showFilters ? 'text-accent' : ''}`}
          title="Filters"
          aria-label="Filters"
          aria-expanded={showFilters}
          data-testid="mail-search-filters-toggle"
        >
          <Icon name="filter_list" size={15} />
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-1" data-testid="mail-search-filters">
          {QUICK.map((q) => (
            <button
              key={q.key}
              onClick={() => toggle(q.key)}
              className={chip(!!filter[q.key])}
              aria-pressed={!!filter[q.key]}
            >
              {q.label}
            </button>
          ))}
          <span className="w-px h-4 bg-[var(--edge-soft)] mx-1" aria-hidden />
          {WINDOWS.map((w) => (
            <button
              key={w.label}
              onClick={() => setFilter((f) => ({ ...f, sinceDays: w.days }))}
              className={chip((filter.sinceDays ?? null) === w.days && w.days !== null)}
              aria-pressed={(filter.sinceDays ?? null) === w.days}
            >
              {w.label}
            </button>
          ))}
        </div>
      )}

      {/* Coverage, not just a count. What was NOT searched is the part a user
          cannot infer and would otherwise be misled by. */}
      {active && (
        <div className="flex items-center gap-2 fb-t-caption text-[var(--ink-60)]">
          <span className="truncate" data-testid="mail-search-coverage">
            {error ? error : coverage ? coverageLine(coverage, count) : 'Searching…'}
          </span>
          <button
            onClick={clear}
            className="ml-auto shrink-0 underline hover:text-[var(--ink-100)]"
            data-testid="mail-search-clear"
          >
            Clear
          </button>
        </div>
      )}
    </div>
  )
}
