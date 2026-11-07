import { useState, type JSX } from 'react'
import { useLiveDeskPublisher } from '../lib/useLiveDeskPublisher'
import { viewerUrlFor } from '../lib/shareTokens'

// "Live web view" in the share dialog.
//
// The design is explicit that an owner must be able to see whether publishing
// is live, stale, paused, failed or revoked, and be able to pause without
// destroying the link. Someone who believes a public page is current when
// publishing has been failing for an hour is worse off than someone who is
// told, so the last error is shown rather than swallowed.

function relative(ts: number | null): string {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 10) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts).toLocaleDateString()
}

export default function LiveWebViewPanel({ deskId }: { deskId: string }): JSX.Element {
  const { status, start, stop, setPaused, publishNow } = useLiveDeskPublisher(deskId)
  const [copied, setCopied] = useState(false)
  const url = status.token ? viewerUrlFor(status.token) : null

  const state = !status.token
    ? 'off'
    : status.lastError
      ? 'failed'
      : status.paused
        ? 'paused'
        : 'live'

  const tone = {
    off: 'text-stone-400',
    live: 'text-emerald-400',
    paused: 'text-stone-300',
    failed: 'text-amber-400'
  }[state]

  return (
    <div className="rounded-lg border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">Live web view</div>
          <div className="text-[11px] text-stone-500">
            A public page that updates as you work. Visitors cannot change it, but anyone can download a copy of it on Plexii.
          </div>
        </div>
        <span className={`text-[10px] uppercase tracking-[0.16em] shrink-0 ${tone}`}>
          {state === 'off' ? 'Off' : state === 'live' ? 'Live' : state === 'paused' ? 'Paused' : 'Publish failed'}
        </span>
      </div>

      {!status.token && (
        <button
          className="text-xs px-2 py-1 rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-50"
          onClick={() => void start()}
          disabled={status.busy}
        >
          {status.busy ? 'Publishing…' : 'Publish this desk to the web'}
        </button>
      )}

      {status.token && (
        <>
          <div className="flex items-center gap-1">
            <input
              readOnly
              value={url ?? ''}
              className="flex-1 min-w-0 text-[11px] px-2 py-1 rounded bg-black/30 border border-white/10 text-stone-300"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className="text-[11px] px-2 py-1 rounded hover:bg-white/10 text-stone-300"
              onClick={() => {
                if (!url) return
                void navigator.clipboard.writeText(url)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <div className="text-[11px] text-stone-500">
            Revision {status.revision} · published {relative(status.lastPublishedAt)}
          </div>

          {status.lastError && (
            // Never silently stale: if publishing is failing the owner is told,
            // because the public page is still showing the last good revision.
            <div className="text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-1">
              Last publish failed: {status.lastError}
            </div>
          )}

          <div className="flex items-center gap-1 pt-0.5">
            <button
              className="text-[11px] px-2 py-1 rounded hover:bg-white/10 text-stone-300"
              onClick={() => void setPaused(!status.paused)}
            >
              {status.paused ? 'Resume publishing' : 'Pause publishing'}
            </button>
            <button
              className="text-[11px] px-2 py-1 rounded hover:bg-white/10 text-stone-300"
              onClick={() => void publishNow()}
              disabled={status.busy}
            >
              Publish now
            </button>
            <button
              className="text-[11px] px-2 py-1 rounded hover:bg-red-500/15 text-red-300 ml-auto"
              onClick={() => void stop()}
            >
              Stop sharing
            </button>
          </div>
          <div className="text-[10px] text-stone-600">
            Pausing keeps the link working and stops updating it. Stopping revokes the link,
            disconnects anyone viewing, and deletes the published copy.
          </div>
        </>
      )}
    </div>
  )
}
