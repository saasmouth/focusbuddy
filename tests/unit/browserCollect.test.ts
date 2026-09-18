import { describe, expect, test, vi } from 'vitest'

// browserActions reaches for Electron at import time; the harvest script it
// builds does not, so a stub is enough to get at it.
vi.mock('electron', () => ({ webContents: { fromId: () => null } }))

// The harvest script, RUN rather than inspected.
//
// `collectJs` builds a string that executes inside a live page, which makes it
// exactly the kind of code that reads fine and behaves wrong. The suite's DOM
// environment gives it a real document to walk, so these tests exercise the
// same source the browser gets: relative URLs resolved, in-page anchors dropped, tracking pixels left
// out, duplicates collapsed, and the cap honoured.

import { collectJs, MAX_COLLECTED, type CollectedItem } from '../../src/main/ai/browserActions'
import { collectResultLine } from '../../src/main/ai/browserAgentEnvelope'

interface Harvest {
  items: CollectedItem[]
  total: number
}

function run(html: string, what: 'links' | 'images', cap = MAX_COLLECTED): Harvest {
  document.head.innerHTML = '<base href="https://example.com/docs/">'
  document.body.innerHTML = html
  // eslint-disable-next-line no-eval
  return eval(collectJs(what, cap)) as Harvest
}

describe('collecting links', () => {
  test('resolves relative hrefs against the page', () => {
    // A bare "guide.html" means nothing once it leaves the page, and a model
    // handed one would either guess a host or record a dead string.
    const { items } = run('<a href="guide.html">Guide</a>', 'links')
    expect(items).toEqual([{ url: 'https://example.com/docs/guide.html', text: 'Guide' }])
  })

  test('keeps the visible text, collapsed', () => {
    const { items } = run('<a href="/x">  Read\n   the   docs  </a>', 'links')
    expect(items[0].text).toBe('Read the docs')
  })

  test('drops in-page anchors and non-http schemes', () => {
    // These are navigation or actions, not destinations worth recording — and
    // javascript: in particular must never come back as a "link" to open.
    const { items } = run(
      `<a href="#section">Jump</a>
       <a href="javascript:alert(1)">Bad</a>
       <a href="mailto:a@b.com">Mail</a>
       <a href="/real">Real</a>`,
      'links'
    )
    expect(items.map((i) => i.url)).toEqual(['https://example.com/real'])
  })

  test('collapses duplicates but still counts the page honestly', () => {
    const { items, total } = run(
      '<a href="/a">One</a><a href="/a">One again</a><a href="/b">Two</a>',
      'links'
    )
    expect(items).toHaveLength(2)
    expect(total).toBe(2)
  })

  test('caps the list and reports how many there really were', () => {
    // The cap is what keeps one harvest from eating the whole round; the total
    // is what keeps the report from lying about coverage.
    const html = Array.from({ length: 12 }, (_, i) => `<a href="/p${i}">P${i}</a>`).join('')
    const { items, total } = run(html, 'links', 5)
    expect(items).toHaveLength(5)
    expect(total).toBe(12)
  })

  test('returns nothing rather than throwing on a page with no links', () => {
    expect(run('<p>Just words.</p>', 'links')).toEqual({ items: [], total: 0 })
  })
})

describe('collecting images', () => {
  test('resolves the src and keeps the alt text and size', () => {
    const { items } = run('<img src="hero.png" alt="The hero" width="800" height="400">', 'images')
    expect(items).toEqual([
      { url: 'https://example.com/docs/hero.png', text: 'The hero', w: 800, h: 400 }
    ])
  })

  test('leaves out icons and tracking pixels', () => {
    // A 1x1 beacon and a 16px icon are not what anyone means by "the images on
    // this page"; collecting them buries the real pictures.
    const { items } = run(
      `<img src="/beacon.gif" width="1" height="1">
       <img src="/icon.png" width="16" height="16">
       <img src="/photo.jpg" width="1200" height="800" alt="Photo">`,
      'images'
    )
    expect(items.map((i) => i.url)).toEqual(['https://example.com/photo.jpg'])
  })

  test('keeps an image whose size is unknown', () => {
    // An image that has not loaded reports 0x0. Treating unknown as tiny would
    // silently drop the real content of a lazy-loading page.
    const { items } = run('<img src="/late.jpg" alt="Late">', 'images')
    expect(items.map((i) => i.url)).toEqual(['https://example.com/late.jpg'])
  })

  test('records an empty alt honestly rather than inventing one', () => {
    const { items } = run('<img src="/x.png" width="500" height="500">', 'images')
    expect(items[0].text).toBe('')
  })

  test('ignores links when asked for images, and images when asked for links', () => {
    const html = '<a href="/page">Page</a><img src="/pic.png" width="300" height="300">'
    expect(run(html, 'images').items.map((i) => i.url)).toEqual(['https://example.com/pic.png'])
    expect(run(html, 'links').items.map((i) => i.url)).toEqual(['https://example.com/page'])
  })
})

// How a harvest is reported back to the model.
//
// The list exists for exactly one round — like every other observation it is
// dropped to keep a long run affordable — so the line has to SAY that. Without
// it a run collects fifty links, moves on, and records none of them, which is
// the failure the findings mechanism exists to prevent.
describe('collectResultLine', () => {
  const items: CollectedItem[] = [
    { url: 'https://a.test/one', text: 'One' },
    { url: 'https://a.test/two', text: '' }
  ]

  test('lists what came back and warns the list is not repeated', () => {
    const line = collectResultLine('links', { collected: items, collectedTotal: 2 })
    expect(line).toContain('https://a.test/one')
    expect(line).toContain('https://a.test/two')
    expect(line).toContain('NOT repeated')
  })

  test('is honest when the page had more than the cap allowed', () => {
    // Claiming 2 links on a page with 140 would have the model conclude it had
    // seen everything.
    expect(collectResultLine('links', { collected: items, collectedTotal: 140 })).toContain(
      'of 140'
    )
  })

  test('says so plainly when a page has none', () => {
    const line = collectResultLine('images', { collected: [], collectedTotal: 0 })
    expect(line).toContain('found none')
    // An empty harvest is a fact about the page, not a failure to retry.
    expect(line).not.toContain('NOT repeated')
  })

  test('carries image dimensions so a hero can be told from an icon', () => {
    const line = collectResultLine('images', {
      collected: [{ url: 'https://a.test/hero.jpg', text: 'Hero', w: 1600, h: 900 }],
      collectedTotal: 1
    })
    expect(line).toContain('1600x900')
  })
})
