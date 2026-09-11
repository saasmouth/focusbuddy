import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  getDeskAccess,
  shareDeskLive,
  revokeDeskAccess,
  revokeDeskInvite,
  type DeskAccess,
  type DeskInvite
} from '../lib/deskShareClient'
import SharePeoplePicker, { type SharePick } from './SharePeoplePicker'
import DeskClaimLinks from './DeskClaimLinks'
import EphemeralDeskShare from './EphemeralDeskShare'
import { usePeopleStore } from '../lib/peopleDirectory'
import { useOrgStore, PERSONAL_ORG_ID } from '../stores/org'
import { useAccountStore } from '../stores/account'
import { inviteMember } from '../lib/orgsClient'

// Live sharing for a desk or room (a folder or task node). Grants named people
// bidirectional near-live access. Pick several teammates from the org directory
// at once (by name, @handle or email), invite by email, and optionally share the
// desk's room too. External emails are added to the org as guests so they resolve
// and can be @mentioned later.
export default function LiveDeskSharing({
  rootId,
  roomRootId,
  roomTitle
}: {
  rootId: string
  roomRootId?: string
  roomTitle?: string
}): JSX.Element {
  const [access, setAccess] = useState<DeskAccess | null>(null)
  const [perm, setPerm] = useState<'view' | 'edit'>('edit')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [shareRoom, setShareRoom] = useState(false)

  const activeOrgId = useOrgStore((s) => s.activeOrgId)
  const hasOrg = !!activeOrgId && activeOrgId !== PERSONAL_ORG_ID
  const loadPeople = usePeopleStore((s) => s.load)

  useEffect(() => {
    let cancelled = false
    void getDeskAccess(rootId).then((a) => {
      if (!cancelled) setAccess(a)
    })
    return () => {
      cancelled = true
    }
  }, [rootId])

  const owner = access?.owner ?? null
  const grants = (access?.grants ?? []).filter((g) => g.accountId !== owner)
  const pending = access?.pending ?? []
  const anyone = grants.length > 0 || pending.length > 0
  const excludeAccountIds = new Set([owner, ...grants.map((g) => g.accountId)].filter(Boolean) as string[])
  const excludeEmails = new Set(pending.map((p) => p.email.toLowerCase()))
  const myDomain = (useAccountStore.getState().account?.email ?? useAccountStore.getState().cachedEmail ?? '')
    .split('@')[1]
    ?.toLowerCase()

  async function onShare(picks: SharePick[]): Promise<{ ok: boolean; error?: string }> {
    setBusy(true)
    setMsg(null)
    // Add any external typed email to the org as a guest first, so it resolves.
    if (hasOrg && activeOrgId) {
      const token = useAccountStore.getState().sessionToken
      if (token) {
        for (const p of picks) {
          if (!p.accountId && p.email) {
            const dom = p.email.split('@')[1]?.toLowerCase()
            if (dom && myDomain && dom !== myDomain) {
              await inviteMember(token, activeOrgId, p.email, 'guest').catch(() => {})
            }
          }
        }
        void loadPeople()
      }
    }
    const invites: DeskInvite[] = picks.map((p) =>
      p.accountId ? { accountId: p.accountId, permission: perm } : { email: p.email, permission: perm }
    )
    const r = await shareDeskLive(rootId, invites, perm)
    let roomShared = false
    if (r.ok && shareRoom && roomRootId) {
      const roomResult = await shareDeskLive(roomRootId, invites, perm)
      roomShared = roomResult.ok
    }
    if (r.ok && r.access) {
      setAccess(r.access)
      const base = `Shared with ${picks.length} ${picks.length === 1 ? 'person' : 'people'}.`
      const roomNote = roomShared
        ? ` Room "${roomTitle}" too.`
        : shareRoom && roomRootId
          ? ` The room could not be shared, so only this desk was.`
          : ''
      setMsg(base + roomNote)
      setBusy(false)
      return { ok: true }
    }
    setMsg(r.error || 'Could not share the desk.')
    setBusy(false)
    return { ok: false, error: r.error }
  }

  return (
    <div className="rounded-md border-2 border-accent/40 bg-accent/[0.04] p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-accent">
        <Icon name="bolt" size={12} />
        Live sharing (real-time)
      </div>
      <p className="text-[11px] text-[var(--ink-50)] leading-snug">
        Everyone you add sees each other&apos;s changes as they happen. Only the people listed can open it.
      </p>

      <SharePeoplePicker
        excludeAccountIds={excludeAccountIds}
        excludeEmails={excludeEmails}
        perm={perm}
        onPermChange={setPerm}
        busy={busy}
        onShare={onShare}
        msg={msg}
        footer={
          roomRootId ? (
            <label className="flex items-start gap-2 text-[11px] text-[var(--ink-60)] cursor-pointer">
              <input
                type="checkbox"
                checked={shareRoom}
                onChange={(e) => setShareRoom(e.target.checked)}
                data-testid="livedesk-share-room"
                className="mt-0.5 accent-[rgb(var(--accent))]"
              />
              <span>
                Also share the room <span className="font-semibold text-[var(--ink-80)]">{roomTitle}</span> and
                everything in it.
              </span>
            </label>
          ) : undefined
        }
      />

      {/* Sharing with someone whose email you do not know. Placed after the
          people picker because naming a person is the commoner act; this is the
          fallback when you cannot. */}
      <EphemeralDeskShare rootId={rootId} />
      <DeskClaimLinks rootId={rootId} />

      {anyone && (
        <div className="space-y-0.5 pt-1 border-t border-[var(--edge-soft)]">
          {grants.map((g) => (
            <div key={g.accountId} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-[var(--ink-80)]">
                {g.name || g.handle || g.email || g.accountId}
                <span className="text-[var(--ink-40)]"> · {g.permission === 'view' ? 'view' : 'can edit'}</span>
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-emerald-500 text-[10px] uppercase tracking-wide">live</span>
                <button
                  onClick={() => void revokeDeskAccess(rootId, g.accountId).then((a) => a && setAccess(a))}
                  className="icon-btn !h-5 !w-5 hover:!text-red-600"
                  title="Remove access"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            </div>
          ))}
          {pending.map((p) => (
            <div key={p.email} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate text-[var(--ink-70)]">{p.email}</span>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[var(--ink-40)] text-[10px] uppercase tracking-wide">granted</span>
                <button
                  onClick={() => void revokeDeskInvite(rootId, p.email).then((a) => a && setAccess(a))}
                  className="icon-btn !h-5 !w-5 hover:!text-red-600"
                  title="Revoke access"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            </div>
          ))}
          {pending.length > 0 && (
            <p className="text-[10px] text-[var(--ink-40)] leading-snug pt-0.5">
              Access is granted for these addresses. They will see it when they sign in with that
              email. No email is sent from here.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
