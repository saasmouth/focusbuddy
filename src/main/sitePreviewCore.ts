// Deciding what each website on a shared desk shows, from one clean visit to it.
//
// The visit itself (a hidden, signed-out Electron window) is sitePreview.ts;
// this is everything around it that does not need Electron, so it can be tested
// with a fake loader: the cache that lets the share sheet's preview and the
// link that follows share one visit, the queue that keeps a desk of twenty
// sites from opening twenty windows at once, and the rules that turn what the
// visit saw into live / embed / picture / link. See shared/sitePresentation.ts
// for what those four mean to the person who opens the link.
import {
  equivalentEmbedFor,
  frameVerdict,
  officialEmbedFor,
  pictureRefusal,
  type SiteChoice,
  type SiteShow
} from '@shared/sitePresentation'

/**
 * How a site answered when framed the way the share page frames it: in an
 * iframe with the same sandbox and referrer policy, so it sees what a visitor's
 * browser sends (Sec-Fetch-Dest: iframe, a cross-site parent, the share
 * origin as referrer). Sites differ here from an ordinary visit -- some answer
 * a framed request with X-Frame-Options or a bot check they never show a page
 * on its own -- so this, not the ordinary visit's headers, decides 'live'.
 */
export interface FramedAnswer {
  /** The frame's last HTTP status, or null when it never navigated. */
  status: number | null
  /** The frame document's last response headers. */
  headers: Record<string, string | string[]>
  /** The browser itself reported refusing to display it (X-Frame-Options or frame-ancestors). */
  refused: boolean
}

/** What one visit to a page saw. */
export interface PageShot {
  /**
   * The answer the picture is of: the framed one when the site allowed being
   * framed (the picture then shows what visitors will see live), otherwise an
   * ordinary visit's. Null when no response arrived.
   */
  status: number | null
  /** That answer's headers (used to judge framing only when there is no framed answer). */
  headers: Record<string, string | string[]>
  finalUrl: string
  title: string
  /** A JPEG of the page, already resized and within MAX_SITE_PICTURE_BYTES; null when none was taken. */
  jpeg: Uint8Array | null
  width: number
  height: number
  /** Why the page did not load, when it did not. */
  error?: string
  /** How it answered when framed. Absent from a loader that does not test framing. */
  frame?: FramedAnswer
}

/** Did the framed answer let the share page show the site? */
export function framedVerdict(frame: FramedAnswer, embedderOrigin: string): 'allowed' | 'refused' {
  if (frame.refused) return 'refused'
  if (frame.status === null || frame.status < 200 || frame.status >= 400) return 'refused'
  return frameVerdict(frame.headers, embedderOrigin)
}

export interface PageLoader {
  /** Visit `url` at `viewport`; `embedderOrigin` is where links open, for the framed look. */
  shoot(url: string, viewport: { width: number; height: number }, embedderOrigin?: string): Promise<PageShot>
}

export interface SitePicture {
  bytes: Uint8Array
  width: number
  height: number
  capturedAt: number
}

/** What is known about one site, for one viewport, from one visit. */
export interface SiteCheck {
  url: string
  host: string
  /** The site's official embed, when it has one. */
  embed: { embedUrl: string; provider: string } | null
  /** A TradingView widget that does the page's job, when there is one (sitePresentation.equivalentEmbedFor). */
  equivalent?: { embedUrl: string; provider: string; label: string } | null
  /** May the share page frame it? 'unknown' when the visit got no answer. */
  framing: 'allowed' | 'refused' | 'unknown'
  picture: SitePicture | null
  /** Why there is no picture, in words for the sender. Null when there is one. */
  refusal: string | null
  checkedAt: number
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * The window a picture is taken at: the widget's own size, so the picture is
 * the page as it sits in the widget, held to sizes a page lays out sensibly at.
 */
export function viewportFor(width: unknown, height: unknown): { width: number; height: number } {
  const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
  return {
    width: Math.round(Math.min(1600, Math.max(480, n(width, 1280)))),
    height: Math.round(Math.min(1200, Math.max(360, n(height, 800))))
  }
}

/**
 * A page that answered 200 but is a bot wall. These pages say what they are in
 * their title; a picture of one is a picture of a refusal. The sender sees every
 * picture before the link goes out, so this only has to catch the common ones.
 */
const CHALLENGE_TITLE =
  /^(just a moment|attention required|access denied|verifying|verify (you are|that you are)|are you (a )?(human|robot)|security check|one more step|captcha)/i

/** Turn a visit into what is known about the site. */
export function checkFromShot(url: string, shot: PageShot, embedderOrigin: string, now: number): SiteCheck {
  const host = hostOf(shot.finalUrl || url)
  const embed = officialEmbedFor(url)
  const equivalent = embed ? null : equivalentEmbedFor(url)
  const answered = shot.status !== null && shot.status >= 200 && shot.status < 400
  const framing: SiteCheck['framing'] = shot.frame
    ? framedVerdict(shot.frame, embedderOrigin)
    : answered
      ? frameVerdict(shot.headers, embedderOrigin)
      : 'unknown'
  let refusal = pictureRefusal(shot.status, host)
  if (!refusal && CHALLENGE_TITLE.test(shot.title.trim())) {
    refusal = `${host} asked for a human check, so no picture could be taken.`
  }
  if (!refusal && !shot.jpeg) {
    refusal = shot.error ? `${host} could not be loaded (${shot.error}).` : `No picture of ${host} could be taken.`
  }
  return {
    url,
    host,
    embed,
    equivalent,
    framing,
    picture: !refusal && shot.jpeg ? { bytes: shot.jpeg, width: shot.width, height: shot.height, capturedAt: now } : null,
    refusal,
    checkedAt: now
  }
}

/**
 * The ways a site can be shown, best first. 'link' is always possible.
 * Its own official embed, then the site itself framed, then an equivalent
 * widget (another provider's data, so only when the site itself cannot show),
 * then its picture.
 */
export function availableShows(check: Pick<SiteCheck, 'embed' | 'framing' | 'picture'> & { equivalent?: SiteCheck['equivalent'] }): SiteShow[] {
  const out: SiteShow[] = []
  if (check.embed) out.push('embed')
  else if (check.framing === 'allowed') out.push('live')
  else if (check.equivalent) out.push('embed')
  if (check.picture) out.push('picture')
  out.push('link')
  return out
}

/**
 * What the sender's choice comes to for this site. A choice the site cannot
 * honour falls to the next best thing, never to a blank: 'live' on a site that
 * refuses framing is its picture, and a picture that could not be taken is a
 * link card.
 */
export function decideShow(
  choice: SiteChoice,
  check: Pick<SiteCheck, 'embed' | 'framing' | 'picture'> & { equivalent?: SiteCheck['equivalent'] }
): SiteShow {
  const can = availableShows(check)
  if (choice === 'link') return 'link'
  if (choice === 'picture') return can.includes('picture') ? 'picture' : 'link'
  // 'auto' and 'live' both mean "live if it can be".
  return can[0]
}

export interface SitePreviewer {
  /** What is known about `url` at `viewport`: from the cache, or from a visit now. */
  check(
    url: string,
    viewport: { width: number; height: number },
    embedderOrigin: string,
    opts?: { force?: boolean }
  ): Promise<SiteCheck>
  /** The cached check, without visiting. */
  peek(url: string, viewport: { width: number; height: number }, embedderOrigin: string): SiteCheck | null
  /** Visits in flight or waiting (for tests and diagnostics). */
  pending(): number
}

/** How long a visit stands for the same site at the same size. */
export const SITE_CHECK_TTL_MS = 20 * 60 * 1000

export function createSitePreviewer(
  loader: PageLoader,
  opts: { concurrency?: number; ttlMs?: number; now?: () => number; maxEntries?: number } = {}
): SitePreviewer {
  const concurrency = Math.max(1, opts.concurrency ?? 3)
  const ttl = opts.ttlMs ?? SITE_CHECK_TTL_MS
  const now = opts.now ?? Date.now
  const maxEntries = opts.maxEntries ?? 64
  const cache = new Map<string, SiteCheck>()
  const inflight = new Map<string, Promise<SiteCheck>>()
  const waiting: Array<() => void> = []
  let running = 0

  const keyOf = (url: string, vp: { width: number; height: number }, origin: string): string =>
    `${url}\n${vp.width}x${vp.height}\n${origin}`

  async function slot<T>(fn: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>((r) => waiting.push(r))
    running++
    try {
      return await fn()
    } finally {
      running--
      waiting.shift()?.()
    }
  }

  function remember(key: string, check: SiteCheck): void {
    cache.delete(key)
    cache.set(key, check)
    // Oldest first out: pictures are a few hundred KB each.
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string)
  }

  function peek(url: string, vp: { width: number; height: number }, origin: string): SiteCheck | null {
    const hit = cache.get(keyOf(url, vp, origin))
    if (!hit) return null
    if (now() - hit.checkedAt > ttl) return null
    return hit
  }

  function check(
    url: string,
    vp: { width: number; height: number },
    origin: string,
    o: { force?: boolean } = {}
  ): Promise<SiteCheck> {
    const key = keyOf(url, vp, origin)
    if (!o.force) {
      const hit = peek(url, vp, origin)
      if (hit) return Promise.resolve(hit)
      const flying = inflight.get(key)
      if (flying) return flying
    }
    const job = slot(async () => {
      let shot: PageShot
      try {
        shot = await loader.shoot(url, vp, origin)
      } catch (e) {
        shot = { status: null, headers: {}, finalUrl: url, title: '', jpeg: null, width: 0, height: 0, error: (e as Error).message }
      }
      return checkFromShot(url, shot, origin, now())
    }).then(
      (c) => {
        inflight.delete(key)
        remember(key, c)
        return c
      },
      (e) => {
        inflight.delete(key)
        throw e
      }
    )
    inflight.set(key, job)
    return job
  }

  return { check, peek, pending: () => running + waiting.length }
}
