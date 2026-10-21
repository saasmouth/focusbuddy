// WP-OBJ on screen: a clipping group draws the same parts the exporter writes
// (clip path, fill under, contents clipped, stroke over); isolation mode shows
// its bar and its veil, and the bar's crumbs really leave the levels.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/documents/embed/WidgetEmbed', () => ({ default: () => null }))

import { NodeView } from '../../src/renderer/src/components/documents/draw/render/SceneView'
import IsolationBar from '../../src/renderer/src/components/documents/draw/render/IsolationBar'
import Overlay from '../../src/renderer/src/components/documents/draw/render/Overlay'
import type { DrawGroupNode } from '../../src/shared/draw/model'
import { harness, rect } from './drawTools/harness'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const sqPath = (x: number, y: number, w: number, h: number) => ({ subpaths: [{ closed: true, nodes: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }] })

function v2(objects: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [{ id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } }],
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    activeLayerId: 'L1',
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  }
}

describe('a clipping group on screen', () => {
  it('unpainted clip path: one clipped <g>, the clip path only inside <clipPath>', () => {
    const g: DrawGroupNode = {
      id: 'g',
      type: 'group',
      clip: true,
      children: [
        { id: 'art', type: 'path', path: sqPath(0, 0, 100, 100), fill: { type: 'solid', color: '#00ff00' } },
        { id: 'mask', type: 'path', path: sqPath(25, 25, 50, 50), fill: { type: 'none' } }
      ]
    }
    act(() => root.render(<svg><NodeView o={g} assets={{}} swatches={[]} /></svg>))
    const svg = host.querySelector('svg')!
    expect(svg.querySelector('clipPath#clip-g path')!.getAttribute('d')).toBe('M 25 25 L 75 25 L 75 75 L 25 75 Z')
    expect(svg.querySelectorAll('g[clip-path="url(#clip-g)"] path')).toHaveLength(1)
    expect(svg.querySelectorAll('path')).toHaveLength(2)
  })

  it('a painted clip path: its fill under the contents, its stroke over them outside the clip', () => {
    const g: DrawGroupNode = {
      id: 'g',
      type: 'group',
      clip: true,
      children: [
        { id: 'art', type: 'path', path: sqPath(0, 0, 100, 100), fill: { type: 'solid', color: '#00ff00' } },
        { id: 'mask', type: 'path', path: sqPath(25, 25, 50, 50), fill: { type: 'solid', color: '#0000ff' }, stroke: { paint: { type: 'solid', color: '#ff00ff' }, width: 3 } }
      ]
    }
    act(() => root.render(<svg><NodeView o={g} assets={{}} swatches={[]} /></svg>))
    const clipped = host.querySelector('g[clip-path="url(#clip-g)"]')!
    const inside = [...clipped.querySelectorAll('path')].map((p) => p.getAttribute('fill'))
    expect(inside).toEqual(['#0000ff', '#00ff00'])
    const over = clipped.nextElementSibling!
    expect(over.getAttribute('stroke')).toBe('#ff00ff')
    expect(over.getAttribute('fill')).toBe('none')
  })
})

describe('isolation mode on screen', () => {
  it('shows a bar with the path, a veil with the isolated art drawn on top, and the crumbs leave', () => {
    const h = harness(
      v2([
        { id: 'g', type: 'group', name: 'Badge', children: [rect('a', 10, 10, 20, 20), { id: 'in', type: 'group', children: [rect('b', 50, 10, 20, 20)] }] }
      ])
    )
    h.ed.doubleClick({ x: 20, y: 20 })
    h.ed.doubleClick({ x: 60, y: 20 })
    expect(h.state().isolation).toEqual(['g', 'in'])
    act(() => root.render(<IsolationBar ctx={h.ed.ctx} />))
    const bar = host.querySelector('[data-testid="draw-isolation-bar"]')!
    expect(bar.textContent).toContain('Layer 1')
    expect(bar.textContent).toContain('Badge')
    expect(bar.textContent).toContain('<Group>')
    act(() => (host.querySelector('[data-testid="draw-isolation-crumb-0"]') as HTMLButtonElement).click())
    expect(h.state().isolation).toEqual(['g'])
    act(() => (host.querySelector('[data-testid="draw-isolation-exit"]') as HTMLButtonElement).click())
    expect(h.state().isolation).toEqual([])
    expect(host.querySelector('[data-testid="draw-isolation-bar"]')).toBeNull()

    h.ed.doubleClick({ x: 20, y: 20 })
    const s = h.state()
    act(() => root.render(<Overlay state={s} board={s.doc.artboards[0]} stageW={400} stageH={300} />))
    const veil = host.querySelector('[data-testid="draw-isolation-veil"]')!
    expect(veil).not.toBeNull()
    // The veil, then the isolated group's two shapes redrawn above it.
    expect(veil.querySelectorAll('path')).toHaveLength(2)
  })
})
