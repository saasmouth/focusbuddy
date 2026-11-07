// Share-link token utilities. Tokens are opaque, URL-safe, and long enough
// that brute-forcing the share namespace is impractical. v1 generates them
// locally; when the production server lands the same token format is what
// goes into the URL path so URLs minted in local-mock mode survive the
// transition.

// 96 bits of entropy (16 base32 chars). 32^16 = ~10^24 — astronomically
// safe against guessing within any human-lifetime URL space.
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

export function generateShareToken(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length]
  }
  return out
}

// The viewer base URL where share links resolve. Defaults to the hosted
// viewer; override at build time with VITE_VIEWER_URL (e.g. a custom domain
// like https://view.plexiidesk.com). Trailing slashes are trimmed so the
// `${base}/share/${token}` join is always clean.
import { ACTIVE } from '@shared/productDomains'

const VIEWER_BASE = (
  (import.meta.env.VITE_VIEWER_URL as string | undefined) ||
  ACTIVE.viewer
).replace(/\/+$/, '')

// The viewer URL for a share token. This is what the user copies and sends,
// so it must point at the real viewer, not a placeholder.
export function viewerUrlFor(token: string): string {
  return `${VIEWER_BASE}/share/${token}`
}

/**
 * What a link pasted into "Shared with me" is.
 *
 * Four shapes reach that box, because a share link's address changes on the
 * way to the person holding it:
 *   view.plexiidesk.com/share/<token>     what the sender sends (a read link)
 *   plexiidesk.com/share/c/<token>        what the browser shows once the
 *                                         viewer has forwarded that link to the
 *                                         full web app -- the address a
 *                                         recipient copies (23, 2026-11-07:
 *                                         it was read as the token "c")
 *   plexiidesk.com/share/s/<token>        a desk to use, in the browser
 *   .../share/dsk_<…>, .../share/l/dsk_<…> a live desk
 * Only a read link is added here; the other two are said plainly.
 */
export type PastedShareLink =
  | { kind: 'read'; token: string }
  | { kind: 'use' }
  | { kind: 'live' }
  | null

export function parsePastedShareLink(text: string): PastedShareLink {
  const raw = (text ?? '').trim()
  if (/(^|\/)(l\/)?dsk_[A-Za-z0-9_-]{8,}/.test(raw)) return { kind: 'live' }
  const path = /\/share\/(?:(c|s)\/)?([A-Za-z0-9_-]+)/.exec(raw)
  if (path) {
    if (path[1] === 's') return { kind: 'use' }
    return /^[a-z0-9]{8,64}$/i.test(path[2]) ? { kind: 'read', token: path[2] } : null
  }
  // The token alone, as somebody might copy it out of a link.
  return /^[a-z0-9]{16}$/i.test(raw) ? { kind: 'read', token: raw } : null
}
