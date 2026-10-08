import { useEffect, useMemo, useRef, useState } from 'react'
import { showCopyFallback } from './plexi/PromptDialog'
import Modal from './plexi/Modal'
import { createPortal } from 'react-dom'
import type {
  ShareableKind,
  ShareLink,
  ShareScope
} from '@shared/types'
import { useSharesStore } from '../stores/shares'
import { useNodeStore } from '../stores/nodes'
import { useWidgetStore } from '../stores/widgets'
import { viewerUrlFor } from '../lib/shareTokens'
import {
  buildFolderSnapshot,
  buildTaskSnapshot,
  buildWidgetSnapshot,
  buildFileSnapshot,
  generateAnonymousHandle,
  MAX_PUBLIC_FILE_BYTES
} from '../lib/shareSnapshot'
import { buildDocumentSnapshot, buildFolderShareSnapshot } from '../lib/officeShareSnapshot'
import Icon from './Icon'
import DeskShareSheet from './share/DeskShareSheet'
import LiveDocSharing from './LiveDocSharing'

// Universal share dialog — opens from a folder, task, or widget right-click.
// One flow regardless of the entity kind: pick scope (view-only or
// collaborator-copy), mint a link, copy it, see existing links + revoke.
//
// The link URL points at the hosted viewer (`https://view.plexiidesk.com/share/…`).
// In local-mock mode the URL won't resolve yet — there's an honest banner
// telling the user that. Once the matching/viewer service ships, the SAME
// links start working without any change to the dialog.

interface Props {
  kind: ShareableKind
  entityId: string
  // Display label cached at create-time. Used in the link list so revoked
  // / renamed items still make sense.
  label: string
  onClose: () => void
}

export default function ShareDialog({
  kind,
  entityId,
  label,
  onClose
}: Props): JSX.Element {
  // A desk or a room. Both are node kinds and both share the same way; the
  // other kinds (document, widget, file) keep the snapshot-link flow.
  const isDesk = kind === 'folder' || kind === 'task'
  const createFor = useSharesStore((s) => s.createFor)
  const revoke = useSharesStore((s) => s.revoke)
  const remove = useSharesStore((s) => s.remove)
  const refresh = useSharesStore((s) => s.refresh)
  // When sharing a desk (task) that lives in a room (folder), offer to share the
  // room too so the recipient can open the desk in its room context.
  const roomInfo = useMemo(() => {
    if (kind !== 'task') return null
    const nodes = useNodeStore.getState().nodes
    const node = nodes.find((n) => n.id === entityId)
    if (!node?.parentId) return null
    const parent = nodes.find((n) => n.id === node.parentId)
    if (!parent || parent.kind !== 'folder') return null
    return { id: parent.id, title: parent.title || 'room' }
  }, [kind, entityId])
  // CRITICAL: subscribe to the FULL outgoing array (stable ref while the
  // array itself is unchanged) and derive the filtered subset with
  // useMemo. The previous code did the .filter INSIDE the selector,
  // which returned a NEW ARRAY every render → Zustand's default Object.is
  // equality always failed → React saw the value as constantly changing
  // → re-render → re-fire effects → "Maximum update depth exceeded".
  const allOutgoing = useSharesStore((s) => s.outgoing)
  const outgoing = useMemo(
    () => allOutgoing.filter((l) => l.kind === kind && l.entityId === entityId),
    [allOutgoing, kind, entityId]
  )

  const [scope, setScope] = useState<ShareScope>('view')
  const [busy, setBusy] = useState(false)
  const [justCopiedId, setJustCopiedId] = useState<string | null>(null)
  // The most recently minted link — surfaced prominently so the user sees
  // what to copy without scrolling the existing-links list.
  const [fresh, setFresh] = useState<ShareLink | null>(null)
  // Invite-by-email state.
  const invite = useSharesStore((s) => s.invite)
  const recipientsByEntity = useSharesStore((s) => s.recipientsByEntity)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteBusy, setInviteBusy] = useState(false)
  const [inviteMsg, setInviteMsg] = useState<string | null>(null)

  // The token an email invite attaches to: the freshly minted link, else the
  // most recent existing link for this entity. Invites need a live token.
  const inviteToken = fresh?.token ?? outgoing.find((s) => !s.revoked)?.token ?? null
  const entityRecipients = recipientsByEntity[entityId] ?? []

  // The active org's domain, so an invite to someone outside it can be
  // confirmed before it goes out ("send outside the organisation?"). Loaded
  // once per active org; a personal org has no domain and never warns.
  const [orgDomain, setOrgDomain] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { useOrgStore } = await import('../stores/org')
      const { useAccountStore } = await import('../stores/account')
      const orgId = useOrgStore.getState().activeOrgId
      const token = useAccountStore.getState().sessionToken
      if (!token || !orgId || orgId === 'personal') {
        if (!cancelled) setOrgDomain(null)
        return
      }
      const { getInvitePolicy } = await import('../lib/orgsClient')
      const p = await getInvitePolicy(token, orgId)
      if (!cancelled) setOrgDomain(p.domain)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function handleInvite(): Promise<void> {
    const email = inviteEmail.trim().toLowerCase()
    if (!email.includes('@') || !inviteToken || inviteBusy) return
    // Sharing outside the organization domain asks for confirmation first.
    const domain = email.split('@')[1] ?? ''
    if (orgDomain && domain !== orgDomain.toLowerCase()) {
      const ok = window.confirm(
        `${email} is outside ${orgDomain}. Send this share outside the organisation?`
      )
      if (!ok) return
    }
    setInviteBusy(true)
    setInviteMsg(null)
    try {
      const { emailDelivered } = await invite(inviteToken, email)
      setInviteEmail('')
      setInviteMsg(
        emailDelivered
          ? `Invite sent to ${email}.`
          : `${email} added — email will send once the mail provider is configured.`
      )
    } catch (err) {
      setInviteMsg((err as Error).message)
    } finally {
      setInviteBusy(false)
    }
  }

  // Refresh shares once on mount. Sidebar already loads them when the
  // app boots, so this is a "catch up if something else minted a link
  // outside the sidebar's lifecycle" guard. Using a ref-once guard so
  // the effect can't re-fire on parent re-renders (which was part of
  // the previous infinite-loop chain).
  const didRefreshRef = useRef(false)
  useEffect(() => {
    if (didRefreshRef.current) return
    didRefreshRef.current = true
    void refresh()
    // refresh is a stable Zustand action ref; we DON'T put it in deps
    // because we want this to fire exactly once per mount regardless of
    // any selector instability further up the tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape and backdrop close are handled by the Modal wrapper.

  async function copyToClipboard(text: string, linkId: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setJustCopiedId(linkId)
      setTimeout(() => setJustCopiedId((id) => (id === linkId ? null : id)), 1800)
    } catch {
      // Clipboard write failed (rare on Electron) — show it to copy by hand.
      void showCopyFallback('Copy this link manually', text)
    }
  }

  async function handleCreate(scopeOverride?: ShareScope): Promise<void> {
    if (busy) return
    // A scopeOverride lets the one-click "public duplicate link" mint a copy-scope
    // share without the user touching the permission picker; keep the picker in
    // sync so the rest of the dialog reflects what was minted.
    const useScope = scopeOverride ?? scope
    if (scopeOverride && scopeOverride !== scope) setScope(scopeOverride)
    setBusy(true)
    try {
      // Build the snapshot — this is what the viewer page will render and
      // what the recipient sees. For a folder, walks descendants + each
      // task's widgets. For a task, pulls its widgets. For a widget, just
      // the widget itself. Tables get their schema + rows inlined.
      const fromHandle = generateAnonymousHandle()
      let snapshot: unknown = undefined
      // For a raw-file share the bytes are hosted publicly against the token, so
      // they are read here and handed to the store to upload after the mint.
      let fileBlob: { bytes: ArrayBuffer; mimeType: string; ext: string } | undefined
      try {
        if (kind === 'folder') {
          const nodes = useNodeStore.getState().nodes
          const node = nodes.find((n) => n.id === entityId)
          if (node) snapshot = await buildFolderSnapshot(node, nodes, fromHandle)
        } else if (kind === 'task') {
          const nodes = useNodeStore.getState().nodes
          const node = nodes.find((n) => n.id === entityId)
          if (node) snapshot = await buildTaskSnapshot(node, fromHandle)
        } else if (kind === 'widget') {
          const widgets = useWidgetStore.getState().widgets
          const widget = widgets.find((w) => w.id === entityId)
          if (widget) snapshot = await buildWidgetSnapshot(widget, fromHandle)
        } else if (kind === 'document') {
          const doc = await window.api.documents.get(entityId)
          if (doc) snapshot = buildDocumentSnapshot(doc, fromHandle)
        } else if (kind === 'docfolder') {
          snapshot = await buildFolderShareSnapshot(entityId, label, fromHandle)
        } else if (kind === 'file') {
          const file = await window.api.files.get(entityId)
          if (file) {
            snapshot = buildFileSnapshot(
              { name: file.originalName, mimeType: file.mimeType, ext: file.ext, sizeBytes: file.sizeBytes },
              fromHandle
            )
            // Read the bytes to host only when within the public cap; oversized
            // files still resolve to metadata with an honest "too large" note.
            if (file.sizeBytes > 0 && file.sizeBytes <= MAX_PUBLIC_FILE_BYTES) {
              const read = await window.api.files.read(entityId)
              if (read) fileBlob = { bytes: read.buffer, mimeType: read.mimeType || file.mimeType, ext: file.ext }
            }
          }
        }
      } catch {
        // Snapshot building failed (e.g. an IPC error fetching widgets).
        // We still mint the share record locally — the user gets a URL,
        // and the snapshot push to the server will simply be skipped.
        snapshot = undefined
      }
      // The sharer's real handle, for "invited by X" attribution (distinct from
      // the anonymous fromHandle used in the recipient snapshot).
      const { useAccountStore } = await import('../stores/account')
      const createdBy = useAccountStore.getState().account?.handle ?? null
      const created = await createFor({
        kind,
        entityId,
        label,
        scope: useScope,
        snapshot,
        fromHandle,
        createdBy,
        fileBlob
      })
      setFresh(created)
      // Auto-copy fresh links so the common path is one click → in
      // clipboard. The success animation on the chip confirms it landed.
      await copyToClipboard(viewerUrlFor(created.token), created.id)
    } finally {
      setBusy(false)
    }
  }

  const KIND_LABEL: Record<ShareableKind, string> = {
    folder: 'folder',
    task: 'task',
    widget: 'desk item',
    document: 'document',
    docfolder: 'folder',
    file: 'file'
  }

  return createPortal(
    <Modal
      onClose={onClose}
      label={`Share this ${KIND_LABEL[kind]}`}
      z={260}
      className="fb-card w-[460px] max-h-[80vh] flex flex-col"
    >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--edge-soft)]">
          <div className="h-8 w-8 rounded-full bg-accent/10 inline-flex items-center justify-center">
            <Icon name="share" size={16} className="text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--ink-100)]">
              Share this {KIND_LABEL[kind]}
            </h2>
            <p className="text-[11px] text-[var(--ink-50)] truncate">
              {label || '(untitled)'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 rounded inline-flex items-center justify-center text-[var(--ink-40)] hover:bg-[var(--surface-sunken)]"
            aria-label="Close"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {/* Sharing a desk or a room is ONE sheet with two questions, where it
              used to be five stacked controls. The transports underneath are
              unchanged — see share/shareAudience.ts for what was wrong, and why
              the public path still needs a second question rather than one
              merged option. */}
          {isDesk && (
            <DeskShareSheet
              kind={kind as 'folder' | 'task'}
              entityId={entityId}
              label={label}
              roomRootId={roomInfo?.id}
              roomTitle={roomInfo?.title}
            />
          )}
          {/* An office file promotes to a live co-edited document and invites the
              chosen people, via the same shared picker. */}
          {kind === 'document' && <LiveDocSharing documentId={entityId} onClose={onClose} />}

          {/* Documents, widgets and files still use the snapshot-link flow
              below. A desk never reaches it: everything it offered for a desk
              now lives in the sheet above, and showing both was the
              duplication. */}
          {!isDesk && (
            <>
          {/* Read-only link + snapshot sharing below. */}
          {/* Scope picker */}
          <div>
            <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
              Or choose the permission yourself
            </label>
            <div className="space-y-1.5">
              <button
                onClick={() => setScope('view')}
                className={`w-full text-left p-2.5 rounded-md border-2 flex items-start gap-2.5 transition-colors ${
                  scope === 'view'
                    ? 'border-accent bg-accent/[0.06]'
                    : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'
                }`}
              >
                <Icon
                  name="visibility"
                  size={16}
                  className={scope === 'view' ? 'text-accent mt-0.5 shrink-0' : 'text-[var(--ink-40)] mt-0.5 shrink-0'}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-[13px] font-medium ${scope === 'view' ? 'text-accent' : 'text-[var(--ink-90)]'}`}>
                    View only
                  </div>
                  <div className="text-[11px] text-[var(--ink-50)] leading-snug">
                    Anyone with the link can see this {KIND_LABEL[kind]}. No sign-up needed to view.
                  </div>
                </div>
              </button>
              <button
                onClick={() => setScope('copy')}
                className={`w-full text-left p-2.5 rounded-md border-2 flex items-start gap-2.5 transition-colors ${
                  scope === 'copy'
                    ? 'border-accent bg-accent/[0.06]'
                    : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'
                }`}
              >
                <Icon
                  name="content_copy"
                  size={16}
                  className={scope === 'copy' ? 'text-accent mt-0.5 shrink-0' : 'text-[var(--ink-40)] mt-0.5 shrink-0'}
                />
                <div className="flex-1 min-w-0">
                  <div className={`text-[13px] font-medium ${scope === 'copy' ? 'text-accent' : 'text-[var(--ink-90)]'}`}>
                    View + add to their workspace
                  </div>
                  <div className="text-[11px] text-[var(--ink-50)] leading-snug">
                    Recipient can sign up and it appears in their <strong>Shared with me</strong> sidebar — they can copy it into their own workspace.
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Generate + freshly-minted link surface */}
          <button
            onClick={() => void handleCreate()}
            disabled={busy}
            className="w-full text-[13px] py-2 rounded-md bg-accent text-white hover:brightness-110 disabled:opacity-60 inline-flex items-center justify-center gap-1.5 font-medium"
          >
            {busy ? (
              <>
                <Icon name="autorenew" size={13} className="animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Icon name="link" size={13} />
                Create link & copy
              </>
            )}
          </button>

          {fresh && (
            <div className="rounded-md border-2 border-accent bg-accent/[0.06] p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-accent font-semibold">
                <Icon name="check_circle" size={11} />
                Link ready{justCopiedId === fresh.id ? ' — copied!' : ''}
              </div>
              <div className="flex items-center gap-1.5">
                <code className="fb-card flex-1 min-w-0 text-[11px] font-mono px-2 py-1 truncate">
                  {viewerUrlFor(fresh.token)}
                </code>
                <button
                  onClick={() => void copyToClipboard(viewerUrlFor(fresh.token), fresh.id)}
                  className="text-[11px] px-2 py-1 rounded text-[var(--ink-70)] hover:bg-[var(--surface-sunken)]"
                  title="Copy link"
                >
                  <Icon name="content_copy" size={12} />
                </button>
              </div>
            </div>
          )}

          {/* Invite by email — sends a link + lands the share in their inbox */}
          {inviteToken && (
            <div className="rounded-md bg-[var(--surface-sunken)] p-2.5 space-y-2">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)]">
                Invite by email
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleInvite()
                  }}
                  placeholder="name@example.com"
                  data-testid="invite-email"
                  className="fb-field flex-1 text-[12px] px-2 py-1.5 bg-[var(--surface-raised)] text-[var(--ink-90)]"
                />
                <button
                  onClick={() => void handleInvite()}
                  disabled={inviteBusy || !inviteEmail.includes('@')}
                  data-testid="invite-send"
                  className="text-[12px] px-2.5 py-1.5 rounded bg-accent text-white hover:brightness-110 disabled:opacity-50 inline-flex items-center gap-1"
                >
                  <Icon name={inviteBusy ? 'autorenew' : 'send'} size={12} className={inviteBusy ? 'animate-spin' : ''} />
                  Invite
                </button>
              </div>
              {inviteMsg && (
                <div className="text-[11px] text-[var(--ink-50)]">{inviteMsg}</div>
              )}
              {entityRecipients.length > 0 && (
                <div className="space-y-0.5 pt-1 border-t border-[var(--edge-soft)]">
                  {entityRecipients.map((r) => (
                    <div key={r.email} className="flex items-center justify-between gap-2 text-[11px]">
                      <span className="truncate text-[var(--ink-70)]">
                        {(r.handle && r.handle.trim()) || r.email}
                      </span>
                      <span className={r.status === 'accepted' ? 'text-emerald-500' : 'text-[var(--ink-40)]'}>
                        {r.status === 'accepted' ? 'joined' : 'invited'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Existing links for this entity */}
          {outgoing.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-50)] mb-1.5">
                Existing links ({outgoing.length})
              </label>
              <div className="space-y-1">
                {outgoing.map((link) => {
                  const url = viewerUrlFor(link.token)
                  return (
                    <div
                      key={link.id}
                      className={`flex items-center gap-1.5 px-2 py-1.5 rounded-md border ${
                        link.revoked
                          ? 'border-[var(--edge-soft)] bg-[var(--surface-sunken)] opacity-60'
                          : 'border-[var(--edge-soft)] hover:border-[var(--edge-firm)]'
                      }`}
                    >
                      <Icon
                        name={link.scope === 'view' ? 'visibility' : 'content_copy'}
                        size={11}
                        className="text-[var(--ink-40)] shrink-0"
                      />
                      <code className="flex-1 min-w-0 text-[10px] font-mono text-[var(--ink-70)] truncate">
                        {url}
                      </code>
                      {link.revoked && (
                        <span className="text-[9px] uppercase tracking-wider text-red-500 dark:text-red-400">
                          revoked
                        </span>
                      )}
                      {!link.revoked && link.viewCount > 0 && (
                        <span className="text-[10px] text-[var(--ink-50)] tabular-nums">
                          {link.viewCount} views
                        </span>
                      )}
                      {!link.revoked && (
                        <button
                          onClick={() => void copyToClipboard(url, link.id)}
                          className="icon-btn !h-5 !w-5"
                          title="Copy"
                        >
                          <Icon
                            name={justCopiedId === link.id ? 'check' : 'content_copy'}
                            size={11}
                          />
                        </button>
                      )}
                      {!link.revoked && (
                        <button
                          onClick={() => void revoke(link.id)}
                          className="icon-btn !h-5 !w-5"
                          title="Revoke — link stops working"
                        >
                          <Icon name="link_off" size={11} />
                        </button>
                      )}
                      <button
                        onClick={() => void remove(link.id)}
                        className="icon-btn !h-5 !w-5 hover:!text-red-700"
                        title="Delete this link"
                      >
                        <Icon name="delete" size={11} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
            </>
          )}
        </div>
    </Modal>,
    document.body
  )
}
