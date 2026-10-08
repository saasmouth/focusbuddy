import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../Icon'
import LiveDeskSharing from '../LiveDeskSharing'
import LiveWebViewPanel from '../LiveWebViewPanel'
import { useSharesStore } from '../../stores/shares'
import { useNodeStore } from '../../stores/nodes'
import { viewerUrlFor } from '../../lib/shareTokens'
import { buildFolderSnapshot, buildTaskSnapshot, generateAnonymousHandle } from '../../lib/shareSnapshot'
import {
  mintEphemeralShare,
  listEphemeralShares,
  revokeEphemeralShare,
  timeLeft,
  shareUrlFor,
  type EphemeralShare
} from '../../lib/ephemeralShareClient'
import {
  EXPIRY_CHOICES,
  PUBLIC_MODES,
  expiryAt,
  publicMode,
  type PublicMode,
  type ShareAudience
} from './shareAudience'

// One sheet for sharing a desk or a room. See shareAudience.ts for why this
// replaced five stacked controls, and why "anyone with the link" still needs a
// second question.
//
// The transports underneath are unchanged — this is a surface, not a rewrite.
// Named-people sharing is still LiveDeskSharing, the live page is still
// LiveWebViewPanel, the usable browser desk is still the ephemeral share, and
// the snapshot is still the shares store. What changed is that each appears
// once, in an order that answers a question, instead of all at once with a
// paragraph of prose explaining which is which.

interface Props {
  kind: 'folder' | 'task'
  entityId: string
  label: string
  roomRootId?: string
  roomTitle?: string
}

const KIND_WORD: Record<Props['kind'], string> = { folder: 'room', task: 'desk' }

export default function DeskShareSheet({
  kind,
  entityId,
  label,
  roomRootId,
  roomTitle
}: Props): JSX.Element {
  // Naming a person is the commoner act, so it leads. The link path is one
  // click away with the demo option already selected.
  const [audience, setAudience] = useState<ShareAudience>('people')
  const [mode, setMode] = useState<PublicMode>('use')
  const [expiryMs, setExpiryMs] = useState<number | null>(null)
  // 'read' can be a dead end or a door into the product. Default to the door.
  const [allowCopy, setAllowCopy] = useState(true)

  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [ephemeral, setEphemeral] = useState<EphemeralShare[]>([])
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sentMsg, setSentMsg] = useState<string | null>(null)
  // The token behind the URL on screen. Needed because the server-side invite
  // addresses a share by token, not by URL.
  const [token, setToken] = useState<string | null>(null)

  const createFor = useSharesStore((s) => s.createFor)
  const outgoing = useSharesStore((s) => s.outgoing)
  const revoke = useSharesStore((s) => s.revoke)
  const refreshShares = useSharesStore((s) => s.refresh)
  const invite = useSharesStore((s) => s.invite)

  const spec = publicMode(mode)
  const word = KIND_WORD[kind]

  const snapshotLinks = useMemo(
    () => outgoing.filter((l) => l.entityId === entityId && !l.revoked),
    [outgoing, entityId]
  )

  const loadEphemeral = useCallback(async () => {
    const all = await listEphemeralShares()
    setEphemeral(all.filter((s) => s.rootId === entityId))
  }, [entityId])

  useEffect(() => {
    void loadEphemeral()
    void refreshShares()
    // refreshShares is a stable Zustand action ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEphemeral])

  // Changing what the recipient gets invalidates the link already on screen —
  // showing a 'use' URL under a 'read' description is how someone sends the
  // wrong thing.
  useEffect(() => {
    setUrl(null)
    setToken(null)
    setError(null)
    setCopied(false)
    setSentMsg(null)
  }, [mode, expiryMs, allowCopy])

  async function makeLink(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (mode === 'use') {
        const res = await mintEphemeralShare(entityId, expiryMs)
        if (!res.ok || !res.url) throw new Error(res.error || 'Could not create the link.')
        setUrl(res.url)
        setToken(res.share?.token ?? null)
        await loadEphemeral()
        return
      }
      // 'read' — a frozen render on the public viewer.
      const nodes = useNodeStore.getState().nodes
      const node = nodes.find((n) => n.id === entityId)
      if (!node) throw new Error(`That ${word} is no longer in the workspace.`)
      // One handle for both the snapshot and the link, so the "shared by" name
      // the recipient sees matches the one stamped on the record.
      const handle = generateAnonymousHandle()
      const snapshot =
        kind === 'folder'
          ? await buildFolderSnapshot(node, nodes, handle)
          : await buildTaskSnapshot(node, handle)
      const link = await createFor({
        kind,
        entityId,
        label,
        scope: allowCopy ? 'copy' : 'view',
        expiresAt: expiryAt(expiryMs),
        snapshot,
        fromHandle: handle
      })
      setUrl(viewerUrlFor(link.token))
      setToken(link.token)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function send(): Promise<void> {
    const to = email.trim().toLowerCase()
    if (!to.includes('@') || !url || sending) return
    setSending(true)
    setSentMsg(null)
    setError(null)
    try {
      if (mode === 'read' && token) {
        const { emailDelivered } = await invite(token, to)
        setSentMsg(
          emailDelivered
            ? `Sent to ${to}. It is also in their Shared with me.`
            : `${to} was added — the email sends once mail is configured.`
        )
      } else {
        const subject = encodeURIComponent(`A Plexii ${word}: ${label}`)
        const body = encodeURIComponent(
          `Open this in your browser — no account or install needed:\n\n${url}\n`
        )
        await window.api.files.openExternal(`mailto:${to}?subject=${subject}&body=${body}`)
        setSentMsg('Your mail app has it, ready to send.')
      }
      setEmail('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSending(false)
    }
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setError('Could not copy — select the link and copy it by hand.')
    }
  }

  return (
    <div className="space-y-3" data-testid="desk-share-sheet">
      {/* ── Question one ───────────────────────────────────────────────── */}
      <div>
        <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
          Who can open this {word}?
        </div>
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label={`Who can open this ${word}`}>
          {([
            ['people', 'Specific people', 'They sign in. Changes sync both ways.'],
            ['link', 'Anyone with the link', 'No account, no install needed.']
          ] as Array<[ShareAudience, string, string]>).map(([id, title, sub]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={audience === id}
              onClick={() => setAudience(id)}
              data-testid={`share-audience-${id}`}
              className={`text-left rounded-[var(--radius-row)] border px-2.5 py-2 transition-colors ${
                audience === id
                  ? 'border-accent bg-accent/10'
                  : 'border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <div className="text-[12px] font-medium text-[var(--ink-90)]">{title}</div>
              <div className="text-[10.5px] text-[var(--ink-50)] leading-snug mt-0.5">{sub}</div>
            </button>
          ))}
        </div>
      </div>

      {audience === 'people' ? (
        <LiveDeskSharing rootId={entityId} roomRootId={roomRootId} roomTitle={roomTitle} />
      ) : (
        <>
          {/* ── Question two ─────────────────────────────────────────────── */}
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
              What do they get?
            </div>
            <div className="space-y-1" role="radiogroup" aria-label="What do they get">
              {PUBLIC_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === m.id}
                  onClick={() => setMode(m.id)}
                  data-testid={`share-mode-${m.id}`}
                  className={`w-full text-left rounded-[var(--radius-row)] border px-2.5 py-2 transition-colors ${
                    mode === m.id
                      ? 'border-accent bg-accent/10'
                      : 'border-[var(--edge-soft)] hover:bg-[var(--surface-sunken)]'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon
                      name={mode === m.id ? 'radio_button_checked' : 'radio_button_unchecked'}
                      size={13}
                      className={mode === m.id ? 'text-accent' : 'text-[var(--ink-40)]'}
                    />
                    <span className="text-[12px] font-medium text-[var(--ink-90)]">{m.label}</span>
                  </div>
                  <div className="text-[10.5px] text-[var(--ink-50)] leading-snug mt-0.5 pl-[19px]">
                    {m.blurb}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 'watch' is a published projection with its own lifecycle (live,
              stale, paused, failed), so it keeps its own panel rather than
              pretending to be a link you mint once. */}
          {mode === 'watch' ? (
            <LiveWebViewPanel deskId={entityId} />
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-[11px] text-[var(--ink-60)]">
                  Link expires
                  <select
                    value={String(expiryMs)}
                    onChange={(e) =>
                      setExpiryMs(e.target.value === 'null' ? null : Number(e.target.value))
                    }
                    data-testid="share-expiry"
                    className="ml-1.5 fb-field text-[11px] px-1.5 py-1 bg-[var(--surface-raised)] text-[var(--ink-90)]"
                  >
                    {EXPIRY_CHOICES.map((c) => (
                      <option key={c.label} value={String(c.ms)}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {mode === 'read' && (
                  <label className="flex items-center gap-1.5 text-[11px] text-[var(--ink-60)]">
                    <input
                      type="checkbox"
                      checked={allowCopy}
                      onChange={(e) => setAllowCopy(e.target.checked)}
                      data-testid="share-allow-copy"
                      className="accent-[rgb(var(--accent))]"
                    />
                    Let them add it to their own workspace
                  </label>
                )}
              </div>

              {url ? (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={url}
                      data-testid="share-url"
                      onFocus={(e) => e.currentTarget.select()}
                      className="fb-field flex-1 text-[11px] px-2 py-1.5 bg-[var(--surface-sunken)] text-[var(--ink-80)] font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => void copy(url)}
                      data-testid="share-copy"
                      className="text-[12px] px-2.5 py-1.5 rounded bg-accent text-white hover:brightness-110 inline-flex items-center gap-1 shrink-0"
                    >
                      <Icon name={copied ? 'check' : 'content_copy'} size={12} />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  {mode === 'use' && (
                    <p className="text-[10.5px] text-[var(--ink-50)] leading-snug">
                      Send this to try Plexii without installing anything. Whatever they change is
                      theirs alone — it never comes back to this {word}.
                    </p>
                  )}

                  {/* Delivery, not a kind of sharing. One row, for whichever
                      link is above it.

                      The pipe differs because the links differ, and saying so
                      is better than a control that silently does something
                      else: a snapshot is a record the server can address by
                      token, so it can be emailed AND dropped into the
                      recipient's Shared-with-me inbox. A usable-desk token is a
                      read capability in a URL with no recipient model behind
                      it, so there is nothing to send server-side — it opens the
                      mail client with the link in it. */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void send()
                      }}
                      placeholder="name@example.com"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      data-testid="share-email"
                      className="fb-field flex-1 text-[11px] px-2 py-1.5 bg-[var(--surface-raised)] text-[var(--ink-90)]"
                    />
                    <button
                      type="button"
                      onClick={() => void send()}
                      disabled={sending || !email.includes('@')}
                      data-testid="share-send"
                      className="text-[12px] px-2.5 py-1.5 rounded border border-[var(--edge-firm)] text-[var(--ink-80)] hover:bg-[var(--surface-sunken)] disabled:opacity-50 inline-flex items-center gap-1 shrink-0"
                    >
                      <Icon name={sending ? 'autorenew' : 'send'} size={12} className={sending ? 'animate-spin' : ''} />
                      Send
                    </button>
                  </div>
                  {sentMsg && (
                    <p className="text-[10.5px] text-[var(--ink-50)]" data-testid="share-sent">
                      {sentMsg}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => void makeLink()}
                  disabled={busy}
                  data-testid="share-create-link"
                  className="text-[12px] px-3 py-1.5 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <Icon name={busy ? 'autorenew' : 'link'} size={13} className={busy ? 'animate-spin' : ''} />
                  {busy ? 'Creating…' : `Create ${spec.label.toLowerCase()}`}
                </button>
              )}

              {error && (
                <p className="text-[11px] text-red-400" data-testid="share-error">
                  {error}
                </p>
              )}
            </div>
          )}

          {/* ── One list of the links that exist ───────────────────────── */}
          {(ephemeral.length > 0 || snapshotLinks.length > 0) && (
            <div className="pt-1 border-t border-[var(--edge-soft)] space-y-1">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)]">
                Links to this {word}
              </div>
              {ephemeral.map((s) => (
                <div key={s.token} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-[var(--ink-70)]">
                    Usable desk · {timeLeft(s.expiresAt)} · {s.opens} open{s.opens === 1 ? '' : 's'}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void copy(shareUrlFor(s.token))}
                      className="icon-btn !h-6 !w-6"
                      title="Copy this link"
                    >
                      <Icon name="content_copy" size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        await revokeEphemeralShare(s.token)
                        await loadEphemeral()
                      }}
                      className="icon-btn !h-6 !w-6"
                      title="Stop this link working"
                      data-testid="share-revoke-ephemeral"
                    >
                      <Icon name="link_off" size={11} />
                    </button>
                  </div>
                </div>
              ))}
              {snapshotLinks.map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="truncate text-[var(--ink-70)]">
                    Snapshot · {l.scope === 'copy' ? 'can be added to a workspace' : 'read only'} ·{' '}
                    {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void copy(viewerUrlFor(l.token))}
                      className="icon-btn !h-6 !w-6"
                      title="Copy this link"
                    >
                      <Icon name="content_copy" size={11} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void revoke(l.id)}
                      className="icon-btn !h-6 !w-6"
                      title="Stop this link working"
                      data-testid="share-revoke-snapshot"
                    >
                      <Icon name="link_off" size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
