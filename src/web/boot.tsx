// Entry point for Plexii in the browser.
//
// The cloud app is not a product. It is the delivery end of one feature: someone
// was sent a desk, and for as long as the link lives (48 hours by default, or
// for good) they can open it here without installing anything or creating an
// account. Everything else about this app — sign-in,
// sign-up, two-way sync, a workspace of your own — is gone, because the answer
// to "can I use Plexii in a browser" is no, and the honest place to say so is
// the front door.
//
// So there are exactly two things this file can show:
//
//   a live share token  → unpack the desk and hand the renderer over to it
//   anything else       → the download page
//
// and neither of them ever erases a desk that came from a different link. A
// browser can hold desks from several links (api/shareVersion.ts keeps a record
// per link); a bare visit, a mistyped link or another link that was turned off
// leaves them all alone, and a link that is gone takes only its own
// (api/shareDesk.ts).
//
// The order still matters underneath. window.api is installed before the
// renderer is imported, because the renderer's first modules read it at module
// scope; and the file server is up before any widget renders a picture.
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ACTIVE } from '@shared/productDomains'
import ReactDOM from 'react-dom/client'
import { installBrowserApi, installFileServer } from './api/bridge'
import {
  shareTokenFromUrl, previewShare, fetchShareBundle, countdown, msLeft, linkExpires, downloadBundle,
  linkIsGone, refreshCachedOffer, refusalLine, whenRefused, finishPendingWipe,
  type ShareOffer, type ShareRefusal
} from './api/share'
import {
  decideShareUpdate, linkRecord, linksSharingDesk, migrateLegacyRecords, othersPresent,
  requestNewVersion, takeNewVersionRequest, noteVersionDeclined, replaceConfirmation
} from './api/shareVersion'
import { dropLinkCopy, holdDesk, openLinkDesk, type ReplacePlan } from './api/shareDesk'
import { markShareRecipient, setShareDeskId } from '@renderer/lib/shareMode'
import { SHARE_EDIT_EVENT, hasEditedShare } from './api/shareEdits'

// plexii.app has no DNS, so this button went to a browser error page for every
// visitor who opened the web runtime without a live share link — the one
// audience the page exists to convert. Follow the configured site instead.
const DESKTOP_DOWNLOAD_URL = `${ACTIVE.site}/download`

/** The page for everyone who did not arrive with a live link. */
function DownloadPage({ reason }: { reason?: ShareRefusal }): React.JSX.Element {
  // A link that is only unreachable for now is worth another try; one that is
  // gone needs a new link from the sender.
  const transient = reason === 'offline' || reason === 'unavailable'
  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.sub} data-testid="share-refusal">{refusalLine(reason)}</div>
        {transient && (
          <button style={S.primary} onClick={() => window.location.reload()}>Try again</button>
        )}
        <a style={transient ? S.secondary : S.primary} href={DESKTOP_DOWNLOAD_URL}>Download Plexii for desktop</a>
        {reason && !transient && (
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
  const expires = linkExpires(offer)
  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.offer}>
          <div style={S.offerWho}>A desk has been shared with you</div>
          <div style={S.offerTitle}>{offer.title || 'A desk'}</div>
          <div style={S.offerWhat}>
            {expires && `${countdown(offer.expiresAt)} · `}{(offer.sizeBytes / 1e6).toFixed(1)} MB
          </div>
        </div>
        <div style={S.sub}>
          {expires ? (
            <>
              Explore it in full — zoom in, rearrange it, change anything you like. Nothing you
              do reaches the sender, and nothing is kept: this copy and everything in it is
              deleted when the link expires. Plexii is free, and keeps it for good.
            </>
          ) : (
            <>
              Explore it in full — zoom in, rearrange it, change anything you like. Nothing you
              do reaches the sender, and your copy lives only in this browser. Plexii is free,
              and keeps it for good.
            </>
          )}
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
/**
 * Said once, at the first change.
 *
 * The offer card already explained this, but nobody re-reads a card they
 * dismissed two minutes ago, and finding out afterwards is the version that
 * makes people feel tricked. It appears when they start working and stays until
 * they close it.
 */
function EditWarning({ expires, onClose }: { expires: boolean; onClose: () => void }): React.JSX.Element {
  return (
    <div style={S.warn} role="status">
      <span style={S.warnText}>
        {expires ? (
          <>
            <strong>Nothing here is being saved.</strong> This copy is deleted when the link expires —
            get Plexii free to keep this desk and everything you do to it.
          </>
        ) : (
          <>
            <strong>Your changes stay in this browser only.</strong> They are lost if you clear your
            browser data or the sender turns this link off — get Plexii free to keep this desk and
            everything you do to it.
          </>
        )}
      </span>
      <span style={S.barActions}>
        <a style={S.barPrimary} href={DESKTOP_DOWNLOAD_URL}>Get Plexii — free</a>
        <button style={S.barGhost} onClick={onClose} aria-label="Dismiss">Dismiss</button>
      </span>
    </div>
  )
}

/**
 * Said when the sender has replaced what the link shows since this copy was
 * made (see api/shareVersion.ts). Only shown when the copy cannot simply be
 * replaced -- a copy the visitor never changed is updated without asking.
 */
type UpdateNotice =
  // shared: another link opened in this browser shows this same desk, so it
  // changes there too if this one is replaced. existing: this link was opened
  // for the first time onto a copy of its desk that was already here.
  | { kind: 'ask' | 'ask-unsure'; version: number | null; shared: boolean; existing?: boolean }
  | { kind: 'blocked'; why: 'open-elsewhere' | 'unreadable' }
  | { kind: 'loaded' }
  // The server could not be asked, or could not serve the desk: this is the
  // visitor's copy as they left it.
  | { kind: 'unavailable'; offline: boolean }

function UpdateBanner({
  notice, token, onClose
}: { notice: UpdateNotice; token: string; onClose: () => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const askRef = useRef<HTMLButtonElement>(null)
  const [returnFocus, setReturnFocus] = useState(false)
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
    else if (returnFocus) askRef.current?.focus()
  }, [confirming, returnFocus])

  // Replacing happens on the next load of this tab, before the desk is shown
  // again: this page has the old desk on screen, and anything it saves on its
  // way out must land before the old rows are removed, not after the new ones
  // are in.
  const replace = (): void => {
    requestNewVersion()
    window.location.reload()
  }

  if (notice.kind === 'unavailable') {
    return (
      <div style={S.notice} role="status" data-testid="share-unavailable">
        <span style={S.warnText}>
          {notice.offline ? (
            <><strong>The shared desk could not be reached just now.</strong> You are looking at your own copy, as you left it. Check your connection, then reload to look for the sender’s latest version.</>
          ) : (
            <><strong>The shared desk is temporarily unavailable.</strong> You are looking at your own copy, as you left it — nothing has been deleted. Reload later to look for the sender’s latest version.</>
          )}
        </span>
        <span style={S.barActions}>
          <button style={S.barGhost} onClick={onClose}>Dismiss</button>
        </span>
      </div>
    )
  }

  if (notice.kind === 'loaded') {
    return (
      <div style={S.notice} role="status" data-testid="share-update-loaded">
        <span style={S.warnText}>You now have the sender’s latest version of this desk.</span>
        <span style={S.barActions}>
          <button style={S.barGhost} onClick={onClose}>Dismiss</button>
        </span>
      </div>
    )
  }

  if (notice.kind === 'blocked') {
    return (
      <div style={S.notice} role="status" data-testid="share-update-blocked">
        <span style={S.warnText}>
          <strong>The sender’s latest version could not be loaded yet.</strong>{' '}
          {notice.why === 'open-elsewhere'
            ? 'This desk is open in another tab. Close the other tabs showing it, then reload this page.'
            : 'It could not be read, so your copy has been kept exactly as it was. Reload this page to try again.'}
        </span>
        <span style={S.barActions}>
          <button style={S.barPrimaryButton} onClick={replace}>Reload</button>
          <button style={S.barGhost} onClick={onClose}>Not now</button>
        </span>
      </div>
    )
  }

  const unsure = notice.kind === 'ask-unsure'
  return (
    <div style={S.notice} role="region" aria-label="Desk update" aria-live="polite" data-testid="share-update-banner">
      {confirming ? (
        <>
          <span style={S.warnText} data-testid="share-update-confirm-text">
            {replaceConfirmation(unsure, notice.shared)}
          </span>
          <span style={S.barActions}>
            <button ref={confirmRef} style={S.barPrimaryButton} onClick={replace}>Replace my copy</button>
            <button style={S.barGhost} onClick={() => { setReturnFocus(true); setConfirming(false) }}>Cancel</button>
          </span>
        </>
      ) : (
        <>
          <span style={S.warnText}>
            {notice.existing ? (
              <><strong>You already have a copy of this desk in this browser.</strong> You are looking at it, as you left it; the sender’s version may be newer.</>
            ) : unsure ? (
              <><strong>This desk may have changed since you first opened it.</strong> You are looking at your own copy.</>
            ) : (
              <><strong>The sender has updated this desk.</strong> You are looking at your own copy.</>
            )}
          </span>
          <span style={S.barActions}>
            <button ref={askRef} style={S.barPrimaryButton} onClick={() => setConfirming(true)}>
              {unsure ? 'Load the latest version' : 'Load the new version'}
            </button>
            <button
              style={S.barGhost}
              onClick={() => {
                noteVersionDeclined(token, notice.version)
                onClose()
              }}
            >
              Keep my copy
            </button>
          </span>
        </>
      )}
    </div>
  )
}

function ExpiryBar({
  offer, onSave, onExpired, children
}: {
  offer: ShareOffer
  /**
   * Hand the visitor the desk file. Null when it cannot be had (the server is
   * not serving the desk right now). Resolves false when fetching it failed.
   */
  onSave: (() => Promise<boolean>) | null
  onExpired: () => void
  /** Notices that sit under the bar, above the edit warning. */
  children?: React.ReactNode
}): React.JSX.Element {
  // A link that never expires has no clock: no countdown, no timer, and
  // nothing wiped when one runs out.
  const expires = linkExpires(offer)
  // Seeded from the flag, not only from the event: a change made before this
  // bar mounted would otherwise go unannounced.
  const [warned, setWarned] = useState(hasEditedShare)
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    const onEdit = (): void => setWarned(true)
    window.addEventListener(SHARE_EDIT_EVENT, onEdit)
    return () => window.removeEventListener(SHARE_EDIT_EVENT, onEdit)
  }, [])
  useEffect(() => {
    document.documentElement.classList.add('fb-share-bar')
    return () => document.documentElement.classList.remove('fb-share-bar')
  }, [])
  const [, tick] = useState(0)
  useEffect(() => {
    if (!expires) return
    const t = window.setInterval(() => {
      if (msLeft(offer.expiresAt) === 0) onExpired()
      else tick((n) => n + 1)
    }, 30_000)
    return () => window.clearInterval(t)
  }, [expires, offer.expiresAt, onExpired])

  const [saving, setSaving] = useState<'idle' | 'saving' | 'failed'>('idle')
  const save = async (): Promise<void> => {
    if (!onSave) return
    setSaving('saving')
    setSaving((await onSave().catch(() => false)) ? 'idle' : 'failed')
  }

  const left = msLeft(offer.expiresAt)
  const urgent = expires && left < 4 * 60 * 60 * 1000
  const showWarning = warned && !dismissed
  return (
    <>
    {(children || showWarning) && (
      <div style={S.notices}>
        {children}
        {showWarning && <EditWarning expires={expires} onClose={() => setDismissed(true)} />}
      </div>
    )}
    <div style={{ ...S.bar, background: urgent ? '#3a2216' : '#171a21' }}>
      <span style={S.barText}>
        {expires ? (
          <>
            <strong>{offer.title || 'Shared desk'}</strong> · {countdown(offer.expiresAt)}
            <span style={S.barFine}> — changes are not saved · deleted when the timer ends</span>
          </>
        ) : (
          <>
            <strong>{offer.title || 'Shared desk'}</strong>
            <span style={S.barFine}> — your copy, in this browser only</span>
          </>
        )}
      </span>
      <span style={S.barActions}>
        {onSave && (
          <button style={S.barGhost} onClick={() => void save()} disabled={saving === 'saving'}>
            {saving === 'saving' ? 'Fetching the desk file…' : saving === 'failed' ? 'Could not fetch it — try again' : 'Save desk file'}
          </button>
        )}
        <a style={S.barPrimary} href={DESKTOP_DOWNLOAD_URL}>Get Plexii — free</a>
      </span>
    </div>
    </>
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
  const [reopen, setReopen] = useState(false)
  const [update, setUpdate] = useState<UpdateNotice | null>(null)
  // The bundle as fetched, when this visit fetched one (a first visit, or a new
  // version). A returning visitor whose copy is current fetches nothing, and
  // "Save desk file" fetches it only when asked (saveDeskFile).
  const bundleRef = useRef<string | null>(null)
  // A new version fetched by the boot, before the database was opened, waiting
  // to be put in place of this link's desk by open().
  const planRef = useRef<ReplacePlan | null>(null)
  const token = shareTokenFromUrl()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Before anything reads the records or opens the database: what older
      // builds kept becomes per-link records, and a wipe an expiring link asked
      // for on its way out is finished while nothing holds the database.
      migrateLegacyRecords()
      await finishPendingWipe()
      if (cancelled) return
      if (!token) {
        // No link: this app has nothing else to offer, and says so. Nothing is
        // erased -- a bare visit, or a link mangled past reading, is not a
        // reason to take anybody's copy of anything.
        setState({ kind: 'download' })
        return
      }
      const preview = await previewShare(token)
      if (cancelled) return
      if (!preview.ok) {
        // A gone link takes its OWN copy (whenRefused): nothing, when this
        // browser never unpacked it. A link that is only unreachable (offline,
        // or the server saying "unavailable") takes nothing: if this browser
        // holds its copy, the copy opens as the visitor left it.
        const next = whenRefused(preview.reason, linkRecord(token), othersPresent(token))
        if (next.action === 'wipe' || next.action === 'forget') await dropLinkCopy(token, next.action)
        if (cancelled) return
        if (next.action !== 'open-copy') {
          setState({ kind: 'download', reason: next.reason })
          return
        }
        setUpdate({ kind: 'unavailable', offline: preview.reason === 'offline' })
        markShareRecipient(token)
        setShareDeskId(next.offer.rootId)
        setState({ kind: 'offer', offer: next.offer })
        setReopen(true)
        return
      }
      const offer = preview.offer
      // This browser holds this link's desk, so this is a return rather than an
      // arrival -- whichever links were opened in between.
      const returning = linkRecord(token) !== null
      if (returning) {
        refreshCachedOffer(token, offer)
        // Has the sender replaced the desk since this copy was made? Settled
        // here, from the metadata alone. The visitor's own request (from the
        // banner, before a reload) counts as permission to replace.
        const asked = takeNewVersionRequest()
        const decision = asked ? 'load' : decideShareUpdate(linkRecord(token)!, offer.updatedAt)
        if (decision === 'load') {
          // The new version is fetched BEFORE anything is removed. The
          // metadata route answering is no promise that the desk can be read
          // (a payload the server cannot open answers 503), and removing first
          // would trade the visitor's copy for nothing.
          const next = await fetchShareBundle(token)
          if (cancelled) return
          if (!next.ok) {
            if (linkIsGone(next.reason)) {
              await dropLinkCopy(token, othersPresent(token) ? 'forget' : 'wipe')
              if (!cancelled) setState({ kind: 'download', reason: next.reason })
              return
            }
            // Kept, and opened as it was.
            setUpdate({ kind: 'unavailable', offline: next.reason === 'offline' })
          } else {
            planRef.current = { text: next.text, asked }
          }
        } else if (decision !== 'current') {
          setUpdate({ kind: decision, version: offer.updatedAt ?? null, shared: linksSharingDesk(token).length > 0 })
        }
      }
      markShareRecipient(token)
      // The desk to open once the renderer is up; the app would otherwise
      // land on its home view and show an empty workspace.
      setShareDeskId(offer.rootId)
      setState({ kind: 'offer', offer })
      // A returning visitor goes straight back to the desk. Making somebody
      // re-accept a desk they are in the middle of reading is a door that
      // locks behind them -- and that holds when the desk behind the link was
      // just replaced with a newer one, too.
      if (returning) setReopen(true)
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

        const plan = planRef.current
        planRef.current = null
        const outcome = await openLinkDesk(token, offer, plan)
        if (outcome.kind === 'refused') {
          // It was alive a moment ago at the preview. Gone since then (revoked,
          // or the clock ran out between the two calls): its own copy has
          // gone (shareDesk.dropLinkCopy), and the visitor is told why. Only
          // unreachable: nothing is removed, and they are told to try again --
          // not that the link expired.
          setState({ kind: 'download', reason: outcome.reason })
          return
        }
        if (outcome.kind === 'failed') throw new Error(outcome.detail)
        bundleRef.current = outcome.bundleText
        if (outcome.notice) setUpdate(outcome.notice)
        // This tab shows the desk from here on: no other tab replaces or
        // removes it underneath (shareDesk.withDesksToThisTab).
        holdDesk(offer.rootId)

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

  // A reload of a desk already unpacked goes straight back to it.
  useEffect(() => {
    if (reopen && state.kind === 'offer' && !busy) open()
  }, [reopen, state.kind, busy, open])

  // The link's own clock ran out while the desk was open. Its desk goes now --
  // only its own, with the database open in this tab -- and the page asks the
  // server again, which says so in words ("That share has expired...").
  const expire = useCallback(() => {
    const showing = state.kind === 'ready' ? state.offer.rootId : undefined
    void (async () => {
      if (token) {
        await dropLinkCopy(token, othersPresent(token) ? 'forget' : 'wipe', { databaseOpenHere: true, showing })
      }
      window.location.replace(window.location.href)
    })()
  }, [token, state])

  // "Save desk file": the bundle this visit already has, or -- for a returning
  // visitor, who was not made to download it again just to reload -- fetched
  // now that it is actually wanted.
  const saveDeskFile = useCallback(async (): Promise<boolean> => {
    if (!token || state.kind !== 'ready') return false
    let text = bundleRef.current
    if (text === null) {
      const got = await fetchShareBundle(token)
      if (!got.ok) return false
      text = got.text
      bundleRef.current = text
    }
    downloadBundle(text, state.offer.title)
    return true
  }, [token, state])

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
  // Ready: the renderer owns the document underneath and only the bar is still
  // ours. #boot stays mounted to hold it, which is why that layer must not
  // capture pointer events -- see index.html. The class insets the app so the
  // desk begins below the bar instead of behind it.
  return (
    <ExpiryBar
      offer={state.offer}
      onSave={update?.kind === 'unavailable' && bundleRef.current === null ? null : saveDeskFile}
      onExpired={expire}
    >
      {update && token && <UpdateBanner notice={update} token={token} onClose={() => setUpdate(null)} />}
    </ExpiryBar>
  )
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
  // The second action on a card: the same shape as primary, without the fill.
  secondary: { padding: '10px 12px', borderRadius: 8, border: '1px solid #39404f', background: 'transparent',
    color: '#e7e9ee', fontSize: 14, fontWeight: 600, cursor: 'pointer', textAlign: 'center',
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
  // Everything that sits under the bar, stacked, so two notices never overlap.
  notices: { position: 'fixed', top: 40, left: 0, right: 0, zIndex: 61,
    display: 'flex', flexDirection: 'column' },
  warn: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    flexWrap: 'wrap', padding: '10px 12px', background: '#3a2216', borderBottom: '1px solid #5a3a20',
    color: '#ffe9d6', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 },
  notice: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    flexWrap: 'wrap', padding: '10px 12px', background: '#12203a', borderBottom: '1px solid #24406e',
    color: '#e7e9ee', fontFamily: 'Inter, system-ui, sans-serif', fontSize: 13 },
  warnText: { lineHeight: 1.45 },
  barPrimary: { padding: '5px 10px', borderRadius: 6, background: '#4f7cff', color: 'white',
    fontSize: 12, fontWeight: 600, textDecoration: 'none' },
  barPrimaryButton: { padding: '5px 10px', borderRadius: 6, background: '#4f7cff', color: 'white',
    fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer' }
}

ReactDOM.createRoot(document.getElementById('boot') as HTMLElement).render(
  <React.StrictMode><Boot /></React.StrictMode>
)
