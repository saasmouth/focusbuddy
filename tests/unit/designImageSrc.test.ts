// What a design element's image address may be, and what elementHtml does
// with one it cannot vouch for.
//
// This mattered the moment elementHtml was exported (2e's any-to-any work): a
// SNIPPET carries one document's elements into another's, and that HTML is
// rendered inside a foreignObject in Write, Diagrams and Draw. A src that was
// always our own data inside Design is someone else's data once it travels,
// and an unescaped quote in an attribute is a way out of that attribute.

import { describe, expect, it } from 'vitest'
// Through pageElementsHtml, the exported renderer: elementHtml itself is
// exported on 2e's any-to-any branch, not here, and a test should not depend
// on another branch's export to prove this branch's escaping.
import { normalizeDesignBody, pageElementsHtml, isSafeImageSrc } from '../../src/shared/design'
import type { SlideElement } from '../../src/shared/types'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

describe('isSafeImageSrc', () => {
  it('accepts embedded image bytes', () => {
    expect(isSafeImageSrc(PNG)).toBe(true)
    expect(isSafeImageSrc('data:image/svg+xml;utf8,<svg/>')).toBe(false) // angle brackets
    expect(isSafeImageSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe(true)
  })

  it('accepts https, because a brand logo is an uploaded asset, not always a data URI', () => {
    expect(isSafeImageSrc('https://cdn.example.com/logo.png')).toBe(true)
  })

  it('refuses the schemes that are not images at all', () => {
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false)
    expect(isSafeImageSrc('data:text/html;base64,PHNjcmlwdD4=')).toBe(false)
    expect(isSafeImageSrc('http://insecure.example.com/x.png')).toBe(false)
    expect(isSafeImageSrc('file:///etc/passwd')).toBe(false)
  })

  it('refuses anything that could break out of the attribute it is written into', () => {
    expect(isSafeImageSrc('https://e.com/x.png" onerror="alert(1)')).toBe(false)
    expect(isSafeImageSrc("https://e.com/x.png' onerror='alert(1)")).toBe(false)
    expect(isSafeImageSrc('https://e.com/x.png><script>alert(1)</script>')).toBe(false)
    expect(isSafeImageSrc('https://e.com/\u0000.png')).toBe(false)
  })

  it('refuses what is not a string', () => {
    expect(isSafeImageSrc(undefined)).toBe(false)
    expect(isSafeImageSrc(null)).toBe(false)
    expect(isSafeImageSrc(42)).toBe(false)
    expect(isSafeImageSrc('')).toBe(false)
  })
})

describe('the element renderer escapes what it is given', () => {
  const htmlFor = (el: unknown): string =>
    pageElementsHtml(normalizeDesignBody({ width: 100, height: 100, elements: [el] }), 0)
  const image = (src: string): SlideElement =>
    ({ id: 'e1', type: 'image', src, x: 0, y: 0, w: 10, h: 10, z: 1 }) as unknown as SlideElement

  it('an attribute-breaking src cannot escape its attribute', () => {
    const html = htmlFor(image('x.png" onerror="alert(1)'))
    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).toContain('&quot;')
  })

  it('a table cell cannot inject markup, including a closing tag', () => {
    const table = {
      id: 'e2',
      type: 'table',
      cells: [['</td></tr><script>alert(1)</script>', 'ok & fine']],
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      z: 1
    } as unknown as SlideElement
    const html = htmlFor(table)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('ok &amp; fine')
  })
})
