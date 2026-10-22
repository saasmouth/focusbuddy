import { useEffect, useState } from 'react'
import Icon from '../Icon'
import PlexiiIcon from '../PlexiiIcon'
import BrainBulkAdd from '../brain/BrainBulkAdd'
import MemoryPanel from '../brain/MemoryPanel'
import { useKnowledgeStore } from '../../stores/knowledge'
import { useViewStore } from '../../stores/view'
import type { KnowledgeEntry } from '@shared/knowledge'

// PlexiBrain: the company knowledge base. People curate entries here and the AI
// grounds its answers in them. Reads only real entries; an empty brain shows an
// honest empty state, never sample knowledge.

function snippet(body: string, n = 120): string {
  const s = body.replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

export default function KnowledgeView(): JSX.Element {
  const entries = useKnowledgeStore((s) => s.entries)
  const loaded = useKnowledgeStore((s) => s.loaded)
  const load = useKnowledgeStore((s) => s.load)
  const createEntry = useKnowledgeStore((s) => s.create)
  const updateEntry = useKnowledgeStore((s) => s.update)
  const removeEntry = useKnowledgeStore((s) => s.remove)

  // When the view was opened with a specific entry (e.g. from PlexiSearch), start
  // on that entry. Reads the route once on mount via the store's current value.
  const routedEntryId = useViewStore((s) => (s.view.kind === 'knowledge' ? s.view.entryId : undefined))

  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(routedEntryId ?? null)
  // Search hits from the main process (semantic + keyword blended). null = no
  // active search, so the full list shows.
  const [searchHits, setSearchHits] = useState<KnowledgeEntry[] | null>(null)

  useEffect(() => {
    void load()
    // Backfill embeddings so search ranks by meaning. Best-effort and silent:
    // with no embedding key it is a no-op and search stays keyword-based.
    void window.api.knowledge.reindex()
  }, [load])

  // Follow a later deep-link (open PlexiSearch again on a different entry).
  useEffect(() => {
    if (routedEntryId) setSelectedId(routedEntryId)
  }, [routedEntryId])

  // Debounced search through the main process so results rank by meaning when a
  // key is set, and by keyword otherwise. An empty query shows everything.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSearchHits(null)
      return
    }
    const id = setTimeout(() => {
      void window.api.knowledge
        .search(q)
        .then(setSearchHits)
        .catch(() => setSearchHits([]))
    }, 200)
    return () => clearTimeout(id)
  }, [query])

  const filtered = searchHits ?? entries

  const selected = entries.find((e) => e.id === selectedId) ?? null

  async function addEntry(): Promise<void> {
    const created = await createEntry({ title: 'New entry', body: '', tags: [] })
    if (created) setSelectedId(created.id)
  }

  return (
    <div className="h-full w-full flex bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexibrain-view">
      {/* List */}
      <div className="w-[320px] shrink-0 border-r border-[var(--edge-soft)] flex flex-col">
        <div className="px-4 py-3.5 border-b border-[var(--edge-soft)]">
          <div className="flex items-center gap-2">
            <PlexiiIcon kind="app" id="plexibrain" size={20} fallback="neurology" fallbackFilled fallbackClassName="text-violet-500" className="shrink-0" />
            <h1 className="text-[15px] font-bold tracking-tight text-[var(--ink-100)]">PlexiiBrain</h1>
          </div>
          <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)]">
            Your company's shared memory. People and AI read from it.
          </p>
        </div>
        <div className="px-3 py-2.5 flex items-center gap-2">
          <div className="fb-card flex-1 flex items-center gap-1.5 px-2 py-1.5">
            <Icon name="search" size={14} className="text-[var(--ink-70)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search knowledge"
              data-testid="brain-search"
              className="flex-1 bg-transparent text-[12px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
            />
          </div>
          <button
            onClick={() => void addEntry()}
            data-testid="brain-new"
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md bg-[rgb(var(--accent))] text-white text-[11.5px] font-medium hover:bg-[rgb(var(--accent-hover))]"
            title="New knowledge entry"
          >
            <Icon name="add" size={14} /> New
          </button>
        </div>

        {/* Bulk-add files & folders straight into the Brain (independent of desks). */}
        <BrainBulkAdd />

        {/* Self-building memory: what the assistant durably knows about the user. */}
        <MemoryPanel />

        <div className="flex-1 overflow-auto px-2 pb-2">
          {loaded && filtered.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <Icon name="psychology_alt" size={26} className="text-[var(--ink-30)]" />
              <p className="mt-2 text-[12px] text-[var(--ink-70)] leading-relaxed">
                {entries.length === 0
                  ? 'No knowledge yet. Add what your team and your AI should remember.'
                  : 'Nothing matches that search.'}
              </p>
            </div>
          ) : (
            filtered.map((e) => (
              <EntryRow key={e.id} entry={e} active={e.id === selectedId} onClick={() => setSelectedId(e.id)} />
            ))
          )}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 min-w-0">
        {selected ? (
          <Editor
            key={selected.id}
            entry={selected}
            onChange={(patch) => void updateEntry(selected.id, patch)}
            onDelete={() => {
              void removeEntry(selected.id)
              setSelectedId(null)
            }}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-center px-6">
            <PlexiiIcon kind="app" id="plexibrain" size={36} fallback="neurology" fallbackClassName="text-[var(--ink-30)]" />
            <p className="mt-2 text-[13px] text-[var(--ink-70)] max-w-sm leading-relaxed">
              Select an entry to read or edit it, or add a new one. Everything here grounds the AI's answers in your own
              documented truth.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function EntryRow({ entry, active, onClick }: { entry: KnowledgeEntry; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      data-testid={`brain-entry-${entry.id}`}
      className={`w-full text-left rounded-lg px-3 py-2.5 mb-1 transition-colors ${
        active ? 'bg-[rgb(var(--accent)/0.10)] border border-[rgb(var(--accent)/0.30)]' : 'hover:bg-[var(--surface-sunken)] border border-transparent'
      }`}
    >
      <div className="flex items-center gap-1.5">
        {entry.pinned && <Icon name="push_pin" size={12} className="text-violet-500 shrink-0" filled />}
        <span className="text-[13px] font-semibold text-[var(--ink-100)] truncate">{entry.title || 'Untitled'}</span>
      </div>
      {entry.body && <p className="mt-0.5 text-[11.5px] text-[var(--ink-70)] line-clamp-2">{snippet(entry.body)}</p>}
      {entry.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {entry.tags.slice(0, 4).map((t) => (
            <span key={t} className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-stone-200/70 dark:bg-white/[0.06] text-[var(--ink-70)]">
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  )
}

function Editor({
  entry,
  onChange,
  onDelete
}: {
  entry: KnowledgeEntry
  onChange: (patch: { title?: string; body?: string; tags?: string[]; pinned?: boolean }) => void
  onDelete: () => void
}): JSX.Element {
  const [title, setTitle] = useState(entry.title)
  const [body, setBody] = useState(entry.body)
  const [tagInput, setTagInput] = useState('')

  function commitTags(raw: string): void {
    const tags = Array.from(new Set(raw.split(',').map((t) => t.trim()).filter(Boolean)))
    onChange({ tags })
  }

  return (
    <div className="h-full flex flex-col" data-testid="brain-editor">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--edge-soft)]">
        <button
          onClick={() => onChange({ pinned: !entry.pinned })}
          className={`p-1.5 rounded-md ${entry.pinned ? 'text-[rgb(var(--accent))] bg-[rgb(var(--accent)/0.10)]' : 'text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]'}`}
          title={entry.pinned ? 'Unpin' : 'Pin to top and surface first to the AI'}
          data-testid="brain-pin"
        >
          <Icon name="push_pin" size={16} filled={entry.pinned} />
        </button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== entry.title && onChange({ title })}
          placeholder="Entry title"
          data-testid="brain-title"
          className="flex-1 bg-transparent text-[17px] font-bold text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
        />
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-[var(--ink-40)] hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
          title="Delete entry"
          data-testid="brain-delete"
        >
          <Icon name="delete" size={16} />
        </button>
      </div>

      <div className="px-5 py-2.5 border-b border-[var(--edge-soft)] flex items-center gap-2 flex-wrap">
        <Icon name="sell" size={14} className="text-[var(--ink-70)]" />
        {entry.tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-stone-200/70 dark:bg-white/[0.06] text-[var(--ink-90)]">
            {t}
            <button onClick={() => onChange({ tags: entry.tags.filter((x) => x !== t) })} className="opacity-60 hover:opacity-100">
              <Icon name="close" size={10} />
            </button>
          </span>
        ))}
        <input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && tagInput.trim()) {
              commitTags([...entry.tags, tagInput].join(','))
              setTagInput('')
            }
          }}
          placeholder="Add tag…"
          className="bg-transparent text-[11px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)] w-24"
        />
      </div>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => body !== entry.body && onChange({ body })}
        placeholder="Write what should be remembered. The AI will ground its answers in this."
        data-testid="brain-body"
        className="flex-1 w-full resize-none px-5 py-4 bg-transparent text-[14px] leading-relaxed text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
      />
    </div>
  )
}
