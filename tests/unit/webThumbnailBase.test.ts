// The browser runtime's thumbnails ask the file Service Worker for the bytes,
// and must ask under the base the app was served from.
//
// The share site serves the app under /share/, and the worker's scope is
// /share/. A root-absolute fetch('/fb-file/<id>') is outside that scope: no
// worker sees it, the host answers with index.html, and every thumbnail on the
// share page was quietly null.
import { describe, it, expect, vi, afterEach } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('files.thumbnail in the browser runtime', () => {
  it.each([
    ['/share/', '/share/fb-file/3f2a9c1e-7b44'],
    ['/', '/fb-file/3f2a9c1e-7b44']
  ])('served from %s, it fetches %s', async (base, expected) => {
    vi.stubEnv('BASE_URL', base)
    const asked: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url))
      return new Response('No such file', { status: 404 })
    })
    const { platformNamespaces } = await import('../../src/web/api/platform')
    const files = platformNamespaces().files as { thumbnail: (id: string) => Promise<unknown> }
    expect(await files.thumbnail('3f2a9c1e-7b44')).toBeNull()
    expect(asked).toEqual([expected])
  })

  it('declines anything the worker does not serve as a raster image', async () => {
    vi.stubEnv('BASE_URL', '/share/')
    vi.stubGlobal('fetch', async () =>
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml', 'content-disposition': 'attachment' } }))
    const { platformNamespaces } = await import('../../src/web/api/platform')
    const files = platformNamespaces().files as { thumbnail: (id: string) => Promise<unknown> }
    expect(await files.thumbnail('abc')).toBeNull()
  })
})
