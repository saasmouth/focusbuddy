// Entry point for Plexii in the browser.
//
// The cloud app is not a product. It is the delivery end of one feature: someone
// was sent a desk, and for 48 hours they can open it here without installing
// anything or creating an account. Everything else about this app — sign-in,
// sign-up, two-way sync, a workspace of your own — is gone, because the answer
// to "can I use Plexii in a browser" is no, and the honest place to say so is
// the front door.
//
// So there are exactly two things this file can show:
//
//   a live share token  → unpack the desk and hand the renderer over to it
//   anything else       → the download page
//
// The order still matters underneath. window.api is installed before the
// renderer is imported, because the renderer's first modules read it at module
// scope; and the file server is up before any widget renders a picture.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { installBrowserApi, installFileServer } from './api/bridge'
import {
  shareTokenFromUrl, previewShare, fetchShareBundle, alreadyImported, markImported,
  wipeLocalCopy, countdown, msLeft, downloadBundle, type ShareOffer, type ShareRefusal
} from './api/share'
import { markShareRecipient } from '@renderer/lib/shareMode'

const DESKTOP_DOWNLOAD_URL = 'https://plexii.app/download'

/** The page for everyone who did not arrive with a live link. */
function DownloadPage({ reason }: { reason?: ShareRefusal }): React.JSX.Element {
  const line =
    reason === 'expired'
      ? 'That share has expired. Shared desks are available for 48 hours, then they are deleted.'
      : reason === 'revoked'
        ? 'That share was turned off by the person who sent it.'
        : reason === 'offline'
          ? 'That link could not be reached just now. Check your connection and try again.'
          : reason === 'unknown'
            ? 'That link is not a share we recognise. It may have already been deleted.'
            : 'Plexii is a desktop app. Your desks, files and notes live on your own machine.'

  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.sub}>{line}</div>
        <a style={S.primary} href={DESKTOP_DOWNLOAD_URL}>Download Plexii for desktop</a>
        {reason && (
          <div style={S.fine}>
            If you still need this desk, ask whoever sent it for a fresh link.
          </div>
        )}
      </div>
    </div>
  )
}

/** The offer, before the desk is downloaded. */
function ShareOfferCard({
  offer, busy, onOpen
}: { offer: ShareOffer; busy: boolean; onOpen: () => void }): React.JSX.Element {
  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.offer}>
          <div style={S.offerWho}>A desk has been shared with you</div>
          <div style={S.offerTitle}>{offer.title || 'A desk'}</div>
          <div style={S.offerWhat}>
            {countdown(offer.expiresAt)} · {(offer.sizeBytes / 1e6).toFixed(1)} MB
          </div>
        </div>
        <div style={S.sub}>
          You can open it here and change anything you like — it is your own copy, and nothing
          you do travels back. After 48 hours it is deleted.
        </div>
        <button style={S.primary} onClick={onOpen} disabled={busy}>
          {busy ? 'Opening the desk…' : 'Open the desk'}
        </button>
        <div style={S.fine}>No account needed.</div>
      </div>
    </div>
  )
}

/**
 * The bar that sits above the desk for as long as the copy lives.
 *
 * It is not decoration. It is the only thing telling someone that what they are
 * editing is temporary, and the only route to keeping it.
 */
function ExpiryBar({
  offer, bundle, onExpired
}: { offer: ShareOffer; bundle: string | null; onExpired: () => void }): React.JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (msLeft(offer.expiresAt) === 0) onExpired()
      else tick((n) => n + 1)
    }, 30_000)
    return () => window.clearInterval(t)
  }, [offer.expiresAt, onExpired])

  const left = msLeft(offer.expiresAt)
  const urgent = left < 4 * 60 * 60 * 1000
  return (
    <div style={{ ...S.bar, background: urgent ? '#3a2216' : '#171a21' }}>
      <span style={S.barText}>
        <strong>{offer.title || 'Shared desk'}</strong> · {countdown(offer.expiresAt)}
        <span style={S.barFine}> — this copy is deleted when the timer ends</span>
      </span>
      <span style={S.barActions}>
        {bundle && (
          <button style={S.barGhost} onClick={() => downloadBundle(bundle, offer.title)}>
            Save desk file
          </button>
        )}
        <a style={S.barPrimary} href={DESKTOP_DOWNLOAD_URL}>Keep it — get the desktop app</a>
      </span>
    </div>
  )
}

type State =
  | { kind: 'checking' }
  | { kind: 'download'; reason?: ShareRefusal }
  | { kind: 'offer'; offer: ShareOffer }
  | { kind: 'opening'; offer: ShareOffer }
  | { kind: 'ready'; offer: ShareOffer }
  | { kind: 'failed'; detail: string }

function Boot(): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'checking' })
  const [busy, setBusy] = useState(false)
  const bundleRef = useRef<string | null>(null)
  const token = shareTokenFromUrl()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!token) {
        // No link: this app has nothing else to offer, and says so.
        await wipeLocalCopy()
        if (!cancelled) setState({ kind: 'download' })
        return
      }
      const preview = await previewShare(token)
      if (cancelled) return
      if (!preview.ok) {
        // A dead link takes its copy with it. Offline is the exception: the
        // share may be perfectly alive and the network is not.
        if (preview.reason !== 'offline') await wipeLocalCopy()
        setState({ kind: 'download', reason: preview.reason })
        return
      }
      markShareRecipient(token)
      setState({ kind: 'offer', offer: preview.offer })
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const open = useCallback(() => {
    if (state.kind !== 'offer' || !token) return
    setBusy(true)
    const offer = state.offer
    void (async () => {
      try {
        installBrowserApi()
        await installFileServer()

        if (!alreadyImported(token)) {
          const text = await fetchShareBundle(token)
          if (!text) {
            // It was alive a moment ago at the preview, so this is the share
            // being revoked or expiring between the two calls.
            await wipeLocalCopy()
            setState({ kind: 'download', reason: 'expired' })
            return
          }
          bundleRef.current = text
          const res = (await window.api.shares.importBundle(JSON.parse(text))) as { ok?: boolean; reason?: string }
          if (!res?.ok) throw new Error(res?.reason ?? 'the desk could not be unpacked')
          markImported(token)
        } else {
          // Re-opened later: the desk is already here, but the file is still
          // wanted for the "save desk file" button.
          bundleRef.current = await fetchShareBundle(token)
        }

        setState({ kind: 'opening', offer })
        await import('@renderer/main')
        setState({ kind: 'ready', offer })
      } catch (err) {
        setState({ kind: 'failed', detail: (err as Error).message })
      } finally {
        setBusy(false)
      }
    })()
  }, [state, token])

  const expire = useCallback(() => {
    void (async () => {
      await wipeLocalCopy()
      window.location.replace('/')
    })()
  }, [])

  if (state.kind === 'checking') {
    return <div style={S.shell}><div style={S.sub}>Checking that link…</div></div>
  }
  if (state.kind === 'download') return <DownloadPage reason={state.reason} />
  if (state.kind === 'offer') return <ShareOfferCard offer={state.offer} busy={busy} onOpen={open} />
  if (state.kind === 'failed') {
    return (
      <div style={S.shell}>
        <div style={S.card}>
          <div style={S.brand}>Plexii</div>
          <div style={S.sub}>That desk could not be opened.</div>
          <div style={S.error}>{state.detail}</div>
          <a style={S.primary} href={DESKTOP_DOWNLOAD_URL}>Download Plexii for desktop</a>
        </div>
      </div>
    )
  }
  if (state.kind === 'opening') {
    return <div style={S.shell}><div style={S.card}><div style={S.brand}>Plexii</div><div style={S.sub}>Opening {state.offer.title || 'the desk'}…</div></div></div>
  }
  // Ready: the renderer owns the document underneath. Only the expiry bar is
  // still ours, and it is rendered into its own node so #boot can be empty and
  // drop out of the layout -- a full-height #boot once pushed the app a whole
  // viewport down the page.
  return <ExpiryBar offer={state.offer} bundle={bundleRef.current} onExpired={expire} />
}

const S: Record<string, React.CSSProperties> = {
  shell: { position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
    background: '#0f1115', color: '#e7e9ee', fontFamily: 'Inter, system-ui, sans-serif', zIndex: 40 },
  card: { display: 'flex', flexDirection: 'column', gap: 12, width: 380, padding: 28,
    background: '#171a21', border: '1px solid #262b36', borderRadius: 14 },
  brand: { fontSize: 26, fontWeight: 600, letterSpacing: -0.4 },
  sub: { fontSize: 14, opacity: 0.75, lineHeight: 1.5 },
  fine: { fontSize: 12, opacity: 0.55, lineHeight: 1.45 },
  primary: { padding: '11px 12px', borderRadius: 8, border: 'none', background: '#4f7cff',
    color: 'white', fontSize: 14, fontWeight: 600, cursor: 'pointer', textAlign: 'center',
    textDecoration: 'none', display: 'block' },
  error: { color: '#ff8a8a', fontSize: 13, lineHeight: 1.4 },
  offer: { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px', borderRadius: 10,
    background: '#12203a', border: '1px solid #24406e' },
  offerWho: { fontSize: 12, opacity: 0.75, letterSpacing: 0.2 },
  offerTitle: { fontSize: 18, fontWeight: 600 },
  offerWhat: { fontSize: 12, opacity: 0.7 },
  bar: { position: 'fixed', top: 0, left: 0, right: 0, height: 40, zIndex: 60,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '0 12px', borderBottom: '1px solid #262b36', color: '#e7e9ee',
    fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 },
  barText: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  barFine: { opacity: 0.6 },
  barActions: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 },
  barGhost: { padding: '5px 10px', borderRadius: 6, border: '1px solid #39404f',
    background: 'transparent', color: '#e7e9ee', fontSize: 12, cursor: 'pointer' },
  barPrimary: { padding: '5px 10px', borderRadius: 6, background: '#4f7cff', color: 'white',
    fontSize: 12, fontWeight: 600, textDecoration: 'none' }
}

ReactDOM.createRoot(document.getElementById('boot') as HTMLElement).render(
  <React.StrictMode><Boot /></React.StrictMode>
)
