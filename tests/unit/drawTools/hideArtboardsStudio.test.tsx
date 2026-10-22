// The studio with View › Hide Artboards on (4.3.41): no page fill, edge or
// shadow, and no artboard pages, while the art is still drawn.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../../src/renderer/src/components/documents/editor/DrawStudioMenuBar', () => ({
  default: () => <div data-testid="menubar-stub" />
}))
vi.mock('../../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/src/components/documents/draw/raster')>()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../../src/renderer/src/components/documents/DrawStudio'
import { resetShellPrefs, shellPrefs } from '../../../src/renderer/src/components/documents/draw/editor/shellPrefs'
import { blank, rect } from './harness'

beforeEach(() => resetShellPrefs())
afterEach(() => resetShellPrefs())

describe('the studio with artboards hidden', () => {
  let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })
  afterEach(() => host.remove())

  async function mount(content: unknown): Promise<() => void> {
    ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
    const root = createRoot(host)
    await act(async () => root.render(<DrawStudio content={content} title="t" onChange={() => {}} />))
    return () => act(() => root.unmount())
  }

  it('one artboard: the page fill and shadow go, and come back', async () => {
    const off = await mount(blank([rect('a', 10, 10, 40, 40)]))
    const stage = () => host.querySelector('[data-testid="draw-stage"]') as HTMLElement
    expect(stage().style.background).not.toBe('transparent')
    expect(stage().className).toContain('shadow-lg')
    await act(async () => shellPrefs.setState({ hideArtboards: true }))
    expect(stage().style.background).toBe('transparent')
    expect(stage().className).not.toContain('shadow-lg')
    expect(stage().getAttribute('data-artboards-hidden')).toBe('1')
    await act(async () => shellPrefs.setState({ hideArtboards: false }))
    expect(stage().className).toContain('shadow-lg')
    off()
  })

  it('several artboards: the pages are not drawn while hidden; the art still is', async () => {
    const doc = {
      schemaVersion: 2,
      minWriterVersion: 2,
      artboards: [
        { id: 'artboard-1', name: 'Artboard 1', x: 0, y: 0, w: 200, h: 100, background: { type: 'solid', color: '#ffffff' } },
        { id: 'b2', name: 'Artboard 2', x: 300, y: 0, w: 200, h: 100, background: { type: 'solid', color: '#ffffff' } }
      ],
      layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects: [rect('a', 10, 10, 40, 40)] }],
      assets: {},
      swatches: [],
      guides: [],
      settings: {}
    }
    const off = await mount(doc)
    expect(host.querySelector('[data-testid="draw-artboards"]')).not.toBeNull()
    await act(async () => shellPrefs.setState({ hideArtboards: true }))
    expect(host.querySelector('[data-testid="draw-artboards"]')).toBeNull()
    expect(host.querySelectorAll('[data-testid="draw-vector-L1"] path').length).toBe(1)
    off()
  })
})
