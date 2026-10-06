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
// like https://view.haptyx.app). Trailing slashes are trimmed so the
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
