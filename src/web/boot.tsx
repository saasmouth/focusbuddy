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
// A share token comes in two shapes. /s/<token> is a 'use' link: the sender
// packed the desk for this page. /c/<token> is a read link the sender made
// copyable (view.plexiidesk.com's "Open this desk in your browser"): its
// snapshot is made into the same kind of desk here (api/readShare.ts), and
// from then on the two are opened, kept and removed by the same code.
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
  linkIsGone, readInstead, refreshCachedOffer, refusalLine, whenRefused, finishPendingWipe,
  type ShareOffer, type ShareRefusal
} from './api/share'
import {
  readTokenFromUrl, previewReadShare, fetchReadShareBundle, offerWithRecordedDesk, readLinkViewerUrl,
  resolveFirstVisit
} from './api/readShare'
import {
  decideShareUpdate, linkRecord, linksSharingDesk, migrateLegacyRecords, othersPresent,
  requestNewVersion, takeNewVersionRequest, noteVersionDeclined, replaceConfirmation,
  keepRecordsForThisPageOnly, recordsArePageOnly
} from './api/shareVersion'
import { dbCall } from './api/dbClient'
import { dropLinkCopy, holdDesk, openLinkDesk, type BundleFetch, type ReplacePlan } from './api/shareDesk'
import { markShareRecipient, setShareDeskId, setSharePresentation } from '@renderer/lib/shareMode'
import { SHARE_EDIT_EVENT, hasEditedShare, shareEditCount } from './api/shareEdits'
import { installShareGestures, msSinceLastAct, openShareGate, setVisitorMode } from './api/shareGate'
import { classicViewerUrl, fetchLiveShareBundle, liveBundleUpdatedAt, liveTokenFromUrl, previewLiveShare } from './api/liveShare'
import {
  installerFor, loadInstallers, sendCopy, serverKeepsHandoffs, startDownload, visitorPlatform,
  type HandoffOutcome, type Installers
} from './api/deskHandoff'
import { SHARE_GATE_EVENT, type ShareGateDetail } from '@renderer/lib/shareGate'

// plexii.app has no DNS, so this button went to a browser error page for every
// visitor who opened the web runtime without a live share link — the one
// audience the page exists to convert. Follow the configured site instead.
const DESKTOP_DOWNLOAD_URL = `${ACTIVE.site}/download`

/** The installer starts once per visit, not at every gate: a second copy is clutter. */
const DOWNLOAD_STARTED_KEY = 'fb.share.downloadStarted'

/** How often a live link looks for a newer desk, and how long the visitor must be idle for it to swap in. */
const LIVE_POLL_MS = 30_000
const LIVE_IDLE_MS = 15_000

/** How long "Open this desk in Plexii" waits to send a newer copy before opening Plexii anyway. */
const RESEND_WAIT_MS = 4000

/** The link in the address bar, and which kind it is. */
interface Link {
  token: string
  /** 'use': a desk the sender packed (/s/). 'copy': a copyable read link (/c/). */
  kind: 'use' | 'copy' | 'live'
}

function linkFromUrl(): Link | null {
  // A live web view (/l/dsk_…): the desk the sender keeps live (liveShare.ts).
  const live = liveTokenFromUrl()
  if (live) return { token: live, kind: 'live' }
  const use = shareTokenFromUrl()
  if (use) return { token: use, kind: 'use' }
  const copy = readTokenFromUrl()
  return copy ? { token: copy, kind: 'copy' } : null
}

const previewLink = (link: Link): ReturnType<typeof previewShare> =>
  link.kind === 'use' ? previewShare(link.token) : link.kind === 'live' ? previewLiveShare(link.token) : previewReadShare(link.token)

const fetchLinkBundle = (link: Link): ReturnType<BundleFetch> =>
  link.kind === 'use' ? fetchShareBundle(link.token) : link.kind === 'live' ? fetchLiveShareBundle(link.token) : fetchReadShareBundle(link.token)

/** Where a link this page will not open can still be seen. */
const elsewhereUrl = (link: Link | null): string | undefined =>
  link?.kind === 'copy' ? readLinkViewerUrl(link.token) : link?.kind === 'live' ? classicViewerUrl(link.token) : undefined

/** The page for everyone who did not arrive with a live link. */
function DownloadPage({ reason, readUrl }: { reason?: ShareRefusal; readUrl?: string }): React.JSX.Element {
  // A link that is only unreachable for now is worth another try; one that is
  // gone needs a new link from the sender. One the sender made read-only still
  // works, as a page to read: that is where it goes.
  const transient = reason === 'offline' || reason === 'unavailable'
  const read = readInstead(reason) && !!readUrl
  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.sub} data-testid="share-refusal">{refusalLine(reason)}</div>
        {transient && (
          <button style={S.primary} onClick={() => window.location.reload()}>Try again</button>
        )}
        {read && (
          <a style={S.primary} href={readUrl} data-testid="share-read-instead">Read it</a>
        )}
        <a style={transient || read ? S.secondary : S.primary} href={DESKTOP_DOWNLOAD_URL}>Download Plexii for desktop</a>
        {reason && !transient && !readInstead(reason) && (
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
  offer, busy, onOpen, live
}: { offer: ShareOffer; busy: boolean; onOpen: () => void; live: boolean }): React.JSX.Element {
  const expires = linkExpires(offer)
  // A read link's size is not known until its snapshot is fetched (0): left
  // out, rather than shown as "0.0 MB".
  const what = [
    expires ? countdown(offer.expiresAt) : null,
    offer.sizeBytes > 0 ? `${(offer.sizeBytes / 1e6).toFixed(1)} MB` : null
  ].filter(Boolean).join(' · ')
  return (
    <div style={S.shell}>
      <div style={S.card}>
        <div style={S.brand}>Plexii</div>
        <div style={S.offer}>
          <div style={S.offerWho}>{offer.mode === 'view' ? (live ? 'A live desk has been shared with you' : 'A desk has been shared with you to look at') : 'A desk has been shared with you'}</div>
          <div style={S.offerTitle}>{offer.title || 'A desk'}</div>
          {what && <div style={S.offerWhat}>{what}</div>}
        </div>
        <div style={S.sub}>
          {offer.mode === 'view' ? (
            live ? (
              <>
                Look around it in Plexii — zoom in, open anything, arrange it your way. It is live:
                it changes as the person who shared it works on it.
              </>
            ) : (
              <>
                Look around it in Plexii — zoom in, open anything, arrange it your way. Nothing you
                do reaches the person who shared it.
              </>
            )
          ) : expires ? (
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
function EditWarning({ expires, onClose, onTakeIt }: { expires: boolean; onClose: () => void; onTakeIt: () => void }): React.JSX.Element {
  return (
    <div style={S.warn} role="status">
      <span style={S.warnText}>
        {expires ? (
          <>
            <strong>Nothing here is being saved.</strong> This copy is deleted when the link expires —
            download this desk on Plexii to keep it and everything you add to it.
          </>
        ) : recordsArePageOnly() ? (
          <>
            <strong>This browser cannot keep a copy.</strong> Your changes last until you close or
            reload this page — download this desk on Plexii to keep it and everything you add to it.
          </>
        ) : (
          <>
            <strong>Your changes stay in this browser only.</strong> They are lost if you clear your
            browser data or the sender turns this link off — download this desk on Plexii to keep it
            and everything you add to it.
          </>
        )}
      </span>
      <span style={S.barActions}>
        <button style={S.barPrimaryButton} onClick={onTakeIt}>Download this desk</button>
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
  // A live link's sender changed the desk while the visitor was busy.
  | { kind: 'live' }
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

  if (notice.kind === 'live') {
    return (
      <div style={S.notice} role="status" data-testid="share-live-updated">
        <span style={S.warnText}>This desk has just changed.</span>
        <span style={S.barActions}>
          <button style={S.barPrimaryButton} onClick={replace}>Show the latest</button>
          <button style={S.barGhost} onClick={onClose}>Later</button>
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
  offer, onSave, onExpired, onTakeIt, live = false, children
}: {
  offer: ShareOffer
  /** A live web view: the desk follows the sender. */
  live?: boolean
  /** "Download this desk": the gate, asked for. */
  onTakeIt: () => void
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
    return () => {
      document.documentElement.classList.remove('fb-share-bar')
      document.documentElement.style.removeProperty('--fb-share-top')
    }
  }, [])
  // The app starts below the bar AND below any notice under it (index.html
  // --fb-share-top), so a notice never covers the app's own titlebar.
  const noticesRef = useRef<HTMLDivElement>(null)
  const hasNotices = !!children || (warned && !dismissed)
  useEffect(() => {
    const root = document.documentElement
    const el = noticesRef.current
    if (!el || !hasNotices) {
      root.style.setProperty('--fb-share-top', '40px')
      return
    }
    const apply = (): void => root.style.setProperty('--fb-share-top', `${40 + Math.ceil(el.getBoundingClientRect().height)}px`)
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [hasNotices, children])
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
      <div style={S.notices} ref={noticesRef}>
        {children}
        {showWarning && <EditWarning expires={expires} onClose={() => setDismissed(true)} onTakeIt={onTakeIt} />}
      </div>
    )}
    <div style={{ ...S.bar, background: urgent ? '#3a2216' : '#171a21' }}>
      <span style={S.barText}>
        {expires ? (
          <>
            <strong>{offer.title || 'Shared desk'}</strong> · {countdown(offer.expiresAt)}
            <span style={S.barFine}> — changes are not saved · deleted when the timer ends</span>
          </>
        ) : offer.mode === 'view' ? (
          <>
            <strong>{offer.title || 'Shared desk'}</strong>
            <span style={S.barFine}>{live ? ' — live: it changes as it is worked on' : ' — shared to look at'}</span>
          </>
        ) : (
          <>
            <strong>{offer.title || 'Shared desk'}</strong>
            <span style={S.barFine}>
              {recordsArePageOnly()
                ? ' — a copy for this visit: this browser cannot keep it, so it goes when you close or reload the page'
                : ' — your copy, in this browser only'}
            </span>
          </>
        )}
      </span>
      <span style={S.barActions}>
        {onSave && offer.mode !== 'view' && (
          <button style={S.barGhost} onClick={() => void save()} disabled={saving === 'saving'}>
            {saving === 'saving' ? 'Fetching the desk file…' : saving === 'failed' ? 'Could not fetch it — try again' : 'Save desk file'}
          </button>
        )}
        <button style={S.barPrimaryButton} onClick={onTakeIt} data-testid="share-take-desk">
          {offer.mode === 'view' ? 'Get Plexii' : 'Download this desk'}
        </button>
      </span>
    </div>
    </>
  )
}

/** Where carrying the desk into Plexii stands. */
type Carry =
  | { kind: 'off' } // the released app or the server cannot take it yet
  | { kind: 'idle' } // it can, and nothing has been sent yet
  | { kind: 'sending' }
  | { kind: 'ready'; link: string; sentAtEdits: number }
  | { kind: 'failed'; why: Exclude<HandoffOutcome, { ok: true }>['why'] }

/**
 * "Download this desk on Plexii" (owner, 2026-11-07).
 *
 * Shown when a visitor does anything past looking around, arranging the desk
 * and dragging things onto it. The installer has already started (once per
 * visit, see Boot); this says what to do with it, and -- when the released app
 * and the server can both do it -- carries the visitor's copy of the desk,
 * with everything they added, into Plexii once they have signed up.
 */
function GateModal({
  what, platform, installers, downloadUrl, downloadStarted, carry, onOpenInPlexii, onRetryCarry, onDownload, onClose, viewOnly = false
}: {
  what: string
  /** A link to look at: Plexii is offered, not this desk. */
  viewOnly?: boolean
  platform: ReturnType<typeof visitorPlatform>
  installers: Installers | null
  downloadUrl: string | null
  downloadStarted: boolean
  carry: Carry
  onOpenInPlexii: (e: React.MouseEvent<HTMLAnchorElement>) => void
  onRetryCarry: () => void
  onDownload: () => void
  onClose: () => void
}): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const computer = platform === 'mac' ? 'Mac' : platform === 'windows' ? 'Windows' : null
  // Asked for from the bar, there is nothing to explain; refused, it says what.
  const lead = what ? `${what} is part of the Plexii app. ` : ''
  const shown = platform === 'windows' ? installers?.winVersion : installers?.version
  const version = shown ? ` ${shown}` : ''
  return (
    <div style={S.scrim} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={S.gate} role="dialog" aria-modal="true" aria-labelledby="share-gate-title" data-testid="share-gate">
        {/* A link to look at is the sender's desk, not the visitor's to take:
            the gate offers Plexii itself (owner, 2026-11-07: every link opens
            the full app, "just the interactivity that changes"). */}
        <div style={S.gateTitle} id="share-gate-title">{viewOnly ? 'Get Plexii' : 'Download this desk on Plexii'}</div>
        <div style={S.sub} data-testid="share-gate-lead">
          {viewOnly ? `${lead}Plexii is free to start.` : <>{lead}Take this desk with you{carry.kind === 'off' ? '' : ' — everything you added comes too'}.</>}
        </div>

        {platform === 'phone' ? (
          <div style={S.gateStep}>
            <div style={S.gateStepText}>Plexii runs on Mac and Windows. Send yourself the download link and open it on your computer.</div>
            <a style={S.primary} href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener" data-testid="share-gate-phone">Send me the download link</a>
          </div>
        ) : downloadUrl && computer ? (
          <div style={S.gateStatus} data-testid="share-gate-download">
            {downloadStarted ? `Plexii${version} for ${computer} is downloading.` : `Plexii${version} for ${computer} is ready to download.`}{' '}
            <button style={S.linkButton} onClick={onDownload}>{downloadStarted ? 'Download again' : 'Download'}</button>
          </div>
        ) : (
          <div style={S.gateStep}>
            <div style={S.gateStepText}>Plexii runs on Mac and Windows.</div>
            <a style={S.primary} href={DESKTOP_DOWNLOAD_URL} target="_blank" rel="noopener" data-testid="share-gate-download-page">Download Plexii</a>
          </div>
        )}

        <ol style={S.steps}>
          <li style={S.stepItem}><strong>Install Plexii.</strong> Open the file you downloaded.</li>
          <li style={S.stepItem}><strong>Start your free trial.</strong> Plexii asks you to sign up when it first opens.</li>
          <li style={S.stepItem}>
            {carry.kind === 'off' ? (
              <><strong>Build your own desks.</strong> This one stays here, in this browser.</>
            ) : (
              <><strong>Open this desk in Plexii.</strong> It opens as soon as you are signed in, with everything you added.</>
            )}
          </li>
        </ol>

        {carry.kind === 'ready' && (
          <a style={S.primary} href={carry.link} onClick={onOpenInPlexii} data-testid="share-gate-open-in-plexii">Open this desk in Plexii</a>
        )}
        {(carry.kind === 'sending' || carry.kind === 'idle') && (
          <div style={S.secondary} aria-busy="true" data-testid="share-gate-sending">Getting your desk ready…</div>
        )}
        {carry.kind === 'failed' && (
          <div style={S.gateStatus} data-testid="share-gate-carry-failed">
            {carry.why === 'too-large'
              ? 'This desk is too big to send to Plexii from here. Remove something large you added, then try again.'
              : carry.why === 'gone'
                ? 'This shared link has ended, so the desk cannot be sent to Plexii.'
                : carry.why === 'busy'
                  ? 'Too many desks were sent from here just now. Try again in a little while.'
                  : 'Your desk could not be sent to Plexii just now.'}
            {carry.why !== 'gone' && (
              <> <button style={S.linkButton} onClick={onRetryCarry}>Try again</button></>
            )}
          </div>
        )}
        <button ref={closeRef} style={S.secondary} onClick={onClose} data-testid="share-gate-close">Keep looking around</button>
      </div>
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
  const [reopen, setReopen] = useState(false)
  const [update, setUpdate] = useState<UpdateNotice | null>(null)
  // The bundle as fetched, when this visit fetched one (a first visit, or a new
  // version). A returning visitor whose copy is current fetches nothing, and
  // "Save desk file" fetches it only when asked (saveDeskFile).
  const bundleRef = useRef<string | null>(null)
  // A new version fetched by the boot, before the database was opened, waiting
  // to be put in place of this link's desk by open().
  const planRef = useRef<ReplacePlan | null>(null)
  const [link] = useState<Link | null>(linkFromUrl)
  const token = link?.token ?? null

  // "Download this desk on Plexii": the gate, what was tried, the installer and
  // the visitor's copy on its way to the app (GateModal).
  const [gate, setGate] = useState<string | null>(null)
  const gateOpenRef = useRef(false)
  useEffect(() => {
    gateOpenRef.current = gate !== null
  }, [gate])
  const [platform] = useState(() => visitorPlatform())
  const [installers, setInstallers] = useState<Installers | null>(null)
  const [carry, setCarry] = useState<Carry>({ kind: 'off' })
  const carryOffered = useRef(false)
  const [downloadStarted, setDownloadStarted] = useState(() => {
    try {
      return sessionStorage.getItem(DOWNLOAD_STARTED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Before anything reads the records or opens the database: what older
      // builds kept becomes per-link records, and a wipe an expiring link asked
      // for on its way out is finished while nothing holds the database.
      migrateLegacyRecords()
      await finishPendingWipe()
      if (cancelled) return
      if (!link || !token) {
        // No link: this app has nothing else to offer, and says so. Nothing is
        // erased -- a bare visit, or a link mangled past reading, is not a
        // reason to take anybody's copy of anything.
        setState({ kind: 'download' })
        return
      }
      const preview = await previewLink(link)
      if (cancelled) return
      if (!preview.ok && readInstead(preview.reason)) {
        // The sender's choice, not the link's state: it is read-only, or not a
        // desk. Nothing is removed and nothing is opened -- not even a copy
        // this browser may hold from before -- and the page says where it can
        // still be read.
        setState({ kind: 'download', reason: preview.reason })
        return
      }
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
      // A read link's metadata does not name its desk; this browser's record of
      // the link does, once it has been unpacked here (readShare.ts).
      const offer = link.kind !== 'use' ? offerWithRecordedDesk(preview.offer, linkRecord(token)) : preview.offer
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
          const next = await fetchLinkBundle(link)
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
  }, [link, token])

  const open = useCallback(() => {
    if (state.kind !== 'offer' || !token || !link) return
    setBusy(true)
    let offer = state.offer
    void (async () => {
      try {
        let fetchBundle: BundleFetch = () => fetchLinkBundle(link)
        if ((link.kind === 'copy' || link.kind === 'live') && !offer.rootId) {
          // A first visit to a read link: the desk is named only inside its
          // snapshot, so the snapshot is fetched now -- once; openLinkDesk is
          // handed the same text -- and the offer completed from it.
          const first = await resolveFirstVisit(token, offer, link.kind === 'live' ? fetchLiveShareBundle : undefined)
          if (!first.ok) {
            // Nothing of this link's is here yet, so there is nothing to take
            // out: say why, as the preview would have.
            setState({ kind: 'download', reason: first.reason })
            return
          }
          offer = first.offer
          fetchBundle = first.fetchBundle
          setShareDeskId(offer.rootId)
        }

        installBrowserApi()
        // Who did what, and when, for the bridge to decide each call by
        // (api/shareGate.ts): looking, arranging and dropping are free.
        installShareGestures()
        // What this kind of link lets the visitor do (api/shareGate.ts).
        setVisitorMode(offer.mode ?? 'use')
        await installFileServer()

        // Where can this desk live? A browser that refuses durable storage
        // (phone in-app browsers, private windows) gets a memory-only database
        // (worker/database.ts). Then this browser's notes about links must not
        // be trusted or written either, and the page must say plainly that the
        // copy lasts only until it closes.
        const where = (await dbCall('shareCopy:storageMode', []).catch(() => null)) as { mode?: string } | null
        if (where?.mode === 'memory') keepRecordsForThisPageOnly()

        const plan = planRef.current
        planRef.current = null
        const outcome = await openLinkDesk(token, offer, plan, fetchBundle)
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
        // A desk from a team workspace carries its team's id on every row, and
        // the app shows only the visitor's own workspace: without this it was
        // unpacked and then filtered out of sight (worker/shareCopy.ts).
        await dbCall('shareCopy:adoptVisitorScope', []).catch(() => null)
        bundleRef.current = outcome.bundleText
        if (outcome.notice) setUpdate(outcome.notice)
        // This tab shows the desk from here on: no other tab replaces or
        // removes it underneath (shareDesk.withDesksToThisTab).
        holdDesk(offer.rootId)
        // How the sender presented this desk (the view, and what each website
        // shows), as recorded with the version now in this browser.
        setSharePresentation(linkRecord(token)?.presentation ?? null)

        setState({ kind: 'opening', offer })
        await import('@renderer/main')
        setState({ kind: 'ready', offer })
      } catch (err) {
        setState({ kind: 'failed', detail: (err as Error).message })
      } finally {
        setBusy(false)
      }
    })()
  }, [state, token, link])

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
    if (!token || !link || state.kind !== 'ready') return false
    let text = bundleRef.current
    if (text === null) {
      const got = await fetchLinkBundle(link)
      if (!got.ok) return false
      text = got.text
      bundleRef.current = text
    }
    downloadBundle(text, state.offer.title)
    return true
  }, [token, link, state])

  // ── "Download this desk on Plexii" ──────────────────────────────────────
  //
  // Once the desk is open: which installer this computer gets, and whether the
  // copy can be carried into the app (the released app takes handoffs AND the
  // server keeps them). Asked up front so the gate can start the download in
  // the same moment it appears.
  const ready = state.kind === 'ready'
  const viewOnly = state.kind === 'ready' ? state.offer.mode === 'view' : null
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    void (async () => {
      const inst = await loadInstallers()
      if (cancelled) return
      setInstallers(inst)
      // A link to look at is not the visitor's to take: nothing is carried.
      const offered = viewOnly === false && !!inst?.deskHandoff && (await serverKeepsHandoffs())
      if (cancelled) return
      carryOffered.current = offered
      // Nothing is sent until the gate opens.
      setCarry((c) => (offered ? (c.kind === 'off' ? { kind: 'idle' } : c) : { kind: 'off' }))
    })()
    return () => {
      cancelled = true
    }
  }, [ready, viewOnly])

  // A live link follows the sender: a newer desk is looked for every 30 s, and
  // put in place once the visitor has left the page alone for a little while
  // (a reload: an untouched copy is replaced without asking, shareVersion.ts).
  // While they are busy, a notice offers it instead of pulling the desk out
  // from under them.
  const liveSince = state.kind === 'ready' && link?.kind === 'live' ? (state.offer.updatedAt ?? 0) : null
  useEffect(() => {
    if (liveSince === null || !token) return
    let stopped = false
    const look = async (): Promise<void> => {
      const at = await liveBundleUpdatedAt(token)
      if (stopped || at === null || at <= liveSince) return
      if (msSinceLastAct() >= LIVE_IDLE_MS && gateOpenRef.current === false) {
        requestNewVersion()
        window.location.reload()
      } else {
        setUpdate({ kind: 'live' })
      }
    }
    const t = window.setInterval(() => void look(), LIVE_POLL_MS)
    // And the moment the visitor comes back to the tab: the first thing they
    // see after a while away should be the desk as it is now.
    const onBack = (): void => {
      if (document.visibilityState !== 'hidden') void look()
    }
    window.addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)
    return () => {
      stopped = true
      window.clearInterval(t)
      window.removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
    }
  }, [liveSince, token])

  const downloadUrl = installerFor(platform, installers)

  const download = useCallback(() => {
    if (!downloadUrl) return
    startDownload(downloadUrl)
    setDownloadStarted(true)
    try {
      sessionStorage.setItem(DOWNLOAD_STARTED_KEY, '1')
    } catch {
      /* this visit remembers it in state */
    }
  }, [downloadUrl])

  const send = useCallback(async (): Promise<Carry> => {
    // A live link is the sender's desk to look at: never carried (carryOffered stays false too).
    if (state.kind !== 'ready' || !token || !link || link.kind === 'live' || !carryOffered.current) return { kind: 'off' }
    setCarry({ kind: 'sending' })
    const edits = shareEditCount()
    const out = await sendCopy({ token, kind: link.kind, rootId: state.offer.rootId, title: state.offer.title })
    const next: Carry = out.ok ? { kind: 'ready', link: out.link, sentAtEdits: edits } : { kind: 'failed', why: out.why }
    setCarry(next)
    return next
  }, [state, token, link])

  const openGate = useCallback((what: string) => {
    setGate(what)
    // The installer starts with the first gate of the visit.
    if (!downloadStarted && downloadUrl && (platform === 'mac' || platform === 'windows')) download()
    // The copy goes as it is now; a later change is sent again on the way to Plexii.
    if (carryOffered.current && carry.kind !== 'ready' && carry.kind !== 'sending') void send()
  }, [downloadStarted, downloadUrl, platform, download, carry.kind, send])

  useEffect(() => {
    if (!ready) return
    const onGate = (e: Event): void => openGate((e as CustomEvent<ShareGateDetail>).detail?.what ?? '')
    window.addEventListener(SHARE_GATE_EVENT, onGate)
    return () => window.removeEventListener(SHARE_GATE_EVENT, onGate)
  }, [ready, openGate])

  // Typing into the desk -- a note, a document, a cell -- is editing it, and is
  // the gate BEFORE a single character lands. Left to the bridge alone, the
  // words would sit on screen unsaved until the editor tried to save them. The
  // assistant's box and the app's own fields (search, the command centre) are
  // not the desk and type as normal; sending to the assistant is the gate.
  useEffect(() => {
    if (!ready) return
    const onBeforeInput = (e: Event): void => {
      const t = e.target
      if (!(t instanceof Element)) return
      if (t.closest('[data-testid="assistant-overlay"]')) return
      if (!t.closest('[data-widget-id]') && !t.closest('.ProseMirror')) return
      if (e.cancelable) e.preventDefault()
      openShareGate('Editing this desk')
    }
    document.addEventListener('beforeinput', onBeforeInput, true)
    return () => document.removeEventListener('beforeinput', onBeforeInput, true)
  }, [ready])

  // "Open this desk in Plexii": a real link, so the browser hands it to the app
  // the way it hands any app link. If the visitor added something since the
  // copy was sent, the newer copy goes first (briefly; Plexii opens anyway).
  const openInPlexii = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    if (carry.kind !== 'ready' || shareEditCount() === carry.sentAtEdits) return
    e.preventDefault()
    const fallback = carry.link
    void (async () => {
      const next = await Promise.race([
        send(),
        new Promise<Carry>((r) => setTimeout(() => r({ kind: 'ready', link: fallback, sentAtEdits: -1 }), RESEND_WAIT_MS))
      ])
      if (next.kind === 'ready') window.location.href = next.link
    })()
  }, [carry, send])

  if (state.kind === 'checking') {
    return <div style={S.shell}><div style={S.sub}>Checking that link…</div></div>
  }
  if (state.kind === 'download') {
    return (
      <DownloadPage
        reason={state.reason}
        readUrl={elsewhereUrl(link)}
      />
    )
  }
  if (state.kind === 'offer') return <ShareOfferCard offer={state.offer} busy={busy} onOpen={open} live={link?.kind === 'live'} />
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
    <>
      <ExpiryBar
        offer={state.offer}
        live={link?.kind === 'live'}
        onSave={update?.kind === 'unavailable' && bundleRef.current === null ? null : saveDeskFile}
        onExpired={expire}
        onTakeIt={() => openGate('')}
      >
        {update && token && <UpdateBanner notice={update} token={token} onClose={() => setUpdate(null)} />}
      </ExpiryBar>
      {gate !== null && (
        <GateModal
          what={gate}
          platform={platform}
          installers={installers}
          downloadUrl={downloadUrl}
          downloadStarted={downloadStarted}
          carry={carry}
          onOpenInPlexii={openInPlexii}
          onRetryCarry={() => void send()}
          onDownload={download}
          onClose={() => setGate(null)}
          viewOnly={state.offer.mode === 'view'}
        />
      )}
    </>
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
  // Above the app's own chrome (its titlebar is z 195 and sits right under the
  // bar, since visitors get the whole app) and below the gate (400).
  notices: { position: 'fixed', top: 40, left: 0, right: 0, zIndex: 300,
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
    fontSize: 12, fontWeight: 600, border: 'none', cursor: 'pointer' },
  // The gate: above the app and its own modals (which reach z-index 280), below nothing.
  scrim: { position: 'fixed', inset: 0, zIndex: 400, display: 'grid', placeItems: 'center', padding: 16,
    background: 'rgba(8, 10, 14, 0.62)', backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
    fontFamily: 'Inter, system-ui, sans-serif', color: '#e7e9ee' },
  gate: { display: 'flex', flexDirection: 'column', gap: 14, width: 420, maxWidth: '100%', padding: 28,
    background: '#171a21', border: '1px solid #262b36', borderRadius: 14,
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.45)' },
  gateTitle: { fontSize: 20, fontWeight: 600, letterSpacing: -0.3 },
  gateStatus: { fontSize: 13, lineHeight: 1.5, padding: '10px 12px', borderRadius: 10,
    background: '#12203a', border: '1px solid #24406e' },
  gateStep: { display: 'flex', flexDirection: 'column', gap: 10 },
  gateStepText: { fontSize: 13, lineHeight: 1.5, opacity: 0.85 },
  steps: { margin: 0, paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.5 },
  stepItem: { opacity: 0.9 },
  linkButton: { background: 'none', border: 'none', padding: 0, color: '#8fb0ff', fontSize: 13,
    textDecoration: 'underline', cursor: 'pointer' }
}

ReactDOM.createRoot(document.getElementById('boot') as HTMLElement).render(
  <React.StrictMode><Boot /></React.StrictMode>
)
