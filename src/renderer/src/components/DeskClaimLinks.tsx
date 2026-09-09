import { useEffect, useState } from 'react'
import Icon from './Icon'
import {
  createDeskClaimLink,
  listDeskClaimLinks,
  revokeDeskClaimLink,
  type DeskClaimLink
} from '../lib/deskShareClient'
import { cloudAppUrl } from '../lib/signalConfig'

// Sharing a desk with someone who has no account and whose email you do not
// know. The people picker above this covers "share with Sam"; this covers
// "here, have a look" -- a link you hand out, which turns whoever opens it into
// a real grantee once they sign up.
//
// The terms are per link because the two acts are different: showing someone
// your desk and inviting them to work on it carry different risk, and a link
// that gets forwarded is the case worth designing for. So each link records who
// claimed it, and a spent single-use link is visibly spent.
export default function DeskClaimLinks({ rootId }: { rootId: string }): JSX.Element {
  const [links, setLinks] = useState<DeskClaimLink[]>([])
  const [claims, setClaims] = useState<
    Array<{ token: string; accountId: string; name: string; permission: string; claimedAt: number }>
  >([])
  const [perm, setPerm] = useState<'view' | 'edit'>('view')
  const [singleUse, setSingleUse] = useState(false)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const appBase = cloudAppUrl()

  const refresh = async (): Promise<void> => {
    const r = await listDeskClaimLinks(rootId)
    setLinks(r.links)
    setClaims(r.claims)
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId])

  const urlFor = (token: string): string => `${appBase}/claim/${token}`

  const create = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    const r = await createDeskClaimLink(rootId, { permission: perm, singleUse })
    setBusy(false)
    if (!r.ok || !r.link) {
      setMsg(r.error ?? 'Could not create the link.')
      return
    }
    await refresh()
    if (appBase) void copy(r.link.token)
  }

  const copy = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(urlFor(token))
      setCopied(token)
      window.setTimeout(() => setCopied((c) => (c === token ? null : c)), 1800)
    } catch {
      setMsg('Could not copy to the clipboard — select the link and copy it manually.')
    }
  }

  const claimsFor = (token: string): number => claims.filter((c) => c.token === token).length

  return (
    <div className="rounded-md border border-[var(--edge-soft)] p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[var(--ink-60)]">
        <Icon name="link" size={12} />
        Share by link
      </div>
      <p className="text-[11px] text-[var(--ink-50)] leading-snug">
        Anyone who opens the link can sign up and add this desk to their own Plexii. They do not need
        an account first, or the app installed.
      </p>

      {!appBase && (
        // Minting a link to a page nobody can open is worse than having no
        // button: the sender never finds out it was broken.
        <p className="text-[11px] text-amber-600 leading-snug">
          No cloud app address is configured for this build, so a link would point nowhere. Set
          VITE_CLOUD_APP_URL when building to turn this on.
        </p>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={perm}
          onChange={(e) => setPerm(e.target.value as 'view' | 'edit')}
          disabled={!appBase || busy}
          className="text-[11px] rounded border border-[var(--edge-soft)] bg-[var(--surface-sunken)] px-1.5 py-1"
          data-testid="claim-link-perm"
        >
          <option value="view">Can view</option>
          <option value="edit">Can edit</option>
        </select>
        <label className="flex items-center gap-1.5 text-[11px] text-[var(--ink-60)] cursor-pointer">
          <input
            type="checkbox"
            checked={singleUse}
            onChange={(e) => setSingleUse(e.target.checked)}
            disabled={!appBase || busy}
            className="accent-[rgb(var(--accent))]"
            data-testid="claim-link-single-use"
          />
          One person only
        </label>
        <button
          onClick={() => void create()}
          disabled={!appBase || busy}
          className="btn-secondary !text-[11px] !py-1 !px-2 disabled:opacity-40"
          data-testid="claim-link-create"
        >
          {busy ? 'Creating…' : 'Create link'}
        </button>
      </div>

      {msg && <p className="text-[11px] text-red-600 leading-snug">{msg}</p>}

      {links.length > 0 && (
        <div className="space-y-0.5 pt-1 border-t border-[var(--edge-soft)]">
          {links.map((l) => {
            const used = l.singleUse && l.claims > 0
            return (
              <div key={l.token} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="truncate text-[var(--ink-80)]">
                  {l.permission === 'edit' ? 'Can edit' : 'Can view'}
                  {l.singleUse && <span className="text-[var(--ink-40)]"> · one person</span>}
                  {claimsFor(l.token) > 0 && (
                    <span className="text-[var(--ink-40)]">
                      {' '}
                      · {claimsFor(l.token)} joined
                    </span>
                  )}
                  {l.revoked && <span className="text-red-600"> · revoked</span>}
                  {used && !l.revoked && <span className="text-[var(--ink-40)]"> · used</span>}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {!l.revoked && (
                    <button
                      onClick={() => void copy(l.token)}
                      className="icon-btn !h-5 !w-5"
                      title="Copy link"
                    >
                      <Icon name={copied === l.token ? 'check' : 'content_copy'} size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => void revokeDeskClaimLink(l.token).then(() => refresh())}
                    className="icon-btn !h-5 !w-5 hover:!text-red-600"
                    title="Stop this link working"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </div>
              </div>
            )
          })}
          <p className="text-[10px] text-[var(--ink-40)] leading-snug pt-0.5">
            Revoking a link stops it being claimed again. People who already joined through it keep
            their access — remove them in the list above.
          </p>
        </div>
      )}
    </div>
  )
}
