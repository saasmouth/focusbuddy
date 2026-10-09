import { toHttpUrl } from '@shared/safeUrl'

// Open an address that came from content in a new tab -- safely, in both
// runtimes.
//
// Two things go wrong with a bare window.open into a new tab once the same
// renderer serves the public share page:
//
//   - the scheme is whatever the content says. `javascript:` runs in the share
//     page's own origin; `data:` and `blob:` can carry a whole page.
//   - the opened tab gets `window.opener`, so a hostile site can navigate the
//     share page behind the visitor's back to a look-alike (reverse
//     tabnabbing), and it receives the share page's URL -- token included --
//     as its Referer.
//
// So only http(s) is opened, always with noopener and noreferrer. On the
// desktop the main process's window-open handler still makes the final call and
// hands the address to the system browser; nothing here changes that.

/**
 * Open `raw` in a new tab if it is an http(s) address. Returns false, having
 * opened nothing, for any other scheme -- callers that need to tell the user
 * should say so rather than fail silently.
 */
export function openHttpUrl(raw: unknown): boolean {
  const u = toHttpUrl(raw)
  if (!u) return false
  window.open(u.href, '_blank', 'noopener,noreferrer')
  return true
}
