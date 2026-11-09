import { useEffect, useMemo, useRef } from 'react'
import type { Widget } from '@shared/types'
import { useMessagingStore } from '../../stores/messaging'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'
import { personDisplayName } from '../../lib/personName'
import { ChatComposer } from '../views/chat/ChatComposer'
import Icon from '../Icon'

// A canvas widget that pins a PlexiChat conversation to a desk. content holds
// JSON { conversationId, channelName }. Empty content shows a picker; once a
// conversation is chosen it renders a live, scrollable view of the messages (read
// from the messaging store, never copied into the widget) with an inline composer
// so you can read and reply to the channel without leaving the desk. An Open
// button jumps to the full conversation in Messages.

interface ThreadConfig {
  conversationId: string
  channelName: string
}

function parseConfig(content: string): ThreadConfig | null {
  if (!content.trim()) return null
  try {
    const c = JSON.parse(content) as Partial<ThreadConfig>
    if (typeof c.conversationId === 'string' && c.conversationId) {
      return { conversationId: c.conversationId, channelName: c.channelName ?? 'Conversation' }
    }
  } catch {
    /* fall through to picker */
  }
  return null
}

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    return ''
  }
}

export default function ChatThreadWidget({ widget }: { widget: Widget }): JSX.Element {
  const config = useMemo(() => parseConfig(widget.content ?? ''), [widget.content])
  const token = useMessagingStore((s) => s.token)
  const conversations = useMessagingStore((s) => s.conversations)
  const messagesByConv = useMessagingStore((s) => s.messagesByConv)
  const openConversation = useMessagingStore((s) => s.openConversation)
  const refresh = useMessagingStore((s) => s.refreshConversations)
  const ensureLoaded = useMessagingStore((s) => s.ensureConversationLoaded)
  const sendToConversation = useMessagingStore((s) => s.sendToConversation)
  const goMessages = useViewStore((s) => s.goMessages)
  const updateWidget = useWidgetStore((s) => s.update)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (conversations.length === 0) void refresh()
  }, [conversations.length, refresh])

  // Load the bound conversation's history once, without switching the active view.
  useEffect(() => {
    if (config) void ensureLoaded(config.conversationId)
  }, [config, ensureLoaded])

  const messages = config ? messagesByConv[config.conversationId] ?? [] : []

  // Keep the view pinned to the latest message.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  // Sender display names from the conversation's member list.
  const nameByAccount = useMemo(() => {
    const conv = config ? conversations.find((c) => c.id === config.conversationId) : null
    const map = new Map<string, string>()
    for (const m of conv?.members ?? []) map.set(m.accountId, personDisplayName(m, m.handle ?? 'Member'))
    return map
  }, [config, conversations])

  // Signed-out: honest, never a fabricated thread.
  if (!token) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[var(--surface-base)] text-[12px] text-[var(--ink-50)] p-3 text-center">
        Sign in to use chat on this desk.
      </div>
    )
  }

  // Empty state: pick a conversation to pin.
  if (!config) {
    return (
      <div className="h-full w-full flex flex-col bg-[var(--surface-base)] text-[var(--ink-90)]">
        <div className="px-3 py-2 border-b border-[var(--edge-soft)] text-[12px] font-semibold flex items-center gap-1.5">
          <Icon name="forum" size={14} className="text-accent" />
          Pin a conversation
        </div>
        <div className="flex-1 overflow-auto p-1">
          {conversations.length === 0 ? (
            <div className="p-3 text-[12px] text-[var(--ink-50)]">
              No conversations yet. Start one in Messages, then pin it here.
            </div>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() =>
                  void updateWidget(widget.id, {
                    content: JSON.stringify({ conversationId: c.id, channelName: c.title })
                  })
                }
                data-testid={`chat-thread-pick-${c.id}`}
                className="block w-full text-left px-2.5 py-1.5 rounded-md text-[12px] hover:bg-[var(--surface-sunken)] truncate"
              >
                <Icon name={c.kind === 'dm' ? 'person' : 'tag'} size={12} className="mr-1 text-[var(--ink-50)]" />
                {c.title}
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col bg-[var(--surface-base)] text-[var(--ink-90)]">
      <div className="px-3 py-2 border-b border-[var(--edge-soft)] flex items-center gap-1.5 shrink-0">
        <Icon name="forum" size={14} className="text-accent shrink-0" />
        <span className="text-[12px] font-semibold truncate flex-1 min-w-0">{config.channelName}</span>
        <button
          onClick={() => {
            goMessages()
            void openConversation(config.conversationId)
          }}
          data-testid="chat-thread-open"
          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          title="Open the full conversation in Messages"
        >
          Open <Icon name="open_in_full" size={11} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-3 py-2 space-y-1.5 widget-nodrag">
        {messages.length === 0 ? (
          <div className="text-[12px] text-[var(--ink-50)]">No messages yet. Say something below.</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="text-[12px] leading-snug">
              <span className="text-[11px] text-[var(--ink-50)] mr-1">
                {nameByAccount.get(m.fromAccount) ?? 'Someone'}
                <span className="text-[var(--ink-30)]"> · {fmtTime(m.createdAt)}</span>
              </span>
              <div className="text-[var(--ink-100)] whitespace-pre-wrap break-words">
                {m.deletedAt ? (
                  <span className="italic text-[var(--ink-50)]">message deleted</span>
                ) : (
                  m.body || '[attachment]'
                )}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-[var(--edge-soft)] widget-nodrag">
        <ChatComposer
          conversationId={config.conversationId}
          token={token}
          onSend={(body, attachment) => sendToConversation(config.conversationId, body, attachment)}
          onTyping={() => {}}
          compactBelow={380}
        />
      </div>
    </div>
  )
}
