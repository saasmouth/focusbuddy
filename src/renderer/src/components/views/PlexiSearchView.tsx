import type { AnswerGrounding } from '@shared/types'
import { CheckedText, CheckSummary } from '../ai/CheckThis'
import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../Icon'
import { DashboardHeader, StatusPill, PLEXI_CARD } from '../plexi'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import type { SearchHit } from '@shared/types'

// PlexiSearch: one search box over the whole workspace. As you type it ranks
// tasks, documents, knowledge and files by relevance (knowledge and documents by
// meaning when an embedding key is set, by keyword otherwise). Press Enter and it
// also asks the workspace for a plain-language answer grounded in those same
// sources, shown above the links. With no AI key the answer step degrades to an
// honest prompt and the links still work, so nothing is faked.

type AskState =
  | { status: 'idle' }
  | { status: 'asking' }
  | { status: 'answered'; answer: string; sources: AskSource[]; grounding?: AnswerGrounding }
  | { status: 'nokey' }
  | { status: 'error'; message: string }

interface AskSource {
  docId: string
  title: string
  docType: string
  snippet: string
  cited: boolean
}

const TYPE_META: Record<
  SearchHit['type'],
  { icon: string; label: string; tone: 'accent' | 'stone' | 'sky' | 'violet' }
> = {
  task: { icon: 'task_alt', label: 'Task', tone: 'accent' },
  folder: { icon: 'folder', label: 'Folder', tone: 'accent' },
  document: { icon: 'description', label: 'Document', tone: 'stone' },
  'table-row': { icon: 'table_chart', label: 'Table', tone: 'stone' },
  widget: { icon: 'widgets', label: 'On a desk', tone: 'stone' },
  file: { icon: 'draft', label: 'File', tone: 'sky' },
  knowledge: { icon: 'neurology', label: 'PlexiiBrain', tone: 'violet' },
  event: { icon: 'calendar_month', label: 'Calendar', tone: 'sky' },
  meeting: { icon: 'video_call', label: 'Meeting', tone: 'violet' },
  sign: { icon: 'draw', label: 'Signature', tone: 'stone' },
  mail: { icon: 'mail', label: 'Email', tone: 'sky' }
}

function hitMeta(h: SearchHit): { icon: string; label: string; tone: 'accent' | 'stone' | 'sky' | 'violet' } {
  if (h.type === 'document') {
    if (h.docType === 'sheet') return { icon: 'table_chart', label: 'Spreadsheet', tone: 'stone' }
    if (h.docType === 'slides') return { icon: 'slideshow', label: 'Slides', tone: 'stone' }
    return { icon: 'description', label: 'Document', tone: 'stone' }
  }
  return TYPE_META[h.type]
}

export default function PlexiSearchView(): JSX.Element {
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  const goDocument = useViewStore((s) => s.goDocument)
  const goFiles = useViewStore((s) => s.goFiles)
  const goKnowledge = useViewStore((s) => s.goKnowledge)
  const goCalendar = useViewStore((s) => s.goCalendar)
  const goOffice = useViewStore((s) => s.goOffice)
  const goSign = useViewStore((s) => s.goSign)
  const goMail = useViewStore((s) => s.goMail)
  const goMeet = (): void => goOffice('meet')
  const setActive = useNodeStore((s) => s.setActive)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [ask, setAsk] = useState<AskState>({ status: 'idle' })
  // Which result the keyboard is on. -1 means none focused (e.g. before any
  // results arrive); it snaps to the top result whenever a fresh result set lands.
  const [focusIdx, setFocusIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  // Monotonic token so a slow ask for an old query cannot overwrite the answer
  // for the current one.
  const askSeq = useRef(0)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Live result list as the user types. Debounced, and a query under two
  // characters clears the list rather than running a too-broad search.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearching(false)
      setSearchError(false)
      return
    }
    setSearching(true)
    setSearchError(false)
    let cancelled = false
    const t = window.setTimeout(() => {
      void window.api.search
        .query(q)
        .then((res) => {
          if (cancelled) return
          setHits(res)
          // Snap keyboard focus to the top result so Enter opens it immediately.
          setFocusIdx(res.length ? 0 : -1)
        })
        .catch(() => {
          // A failed search is an honest error, not "no results".
          if (!cancelled) {
            setHits([])
            setSearchError(true)
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 160)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [query])

  // The AI answer is opt-in: it runs on Enter or the Ask button, not on every
  // keystroke, so it never burns a model call the user did not ask for.
  async function runAsk(): Promise<void> {
    const q = query.trim()
    if (q.length < 2 || ask.status === 'asking') return
    const seq = ++askSeq.current
    setAsk({ status: 'asking' })
    try {
      const r = await window.api.workspace.ask(q)
      if (seq !== askSeq.current) return // a newer query superseded this answer
      if (!r.ok) {
        if (r.needsApiKey) setAsk({ status: 'nokey' })
        else setAsk({ status: 'error', message: r.error || 'Could not answer that right now.' })
        return
      }
      setAsk({ status: 'answered', answer: r.answer || '', sources: r.sources || [], grounding: r.grounding })
    } catch {
      if (seq === askSeq.current) setAsk({ status: 'error', message: 'Could not answer that right now.' })
    }
  }

  function openHit(h: SearchHit): void {
    switch (h.type) {
      case 'folder':
        goProject(h.id)
        break
      case 'task':
        setActive(h.id)
        goTask(h.id)
        break
      case 'widget':
      case 'table-row':
        if (h.taskId) {
          setActive(h.taskId)
          goTask(h.taskId)
        }
        break
      case 'document':
        goDocument(h.id)
        break
      case 'file':
        goFiles()
        break
      case 'knowledge':
        goKnowledge(h.id)
        break
      case 'event':
        goCalendar()
        break
      case 'meeting':
        goMeet()
        break
      case 'sign':
        goSign()
        break
      case 'mail':
        goMail(Number(h.id))
        break
    }
  }

  function openSource(s: AskSource): void {
    if (s.docType === 'knowledge') goKnowledge(s.docId)
    else goDocument(s.docId)
  }

  const trimmed = query.trim()
  const showResults = trimmed.length >= 2

  return (
    <div className="h-full w-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]" data-testid="plexisearch-view">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <DashboardHeader title="Search" subtitle="Find tasks, documents, knowledge and files, and ask for an answer" />

        {/* Hero search input + Ask button */}
        <div
          className="fb-card flex items-center gap-2 h-12 px-3 fb-spring-crisp focus-within:ring-2 focus-within:ring-[rgb(var(--accent)/0.35)] focus-within:border-[rgb(var(--accent)/0.55)]"
        >
          <Icon name="search" size={18} className="text-[var(--ink-70)] shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setAsk({ status: 'idle' })
              // Invalidate any in-flight ask so its answer cannot land on the new query.
              askSeq.current++
            }}
            aria-label="Search your workspace"
            role="combobox"
            aria-expanded={showResults && hits.length > 0}
            aria-controls="plexisearch-results"
            aria-activedescendant={focusIdx >= 0 ? `plexisearch-opt-${focusIdx}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setFocusIdx((i) => Math.min(i + 1, hits.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setFocusIdx((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                // Cmd/Ctrl+Enter asks the AI; a plain Enter opens the focused
                // result, which is what a search box with a list should do.
                if (e.metaKey || e.ctrlKey) {
                  void runAsk()
                } else if (focusIdx >= 0 && hits[focusIdx]) {
                  openHit(hits[focusIdx])
                }
              }
            }}
            placeholder="Search everything. Up and down to move, Enter to open, Cmd+Enter to ask"
            data-testid="plexisearch-input"
            className="flex-1 min-w-0 bg-transparent text-[15px] text-[var(--ink-100)] placeholder:text-[var(--ink-50)]"
          />
          <button
            onClick={() => void runAsk()}
            disabled={trimmed.length < 2 || ask.status === 'asking'}
            data-testid="plexisearch-ask"
            className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-[rgb(var(--accent))] text-white text-[13px] font-medium hover:bg-[rgb(var(--accent-hover))] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Icon name="auto_awesome" size={15} />
            {ask.status === 'asking' ? 'Asking…' : 'Ask'}
          </button>
        </div>

        {/* AI answer card */}
        {ask.status !== 'idle' && (
          <div className={`${PLEXI_CARD} mt-4 p-5`} data-testid="plexisearch-answer">
            {ask.status === 'asking' && (
              <div className="flex items-center gap-2 text-[13px] text-[var(--ink-70)]">
                <Icon name="auto_awesome" size={15} className="text-violet-500 animate-pulse" />
                Reading your workspace and writing an answer…
              </div>
            )}
            {ask.status === 'nokey' && (
              <div className="flex items-start gap-2.5">
                <Icon name="key" size={16} className="text-[var(--ink-70)] mt-0.5 shrink-0" />
                <p className="text-[13px] text-[var(--ink-70)] leading-relaxed">
                  Add an Anthropic key in Settings to get a written answer drawn from your workspace. The results below
                  still work without one.
                </p>
              </div>
            )}
            {ask.status === 'error' && (
              <div className="flex items-start gap-2.5">
                <Icon name="error_outline" size={16} className="text-rose-500 mt-0.5 shrink-0" />
                <p className="text-[13px] text-[var(--ink-70)] leading-relaxed">{ask.message}</p>
              </div>
            )}
            {ask.status === 'answered' && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Icon name="auto_awesome" size={14} className="text-violet-500" filled />
                  <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">
                    Answer
                  </span>
                </div>
                <p className="text-[13.5px] text-[var(--ink-90)] leading-relaxed whitespace-pre-wrap">
                  <CheckedText text={ask.answer} grounding={ask.grounding} />
                </p>
                <CheckSummary grounding={ask.grounding} className="mt-1.5" />
                {ask.sources.filter((s) => s.cited).length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--edge-soft)]">
                    <span className="text-[11px] text-[var(--ink-50)]">Sources</span>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {ask.sources
                        .filter((s) => s.cited)
                        .map((s) => (
                          <button
                            key={s.docId}
                            onClick={() => openSource(s)}
                            className="fb-tile inline-flex items-center gap-1 text-[11.5px] px-2 py-1 text-[var(--ink-90)] hover:bg-[rgb(var(--accent)/0.10)]"
                          >
                            <Icon name={s.docType === 'knowledge' ? 'neurology' : 'description'} size={12} />
                            {s.title || 'Untitled'}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Result list */}
        {showResults && (
          <div className="mt-5">
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--ink-50)]">Results</span>
              {!searching && (
                <span className="fb-tabular text-[12px] text-[var(--ink-50)]">
                  {hits.length} {hits.length === 1 ? 'result' : 'results'}
                </span>
              )}
            </div>

            {searching && hits.length === 0 ? (
              <div className="flex items-center gap-2 px-3 py-6 text-[13px] text-[var(--ink-70)]">
                <Icon name="progress_activity" size={16} className="text-[rgb(var(--accent))] animate-spin" />
                Searching…
              </div>
            ) : searchError ? (
              <div className="px-3 py-10 text-center" data-testid="plexisearch-error">
                <Icon name="error_outline" size={26} className="text-rose-500" />
                <p className="mt-2 text-[13px] text-[var(--ink-70)]">Search failed. Try again.</p>
              </div>
            ) : hits.length === 0 ? (
              <div className="px-3 py-10 text-center">
                <Icon name="search_off" size={26} className="text-[var(--ink-30)]" />
                <p className="mt-2 text-[13px] text-[var(--ink-70)]">Nothing matches that yet. Try different words.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1" role="listbox" id="plexisearch-results" aria-label="Search results">
                {hits.map((h, i) => (
                  <ResultRow
                    key={`${h.type}:${h.id}`}
                    hit={h}
                    optionId={`plexisearch-opt-${i}`}
                    active={i === focusIdx}
                    onOpen={() => openHit(h)}
                    onHover={() => setFocusIdx(i)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {!showResults && ask.status === 'idle' && (
          <div className="mt-16 text-center">
            <Icon name="search" size={30} className="text-[var(--ink-30)]" />
            <p className="mt-3 text-[14px] text-[var(--ink-70)] max-w-md mx-auto leading-relaxed">
              One box for the whole workspace. Search your tasks, documents, knowledge and files, and press Enter to get
              a plain-language answer grounded in your own content.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function ResultRow({
  hit,
  optionId,
  active,
  onOpen,
  onHover
}: {
  hit: SearchHit
  optionId: string
  active: boolean
  onOpen: () => void
  onHover: () => void
}): JSX.Element {
  const meta = useMemo(() => hitMeta(hit), [hit])
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <button
      ref={ref}
      id={optionId}
      role="option"
      aria-selected={active}
      onClick={onOpen}
      onMouseMove={onHover}
      data-testid={`plexisearch-hit-${hit.id}`}
      className={`w-full text-left rounded-lg px-3 py-2.5 border transition-colors flex items-start gap-3 ${
        active
          ? 'bg-[rgb(var(--accent)/0.10)] border-[rgb(var(--accent)/0.30)]'
          : 'border-transparent hover:bg-[var(--surface-sunken)]'
      }`}
    >
      <span className="shrink-0 mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--surface-sunken)]">
        <Icon name={meta.icon} size={15} className="text-[var(--ink-70)]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-[var(--ink-100)] truncate">{hit.title}</span>
          <StatusPill tone={meta.tone} label={meta.label} dot={false} />
        </span>
        {hit.snippet && <span className="block mt-0.5 text-[12px] text-[var(--ink-70)] line-clamp-2">{hit.snippet}</span>}
      </span>
    </button>
  )
}
