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
