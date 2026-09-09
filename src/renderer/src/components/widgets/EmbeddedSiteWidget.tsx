import { useMemo, useState } from 'react'
import Icon from '../Icon'
import type { Widget } from '@shared/types'

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

  const url = useMemo(() => {
    if (!raw) return null
    try {
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
      // Only http(s) is embeddable or openable; anything else here is a desktop
      // scheme that means nothing in a tab.
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
    } catch {
      return null
    }
  }, [raw])

  if (!url) {
    return (
      <div className="h-full w-full flex items-center justify-center p-3 text-center">
        <p className="text-[11px] text-[var(--ink-50)] leading-snug">
          {raw ? 'This widget points at an address the browser cannot open.' : 'No address set.'}
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
          referrerPolicy="no-referrer-when-downgrade"
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
