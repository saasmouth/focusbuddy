// The desk share tracker, the page's end (focusbuddy-signal src/shareTracker.ts).
//
// Two things are counted, first-party only, at the API (never Google; the site
// keeps Google off share pages, plexii-site shared/analytics.html secretFree):
//
//   view            the page opened a live link. Once per tab session per link:
//                   the visitor is a random id this tab keeps in sessionStorage,
//                   and nothing else identifies them (no cookie, no address).
//   download_click  the page started the Plexii installer, or a visitor pressed
//                   a link to the download page (a phone's "Send me the
//                   download link"). Every one counts, with the platform.
//
// Sent with navigator.sendBeacon: a string body (the browser labels it
// text/plain, so no preflight), fire and forget. Nothing here can throw, wait,
// or stand between the visitor and the download: the download starts first,
// and a beacon that fails is simply not counted.
//
// The sign-up link on the gate carries the link (?share=<token>), so a sign-up
// that starts from a shared desk is credited to it (signal /accounts/signup).
import { ACTIVE } from '@shared/productDomains'
import { signalConfig } from '@renderer/lib/signalConfig'
import type { VisitorPlatform } from './deskHandoff'

export type ShareEvent = 'view' | 'download_click'

const VISITOR_KEY = 'fb.share.visitor'
const VIEWED_KEY = (token: string): string => `fb.share.viewed.${token}`

// When sessionStorage cannot be used (some private windows), this page load is
// the visit: one id and one view for as long as it stays open.
let pageVisitor: string | null = null
const pageViewed = new Set<string>()

function session(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function randomId(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().replace(/-/g, '')
    const b = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  } catch {
    // No crypto at all: still random enough to tell tabs apart, never identifying.
    return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  }
}

/** This tab's visitor id: made once, kept in sessionStorage (gone when the tab closes). */
export function visitorId(store: Storage | null = session()): string {
  try {
    const kept = store?.getItem(VISITOR_KEY)
    if (kept && /^[A-Za-z0-9_-]{16,64}$/.test(kept)) return kept
    const made = randomId()
    store?.setItem(VISITOR_KEY, made)
    if (store) return made
  } catch {
    /* storage refused: this page load's id below */
  }
  pageVisitor ??= randomId()
  return pageVisitor
}

/** Where a link's events go. */
export function trackUrl(token: string): string {
  return `${signalConfig.httpUrl.replace(/\/+$/, '')}/share/${encodeURIComponent(token)}/track`
}

export interface Sender {
  beacon?: ((url: string, body: string) => boolean) | null
  fetch?: typeof fetch | null
}

function defaultSender(): Sender {
  return {
    beacon: typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? (u, b) => navigator.sendBeacon(u, b) : null,
    fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null
  }
}

/**
 * Send one event. Returns whether it was handed to the browser; never throws
 * and never waits. A beacon the browser will not queue falls back to a
 * keepalive fetch, as a simple no-cors request (no preflight, response unread).
 */
export function sendShareEvent(token: string, event: ShareEvent, platform: VisitorPlatform, sender: Sender = defaultSender()): boolean {
  try {
    const url = trackUrl(token)
    const body = JSON.stringify({ event, visitorId: visitorId(), platform })
    try {
      if (sender.beacon && sender.beacon(url, body)) return true
    } catch {
      /* a beacon that throws is a beacon not sent: try fetch */
    }
    if (!sender.fetch) return false
    void sender
      .fetch(url, { method: 'POST', body, mode: 'no-cors', credentials: 'omit', keepalive: true, headers: { 'content-type': 'text/plain' } })
      .catch(() => undefined)
    return true
  } catch {
    return false
  }
}

/** The page opened this live link: counted once per tab session. */
export function trackShareView(token: string, platform: VisitorPlatform, sender?: Sender, store: Storage | null = session()): boolean {
  try {
    if (pageViewed.has(token)) return false
    let counted = false
    try {
      counted = store?.getItem(VIEWED_KEY(token)) === '1'
    } catch {
      /* storage refused: this page load is the visit */
    }
    if (counted) return false
    pageViewed.add(token)
    try {
      store?.setItem(VIEWED_KEY(token), '1')
    } catch {
      /* this page load remembers it */
    }
    return sendShareEvent(token, 'view', platform, sender)
  } catch {
    return false
  }
}

/** A download started, or a link to the download page was pressed. Every one counts. */
export function trackDownloadClick(token: string, platform: VisitorPlatform, sender?: Sender): boolean {
  return sendShareEvent(token, 'download_click', platform, sender)
}

/** The site this page is served from (plexiidesk.com), so the sign-up stays on it; the configured site otherwise. */
function pageSite(): string {
  try {
    if (/^https?:$/.test(window.location.protocol)) return window.location.origin
  } catch {
    /* no location: the configured site */
  }
  return ACTIVE.site
}

/** The website's sign-up page, carrying the link it starts from. Sign-up is the free trial, never a checkout. */
export function shareSignupUrl(token: string, site: string = pageSite()): string {
  return `${site.replace(/\/+$/, '')}/account/signup?share=${encodeURIComponent(token)}`
}

/** Tests: forget this page load's memory. */
export function resetShareTrackingForTests(): void {
  pageVisitor = null
  pageViewed.clear()
}
