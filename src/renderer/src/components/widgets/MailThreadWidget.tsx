import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../Icon'
import { useMailModalStore } from '../../stores/mailModal'
import { useViewStore } from '../../stores/view'
import { useWidgetStore } from '../../stores/widgets'
import { splitQuoted } from '../../lib/mailBodyText'
import type { MailThreadContent, PinnedMailMessage, Widget } from '@shared/types'

// An email on a desk, read as a document.
//
// Deliberately not an inbox. The 'inbox' widget is a live QUERY — a rule the user
// writes, showing whatever currently matches. This is the opposite: one piece of
// correspondence that belongs to this work. The lease. The quote. The levy notice.
// It stays on the desk whether or not it still matches any filter, whether or not
// it has been read, and whether or not it is still in the inbox at all.
//
// It renders from the LOCAL mail store, which is what makes that true. A widget
// holding a pointer into a live mailbox goes blank the day the message is archived
// — and the whole point of putting the lease on the desk is that it stays there.

const dateLine = (ms: number): string =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : 'undated'

function MessageBody({ body }: { body: string | null }): JSX.Element {
  // Every hook runs unconditionally and before any early return. `body` flips from
  // null to text when the sweep fetches it, so a hook after the null check would
  // change the hook order mid-life and break the component at exactly the moment
  // the message finally arrived.
  const [showQuoted, setShowQuoted] = useState(false)
  const { main, quoted } = useMemo(() => splitQuoted(body ?? ''), [body])
  if (body === null) {
    // Not the same as an empty message, and saying so is the difference between
    // "there is nothing here" and "it has not been read yet".
    return (
      <p className="fb-t-caption text-[var(--ink-50)] italic">
        The text of this message has not been downloaded yet — it will appear once PlexiDesk has read it.
      </p>
    )
  }
  if (!main && !quoted) {
    return <p className="fb-t-caption text-[var(--ink-50)] italic">This message has no text body.</p>
  }
  const quotedLines = quoted ? quoted.split('\n').length : 0
  return (
    <div className="flex flex-col gap-1.5">
      <p className="fb-t-body whitespace-pre-wrap break-words text-[var(--ink-100)]">{main}</p>
      {quoted && (
        <>
          <button
            onClick={() => setShowQuoted((v) => !v)}
            className="self-start fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-100)] underline"
          >
            {showQuoted
              ? 'Hide quoted history'
              : `Show ${quotedLines} more ${quotedLines === 1 ? 'line' : 'lines'} of quoted history`}
          </button>
          {showQuoted && (
            <p className="fb-t-caption whitespace-pre-wrap break-words text-[var(--ink-50)] border-l-2 border-[var(--edge-soft)] pl-2">
              {quoted}
            </p>
          )}
        </>
      )}
    </div>
  )
}

export default function MailThreadWidget({ widget }: { widget: Widget }): JSX.Element {
  const content = useMemo<MailThreadContent>(() => {
    try {
      const p = JSON.parse(widget.content || '{}') as MailThreadContent
      return {
        mode: p.mode === 'thread' ? 'thread' : 'one',
        uids: Array.isArray(p.uids) ? p.uids.filter((u) => Number.isSafeInteger(u)) : [],
        rootMessageId: p.rootMessageId ?? null,
        subject: p.subject,
        fromName: p.fromName,
        collapsed: p.collapsed
      }
    } catch {
      return { mode: 'one', uids: [] }
    }
  }, [widget.content])

  const [messages, setMessages] = useState<PinnedMailMessage[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openReader = useMailModalStore((s) => s.open)
  const goMail = useViewStore((s) => s.goMail)
  const updateWidget = useWidgetStore((s) => s.update)

  const load = useCallback(() => {
    void window.api.mail
      .storedThread(content)
      .then((r) => {
        if (!r.ok) {
          setError(r.error)
          setMessages([])
          return
        }
        setError(null)
        setMessages(r.messages)
      })
      .catch((e: Error) => setError(e.message))
  }, [content])

  useEffect(load, [load])

  // A 'thread' widget regathers on every load, so a reply that arrived since is
  // picked up. Refresh is offered explicitly rather than polled: a desk with ten
  // pinned threads must not sit in a loop querying the database.
  const title = content.subject || widget.title || 'Email'
  const single = messages && messages.length === 1 ? messages[0] : null
  const anchorUid = content.uids[0] ?? single?.uid ?? null

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-2.5 pt-2 pb-1.5 border-b border-[var(--edge-soft)] flex items-start gap-2">
        <Icon name="mail" size={14} className="text-accent mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="fb-t-body font-semibold text-[var(--ink-100)] leading-snug break-words">{title}</p>
          <p className="fb-t-caption truncate">
            {content.mode === 'thread'
              ? `${messages ? messages.length : '…'} ${messages && messages.length === 1 ? 'message' : 'messages'} in this thread`
              : (single ? `${single.fromName || single.fromAddress}` : content.fromName) || 'One message'}
          </p>
        </div>
        <button onClick={load} className="icon-btn shrink-0" title="Check for new replies" aria-label="Refresh">
          <Icon name="refresh" size={13} />
        </button>
        {anchorUid !== null && (
          <button
            onClick={() => {
              goMail()
              openReader(anchorUid)
            }}
            className="icon-btn shrink-0"
            title="Open in Mail"
            aria-label="Open in Mail"
          >
            <Icon name="open_in_new" size={13} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2 flex flex-col gap-3">
        {messages === null && <p className="fb-t-caption text-[var(--ink-50)]">Loading…</p>}

        {messages !== null && messages.length === 0 && (
          // The honest case, and worth distinguishing. The widget is not broken and
          // the desk has not lost anything — the message is simply not in the local
          // store, usually because it was pinned on another device or the store was
          // cleared when the mailbox was disconnected.
          <div className="flex flex-col gap-1">
            <p className="fb-t-caption text-[var(--ink-50)]">
              {error ?? 'This message is not in PlexiDesk’s local copy of your mail.'}
            </p>
            {content.subject && (
              <p className="fb-t-caption text-[var(--ink-50)]">
                It was pinned as “{content.subject}”
                {content.fromName ? `, from ${content.fromName}` : ''}.
              </p>
            )}
          </div>
        )}

        {messages?.map((m, i) => (
          <article key={m.uid} className="flex flex-col gap-1">
            {/* In a thread every message needs its own attribution; for a single
                pinned message the sender is already in the header above. */}
            {(content.mode === 'thread' || messages.length > 1) && (
              <header className="flex items-baseline gap-2 min-w-0">
                <span className="fb-t-caption font-semibold text-[var(--ink-100)] truncate">
                  {m.fromName || m.fromAddress || 'Unknown sender'}
                </span>
                <span className="fb-t-caption text-[var(--ink-50)] shrink-0">{dateLine(m.date)}</span>
              </header>
            )}
            {content.mode === 'one' && i === 0 && (
              <header className="flex flex-col">
                <span className="fb-t-caption text-[var(--ink-50)]">{dateLine(m.date)}</span>
                {m.toText && <span className="fb-t-caption text-[var(--ink-50)] truncate">To: {m.toText}</span>}
              </header>
            )}
            <MessageBody body={m.bodyText} />
            {m.attachments.length > 0 && (
              <ul className="flex flex-wrap gap-1 mt-0.5">
                {m.attachments.map((a) => (
                  <li
                    key={a.filename}
                    className="fb-t-caption px-1.5 py-0.5 rounded border border-[var(--edge-soft)] text-[var(--ink-60)] flex items-center gap-1"
                    title={`${a.filename} · ${Math.max(1, Math.round(a.sizeBytes / 1024))} KB`}
                  >
                    <Icon name="attach_file" size={11} />
                    <span className="truncate max-w-[160px]">{a.filename}</span>
                  </li>
                ))}
              </ul>
            )}
            {i < messages.length - 1 && <hr className="border-[var(--edge-soft)] mt-1.5" />}
          </article>
        ))}
      </div>

      {/* Switching between one message and the conversation, in place. Someone who
          pinned a quote often wants the argument around it later — and having to
          delete the widget and re-add it from Mail would be a silly way to ask. */}
      {anchorUid !== null && (
        <div className="px-2.5 py-1.5 border-t border-[var(--edge-soft)]">
          <button
            onClick={() =>
              void updateWidget(widget.id, {
                content: JSON.stringify({ ...content, mode: content.mode === 'thread' ? 'one' : 'thread' })
              })
            }
            className="fb-t-caption text-[var(--ink-50)] hover:text-[var(--ink-100)] underline"
          >
            {content.mode === 'thread' ? 'Show just this message' : 'Show the whole thread'}
          </button>
        </div>
      )}
    </div>
  )
}
