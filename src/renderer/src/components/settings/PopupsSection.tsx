import { useEffect, useState } from 'react'
import type { DeskPopupMode } from '@shared/deskPopup'

// Settings → Advanced → Pop-ups. Since 4.3.31 a sign-in or scripted pop-up from
// a desk browser object or a connected app opens as a card on the desk. This is
// the escape hatch back to separate OS windows, for a site that misbehaves in
// the card. PLEXI_POPUPS_NATIVE=1 forces native windows; the toggle then shows
// that and cannot override it.
export default function PopupsSection(): JSX.Element | null {
  const [mode, setMode] = useState<DeskPopupMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.api?.deskPopups
      ?.getMode()
      .then((m) => {
        if (alive) setMode(m)
      })
      .catch(() => {
        if (alive) setMode(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // Not served (the browser runtime has no native windows): say nothing.
  if (!mode) return null

  async function toggle(native: boolean): Promise<void> {
    setError(null)
    try {
      setMode(await window.api.deskPopups.setNativeMode(native))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that setting.')
    }
  }

  return (
    <div className="px-3 py-3 border-t border-[var(--edge-hairline)]" data-testid="popups-section">
      <div className="fb-t-caption uppercase tracking-[0.12em] font-medium mb-1">Pop-ups</div>
      <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
        <span className="text-xs text-[var(--ink-70)]">Open sign-in pop-ups in separate windows</span>
        <input
          type="checkbox"
          checked={mode.native}
          disabled={mode.forcedByEnv}
          onChange={(e) => void toggle(e.target.checked)}
          className="h-3.5 w-3.5 accent-accent cursor-pointer disabled:cursor-not-allowed"
          data-testid="popups-native-toggle"
        />
      </label>
      <div className="text-[11.5px] leading-relaxed text-[var(--ink-50)]">
        {mode.forcedByEnv
          ? 'PLEXI_POPUPS_NATIVE is set, so pop-ups always open as separate windows.'
          : 'Off: sign-in and app pop-ups open as a card on your desk. Turn this on if a site’s sign-in misbehaves there. Applies to the next pop-up.'}
      </div>
      {error && <div className="mt-1 text-[11.5px] text-[var(--danger,#b42318)]">{error}</div>}
    </div>
  )
}
