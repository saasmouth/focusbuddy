// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { duplicateElement } from '../../src/renderer/src/components/documents/slides/slideOps'
import type { Slide, SlideElement } from '../../src/shared/types'

// Duplicate used to spread the element, which gave the copy its own top-level
// object and left every nested one SHARED. Two consequences, neither obvious
// from reading the call site:
//
//   editing the copy's fill edited the original's, because they were one
//   object;
//
//   the saved body held the same object reachable by two paths, which the IPC
//   payload check rejected as "cyclic data" — the bug that broke saves after
//   Draw's Duplicate and needed the 4.3.39-local.7 hotfix.

const el = (over: Record<string, unknown> = {}): SlideElement =>
  ({
    id: 'a', type: 'text', x: 10, y: 20, w: 100, h: 50, z: 1,
    fill: { type: 'solid', color: '#ffffff' },
    border: { color: '#000000', width: 1 },
    paragraphs: [{ runs: [{ text: 'hello', color: '#111111' }] }],
    ...over
  }) as unknown as SlideElement

const slide = (els: SlideElement[]): Slide =>
  ({ id: 's1', notes: '', elements: els }) as unknown as Slide

type Rec = Record<string, unknown>

describe('duplicateElement', () => {
  const run = (): { orig: Rec; copy: Rec } => {
    const { slide: next } = duplicateElement(slide([el()]), 'a')
    const [orig, copy] = next.elements as unknown as Rec[]
    return { orig, copy }
  }

  it('gives the copy a new id and offsets it', () => {
    const { orig, copy } = run()
    expect(copy.id).not.toBe(orig.id)
    expect(copy.x).toBe(30)
    expect(copy.y).toBe(40)
  })

  it('shares NOTHING with the original', () => {
    // The whole point. Each of these was shared before.
    const { orig, copy } = run()
    expect(copy.fill).not.toBe(orig.fill)
    expect(copy.border).not.toBe(orig.border)
    expect(copy.paragraphs).not.toBe(orig.paragraphs)
    expect((copy.paragraphs as Rec[])[0]).not.toBe((orig.paragraphs as Rec[])[0])
    expect(((copy.paragraphs as Rec[])[0].runs as Rec[])[0]).not.toBe(
      ((orig.paragraphs as Rec[])[0].runs as Rec[])[0]
    )
  })

  it('copies the values faithfully', () => {
    // Not sharing is only half of it; the duplicate has to look identical.
    const { orig, copy } = run()
    expect(copy.fill).toEqual(orig.fill)
    expect(copy.paragraphs).toEqual(orig.paragraphs)
  })

  it('leaves the original untouched when the copy is edited', () => {
    const { orig, copy } = run()
    ;(copy.fill as Rec).color = '#ff0000'
    expect((orig.fill as Rec).color).toBe('#ffffff')
  })

  it('produces a body with no object reachable twice', () => {
    // Stated as the invariant the IPC check actually enforces, rather than as
    // a list of fields someone has to remember to extend.
    const { slide: next } = duplicateElement(slide([el()]), 'a')
    const seen = new Set<unknown>()
    let duplicates = 0
    const walk = (v: unknown): void => {
      if (!v || typeof v !== 'object') return
      if (seen.has(v)) {
        duplicates++
        return
      }
      seen.add(v)
      for (const child of Object.values(v as Rec)) walk(child)
    }
    walk(next)
    expect(duplicates).toBe(0)
  })

  it('returns the slide unchanged when the id is not there', () => {
    const s = slide([el()])
    expect(duplicateElement(s, 'nope').slide).toBe(s)
  })
})
