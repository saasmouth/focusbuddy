// The studio itself, mounted: the forward-compat read-only mode, and the two
// audit bugs that only show on screen (miter limit; rotated hit-testing).
// Driven through the DOM -- pointer events and keys -- so each assertion is
// about what a person would see, and each one failed before its fix.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/components/documents/editor/DrawStudioMenuBar', () => ({
  default: () => <div data-testid="menubar-stub" />
}))
vi.mock('../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/src/components/documents/draw/raster')>()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../src/renderer/src/components/documents/DrawStudio'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  // happy-dom has no pointer capture; the studio only needs the call to exist.
  ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function rect(id: string, x: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    type: 'path',
    path: { subpaths: [{ closed: true, nodes: [{ x, y: 10 }, { x: x + 40, y: 10 }, { x: x + 40, y: 50 }, { x, y: 50 }] }] },
    fill: { type: 'solid', color: '#ff0000' },
    ...extra
  }
}

function body(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width: 400,
    height: 300,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }],
    ...extra
  }
}

async function mount(content: unknown, onChange: (b: unknown) => void = () => {}): Promise<void> {
  await act(async () => {
    root.render(<DrawStudio content={content} title="t" onChange={onChange} />)
  })
}

/** The stage maps client px to artboard px by its zoom; happy-dom lays out nothing, so the fitted zoom is the floor. */
function zoom(): number {
  const label = host.querySelector('[data-testid="draw-zoom"]')?.textContent ?? '100%'
  return parseInt(label, 10) / 100
}

async function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number, init: PointerEventInit = {}): Promise<void> {
  const stage = host.querySelector('[data-testid="draw-stage"]') as HTMLElement
  const z = zoom()
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x * z, clientY: y * z, button: 0, pointerId: 1, ...init }))
  })
}

async function click(x: number, y: number): Promise<void> {
  await pointer('pointerdown', x, y)
  await pointer('pointerup', x, y)
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
  })
}

describe('read-only mode for a drawing made by a newer PlexiiDraw', () => {
  // This build reads and writes schema 2 (the v2 model), so "newer" is schema
  // 3 -- here holding an object kind no build knows yet.
  const newer = (): Record<string, unknown> =>
    body([rect('a', 10), { id: 'g', type: 'hologram', children: [rect('inner', 200)] }], { schemaVersion: 3, minWriterVersion: 3 })

  it('shows the banner, says what is kept, and never calls onChange whatever you do', async () => {
    const onChange = vi.fn()
    await mount(newer(), onChange)
    const banner = host.querySelector('[data-testid="draw-readonly-banner"]')
    expect(banner?.textContent).toContain('Made in a newer PlexiiDraw — update to edit')
    expect(banner?.textContent).toContain('1 object (hologram)')
    expect(banner?.textContent).toContain('newer file format (version 3)')

    // Select everything and try every edit the keyboard offers.
    await key('a', { metaKey: true })
    for (const k of ['Delete', 'Backspace', 'ArrowRight', 'ArrowDown']) await key(k)
    await key('d', { metaKey: true })
    await key('z', { metaKey: true })
    // Try to drag the shape and to draw with a shape tool.
    await pointer('pointerdown', 20, 20)
    await pointer('pointermove', 120, 120)
    await pointer('pointerup', 120, 120)
    await key('r')
    await pointer('pointerdown', 250, 200)
    await pointer('pointermove', 300, 260)
    await pointer('pointerup', 300, 260)

    expect(onChange).not.toHaveBeenCalled()
    // Nothing moved on screen either, and nothing new appeared.
    expect(host.querySelectorAll('[data-testid^="draw-vector-"] path')).toHaveLength(1)
  })

  it('turns off the editing tools and every inspector control', async () => {
    await mount(newer())
    expect((host.querySelector('[data-testid="draw-tool-pen"]') as HTMLButtonElement).disabled).toBe(true)
    expect((host.querySelector('[data-testid="draw-tool-select"]') as HTMLButtonElement).disabled).toBe(false)
    expect((host.querySelector('[data-testid="draw-tool-hand"]') as HTMLButtonElement).disabled).toBe(false)
    const fieldset = host.querySelector('fieldset')
    expect(fieldset?.disabled).toBe(true)
    expect(fieldset?.querySelector('[data-testid="draw-inspector"]')).not.toBeNull()
  })

  it('an unknown object in a v1-numbered body is also read-only', async () => {
    await mount(body([rect('a', 10), { id: 's', type: 'symbol', symbolId: 'x' }]))
    expect(host.querySelector('[data-testid="draw-readonly-banner"]')?.textContent).toContain('symbol')
  })

  it('an ordinary drawing shows no banner and saves edits', async () => {
    const onChange = vi.fn()
    await mount(body([rect('a', 10)]), onChange)
    expect(host.querySelector('[data-testid="draw-readonly-banner"]')).toBeNull()
    await key('a', { metaKey: true })
    await key('ArrowRight')
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('bug 3 — the miter limit is drawn on screen as it is exported', () => {
  it('a path carries stroke-miterlimit; a stroked text carries its caps, joins and dashes', async () => {
    await mount(
      body([
        rect('m', 10, { stroke: { paint: { type: 'solid', color: '#000000' }, width: 8, join: 'miter', miterLimit: 1.5 } }),
        {
          id: 't',
          type: 'text',
          x: 10,
          y: 100,
          w: 200,
          text: 'Hi',
          fontSize: 30,
          fill: { type: 'solid', color: '#000000' },
          stroke: { paint: { type: 'solid', color: '#ff0000' }, width: 2, cap: 'round', join: 'bevel', dash: [4, 2], miterLimit: 3 }
        }
      ])
    )
    const path = host.querySelector('[data-testid^="draw-vector-"] path')
    expect(path?.getAttribute('stroke-miterlimit')).toBe('1.5')
    const text = host.querySelector('[data-testid^="draw-vector-"] text')
    expect(text?.getAttribute('stroke-linecap')).toBe('round')
    expect(text?.getAttribute('stroke-linejoin')).toBe('bevel')
    expect(text?.getAttribute('stroke-dasharray')).toBe('4 2')
    expect(text?.getAttribute('stroke-miterlimit')).toBe('3')
  })
})

describe('bug 6 — a rotated image is selected where it is drawn', () => {
  // A 200 x 100 image at (100, 100) turned a quarter: it is drawn over
  // x 150..250, y 50..250. Its unrotated frame was x 100..300, y 100..200.
  const turned = (): Record<string, unknown> => body([{ id: 'img', type: 'image', x: 100, y: 100, w: 200, h: 100, src: PNG, rotation: 90 }])

  it('a click on the part that sticks out above the old frame selects it', async () => {
    await mount(turned())
    await click(200, 60)
    expect(host.querySelector('[data-testid="draw-selection"]')).not.toBeNull()
  })

  it('a click in the empty corner of the old frame does not', async () => {
    await mount(turned())
    await click(110, 110)
    expect(host.querySelector('[data-testid="draw-selection"]')).toBeNull()
  })
})
