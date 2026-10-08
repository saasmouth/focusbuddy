// The conversation list (Phase 4.6, reshaped in UI/UX P8). One component, two
// containers: a permanent rail in fullscreen, where there is room for it, and
// an overlay in sidebar and floating, where there is not (plan D10).
//
// The premium-rail conventions, verbatim from the mission research: rows are a
// single quiet line (title only — timestamps live in the group headers, not on
// every row), history is grouped by time (Today / Yesterday / Previous 7 days
// / Previous 30 days / Older), row actions exist only under the pointer, and a
// search field sits at the top (commissioned by Caleb at plan approval).
// Everything a row used to print — where it started, exactly when — moves to
// its tooltip, so the information survives without the noise.
//
// The search field used to appear only past five conversations. It is
// unconditional now: with the desk sidebar's recent-conversation sublist gone
// (2026-10-08) this list is the only way to reach an old chat, and a field
// that comes and goes with the row count is a field you cannot learn to reach
// for. The overlay variant also carries its own close button and answers
// Escape, because unlike the rail it covers the conversation it sits on.

import { useEffect, useMemo, useState } from 'react'
import Icon from '../Icon'
import type { AiChatConversationMeta } from '@shared/types'

interface Props {
  conversations: AiChatConversationMeta[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  // Fullscreen renders this as a rail; the other modes float it over the panel.
  variant: 'rail' | 'overlay'
  /** Overlay only — dismiss without picking anything. */
  onClose?: () => void
}

function bucketLabel(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  if (days < 30) return 'Previous 30 days'
  return 'Older'
}

function whenLabel(ts: number): string {
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 7)}w ago`
  return `${Math.floor(days / 365)}y ago`
}

export default function ConversationList({
  conversations,
  activeId,
  onOpen,
  onNew,
  onDelete,
  variant,
  onClose
}: Props): JSX.Element {
  const isRail = variant === 'rail'
  const [query, setQuery] = useState('')
  // Escape dismisses the overlay. The rail is permanent furniture and must not
  // answer Escape, or it would vanish from the AI home with no way back.
  useEffect(() => {
    if (isRail || !onClose) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose!()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isRail, onClose])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => (c.title || 'Untitled conversation').toLowerCase().includes(q))
  }, [conversations, query])

  return (
    <div
      data-testid={isRail ? 'conversation-rail' : 'conversation-overlay'}
      className={
        isRail
          ? 'w-[220px] shrink-0 h-full flex flex-col border-r border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_40%,transparent)]'
          : 'absolute inset-x-2 top-2 z-30 max-h-[70%] flex flex-col rounded-[var(--radius-card)] border border-[var(--edge-firm)] bg-[var(--surface-raised)] shadow-[var(--shadow-cast)] overflow-hidden'
      }
    >
      <div className="shrink-0 p-2 flex flex-col gap-1.5">
        {!isRail && onClose && (
          <div className="flex items-center gap-1">
            <span className="fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
              Your conversations
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close conversations"
              title="Close (Esc)"
              data-testid="conversation-close"
              className="ml-auto icon-btn !h-6 !w-6 shrink-0"
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={onNew}
          data-testid="conversation-new"
          title="New chat (⌘O)"
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-[var(--radius-row)] border border-[var(--edge-soft)] bg-[var(--surface-raised)] hover:border-[rgb(var(--accent)/0.45)] transition-colors fb-t-label text-[var(--ink-80)]"
        >
          <Icon name="add" size={14} className="text-accent shrink-0" />
          <span>New chat</span>
          <span className="ml-auto fb-t-caption font-mono text-[var(--ink-40)]">⌘O</span>
        </button>
        {conversations.length > 0 && (
          <div className="relative">
            <Icon
              name="search"
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--ink-40)] pointer-events-none"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats"
              data-testid="conversation-search"
              className="w-full rounded-[var(--radius-field)] bg-[var(--surface-sunken)] pl-7 pr-2 py-1 fb-t-label text-[var(--ink-90)] placeholder:text-[var(--ink-40)] focus:outline-none focus:shadow-[0_0_0_2px_rgb(var(--accent)/0.25)]"
            />
          </div>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 fb-t-caption text-[var(--ink-40)]">
            Your conversations will appear here.
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-2 py-3 fb-t-caption text-[var(--ink-40)]">No chats match.</p>
        ) : (
          filtered.map((c, i) => {
            const bucket = bucketLabel(c.updatedAt)
            const prev = i > 0 ? bucketLabel(filtered[i - 1].updatedAt) : null
            const contextNote = c.context ? ` — started on ${c.context.title || c.context.label}` : ''
            return (
              <div key={c.id} className="flex flex-col">
                {bucket !== prev && (
                  <div className="px-2 pt-2 pb-1 fb-t-caption uppercase tracking-[0.06em] text-[var(--ink-40)] select-none">
                    {bucket}
                  </div>
                )}
                <div
                  data-testid="conversation-row"
                  data-conversation-id={c.id}
                  data-active={c.id === activeId ? 'true' : 'false'}
                  className={`group/conv flex items-center gap-1 rounded-[var(--radius-row)] px-2 py-1.5 transition-colors ${
                    c.id === activeId
                      ? 'bg-[rgb(var(--accent)/0.12)]'
                      : 'hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onOpen(c.id)}
                    className="min-w-0 flex-1 text-left"
                    title={`${c.title || 'Untitled conversation'}${contextNote} · ${whenLabel(c.updatedAt)}`}
                  >
                    <span className="block fb-t-label text-[var(--ink-90)] truncate">
                      {c.title || 'Untitled conversation'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    aria-label={`Delete ${c.title || 'conversation'}`}
                    title="Delete this conversation"
                    data-testid="conversation-delete"
                    className="shrink-0 opacity-0 group-hover/conv:opacity-60 hover:!opacity-100 focus-visible:opacity-100 transition-opacity grid place-items-center text-[var(--ink-50)] hover:text-[var(--ink-100)]"
                  >
                    <Icon name="delete" size={13} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
