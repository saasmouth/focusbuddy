// When a public desk link stops working -- or that it never does -- and how
// much it can carry (at the end of this file).
//
// A "use" link (anyone with the link opens a desk they can work on) used to be a
// 48-hour thing and nothing else. It is now also the standing link a sender puts
// in front of many people over weeks and months, so it can be told never to
// expire. Signal stores that as a far-future sentinel in the same column as
// every other expiry, which keeps its "expires_at > now" checks and its sweeper
// unchanged, and maps the sentinel to null in every response.
//
// Both clients (the desktop's share sheet and the browser's share page) read
// expiry through this one function, so "null means never" is decided once, and
// a sentinel that leaked through a response unmapped still reads as never
// rather than as a countdown to the year 9999.

/** 9999-12-31T23:59:59.999Z. What Signal stores for a link that never expires. */
export const NEVER_EXPIRES_AT = 253402300799999

/**
 * Does this link never expire?
 *
 * null is the contract. Absent is treated the same way, because JSON cannot
 * carry the difference and a live share with no stated end has no countdown to
 * show. Anything at or beyond the sentinel is the sentinel, unmapped.
 */
export function expiresNever(expiresAt: number | null | undefined): boolean {
  if (expiresAt === null || expiresAt === undefined) return true
  return typeof expiresAt === 'number' && expiresAt >= NEVER_EXPIRES_AT
}

/** The expiry as clients hold it: a timestamp, or null for never. */
export function normaliseExpiresAt(expiresAt: number | null | undefined): number | null {
  return expiresNever(expiresAt) ? null : (expiresAt as number)
}

// ── How much a link can carry ────────────────────────────────────────────────
//
// Kept beside the expiry because it is the other half of the same contract, and
// because three places must agree on it: the main process packs the desk to fit
// (deskBundle.buildDeskBundle), the renderer checks the request before sending
// it (ephemeralShareClient), and Signal refuses anything larger.

/**
 * The largest request body Signal accepts on POST and PUT /shares/ephemeral:
 * 8 MiB, counted over the whole JSON body. The bundle travels inside that body
 * as a JSON STRING, so it is escaped twice over and every file in it is base64.
 */
export const LINK_SHARE_MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * What a bundle is packed to: the body limit less 512 KiB. The margin covers
 * what is wrapped around the bundle (the title a second time, the desk id, the
 * expiry fields) and leaves room for a server that counts slightly differently.
 */
export const LINK_SHARE_BUNDLE_BUDGET = LINK_SHARE_MAX_BODY_BYTES - 512 * 1024

/**
 * "8 MB", "7.5 MB", "40 MB": a size as the sender is told it. Binary megabytes
 * called MB, as Signal's own "too large" message counts them, so the desktop
 * and the server never quote the same limit as two different numbers. Whole
 * from 10 up, one decimal below, and no ".0".
 */
export const linkMegabytes = (bytes: number): string => {
  const v = bytes / (1024 * 1024)
  const one = v.toFixed(1)
  return `${v >= 10 || one.endsWith('.0') ? Math.round(v) : one} MB`
}

/** The link limit in words: "8 MB", as Signal says it. */
export const LINK_SHARE_LIMIT_WORDS = linkMegabytes(LINK_SHARE_MAX_BODY_BYTES)

/**
 * UTF-8 length of a string, counted rather than encoded: a bundle near the limit
 * is megabytes long, and encoding it only to read .byteLength allocates a second
 * copy for nothing. A lone surrogate counts as 3, as an encoder would write it.
 */
export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        // A surrogate pair: one code point, four bytes.
        n += 4
        i++
      } else n += 3
    } else n += 3
  }
  return n
}
