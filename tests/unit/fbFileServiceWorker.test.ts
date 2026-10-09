// @vitest-environment node
//
// The share page's file Service Worker, run from the file that ships.
//
// On a share page every blob in OPFS, and the name it is stored under, came
// from whoever made the link. The worker used to type a response by the blob's
// extension and send nothing else, so a link could plant <id>.html and opening
// /share/fb-file/<id> ran it as a page of the share origin, where localStorage
// holds every link the visitor has opened. These tests load
// src/web/public/fb-file-sw.js into a sandbox with a fake OPFS and drive its
// fetch handler, so what they check is the code a browser runs, not a copy.
// The same file is driven in real Chromium by the share harness
// (e2eFileServiceWorker.mjs); this is the fast half that runs on every commit.
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import vm from 'vm'

vi.mock('../../src/main/db/database', () => ({ getDb: () => null }))
vi.mock('../../src/main/db/account', () => ({ accountEmail: () => null }))
vi.mock('../../src/main/db/fileBlobs', () => ({ fileBlobs: {} }))

const SW_SOURCE = readFileSync(resolve(__dirname, '../../src/web/public/fb-file-sw.js'), 'utf8')
const ORIGIN = 'https://plexiidesk.com'
const BASE = `${ORIGIN}/share/`

type FetchListener = (e: { request: Request; respondWith: (p: Promise<Response>) => void }) => void

/** A worker instance over a fake OPFS directory holding `files` (name -> bytes). */
function loadWorker(files: Record<string, string | Uint8Array> | null): (path: string, init?: RequestInit) => Promise<Response | null> {
  const listeners: Record<string, Array<(e: unknown) => void>> = {}
  const dir = {
    async *entries(): AsyncGenerator<[string, { getFile: () => Promise<File> }]> {
      for (const [name, body] of Object.entries(files ?? {})) {
        // OPFS types a File by its name; the worker must not believe it.
        const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.svg') ? 'image/svg+xml' : ''
        yield [name, { getFile: async () => new File([body], name, { type }) }]
      }
    }
  }
  const self = {
    location: new URL(`${BASE}fb-file-sw.js`),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      ;(listeners[type] ??= []).push(fn)
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} }
  }
  const navigator = {
    storage: {
      getDirectory: async () => ({
        getDirectoryHandle: async () => {
          if (files === null) throw new DOMException('not found', 'NotFoundError')
          return dir
        }
      })
    }
  }
  const context = vm.createContext({ self, navigator, Response, URL, DOMException })
  vm.runInContext(SW_SOURCE, context, { filename: 'fb-file-sw.js' })
  const fetchListener = listeners.fetch?.[0] as FetchListener | undefined
  if (!fetchListener) throw new Error('the worker registered no fetch listener')

  return async (path, init) => {
    let answered: Promise<Response> | null = null
    fetchListener({ request: new Request(new URL(path, ORIGIN), init), respondWith: (p) => (answered = p) })
    return answered ? await answered : null
  }
}

const ID = '3f2a9c1e-7b44-4c1d-9a0e-5d2b8f6e1a77'
const header = (r: Response, h: string): string => r.headers.get(h) ?? ''

/** Every response must carry these, whatever it is. */
function expectGuarded(r: Response): void {
  expect(header(r, 'x-content-type-options')).toBe('nosniff')
  const csp = header(r, 'content-security-policy')
  expect(csp).toMatch(/^sandbox(;| allow-same-origin;)/)
  expect(csp).not.toMatch(/allow-scripts/)
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("frame-ancestors 'self'")
  expect(header(r, 'x-frame-options')).toBe('SAMEORIGIN')
}

describe('a planted page is a download, never a page', () => {
  it.each([
    ['.html', '<script>localStorage.setItem("pwned","1")</script>'],
    ['.htm', '<script>alert(1)</script>'],
    ['.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'],
    ['.xml', '<?xml version="1.0"?><x/>'],
    ['.js', 'alert(1)'],
    ['.mjs', 'alert(1)'],
    ['.css', 'body{}'],
    ['.txt', 'hello'],
    ['.md', '# hi'],
    ['.json', '{}'],
    ['.csv', 'a,b'],
    ['.exe', 'MZ'],
    ['.bin', 'bytes'],
    ['.HTML', '<script>alert(1)</script>'],
    ['.constructor', 'not Object.prototype.constructor'],
    ['.__proto__', 'nor this'],
    ['', 'an extensionless blob']
  ])('%s is application/octet-stream, an attachment, sandboxed and nosniff', async (ext, body) => {
    const get = loadWorker({ [`${ID}${ext}`]: body })
    const r = (await get(`/share/fb-file/${ID}`))!
    expect(r.status).toBe(200)
    expect(header(r, 'content-type')).toBe('application/octet-stream')
    expect(header(r, 'content-disposition')).toMatch(/^attachment; filename="/)
    expect(header(r, 'content-disposition')).toContain(`${ID}${ext}`)
    expectGuarded(r)
    expect(header(r, 'content-security-policy')).toMatch(/^sandbox;/) // no allow-same-origin
    expect(await r.text()).toBe(body)
  })

  it('a scripted SVG keeps its type, so an <img> still renders it, but opening it downloads it', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const get = loadWorker({ [`${ID}.svg`]: svg })
    const r = (await get(`/share/fb-file/${ID}`))!
    expect(header(r, 'content-type')).toBe('image/svg+xml')
    expect(header(r, 'content-disposition')).toBe(`attachment; filename="${ID}.svg"; filename*=UTF-8''${ID}.svg`)
    expectGuarded(r)
    expect(header(r, 'content-security-policy')).toMatch(/^sandbox;/)
  })

  it('the type never comes from the File OPFS hands back (which is typed by the name)', async () => {
    // The fake OPFS types a .html File as text/html, exactly as a browser does.
    const get = loadWorker({ [`${ID}.html`]: '<p>x</p>' })
    expect(header((await get(`/share/fb-file/${ID}`))!, 'content-type')).toBe('application/octet-stream')
  })
})

describe('what a desk shows still shows', () => {
  it.each([
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.JPG', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif']
  ])('a %s image is inline as %s, with a sandbox that runs nothing', async (ext, type) => {
    const get = loadWorker({ [`${ID}${ext}`]: 'img' })
    const r = (await get(`/share/fb-file/${ID}`))!
    expect(header(r, 'content-type')).toBe(type)
    expect(header(r, 'content-disposition')).toBe('inline')
    expectGuarded(r)
    expect(header(r, 'content-security-policy')).toBe("sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'self'")
  })

  it('a PDF is inline, same-origin (for the viewer) and still runs no script', async () => {
    const get = loadWorker({ [`${ID}.pdf`]: '%PDF-1.4' })
    const r = (await get(`/share/fb-file/${ID}`))!
    expect(header(r, 'content-type')).toBe('application/pdf')
    expect(header(r, 'content-disposition')).toBe('inline')
    expect(header(r, 'content-security-policy')).toBe("sandbox allow-same-origin; default-src 'none'; frame-ancestors 'self'")
    expectGuarded(r)
  })

  it.each([
    ['.mp4', 'video/mp4'], ['.m4v', 'video/x-m4v'], ['.mov', 'video/quicktime'], ['.webm', 'video/webm'],
    ['.ogv', 'video/ogg'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'],
    ['.oga', 'audio/ogg'], ['.opus', 'audio/ogg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
    ['.flac', 'audio/flac'], ['.weba', 'audio/webm']
  ])('%s media is inline as %s with media-src for its own fetch', async (ext, type) => {
    const get = loadWorker({ [`${ID}${ext}`]: 'media' })
    const r = (await get(`/share/fb-file/${ID}`))!
    expect(header(r, 'content-type')).toBe(type)
    expect(header(r, 'content-disposition')).toBe('inline')
    expect(header(r, 'content-security-policy')).toBe(
      "sandbox allow-same-origin; default-src 'none'; media-src 'self'; frame-ancestors 'self'"
    )
    expectGuarded(r)
  })

  it('answers a Range request with 206, the policy headers, and a range clamped to the file', async () => {
    const get = loadWorker({ [`${ID}.mp4`]: '0123456789' })
    const r = (await get(`/share/fb-file/${ID}`, { headers: { range: 'bytes=2-99' } }))!
    expect(r.status).toBe(206)
    expect(header(r, 'content-range')).toBe('bytes 2-9/10')
    expect(header(r, 'content-length')).toBe('8')
    expect(header(r, 'content-type')).toBe('video/mp4')
    expectGuarded(r)
    expect(await r.text()).toBe('23456789')

    const tail = (await get(`/share/fb-file/${ID}`, { headers: { range: 'bytes=-3' } }))!
    expect(tail.status).toBe(206)
    expect(header(tail, 'content-range')).toBe('bytes 7-9/10')
    expect(await tail.text()).toBe('789')
  })

  it('a Range on a planted page is still a download', async () => {
    const get = loadWorker({ [`${ID}.html`]: '<script>x</script>' })
    const r = (await get(`/share/fb-file/${ID}`, { headers: { range: 'bytes=0-' } }))!
    expect(r.status).toBe(206)
    expect(header(r, 'content-type')).toBe('application/octet-stream')
    expect(header(r, 'content-disposition')).toMatch(/^attachment/)
    expectGuarded(r)
  })
})

describe('what is not a file', () => {
  it('a missing file is a guarded 404', async () => {
    const r = (await loadWorker({})(`/share/fb-file/${ID}`))!
    expect(r.status).toBe(404)
    expectGuarded(r)
    expect(header(r, 'content-type')).toBe('text/plain; charset=utf-8')
  })

  it('no store at all is a guarded 404', async () => {
    const r = (await loadWorker(null)(`/share/fb-file/${ID}`))!
    expect(r.status).toBe(404)
    expectGuarded(r)
  })

  it.each([
    // "<id>.html" asked for by its full name would otherwise match exactly.
    [`${ID}.html`],
    ['..%2F..%2Fsecret'],
    ['a%2Fb'],
    ['%E0%A4%A'], // a malformed escape
    ['']
  ])('an id that is not an id (%s) is a guarded 404, even when a blob of that name exists', async (raw) => {
    const r = (await loadWorker({ [`${ID}.html`]: '<script>x</script>', [decodeSafe(raw)]: 'x' })(`/share/fb-file/${raw}`))!
    expect(r.status).toBe(404)
    expectGuarded(r)
  })

  it('a dotted id cannot reach another file through the prefix match', async () => {
    // Without the id check, "<ID>" would match "<ID>.anything" -- that is how
    // blobs are found -- and "<ID>.x" would match "<ID>.x.html".
    const get = loadWorker({ [`${ID}.x.html`]: '<script>x</script>' })
    expect((await get(`/share/fb-file/${ID}.x`))!.status).toBe(404)
  })

  it('leaves requests outside its prefix, or for another origin, to the network', async () => {
    const get = loadWorker({ [`${ID}.png`]: 'img' })
    expect(await get('/share/s/sometoken')).toBeNull()
    expect(await get('/fb-file/' + ID)).toBeNull() // root-absolute: not this worker's scope
    expect(await get(`https://evil.example/share/fb-file/${ID}`)).toBeNull()
  })

  it('keeps a name with a quote or a control character from breaking the header', async () => {
    const get = loadWorker({ [`${ID}.a"b;c\u0001`]: 'x' })
    const d = header((await get(`/share/fb-file/${ID}`))!, 'content-disposition')
    expect(d).toBe(`attachment; filename="${ID}.a_b_c_"; filename*=UTF-8''${ID}.a_b_c_`)
  })
})

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s) || 'empty'
  } catch {
    return 'malformed'
  }
}

// Import holds a file's name to a list (deskBundle.safeBundledFileType); the
// worker types a response by the name. The two must agree, or a legitimate
// picture or video imported under an allowed name arrives as a download.
describe('the import list and the worker agree', () => {
  let deskBundle: typeof import('../../src/main/db/deskBundle')
  beforeAll(async () => {
    deskBundle = await import('../../src/main/db/deskBundle')
  })

  it('every name import can produce is served as an inline-safe type, an SVG attachment, or a download', async () => {
    const names = [...deskBundle.BUNDLE_FILE_TYPES.keys(), deskBundle.FALLBACK_FILE_EXT, '']
    for (const ext of names) {
      const r = (await loadWorker({ [`${ID}${ext}`]: 'x' })(`/share/fb-file/${ID}`))!
      const type = header(r, 'content-type')
      const disp = header(r, 'content-disposition')
      expectGuarded(r)
      const inlineSafe = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|(audio|video)\/[a-z0-9.-]+)$/.test(type)
      if (disp === 'inline') expect(inlineSafe, `${ext} served inline as ${type}`).toBe(true)
      else expect(['application/octet-stream', 'image/svg+xml'], `${ext} -> ${type}`).toContain(type)
    }
  })

  it('every image, PDF, audio or video name import keeps is served inline as the type import gives it', async () => {
    for (const [ext, types] of deskBundle.BUNDLE_FILE_TYPES) {
      const canonical = types[0]
      if (!/^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|audio\/|video\/)/.test(canonical)) continue
      const r = (await loadWorker({ [`${ID}${ext}`]: 'x' })(`/share/fb-file/${ID}`))!
      expect(header(r, 'content-type'), ext).toBe(canonical)
      expect(header(r, 'content-disposition'), ext).toBe('inline')
    }
  })
})
