import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MailFullMessage, MailListItem } from '@shared/types'
import Icon from '../Icon'
import { useMailModalStore } from '../../stores/mailModal'
import { trailFor } from '../../lib/replyTrail'

// Reading one email, and answering it, without leaving what you were doing.
//
// The trail is the point. A reply drafted from the latest message alone is the
// thing people notice immediately -- it re-asks a question settled three
// messages ago -- so the earlier exchange is loaded, shown, and passed to the
// drafter. It is also shown collapsed rather than hidden: a draft written from
// context you cannot see is one you cannot check.

interface Loaded {
  message: MailFullMessage
  trail: Array<{ item: MailListItem; body: string }>
}

type State =
  | { k: 'loading' }
  | { k: 'error'; error: string }
  | { k: 'ready'; data: Loaded }

const fmt = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })

type MailApi = {
  get: (uid: number) => Promise<{ ok: true; message: MailFullMessage } | { ok: false; error: string }>
  list: (limit?: number) => Promise<{ ok: true; items: MailListItem[] } | { ok: false; error: string }>
  markSeen: (uid: number) => Promise<unknown>
  send: (input: {
    to: string[]
    cc?: string[]
    subject: string
    text: string
    inReplyTo?: string | null
    references?: string[]
  }) => Promise<{ ok: true } | { ok: false; error: string }>
  suggestReply: (
    incoming: { subject: string; from: string; body: string },
    trail?: Array<{ from: string; date?: number; body: string }>
  ) => Promise<{
    ok: boolean
    reply?: string
    note?: string
    skip?: boolean
    skipReason?: string
    needsApiKey?: boolean
    error?: string
  }>
}

export default function MailMessageModal(): JSX.Element | null {
  const uid = useMailModalStore((s) => s.uid)
  const close = useMailModalStore((s) => s.close)

  const [state, setState] = useState<State>({ k: 'loading' })
  const [replying, setReplying] = useState<'reply' | 'replyAll' | null>(null)
  const [draft, setDraft] = useState('')
  const [to, setTo] = useState<string>('')
  const [cc, setCc] = useState<string>('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [sendError, setSendError] = useState<string | null>(null)
  const [showTrail, setShowTrail] = useState(false)

  const api = (window as { api?: { mail?: MailApi } }).api?.mail

  const load = useCallback(async (): Promise<void> => {
    if (uid == null || !api) return
    setState({ k: 'loading' })
    setReplying(null)
    setDraft('')
    setAiNote(null)
    setSendState('idle')
    setSendError(null)
    setShowTrail(false)
    try {
      const res = await api.get(uid)
      if (!res.ok) {
        setState({ k: 'error', error: res.error })
        return
      }
      // The mailbox listing is what threading is computed from; a failure here
      // costs the trail, not the message, so it degrades rather than throws.
      let trail: Array<{ item: MailListItem; body: string }> = []
      try {
        const list = await api.list(300)
        if (list.ok) {
          const target = list.items.find((m) => m.uid === uid)
          if (target) {
            const earlier = trailFor(target, list.items)
            const bodies = await Promise.all(
              earlier.map(async (m) => {
                const full = await api.get(m.uid)
                return { item: m, body: full.ok ? full.message.text : '' }
              })
            )
            trail = bodies
          }
        }
      } catch {
        trail = []
      }
      setState({ k: 'ready', data: { message: res.message, trail } })
      void api.markSeen(uid)
    } catch (e) {
      setState({ k: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }, [uid, api])

  useEffect(() => {
    void load()
  }, [load])

  // Escape closes, but never mid-send: losing a message to a stray keypress is
  // the one thing a composer must not do.
  useEffect(() => {
    if (uid == null) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && sendState !== 'sending') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [uid, close, sendState])

  const msg = state.k === 'ready' ? state.data.message : null

  const startReply = (mode: 'reply' | 'replyAll'): void => {
    if (!msg) return
    setReplying(mode)
    setSendError(null)
    setTo(msg.fromAddress)
    setCc(
      mode === 'replyAll'
        ? (msg.toAddresses ?? []).filter((a) => a && a !== msg.fromAddress).join(', ')
        : ''
    )
  }

  const trailForAi = useMemo(
    () =>
      state.k === 'ready'
        ? state.data.trail.map((t) => ({
            from: t.item.fromAddress || t.item.fromName,
            date: t.item.date,
            body: t.body
          }))
        : [],
    [state]
  )

  const aiDraft = async (): Promise<void> => {
    if (!msg || !api) return
    setAiBusy(true)
    setAiNote(null)
    try {
      const res = await api.suggestReply(
        { subject: msg.subject, from: msg.fromAddress, body: msg.text },
        trailForAi
      )
      if (res.skip) {
        setAiNote(res.skipReason || 'This does not look like a message that wants a reply.')
        return
      }
      if (!res.ok || !res.reply) {
        setAiNote(
          res.needsApiKey
            ? 'No Anthropic API key set — add one in Settings → AI.'
            : res.error || 'The draft could not be written.'
        )
        return
      }
      setDraft(res.reply)
      setAiNote(
        res.note
          ? `${res.note} · drafted from ${trailForAi.length} earlier message${trailForAi.length === 1 ? '' : 's'}`
          : trailForAi.length > 0
            ? `Drafted from this message and ${trailForAi.length} earlier one${trailForAi.length === 1 ? '' : 's'}. Check it before sending.`
            : 'Drafted from this message alone. Check it before sending.'
      )
    } finally {
      setAiBusy(false)
    }
  }

  const send = async (): Promise<void> => {
    if (!msg || !api || !draft.trim()) return
    setSendState('sending')
    setSendError(null)
    const res = await api.send({
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
      subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
      text: draft,
      inReplyTo: msg.messageId,
      references: [...(msg.references ?? []), msg.messageId].filter((x): x is string => Boolean(x))
    })
    if (!res.ok) {
      setSendState('idle')
      setSendError(res.error)
      return
    }
    setSendState('sent')
  }

  if (uid == null) return null

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/35 p-6"
      onClick={() => sendState !== 'sending' && close()}
      data-testid="mail-modal-backdrop"
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface-raised)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="mail-modal"
      >
        <div className="flex items-start gap-2 border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-[var(--ink-90)]">
              {msg?.subject || (state.k === 'loading' ? 'Opening…' : 'Message')}
            </div>
            {msg && (
              <div className="truncate text-[11px] text-[var(--ink-50)]">
                {msg.fromName ? `${msg.fromName} · ` : ''}
                {msg.fromAddress} · {fmt(msg.date)}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            className="shrink-0 rounded p-1 text-[var(--ink-40)] hover:bg-[var(--surface-sunken)] hover:text-[var(--ink-90)]"
            aria-label="Close"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {state.k === 'loading' && (
            <p className="py-8 text-center text-[12px] text-[var(--ink-50)]">Opening…</p>
          )}
          {state.k === 'error' && (
            <div className="py-8 text-center">
              <Icon name="error_outline" size={20} className="text-[var(--ink-40)]" />
              <p className="mt-1 text-[12px] text-[var(--ink-70)]">Couldn’t open this message</p>
              <p className="text-[11px] text-[var(--ink-45)]">{state.error}</p>
            </div>
          )}
          {state.k === 'ready' && msg && (
            <>
              {state.data.trail.length > 0 && (
                <div className="mb-3">
                  <button
                    type="button"
                    onClick={() => setShowTrail(!showTrail)}
                    className="flex items-center gap-1 text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-80)]"
                    data-testid="mail-trail-toggle"
                  >
                    <Icon name={showTrail ? 'expand_less' : 'expand_more'} size={13} />
                    {state.data.trail.length} earlier message
                    {state.data.trail.length === 1 ? '' : 's'} in this thread
                  </button>
                  {showTrail && (
                    <div className="mt-2 flex flex-col gap-2 border-l-2 border-[var(--line)] pl-3">
                      {state.data.trail.map((t) => (
                        <div key={t.item.uid}>
                          <div className="text-[10px] text-[var(--ink-45)]">
                            {t.item.fromName || t.item.fromAddress} · {fmt(t.item.date)}
                          </div>
                          <div className="whitespace-pre-wrap text-[11px] leading-snug text-[var(--ink-60)]">
                            {t.body.slice(0, 600) || '(no text part)'}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-80)]">
                {msg.text || '(This message has no plain-text part.)'}
              </div>

              {msg.attachments?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {msg.attachments.map((a) => (
                    <span
                      key={a.filename}
                      className="inline-flex items-center gap-1 rounded-md bg-[var(--surface-sunken)] px-2 py-1 text-[10px] text-[var(--ink-60)]"
                      title={`${a.contentType} · ${Math.round(a.size / 1024)} KB`}
                    >
                      <Icon name="attach_file" size={11} />
                      {a.filename}
                    </span>
                  ))}
                </div>
              )}

              {replying && (
                <div className="mt-4 flex flex-col gap-2 border-t border-[var(--line)] pt-3">
                  <label className="flex items-center gap-2 text-[11px]">
                    <span className="w-[28px] shrink-0 text-[var(--ink-45)]">To</span>
                    <input
                      className="min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11px]"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                    />
                  </label>
                  {replying === 'replyAll' && (
                    <label className="flex items-center gap-2 text-[11px]">
                      <span className="w-[28px] shrink-0 text-[var(--ink-45)]">Cc</span>
                      <input
                        className="min-w-0 flex-1 rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1 text-[11px]"
                        value={cc}
                        onChange={(e) => setCc(e.target.value)}
                      />
                    </label>
                  )}
                  <textarea
                    className="min-h-[140px] w-full resize-y rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-[12px] leading-snug outline-none"
                    placeholder="Write your reply, or draft one with AI."
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    data-testid="mail-reply-body"
                  />
                  {aiNote && (
                    <p className="text-[10px] leading-snug text-[var(--ink-50)]">{aiNote}</p>
                  )}
                  {sendError && <p className="text-[11px] text-rose-500">{sendError}</p>}
                  {sendState === 'sent' && (
                    <p className="text-[11px] text-emerald-600">Sent.</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {state.k === 'ready' && msg && sendState !== 'sent' && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--line)] px-4 py-2.5">
            {!replying ? (
              <>
                <Action icon="reply" label="Reply" onClick={() => startReply('reply')} />
                <Action icon="reply_all" label="Reply all" onClick={() => startReply('replyAll')} />
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void aiDraft()}
                  disabled={aiBusy}
                  data-testid="mail-ai-draft"
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)] disabled:opacity-50"
                  title={
                    trailForAi.length > 0
                      ? `Draft using this message and ${trailForAi.length} earlier one${trailForAi.length === 1 ? '' : 's'}`
                      : 'Draft a reply to this message'
                  }
                >
                  <Icon name={aiBusy ? 'hourglass_empty' : 'auto_awesome'} size={13} />
                  {aiBusy ? 'Drafting…' : 'Draft with AI'}
                </button>
                <button
                  type="button"
                  onClick={() => setReplying(null)}
                  className="rounded-md px-2 py-1.5 text-[11px] text-[var(--ink-50)] hover:text-[var(--ink-80)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim() || sendState === 'sending'}
                  data-testid="mail-send"
                  className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {sendState === 'sending' ? 'Sending…' : 'Send'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Action({
  icon,
  label,
  onClick
}: {
  icon: string
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md border border-[var(--line)] px-2.5 py-1.5 text-[11px] text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
    >
      <Icon name={icon} size={13} />
      {label}
    </button>
  )
}
