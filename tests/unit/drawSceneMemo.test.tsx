// Rendering is memoised per object: an object that is the same object as last
// render does no work -- its path string is not even rebuilt. Measured by
// counting pathToSvgD calls while one shape out of many changes.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = { n: 0 }
vi.mock('../../src/shared/drawGeometry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/shared/drawGeometry')>()
  return {
    ...real,
    pathToSvgD: (p: Parameters<typeof real.pathToSvgD>[0]) => {
      calls.n += 1
      return real.pathToSvgD(p)
    }
  }
})
vi.mock('../../src/renderer/src/components/documents/embed/WidgetEmbed', () => ({ default: () => null }))

import { VectorLayerView } from '../../src/renderer/src/components/documents/draw/render/SceneView'
import type { DrawArtboard, DrawDocVectorLayer, DrawPathNode } from '../../src/shared/draw/model'

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

const board: DrawArtboard = { id: 'a', name: 'A', x: 0, y: 0, w: 1000, h: 1000, background: { type: 'none' } }
const sq = (id: string, x: number): DrawPathNode => ({
  id,
  type: 'path',
  path: { subpaths: [{ closed: true, nodes: [{ x, y: 0 }, { x: x + 5, y: 0 }, { x: x + 5, y: 5 }, { x, y: 5 }] }] },
  fill: { type: 'solid', color: '#000000' }
})

describe('memoised scene rendering', () => {
  it('moving one shape out of 200 rebuilds one path, not 200', async () => {
    const objects = Array.from({ length: 200 }, (_, i) => sq(`o${i}`, i * 5))
    const layer: DrawDocVectorLayer = { id: 'L', kind: 'vector', name: 'L', visible: true, locked: false, opacity: 1, blend: 'normal', objects }
    const render = async (l: DrawDocVectorLayer): Promise<void> => {
      await act(async () => {
        root.render(<VectorLayerView layer={l} board={board} stageW={1000} stageH={1000} assets={{}} swatches={[]} />)
      })
    }
    await render(layer)
    expect(calls.n).toBe(200)
    expect(host.querySelectorAll('path')).toHaveLength(200)

    calls.n = 0
    const moved = { ...layer, objects: layer.objects.map((o, i) => (i === 57 ? sq('o57', 9999) : o)) }
    await render(moved)
    expect(calls.n).toBe(1)
    expect(host.querySelectorAll('path')[57].getAttribute('d')).toContain('M 9999 0')

    // Re-rendering the SAME layer object does no node work at all -- even with a
    // new asset store and swatch list, which no plain shape reads.
    calls.n = 0
    await render(moved)
    expect(calls.n).toBe(0)
  })
})
