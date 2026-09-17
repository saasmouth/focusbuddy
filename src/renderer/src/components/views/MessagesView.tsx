import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import MentionText from './chat/MentionText'
import { useMessagingStore } from '../../stores/messaging'
import { buildMessageUrl } from '../../lib/messageLink'
import { liveItemForMessage } from '../../lib/messageAttention'
import { PRIMARY_ACTION, queueOf } from '../../lib/attentionQueues'
import { useCloseWorkItem } from '../attention/useCloseWorkItem'
import BellIcon from '../attention/BellIcon'
import CompleteCircle from '../attention/CompleteCircle'
import { useWorkItemStore } from '../../stores/workItems'
import type { FbNode } from '@shared/types'
import { presetForSelection } from '../../lib/attentionPresets'
import { useAccountStore } from '../../stores/account'
import { useCallStore } from '../../stores/call'
import { useSignInPrompt } from '../../stores/signInPrompt'
import type { ChatMessage, OrgChannel, SearchHit } from '../../lib/messagingClient'
import {
  attachmentUrl,
  getOrgAiKeyStatus,
  setOrgAiKey,
  clearOrgAiKey,
  listSchedules,
  createSchedule,
  setScheduleEnabled,
  deleteSchedule,
  recallChannel,
  getPulse,
  refreshPulse,
  setPulseStatus,
  deletePulseItem,
  getBriefing,
  summarizeThread,
  listBotRoles,
  createBotRole,
  deleteBotRole,
  translateMessage,
  type ChannelSchedule,
  type RecallResult,
  type PulseItem,
  type Briefing,
  type ThreadSummaryResult,
  type BotRole
} from '../../lib/messagingClient'
import { applyProposal } from '../../lib/actionExecutor'
import { listOrgs, type OrgMembership } from '../../lib/orgsClient'
import Icon from '../Icon'
import { ChatComposer } from './chat/ChatComposer'
import ProposalCards from '../ProposalCards'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useWidgetStore } from '../../stores/widgets'
import { catalogFor } from '../../lib/widgetCatalog'
import { spawnPositionFor } from '../../lib/spawnPosition'
import { personDisplayName } from '../../lib/personName'
import { useClickAway } from '../../hooks/useClickAway'

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '✅', '👀']

function ReactPicker({ onPick }: { onPick: (emoji: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useClickAway(ref, open, close) // DEC-126 — anywhere outside, or Esc, closes it
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Add reaction"
        data-testid="react-open"
        className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 h-6 w-6 inline-flex items-center justify-center rounded-full text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] transition-opacity"
      >
        <Icon name="add_reaction" size={14} />
      </button>
      {open && (
        <div
          className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-20 bottom-full mb-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5 p-1"
          data-testid="react-palette"
        >
          {QUICK_EMOJIS.map((e) => (
            <button
              key={e}
              data-testid={`react-pick-${e}`}
              onClick={() => {
                onPick(e)
                setOpen(false)
              }}
              className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-[var(--surface-sunken)] text-[15px]"
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// A short text label for a message whose body is empty but which carries an
// attachment, used in the conversation-list preview.
// DEC-124/125 — the bell on a message, behaving exactly as it does on a desk
// widget: empty, it opens the house capture prompt (classify first — Respond
// by default — then file); once an open item points at the message it fills
// solid and stays visible, with a check-off circle beside it that closes the
// item with its queue's own verb through the one closing path (DEC-051), and
// then empties again. A filled bell opens the queue. Read in line, that is
// the list of messages still waiting on you.
function MessageBell({
  m,
  marked,
  onCapture
}: {
  m: ChatMessage
  marked: FbNode | null
  onCapture: () => void
}): JSX.Element {
  const closeWorkItem = useCloseWorkItem()
  const goAttention = useViewStore((s) => s.goAttention)
  const verb = marked ? (PRIMARY_ACTION[queueOf(marked)] ?? PRIMARY_ACTION.to_do) : null
  return (
    <span
      className={`self-center inline-flex items-center gap-0.5 shrink-0 ${
        marked ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100'
      }`}
      data-testid={`msg-attention-wrap-${m.id}`}
    >
      <button
        onClick={marked ? goAttention : onCapture}
        aria-pressed={!!marked}
        aria-label={marked ? 'In Attention — open the queue' : 'Add to Attention'}
        title={
          marked
            ? `In Attention: “${marked.title || 'this message'}” — click to open the queue`
            : "Add to Attention — you choose how it's filed (Respond by default)"
        }
        data-testid={`msg-attention-${m.id}`}
        className={`h-6 w-6 inline-flex items-center justify-center rounded-full hover:bg-[var(--surface-sunken)] transition-colors ${
          marked ? 'text-[rgb(var(--accent))]' : 'text-[var(--ink-50)] hover:text-[rgb(var(--accent))]'
        }`}
      >
        <BellIcon size={14} active={!!marked} />
      </button>
      {marked && verb && (
        <CompleteCircle
          size={14}
          className="shrink-0"
          onClick={() => void closeWorkItem(marked, verb.state)}
          title={`${verb.label} — complete “${marked.title || 'this message'}”`}
          dataTestId={`msg-attn-complete-${m.id}`}
        />
      )}
    </span>
  )
}

function attachmentPreviewLabel(att: ChatMessage['attachment']): string {
  if (!att) return ''
  if (att.kind === 'share') return att.label
  if (att.kind === 'voice') return 'Voice note'
  if (att.kind === 'video') return 'Video message'
  if (att.kind === 'gif') return 'GIF'
  if (att.kind === 'image') return 'Photo'
  return att.name
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Renders the one attachment a message may carry: a shared folder/task, an image
// or GIF inline, a downloadable file chip, or a voice-note player. Image/voice
// bytes load from the conversation-scoped, token-authenticated attachment route.
function AttachmentView({ m, mine }: { m: ChatMessage; mine: boolean }): JSX.Element | null {
  const token = useAccountStore((s) => s.sessionToken)
  const att = m.attachment
  if (!att) return null
  if (att.kind === 'share') {
    return (
      <div
        className={`mt-1 inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 ${mine ? 'bg-white/20' : 'bg-black/5 dark:bg-white/10'}`}
      >
        <Icon name="folder_shared" size={11} />
        {att.label}
      </div>
    )
  }
  const url = token ? attachmentUrl(m.conversationId, att.id, token) : ''
  if (att.kind === 'image' || att.kind === 'gif') {
    return (
      <img
        src={url}
        alt={att.name}
        loading="lazy"
        className="mt-1 max-w-[260px] max-h-[260px] rounded-lg object-cover cursor-zoom-in"
        onClick={() => url && window.open(url, '_blank')}
        data-testid={`attachment-image-${m.id}`}
      />
    )
  }
  if (att.kind === 'voice') {
    return <audio controls src={url} className="mt-1 max-w-[240px] h-9" data-testid={`attachment-voice-${m.id}`} />
  }
  if (att.kind === 'video') {
    return (
      <video
        controls
        playsInline
        src={url}
        className="mt-1 max-w-[280px] max-h-[280px] rounded-lg bg-black"
        data-testid={`attachment-video-${m.id}`}
      />
    )
  }
  // file
  return (
    <a
      href={url}
      download={att.name}
      className={`mt-1 inline-flex items-center gap-1.5 text-[11px] rounded-lg px-2 py-1 ${mine ? 'bg-white/20 text-white' : 'bg-black/5 dark:bg-white/10 text-stone-800 dark:text-stone-100'} hover:underline`}
      data-testid={`attachment-file-${m.id}`}
    >
      <Icon name="description" size={13} />
      <span className="truncate max-w-[180px]">{att.name}</span>
      <span className="opacity-60">{fmtBytes(att.sizeBytes)}</span>
    </a>
  )
}

// Message body with @mentions highlighted. Handles come from the message's
// conversation members; the viewer's own handle gets the accent chip.
function MentionBody({ m }: { m: ChatMessage }): JSX.Element {
  const conversations = useMessagingStore((s) => s.conversations)
  const myHandle = useAccountStore((s) => s.account?.handle ?? null)
  const conv = conversations.find((c) => c.id === m.conversationId)
  const known = new Set<string>()
  const nameByHandle = new Map<string, string>()
  for (const member of conv?.members ?? []) {
    if (member.handle) {
      const h = member.handle.toLowerCase()
      known.add(h)
      nameByHandle.set(h, personDisplayName(member, member.handle))
    }
  }
  return <MentionText body={m.body} myHandle={myHandle} knownHandles={known} nameByHandle={nameByHandle} />
}

export function MessageRow({
  m,
  mine,
  myId,
  onReact,
  onOpenThread,
  onEdit,
  onDelete,
  onTogglePin,
  pinned,
  translateLang,
  onCapture,
  marked = null
}: {
  m: ChatMessage
  mine: boolean
  myId: string
  onReact: (emoji: string) => void
  onOpenThread?: () => void
  onEdit?: (body: string) => void
  onDelete?: () => void
  onTogglePin?: () => void
  pinned?: boolean
  translateLang?: string
  /** DEC-124 — the bell: capture this message into Attention. */
  onCapture?: () => void
  /** DEC-125 — the open item pointing at this message, if any: the bell fills. */
  marked?: FbNode | null
}): JSX.Element {
  const reactions = m.reactions ?? []
  const replyCount = m.replyCount ?? 0
  const deleted = !!m.deletedAt
  const consumeProposal = useMessagingStore((s) => s.consumeProposal)
  const token = useMessagingStore((s) => s.token)
  const proposals = !deleted ? m.proposals ?? [] : []
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(m.body)
  const [translated, setTranslated] = useState<string | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [translating, setTranslating] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useClickAway(menuRef, menuOpen, closeMenu) // DEC-126 — anywhere outside, or Esc, closes it
  // DEC-126 — the ⋯ menu is on EVERY message now: Translate for anyone's
  // words (it left the meta row), Edit / Delete on your own. No entries, no
  // door.
  const menuEntries = (m.body ? 1 : 0) + (mine && onEdit ? 1 : 0) + (mine && onDelete ? 1 : 0)

  async function onTranslate(): Promise<void> {
    if (!token) return
    if (translated) {
      setShowOriginal((v) => !v)
      return
    }
    setTranslating(true)
    const r = await translateMessage(token, m.conversationId, m.id, translateLang || 'English')
    setTranslating(false)
    if (r.text) {
      setTranslated(r.text)
      setShowOriginal(false)
    }
  }
  // DEC-126 — the row's doors (the reaction palette, the bell, the ⋯ menu)
  // hang off the BUBBLE, not the column: absolutely positioned beside it on
  // its vertical centre, so whatever rides under the bubble (the time, the
  // pin, the thread, reactions) cannot push them off the message they name.
  const actions = !deleted && !editing && (
    <div
      className={`absolute top-1/2 -translate-y-1/2 flex items-center gap-1.5 ${mine ? 'right-full mr-1.5' : 'left-full ml-1.5'}`}
      data-testid={`msg-actions-${m.id}`}
    >
      <ReactPicker onPick={onReact} />
      {onCapture && <MessageBell m={m} marked={marked} onCapture={onCapture} />}
      {menuEntries > 0 && (
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Message actions"
            aria-expanded={menuOpen}
            data-testid={`msg-menu-${m.id}`}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 h-6 w-6 inline-flex items-center justify-center rounded-full text-[var(--ink-50)] hover:bg-[var(--surface-sunken)] transition-opacity"
          >
            <Icon name="more_horiz" size={14} />
          </button>
          {menuOpen && (
            <div
              className={`fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute z-20 bottom-full mb-1 ${mine ? 'right-0' : 'left-0'} py-1 min-w-[8.5rem] whitespace-nowrap`}
              data-testid={`msg-menu-panel-${m.id}`}
            >
              {m.body && (
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    void onTranslate()
                  }}
                  disabled={translating}
                  data-testid={`msg-translate-${m.id}`}
                  className="block w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                >
                  {translating ? 'Translating…' : translated ? (showOriginal ? `Show ${translateLang || 'translation'}` : 'Show original') : `Translate to ${translateLang || 'English'}`}
                </button>
              )}
              {mine && onEdit && (
                <button
                  onClick={() => {
                    setEditText(m.body)
                    setEditing(true)
                    setMenuOpen(false)
                  }}
                  data-testid={`msg-edit-${m.id}`}
                  className="block w-full text-left px-3 py-1.5 text-[12px] hover:bg-[var(--surface-sunken)]"
                >
                  Edit
                </button>
              )}
              {mine && onDelete && (
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    onDelete()
                  }}
                  data-testid={`msg-delete-${m.id}`}
                  className="block w-full text-left px-3 py-1.5 text-[12px] text-rose-500 hover:bg-[var(--surface-sunken)]"
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
  return (
    <div
      id={`msg-${m.id}`}
      className={`group flex ${mine ? 'justify-end' : 'justify-start'} rounded-lg transition-colors`}
    >
      <div className={`flex flex-col max-w-[70%] ${mine ? 'items-end' : 'items-start'}`}>
        <div className="relative max-w-full">
          {actions}
          <div
            className={`rounded-2xl px-3 py-1.5 text-[13px] ${
              deleted
                ? 'bg-[var(--surface-sunken)] text-[var(--ink-50)] italic'
                : mine
                  ? 'bg-accent text-white rounded-br-sm'
                  : 'bg-stone-100 dark:bg-stone-800 text-stone-900 dark:text-stone-100 rounded-bl-sm'
            }`}
          >
            {deleted ? (
              <div className="text-[12px]">This message was deleted</div>
            ) : editing ? (
              <div className="flex flex-col gap-1">
                <textarea
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      const t = editText.trim()
                      if (t) onEdit?.(t)
                      setEditing(false)
                    } else if (e.key === 'Escape') {
                      setEditing(false)
                    }
                  }}
                  rows={1}
                  data-testid={`msg-edit-input-${m.id}`}
                  className="resize-none rounded-md px-2 py-1 text-[13px] text-stone-900 bg-white/95 min-w-[180px]"
                />
                <div className="flex items-center gap-2 text-[10px] text-white/80">
                  <button onClick={() => { const t = editText.trim(); if (t) onEdit?.(t); setEditing(false) }} className="underline">Save</button>
                  <button onClick={() => setEditing(false)} className="underline">Cancel</button>
                  <span>Enter to save, Esc to cancel</span>
                </div>
              </div>
            ) : (
              <>
                {m.body && (
                  <div className="whitespace-pre-wrap break-words">
                    {translated && !showOriginal ? translated : <MentionBody m={m} />}
                  </div>
                )}
                <AttachmentView m={m} mine={mine} />
              </>
            )}
          </div>
        </div>
        {/* DEC-125/126 — the meta row, OUTSIDE the bubble: the time (on hover)
            and the pin on the left, the thread on the right edge. Translate
            moved into the ⋯ menu (DEC-126). */}
        {!editing && (
          <div
            className="mt-0.5 w-full flex items-center gap-2 text-[10px] text-[var(--ink-40)]"
            data-testid={`msg-meta-${m.id}`}
          >
            <span
              className="fb-tabular shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
              data-testid={`msg-time-${m.id}`}
            >
              {fmtTime(m.createdAt)}
              {!deleted && m.editedAt ? ' · edited' : ''}
              {translated && !showOriginal ? ' · translated' : ''}
            </span>
            {translating && (
              <span className="shrink-0" data-testid={`msg-translating-${m.id}`}>
                translating…
              </span>
            )}
            {onTogglePin && !deleted && (
              <button
                onClick={onTogglePin}
                data-testid={`msg-pin-${m.id}`}
                title={pinned ? 'Unpin message' : 'Pin message'}
                aria-label={pinned ? 'Unpin message' : 'Pin message'}
                className={`inline-flex items-center hover:text-accent transition-opacity ${
                  pinned ? 'text-accent' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100'
                }`}
              >
                <Icon name="keep" size={12} filled={pinned} />
              </button>
            )}
            {onOpenThread && (
              <span className="ml-auto shrink-0">
                {replyCount > 0 ? (
                  <button
                    onClick={onOpenThread}
                    data-testid={`thread-open-${m.id}`}
                    className="text-[11px] text-accent inline-flex items-center gap-1 hover:underline"
                  >
                    <Icon name="forum" size={12} /> {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                  </button>
                ) : (
                  <button
                    onClick={onOpenThread}
                    data-testid={`thread-reply-${m.id}`}
                    className="text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-accent"
                  >
                    <Icon name="reply" size={12} /> Reply in thread
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1" data-testid={`reactions-${m.id}`}>
            {reactions.map((r) => {
              const reactedByMe = r.accountIds.includes(myId)
              return (
                <button
                  key={r.emoji}
                  onClick={() => onReact(r.emoji)}
                  data-testid={`reaction-${m.id}-${r.emoji}`}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] border transition-colors ${
                    reactedByMe
                      ? 'bg-[rgb(var(--accent)/0.12)] border-[rgb(var(--accent)/0.40)] text-[var(--ink-100)]'
                      : 'bg-[var(--surface-sunken)] border-[var(--edge-soft)] text-[var(--ink-90)] hover:border-[var(--edge-firm)]'
                  }`}
                >
                  <span>{r.emoji}</span>
                  <span className="fb-tabular">{r.accountIds.length}</span>
                </button>
              )
            })}
          </div>
        )}
        {proposals.length > 0 && (
          <div className="mt-1 w-full max-w-[420px]" data-testid={`chat-proposals-${m.id}`}>
            {/* No appliedProposals / onApplied: PlexiChat has nowhere to keep
                applied-state yet, so cards are consumed on success exactly as
                before. Wiring applied-state into stores/messaging.ts is all this
                needs to gain durable green records + "Go to". */}
            <ProposalCards
              proposals={proposals}
              activeTaskId={null}
              onConsume={(pid) => consumeProposal(m.conversationId, m.id, pid)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// Messages — direct messages and shared-space chat in one place, the first
// surface of the cohesive messaging system. Conversation list on the left, the
// open thread + composer on the right, and a "new message by handle" action.

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

// `compact` (DEC-121) — the same view inside the assistant panel: no paper
// of its own, and one pane at a time (the list, then the thread with a way
// back), because a 420px panel has no width to give two.
export default function MessagesView({ compact = false }: { compact?: boolean } = {}): JSX.Element {
  const account = useAccountStore((s) => s.account)
  const sessionToken = useAccountStore((s) => s.sessionToken)
  const requestSignIn = useSignInPrompt((s) => s.requestOpen)
  const conversations = useMessagingStore((s) => s.conversations)
  const messagesByConv = useMessagingStore((s) => s.messagesByConv)
  const activeId = useMessagingStore((s) => s.activeId)
  const react = useMessagingStore((s) => s.react)
  const editMessage = useMessagingStore((s) => s.editMessage)
  const deleteMessage = useMessagingStore((s) => s.deleteMessage)
  const notifyTyping = useMessagingStore((s) => s.notifyTyping)
  const typingByConv = useMessagingStore((s) => s.typingByConv)
  const openThread = useMessagingStore((s) => s.openThread)
  const activeThreadId = useMessagingStore((s) => s.activeThreadId)
  const threadsByParent = useMessagingStore((s) => s.threadsByParent)
  const landOnMessage = useMessagingStore((s) => s.landOnMessage)
  const landOn = useMessagingStore((s) => s.landOn)
  const startCall = useCallStore((s) => s.startCall)
  const goMeetings = useViewStore((s) => s.goMeetings)
  const open = useMessagingStore((s) => s.openConversation)
  const send = useMessagingStore((s) => s.send)
  const startDm = useMessagingStore((s) => s.startDm)
  const inviteContact = useMessagingStore((s) => s.inviteContact)
  const refresh = useMessagingStore((s) => s.refreshConversations)

  const [newHandle, setNewHandle] = useState('')
  const [composingNew, setComposingNew] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const search = useMessagingStore((s) => s.search)
  const pinsByConv = useMessagingStore((s) => s.pinsByConv)
  const loadPins = useMessagingStore((s) => s.loadPins)
  const pinMsg = useMessagingStore((s) => s.pin)
  const unpinMsg = useMessagingStore((s) => s.unpin)
  const activity = useMessagingStore((s) => s.activity)
  const loadActivity = useMessagingStore((s) => s.loadActivity)
  const setNotif = useMessagingStore((s) => s.setNotif)
  const addMemberByHandle = useMessagingStore((s) => s.addMemberByHandle)
  const removeMember = useMessagingStore((s) => s.removeMember)
  const setVisibility = useMessagingStore((s) => s.setVisibility)
  const [showMembers, setShowMembers] = useState(false)
  const [showSchedules, setShowSchedules] = useState(false)
  const [showRecall, setShowRecall] = useState(false)
  const [showPulse, setShowPulse] = useState(false)
  const [showBriefing, setShowBriefing] = useState(false)
  const [translateLang, setTranslateLang] = useState<string>(
    () => localStorage.getItem('plexi-translate-lang') || 'English'
  )
  useEffect(() => {
    localStorage.setItem('plexi-translate-lang', translateLang)
  }, [translateLang])
  const [addMemberHandle, setAddMemberHandle] = useState('')
  const [memberError, setMemberError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [viewingActivity, setViewingActivity] = useState(false)
  // Compact mode's one-pane-at-a-time: opening a conversation shows the
  // thread; the thread's back arrow returns to the list without touching
  // the store's active conversation (the Office view shares it).
  const [compactPane, setCompactPane] = useState<'list' | 'thread'>('thread')
  useEffect(() => {
    if (activeId) setCompactPane('thread')
  }, [activeId])
  const openConv = (id: string): void => {
    void open(id)
    setCompactPane('thread')
  }

  useEffect(() => {
    if (viewingActivity) void loadActivity()
  }, [viewingActivity, loadActivity])

  // Debounced message search across the account's conversations.
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    const t = window.setTimeout(() => {
      void search(q).then(setSearchHits)
    }, 250)
    return () => window.clearTimeout(t)
  }, [searchQuery, search])

  useEffect(() => {
    if (account) void refresh()
  }, [account, refresh])

  const messages = activeId ? messagesByConv[activeId] ?? [] : []
  const pins = activeId ? pinsByConv[activeId] ?? [] : []
  const pinnedIds = new Set(pins.map((p) => p.id))

  // Load pinned messages whenever the open conversation changes.
  useEffect(() => {
    if (activeId) void loadPins(activeId)
  }, [activeId, loadPins])

  // Keep the thread pinned to the newest message.
  useEffect(() => {
    const el = threadRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, activeId])

  // DEC-127 — land on the message the route back from Attention named. Runs
  // AFTER the pin-to-newest effect above (declaration order), so the landing
  // wins the scroll. In the panel the thread pane must be showing first; a
  // reply needs its thread open first; a message that never appears expires.
  useEffect(() => {
    if (!landOnMessage || !activeId) return
    if (Date.now() - landOnMessage.at > 8000) {
      landOn(null)
      return
    }
    if (compact && compactPane !== 'thread') {
      setCompactPane('thread')
      return
    }
    const { messageId, parentId } = landOnMessage
    if (parentId) {
      if (activeThreadId !== parentId) {
        if (messages.some((m) => m.id === parentId)) void openThread(parentId)
        return
      }
      if (!(threadsByParent[parentId] ?? []).some((m) => m.id === messageId)) return
    } else if (!messages.some((m) => m.id === messageId)) return
    if (!document.getElementById(`msg-${messageId}`)) return
    jumpToMessage(messageId)
    landOn(null)
  }, [landOnMessage, activeId, activeThreadId, messages, threadsByParent, compact, compactPane, openThread, landOn])

  // DEC-125 — which messages an open Attention item still points at: the bell
  // fills for those and shows its check-off circle.
  //
  // These sit ABOVE the signed-out early return on purpose. Below it they ran
  // only when an account existed, so the first render after signing in called
  // four more hooks than the one before it — the "rendered more hooks than
  // during the previous render" crash. They depend on nothing between here and
  // where they used to be.
  const workItems = useWorkItemStore((s) => s.items)
  const workItemsLoaded = useWorkItemStore((s) => s.loaded)
  const refreshWorkItems = useWorkItemStore((s) => s.refresh)
  useEffect(() => {
    if (!workItemsLoaded) void refreshWorkItems()
  }, [workItemsLoaded, refreshWorkItems])

  if (!account) {
    return (
      <div className={`h-full flex items-center justify-center px-6 ${compact ? '' : 'desk-paper no-tod'}`}>
        <div className="text-center max-w-sm">
          <Icon name="forum" size={32} className="text-stone-400 dark:text-stone-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-stone-900 dark:text-stone-100 mb-1">Messages</h1>
          <p className="text-[13px] text-stone-500 dark:text-stone-400 mb-4">
            Sign in to message other people on PlexiDesk and share folders and tasks to work
            together.
          </p>
          <button onClick={() => requestSignIn()} className="btn-primary mx-auto">
            <Icon name="login" size={14} />
            <span>Sign in</span>
          </button>
        </div>
      </div>
    )
  }

  async function submitNew(): Promise<void> {
    setError(null)
    const value = newHandle.trim()
    if (!value) return
    // An email address adds a contact (they get a request to accept, or a
    // sign-up invite if they're not on PlexiDesk yet); a handle starts a DM now.
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
    if (isEmail) {
      const r = await inviteContact(value)
      if (!r.ok) {
        setError(r.error)
        return
      }
      setError(
        r.status === 'requested'
          ? 'Request sent — they can accept it in their inbox.'
          : "Invite sent — they'll get an email to join PlexiDesk."
      )
      setNewHandle('')
      return
    }
    const r = await startDm(value)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setComposingNew(false)
    setNewHandle('')
  }

  // Pin the open conversation to the current desk as a chat-thread widget. Needs
  // an active desk; if there is none, tell the user rather than failing silently.
  async function pinToCanvas(): Promise<void> {
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv) return
    const taskId = useNodeStore.getState().activeTaskId
    if (!taskId) {
      setError('Open a desk first, then pin the conversation to it.')
      return
    }
    const entry = catalogFor('chat-thread')
    const pos = spawnPositionFor(entry?.defaultWidth ?? 320, entry?.defaultHeight ?? 300)
    await useWidgetStore.getState().create({
      taskId,
      kind: 'chat-thread',
      title: conv.title,
      content: JSON.stringify({ conversationId: conv.id, channelName: conv.title }),
      x: pos.x,
      y: pos.y,
      width: entry?.defaultWidth ?? 320,
      height: entry?.defaultHeight ?? 300,
      color: null
    })
    useViewStore.getState().goTask(taskId)
  }

  const activeConv = conversations.find((c) => c.id === activeId) ?? null
  // For a 1:1 DM, the other member is the call target. Spaces are multi-member,
  // so the header call button only shows for DMs (a 1:1 mesh call).
  const dmOther = activeConv?.kind === 'dm' ? activeConv.members.find((m) => m.accountId !== account.id) : null
  const callTarget = dmOther
    ? { accountId: dmOther.accountId, handle: dmOther.handle ?? 'teammate', firstName: dmOther.firstName, lastName: dmOther.lastName }
    : null
  const callTargetName = callTarget ? personDisplayName(callTarget, callTarget.handle) : ''
  // A DM's header reads as the other person's real name; spaces/channels carry
  // their own title from the server.
  const headerTitle =
    activeConv?.kind === 'dm' && dmOther
      ? personDisplayName(dmOther, dmOther.handle ?? 'Conversation')
      : activeConv?.title ?? 'Conversation'
  // DEC-131 — in the panel the header IS the people: a DM reads as the person,
  // a space reads as everyone else in it ("if I were to have multiple people
  // in this chat that should just show me both names"), so no members
  // button is needed; a space with no one else falls back to its title.
  const others = (activeConv?.members ?? []).filter((m) => m.accountId !== account?.id)
  const panelTitle =
    activeConv?.kind === 'dm'
      ? headerTitle
      : others.length > 0
        ? others.map((m) => personDisplayName(m, m.handle ?? 'teammate')).join(', ')
        : headerTitle

  // DEC-124 — a message's bell: the house capture prompt, prefilled with the
  // message and pointed back at it (sourceType 'message', the conversation as
  // sourceRef, the moment URL as sourceUrl), opening on Respond — the card
  // still asks how to file it. Nothing files until the person says so.
  function captureMessage(m: ChatMessage): void {
    const member = activeConv?.members.find((mm) => mm.accountId === m.fromAccount)
    const who =
      m.fromAccount === account?.id ? 'You' : member ? personDisplayName(member, member.handle ?? 'teammate') : 'Someone'
    const text = (m.body || attachmentPreviewLabel(m.attachment)).trim()
    const p = presetForSelection('chat', text)
    window.dispatchEvent(
      new CustomEvent('fb:command-new-work-item', {
        detail: {
          captureText: p.text || `Reply to ${who}`,
          notes: `${who} in ${headerTitle}:\n${text}`,
          source: {
            sourceType: 'message',
            sourceRef: m.conversationId,
            intentClass: 'to_respond',
            // DEC-127 — a reply names its parent too, so the way back can open its thread.
            sourceUrl: buildMessageUrl(m.conversationId, m.id, m.parentId ?? null)
          }
        }
      })
    )
  }

  const markedFor = (id: string): FbNode | null => liveItemForMessage(workItems, id)

  // Who is currently typing in the open conversation (recent pings only).
  const typers = activeId
    ? Object.values(typingByConv[activeId] ?? {})
        .filter((t) => Date.now() - t.at < 5000)
        .map((t) => t.name)
    : []
  const typingLabel =
    typers.length === 0
      ? null
      : typers.length === 1
        ? `${typers[0]} is typing…`
        : typers.length === 2
          ? `${typers[0]} and ${typers[1]} are typing…`
          : 'Several people are typing…'

  // Header doors: the Office page's size, or the panel's tighter one (DEC-123) —
  // in the panel they sit on their own row, left-aligned, wrapping, so nothing
  // is ever cut off at 420px.
  const hdrBtn = compact
    ? 'fb-btn-surface inline-flex items-center gap-1 h-7 px-2 text-[12px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
    : 'fb-btn-surface inline-flex items-center gap-1.5 h-8 px-3 text-[12.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
  const hdrIconBtn = compact
    ? 'fb-btn-surface inline-flex items-center justify-center h-7 w-7 text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
    : 'fb-btn-surface inline-flex items-center justify-center h-8 w-8 text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]'
  return (
    <div className={compact ? 'h-full flex flex-col' : 'h-full flex desk-paper no-tod'} data-testid="messages-view" data-compact={compact || undefined}>
      {/* Conversation list */}
      <div
        className={
          compact
            ? `${activeId && compactPane === 'thread' ? 'hidden' : 'flex'} flex-1 min-h-0 w-full flex-col`
            : 'w-64 shrink-0 border-r border-[var(--edge-soft)] flex flex-col'
        }
        data-testid="messages-list-pane"
      >
        <div className="px-3 py-3 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Messages</h1>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowBriefing(true)}
              className="icon-btn"
              title="Needs you — a briefing across all your channels"
              data-testid="messages-briefing"
            >
              <Icon name="flag" size={15} />
            </button>
            <button
              onClick={() => setViewingActivity((v) => !v)}
              className={`icon-btn ${viewingActivity ? 'text-accent' : ''}`}
              title="Activity — mentions & replies to you"
              data-testid="messages-activity-toggle"
            >
              <Icon name="notifications" size={15} />
            </button>
            <button
              onClick={() => {
                setSearching((v) => !v)
                setSearchQuery('')
              }}
              className="icon-btn"
              title="Search messages"
              data-testid="messages-search-toggle"
            >
              <Icon name="search" size={15} />
            </button>
            <button
              onClick={() => setBrowsing(true)}
              className="icon-btn"
              title="Browse and create channels"
              data-testid="messages-channels"
            >
              <Icon name="tag" size={15} />
            </button>
            <button
              onClick={() => setComposingNew((v) => !v)}
              className="icon-btn"
              title="New message"
              data-testid="messages-new"
            >
              <Icon name="edit_square" size={15} />
            </button>
          </div>
        </div>
        {browsing && <ChannelBrowser onClose={() => setBrowsing(false)} />}
        {showSchedules && activeId && (
          <SchedulesPanel conversationId={activeId} onClose={() => setShowSchedules(false)} />
        )}
        {showRecall && activeId && <RecallPanel conversationId={activeId} onClose={() => setShowRecall(false)} />}
        {showPulse && activeId && <PulsePanel conversationId={activeId} onClose={() => setShowPulse(false)} />}
        {showBriefing && <BriefingPanel onClose={() => setShowBriefing(false)} />}

        {composingNew && (
          <div className="px-3 pb-2">
            <div className="flex gap-1">
              <input
                value={newHandle}
                onChange={(e) => setNewHandle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void submitNew()}
                placeholder="@handle or email"
                autoFocus
                data-testid="messages-new-handle"
                className="fb-field flex-1 px-2 py-1 text-[12px]"
              />
              <button onClick={() => void submitNew()} className="btn-primary px-2 py-1 text-[11px]">
                Start
              </button>
            </div>
            {error && <div className="text-[11px] text-red-600 dark:text-red-400 mt-1">{error}</div>}
          </div>
        )}

        {searching && (
          <div className="px-3 pb-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search messages…"
              autoFocus
              data-testid="messages-search-input"
              className="fb-field w-full px-2 py-1 text-[12px]"
            />
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {viewingActivity ? (
            activity.length === 0 ? (
              <p className="text-[11px] text-stone-500 dark:text-stone-400 px-3 py-2">
                Nothing yet. Mentions of you and replies to your messages show up here.
              </p>
            ) : (
              activity.map((a) => (
                <button
                  key={a.messageId}
                  onClick={() => {
                    openConv(a.conversationId)
                    setViewingActivity(false)
                  }}
                  data-testid="activity-item"
                  className="w-full text-left px-3 py-2 border-b border-[var(--edge-soft)] hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors"
                >
                  <div className="text-[11px] font-medium text-stone-700 dark:text-stone-300 truncate inline-flex items-center gap-1">
                    <Icon name={a.reason === 'mention' ? 'alternate_email' : 'reply'} size={11} className="text-accent" />
                    {a.conversationTitle}
                  </div>
                  <div className="text-[12px] text-stone-600 dark:text-stone-400 truncate">{a.body}</div>
                </button>
              ))
            )
          ) : searching && searchQuery.trim() ? (
            searchHits.length === 0 ? (
              <p className="text-[11px] text-stone-500 dark:text-stone-400 px-3 py-2">No matches.</p>
            ) : (
              searchHits.map((h) => (
                <button
                  key={h.messageId}
                  onClick={() => {
                    openConv(h.conversationId)
                    setSearching(false)
                    setSearchQuery('')
                  }}
                  data-testid="search-hit"
                  className="w-full text-left px-3 py-2 border-b border-[var(--edge-soft)] hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors"
                >
                  <div className="text-[11px] font-medium text-stone-700 dark:text-stone-300 truncate">
                    {h.conversationTitle}
                  </div>
                  <div className="text-[12px] text-stone-600 dark:text-stone-400 truncate">{h.body}</div>
                </button>
              ))
            )
          ) : conversations.length === 0 ? (
            <p className="text-[11px] text-stone-500 dark:text-stone-400 px-3 py-2 leading-snug">
              No conversations yet. Start one with someone&apos;s handle.
            </p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => openConv(c.id)}
                data-testid="conversation-row"
                className={`w-full text-left px-3 py-2 border-b border-[var(--edge-soft)] hover:bg-stone-100 dark:hover:bg-stone-800/50 transition-colors ${
                  c.id === activeId ? 'bg-accent/[0.06]' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-stone-900 dark:text-stone-100 truncate inline-flex items-center gap-1.5">
                    <Icon
                      name={c.kind === 'channel' ? 'tag' : c.kind === 'space' ? 'folder_shared' : 'person'}
                      size={13}
                      className="text-stone-400"
                    />
                    {c.kind === 'channel'
                      ? `#${c.title}`
                      : c.kind === 'dm'
                        ? personDisplayName(
                            c.members.find((m) => m.accountId !== account.id),
                            c.title
                          )
                        : c.title}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="shrink-0 text-[10px] font-semibold text-white bg-accent rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                      {c.unreadCount}
                    </span>
                  )}
                </div>
                {c.lastMessage && (
                  <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate mt-0.5 flex items-center gap-1">
                    {c.lastMessage.attachment && <Icon name="attach_file" size={11} />}
                    {c.lastMessage.body || attachmentPreviewLabel(c.lastMessage.attachment)}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Thread */}
      <div
        className={
          compact
            ? `${activeId && compactPane === 'thread' ? 'flex' : 'hidden'} flex-1 min-h-0 flex-col min-w-0`
            : 'flex-1 flex flex-col min-w-0'
        }
        data-testid="messages-thread-pane"
      >
        {!activeId ? (
          <div className="flex-1 flex items-center justify-center text-[13px] text-stone-500 dark:text-stone-400">
            Pick a conversation, or start a new one.
          </div>
        ) : (
          // Gate on activeId, not activeConv: a conversation opened from
          // PlexiInbox sets activeId before it has landed in the conversations
          // list, and the receiver must be able to reply immediately. Title
          // falls back until the list catches up.
          <>
            <div className={`${compact ? 'px-3 py-2' : 'px-4 py-3'} border-b border-[var(--edge-soft)] flex items-center gap-2 justify-between`}>
              {compact && (
                <button
                  onClick={() => setCompactPane('list')}
                  className="icon-btn shrink-0"
                  title="All conversations"
                  aria-label="All conversations"
                  data-testid="messages-back"
                >
                  <Icon name="arrow_back" size={16} />
                </button>
              )}
              <h2
                className={`text-sm font-semibold text-stone-900 dark:text-stone-100 inline-flex items-center gap-1.5 min-w-0 ${compact ? 'flex-1' : ''}`}
                title={compact ? panelTitle : undefined}
              >
                <Icon name={activeConv?.kind === 'space' ? 'folder_shared' : 'person'} size={14} className="text-accent shrink-0" />
                <span className="truncate">{compact ? panelTitle : headerTitle}</span>
              </h2>
              {/* DEC-123 put the panel's doors on their own row; DEC-131 moves
                  them to the right of the name — Meet · Recall · pin, the
                  three the panel keeps (the members button is the name now;
                  Pulse and Schedules stay on the Office page). */}
              <div className="flex items-center gap-1.5 shrink-0" data-testid="messages-actions">
                {callTarget && !compact && (
                  <button
                    onClick={() => void startCall(callTarget, 'video')}
                    aria-label={`Call ${callTargetName}`}
                    title="Start a video call"
                    data-testid="messages-call"
                    className={hdrBtn}
                  >
                    <Icon name="videocam" size={15} /> Call
                  </button>
                )}
                {/* Compact (DEC-123): Call and Meet are one door — a DM meets the
                    person now (the 1:1 video call); a space opens PlexiMeet. The
                    Office page keeps both buttons. */}
                <button
                  onClick={() => (compact && callTarget ? void startCall(callTarget, 'video') : goMeetings())}
                  aria-label={compact && callTarget ? `Meet with ${callTargetName}` : undefined}
                  title={compact && callTarget ? `Meet with ${callTargetName} now — a video call` : 'Start a meeting in PlexiMeet'}
                  data-testid="messages-meet"
                  className={hdrBtn}
                >
                  <Icon name={compact && callTarget ? 'videocam' : 'groups'} size={15} /> Meet
                </button>
                {activeId && !compact && (
                  <select
                    value={translateLang}
                    onChange={(e) => setTranslateLang(e.target.value)}
                    title="Translate messages to"
                    data-testid="messages-translate-lang"
                    className="fb-field w-auto h-8 text-[12px] text-[var(--ink-70)] px-1.5 hover:bg-[var(--surface-sunken)]"
                  >
                    {['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Arabic']
                      .concat(
                        ['English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Chinese', 'Japanese', 'Korean', 'Hindi', 'Arabic'].includes(
                          translateLang
                        )
                          ? []
                          : [translateLang]
                      )
                      .map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                  </select>
                )}
                {activeId && (
                  <button
                    onClick={() => setShowRecall(true)}
                    title="Catch up or ask this channel"
                    data-testid="messages-recall"
                    className={hdrBtn}
                  >
                    <Icon name="bolt" size={15} /> Recall
                  </button>
                )}
                {activeId && activeConv && activeConv.kind !== 'dm' && !compact && (
                  <button
                    onClick={() => setShowPulse(true)}
                    title="Decisions, questions and action items in this channel"
                    data-testid="messages-pulse"
                    className={hdrBtn}
                  >
                    <Icon name="radar" size={15} /> Pulse
                  </button>
                )}
                {activeId && activeConv && activeConv.kind !== 'dm' && !compact && (
                  <button
                    onClick={() => setShowSchedules(true)}
                    title="Scheduled AI tasks for this channel"
                    data-testid="messages-schedules"
                    className={hdrBtn}
                  >
                    <Icon name="schedule" size={15} /> Schedules
                  </button>
                )}
                {activeId && activeConv && !compact && (
                  <div className="relative">
                    <button
                      onClick={() => setShowMembers((v) => !v)}
                      title="Members"
                      data-testid="messages-members"
                      className={hdrBtn}
                    >
                      <Icon name="group" size={15} /> {activeConv.members.length}
                    </button>
                    {showMembers && (
                      <div
                        className="fb-glass-panel rounded-[var(--radius-row)] fb-pop-in absolute right-0 top-full mt-1 z-30 w-64 p-2"
                        data-testid="members-popover"
                      >
                        {activeConv.kind === 'channel' && (
                          <button
                            onClick={() =>
                              void setVisibility(activeId, activeConv.visibility === 'public' ? 'private' : 'public')
                            }
                            className="w-full flex items-center gap-1.5 text-[11px] text-[var(--ink-70)] hover:text-[var(--ink-100)] px-1 py-1 mb-1"
                          >
                            <Icon name={activeConv.visibility === 'public' ? 'public' : 'lock'} size={13} />
                            {activeConv.visibility === 'public' ? 'Public channel' : 'Private channel'} · make{' '}
                            {activeConv.visibility === 'public' ? 'private' : 'public'}
                          </button>
                        )}
                        <div className="max-h-48 overflow-auto space-y-0.5">
                          {activeConv.members.map((mem) => (
                            <div key={mem.accountId} className="flex items-center gap-2 px-1 py-1 text-[12px]">
                              <span className="flex-1 min-w-0 truncate text-[var(--ink-90)]">
                                {personDisplayName(mem, mem.handle ?? 'Member')}
                                {mem.accountId === account.id && ' (you)'}
                              </span>
                              {mem.accountId !== account.id && (
                                <button
                                  onClick={() => void removeMember(activeId, mem.accountId)}
                                  title="Remove"
                                  className="text-[var(--ink-40)] hover:text-red-500"
                                >
                                  <Icon name="close" size={12} />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="mt-1.5 flex gap-1">
                          <input
                            value={addMemberHandle}
                            onChange={(e) => setAddMemberHandle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && addMemberHandle.trim()) {
                                void addMemberByHandle(activeId, addMemberHandle).then((r) => {
                                  if (r.ok) {
                                    setAddMemberHandle('')
                                    setMemberError(null)
                                  } else setMemberError(r.error ?? 'Could not add.')
                                })
                              }
                            }}
                            placeholder="@handle to add"
                            data-testid="members-add-handle"
                            className="fb-field flex-1 px-2 py-1 text-[11px]"
                          />
                        </div>
                        {memberError && <div className="text-[10px] text-red-500 mt-1">{memberError}</div>}
                        <button
                          onClick={() => {
                            void removeMember(activeId, account.id)
                            setShowMembers(false)
                          }}
                          className="w-full mt-1.5 text-[11px] text-red-500 hover:text-red-600 px-1 py-1 text-left"
                          data-testid="members-leave"
                        >
                          Leave conversation
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {/* The notification-level bell stays on the Office page; in the
                    panel the bell means Attention (DEC-124). */}
                {activeId && !compact && (
                  <button
                    onClick={() => {
                      const cur = activeConv?.notifLevel ?? 'all'
                      const next = cur === 'all' ? 'mentions' : cur === 'mentions' ? 'muted' : 'all'
                      void setNotif(activeId, next)
                    }}
                    title={`Notifications: ${activeConv?.notifLevel ?? 'all'} (click to cycle all → mentions → muted)`}
                    data-testid="messages-notif"
                    className={hdrIconBtn}
                  >
                    <Icon
                      name={
                        activeConv?.notifLevel === 'muted'
                          ? 'notifications_off'
                          : activeConv?.notifLevel === 'mentions'
                            ? 'alternate_email'
                            : 'notifications'
                      }
                      size={15}
                    />
                  </button>
                )}
                <button
                  onClick={() => pinToCanvas()}
                  title="Pin this conversation to your current desk"
                  data-testid="messages-pin"
                  className={hdrIconBtn}
                >
                  <Icon name="push_pin" size={15} />
                </button>
              </div>
            </div>
            {pins.length > 0 && (
              <div
                className="shrink-0 border-b border-[var(--edge-soft)] bg-[color-mix(in_oklab,var(--surface-sunken)_60%,transparent)] px-4 py-1.5"
                data-testid="pinned-bar"
              >
                <div className="text-[10px] uppercase tracking-[0.1em] text-[var(--ink-45)] mb-1 inline-flex items-center gap-1">
                  <Icon name="keep" size={11} filled /> {pins.length} pinned
                </div>
                <div className="space-y-1">
                  {pins.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-start gap-2 text-[11.5px] text-[var(--ink-80)]"
                      data-testid={`pinned-item-${p.id}`}
                    >
                      <span className="flex-1 min-w-0 truncate">{p.body || '(attachment)'}</span>
                      {activeId && (
                        <button
                          onClick={() => void unpinMsg(activeId, p.id)}
                          title="Unpin"
                          className="shrink-0 text-[var(--ink-40)] hover:text-accent"
                        >
                          <Icon name="close" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div ref={threadRef} className="flex-1 overflow-auto px-4 py-3 space-y-2">
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  mine={m.fromAccount === account.id}
                  myId={account.id}
                  translateLang={translateLang}
                  onReact={(emoji) => void react(m.id, emoji)}
                  onCapture={() => captureMessage(m)}
                  marked={markedFor(m.id)}
                  onOpenThread={() => void openThread(m.id)}
                  onEdit={(b) => void editMessage(m.id, b)}
                  onDelete={() => void deleteMessage(m.id)}
                  pinned={pinnedIds.has(m.id)}
                  onTogglePin={
                    activeId
                      ? () =>
                          void (pinnedIds.has(m.id)
                            ? unpinMsg(activeId, m.id)
                            : pinMsg(activeId, m.id))
                      : undefined
                  }
                />
              ))}
            </div>
            <div className="h-4 px-4 text-[11px] text-stone-500 dark:text-stone-400 italic" data-testid="typing-indicator">
              {typingLabel}
            </div>
            {activeId && sessionToken && (
              <ChatComposer
                conversationId={activeId}
                token={sessionToken}
                onSend={(body, attachment) => send(body, attachment)}
                onTyping={notifyTyping}
                compact={compact}
              />
            )}
          </>
        )}
      </div>

      {activeThreadId && (
        <ThreadPanel
          parentId={activeThreadId}
          parent={messages.find((m) => m.id === activeThreadId) ?? null}
          myId={account.id}
          onCapture={captureMessage}
          markedFor={markedFor}
        />
      )}
    </div>
  )
}

// The thread panel: the parent message, its replies, and a reply composer. Opens
// as a right-side column when a message's thread is opened.
function ThreadPanel({
  parentId,
  parent,
  myId,
  onCapture,
  markedFor
}: {
  parentId: string
  parent: ChatMessage | null
  myId: string
  /** DEC-124 — the bell on the parent and every reply. */
  onCapture?: (m: ChatMessage) => void
  markedFor?: (id: string) => FbNode | null
}): JSX.Element {
  const threadsByParent = useMessagingStore((s) => s.threadsByParent)
  const sendThreadReply = useMessagingStore((s) => s.sendThreadReply)
  const react = useMessagingStore((s) => s.react)
  const closeThread = useMessagingStore((s) => s.closeThread)
  const token = useMessagingStore((s) => s.token)
  const replies = threadsByParent[parentId] ?? []
  const [draft, setDraft] = useState('')
  const [summary, setSummary] = useState<ThreadSummaryResult | null>(null)
  const [summarising, setSummarising] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const conversationId = parent?.conversationId ?? null

  async function onSummarise(): Promise<void> {
    if (!token || !conversationId) return
    setSummarising(true)
    const r = await summarizeThread(token, conversationId, parentId)
    setSummarising(false)
    setSummary(r)
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [replies.length])

  async function submit(): Promise<void> {
    const body = draft
    setDraft('')
    await sendThreadReply(parentId, body)
  }

  return (
    <div
      className="w-80 shrink-0 border-l border-[var(--edge-soft)] flex flex-col"
      data-testid="thread-panel"
    >
      <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100 inline-flex items-center gap-1.5">
          <Icon name="forum" size={14} className="text-accent" /> Thread
        </h2>
        <div className="flex items-center gap-1">
          {replies.length >= 3 && (
            <button
              onClick={() => void onSummarise()}
              disabled={summarising}
              className="fb-btn-surface inline-flex items-center gap-1 h-7 px-2 text-[11px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
              title="Summarise this thread"
              data-testid="thread-summarise"
            >
              <Icon name="bolt" size={12} /> {summarising ? '…' : 'Summarise'}
            </button>
          )}
          <button onClick={closeThread} className="icon-btn" aria-label="Close thread" data-testid="thread-close">
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
      {summary && (
        <div className="px-4 py-2 border-b border-[var(--edge-soft)] bg-[var(--surface-sunken)]" data-testid="thread-summary">
          {!summary.available ? (
            <p className="text-[11px] text-[var(--ink-50)]">
              {summary.reason === 'no-key'
                ? 'Summaries need the workspace AI key (Channels, AI member).'
                : 'Summary unavailable here.'}
            </p>
          ) : summary.summary ? (
            <>
              <div className="text-[12px] text-[var(--ink-100)] leading-snug">{summary.summary}</div>
              {summary.sources.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {summary.sources.map((s) => (
                    <button
                      key={s.ref}
                      onClick={() => jumpToMessage(s.messageId)}
                      className="text-[10.5px] text-accent hover:underline"
                      title={`${s.fromName}: ${s.excerpt}`}
                    >
                      [{s.ref}]
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-[11px] text-[var(--ink-50)]">Could not summarise right now.</p>
          )}
        </div>
      )}
      <div className="flex-1 overflow-auto px-4 py-3 space-y-2">
        {parent && (
          <>
            <MessageRow
              m={parent}
              mine={parent.fromAccount === myId}
              myId={myId}
              translateLang={localStorage.getItem('plexi-translate-lang') || 'English'}
              onReact={(e) => void react(parent.id, e)}
              onCapture={onCapture ? () => onCapture(parent) : undefined}
              marked={markedFor ? markedFor(parent.id) : null}
            />
            <div className="text-[10px] uppercase tracking-wide text-stone-400 border-b border-[var(--edge-soft)] pb-1">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </div>
          </>
        )}
        {replies.map((m) => (
          <MessageRow
            key={m.id}
            m={m}
            mine={m.fromAccount === myId}
            myId={myId}
            translateLang={localStorage.getItem('plexi-translate-lang') || 'English'}
            onReact={(e) => void react(m.id, e)}
            onCapture={onCapture ? () => onCapture(m) : undefined}
            marked={markedFor ? markedFor(m.id) : null}
          />
        ))}
        <div ref={endRef} />
      </div>
      <div className="px-3 py-3 border-t border-[var(--edge-soft)] flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="Reply…"
          rows={1}
          data-testid="thread-composer"
          className="fb-field flex-1 resize-none px-3 py-2 text-[13px]"
        />
        <button
          onClick={() => void submit()}
          disabled={!draft.trim()}
          className="btn-primary"
          data-testid="thread-send"
        >
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  )
}

// Scroll a message into view and flash it, so a recall source citation links
// back to the real message it came from.
function jumpToMessage(messageId: string): void {
  const el = document.getElementById(`msg-${messageId}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.style.backgroundColor = 'rgb(var(--accent) / 0.14)'
  window.setTimeout(() => {
    el.style.backgroundColor = ''
  }, 1600)
}

// PlexiChat 2100 — the "what needs me" briefing. One cross-channel view of what
// actually requires you: where you were named, AI proposals waiting on your
// decision, and the open questions and action items across your channels. Real
// data only, no AI call. Each item jumps you to the exact place. This is the
// antidote to the unread badge: read what needs you, not everything.
export function BriefingPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const token = useMessagingStore((s) => s.token)
  const openConversation = useMessagingStore((s) => s.openConversation)
  const [b, setB] = useState<Briefing | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!token) return
      const res = await getBriefing(token)
      if (alive) setB(res)
    })()
    return () => {
      alive = false
    }
  }, [token])

  function go(conversationId: string, messageId?: string): void {
    void openConversation(conversationId)
    onClose()
    if (messageId) window.setTimeout(() => jumpToMessage(messageId), 500)
  }

  const total = b ? b.mentions.length + b.pendingProposals.length + b.questions.length + b.actions.length : 0

  function Section({
    title,
    icon,
    children,
    count
  }: {
    title: string
    icon: string
    count: number
    children: ReactNode
  }): JSX.Element | null {
    if (count === 0) return null
    return (
      <div>
        <div className="text-[10.5px] uppercase tracking-wide text-[var(--ink-40)] inline-flex items-center gap-1 mb-1">
          <Icon name={icon} size={12} /> {title} <span className="text-[var(--ink-30)]">{count}</span>
        </div>
        <div className="space-y-1">{children}</div>
      </div>
    )
  }

  function Row({
    title,
    sub,
    onClick,
    testid
  }: {
    title: string
    sub: string
    onClick: () => void
    testid: string
  }): JSX.Element {
    return (
      <button
        onClick={onClick}
        data-testid={testid}
        className="fb-btn-surface w-full text-left p-2 hover:bg-[var(--surface-sunken)]"
      >
        <div className="text-[12.5px] text-[var(--ink-100)] break-words">{title}</div>
        <div className="text-[11px] text-[var(--ink-50)] truncate">{sub}</div>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="briefing-panel"
    >
      <div
        className="fb-card fb-press w-[500px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--ink-100)] inline-flex items-center gap-1.5">
            <Icon name="flag" size={15} className="text-accent" /> Needs you
          </h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close" data-testid="briefing-close">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
          {b === null ? (
            <p className="text-[12px] text-[var(--ink-50)]">Gathering what needs you…</p>
          ) : total === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)] leading-snug">
              Nothing needs you right now. No unread mentions, no proposals waiting, no open questions in your channels.
            </p>
          ) : (
            <>
              <Section title="Mentioned you" icon="alternate_email" count={b.mentions.length}>
                {b.mentions.map((m) => (
                  <Row
                    key={m.messageId}
                    testid="briefing-mention"
                    title={`${m.fromName}: ${m.excerpt}`}
                    sub={m.conversationTitle}
                    onClick={() => go(m.conversationId, m.messageId)}
                  />
                ))}
              </Section>
              <Section title="Awaiting your decision" icon="task_alt" count={b.pendingProposals.length}>
                {b.pendingProposals.map((p) => (
                  <Row
                    key={p.messageId}
                    testid="briefing-proposal"
                    title="Plexii proposed an action"
                    sub={p.conversationTitle}
                    onClick={() => go(p.conversationId, p.messageId)}
                  />
                ))}
              </Section>
              <Section title="Open questions" icon="help" count={b.questions.length}>
                {b.questions.map((q) => (
                  <Row
                    key={q.extractId}
                    testid="briefing-question"
                    title={q.text}
                    sub={q.conversationTitle}
                    onClick={() => go(q.conversationId, q.sourceMessageId ?? undefined)}
                  />
                ))}
              </Section>
              <Section title="Action items" icon="checklist" count={b.actions.length}>
                {b.actions.map((a) => (
                  <Row
                    key={a.extractId}
                    testid="briefing-action"
                    title={a.text}
                    sub={a.conversationTitle}
                    onClick={() => go(a.conversationId, a.sourceMessageId ?? undefined)}
                  />
                ))}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// PlexiChat 2100 — Channel Pulse. A channel's durable meaning: the decisions it
// reached, the questions still open, the action items someone owns, each linked to
// the message it came from. Read the state of the room, not the transcript.
// Refresh is opt-in (no background AI cost); honest and dark without the org key.
export function PulsePanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }): JSX.Element {
  const token = useMessagingStore((s) => s.token)
  const [items, setItems] = useState<PulseItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!token) return
      const list = await getPulse(token, conversationId)
      if (alive) setItems(list)
    })()
    return () => {
      alive = false
    }
  }, [token, conversationId])

  async function onRefresh(): Promise<void> {
    if (!token) return
    setBusy(true)
    setNote(null)
    const r = await refreshPulse(token, conversationId)
    setBusy(false)
    setItems(r.items)
    if (!r.available) {
      setNote(
        r.reason === 'no-key'
          ? 'Pulse needs the workspace AI key (Channels, AI member).'
          : r.reason === 'no-org'
            ? 'Pulse works in organisation channels.'
            : 'Pulse is unavailable right now.'
      )
    } else {
      setNote(r.added > 0 ? `Found ${r.added} new item${r.added === 1 ? '' : 's'}.` : 'Nothing new to surface.')
    }
  }

  async function onCreateTask(it: PulseItem): Promise<void> {
    if (!token) return
    const res = await applyProposal(
      { id: `pulse-${it.id}`, kind: 'create-task', title: it.text.slice(0, 200) },
      { activeTaskId: null }
    )
    setNote(res.ok ? 'Desk created.' : res.message || 'Could not create the desk.')
  }

  const open = (items ?? []).filter((i) => i.status === 'open')
  const groups: Array<{ kind: PulseItem['kind']; label: string; icon: string }> = [
    { kind: 'decision', label: 'Decisions', icon: 'check_circle' },
    { kind: 'question', label: 'Open questions', icon: 'help' },
    { kind: 'action', label: 'Desks to create', icon: 'task_alt' }
  ]

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="pulse-panel"
    >
      <div
        className="fb-card fb-press w-[500px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--ink-100)] inline-flex items-center gap-1.5">
            <Icon name="radar" size={15} className="text-accent" /> Pulse
          </h2>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void onRefresh()}
              disabled={busy}
              className="fb-btn-surface inline-flex items-center gap-1 h-7 px-2.5 text-[11.5px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
              data-testid="pulse-refresh"
            >
              <Icon name="refresh" size={13} /> {busy ? 'Reading…' : 'Refresh'}
            </button>
            <button onClick={onClose} className="icon-btn" aria-label="Close" data-testid="pulse-close">
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>

        {note && <div className="px-4 pt-2 text-[11px] text-[var(--ink-50)]">{note}</div>}

        <div className="flex-1 overflow-auto px-4 py-3 space-y-3">
          {items === null ? (
            <p className="text-[12px] text-[var(--ink-50)]">Loading…</p>
          ) : open.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)] leading-snug">
              No pulse yet. Refresh to surface the decisions, open questions, and action items from this channel.
            </p>
          ) : (
            groups.map((g) => {
              const groupItems = open.filter((i) => i.kind === g.kind)
              if (groupItems.length === 0) return null
              return (
                <div key={g.kind}>
                  <div className="text-[10.5px] uppercase tracking-wide text-[var(--ink-40)] inline-flex items-center gap-1 mb-1">
                    <Icon name={g.icon} size={12} /> {g.label}
                  </div>
                  <div className="space-y-1">
                    {groupItems.map((it) => (
                      <div
                        key={it.id}
                        className="rounded-lg bg-[var(--surface-sunken)] p-2 flex items-start gap-2"
                        data-testid="pulse-item"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-[12.5px] text-[var(--ink-100)] break-words">{it.text}</div>
                          {it.sourceMessageId && (
                            <button
                              onClick={() => {
                                jumpToMessage(it.sourceMessageId as string)
                                onClose()
                              }}
                              className="mt-0.5 text-[11px] text-accent hover:underline inline-flex items-center gap-0.5"
                            >
                              <Icon name="arrow_outward" size={11} /> source
                            </button>
                          )}
                        </div>
                        {it.kind === 'action' && (
                          <button
                            onClick={() => void onCreateTask(it)}
                            title="Create a task"
                            className="text-[var(--ink-50)] hover:text-accent"
                            data-testid={`pulse-task-${it.id}`}
                          >
                            <Icon name="add_task" size={16} />
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            if (token) {
                              await setPulseStatus(token, conversationId, it.id, 'resolved')
                              setItems((cur) => (cur ?? []).map((x) => (x.id === it.id ? { ...x, status: 'resolved' } : x)))
                            }
                          }}
                          title="Resolve"
                          className="text-[var(--ink-50)] hover:text-emerald-500"
                          data-testid={`pulse-resolve-${it.id}`}
                        >
                          <Icon name="done" size={16} />
                        </button>
                        <button
                          onClick={async () => {
                            if (token) {
                              await deletePulseItem(token, conversationId, it.id)
                              setItems((cur) => (cur ?? []).filter((x) => x.id !== it.id))
                            }
                          }}
                          title="Dismiss"
                          className="text-[var(--ink-40)] hover:text-red-500"
                          data-testid={`pulse-delete-${it.id}`}
                        >
                          <Icon name="close" size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// PlexiChat 2100 — Channel Recall. The end of scroll-archaeology: catch up on what
// changed since you last read, or ask the channel a question and get an answer
// pulled from its real history with clickable source citations. Read-only and
// private to you; nothing is posted to the channel. Honest states throughout:
// when the workspace AI key is not set it says so instead of faking an answer.
export function RecallPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }): JSX.Element {
  const token = useMessagingStore((s) => s.token)
  const [catchup, setCatchup] = useState<RecallResult | null>(null)
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<RecallResult | null>(null)
  const [askBusy, setAskBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setCatchup(null)
    void (async () => {
      if (!token) return
      const r = await recallChannel(token, conversationId, 'catchup')
      if (alive) setCatchup(r)
    })()
    return () => {
      alive = false
    }
  }, [token, conversationId])

  async function onAsk(): Promise<void> {
    if (!token || !question.trim()) return
    setAskBusy(true)
    setAsked(null)
    const r = await recallChannel(token, conversationId, 'ask', question.trim())
    setAskBusy(false)
    setAsked(r)
  }

  function unavailableNote(r: RecallResult): string | null {
    if (r.available) return null
    if (r.reason === 'no-key')
      return 'Recall needs the workspace AI key. An admin can add it under Channels, AI member.'
    if (r.reason === 'no-org') return 'Recall works in organisation channels, not personal DMs.'
    return 'Recall is unavailable right now.'
  }

  function Result({ r, emptyText }: { r: RecallResult; emptyText: string }): JSX.Element {
    const note = unavailableNote(r)
    if (note) return <p className="text-[12px] text-[var(--ink-50)] leading-snug">{note}</p>
    if (r.empty) return <p className="text-[12px] text-[var(--ink-50)]">{emptyText}</p>
    if (!r.answer)
      return <p className="text-[12px] text-[var(--ink-50)]">Could not generate that right now. Try again shortly.</p>
    return (
      <div>
        <div className="text-[12.5px] text-[var(--ink-100)] whitespace-pre-wrap leading-snug">{r.answer}</div>
        {r.sources.length > 0 && (
          <div className="mt-2 space-y-1">
            <div className="text-[10.5px] uppercase tracking-wide text-[var(--ink-40)]">Sources</div>
            {r.sources.map((s) => (
              <button
                key={s.ref}
                onClick={() => {
                  jumpToMessage(s.messageId)
                  onClose()
                }}
                className="w-full text-left flex gap-1.5 px-1.5 py-1 rounded hover:bg-[var(--surface-sunken)]"
                data-testid={`recall-source-${s.ref}`}
              >
                <span className="text-[11px] text-accent shrink-0">[{s.ref}]</span>
                <span className="min-w-0 text-[11px] text-[var(--ink-70)] truncate">
                  <span className="text-[var(--ink-90)]">{s.fromName}:</span> {s.excerpt}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="recall-panel"
    >
      <div
        className="fb-card fb-press w-[480px] max-h-[78vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--ink-100)] inline-flex items-center gap-1.5">
            <Icon name="bolt" size={15} className="text-accent" /> Recall
          </h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close" data-testid="recall-close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          <div className="px-4 py-3 border-b border-[var(--edge-soft)]">
            <div className="text-[11px] font-semibold text-[var(--ink-70)] mb-1.5">Since you last read</div>
            {catchup === null ? (
              <p className="text-[12px] text-[var(--ink-50)]">Reading the channel…</p>
            ) : (
              <Result r={catchup} emptyText="Nothing new since you last read." />
            )}
          </div>

          <div className="px-4 py-3">
            <div className="text-[11px] font-semibold text-[var(--ink-70)] mb-1.5">Ask this channel</div>
            <div className="flex gap-1.5">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void onAsk()}
                placeholder="e.g. what did we decide about the launch date?"
                data-testid="recall-ask-input"
                className="fb-field flex-1 px-2 py-1 text-[12px] text-[var(--ink-90)]"
              />
              <button
                onClick={() => void onAsk()}
                disabled={!question.trim() || askBusy}
                className="btn-primary px-3 py-1 text-[12px] disabled:opacity-40"
                data-testid="recall-ask"
              >
                {askBusy ? '…' : 'Ask'}
              </button>
            </div>
            {asked && (
              <div className="mt-2">
                <Result r={asked} emptyText="Nothing to answer from." />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// PlexiChat P5: recurring AI tasks bound to a channel. Members create a plain-
// language instruction on a daily/weekly/monthly cadence; the server runs it as
// the AI member even when everyone is offline. No fabrication: an honest empty
// state and real enabled/next-run status.
export function SchedulesPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }): JSX.Element {
  const token = useMessagingStore((s) => s.token)
  const [items, setItems] = useState<ChannelSchedule[] | null>(null)
  const [instruction, setInstruction] = useState('')
  const [recurrence, setRecurrence] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [busy, setBusy] = useState(false)

  async function refresh(): Promise<void> {
    if (!token) return
    setItems(await listSchedules(token, conversationId))
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, conversationId])

  async function onAdd(): Promise<void> {
    if (!token || !instruction.trim()) return
    setBusy(true)
    const created = await createSchedule(token, conversationId, { instruction: instruction.trim(), recurrence })
    setBusy(false)
    if (created) {
      setInstruction('')
      void refresh()
    }
  }

  function fmtNext(ms: number): string {
    try {
      return new Date(ms).toLocaleString()
    } catch {
      return '—'
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="schedules-panel"
    >
      <div
        className="fb-card fb-press w-[460px] max-h-[75vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--ink-100)] inline-flex items-center gap-1.5">
            <Icon name="schedule" size={15} className="text-accent" /> Scheduled AI tasks
          </h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close" data-testid="schedules-close">
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="px-4 pt-3 pb-2 border-b border-[var(--edge-soft)]">
          <p className="text-[11px] text-[var(--ink-50)] leading-snug mb-1.5">
            Plexii runs these on a timer, even when everyone is offline, and posts the result here. It needs the org&apos;s
            AI key set (Channels, AI member).
          </p>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. Post a short standup prompt and summarise yesterday's messages"
            data-testid="schedule-instruction"
            rows={2}
            className="fb-field w-full px-2 py-1 text-[12px] text-[var(--ink-90)] resize-none"
          />
          <div className="flex gap-1.5 mt-1.5">
            <select
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value as 'daily' | 'weekly' | 'monthly')}
              data-testid="schedule-recurrence"
              className="fb-field w-auto px-2 py-1 text-[12px] text-[var(--ink-90)]"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <button
              onClick={() => void onAdd()}
              disabled={!instruction.trim() || busy}
              className="btn-primary px-3 py-1 text-[12px] disabled:opacity-40"
              data-testid="schedule-add"
            >
              Add task
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto px-4 py-3 space-y-2">
          {items === null ? (
            <p className="text-[12px] text-[var(--ink-50)]">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)] leading-snug">No scheduled tasks yet.</p>
          ) : (
            items.map((s) => (
              <div
                key={s.id}
                className="rounded-lg bg-[var(--surface-sunken)] p-2 flex items-start gap-2"
                data-testid="schedule-row"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12.5px] text-[var(--ink-100)] break-words">{s.instruction}</div>
                  <div className="text-[11px] text-[var(--ink-50)] mt-0.5">
                    {s.recurrence} · next {fmtNext(s.nextRunAt)}
                    {s.enabled ? '' : ' · paused'}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (token) {
                      await setScheduleEnabled(token, conversationId, s.id, !s.enabled)
                      void refresh()
                    }
                  }}
                  title={s.enabled ? 'Pause' : 'Resume'}
                  className="text-[var(--ink-50)] hover:text-[var(--ink-100)]"
                  data-testid={`schedule-toggle-${s.id}`}
                >
                  <Icon name={s.enabled ? 'pause' : 'play_arrow'} size={16} />
                </button>
                <button
                  onClick={async () => {
                    if (token) {
                      await deleteSchedule(token, conversationId, s.id)
                      void refresh()
                    }
                  }}
                  title="Delete"
                  className="text-[var(--ink-40)] hover:text-red-500"
                  data-testid={`schedule-delete-${s.id}`}
                >
                  <Icon name="delete" size={16} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

// PlexiChat 2100 named role-agents: an org admin can add extra AI teammates
// beyond @plexi, each with its own @handle, name, and role. Mention one in any
// channel to get a reply in that persona. Requires the org AI key to actually
// reply (honest: it says so). Admin-gated by the caller.
function BotRolesConfig({ token, orgId }: { token: string; orgId: string }): JSX.Element {
  const [roles, setRoles] = useState<BotRole[] | null>(null)
  const [handle, setHandle] = useState('')
  const [name, setName] = useState('')
  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setRoles(await listBotRoles(token, orgId))
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, orgId])

  async function onAdd(): Promise<void> {
    if (!handle.trim() || !name.trim()) return
    setBusy(true)
    setErr(null)
    const res = await createBotRole(token, orgId, {
      handle: handle.trim(),
      name: name.trim(),
      instructions: instructions.trim()
    })
    setBusy(false)
    if (res.ok) {
      setHandle('')
      setName('')
      setInstructions('')
      void refresh()
    } else {
      setErr(res.error)
    }
  }

  return (
    <div className="px-4 py-3 border-t border-[var(--edge-soft)]" data-testid="bot-roles-config">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon name="smart_toy" size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-[var(--ink-100)]">AI teammates</span>
      </div>
      <p className="text-[11px] text-[var(--ink-50)] leading-snug mb-1.5">
        Add named AI members beyond @plexi. Mention one by its handle in any channel and it replies in its role.
      </p>
      {roles && roles.length > 0 && (
        <div className="space-y-1 mb-1.5">
          {roles.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-[12px]" data-testid="bot-role-row">
              <span className="text-accent">@{r.handle}</span>
              <span className="text-[var(--ink-70)] truncate flex-1 min-w-0">{r.name}</span>
              <button
                onClick={async () => {
                  await deleteBotRole(token, orgId, r.id)
                  void refresh()
                }}
                className="text-[var(--ink-40)] hover:text-red-500"
                title="Remove"
                data-testid={`bot-role-delete-${r.id}`}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-1.5">
        <input
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value)
            setErr(null)
          }}
          placeholder="handle"
          data-testid="bot-role-handle"
          className="fb-field w-24 px-2 py-1 text-[12px] text-[var(--ink-90)]"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          data-testid="bot-role-name"
          className="fb-field flex-1 px-2 py-1 text-[12px] text-[var(--ink-90)]"
        />
      </div>
      <textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        placeholder="What is this agent's role? (e.g. research questions and summarise findings)"
        rows={2}
        data-testid="bot-role-instructions"
        className="fb-field w-full mt-1.5 px-2 py-1 text-[12px] text-[var(--ink-90)] resize-none"
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button
          onClick={() => void onAdd()}
          disabled={!handle.trim() || !name.trim() || busy}
          className="btn-primary px-3 py-1 text-[12px] disabled:opacity-40"
          data-testid="bot-role-add"
        >
          Add agent
        </button>
        {err && <span className="text-[11px] text-red-500">{err}</span>}
      </div>
    </div>
  )
}

// PlexiChat P3: an org admin can give the workspace's AI chat member (@plexi) an
// Anthropic key so it can reply on the server. The key is write-only from here —
// we only ever learn whether one is configured, never read it back. Honest states
// throughout: if the server can't store keys we say so rather than pretending.
function AiMemberConfig({ token, orgId }: { token: string; orgId: string }): JSX.Element | null {
  const [status, setStatus] = useState<{ configured: boolean; serverSupported: boolean } | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setStatus(null)
    setKey('')
    setMsg(null)
    void (async () => {
      const s = await getOrgAiKeyStatus(token, orgId)
      if (alive) setStatus(s)
    })()
    return () => {
      alive = false
    }
  }, [token, orgId])

  if (!status) return null

  async function onSave(): Promise<void> {
    if (!key.trim()) return
    setBusy(true)
    setMsg(null)
    const ok = await setOrgAiKey(token, orgId, key.trim())
    setBusy(false)
    if (ok) {
      setKey('')
      setStatus((s) => (s ? { ...s, configured: true } : s))
      setMsg('Key saved. @plexi can now reply in this workspace.')
    } else {
      setMsg('Could not save the key.')
    }
  }

  async function onRemove(): Promise<void> {
    setBusy(true)
    setMsg(null)
    const ok = await clearOrgAiKey(token, orgId)
    setBusy(false)
    if (ok) {
      setStatus((s) => (s ? { ...s, configured: false } : s))
      setMsg('Key removed. @plexi will stay quiet until a new key is added.')
    }
  }

  return (
    <div className="px-4 py-3 border-t border-[var(--edge-soft)]" data-testid="ai-member-config">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Icon name="sparkles" size={14} className="text-accent" />
        <span className="text-[12px] font-semibold text-[var(--ink-100)]">AI member (@plexi)</span>
        <span
          className={`ml-auto text-[11px] ${status.configured ? 'text-emerald-500' : 'text-[var(--ink-50)]'}`}
          data-testid="ai-member-status"
        >
          {status.configured ? 'Active' : 'Not configured'}
        </span>
      </div>
      {!status.serverSupported ? (
        <p className="text-[11px] text-[var(--ink-50)] leading-snug">
          Server-side AI replies are not enabled on this workspace&apos;s server yet, so @plexi cannot reply. Once the
          server is configured for it, add your key here.
        </p>
      ) : (
        <>
          <p className="text-[11px] text-[var(--ink-50)] leading-snug mb-1.5">
            Paste your organisation&apos;s Anthropic API key. Mention @plexi in any channel and it replies as a member.
            The key is stored encrypted and is never shown again.
          </p>
          <div className="flex gap-1.5">
            <input
              type="password"
              value={key}
              onChange={(e) => {
                setKey(e.target.value)
                setMsg(null)
              }}
              placeholder={status.configured ? 'Replace key (sk-ant-…)' : 'sk-ant-…'}
              data-testid="ai-member-key-input"
              className="fb-field flex-1 px-2 py-1 text-[12px] text-[var(--ink-90)]"
            />
            <button
              onClick={() => void onSave()}
              disabled={!key.trim() || busy}
              className="btn-primary px-3 py-1 text-[12px] disabled:opacity-40"
              data-testid="ai-member-key-save"
            >
              Save
            </button>
            {status.configured && (
              <button
                onClick={() => void onRemove()}
                disabled={busy}
                className="fb-btn-surface px-3 py-1 text-[12px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)] disabled:opacity-40"
                data-testid="ai-member-key-remove"
              >
                Remove
              </button>
            )}
          </div>
          {msg && <div className="text-[11px] text-[var(--ink-50)] mt-1">{msg}</div>}
        </>
      )}
    </div>
  )
}

// Browse the channels in your organization, join one, or create a new one.
// Channels are org-scoped: only people in the same organization see and join them.
export function ChannelBrowser({ onClose }: { onClose: () => void }): JSX.Element {
  const token = useMessagingStore((s) => s.token)
  const browseChannels = useMessagingStore((s) => s.browseChannels)
  const createChannel = useMessagingStore((s) => s.createChannel)
  const joinChannel = useMessagingStore((s) => s.joinChannel)
  const [orgs, setOrgs] = useState<OrgMembership[]>([])
  const [orgId, setOrgId] = useState<string | null>(null)
  const [channels, setChannels] = useState<OrgChannel[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!token) {
        setLoading(false)
        return
      }
      const os = await listOrgs(token)
      if (!alive) return
      setOrgs(os)
      setOrgId(os[0]?.id ?? null)
      setLoading(false)
    })()
    return () => {
      alive = false
    }
  }, [token])

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!orgId) {
        setChannels([])
        return
      }
      const cs = await browseChannels(orgId)
      if (alive) setChannels(cs)
    })()
    return () => {
      alive = false
    }
  }, [orgId, browseChannels])

  async function onCreate(): Promise<void> {
    if (!orgId) return
    const r = await createChannel(orgId, name)
    if (!r.ok) {
      setErr(r.error)
      return
    }
    onClose() // createChannel opens the new channel
  }

  async function onJoin(id: string): Promise<void> {
    await joinChannel(id)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30"
      onClick={onClose}
      data-testid="channel-browser"
    >
      <div
        className="fb-card fb-press w-[420px] max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--edge-soft)] flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--ink-100)] inline-flex items-center gap-1.5">
            <Icon name="tag" size={15} className="text-accent" /> Channels
          </h2>
          <button onClick={onClose} className="icon-btn" aria-label="Close" data-testid="channel-browser-close">
            <Icon name="close" size={15} />
          </button>
        </div>

        {orgs.length > 1 && (
          <div className="px-4 pt-3">
            <select
              value={orgId ?? ''}
              onChange={(e) => setOrgId(e.target.value)}
              className="fb-field w-full px-2 py-1 text-[12px] text-[var(--ink-90)]"
              data-testid="channel-browser-org"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex-1 overflow-auto px-4 py-3 space-y-1">
          {loading ? (
            <p className="text-[12px] text-[var(--ink-50)]">Loading channels…</p>
          ) : !orgId ? (
            <p className="text-[12px] text-[var(--ink-50)] leading-snug">
              You are not part of an organization yet. Channels live inside an organization, so create or join one first.
            </p>
          ) : channels.length === 0 ? (
            <p className="text-[12px] text-[var(--ink-50)] leading-snug">No channels yet. Create the first one below.</p>
          ) : (
            channels.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--surface-sunken)]"
                data-testid="channel-row"
              >
                <span className="min-w-0">
                  <span className="text-[13px] font-medium text-[var(--ink-100)] truncate inline-flex items-center gap-1">
                    <span className="text-[var(--ink-50)]">#</span>
                    {c.title}
                  </span>
                  <span className="block text-[11px] text-[var(--ink-50)]">
                    {c.memberCount} {c.memberCount === 1 ? 'member' : 'members'}
                  </span>
                </span>
                {c.isMember ? (
                  <span className="shrink-0 text-[11px] text-[var(--ink-50)] inline-flex items-center gap-1">
                    <Icon name="check" size={13} /> Joined
                  </span>
                ) : (
                  <button
                    onClick={() => void onJoin(c.id)}
                    className="fb-btn-surface shrink-0 h-7 px-3 text-[12px] text-[var(--ink-90)] hover:bg-[var(--surface-sunken)]"
                    data-testid="channel-join"
                  >
                    Join
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {orgId && (
          <div className="px-4 py-3 border-t border-[var(--edge-soft)]">
            <div className="flex gap-1.5">
              <span className="inline-flex items-center text-[var(--ink-50)] text-[13px] pl-1">#</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  setErr(null)
                }}
                onKeyDown={(e) => e.key === 'Enter' && void onCreate()}
                placeholder="new-channel-name"
                data-testid="channel-create-name"
                className="fb-field flex-1 px-2 py-1 text-[12px] text-[var(--ink-90)]"
              />
              <button
                onClick={() => void onCreate()}
                disabled={!name.trim()}
                className="btn-primary px-3 py-1 text-[12px] disabled:opacity-40"
                data-testid="channel-create"
              >
                Create
              </button>
            </div>
            {err && <div className="text-[11px] text-red-500 mt-1">{err}</div>}
          </div>
        )}

        {token && orgId && (() => {
          const role = orgs.find((o) => o.id === orgId)?.role
          if (role !== 'owner' && role !== 'admin') return null
          return (
            <>
              <AiMemberConfig token={token} orgId={orgId} />
              <BotRolesConfig token={token} orgId={orgId} />
            </>
          )
        })()}
      </div>
    </div>
  )
}
