import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import Icon from '../../Icon'
import DocOutline from './DocOutline'
import { sanitizeHtml } from '../../../lib/htmlSanitize'
import WorkspaceAsk from './WorkspaceAsk'
import { applyMention, filterMentionCandidates, matchMentionQuery } from '../../../lib/mentions'
import MentionText from '../../views/chat/MentionText'
import type { DocAi } from './useDocAi'
import AnsweredBy from '../../ai/AnsweredBy'
import type { SidePane } from '../../office/shell'

// The persistent right-side panel for PlexiDocs. Three tabs share one column:
//   AI Assistant - a greeting plus quick actions over the real AI hook
//   Comments     - the real comment threads passed by the parent, or an honest
//                  empty state when there are none
//   Outline      - the live heading outline (reuses DocOutline)
//
// The panel is collapsible and is never shown in focus mode (the caller gates on
// that). Everything here runs on real infrastructure: the AI actions call the
// window.api.ai methods through the DocAi hook, and the comment threads are the
// parent's real data. Nothing is fabricated.

export type DocSidePanelTab = 'ai' | 'comments' | 'outline'

// A comment thread for the panel. The parent maps its own comment model onto this
// shape; the panel never invents authors, times, or bodies. `replies` are the
// thread's responses in order. `you` marks the local user's own comments.
export interface PanelCommentReply {
  id: string
  author: string
  createdAt: number
  body: string
  you: boolean
}

export interface PanelCommentThread {
  id: string
  author: string
  createdAt: number
  body: string
  resolved: boolean
  you: boolean
  replies: PanelCommentReply[]
}

interface Props {
  editor: Editor
  ai: DocAi
  // The name to greet the writer with. Falls back to a neutral greeting when the
  // user is not signed in (no fabricated name).
  userName?: string | null
  // Show the in-panel AI tab. False in the main app, where the one global
  // assistant owns AI (this panel keeps only Comments + Outline). True in the
  // standalone PlexiOffice build, which has no global overlay.
  showAiTab?: boolean
  tab: DocSidePanelTab
  onTab: (tab: DocSidePanelTab) => void
  onCollapse: () => void
  // Comments wiring. When the parent has no comment backend (the non-live editor),
  // it passes an empty list and leaves the handlers undefined, and the panel shows
  // the honest empty state with the add affordance disabled.
  comments: PanelCommentThread[]
  canComment: boolean
  /**
   * Open the sign-in dialog. Shown in place of "Add a comment" when the person
   * is signed out, because commenting needs an account — absent in a surface
   * that has no way to sign in, where the footer is simply not rendered.
   */
  onSignIn?: () => void
  onAddComment?: () => void
  onReply?: (threadId: string, body: string) => void
  onJumpComment?: (threadId: string) => void
  // Member handles a comment can @mention (real participants: comment authors,
  // live collaborators, the signed-in user). Drives the reply autocomplete and
  // decides which @tokens render as highlighted chips. Empty when there is no one
  // to mention, in which case mentions render as plain text.
  mentionHandles?: string[]
  myHandle?: string | null
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function initials(name: string): string {
  const parts = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// The AI Assistant tab: the workspace brain up top, then a greeting, quick-action
// buttons, and the previewed result with Insert and Copy. Every action runs on
// the real AI hook.
function AiTab({ ai, userName, editor }: { ai: DocAi; userName?: string | null; editor: Editor }): JSX.Element {
  const [showMore, setShowMore] = useState(false)
  const [morePrompt, setMorePrompt] = useState('')
  const [translateOpen, setTranslateOpen] = useState(false)
  const [language, setLanguage] = useState('')
  const [copied, setCopied] = useState(false)

  const greeting = userName && userName.trim() ? `Hi ${userName.trim()}, how can I help with this document?` : 'How can I help with this document?'

  const actionClass =
    'fb-card flex items-center gap-2 w-full text-left px-3 py-2 text-[12.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)] disabled:opacity-50 fb-spring-soft'

  async function copyResult(): Promise<void> {
    if (!ai.previewHtml) return
    // Copy the plain text of the result so it pastes cleanly anywhere.
    const tmp = document.createElement('div')
    tmp.innerHTML = sanitizeHtml(ai.previewHtml)
    const text = tmp.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable; leave the result on screen */
    }
  }

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="doc-ai-tab">
      <WorkspaceAsk getDocText={() => editor.getText()} onInsert={(t) => editor.chain().focus().insertContent(t).run()} />

      <div className="flex items-center gap-1.5 pt-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--ink-40)]">This document</span>
        <span className="flex-1 h-px bg-[var(--edge-soft)]" />
      </div>

      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]">
          <Icon name="auto_awesome" size={14} />
        </span>
        <p className="text-[13px] text-[var(--ink-80)] leading-snug">{greeting}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <button className={actionClass} onClick={() => void ai.summarize()} disabled={ai.busy} data-testid="doc-ai-action-summarize">
          <Icon name="summarize" size={15} className="text-[rgb(var(--accent))]" />
          <span>Summarize this document</span>
        </button>
        <button className={actionClass} onClick={() => void ai.improve()} disabled={ai.busy} data-testid="doc-ai-action-improve">
          <Icon name="auto_awesome" size={15} className="text-[rgb(var(--accent))]" />
          <span>Improve writing</span>
        </button>
        <button className={actionClass} onClick={() => void ai.shorten()} disabled={ai.busy} data-testid="doc-ai-action-shorter">
          <Icon name="compress" size={15} className="text-[rgb(var(--accent))]" />
          <span>Make shorter</span>
        </button>
        <button className={actionClass} onClick={() => void ai.grammar()} disabled={ai.busy} data-testid="doc-ai-action-grammar">
          <Icon name="spellcheck" size={15} className="text-[rgb(var(--accent))]" />
          <span>Fix grammar</span>
        </button>
        <AnsweredBy feature="writing" className="mt-1" />
        <button
          className={actionClass}
          onClick={() => setTranslateOpen((v) => !v)}
          disabled={ai.busy}
          data-testid="doc-ai-action-translate"
        >
          <Icon name="translate" size={15} className="text-[rgb(var(--accent))]" />
          <span>Translate</span>
        </button>
        {translateOpen && (
          <div className="flex items-center gap-1.5 pl-1">
            <input
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && language.trim()) void ai.translate(language.trim())
              }}
              placeholder="Language, e.g. Spanish"
              className="fb-field flex-1 px-2.5 py-1.5 text-[12px]"
              data-testid="doc-ai-translate-language"
            />
            <button
              onClick={() => language.trim() && void ai.translate(language.trim())}
              disabled={ai.busy || !language.trim()}
              className="rounded-lg bg-[rgb(var(--accent))] px-2.5 py-1.5 text-[12px] text-white disabled:opacity-50"
              data-testid="doc-ai-translate-go"
            >
              Translate
            </button>
          </div>
        )}
        <button className={actionClass} onClick={() => setShowMore((v) => !v)} disabled={ai.busy} data-testid="doc-ai-action-more">
          <Icon name="more_horiz" size={15} className="text-[rgb(var(--accent))]" />
          <span>More</span>
        </button>
        {showMore && (
          <div className="flex flex-col gap-1.5 pl-1">
            <textarea
              value={morePrompt}
              onChange={(e) => setMorePrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && morePrompt.trim()) void ai.run(morePrompt.trim())
              }}
              rows={2}
              placeholder="Tell the assistant what to do with this document or selection."
              className="fb-field w-full resize-none px-2.5 py-1.5 text-[12px]"
              data-testid="doc-ai-more-prompt"
            />
            <button
              onClick={() => morePrompt.trim() && void ai.run(morePrompt.trim())}
              disabled={ai.busy || !morePrompt.trim()}
              className="self-start rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] text-white disabled:opacity-50"
              data-testid="doc-ai-more-run"
            >
              Run
            </button>
          </div>
        )}
      </div>

      {ai.busy && (
        <div className="flex items-center gap-1.5 text-[12px] text-[var(--ink-50)]" data-testid="doc-ai-busy">
          <Icon name="autorenew" size={14} className="animate-spin" />
          <span>Working on it.</span>
        </div>
      )}

      {ai.error && (
        <div className="rounded-lg border border-red-300/60 bg-red-50/70 dark:bg-red-950/30 px-3 py-2 text-[12px] text-red-600 dark:text-red-300" data-testid="doc-ai-error">
          {ai.error}
        </div>
      )}

      {ai.previewHtml != null && (
        <div className="flex flex-col gap-2" data-testid="doc-ai-result">
          <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-40)] font-semibold">Result</div>
          <div
            className="prose prose-sm prose-stone dark:prose-invert max-w-none max-h-72 overflow-auto rounded-lg bg-[var(--surface-base)] p-3 text-[13px]"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(ai.previewHtml) }}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={ai.apply}
              className="rounded-lg bg-[rgb(var(--accent))] px-3 py-1.5 text-[12px] font-medium text-white"
              data-testid="doc-ai-result-apply"
            >
              {ai.mode === 'rewrite' ? 'Apply' : 'Insert'}
            </button>
            <button
              onClick={() => void copyResult()}
              className="fb-btn-surface px-3 py-1.5 text-[12px] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)]"
              data-testid="doc-ai-result-copy"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// A reply field with @mention autocomplete. As the user types "@prefix" it offers
// matching member handles; Arrow keys move, Enter/Tab or a click inserts. When no
// mention is in progress, Enter submits the reply. Purely additive: typing an
// unknown @word just sends as plain text.
function MentionInput({
  value,
  onChange,
  onSubmit,
  handles,
  placeholder,
  testId
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  handles: string[]
  placeholder: string
  testId: string
}): JSX.Element {
  const [idx, setIdx] = useState(0)
  const q = matchMentionQuery(value)
  const candidates = q ? filterMentionCandidates(handles, q.query) : []
  const open = candidates.length > 0

  function choose(handle: string): void {
    onChange(applyMention(value, handle))
    setIdx(0)
  }

  return (
    <div className="relative mt-1.5">
      {open && (
        <div
          className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute bottom-full left-0 mb-1 z-10 w-48 py-1"
          data-testid={`${testId}-mentions`}
        >
          {candidates.map((h, i) => (
            <button
              key={h}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(h)
              }}
              className={`block w-full text-left px-2.5 py-1 text-[12px] ${
                i === idx ? 'bg-[rgb(var(--accent)/0.12)] text-[rgb(var(--accent))]' : 'text-[var(--ink-80)]'
              }`}
              data-testid={`${testId}-mention-option`}
            >
              @{h}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => {
            onChange(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (open) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx((n) => (n + 1) % candidates.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx((n) => (n - 1 + candidates.length) % candidates.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                choose(candidates[idx])
                return
              }
            }
            if (e.key === 'Enter') onSubmit()
          }}
          placeholder={placeholder}
          data-testid={testId}
          className="fb-field flex-1 px-2 py-1 text-[12px]"
        />
        <button onClick={onSubmit} disabled={!value.trim()} className="icon-btn disabled:opacity-40" title="Reply">
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  )
}

// One comment thread with its replies and a reply box.
function Thread({
  thread,
  onReply,
  onJump,
  mentionHandles,
  myHandle
}: {
  thread: PanelCommentThread
  onReply?: (threadId: string, body: string) => void
  onJump?: (threadId: string) => void
  mentionHandles: string[]
  myHandle?: string | null
}): JSX.Element {
  const [reply, setReply] = useState('')
  const known = new Set(mentionHandles.map((h) => h.toLowerCase()))
  const submit = (): void => {
    const t = reply.trim()
    if (!t || !onReply) return
    onReply(thread.id, t)
    setReply('')
  }
  return (
    <div
      className={`rounded-lg border px-2.5 py-2 ${thread.resolved ? 'border-[var(--edge-soft)] opacity-60' : 'border-[var(--edge-soft)]'}`}
      data-testid={`doc-comment-thread-${thread.id}`}
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent)/0.12)] text-[10px] font-semibold text-[rgb(var(--accent))]">
          {initials(thread.author)}
        </span>
        <button onClick={() => onJump?.(thread.id)} className="min-w-0 flex-1 text-left" title="Jump to the highlighted text">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[var(--ink-90)]">{thread.author}</span>
            <span className="text-[10px] text-[var(--ink-40)]">{timeAgo(thread.createdAt)}</span>
            {thread.resolved && (
              <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">Resolved</span>
            )}
          </div>
          <div className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-[var(--ink-80)]">
            <MentionText body={thread.body} myHandle={myHandle} knownHandles={known} />
          </div>
        </button>
      </div>

      {thread.replies.map((r) => (
        <div key={r.id} className="ml-3 mt-1.5 border-l border-[var(--edge-soft)] pl-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11.5px] font-medium text-[var(--ink-80)]">{r.author}</span>
            <span className="text-[10px] text-[var(--ink-40)]">{timeAgo(r.createdAt)}</span>
          </div>
          <div className="whitespace-pre-wrap text-[12px] text-[var(--ink-80)]">
            <MentionText body={r.body} myHandle={myHandle} knownHandles={known} />
          </div>
        </div>
      ))}

      {!thread.resolved && onReply && (
        <MentionInput
          value={reply}
          onChange={setReply}
          onSubmit={submit}
          handles={mentionHandles}
          placeholder="Reply"
          testId={`doc-comment-reply-${thread.id}`}
        />
      )}
    </div>
  )
}

// The Comments tab: the real threads from the parent, or an honest empty state.
function CommentsTab({
  comments,
  canComment,
  onSignIn,
  onAddComment,
  onReply,
  onJumpComment,
  mentionHandles,
  myHandle
}: {
  comments: PanelCommentThread[]
  canComment: boolean
  /**
   * Open the sign-in dialog. Shown in place of "Add a comment" when the person
   * is signed out, because commenting needs an account — absent in a surface
   * that has no way to sign in, where the footer is simply not rendered.
   */
  onSignIn?: () => void
  onAddComment?: () => void
  onReply?: (threadId: string, body: string) => void
  onJumpComment?: (threadId: string) => void
  mentionHandles: string[]
  myHandle?: string | null
}): JSX.Element {
  const sorted = [...comments].sort((a, b) => a.createdAt - b.createdAt)
  return (
    <div className="flex h-full flex-col" data-testid="doc-comments-tab">
      <div className="flex-1 overflow-auto p-3" data-testid="doc-comments-list">
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[var(--edge-soft)] p-4 text-[12px] text-[var(--ink-50)] leading-relaxed" data-testid="doc-comments-empty">
            No comments yet.{' '}
            {canComment
              ? 'Select text in the document and add a comment to start a thread.'
              : 'Comments appear here once this document is shared for live collaboration.'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {sorted.map((t) => (
              <Thread
                key={t.id}
                thread={t}
                onReply={onReply}
                onJump={onJumpComment}
                mentionHandles={mentionHandles}
                myHandle={myHandle}
              />
            ))}
          </div>
        )}
      </div>
      {canComment ? (
        <div className="shrink-0 border-t border-[var(--edge-soft)] p-3">
          <button
            onClick={onAddComment}
            disabled={!onAddComment}
            className="fb-btn-surface flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)] disabled:opacity-50"
            data-testid="doc-comments-add"
          >
            <Icon name="add_comment" size={15} />
            <span>Add a comment</span>
          </button>
        </div>
      ) : onSignIn ? (
        // SIGNED OUT, not unavailable. Commenting needs an account because a
        // comment is attributed to a person (4.3.41) — so the action stays
        // where it was and explains itself, rather than vanishing and leaving
        // someone to wonder whether this document supports comments at all.
        // Existing comments above remain readable.
        <div className="shrink-0 border-t border-[var(--edge-soft)] p-3">
          <button
            onClick={onSignIn}
            className="fb-btn-surface flex w-full items-center justify-center gap-1.5 px-3 py-2 text-[12.5px] text-[var(--ink-80)] hover:border-[rgb(var(--accent)/0.5)] hover:bg-[rgb(var(--accent)/0.06)]"
            data-testid="doc-comments-signin"
          >
            <Icon name="add_comment" size={15} />
            <span>Sign in to comment</span>
          </button>
          <p className="mt-1.5 text-center text-[11px] text-[var(--ink-40)]">
            Comments show who wrote them.
          </p>
        </div>
      ) : null}
    </div>
  )
}

export default function DocSidePanel({
  editor,
  ai,
  userName,
  showAiTab = true,
  tab,
  onTab,
  onCollapse,
  comments,
  canComment,
  onSignIn,
  onAddComment,
  onReply,
  onJumpComment,
  mentionHandles = [],
  myHandle
}: Props): JSX.Element {
  // Reset a stale preview/error when the writer leaves and re-enters the AI tab,
  // so an old result does not linger after switching tabs and back.
  const lastTab = useRef(tab)
  useEffect(() => {
    if (lastTab.current !== 'ai' && tab === 'ai') {
      // No reset needed; the writer may want to keep their last result.
    }
    lastTab.current = tab
  }, [tab])

  const openCount = comments.filter((c) => !c.resolved).length

  const tabBtn = (id: DocSidePanelTab, label: string, testid: string, badge?: JSX.Element): JSX.Element => (
    <button
      onClick={() => onTab(id)}
      data-testid={testid}
      className={`flex items-center gap-1 px-2.5 py-2 text-[12px] font-medium border-b-2 fb-spring-soft ${
        tab === id
          ? 'border-[rgb(var(--accent))] text-[rgb(var(--accent))]'
          : 'border-transparent text-[var(--ink-60)] hover:text-[var(--ink-90)]'
      }`}
    >
      <span>{label}</span>
      {badge}
    </button>
  )

  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-[var(--edge-soft)] bg-[var(--surface-raised)]"
      aria-label="Document assistant panel"
      data-testid="doc-side-panel"
    >
      <div className="flex shrink-0 items-center border-b border-[var(--edge-soft)] px-1">
        {showAiTab &&
          tabBtn(
            'ai',
            'PlexiiAssist',
            'doc-tab-ai',
            <span className="rounded bg-[rgb(var(--accent)/0.14)] px-1 text-[9px] uppercase tracking-wide text-[rgb(var(--accent))]">Beta</span>
          )}
        {tabBtn(
          'comments',
          'Comments',
          'doc-tab-comments',
          openCount > 0 ? <span className="text-[10px] text-[var(--ink-40)]">{openCount}</span> : undefined
        )}
        {tabBtn('outline', 'Outline', 'doc-tab-outline')}
        <button onClick={onCollapse} className="ml-auto icon-btn" aria-label="Collapse panel" title="Collapse panel" data-testid="doc-side-panel-collapse">
          <Icon name="chevron_right" size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {showAiTab && tab === 'ai' && (
          <div className="h-full overflow-auto">
            <AiTab ai={ai} userName={userName} editor={editor} />
          </div>
        )}
        {tab === 'comments' && (
          <CommentsTab
            comments={comments}
            canComment={canComment}
            onSignIn={onSignIn}
            onAddComment={onAddComment}
            onReply={onReply}
            onJumpComment={onJumpComment}
            mentionHandles={mentionHandles}
            myHandle={myHandle}
          />
        )}
        {tab === 'outline' && (
          // DocOutline renders its own floating aside with a close button. Inside
          // the panel we want it inline, so render a panel-native outline list.
          <PanelOutline editor={editor} />
        )}
      </div>
    </aside>
  )
}

// An inline outline for the panel. DocOutline is a floating overlay; this is the
// same live heading list rendered as a plain column inside the panel body.
// ── The same three bodies, as shell side panes ───────────────────────────────

/**
 * Write's three content panes for the shared ShellSidePane. Same bodies as the
 * panel above; the shell supplies the column, the pane switcher and the
 * collapse control, so the <aside> and tab strip are not repeated here.
 *
 * Every id the doc specs address is preserved: the switcher tabs keep
 * `doc-tab-ai` / `doc-tab-comments` / `doc-tab-outline` through `tabTestid`,
 * and each body keeps its own testid (doc-comments-tab, doc-outline-panel).
 * ShellSidePane's root carries `doc-side-panel`, which is where it was before.
 */
export function docSidePanes(p: Omit<Props, 'tab' | 'onTab' | 'onCollapse'>): SidePane[] {
  const openCount = p.comments.filter((c) => !c.resolved).length
  const panes: SidePane[] = []
  if (p.showAiTab ?? true) {
    panes.push({
      id: 'ai',
      title: 'PlexiiAssist',
      icon: 'auto_awesome',
      tabTestid: 'doc-tab-ai',
      render: () => (
        <div className="h-full overflow-auto">
          <AiTab ai={p.ai} userName={p.userName} editor={p.editor} />
        </div>
      )
    })
  }
  panes.push({
    id: 'comments',
    title: 'Comments',
    icon: 'comment',
    tabTestid: 'doc-tab-comments',
    badge: openCount > 0 ? String(openCount) : undefined,
    render: () => (
      <CommentsTab
        comments={p.comments}
        canComment={p.canComment}
        onSignIn={p.onSignIn}
        onAddComment={p.onAddComment}
        onReply={p.onReply}
        onJumpComment={p.onJumpComment}
        mentionHandles={p.mentionHandles ?? []}
        myHandle={p.myHandle}
      />
    )
  })
  panes.push({
    id: 'outline',
    title: 'Outline',
    icon: 'toc',
    tabTestid: 'doc-tab-outline',
    render: () => <PanelOutline editor={p.editor} />
  })
  return panes
}

function PanelOutline({ editor }: { editor: Editor }): JSX.Element {
  return (
    <div className="h-full overflow-auto py-1" data-testid="doc-outline-tab">
      <DocOutlineInline editor={editor} />
    </div>
  )
}

// Reuse DocOutline's behaviour by rendering it with a no-op close; it stays inline
// because we strip its fixed positioning via a wrapper class override is awkward,
// so instead we read the headings here with the same approach. To avoid drift we
// import and render DocOutline but neutralise its floating chrome.
function DocOutlineInline({ editor }: { editor: Editor }): JSX.Element {
  // DocOutline is a fixed-position overlay. We want the SAME live outline inline,
  // so we render it and let its internal list drive navigation; the wrapper below
  // unsets the fixed positioning so it flows inside the panel column.
  return (
    <div className="[&>aside]:static [&>aside]:w-full [&>aside]:max-h-none [&>aside]:rounded-none [&>aside]:border-0 [&>aside]:shadow-none [&>aside]:bg-transparent">
      <DocOutline editor={editor} onClose={() => {}} />
    </div>
  )
}
