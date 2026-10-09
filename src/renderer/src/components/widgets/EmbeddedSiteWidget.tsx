import { useMemo, useState } from 'react'
import Icon from '../Icon'
import type { Widget } from '@shared/types'
import { toHttpUrl } from '@shared/safeUrl'
import { webBase } from '../../lib/fileUrl'

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
export const EMBED_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'

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
export const EMBED_SANDBOX_SAME_ORIGIN = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'

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
export const EMBED_REFERRER_POLICY = 'strict-origin' as const

/** The page this widget is drawn on, or null outside a browser. */
function hostOrigin(): string | null {
  try {
    return typeof window !== 'undefined' && window.location ? window.location.origin : null
  } catch {
    return null
  }
}

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
// So this shows the address and a way out ABOVE the frame rather than inside
// it. A site that permits embedding renders underneath and the header costs a
// little height; a site that refuses leaves a blank area, but the widget still
// says what it points at and opens it in one click. The failure mode of the
// alternative -- an unadorned iframe -- is a blank rectangle with no way to
// tell what it was meant to be.
export default function EmbeddedSiteWidget({ widget }: { widget: Widget }): JSX.Element {
  const [blocked, setBlocked] = useState(false)
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

  if (!url || selfOrigin) {
    return (
      <div className="h-full w-full flex items-center justify-center p-3 text-center" data-testid="embedded-site-refused">
        <p className="text-[11px] text-[var(--ink-50)] leading-snug">
          {selfOrigin
            ? 'This widget points back into this app, which cannot be shown inside itself.'
            : raw
              ? 'This widget points at an address the browser cannot open.'
              : 'No address set.'}
        </p>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-[var(--edge-soft)] shrink-0">
        <Icon name="public" size={12} />
        <span className="truncate text-[11px] text-[var(--ink-70)] min-w-0" title={url.href}>
          {url.hostname}
        </span>
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
      </div>
    </div>
  )
}
