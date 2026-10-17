import { useEffect, useState } from 'react'

// Settings → Advanced → Connected app sign-ins. Electron, like any browser,
// forgets "session" cookies when it quits, and plenty of web apps keep your
// sign-in in one — so every quit or update signed those apps out and their
// unread counts stopped. On (the default), Plexii keeps those cookies for 30
// days from their last use; off is plain browser behaviour. Cookies a site gives
// its own expiry are never changed, and signing out of an app still signs you
// out. See src/main/sessionPersistence.ts.
export default function AppSessionsSection(): JSX.Element | null {
  const [keep, setKeep] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api?.sessions
      ?.getKeepSignedIn()
      .then((s) => {
        if (alive) setKeep(s.keep)
      })
      .catch(() => {
        if (alive) setKeep(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // Not served (the browser runtime has no cookie jars of its own): say nothing.
  if (keep === null) return null

  async function toggle(next: boolean): Promise<void> {
    setError(null)
    try {
      setKeep((await window.api.sessions.setKeepSignedIn(next)).keep)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that setting.')
    }
  }

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-hairline)]" data-testid="app-sessions-section">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">Connected app sign-ins</div>
      <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
        <span className="text-xs text-[var(--ink-70)]">Keep connected apps signed in between launches</span>
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-accent cursor-pointer"
          data-testid="keep-apps-signed-in-toggle"
        />
      </label>
      <div className="text-[11.5px] leading-relaxed text-[var(--ink-50)]">
        {keep
          ? 'On: sign-ins that a site would only keep until you quit are kept for 30 days from their last use, so apps stay signed in after a restart or update. Signing out of an app still signs you out.'
          : 'Off: plain browser behaviour — an app that keeps its sign-in only until you quit will ask you to sign in again after every restart.'}
      </div>
      {error && <div className="mt-1 text-[11.5px] text-[var(--danger,#b42318)]">{error}</div>}
    </div>
  )
}
