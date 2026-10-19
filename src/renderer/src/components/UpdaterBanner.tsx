// Compact auto-update affordance.
//
// Lives in the Footer next to the version text. Default state: silent.
// When the main-process autoUpdater reports anything but `idle` or
// `none`, this becomes visible.
//
// State machine matches main/autoUpdate.ts UpdateState:
//   idle / none         → nothing rendered
//   checking            → tiny pulsing dot
//   available           → "Update available · vX.Y.Z" (passive — download
//                         starts automatically because autoDownload=true)
//   downloading         → "Downloading update · NN%"
//   ready               → "Install PlexiDesk vX.Y.Z" button → restarts app
//   error               → red text + retry link
//
// The banner is intentionally tiny — sits in the footer row, not a
// modal. Auto-updates land as a chip the user can tap when convenient
// rather than a popup that demands attention.

import { useEffect, useState } from 'react'
import Icon from './Icon'

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string }
  | { kind: 'downloading'; percent: number }
  | { kind: 'ready'; version: string; releaseNotes?: string }
  | { kind: 'none'; currentVersion: string }
  | { kind: 'error'; message: string }

export default function UpdaterBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })
  // macOS cannot auto-install (ad-hoc signature), so there an available update
  // is a one-click download of the release rather than an in-place install.
  const isMac = window.api.platform === 'darwin'

  useEffect(() => {
    // Pull whatever state was missed before this component mounted.
    let cancelled = false
    void window.api.update.getState().then((s) => { if (!cancelled) setState(s) })
    const detach = window.api.update.onState((s) => setState(s))
    return () => {
      cancelled = true
      detach?.()
    }
  }, [])

  if (state.kind === 'idle' || state.kind === 'none') return null

  if (state.kind === 'checking') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[var(--ink-40)]"
        title="Checking for updates…"
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-stone-400 animate-pulse" />
        <span>Checking…</span>
      </span>
    )
  }

  if (state.kind === 'available') {
    // macOS: one-click download and self-replace, since the ad-hoc signature
    // blocks Squirrel's silent install. The app fetches the release, swaps
    // itself in place, and relaunches.
    if (isMac) {
      return (
        <button
          onClick={() => { void window.api.update.downloadAndInstall() }}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 font-medium"
          title={`Update PlexiiDesk to v${state.version} and relaunch`}
          data-testid="updater-download"
        >
          <Icon name="download" size={11} />
          <span>Update to v{state.version}</span>
        </button>
      )
    }
    // Windows: the download starts automatically (autoDownload), so this is
    // passive until the `ready` state arrives.
    return (
      <span
        className="inline-flex items-center gap-1 text-accent"
        title={state.releaseNotes ? state.releaseNotes.slice(0, 200) : `v${state.version} available — downloading`}
      >
        <Icon name="download" size={11} />
        <span>Update available · v{state.version}</span>
      </span>
    )
  }

  if (state.kind === 'downloading') {
    return (
      <span className="inline-flex items-center gap-1 text-accent">
        <Icon name="download" size={11} className="animate-pulse" />
        <span>Downloading · {state.percent}%</span>
      </span>
    )
  }

  if (state.kind === 'ready') {
    // macOS one-click flow: the swap helper has taken over and the app is about
    // to quit and relaunch, so show a passive installing label rather than a
    // button.
    if (isMac) {
      return (
        <span
          className="inline-flex items-center gap-1 text-accent"
          data-testid="updater-installing"
        >
          <Icon name="download" size={11} className="animate-pulse" />
          <span>Installing v{state.version}</span>
        </span>
      )
    }
    return (
      <button
        onClick={() => { void window.api.update.installAndRestart() }}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-accent hover:bg-accent/10 font-medium"
        title={state.releaseNotes ? state.releaseNotes.slice(0, 240) : `Install v${state.version} and restart`}
      >
        <Icon name="rocket_launch" size={11} />
        <span>Install v{state.version}</span>
      </button>
    )
  }

  if (state.kind === 'error') {
    // Two escapes, never a dead end. "Retry" re-runs the check (fixes transient
    // network blips). "Download manually" opens the releases page — the reliable
    // path when the in-app self-update can't complete (an old ad-hoc-signed
    // build whose updater can't replace itself, a blocked swap, a 404 on an
    // arch we don't ship). Without the manual escape, retry just loops the user
    // back into the same failure.
    // Show the real reason inline (truncated), not just on hover — a hidden
    // error message is exactly what made past update failures hard to diagnose.
    const reason = (state.message || '').replace(/\s+/g, ' ').trim()
    const shortReason = reason.length > 64 ? `${reason.slice(0, 64)}…` : reason
    return (
      <span className="inline-flex items-center gap-1.5 text-red-400" title={reason}>
        <Icon name="error_outline" size={11} />
        <span className="text-red-400/90">
          Update failed{shortReason ? `: ${shortReason}` : ''}
        </span>
        <button
          onClick={() => { void window.api.update.check() }}
          className="hover:text-red-300 underline-offset-2 underline"
          data-testid="updater-retry"
        >
          retry
        </button>
        <span aria-hidden className="text-red-400/50">·</span>
        <button
          onClick={() => { void window.api.update.openDownload() }}
          className="hover:text-red-300 underline-offset-2 underline"
          title="Open the releases page to download and install the latest version manually"
          data-testid="updater-manual-download"
        >
          download manually
        </button>
      </span>
    )
  }

  return null
}
