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
const PREFIX = '/fb-file/'
const DIR = 'plexii-files'

// OPFS reports no MIME type of its own, and a <video> handed the wrong one
// refuses to play rather than sniff.
const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
  ico: 'image/x-icon', heic: 'image/heic',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', html: 'text/html'
}
const typeFor = (name) => TYPES[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream'

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
  let found
  try {
    found = await findFile(id)
  } catch {
    // No directory yet: nothing has been stored in this browser.
    found = null
  }
  if (!found) return new Response('No such file', { status: 404 })

  const file = await found.handle.getFile()
  const type = file.type || typeFor(found.name)
  const range = request.headers.get('range')

  // Range matters for media: a <video> asks for one before it will play, and a
  // 200 carrying the whole body makes seeking impossible.
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Number(m[2]) : file.size - 1
      if (start < file.size) {
        const slice = file.slice(start, end + 1)
        return new Response(slice, {
          status: 206,
          headers: {
            'content-type': type,
            'content-length': String(slice.size),
            'content-range': `bytes ${start}-${end}/${file.size}`,
            'accept-ranges': 'bytes'
          }
        })
      }
    }
  }

  return new Response(file, {
    headers: { 'content-type': type, 'content-length': String(file.size), 'accept-ranges': 'bytes' }
  })
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  const id = decodeURIComponent(url.pathname.slice(PREFIX.length))
  event.respondWith(serve(event.request, id))
})
