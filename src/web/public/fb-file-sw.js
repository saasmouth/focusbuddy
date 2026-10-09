// Serves Drive file bytes to <img>, <video> and friends in the browser runtime.
//
// The desktop registers `fb-file://` as a privileged protocol that streams from
// disk. A tab cannot register a scheme, so the same file id arrives here as
// /fb-file/<id> and is answered from OPFS, where the browser runtime's blob
// store keeps it (src/web/worker/main/fileBlobs.ts).
//
// A Service Worker is what makes this possible at all: it can read OPFS and,
// unlike the page, it can answer a request for a URL an <img> has already
// committed to. The alternative -- creating blob: URLs before render and
// revoking them after -- has to be done per element, per mount, and leaks
// whichever way you get it wrong.
//
// ── WHAT A RESPONSE FROM HERE IS ALLOWED TO BE ──────────────────────────────
//
// On a share page every byte in OPFS, and the name each blob is stored under,
// came from whoever made the link. This worker used to type a response by the
// blob's extension and send nothing else, so a link could plant <id>.html (or
// a scripted <id>.svg), and opening plexiidesk.com/share/fb-file/<id> ran that
// page ON THE SHARE ORIGIN -- where localStorage holds the record of every link
// this visitor has opened, tokens included. So the type is decided here, from
// a short list, exactly as Signal serves the bytes people store with it
// (focusbuddy-signal/src/storedBytes.ts):
//
//   - raster images (png, jpeg, gif, webp, avif) and PDF are served inline as
//     themselves; audio and video likewise;
//   - an SVG keeps image/svg+xml, because an <img> renders an SVG only when it
//     is labelled as one, but is an ATTACHMENT: opening its URL downloads it
//     instead of rendering it as a page. (An <img> never runs an SVG's script.)
//   - everything else, text/html and every name not listed here included, is
//     application/octet-stream and an attachment.
//
// And every response, the 404 included, carries a policy that holds even if a
// browser renders it anyway:
//   - X-Content-Type-Options: nosniff, so nothing second-guesses the type;
//   - Content-Security-Policy: sandbox with default-src 'none' -- no scripts,
//     forms, plugins or popups, an opaque origin, and nothing loaded. PDF,
//     audio and video add allow-same-origin (scripts stay forbidden) because a
//     media document's own fetch of the file, and Chrome's PDF viewer, are
//     refused from an opaque origin; media adds media-src 'self' for the same
//     fetch, and an image img-src 'self' so its image document can show it;
//   - frame-ancestors 'self' (and X-Frame-Options: SAMEORIGIN): this app may
//     frame its own files, nothing else may.
//
// The extension is still the only thing consulted -- this worker deliberately
// does not open the database -- but what an extension can earn is now bounded
// by the lists below, not by what the name says. Import refuses unsafe names
// too (deskBundle.safeBundledFileType), so a new link cannot plant <id>.html at
// all; this is what keeps a blob stored by an older build, or arriving some
// other way, from running.
// Derived from where this script was served, so the same file works whether the
// app sits at the root or under a path on another site. self.location is the
// worker's own URL: /share/fb-file-sw.js gives a prefix of /share/fb-file/.
const PREFIX = new URL('./fb-file/', self.location.href).pathname
const DIR = 'plexii-files'

// Served inline as themselves. A Map, not an object literal: a blob named
// <id>.constructor must not find Object.prototype.constructor in here.
const INLINE_TYPES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
  ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['pdf', 'application/pdf']
])

// Audio and video, inline. OPFS reports no MIME type a worker should trust, and
// a <video> handed the wrong one refuses to play rather than sniff, so each is
// named here.
const MEDIA_TYPES = new Map([
  ['mp4', 'video/mp4'], ['m4v', 'video/x-m4v'], ['mov', 'video/quicktime'], ['webm', 'video/webm'],
  ['ogv', 'video/ogg'],
  ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'],
  ['opus', 'audio/ogg'], ['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['flac', 'audio/flac'],
  ['weba', 'audio/webm']
])

const SVG_TYPE = 'image/svg+xml'
const DOWNLOAD_TYPE = 'application/octet-stream'

// What a file id looks like: a UUID on every path that makes one. Anything with
// a dot, slash or percent sign is not an id, and a dot in particular would let
// "<id>" match "<id>.<something>.html" in the prefix search below.
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/

/** How a stored blob name is served: 'image' | 'pdf' | 'media' | 'svg' | 'download', and as what type. */
function policyFor(name) {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (INLINE_TYPES.has(ext)) {
    const type = INLINE_TYPES.get(ext)
    return { kind: type === 'application/pdf' ? 'pdf' : 'image', type }
  }
  if (MEDIA_TYPES.has(ext)) return { kind: 'media', type: MEDIA_TYPES.get(ext) }
  if (ext === 'svg') return { kind: 'svg', type: SVG_TYPE }
  return { kind: 'download', type: DOWNLOAD_TYPE }
}

function cspFor(kind) {
  const sameOrigin = kind === 'pdf' || kind === 'media'
  const parts = [sameOrigin ? 'sandbox allow-same-origin' : 'sandbox', "default-src 'none'"]
  if (kind === 'media') parts.push("media-src 'self'")
  if (kind === 'image') parts.push("img-src 'self'")
  parts.push("frame-ancestors 'self'")
  return parts.join('; ')
}

/**
 * A Content-Disposition value. The name is the blob's own (<id><ext>), reduced
 * to something no header parser can misread, with an RFC 5987 form beside it.
 */
function disposition(inline, name) {
  if (inline) return 'inline'
  const clean = String(name)
    .replace(/[\u0000-\u001f\u007f"\\/;]/g, '_')
    .replace(/^[.\s]+/, '')
    .slice(0, 150)
  if (!clean) return 'attachment'
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** The headers every response carries, whatever it is. */
function guardHeaders(kind) {
  return {
    'x-content-type-options': 'nosniff',
    'content-security-policy': cspFor(kind),
    'x-frame-options': 'SAMEORIGIN'
  }
}

function headersFor(name) {
  const { kind, type } = policyFor(name)
  const inline = kind === 'image' || kind === 'pdf' || kind === 'media'
  return {
    ...guardHeaders(kind),
    'content-type': type,
    'content-disposition': disposition(inline, name),
    'accept-ranges': 'bytes'
  }
}

function notFound() {
  return new Response('No such file', {
    status: 404,
    headers: { ...guardHeaders('download'), 'content-type': 'text/plain; charset=utf-8' }
  })
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

async function findFile(id) {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(DIR, { create: false })
  // Blobs are named <id><ext>, and the extension is not known here -- it lives
  // in the database, which this worker deliberately does not open. Matching on
  // the id prefix avoids needing it, and an id is a UUID so it cannot collide.
  for await (const [name, handle] of dir.entries()) {
    if (name === id || name.startsWith(`${id}.`)) return { name, handle }
  }
  return null
}

async function serve(request, id) {
  if (!FILE_ID.test(id)) return notFound()
  let found
  try {
    found = await findFile(id)
  } catch {
    // No directory yet: nothing has been stored in this browser.
    found = null
  }
  if (!found) return notFound()

  const file = await found.handle.getFile()
  // Never file.type: a File from OPFS is typed by its name, which is exactly
  // the thing that cannot be trusted here.
  const headers = headersFor(found.name)
  const range = request.headers.get('range')

  // Range matters for media: a <video> asks for one before it will play, and a
  // 200 carrying the whole body makes seeking impossible.
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m && (m[1] || m[2])) {
      let start
      let end
      if (m[1]) {
        start = Number(m[1])
        end = m[2] ? Math.min(Number(m[2]), file.size - 1) : file.size - 1
      } else {
        // bytes=-N: the last N bytes.
        start = Math.max(0, file.size - Number(m[2]))
        end = file.size - 1
      }
      if (start < file.size && start <= end) {
        const slice = file.slice(start, end + 1)
        return new Response(slice, {
          status: 206,
          headers: {
            ...headers,
            'content-length': String(slice.size),
            'content-range': `bytes ${start}-${end}/${file.size}`
          }
        })
      }
    }
  }

  return new Response(file, { headers: { ...headers, 'content-length': String(file.size) } })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  let id
  try {
    id = decodeURIComponent(url.pathname.slice(PREFIX.length))
  } catch {
    // A malformed escape is not an id either; answer it here rather than let it
    // fall through to the host, which would hand back the app's index.html.
    id = ''
  }
  event.respondWith(serve(event.request, id))
})
