// The checks every dropped picture passes before a byte of it is stored
// (src/shared/imageDrop.ts): which addresses may be fetched at all, whether
// the bytes are really an image, the size cap, and the name it is stored under.
import { describe, it, expect } from 'vitest'
import {
  MAX_DROPPED_IMAGE_BYTES,
  decodeImageDataUrl,
  imageExtFor,
  imageNameFromUrl,
  imageSourceLabel,
  isAttachableImageAddress,
  judgeImageBody,
  sniffImageMime
} from '../../src/shared/imageDrop'

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs)
const text = (s: string): Uint8Array => new TextEncoder().encode(s)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16)
const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u))

describe('which addresses a drop may store', () => {
  it('http, https and data:image', () => {
    for (const ok of ['https://example.com/a.png', 'http://127.0.0.1:5173/x', 'data:image/png;base64,AAAA', 'data:image/svg+xml,%3Csvg%3E']) {
      expect(isAttachableImageAddress(ok), ok).toBe(true)
    }
  })

  it('nothing else: no page-local, local-disk, app-internal, script or non-image data addresses', () => {
    for (const bad of [
      'blob:https://example.com/1',
      'file:///Users/me/a.png',
      'fb-file://abc',
      'javascript:alert(1)',
      'data:text/html,<b>x</b>',
      'data:,hello',
      '/relative.png',
      'ftp://example.com/a.png',
      'https://',
      'https://exa mple.com/a.png',
      '',
      null,
      undefined
    ]) {
      expect(isAttachableImageAddress(bad as string), String(bad)).toBe(false)
    }
  })
})

describe('is it really an image', () => {
  it('recognises the common formats by their signature', () => {
    expect(sniffImageMime(PNG)).toBe('image/png')
    expect(sniffImageMime(JPEG)).toBe('image/jpeg')
    expect(sniffImageMime(text('GIF89a....'))).toBe('image/gif')
    expect(sniffImageMime(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMime(text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
    expect(sniffImageMime(bytes(0, 0, 0, 0x20, ...text('ftypavif')))).toBe('image/avif')
  })

  it('a web page, a video and random bytes are not images', () => {
    expect(sniffImageMime(text('<!DOCTYPE html><html>'))).toBeNull()
    // An MP4 whose ftyp box is 256 bytes starts 00 00 01 00, like an icon: still not a picture.
    expect(sniffImageMime(bytes(0, 0, 1, 0, ...text('ftypisom')))).toBeNull()
    expect(sniffImageMime(bytes(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull()
    expect(sniffImageMime(new Uint8Array(0))).toBeNull()
  })

  it('believes a declared image/* (the bytes decide the exact type)', () => {
    expect(judgeImageBody('image/png', PNG)).toEqual({ ok: true, mime: 'image/png' })
    expect(judgeImageBody('image/jpeg; charset=binary', PNG)).toEqual({ ok: true, mime: 'image/png' })
    // A format we do not sniff is still taken on the server's word.
    expect(judgeImageBody('image/x-portable-pixmap', bytes(0x50, 0x36))).toEqual({ ok: true, mime: 'image/x-portable-pixmap' })
  })

  it('refuses a login page served as image/png', () => {
    expect(judgeImageBody('image/png', text('<!doctype html><title>Sign in</title>')).ok).toBe(false)
  })

  it('with no type or a generic one, only bytes that ARE an image pass', () => {
    expect(judgeImageBody('', PNG)).toEqual({ ok: true, mime: 'image/png' })
    expect(judgeImageBody('application/octet-stream', JPEG)).toEqual({ ok: true, mime: 'image/jpeg' })
    expect(judgeImageBody('', text('hello')).ok).toBe(false)
    expect(judgeImageBody('application/octet-stream', text('PK\u0003\u0004zip')).ok).toBe(false)
  })

  it('refuses a declared non-image, and an empty body', () => {
    const page = judgeImageBody('text/html', PNG)
    expect(page.ok).toBe(false)
    expect(!page.ok && page.error).toMatch(/web page/)
    expect(judgeImageBody('application/json', text('{}')).ok).toBe(false)
    expect(judgeImageBody('image/png', new Uint8Array(0)).ok).toBe(false)
  })
})

describe('data:image addresses', () => {
  it('decodes base64', () => {
    const r = decodeImageDataUrl(`data:image/png;base64,${b64(PNG)}`)
    expect(r.ok && Array.from(r.bytes)).toEqual(Array.from(PNG))
    expect(r.ok && r.mime).toBe('image/png')
  })

  it('decodes a percent-encoded SVG', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f00"/></svg>'
    const r = decodeImageDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`)
    expect(r.ok && new TextDecoder().decode(r.bytes)).toBe(svg)
    expect(r.ok && r.mime).toBe('image/svg+xml')
  })

  it('refuses a non-image type, unreadable base64, a body that is not what it claims, and anything over the cap', () => {
    expect(decodeImageDataUrl('data:text/plain;base64,aGk=').ok).toBe(false)
    expect(decodeImageDataUrl('data:image/png;base64,%%%').ok).toBe(false)
    expect(decodeImageDataUrl(`data:image/png;base64,${b64(text('<!DOCTYPE html><html></html>'))}`).ok).toBe(false)
    const big = decodeImageDataUrl(`data:image/png;base64,${'A'.repeat(4 * 1024)}`, 1024)
    expect(big.ok).toBe(false)
    expect(!big.ok && big.error).toMatch(/too large/)
    expect(MAX_DROPPED_IMAGE_BYTES).toBe(25 * 1024 * 1024)
  })
})

describe('the name it is stored under', () => {
  it("keeps the URL's own filename, decoded and made safe", () => {
    expect(imageNameFromUrl('https://e.com/holiday/beach.png', 'image/png')).toBe('beach.png')
    expect(imageNameFromUrl('https://e.com/a/My%20Photo.JPG?x=1', 'image/jpeg')).toBe('My Photo.JPG')
    expect(imageNameFromUrl('https://e.com/a/we%3Aird%2Fname.png', 'image/png')).toBe('we_ird_name.png')
  })

  it('swaps a script extension for the image type it served', () => {
    expect(imageNameFromUrl('https://e.com/thumb.php?id=4', 'image/jpeg')).toBe('thumb.jpg')
  })

  it('invents one when the URL has none, or for a data: image', () => {
    expect(imageNameFromUrl('https://e.com/api/content?id=1', 'image/webp', 42)).toBe('image-42.webp')
    expect(imageNameFromUrl('data:image/png;base64,AAAA', 'image/png', 42)).toBe('image-42.png')
  })

  it('knows the usual extensions', () => {
    expect(imageExtFor('image/jpeg')).toBe('.jpg')
    expect(imageExtFor('image/svg+xml')).toBe('.svg')
    expect(imageExtFor('image/jxl')).toBe('.jxl')
    expect(imageExtFor('image/x-portable-pixmap')).toBe('.img')
  })

  it('labels where it came from', () => {
    expect(imageSourceLabel('https://www.example.com/a.png')).toBe('example.com')
    expect(imageSourceLabel('data:image/png;base64,AA')).toBe('the dropped image')
  })
})
