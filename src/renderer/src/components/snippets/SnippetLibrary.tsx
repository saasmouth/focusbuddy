import { useEffect, useMemo, useState } from 'react'
import {
  ORG_SNIPPET_REACH_NOTE,
  ORG_SNIPPETS_SYNC,
  snippetKindIcon,
  snippetKindLabel,
  snippetSummary,
  SNIPPET_KINDS,
  type Snippet,
  type SnippetKind,
  type SnippetLink,
  type SnippetScope
} from '@shared/snippets'
import Icon from '../Icon'
import { useSnippetsStore } from '../../stores/snippets'
import { useOrgStore, PERSONAL_ORG_ID } from '../../stores/org'

// The saved-snippets library: what the user has kept, and what their
// organisation shares.
//
// Two tabs, because the two are genuinely different things rather than one list
// with a label. "Mine" is the user's own reusable assets. "Organisation" is the
// shared library everyone in the workspace draws on — visible because the user
// is in that org, which is what being invited amounts to. In the personal
// workspace there is no one to share with, so the Organisation tab says so
// instead of showing an empty list that looks like a fault.
//
// Inserting asks for the link mode, and only offers the modes the destination
// can really honour: a surface that cannot resolve a reference at render time
// offers Duplicate alone rather than a Live option that would quietly become a
// copy.

export interface SnippetLibraryProps {
  /** Restrict the list to kinds the caller can use. Omitted shows everything. */
  kinds?: SnippetKind[]
  /** Pre-selected destination; otherwise the user picks from the open targets. */
  targetId?: string
  onClose: () => void
}

export default function SnippetLibrary({ kinds, targetId, onClose }: SnippetLibraryProps): JSX.Element {
  const { snippets, loading, error, refresh, remove, fork, insert, targetsFor } = useSnippetsStore()
  const [tab, setTab] = useState<SnippetScope>('personal')
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState<SnippetKind | 'all'>('all')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Which workspace we are in decides whether an Organisation tab is meaningful
  // at all. Read it from the org store rather than inferring from an empty
  // list, so "no shared library here" and "nothing shared yet" stay distinct.
  const activeOrgId = useOrgStore((s) => s.activeOrgId)

  useEffect(() => {
    void refresh(kinds?.length ? { kinds } : undefined)
  }, [refresh, kinds])

  const inPersonalWorkspace = activeOrgId === PERSONAL_ORG_ID

  // Only offer kinds the user can actually act on: the caller's restriction if
  // it gave one, otherwise the kinds that are really in the library. Listing a
  // kind that nothing can hold — or that nobody has saved — advertises a
  // capability the UI cannot honour, and a filter that always returns nothing
  // reads as a fault rather than as an empty category.
  const offerableKinds = useMemo(() => {
    if (kinds?.length) return kinds
    const present = new Set(snippets.map((s) => s.kind))
    return SNIPPET_KINDS.filter((k) => present.has(k))
  }, [kinds, snippets])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return snippets.filter((s) => {
      if (s.scope !== tab) return false
      if (kinds?.length && !kinds.includes(s.kind)) return false
      if (kindFilter !== 'all' && s.kind !== kindFilter) return false
      if (!needle) return true
      const body = s.body.kind === 'doc' ? s.body.text : ''
      return [s.name, s.description, s.tags.join(' '), body].join(' ').toLowerCase().includes(needle)
    })
  }, [snippets, tab, kinds, kindFilter, query])

  async function doInsert(s: Snippet, link: SnippetLink): Promise<void> {
    const candidates = targetsFor(s)
    const chosen = targetId ? candidates.find((t) => t.id === targetId) : candidates[0]
    if (!chosen) {
      setNotice(`Nothing open can take a ${snippetKindLabel(s.kind).toLowerCase()} right now.`)
      return
    }
    setBusy(s.id)
    const ok = await insert(s, link, chosen.id)
    setBusy(null)
    if (ok) {
      setNotice(`Inserted into ${chosen.label}${link === 'live' ? ' as a live instance' : ''}.`)
      onClose()
    } else {
      setNotice(useSnippetsStore.getState().error ?? 'The snippet was not inserted.')
    }
  }

  return (
    <div className="fb-scrim fixed inset-0 z-[60] flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="fb-card flex max-h-[80vh] w-[min(720px,calc(100vw-32px))] flex-col p-4"
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="snippet-library"
      >
        <div className="mb-3 flex items-center gap-2">
          <Icon name="bookmarks" size={17} className="text-accent" />
          <h3 className="text-[14px] font-semibold text-[var(--ink-90)]">Saved snippets</h3>
          <button onClick={onClose} className="ml-auto icon-btn" aria-label="Close" data-testid="snippet-library-close">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="mb-2 flex items-center border-b border-[var(--edge-soft)]">
          {(['personal', 'org'] as SnippetScope[]).map((s) => (
            <button
              key={s}
              onClick={() => setTab(s)}
              data-testid={`snippet-tab-${s}`}
              aria-selected={tab === s}
              className={`border-b-2 px-3 py-1.5 text-[12px] font-medium ${
                tab === s
                  ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))]'
                  : 'border-transparent text-[var(--ink-60)] hover:text-[var(--ink-90)]'
              }`}
            >
              {s === 'personal' ? 'Mine' : 'Organisation'}
            </button>
          ))}
        </div>

        <div className="mb-2 flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, tags or contents…"
            className="fb-field flex-1 px-2 py-1 text-[12px]"
            data-testid="snippet-search"
          />
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as SnippetKind | 'all')}
            className="fb-field px-1 py-1 text-[11px]"
            aria-label="Filter by kind"
            data-testid="snippet-kind-filter"
          >
            <option value="all">All kinds</option>
            {offerableKinds.map((k) => (
              <option key={k} value={k}>
                {snippetKindLabel(k)}
              </option>
            ))}
          </select>
        </div>

        {/*
          The Organisation tab says what these snippets actually reach. Until
          workspace sync carries snippets, they are on this computer, and a tab
          labelled "Organisation" would otherwise imply teammates see them.
        */}
        {tab === 'org' && !inPersonalWorkspace && !ORG_SNIPPETS_SYNC && (
          <div
            className="mb-2 flex items-start gap-1.5 rounded-[var(--radius-row)] bg-[var(--surface-sunken)] px-2 py-1.5 text-[11px] text-[var(--ink-60)]"
            data-testid="snippet-org-reach"
          >
            <Icon name="info" size={13} className="mt-0.5 shrink-0 text-[var(--ink-40)]" />
            <span>{ORG_SNIPPET_REACH_NOTE}</span>
          </div>
        )}

        {error && (
          <div className="mb-2 text-[12px] text-red-600 dark:text-red-400" data-testid="snippet-library-error">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-2 text-[12px] text-[var(--ink-60)]" data-testid="snippet-library-notice">
            {notice}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center gap-2 px-1 py-6 text-[12px] text-[var(--ink-50)]">
              <Icon name="autorenew" size={14} className="animate-spin" /> Loading…
            </div>
          ) : tab === 'org' && inPersonalWorkspace ? (
            <div
              className="rounded-[var(--radius-card)] border border-dashed border-[var(--edge-firm)] p-6 text-center text-[12px] text-[var(--ink-50)]"
              data-testid="snippet-org-unavailable"
            >
              You are in your personal workspace, so there is no shared library here.
              <span className="mt-1 block text-[11px] text-[var(--ink-40)]">
                Join or switch to an organisation to see and use its snippets.
              </span>
            </div>
          ) : visible.length === 0 ? (
            <div
              className="rounded-[var(--radius-card)] border border-dashed border-[var(--edge-firm)] p-6 text-center text-[12px] text-[var(--ink-50)]"
              data-testid="snippet-empty"
            >
              {query.trim()
                ? 'Nothing matches that search.'
                : tab === 'personal'
                  ? 'No saved snippets yet. Select something and choose "Save as snippet".'
                  : 'This organisation has no shared snippets yet.'}
            </div>
          ) : (
            <ul className="space-y-1.5" data-testid="snippet-list">
              {visible.map((s) => (
                <SnippetRow
                  key={s.id}
                  snippet={s}
                  busy={busy === s.id}
                  canInsertLive={targetsFor(s).some((t) => t.supports.includes('live'))}
                  canInsertDuplicate={targetsFor(s).some((t) => t.supports.includes('duplicate'))}
                  onInsert={doInsert}
                  onFork={async () => {
                    const copy = await fork(s.id)
                    if (copy) {
                      setNotice(`Copied "${s.name}" into your own snippets.`)
                      setTab('personal')
                    }
                  }}
                  onDelete={async () => {
                    const ok = await remove(s.id)
                    if (ok) setNotice(`Deleted "${s.name}". Any live instances of it will now show as missing.`)
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function SnippetRow({
  snippet,
  busy,
  canInsertLive,
  canInsertDuplicate,
  onInsert,
  onFork,
  onDelete
}: {
  snippet: Snippet
  busy: boolean
  canInsertLive: boolean
  canInsertDuplicate: boolean
  onInsert: (s: Snippet, link: SnippetLink) => void
  onFork: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <li
      className="flex items-start gap-2.5 rounded-[var(--radius-row)] border border-[var(--edge-soft)] px-2.5 py-2"
      data-testid="snippet-row"
      data-snippet-id={snippet.id}
    >
      <Icon name={snippetKindIcon(snippet.kind)} size={16} className="mt-0.5 shrink-0 text-[var(--ink-40)]" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-[var(--ink-90)]">{snippet.name}</span>
          <span className="shrink-0 rounded-full bg-[var(--surface-sunken)] px-1.5 text-[10px] text-[var(--ink-50)]">
            {snippetKindLabel(snippet.kind)}
          </span>
          {snippet.usageCount > 0 && (
            <span className="shrink-0 text-[10px] text-[var(--ink-40)]" title="Times inserted">
              used {snippet.usageCount}×
            </span>
          )}
        </div>
        <div className="truncate text-[11px] text-[var(--ink-50)]">{snippetSummary(snippet)}</div>
        {snippet.tags.length > 0 && (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {snippet.tags.map((t) => (
              <span key={t} className="rounded bg-[var(--surface-sunken)] px-1 text-[10px] text-[var(--ink-50)]">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Only the modes a destination can really honour are offered. */}
        {canInsertDuplicate && (
          <button
            onClick={() => onInsert(snippet, 'duplicate')}
            disabled={busy}
            className="fb-btn-surface px-2 py-1 text-[11px] disabled:opacity-50"
            title="Insert an editable copy. Later changes to the saved snippet will not affect it."
            data-testid="snippet-insert-duplicate"
          >
            Duplicate
          </button>
        )}
        {canInsertLive && (
          <button
            onClick={() => onInsert(snippet, 'live')}
            disabled={busy}
            className="btn-primary px-2 py-1 text-[11px] disabled:opacity-50"
            title="Insert a live instance. It updates everywhere when the saved snippet changes."
            data-testid="snippet-insert-live"
          >
            Live
          </button>
        )}
        {snippet.scope === 'org' && (
          <button
            onClick={onFork}
            className="icon-btn !h-7 !w-7"
            title="Copy into my snippets so I can change it"
            aria-label="Copy into my snippets"
            data-testid="snippet-fork"
          >
            <Icon name="file_copy" size={14} />
          </button>
        )}
        <button
          onClick={onDelete}
          className="icon-btn !h-7 !w-7"
          title="Delete this snippet"
          aria-label={`Delete ${snippet.name}`}
          data-testid="snippet-delete"
        >
          <Icon name="delete" size={14} />
        </button>
      </div>
    </li>
  )
}
