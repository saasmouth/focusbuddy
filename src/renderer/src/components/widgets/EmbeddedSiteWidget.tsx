import { useMemo, useState } from 'react'
import Icon from '../Icon'
import type { Widget } from '@shared/types'
import { toHttpUrl } from '@shared/safeUrl'
import {
  embedFor,
  siteEntryFor,
  EMBED_REFERRER_POLICY,
  EMBED_SANDBOX,
  EMBED_SANDBOX_SAME_ORIGIN,
  type SitePicture
} from '@shared/sitePresentation'
import { fileSrc, webBase } from '../../lib/fileUrl'
import { sharePresentation } from '../../lib/shareMode'

/**
 * What the framed site may do.
 *
 * This widget only ever runs in the browser build, and there the page around
 * it is a public share link (plexiidesk.com/share/s/<token>) whose desk -- and
 * so whose embedded address -- was chosen by whoever minted the link. The
 * framed site is therefore a stranger's choice sitting inside our page.
 *
 *   allow-scripts, allow-same-origin   ordinary sites need both: their own
 *                                      scripts, and their own cookies and
 *                                      storage. Together they are only unsafe
 *                                      when the frame shares OUR origin -- see
 *                                      EMBED_SANDBOX_SAME_ORIGIN and the app-
 *                                      scope refusal in the component.
 *   allow-forms                        search boxes, sign-ins, sign-ups.
 *   allow-popups,                      "open in new tab", OAuth windows -- and
 *   allow-popups-to-escape-sandbox     the tab they open is a normal tab, not
 *                                      one crippled by this sandbox.
 *
 * Deliberately NOT granted:
 *   allow-top-navigation(-by-user-activation)  the framed site cannot replace
 *                                      the share page with a look-alike.
 *   allow-modals                       no alert()/confirm() sheets drawn over
 *                                      the desk by somebody else's page.
 *   allow-downloads                    no drive-by download pushed at a
 *                                      prospect who only opened a link.
 *
 * The desktop is unaffected: there these widgets are Electron <webview>s
 * (WebViewWidget), not this component -- see renderWidget.tsx.
 */
export { EMBED_SANDBOX } from '@shared/sitePresentation'

/**
 * The same, minus allow-same-origin, for a page on THIS site's origin.
 *
 * The share app is mounted under a path of the marketing site, so a desk can
 * legitimately embed one of the company's own pages (plexiidesk.com/pricing).
 * Framed with allow-scripts AND allow-same-origin, a same-origin page is not
 * sandboxed at all -- it could reach into the desk around it, and into this
 * origin's storage. Without allow-same-origin it still renders and runs, as an
 * opaque origin that can touch neither.
 */
export { EMBED_SANDBOX_SAME_ORIGIN } from '@shared/sitePresentation'

/**
 * Origin only, never the path.
 *
 * The page's own URL carries the share token, and the previous
 * 'no-referrer-when-downgrade' sent all of it -- /share/s/<token> -- to every
 * embedded site in the Referer header and document.referrer. 'no-referrer'
 * would be tighter but breaks real embeds: YouTube's player refuses to load
 * without a referrer (error 153, "embedder.identity.missing.referrer"), and
 * its own guidance is referrerpolicy="strict-origin". That sends
 * "https://plexiidesk.com/" and nothing more, and nothing at all to an http:
 * address.
 */
export { EMBED_REFERRER_POLICY } from '@shared/sitePresentation'

/** The page this widget is drawn on, or null outside a browser. */
function hostOrigin(): string | null {
  try {
    return typeof window !== 'undefined' && window.location ? window.location.origin : null
  } catch {
    return null
  }
}

/**
 * What an official embed may use beyond the sandbox: players need encrypted
 * media and fullscreen, and a chart widget's "copy link" the clipboard.
 */
export const EMBED_ALLOW = 'encrypted-media; picture-in-picture; fullscreen; clipboard-write'

/** "3 Nov, 12:34" -- when a picture was taken, in the visitor's own clock. */
function takenAt(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

type Shown =
  | { kind: 'frame' }
  | { kind: 'embed'; embedUrl: string; provider: string; label: string; equivalent: boolean }
  | { kind: 'picture'; picture: SitePicture }
  | { kind: 'link' }

// A browser widget, in a browser.
//
// On the desktop these are Electron <webview> elements: a real embedded browser
// with its own cookie jar, navigation events and a 649-line widget wrapping it.
// A tab has no equivalent. The nearest thing is an <iframe>, and it is genuinely
// not the same: a great many sites send X-Frame-Options or a frame-ancestors
// policy that forbids being embedded, and there is no way to ask in advance --
// the refusal arrives as a blank frame, cross-origin, with nothing readable
// from here.
//
// So the sender's desktop asks instead, when the link is made, and the link
// says per site what to show (shared/sitePresentation.ts):
//
//   live     the site allows framing: the frame below, as before
//   embed    the site's official embeddable version (a YouTube player, a
//            TradingView chart), live
//   picture  a picture of the page taken in a clean signed-out window, marked
//            as a picture with the time it was taken; it opens the real site
//   link     a card that opens the site
//
// A desk with no presentation (a link made before links carried one, or the
// cloud app) still gets an official embed where there is one, and otherwise
// the frame. The address and a way out stay ABOVE whatever is shown, so even a
// refused frame says what it was meant to be and opens it in one click.
export default function EmbeddedSiteWidget({ widget }: { widget: Widget }): JSX.Element {
  const [blocked, setBlocked] = useState(false)
  const [pictureFailed, setPictureFailed] = useState(false)
  const raw = (widget.content || '').trim()

  // Only http(s) is embeddable or openable; anything else here is a desktop
  // scheme that means nothing in a tab -- or, on a share page, an attempt to run
  // something (javascript:, data:, blob:) in the page's own origin.
  const url = useMemo(() => toHttpUrl(raw), [raw])

  // An address inside the app itself (this origin, under the path the app is
  // served from) is neither framed nor linked. That path is where the desk's
  // own files are served (<base>fb-file/<id>), with bytes and a type chosen by
  // whoever made the link -- as a frame or a tab, an .html "file" would be a
  // page of this site. Other pages on this origin (the marketing site the app
  // is mounted in) are framed, but without allow-same-origin.
  const sameOrigin = url !== null && url.origin === hostOrigin()
  const selfOrigin = sameOrigin && url !== null && url.pathname.startsWith(webBase())

  const shown: Shown = useMemo(() => {
    if (!url) return { kind: 'link' }
    // The embed is worked out here from the address, never taken from the
    // link: what a stranger's bundle can name is the address, not the frame.
    // The site's own embed, or a TradingView widget doing the same job
    // (sitePresentation.embedFor), labelled as what it is.
    const embed = embedFor(url.href)
    const entry = siteEntryFor(sharePresentation(), { id: widget.id, content: url.href })
    if (!entry) return embed ? { kind: 'embed', ...embed } : { kind: 'frame' }
    if (entry.show === 'live') return { kind: 'frame' }
    if (entry.show === 'embed') return embed ? { kind: 'embed', ...embed } : { kind: 'link' }
    if (entry.show === 'picture' && entry.picture) return { kind: 'picture', picture: entry.picture }
    return { kind: 'link' }
  }, [url, widget.id])

  if (!url || selfOrigin) {
    return (
      <div className="h-full w-full flex items-center justify-center p-3 text-center" data-testid="embedded-site-refused">
        <p className="text-[11px] text-[var(--ink-50)] leading-snug">
          {selfOrigin
            ? 'This work widget points back into this app, which cannot be shown inside itself.'
            : raw
              ? 'This work widget points at an address the browser cannot open.'
              : 'No address set.'}
        </p>
      </div>
    )
  }

  const host = url.hostname.replace(/^www\./, '')
  const effective: Shown = shown.kind === 'picture' && pictureFailed ? { kind: 'link' } : shown
  const label =
    effective.kind === 'embed'
      ? `Live · ${effective.label}`
      : effective.kind === 'picture'
        ? `Picture · ${takenAt(effective.picture.capturedAt)}`
        : null

  return (
    <div className="h-full w-full flex flex-col" data-testid="embedded-site" data-site-shows={effective.kind}>
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--edge-soft)] shrink-0">
        <Icon name="public" size={12} />
        <span className="truncate text-[11px] text-[var(--ink-70)] min-w-0" title={url.href}>
          {url.hostname}
        </span>
        {label && (
          <span
            className="shrink-0 rounded-full px-1.5 py-px text-[10px] text-[var(--ink-50)] border border-[var(--edge-soft)]"
            data-testid="embedded-site-label"
          >
            {label}
          </span>
        )}
        <a
          href={url.href}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto shrink-0 text-[11px] text-[rgb(var(--accent))] hover:underline"
          data-testid="embedded-site-open"
        >
          Open ↗
        </a>
      </div>
      <div className="flex-1 min-h-0 relative">
        {effective.kind === 'frame' && (
          <>
            <iframe
              src={url.href}
              title={url.hostname}
              className="absolute inset-0 h-full w-full border-0"
              sandbox={sameOrigin ? EMBED_SANDBOX_SAME_ORIGIN : EMBED_SANDBOX}
              referrerPolicy={EMBED_REFERRER_POLICY}
              data-testid="embedded-site-frame"
              // onLoad fires for a refused frame too (it loads an error document we
              // cannot read), so this is not a reliable "it worked" signal -- only
              // onError is meaningful, and most refusals do not raise it either.
              // Hence the header above, which does not depend on knowing.
              onError={() => setBlocked(true)}
            />
            {blocked && (
              <div className="absolute inset-0 flex items-center justify-center p-3 text-center bg-[var(--surface-sunken)]">
                <p className="text-[11px] text-[var(--ink-50)] leading-snug">
                  {url.hostname} will not display inside another page. Open it in a tab, or use the
                  desktop app, where it runs as a real embedded browser.
                </p>
              </div>
            )}
          </>
        )}
        {effective.kind === 'embed' && (
          <iframe
            src={effective.embedUrl}
            title={effective.equivalent ? `${effective.label}, standing in for ${url.hostname}` : `${effective.provider}: ${url.hostname}`}
            className="absolute inset-0 h-full w-full border-0"
            sandbox={EMBED_SANDBOX}
            referrerPolicy={EMBED_REFERRER_POLICY}
            allow={EMBED_ALLOW}
            allowFullScreen
            data-testid="embedded-site-embed"
          />
        )}
        {effective.kind === 'picture' && (
          <a
            href={url.href}
            target="_blank"
            rel="noreferrer noopener"
            className="group absolute inset-0 block overflow-hidden bg-[var(--surface-sunken)]"
            title={`Open ${host} in a new tab`}
            data-testid="embedded-site-picture"
          >
            <img
              src={`${fileSrc(effective.picture.id)}?v=${effective.picture.capturedAt}`}
              alt={`A picture of ${host}, taken ${takenAt(effective.picture.capturedAt)}`}
              className="h-full w-full object-cover object-top"
              draggable={false}
              onError={() => setPictureFailed(true)}
            />
            <span className="pointer-events-none absolute bottom-2 left-2 rounded-full px-2.5 py-1 text-[11px] font-medium bg-[color-mix(in_oklab,var(--surface-raised)_92%,transparent)] text-[var(--ink-90)] shadow-[var(--shadow-soft)] border border-[var(--edge-soft)] opacity-90 group-hover:opacity-100">
              A picture of this page · open the live site ↗
            </span>
          </a>
        )}
        {effective.kind === 'link' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center" data-testid="embedded-site-link">
            <Icon name="public" size={28} className="text-[var(--ink-30)]" />
            <p className="fb-t-caption font-semibold text-[var(--ink-90)] break-words max-w-full">
              {widget.title && widget.title !== url.href ? widget.title : host}
            </p>
            <a
              href={url.href}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[12px] px-3 py-1.5 rounded bg-accent text-white hover:brightness-110"
              data-testid="embedded-site-link-open"
            >
              Open {host} ↗
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
