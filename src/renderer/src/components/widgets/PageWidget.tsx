import { useEffect, useRef, useState } from 'react'
import MentionTextarea from '../MentionTextarea'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from 'tiptap-markdown'
import type { Editor } from '@tiptap/react'
import type { Widget } from '@shared/types'
import WidgetFrame from './WidgetFrame'
import { useWidgetStore } from '../../stores/widgets'
import Icon from '../Icon'
import ConnectedToolMenu from '../contextMenu/UnifiedConnectedMenu'

function formatAge(ts: number | null): string {
  if (!ts) return 'never'
  const ms = Date.now() - ts
  const s = Math.round(ms / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

interface Props {
  widget: Widget
  inline?: boolean
}

// Notion-style page widget. Tiptap handles all the heavy lifting (headings,
// lists, todos, code blocks, formatting via StarterKit + TaskList + TaskItem).
// We add a custom slash menu for block insertion + an inline AI prompt.
//
// Storage: widget.content holds the editor's JSON serialization. We commit
// on each transaction (debounced lightly) so the page survives reloads.
export default function PageWidget({ widget, inline = false }: Props): JSX.Element {
  const update = useWidgetStore((s) => s.update)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; selectionText?: string } | null>(null)
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashPos, setSlashPos] = useState<{ top: number; left: number } | null>(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  // Staged AI output — surfaces a preview panel that the user must Apply
  // (insert into editor) or Reject (discard) before anything lands in the
  // page. The TWO fields are kept independently because we render the
  // preview from markdown (cheaper) but insert the Tiptap doc (correct
  // structural fidelity into the editor).
  const [aiStaged, setAiStaged] = useState<{
    markdown: string
    tiptapJson: string
  } | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Living-mode local state
  const isLiving = widget.livingQuery !== null && widget.livingQuery !== undefined
  const [livingBusy, setLivingBusy] = useState(false)
  const [livingError, setLivingError] = useState<string | null>(null)
  const [editingQuery, setEditingQuery] = useState(false)
  const [queryDraft, setQueryDraft] = useState(widget.livingQuery ?? '')
  // For the freshness badge — tick once per minute so "2 min ago" updates
  // without forcing a full canvas re-render.
  const [, setNowTick] = useState(0)
  useEffect(() => {
    if (!isLiving) return
    const id = window.setInterval(() => setNowTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [isLiving])

  // Throttle the persist call — Tiptap fires onUpdate on every keystroke and
  // the markdown serializer + IPC roundtrip add up quickly.
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function schedulePersist(editor: Editor): void {
    if (persistTimer.current) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      const json = JSON.stringify(editor.getJSON())
      void update(widget.id, { content: json })
    }, 250)
  }

  const editor = useEditor(
    {
      editable: !isLiving,
      extensions: [
        StarterKit.configure({
          // Keep StarterKit defaults; everything from heading 1-3 to code blocks works out of the box.
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Link.configure({ openOnClick: false }),
        // GFM tables — render + edit, stored natively in the page's Tiptap JSON.
        TableKit.configure({ table: { resizable: false } }),
        // Lets a pasted |---|---| markdown table (or markdown in general) become
        // real nodes. The page still stores Tiptap JSON via getJSON; this only
        // affects how pasted text is interpreted, so tables paste in cleanly.
        Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: false }),
        Placeholder.configure({
          placeholder: isLiving
            ? 'Living page — set a query above to populate this.'
            : 'Start writing… press / for blocks, or click AI draft above'
        })
      ],
      content: tryParseContent(widget.content),
      onUpdate({ editor: ed }) {
        if (isLiving) return // never persist edits in living mode — content is system-owned
        schedulePersist(ed)
      },
      // Detect slash key to open the block menu. We open at the caret's
      // screen position so the menu floats next to the cursor.
      editorProps: {
        handleKeyDown(_, event) {
          if (isLiving) return false
          if (event.key === '/' && !slashOpen) {
            // Defer until Tiptap has inserted the / so the caret lands
            // after it; then read the caret position to anchor the menu.
            setTimeout(() => {
              const sel = window.getSelection()
              if (sel && sel.rangeCount > 0) {
                const rect = sel.getRangeAt(0).getBoundingClientRect()
                const container = containerRef.current?.getBoundingClientRect()
                if (container) {
                  setSlashPos({
                    top: rect.bottom - container.top + 2,
                    left: rect.left - container.left
                  })
                  setSlashOpen(true)
                }
              }
            }, 0)
            return false
          }
          if (event.key === 'Escape') {
            setSlashOpen(false)
            setAiOpen(false)
          }
          return false
        }
      }
    },
    // Re-mount the editor when the living-page generation timestamp changes —
    // that's the signal that widget.content has been replaced with a fresh
    // body. For manual pages the timestamp stays null so this collapses to
    // the original `[widget.id]` behaviour.
    [widget.id, widget.livingGeneratedAt]
  )

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
    }
  }, [])

  function removeSlashTrigger(): void {
    if (!editor) return
    // Step back to delete the "/" we inserted that triggered the menu.
    editor.chain().focus().deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from
    }).run()
  }

  function applyBlock(action: () => void): void {
    if (!editor) return
    removeSlashTrigger()
    action()
    setSlashOpen(false)
  }

  async function regenerateLiving(): Promise<void> {
    if (livingBusy) return
    setLivingBusy(true)
    setLivingError(null)
    try {
      const resp = await window.api.livingPage.regenerate(widget.id)
      if (!resp.ok) {
        setLivingError(resp.error ?? 'Regeneration failed')
        return
      }
      if (resp.skip) {
        setLivingError(resp.reason ?? 'No source material on the canvas yet.')
        return
      }
      // Persist via the store's `update` — this both writes the DB (through
      // the existing widgets:update IPC) and applies the optimistic local
      // update, which re-mounts the editor via the livingGeneratedAt dep.
      if (resp.content && resp.generatedAt) {
        await update(widget.id, {
          content: resp.content,
          livingGeneratedAt: resp.generatedAt
        })
      }
    } finally {
      setLivingBusy(false)
    }
  }

  async function enableLivingMode(): Promise<void> {
    // Electron has no window.prompt (it returns null), so asking for the query
    // up front silently did nothing and Make living appeared broken. Instead we
    // enter living mode with a sensible default query and generate immediately;
    // the inline query bar above the page lets the user refine it and regenerate.
    const defaultQuery = 'A running summary of everything on this task.'
    await update(widget.id, { livingQuery: defaultQuery, livingPaused: false })
    setQueryDraft(defaultQuery)
    // Kick an immediate first generation so the page isn't empty.
    setTimeout(() => void regenerateLiving(), 50)
  }

  async function convertToManual(): Promise<void> {
    if (!confirm('Stop auto-updating this page? Its current content will become editable.')) return
    await update(widget.id, { livingQuery: null, livingGeneratedAt: null, livingPaused: false })
  }

  async function togglePauseLiving(): Promise<void> {
    await update(widget.id, { livingPaused: !widget.livingPaused })
  }

  async function commitQueryEdit(): Promise<void> {
    const next = queryDraft.trim()
    if (!next) {
      setQueryDraft(widget.livingQuery ?? '')
      setEditingQuery(false)
      return
    }
    if (next !== widget.livingQuery) {
      await update(widget.id, { livingQuery: next })
      // Re-generate immediately on query change — it's a deliberate user action.
      setTimeout(() => void regenerateLiving(), 50)
    }
    setEditingQuery(false)
  }

  async function runAiPrompt(): Promise<void> {
    if (!editor || !aiPrompt.trim() || aiBusy) return
    setAiBusy(true)
    setAiError(null)
    try {
      const response = await window.api.ai.suggestPageContent(aiPrompt)
      if (!response.ok) {
        setAiError(response.error ?? 'AI request failed.')
        return
      }
      if (!response.tiptapJson || !response.markdown) {
        setAiError('Empty AI response.')
        return
      }
      // Stage rather than insert — the user gets to see the proposal in a
      // preview panel and either Apply (commits to the editor) or Reject.
      setAiStaged({
        markdown: response.markdown,
        tiptapJson: response.tiptapJson
      })
    } finally {
      setAiBusy(false)
    }
  }

  function applyAiStaged(): void {
    if (!editor || !aiStaged) return
    try {
      const doc = JSON.parse(aiStaged.tiptapJson) as { type: string; content?: unknown }
      // The doc is a full Tiptap doc node — we strip the outer "doc"
      // wrapper and insert its content nodes at the cursor so they merge
      // into the user's current document instead of replacing it.
      const inner = (doc.content as unknown[]) ?? []
      if (inner.length === 0) {
        setAiError('Generated content was empty.')
        return
      }
      editor.chain().focus().insertContent(inner as never).run()
      setAiStaged(null)
      setAiPrompt('')
      setAiOpen(false)
    } catch {
      setAiError('Could not parse AI output.')
    }
  }

  function rejectAiStaged(): void {
    setAiStaged(null)
    setAiError(null)
  }

  const body = (
    <div
      ref={containerRef}
      className="h-full w-full bg-[var(--surface-raised)] overflow-y-auto relative flex flex-col"
    >
      {isLiving && (
        <LivingHeader
          query={widget.livingQuery ?? ''}
          editingQuery={editingQuery}
          queryDraft={queryDraft}
          setQueryDraft={setQueryDraft}
          onStartEdit={() => {
            setQueryDraft(widget.livingQuery ?? '')
            setEditingQuery(true)
          }}
          onCommitEdit={() => void commitQueryEdit()}
          onCancelEdit={() => {
            setQueryDraft(widget.livingQuery ?? '')
            setEditingQuery(false)
          }}
          generatedAt={widget.livingGeneratedAt}
          paused={widget.livingPaused}
          busy={livingBusy}
          error={livingError}
          onRegenerate={() => void regenerateLiving()}
          onTogglePause={() => void togglePauseLiving()}
          onConvertToManual={() => void convertToManual()}
        />
      )}
      {!isLiving && (
        <div className="flex items-center justify-end gap-1 px-2 py-1 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] shrink-0">
          <button
            onClick={() => {
              setAiOpen(true)
              rejectAiStaged()
            }}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors ${
              aiOpen
                ? 'bg-accent text-white'
                : 'text-accent hover:bg-accent/10'
            }`}
            title="AI assistant — draft content, preview, then insert"
          >
            <Icon name="auto_awesome" size={12} />
            <span>AI draft</span>
          </button>
          <span className="w-px h-4 bg-[var(--surface-sunken)] mx-1" />
          <button
            onClick={() => void enableLivingMode()}
            className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] hover:text-accent flex items-center gap-1 px-1.5 py-1"
            title="Turn this page into a living summary that auto-updates from the rest of your canvas"
          >
            <Icon name="autorenew" size={11} />
            <span>Make living</span>
          </button>
        </div>
      )}
      {/* Reuse the same `md-rendered tiptap-editor` styles MarkdownWidget uses
          — they're hand-defined in globals.css. We don't have Tailwind's
          @tailwindcss/typography plugin installed, so `prose` classes would
          render as bare text (which is why this used to be blank). */}
      <div
        className={`md-rendered tiptap-editor px-5 py-4 text-[var(--ink-100)] min-h-[140px] flex-1 leading-relaxed ${isLiving ? 'select-text' : ''}`}
        onContextMenu={(e) => {
          if (e.shiftKey) return
          e.preventDefault()
          const sel = window.getSelection()?.toString() ?? ''
          setCtxMenu({ x: e.clientX, y: e.clientY, selectionText: sel })
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {ctxMenu && (
        <ConnectedToolMenu
          sourceWidgetId={widget.id}
          x={ctxMenu.x}
          y={ctxMenu.y}
          selectionContext={{ selectionText: ctxMenu.selectionText }}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {slashOpen && slashPos && (
        <div
          className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-50 w-56 py-1"
          style={{ top: slashPos.top, left: slashPos.left }}
        >
          <SlashItem
            icon="title"
            label="Heading 1"
            shortcut="#"
            onClick={() =>
              applyBlock(() => editor?.chain().focus().toggleHeading({ level: 1 }).run())
            }
          />
          <SlashItem
            icon="title"
            label="Heading 2"
            shortcut="##"
            onClick={() =>
              applyBlock(() => editor?.chain().focus().toggleHeading({ level: 2 }).run())
            }
          />
          <SlashItem
            icon="format_list_bulleted"
            label="Bullet list"
            shortcut="-"
            onClick={() =>
              applyBlock(() => editor?.chain().focus().toggleBulletList().run())
            }
          />
          <SlashItem
            icon="format_list_numbered"
            label="Numbered list"
            shortcut="1."
            onClick={() =>
              applyBlock(() => editor?.chain().focus().toggleOrderedList().run())
            }
          />
          <SlashItem
            icon="checklist"
            label="Todo list"
            shortcut="[]"
            onClick={() => applyBlock(() => editor?.chain().focus().toggleTaskList().run())}
          />
          <SlashItem
            icon="code"
            label="Code block"
            shortcut="```"
            onClick={() =>
              applyBlock(() => editor?.chain().focus().toggleCodeBlock().run())
            }
          />
          <SlashItem
            icon="format_quote"
            label="Quote"
            shortcut=">"
            onClick={() => applyBlock(() => editor?.chain().focus().toggleBlockquote().run())}
          />
          <SlashItem
            icon="horizontal_rule"
            label="Divider"
            onClick={() => applyBlock(() => editor?.chain().focus().setHorizontalRule().run())}
          />
          <div className="my-1 border-t border-[var(--edge-soft)]" />
          <SlashItem
            icon="auto_awesome"
            label="AI prompt"
            shortcut="/ai"
            onClick={() => {
              removeSlashTrigger()
              setSlashOpen(false)
              setAiOpen(true)
            }}
          />
        </div>
      )}

      {aiOpen && (
        <div className="absolute bottom-3 left-3 right-3 z-50 rounded-lg border border-accent bg-[var(--surface-raised)] shadow-xl p-3 max-h-[60%] flex flex-col gap-2">
          <div className="flex items-center gap-1.5">
            <Icon name="auto_awesome" size={13} className="text-accent" />
            <span className="text-[10px] uppercase tracking-wider font-semibold text-accent">
              AI assistant
            </span>
            <button
              onClick={() => {
                setAiOpen(false)
                rejectAiStaged()
              }}
              className="ml-auto h-5 w-5 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-70)]"
              aria-label="Close"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          {/* Prompt input — always visible so the user can revise the prompt
              even after seeing a staged preview. */}
          <MentionTextarea
            autoFocus
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void runAiPrompt()
              }
            }}
            placeholder='Tell the AI what to draft — e.g. "Write a meeting agenda for…"'
            rows={2}
            className="fb-field w-full text-[13px] px-2.5 py-1.5 resize-none"
          />
          {aiError && (
            <div className="text-[11px] text-amber-700 dark:text-amber-400 px-1">
              {aiError}
            </div>
          )}
          {/* Staging preview — appears once the AI has returned content. The
              user reviews then chooses Apply (insert into editor at cursor)
              or Reject (discard). They can also re-prompt to regenerate. */}
          {aiStaged && (
            <div className="flex-1 min-h-0 flex flex-col gap-1.5">
              <div className="text-[10px] uppercase tracking-wider text-[var(--ink-50)] flex items-center gap-1">
                <Icon name="visibility" size={11} />
                <span>Preview — review before inserting</span>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto bg-[var(--surface-sunken)] rounded-md p-2.5 text-[12px] text-[var(--ink-90)] whitespace-pre-wrap font-mono">
                {aiStaged.markdown}
              </div>
            </div>
          )}
          <div className="flex justify-end gap-1.5">
            {aiStaged ? (
              <>
                <button
                  onClick={rejectAiStaged}
                  className="text-[11px] px-3 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                >
                  Discard
                </button>
                <button
                  onClick={() => void runAiPrompt()}
                  disabled={!aiPrompt.trim() || aiBusy}
                  className="fb-btn-surface text-[11px] px-3 py-1 text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                >
                  {aiBusy ? 'Regenerating…' : 'Regenerate'}
                </button>
                <button
                  onClick={applyAiStaged}
                  className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:brightness-110 inline-flex items-center gap-1"
                >
                  <Icon name="check" size={11} />
                  Insert
                </button>
              </>
            ) : (
              <button
                onClick={() => void runAiPrompt()}
                disabled={!aiPrompt.trim() || aiBusy}
                className="text-[11px] px-3 py-1 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 inline-flex items-center gap-1"
              >
                {aiBusy ? (
                  <>
                    <Icon name="autorenew" size={11} className="animate-spin" />
                    Drafting…
                  </>
                ) : (
                  <>
                    <Icon name="auto_awesome" size={11} />
                    Draft
                  </>
                )}
              </button>
            )}
          </div>
          <div className="text-[9px] text-[var(--ink-40)]">
            Cmd+Enter to draft · Esc to close · staged content never inserts without your approval
          </div>
        </div>
      )}
    </div>
  )

  if (inline) return body
  return (
    <WidgetFrame
      widget={widget}
      headerLabel={widget.title || 'Page'}
      headerAccent="bg-stone-300/60 dark:bg-white/[0.09]"
    >
      {body}
    </WidgetFrame>
  )
}

function SlashItem({
  icon,
  label,
  shortcut,
  onClick
}: {
  icon: string
  label: string
  shortcut?: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-[var(--surface-sunken)] text-left"
    >
      <Icon name={icon} size={14} className="text-[var(--ink-50)]" />
      <span className="text-[12px] flex-1 text-[var(--ink-70)]">{label}</span>
      {shortcut && (
        <span className="text-[10px] text-[var(--ink-40)] font-mono">{shortcut}</span>
      )}
    </button>
  )
}

// Header strip rendered above a Living page. Shows the query (with edit-in-
// place), a freshness badge, and the action cluster (regenerate / pause /
// convert-to-manual). Kept self-contained because the manual page mode
// doesn't need any of this chrome.
interface LivingHeaderProps {
  query: string
  editingQuery: boolean
  queryDraft: string
  setQueryDraft: (s: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  generatedAt: number | null
  paused: boolean
  busy: boolean
  error: string | null
  onRegenerate: () => void
  onTogglePause: () => void
  onConvertToManual: () => void
}

function LivingHeader(props: LivingHeaderProps): JSX.Element {
  const {
    query,
    editingQuery,
    queryDraft,
    setQueryDraft,
    onStartEdit,
    onCommitEdit,
    onCancelEdit,
    generatedAt,
    paused,
    busy,
    error,
    onRegenerate,
    onTogglePause,
    onConvertToManual
  } = props

  return (
    <div className="border-b border-[var(--edge-soft)] bg-gradient-to-b from-accent/[0.06] to-transparent shrink-0">
      <div className="px-3 py-1.5 flex items-start gap-2">
        <Icon
          name="auto_awesome"
          size={12}
          className={`text-accent mt-0.5 shrink-0 ${busy ? 'animate-pulse' : ''}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[9px] uppercase tracking-[0.12em] text-[var(--ink-50)] mb-0.5 flex items-center gap-1.5">
            <span>Living page</span>
            <span className="text-[var(--ink-30)]">·</span>
            <span
              title={generatedAt ? new Date(generatedAt).toLocaleString() : 'Never generated'}
              className={paused ? 'text-amber-600' : ''}
            >
              {busy
                ? 'regenerating…'
                : paused
                  ? 'paused'
                  : `updated ${formatAge(generatedAt)}`}
            </span>
          </div>
          {editingQuery ? (
            <input
              autoFocus
              value={queryDraft}
              onChange={(e) => setQueryDraft(e.target.value)}
              onBlur={onCommitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="w-full text-[12px] px-1.5 py-0.5 bg-[var(--surface-raised)] border border-accent rounded"
              placeholder="What should this page summarize?"
            />
          ) : (
            <button
              onClick={onStartEdit}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-left text-[12px] text-[var(--ink-70)] hover:text-accent leading-snug truncate w-full"
              title="Click to edit the query"
            >
              {query || '(no query — click to set one)'}
            </button>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={onRegenerate}
            disabled={busy}
            className="icon-btn !h-6 !w-6 disabled:opacity-40"
            title="Regenerate now"
          >
            <Icon name="refresh" size={13} className={busy ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onTogglePause}
            className="icon-btn !h-6 !w-6"
            title={paused ? 'Resume auto-updates' : 'Pause auto-updates'}
          >
            <Icon name={paused ? 'play_arrow' : 'pause'} size={13} />
          </button>
          <button
            onClick={onConvertToManual}
            className="icon-btn !h-6 !w-6"
            title="Convert to manual page (stop auto-updates, make editable)"
          >
            <Icon name="edit_note" size={13} />
          </button>
        </div>
      </div>
      {error && (
        <div className="px-3 pb-1.5 text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
          <Icon name="info" size={11} className="mt-[1px] shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}

function tryParseContent(content: string): object | null {
  if (!content) return null
  try {
    return JSON.parse(content) as object
  } catch {
    // Backwards compatibility: a previously-saved plain-text content (or
    // markdown). Render as a single paragraph so we don't lose data.
    return {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: content }]
        }
      ]
    }
  }
}
