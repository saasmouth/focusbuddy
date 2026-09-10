// What an image or video widget stores in `content`, turned into a URL.
//
// This is where images stayed blank after the file-URL helper landed. The
// helper fixed the places that BUILD a URL, but an image widget builds nothing
// -- it renders a string that was written into the database long ago, and that
// string is a Drive reference in one of three historical shapes.
//
// The desktop assertions matter as much as the browser ones: this runs in the
// shipping desktop app, where every one of these must still resolve to exactly
// the fb-file:// URL it did before.
import { describe, it, expect, afterEach } from 'vitest'
import { fileSrc, resolveMediaSrc } from '../../src/renderer/src/lib/fileUrl'

const asWeb = (on: boolean): void => {
  ;(globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__ = on
}
afterEach(() => {
  delete (globalThis as { __PLEXII_WEB__?: boolean }).__PLEXII_WEB__
})

const ID = '3c26020e-1f4a-4c7e-9a11-8b2d5e6f7a90'

describe('on the desktop', () => {
  it('resolves every Drive reference shape to the protocol it always used', () => {
    asWeb(false)
    expect(resolveMediaSrc(`fb-file://${ID}`)).toBe(`fb-file://${ID}`)
    expect(resolveMediaSrc(JSON.stringify({ fileId: ID }))).toBe(`fb-file://${ID}`)
    expect(resolveMediaSrc(JSON.stringify({ id: ID }))).toBe(`fb-file://${ID}`)
    expect(resolveMediaSrc(ID)).toBe(`fb-file://${ID}`)
  })
})

describe('in the browser', () => {
  it('resolves the same four shapes to the path the service worker serves', () => {
    asWeb(true)
    const expected = `/fb-file/${encodeURIComponent(ID)}`
    expect(resolveMediaSrc(`fb-file://${ID}`)).toBe(expected)
    expect(resolveMediaSrc(JSON.stringify({ fileId: ID }))).toBe(expected)
    expect(resolveMediaSrc(JSON.stringify({ id: ID }))).toBe(expected)
    expect(resolveMediaSrc(ID)).toBe(expected)
  })

  it('agrees with fileSrc, which is what the other call sites use', () => {
    asWeb(true)
    expect(resolveMediaSrc(`fb-file://${ID}`)).toBe(fileSrc(ID))
  })
})

describe('things that are already loadable', () => {
  it('passes remote and inline URLs through untouched, in both runtimes', () => {
    for (const web of [false, true]) {
      asWeb(web)
      for (const url of [
        'https://example.com/a.png',
        'http://example.com/a.png',
        'data:image/png;base64,iVBORw0KGgo=',
        'blob:https://example.com/9a8b-7c6d'
      ]) {
        expect(resolveMediaSrc(url), `${url} (web=${web})`).toBe(url)
      }
    }
  })

  it('does not turn arbitrary text into a file request', () => {
    // The bare-id branch is deliberately strict. Anything looser would make a
    // stray word or a relative path into a fetch that 404s, and the widget
    // would show a broken image instead of whatever it was actually pointing at.
    asWeb(true)
    for (const s of ['not a url', './local/photo.png', 'photo.png', 'abc123']) {
      expect(resolveMediaSrc(s), s).toBe(s)
    }
  })

  it('treats empty content as empty rather than as a file id', () => {
    asWeb(true)
    expect(resolveMediaSrc('')).toBe('')
    expect(resolveMediaSrc(null)).toBe('')
    expect(resolveMediaSrc(undefined)).toBe('')
    expect(resolveMediaSrc('   ')).toBe('')
  })

  it('survives malformed JSON without throwing', () => {
    asWeb(true)
    expect(resolveMediaSrc('{"fileId":')).toBe('{"fileId":')
    expect(resolveMediaSrc('{}')).toBe('{}')
  })
})
