// Slide list markers follow the text they mark (4.3.50).
//
// A bullet or number drawn beside a paragraph had no font size of its own, so
// it took the text box's default (16 px) while the runs beside it carried the
// theme's body size (a 28 px bullet list showed 16 px dots). Seen capturing
// 4.3.48 screens on 2026-11-17. The marker now takes the paragraph's text size:
// the largest run's, as the line height is.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SlideElementView from '../../src/renderer/src/components/documents/slides/SlideElementView'
import type { SlideTextElement } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function list(listStyle: 'bullet' | 'number', sizes: (number | undefined)[]): SlideTextElement {
  return {
    id: 't1', type: 'text', x: 0, y: 0, w: 600, h: 400, z: 1,
    paragraphs: sizes.map((fontSize, i) => ({
      runs: [{ text: `Point ${i + 1}`, fontSize }, { text: ' more', fontSize: fontSize ? fontSize - 10 : undefined }],
      listStyle
    }))
  }
}

function markers(text: RegExp): HTMLSpanElement[] {
  return [...host.querySelectorAll('span')].filter((s) => text.test(s.textContent ?? '') && s.children.length === 0) as HTMLSpanElement[]
}

describe('slide list markers', () => {
  it('a bullet is drawn at its paragraph’s text size, not the box default', () => {
    act(() => root.render(<SlideElementView el={list('bullet', [28, 40])} />))
    const dots = markers(/^•$/)
    expect(dots).toHaveLength(2)
    expect(dots.map((d) => d.style.fontSize)).toEqual(['28px', '40px'])
  })

  it('a number is drawn at its paragraph’s text size', () => {
    act(() => root.render(<SlideElementView el={list('number', [24, 32])} />))
    const nums = markers(/^\d+\.$/)
    expect(nums.map((n) => [n.textContent, n.style.fontSize])).toEqual([['1.', '24px'], ['2.', '32px']])
  })

  it('a paragraph whose runs give no size leaves the marker on the box default', () => {
    act(() => root.render(<SlideElementView el={list('bullet', [undefined])} />))
    const [dot] = markers(/^•$/)
    expect(dot.style.fontSize).toBe('')
  })
})
