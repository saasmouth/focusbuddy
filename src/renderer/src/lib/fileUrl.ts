// The URL an <img>, <video> or <a> uses to reach a Drive file's bytes.
//
// On the desktop that is `fb-file://<id>`, a privileged custom protocol
// registered in the main process which streams from disk and supports Range
// requests. A browser has no such scheme -- an <img src="fb-file://…"> simply
// fails, silently, which is exactly how every image on a synced desk came up
// blank in the cloud app.
//
// So in the browser the same id becomes a same-origin path, served by a Service
// Worker that reads the bytes out of OPFS. Deliberately a path rather than a
// blob: URL, because a blob: URL has to be created before the element renders,
// revoked afterwards, and re-created on every mount -- three ways to leak or to
// show nothing. A path is a plain string that behaves like any other image URL,
// including in CSS, and it survives being copied into markup.
const WEB = (): boolean => (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ === true

/** Where this file's bytes can be fetched from, in whichever runtime we are. */
export function fileSrc(fileId: string): string {
  return WEB() ? `/fb-file/${encodeURIComponent(fileId)}` : `fb-file://${fileId}`
}

/**
 * Turn whatever a media widget stores in `content` into a URL this runtime can
 * load.
 *
 * An image or video widget renders `content` straight into a src attribute, and
 * content is not one thing. It may be an ordinary http(s) URL, a data: URL, or a
 * reference to a Drive file -- and a Drive reference has three historical
 * shapes, all of which still exist on real desks (see lib/liveDeskResolvers.ts,
 * which has always had to handle the same three):
 *
 *   fb-file://<id>        the current form
 *   {"fileId":"<id>"}     a JSON wrapper from the ingest pipeline
 *   <id>                  a bare id
 *
 * On the desktop every one of those resolves back to fb-file://<id>, which is
 * exactly what it did before, so nothing changes there. In the browser they
 * become the path the Service Worker serves. This is why images stayed blank
 * after the URL helper was introduced: the construction sites were fixed, but
 * an image widget does not construct anything -- it renders a string that was
 * written into the database long ago.
 */
export function resolveMediaSrc(content: string | null | undefined): string {
  const raw = (content ?? '').trim()
  if (!raw) return ''
  // Already loadable as-is.
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw

  const local = /^fb-file:\/\/([\w-]+)/.exec(raw)
  if (local) return fileSrc(local[1])

  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as { fileId?: unknown; id?: unknown }
      const id = typeof o.fileId === 'string' ? o.fileId : typeof o.id === 'string' ? o.id : null
      if (id) return fileSrc(id)
    } catch {
      // Not JSON after all; fall through and return it untouched.
    }
  }

  // A bare id. Deliberately strict: anything looser would turn a relative path
  // or a stray word into a file request that 404s.
  if (/^[0-9a-fA-F-]{8,}$/.test(raw)) return fileSrc(raw)

  return raw
}
