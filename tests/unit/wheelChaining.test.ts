import { describe, it, expect } from 'vitest'
import {
  chainCanAbsorb,
  collectScrollChain,
  type ScrollBox
} from '../../src/renderer/src/lib/wheelChaining'

// ── 2026-10-08 — "its still sticking to some things" ────────────────────────
//
// Removing the swipe-to-widget gesture fixed the snapping, but the desk still
// stopped moving when the pointer sat over certain widgets. The canvas decided
// the wheel belonged to the active widget by POSITION alone, so a widget with
// nothing to scroll silently ate the gesture. The rule is now scroll chaining:
// the widget keeps the wheel only while it can still scroll that way.

const box = (p: Partial<ScrollBox> = {}): ScrollBox => ({
  tag: 'div',
  overflowX: 'visible',
  overflowY: 'visible',
  scrollWidth: 100,
  clientWidth: 100,
  scrollHeight: 100,
  clientHeight: 100,
  scrollTop: 0,
  scrollLeft: 0,
  ...p
})

/** A vertical scroller 300 tall in a 100 viewport. */
const vScroller = (scrollTop: number): ScrollBox =>
  box({ overflowY: 'auto', scrollHeight: 300, clientHeight: 100, scrollTop })

describe('chainCanAbsorb', () => {
  it('a widget with nothing scrollable never takes the gesture', () => {
    expect(chainCanAbsorb([box(), box()], 0, 100)).toBe(false)
    expect(chainCanAbsorb([box(), box()], 0, -100)).toBe(false)
  })

  it('a scroller with room below takes a downward gesture', () => {
    expect(chainCanAbsorb([vScroller(0)], 0, 100)).toBe(true)
  })

  it('a scroller already at the bottom hands a downward gesture on', () => {
    // 300 - 100 = 200 is the maximum scrollTop. This is the case that made the
    // desk feel stuck: the widget kept the wheel forever once scrolled to the end.
    expect(chainCanAbsorb([vScroller(200)], 0, 100)).toBe(false)
    // ...but it still takes an upward one, because it has room that way.
    expect(chainCanAbsorb([vScroller(200)], 0, -100)).toBe(true)
  })

  it('a scroller at the top hands an upward gesture on', () => {
    expect(chainCanAbsorb([vScroller(0)], 0, -100)).toBe(false)
  })

  it('overflow must allow scrolling, not merely overflow', () => {
    // Content taller than the box but clipped: there is nothing to scroll.
    const clipped = box({ overflowY: 'hidden', scrollHeight: 300, clientHeight: 100 })
    expect(chainCanAbsorb([clipped], 0, 100)).toBe(false)
  })

  it('a scroller one pixel short of overflowing is not a scroller', () => {
    expect(chainCanAbsorb([box({ overflowY: 'auto', scrollHeight: 101, clientHeight: 100 })], 0, 50)).toBe(false)
  })

  it('an inner scroller counts even when the widget root cannot scroll', () => {
    expect(chainCanAbsorb([vScroller(0), box()], 0, 100)).toBe(true)
  })

  it('the dominant axis decides, so a vertical gesture ignores a horizontal scroller', () => {
    const hOnly = box({ overflowX: 'auto', scrollWidth: 300, clientWidth: 100 })
    expect(chainCanAbsorb([hOnly], 0, 100)).toBe(false)
    expect(chainCanAbsorb([hOnly], 100, 0)).toBe(true)
  })

  it('a horizontal scroller at its right edge hands the gesture on', () => {
    const atEnd = box({ overflowX: 'auto', scrollWidth: 300, clientWidth: 100, scrollLeft: 200 })
    expect(chainCanAbsorb([atEnd], 100, 0)).toBe(false)
    expect(chainCanAbsorb([atEnd], -100, 0)).toBe(true)
  })

  it('an embedded browser view always keeps the gesture — it scrolls its own document', () => {
    // We cannot measure a webview from here, and guessing "not scrollable"
    // would steal the wheel from a page the user is reading.
    expect(chainCanAbsorb([box({ tag: 'webview' })], 0, 100)).toBe(true)
    expect(chainCanAbsorb([box({ tag: 'iframe' })], 0, 100)).toBe(true)
  })

  it('a dead gesture belongs to nobody', () => {
    expect(chainCanAbsorb([vScroller(50)], 0, 0)).toBe(false)
  })

  it('an empty chain absorbs nothing', () => {
    expect(chainCanAbsorb([], 0, 100)).toBe(false)
  })
})

describe('collectScrollChain', () => {
  // Minimal stand-ins: enough shape for contains/parentElement walking.
  function el(tag: string, parent: unknown = null): Element {
    const node = {
      tagName: tag.toUpperCase(),
      parentElement: parent,
      contains(other: unknown): boolean {
        let c: unknown = other
        while (c) {
          if (c === node) return true
          c = (c as { parentElement?: unknown }).parentElement
        }
        return false
      }
    }
    return node as unknown as Element
  }

  const read = (e: Element): ScrollBox => box({ tag: e.tagName.toLowerCase() })

  it('runs from the target outward to the root, inclusive', () => {
    const root = el('section')
    const mid = el('div', root)
    const target = el('span', mid)
    expect(collectScrollChain(target, root, read).map((b) => b.tag)).toEqual([
      'span',
      'div',
      'section'
    ])
  })

  it('is empty when the target is outside the root', () => {
    const root = el('section')
    const stray = el('span')
    expect(collectScrollChain(stray, root, read)).toEqual([])
  })

  it('is empty when either end is missing', () => {
    expect(collectScrollChain(null, el('section'), read)).toEqual([])
    expect(collectScrollChain(el('span'), null, read)).toEqual([])
  })
})
