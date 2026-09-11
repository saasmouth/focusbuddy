// "Send this desk to someone for 48 hours."
//
// This replaces the claim-link panel for sharing OUTWARD. The difference is not
// cosmetic: a claim link created an account and a lasting two-way grant, and the
// cloud app no longer has accounts at all. What this mints is a snapshot with a
// clock on it — anyone with the link opens the desk in a browser, edits their
// own copy, and is pointed at the desktop app if they want to keep it.
//
// Nothing they do comes back. That is stated here rather than left to be
// discovered, because a sender who believes otherwise will send the wrong desk.
import { useCallback, useEffect, useState } from 'react'
import Icon from './Icon'
import {
  mintEphemeralShare, listEphemeralShares, revokeEphemeralShare, timeLeft, shareUrlFor,
  type EphemeralShare
} from '../lib/ephemeralShareClient'
import { cloudAppUrl } from '../lib/signalConfig'

export default function EphemeralDeskShare({ rootId }: { rootId: string }): JSX.Element {
  const [shares, setShares] = useState<EphemeralShare[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [omitted, setOmitted] = useState<Array<{ name: string; sizeBytes: number }>>([])
  const [copied, setCopied] = useState<string | null>(null)
  const published = cloudAppUrl() !== ''

  const refresh = useCallback(async () => {
    const all = await listEphemeralShares()
    setShares(all.filter((s) => s.rootId === rootId))
  }, [rootId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The countdown has to move on its own or it is just a timestamp.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const mint = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setOmitted([])
    const res = await mintEphemeralShare(rootId)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not create that link.')
      return
    }
    // Files too big to travel are named now, not discovered by the recipient.
    if (res.filesOmitted?.length) setOmitted(res.filesOmitted.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes })))
    await refresh()
    if (res.url) void copy(res.share!.token)
  }

  const copy = async (token: string): Promise<void> => {
    const url = shareUrlFor(token)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(token)
      window.setTimeout(() => setCopied(null), 1600)
    } catch {
      /* clipboard refused; the link is still on screen */
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-[var(--ink-70)]">Send for 48 hours</span>
        <button
          onClick={() => void mint()}
          disabled={busy || !published}
          className="btn-ghost text-[11px] px-2 py-0.5 disabled:opacity-40"
          title={published ? 'Create a link that works for 48 hours' : 'No cloud app has been published for this build'}
        >
          {busy ? 'Packing…' : 'Create link'}
        </button>
      </div>

      <p className="text-[10px] text-[var(--ink-40)] leading-snug">
        Anyone with the link opens this desk in a browser — no account, no install. They can edit
        their own copy, but <strong>nothing comes back to you</strong>. After 48 hours it is deleted
        from the server and from their browser.
      </p>

      {!published && (
        <p className="text-[10px] text-amber-600 leading-snug">
          This build has no cloud app address, so a link would point nowhere. Set VITE_CLOUD_APP_URL
          when building to turn this on.
        </p>
      )}

      {error && <p className="text-[10px] text-red-600 leading-snug">{error}</p>}

      {omitted.length > 0 && (
        <p className="text-[10px] text-amber-600 leading-snug">
          Too large to travel, so the recipient will not see {omitted.length === 1 ? 'it' : 'them'}:{' '}
          {omitted.map((f) => f.name).join(', ')}.
        </p>
      )}

      {shares.length > 0 && (
        <div className="flex flex-col gap-1 pt-0.5">
          {shares.map((s) => (
            <div key={s.token} className="flex items-center gap-1.5 text-[11px]">
              <Icon name="schedule" size={11} className="text-[var(--ink-40)] shrink-0" />
              <span className="truncate text-[var(--ink-80)]">
                {timeLeft(s.expiresAt)}
                <span className="text-[var(--ink-40)]">
                  {' '}· {(s.sizeBytes / 1e6).toFixed(1)} MB
                  {s.opens > 0 && ` · opened ${s.opens}×`}
                </span>
              </span>
              <div className="flex items-center gap-1 shrink-0 ml-auto">
                <button onClick={() => void copy(s.token)} className="icon-btn !h-5 !w-5" title="Copy link">
                  <Icon name={copied === s.token ? 'check' : 'content_copy'} size={11} />
                </button>
                <button
                  onClick={() => void revokeEphemeralShare(s.token).then(() => refresh())}
                  className="icon-btn !h-5 !w-5 hover:!text-red-600"
                  title="Delete this share now"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            </div>
          ))}
          <p className="text-[10px] text-[var(--ink-40)] leading-snug pt-0.5">
            Deleting a share removes it from the server at once. Anyone reading it loses the desk on
            their next reload.
          </p>
        </div>
      )}
    </div>
  )
}
