import { useCallback, useEffect, useMemo } from 'react'
import { useMessagingStore } from '../../stores/messaging'
import { useAccountStore } from '../../stores/account'
import { useViewStore } from '../../stores/view'
import { useNodeStore } from '../../stores/nodes'
import { useSharesStore } from '../../stores/shares'
import { acceptShareIntoWorkspace } from '../../lib/acceptShare'
import { useSignInPrompt } from '../../stores/signInPrompt'
import Icon from '../Icon'
import { DashboardHeader } from '../plexi'

// PlexiInbox — your internal PlexiDesk notifications, and only those: direct
// and shared-space chat, folders/files/canvases/widgets shared with you, and
// contact requests. Email is deliberately NOT here; it lives in Mail. Clicking
// a row takes you to the conversation or the shared item.

function relTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h`
  return `${Math.round(hrs / 24)}d`
}

// One render-ready row, whatever its source.
interface Row {
  key: string
  icon: string
  title: string
  preview: string
  ts: number
  unread: number
  onClick?: () => void
  contactId?: string
}

export default function InboxView(): JSX.Element {
  const account = useAccountStore((s) => s.account)
  const requestSignIn = useSignInPrompt((s) => s.requestOpen)
  const items = useMessagingStore((s) => s.inboxItems)
  const refreshInbox = useMessagingStore((s) => s.refreshInbox)
  const openConversation = useMessagingStore((s) => s.openConversation)
  const acceptContact = useMessagingStore((s) => s.acceptContactRequest)
  const declineContact = useMessagingStore((s) => s.declineContactRequest)
  const goMessages = useViewStore((s) => s.goMessages)
  const goTask = useViewStore((s) => s.goTask)
  const goProject = useViewStore((s) => s.goProject)
  const goRoom = useViewStore((s) => s.goRoom)
  const setActive = useNodeStore((s) => s.setActive)
  const acceptByToken = useSharesStore((s) => s.acceptByToken)

  useEffect(() => {
    if (account) void refreshInbox()
  }, [account, refreshInbox])

  // Accept a shared folder/task/widget and open it. A share row used to do
  // nothing on click; now it resolves the share into the workspace (under
  // "Shared with me") and navigates to it.
  const openShare = useCallback(
    async (token: string): Promise<void> => {
      try {
        const item = await acceptByToken(token)
        const res = await acceptShareIntoWorkspace(item.snapshot)
        if (res.rootKind === 'folder') {
          // A shared room opens as the desks it contains, like any other room.
          goRoom(res.rootNodeId)
        } else {
          setActive(res.rootNodeId)
          goTask(res.rootNodeId)
        }
      } catch {
        // Snapshot couldn't be resolved (expired / incompatible). Leave the row;
        // the sidebar's "Shared with me" surfaces the same item with its own
        // error handling rather than silently pretending it opened.
      }
    },
    [acceptByToken, goProject, setActive, goTask]
  )

  // Internal notifications only: chat (direct + shared-space), shared items, and
  // contact requests. Email is intentionally excluded — it lives in Mail.
  const rows = useMemo<Row[]>(() => {
    return items
      .map((it) => {
        const isMessage = it.kind === 'message'
        const isContact = it.kind === 'contact-request'
        const icon = isContact
          ? 'person_add'
          : isMessage && it.convKind !== 'space'
            ? 'forum'
            : 'folder_shared'
        return {
          key: `${it.kind}:${it.id}`,
          icon,
          title: it.title,
          preview: it.preview ?? '',
          ts: it.ts,
          unread: it.unread,
          onClick: isMessage
            ? () => {
                void openConversation(it.id)
                goMessages()
              }
            : it.kind === 'share'
              ? () => void openShare(it.id)
              : undefined,
          contactId: isContact ? it.id : undefined
        }
      })
      .sort((a, b) => b.ts - a.ts)
  }, [items, openConversation, goMessages, openShare])

  // PlexiInbox needs a PlexiDesk account (email lives in Mail, separately).
  if (!account) {
    return (
      <div className="h-full flex items-center justify-center bg-[var(--surface-base)] px-6">
        <div className="text-center max-w-sm">
          <Icon name="inbox" size={32} className="text-[var(--ink-40)] mx-auto mb-3" />
          <h1 className="fb-t-title text-[var(--ink-100)] mb-1">PlexiInbox</h1>
          <p className="fb-t-body text-[var(--ink-50)] mb-4">
            Sign in to see your PlexiDesk notifications here, chat messages, shared folders and
            files, and contact requests. Email is in Mail.
          </p>
          <button onClick={() => requestSignIn()} className="btn-primary mx-auto">
            <Icon name="login" size={14} />
            <span>Sign in</span>
          </button>
        </div>
      </div>
    )
  }

  function refreshAll(): void {
    if (account) void refreshInbox()
  }

  return (
    <div className="h-full overflow-auto bg-[var(--surface-base)] text-[var(--ink-100)]">
      <div className="max-w-2xl mx-auto px-6 py-6">
        <DashboardHeader
          title="PlexiInbox"
          subtitle="Your PlexiDesk notifications: chat, shared items, and contact requests. Email is in Mail."
          actions={
            <button onClick={refreshAll} className="icon-btn" title="Refresh">
              <Icon name="refresh" size={16} />
            </button>
          }
        />

        {rows.length === 0 ? (
          <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--edge-firm)] p-10 text-center">
            <Icon name="inbox" size={26} className="text-[var(--ink-40)] mx-auto mb-2" />
            <p className="fb-t-body text-[var(--ink-70)]">Your PlexiInbox is clear.</p>
            <p className="fb-t-label text-[var(--ink-50)] mt-1">
              No new chat, shared items, or contact requests right now. Email lives in Mail.
            </p>
          </div>
        ) : (
          <div className="fb-card overflow-hidden divide-y divide-[var(--edge-soft)]">
            {rows.map((r, i) => (
              <div
                key={r.key}
                onClick={r.onClick}
                role={r.onClick ? 'button' : undefined}
                tabIndex={r.onClick ? 0 : undefined}
                onKeyDown={(e) => {
                  if (r.onClick && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault()
                    r.onClick()
                  }
                }}
                data-testid="inbox-item"
                style={{ animationDelay: `${Math.min(i * 35, 350)}ms` }}
                className={`px-4 py-3 flex items-start gap-3 fb-fade-in-up transition-colors ${
                  r.onClick ? 'cursor-pointer hover:bg-[var(--surface-sunken)] fb-press' : ''
                }`}
              >
                <div
                  className={`h-8 w-8 rounded-[var(--radius-chip)] inline-flex items-center justify-center shrink-0 ${
                    r.unread > 0
                      ? 'bg-accent/15 text-accent'
                      : 'bg-[var(--surface-sunken)] text-[var(--ink-50)]'
                  }`}
                >
                  <Icon name={r.icon} size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`fb-t-body truncate ${
                        r.unread > 0
                          ? 'font-semibold text-[var(--ink-100)]'
                          : 'font-medium text-[var(--ink-90)]'
                      }`}
                    >
                      {r.title}
                    </span>
                    <span className="ml-auto shrink-0 fb-t-caption text-[var(--ink-40)]">
                      {relTime(r.ts)}
                    </span>
                    {!r.contactId && r.unread > 0 && (
                      <span className="shrink-0 fb-t-caption !text-white font-semibold bg-accent rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                        {r.unread}
                      </span>
                    )}
                  </div>
                  {r.preview && (
                    <div className="fb-t-caption truncate mt-0.5">
                      {r.preview}
                    </div>
                  )}
                  {r.contactId && (
                    <div className="flex items-center gap-2 mt-1.5">
                      <button
                        onClick={() => {
                          void acceptContact(r.contactId!)
                          goMessages()
                        }}
                        data-testid="contact-accept"
                        className="btn-primary px-2.5 py-1 fb-t-label"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => void declineContact(r.contactId!)}
                        data-testid="contact-decline"
                        className="fb-t-label text-[var(--ink-50)] hover:text-[var(--ink-70)] px-2 py-1 fb-press"
                      >
                        Decline
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
