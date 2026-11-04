// Storing a linked image, and the refusals that keep a widget from getting worse.
//
// A picture dragged out of a chat arrives as a URL and the desk stores the URL.
// Nothing is saved, and whether it ever appears again depends on a host we do
// not control and often a login we do not have -- one real desk had 21 images
// pointing into a chat session, invisible everywhere except the browser that
// created them.
//
// The refusals matter more than the happy path here. A fetch that fails must
// leave the widget exactly as it was: still showing its link, which is no worse
// than before and keeps the only clue about where the picture came from.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ingested: Array<{ originalName: string; mimeType: string; size: number }> = []
vi.mock('../../src/main/db/files', () => ({
  ingestFromBuffer: async (input: { buffer: Uint8Array; originalName: string; mimeType: string }) => {
    ingested.push({ originalName: input.originalName, mimeType: input.mimeType, size: input.buffer.length })
    return { id: 'file-1', originalName: input.originalName, mimeType: input.mimeType, sizeBytes: input.buffer.length }
  }
}))

import { ingestImageFromUrl, isRemoteImageUrl } from '../../src/main/db/filesFromUrl'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 4])
const okResponse = (bytes: Uint8Array, type = 'image/png'): Response =>
  ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }) as unknown as Response

beforeEach(() => { ingested.length = 0 })
afterEach(() => { vi.unstubAllGlobals() })

describe('which links are worth storing', () => {
  it('accepts http and https', () => {
    expect(isRemoteImageUrl('https://example.com/a.png')).toBe(true)
    expect(isRemoteImageUrl('http://example.com/a.png')).toBe(true)
  })

  it('ignores what is already local or already the bytes', () => {
    // A data: URL IS the image, a blob: belongs to one session, and fb-file://
    // is already a stored file. Re-fetching any of them would be pointless.
    for (const s of ['data:image/png;base64,AAAA', 'blob:https://x/y', 'fb-file://abc', '', '   ']) {
      expect(isRemoteImageUrl(s), s).toBe(false)
    }
  })
})

describe('storing one', () => {
  it('fetches the bytes and puts them in the Drive', async () => {
    vi.stubGlobal('fetch', async () => okResponse(png))
    const res = await ingestImageFromUrl('https://example.com/photo.png')
    expect(res.ok).toBe(true)
    expect(ingested).toHaveLength(1)
    expect(ingested[0].size).toBe(png.length)
    expect(ingested[0].mimeType).toBe('image/png')
  })

  it('keeps the filename from the URL when there is one', async () => {
    vi.stubGlobal('fetch', async () => okResponse(png))
    await ingestImageFromUrl('https://example.com/holiday/beach.png')
    expect(ingested[0].originalName).toBe('beach.png')
  })

  it('invents a sensible name when the URL has none', async () => {
    // The case that prompted all this: a query-string endpoint with no filename.
    vi.stubGlobal('fetch', async () => okResponse(png))
    await ingestImageFromUrl('https://chatgpt.com/backend-api/estuary/content?id=file_0000')
    expect(ingested[0].originalName).toMatch(/^image-\d+\.png$/)
  })
})

describe('when it cannot be stored', () => {
  it('reports a link that needs a session we do not have, and stores nothing', async () => {
    // 422 is literally what those chat links return to anyone else. This is the
    // whole reason the feature exists, so it must fail cleanly rather than throw.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 422 }) as unknown as Response)
    const res = await ingestImageFromUrl('https://chatgpt.com/backend-api/estuary/content?id=x')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('422')
    expect(ingested).toHaveLength(0)
  })

  it('refuses a response that is not an image', async () => {
    vi.stubGlobal('fetch', async () => okResponse(png, 'text/html'))
    const res = await ingestImageFromUrl('https://example.com/login')
    expect(res.ok).toBe(false)
    expect(ingested).toHaveLength(0)
  })

  it('refuses an empty body', async () => {
    vi.stubGlobal('fetch', async () => okResponse(new Uint8Array(0)))
    expect((await ingestImageFromUrl('https://example.com/a.png')).ok).toBe(false)
    expect(ingested).toHaveLength(0)
  })

  it('never throws when the network does', async () => {
    // A widget must not be able to break a render by having a dead link.
    vi.stubGlobal('fetch', async () => { throw new Error('getaddrinfo ENOTFOUND') })
    const res = await ingestImageFromUrl('https://nowhere.invalid/a.png')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

// ── Attachment drops (2026-11-04): the same path stores a picture dragged out of
// a browser onto a table's attachment field. It must take data:image as well as
// http(s), hold to the size cap WHILE reading (not after buffering it all), and
// store only what really is an image.
describe('a picture dropped on an attachment field', () => {
  const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))
  /** A response whose body streams in chunks, recording how much was pulled. */
  const streamed = (chunks: Uint8Array[], headers: Record<string, string>): { res: Response; pulled: () => number; cancelled: () => boolean } => {
    let i = 0
    let pulled = 0
    let cancelled = false
    const body = {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined }
          const value = chunks[i++]!
          pulled += value.byteLength
          return { done: false, value }
        },
        cancel: async () => { cancelled = true }
      }),
      cancel: async () => { cancelled = true }
    }
    const res = {
      ok: true,
      status: 200,
      url: '',
      headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
      body,
      arrayBuffer: async () => { throw new Error('must stream, not buffer') }
    } as unknown as Response
    return { res, pulled: () => pulled, cancelled: () => cancelled }
  }

  it('stores a data:image address without fetching anything', async () => {
    let fetched = false
    vi.stubGlobal('fetch', async () => { fetched = true; return okResponse(png) })
    const res = await ingestImageFromUrl(`data:image/png;base64,${b64(png)}`)
    expect(res.ok).toBe(true)
    expect(fetched).toBe(false)
    expect(ingested).toHaveLength(1)
    expect(ingested[0]).toMatchObject({ mimeType: 'image/png', size: png.length })
    expect(ingested[0].originalName).toMatch(/^image-\d+\.png$/)
  })

  it('refuses a data: address that is not an image, and stores nothing', async () => {
    const res = await ingestImageFromUrl('data:text/html;base64,PGgxPmhpPC9oMT4=')
    expect(res.ok).toBe(false)
    expect(ingested).toHaveLength(0)
  })

  it('refuses addresses it must never fetch (blob:, file:, javascript:)', async () => {
    let fetched = 0
    vi.stubGlobal('fetch', async () => { fetched++; return okResponse(png) })
    for (const u of ['blob:https://e.com/1', 'file:///etc/passwd', 'javascript:alert(1)']) {
      expect((await ingestImageFromUrl(u)).ok, u).toBe(false)
    }
    expect(fetched).toBe(0)
    expect(ingested).toHaveLength(0)
  })

  it('refuses from Content-Length before reading a byte of an oversized body', async () => {
    const s = streamed([png], { 'content-type': 'image/png', 'content-length': String(26 * 1024 * 1024) })
    vi.stubGlobal('fetch', async () => s.res)
    const res = await ingestImageFromUrl('https://example.com/huge.png')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/too large/)
    expect(s.pulled()).toBe(0)
    expect(ingested).toHaveLength(0)
  })

  it('stops reading the moment a body with no Content-Length passes the cap', async () => {
    const MB = new Uint8Array(1024 * 1024)
    MB.set(png)
    const s = streamed(Array.from({ length: 40 }, () => MB), { 'content-type': 'image/png' })
    vi.stubGlobal('fetch', async () => s.res)
    const res = await ingestImageFromUrl('https://example.com/endless.png')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/too large/)
    expect(s.pulled(), 'read past the cap').toBeLessThanOrEqual(26 * 1024 * 1024)
    expect(s.cancelled()).toBe(true)
    expect(ingested).toHaveLength(0)
  })

  it('stores a streamed image under the cap', async () => {
    const s = streamed([png.slice(0, 4), png.slice(4)], { 'content-type': 'image/png' })
    vi.stubGlobal('fetch', async () => s.res)
    const res = await ingestImageFromUrl('https://example.com/a.png')
    expect(res.ok).toBe(true)
    expect(ingested[0]).toMatchObject({ size: png.length, originalName: 'a.png' })
  })

  it('takes an image with no Content-Type only if its bytes are an image', async () => {
    vi.stubGlobal('fetch', async () => okResponse(png, ''))
    expect((await ingestImageFromUrl('https://example.com/noext')).ok).toBe(true)
    expect(ingested[0].mimeType).toBe('image/png')
    vi.stubGlobal('fetch', async () => okResponse(new TextEncoder().encode('just some text'), 'application/octet-stream'))
    expect((await ingestImageFromUrl('https://example.com/blob.bin')).ok).toBe(false)
    expect(ingested).toHaveLength(1)
  })

  it('refuses a sign-in page served as image/png', async () => {
    vi.stubGlobal('fetch', async () => okResponse(new TextEncoder().encode('<!DOCTYPE html><html><title>Sign in</title>'), 'image/png'))
    const res = await ingestImageFromUrl('https://example.com/private.png')
    expect(res.ok).toBe(false)
    expect(ingested).toHaveLength(0)
  })

  it('names a refused page plainly', async () => {
    vi.stubGlobal('fetch', async () => okResponse(png, 'text/html; charset=utf-8'))
    const res = await ingestImageFromUrl('https://example.com/article')
    expect(res.error).toBe('That address is a web page, not an image.')
  })
})
