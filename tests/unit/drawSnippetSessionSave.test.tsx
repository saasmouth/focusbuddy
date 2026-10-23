// PlexiiDraw in a saved snippet's edit session ("Open original";
// components/snippets/SnippetEditSessionView.tsx). The host writes the snippet
// master only on Save. DrawStudio never saves: it emits onChange per edit and,
// given `onSaveRequest`, hands File › Save and ⌘S to the host.
//
// Driven through the mounted studio -- pointer events on the stage, keys on the
// window, the text box and the Fill popover -- with a host stub holding spies,
// and every window.api call recorded, so "nothing was written" is checked
// against everything the studio could reach, not one method.

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
import { commandById } from '../../src/renderer/src/components/documents/draw/commands/registry'
import { blank, harness, rect as hRect } from './drawTools/harness'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
/** Every window.api call the studio makes, as 'area.method'. */
let apiCalls: string[]
let savedApi: unknown

/** window.api where every method, at any depth, records its call and resolves to nothing. */
function recordingApi(path: string[] = []): unknown {
  const fn = (...args: unknown[]): Promise<undefined> => {
    void args
    apiCalls.push(path.join('.'))
    return Promise.resolve(undefined)
  }
  return new Proxy(fn, {
    get: (_t, prop) => (typeof prop === 'string' && prop !== 'then' ? recordingApi([...path, prop]) : undefined)
  })
}

beforeEach(() => {
  ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
  apiCalls = []
  savedApi = (window as unknown as { api?: unknown }).api
  ;(window as unknown as { api: unknown }).api = recordingApi()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  ;(window as unknown as { api: unknown }).api = savedApi
})

function body(objects: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    width: 400,
    height: 300,
    background: { type: 'solid', color: '#ffffff' },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', kind: 'vector', name: 'Layer 1', visible: true, locked: false, opacity: 1, blend: 'normal', objects }]
  }
}

/**
 * The host stub: what SnippetEditSessionView's Draw entry does with the studio.
 * It buffers the latest body and saves only when asked -- here, spies.
 */
async function mountSession(onChange: (b: unknown) => void, onSaveRequest?: () => void): Promise<void> {
  await act(async () => {
    root.render(<DrawStudio content={body([])} title="Saved snippet" onChange={onChange} onSaveRequest={onSaveRequest} />)
  })
}

function zoom(): number {
  const label = host.querySelector('[data-testid="draw-zoom"]')?.textContent ?? '100%'
  return parseInt(label, 10) / 100
}

async function pointer(type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number): Promise<void> {
  const stage = host.querySelector('[data-testid="draw-stage"]') as HTMLElement
  const z = zoom()
  await act(async () => {
    stage.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x * z, clientY: y * z, button: 0, pointerId: 1 }))
  })
}

async function drag(from: [number, number], to: [number, number]): Promise<void> {
  await pointer('pointerdown', ...from)
  await pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2)
  await pointer('pointermove', ...to)
  await pointer('pointerup', ...to)
}

/** A key on the window (the canvas), as the studio's one listener hears it. Returns the event. */
async function key(k: string, init: KeyboardEventInit = {}, target: EventTarget = window): Promise<KeyboardEvent> {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    target.dispatchEvent(e)
  })
  return e
}

/** ⌘S as a Mac sends it: the physical S key. */
const cmdS = { metaKey: true, code: 'KeyS' }

async function click(el: Element | null): Promise<void> {
  expect(el).not.toBeNull()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

/** Type into the canvas text box the way React hears it (value setter + input event). */
async function typeInto(el: HTMLTextAreaElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The last body the host was handed, as its vector objects. */
function lastObjects(onChange: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  const b = onChange.mock.calls.at(-1)![0] as { layers: Array<{ kind: string; objects?: Array<Record<string, unknown>> }> }
  return b.layers.filter((l) => l.kind === 'vector').flatMap((l) => l.objects ?? [])
}

/** The middle of a path object's anchors, in document px. */
function centre(o: Record<string, unknown>): [number, number] {
  const nodes = (o.path as { subpaths: Array<{ nodes: Array<{ x: number; y: number }> }> }).subpaths.flatMap((p) => p.nodes)
  const xs = nodes.map((n) => n.x)
  const ys = nodes.map((n) => n.y)
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
}

describe('a snippet edit session: the studio emits, the host saves', () => {
  it('every edit reaches onChange; nothing saves or writes; ⌘S asks the host once', async () => {
    const onChange = vi.fn()
    const onSaveRequest = vi.fn()
    await mountSession(onChange, onSaveRequest)
    // 100% (⌘1): happy-dom lays nothing out, so the fitted zoom is the 5% floor,
    // where the hit tolerance is wider than the shapes.
    await key('1', { metaKey: true, code: 'Digit1' })
    expect(zoom()).toBe(1)
    expect(onChange).not.toHaveBeenCalled()

    // 1. Draw a shape (Rectangle, Illustrator's M).
    await key('m')
    await drag([40, 40], [140, 120])
    expect(onChange.mock.calls.length).toBeGreaterThan(0)
    const shapes = lastObjects(onChange)
    expect(shapes).toHaveLength(1)
    const shapeId = shapes[0].id as string
    const afterDraw = onChange.mock.calls.length

    // 2. Drag it by its middle with the Selection tool (V).
    const c0 = centre(shapes[0])
    await key('v')
    await drag(c0, [c0[0] + 60, c0[1] + 40])
    expect(onChange.mock.calls.length).toBeGreaterThan(afterDraw)
    const moved = lastObjects(onChange).find((o) => o.id === shapeId)!
    // Moved with the pointer (to within snapping).
    expect(centre(moved)[0] - c0[0]).toBeGreaterThan(40)
    expect(centre(moved)[1] - c0[1]).toBeGreaterThan(25)
    const afterDrag = onChange.mock.calls.length

    // 3. Add a text object (T) and type into it.
    await key('t')
    await pointer('pointerdown', 60, 220)
    await pointer('pointerup', 60, 220)
    expect(onChange.mock.calls.length).toBeGreaterThan(afterDrag)
    const box = host.querySelector('[data-testid="draw-text-editor"]') as HTMLTextAreaElement
    expect(box).not.toBeNull()
    const afterAdd = onChange.mock.calls.length
    await typeInto(box, 'Hello snippet')
    expect(onChange.mock.calls.length).toBeGreaterThan(afterAdd)
    expect(lastObjects(onChange).some((o) => o.type === 'text' && o.text === 'Hello snippet')).toBe(true)
    await key('Escape', {}, box) // leave the text box
    const afterType = onChange.mock.calls.length

    // 4. Change a fill: select the rectangle, then Fill › None in the top bar.
    const c1 = centre(moved)
    await key('v')
    await pointer('pointerdown', ...c1)
    await pointer('pointerup', ...c1)
    // The rectangle, not the text, is selected: its contextual tab is Path.
    expect(host.querySelector('[data-testid="draw-bar-tab-path"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="draw-bar-tab-type"]')).toBeNull()
    // Selecting a shape brings its contextual tab forward; Fill is on Home.
    await click(host.querySelector('[data-testid="draw-bar-tab-home"]'))
    await click(host.querySelector('[data-testid="draw-fill"]'))
    // The popover is portalled out of the studio.
    await click(document.querySelector('[data-testid="draw-fill-kind-none"]'))
    expect(onChange.mock.calls.length).toBeGreaterThan(afterType)
    expect(lastObjects(onChange).find((o) => o.id === shapeId)?.fill).toEqual({ type: 'none' })

    // None of that saved or wrote anything.
    expect(onSaveRequest).not.toHaveBeenCalled()
    expect(apiCalls.filter((c) => /snippets|documents|draw\.|save|update|write|create|put/i.test(c))).toEqual([])

    // ⌘S is the host's Save, once, and the browser's default is prevented.
    const before = onChange.mock.calls.length
    const e = await key('s', cmdS)
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    // Asking to save is not an edit.
    expect(onChange.mock.calls.length).toBe(before)
    expect(apiCalls.filter((c) => /snippets|documents|draw\.|save|update|write|create|put/i.test(c))).toEqual([])
  })

  it('⌘S matches the physical key, on any layout, through the one chord parser', async () => {
    const onSaveRequest = vi.fn()
    await mountSession(vi.fn(), onSaveRequest)
    // A layout whose S key types another character still reports code KeyS.
    await key('ß', { metaKey: true, code: 'KeyS' })
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
    // Ctrl is the modifier on Windows.
    await key('s', { ctrlKey: true, code: 'KeyS' })
    expect(onSaveRequest).toHaveBeenCalledTimes(2)
    // ⇧⌘S (Illustrator's Save As, which a session does not have) is not bound,
    // so the keymap's Shift fallback makes it Save, as ⇧A still picks A's tool.
    const e = await key('S', { metaKey: true, shiftKey: true, code: 'KeyS' })
    expect(onSaveRequest).toHaveBeenCalledTimes(3)
    expect(e.defaultPrevented).toBe(true)
  })

  it('⌘S while typing in the canvas text box saves too, with the text already handed over', async () => {
    const onChange = vi.fn()
    const onSaveRequest = vi.fn(() => {
      // The host saves its latest buffered body: it must already hold the typing.
      expect(lastObjects(onChange).some((o) => o.type === 'text' && o.text === 'mid-sentence')).toBe(true)
    })
    await mountSession(onChange, onSaveRequest)
    await key('t')
    await pointer('pointerdown', 60, 60)
    await pointer('pointerup', 60, 60)
    const box = host.querySelector('[data-testid="draw-text-editor"]') as HTMLTextAreaElement
    await typeInto(box, 'mid-sentence')
    const e = await key('s', cmdS, box)
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
    expect(e.defaultPrevented).toBe(true)
    // Still typing: the box stays open.
    expect(host.querySelector('[data-testid="draw-text-editor"]')).not.toBeNull()
    // A plain s typed in the box is text, not a save.
    await key('s', { code: 'KeyS' }, box)
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
  })
})

describe('outside a session (no onSaveRequest): ⌘S behaves as it always has', () => {
  it('is not claimed and changes nothing', async () => {
    const onChange = vi.fn()
    await mountSession(onChange)
    const e = await key('s', cmdS)
    expect(e.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
    expect(apiCalls).toEqual([])
  })

  it('does not fall through to the S key either (no tool switch)', async () => {
    await mountSession(vi.fn())
    await key('v')
    await key('s', cmdS)
    expect(host.querySelector('[data-testid="draw-tool-select"]')?.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('the Save command (file.save)', () => {
  const save = (): NonNullable<ReturnType<typeof commandById>> => commandById('file.save')!

  it('is registered as File › Save on ⌘S', () => {
    expect(save()).toMatchObject({ label: 'Save', menu: { path: 'file' } })
  })

  it('is enabled only where the host saves on request, and says why otherwise', () => {
    const h = harness(blank([hRect('a', 0, 0, 10, 10)]))
    expect(save().enabled!(h.ed.ctx)).toBe(false)
    expect(save().disabledReason!(h.ed.ctx)).toBe('drawings save as you work')
    expect(save().keyWhen!(h.ed.ctx)).toBe(false)

    const request = vi.fn()
    h.ed.ctx.host.saveRequest = () => request
    expect(save().enabled!(h.ed.ctx)).toBe(true)
    expect(save().disabledReason!(h.ed.ctx)).toBeNull()
    h.ed.ctx.run('file.save')
    expect(request).toHaveBeenCalledTimes(1)
    // Saving is not an edit: no undo step, nothing emitted.
    expect(h.state().past).toHaveLength(0)
    expect(h.emitted).toHaveLength(0)
  })

  it('is disabled on a read-only drawing, and ⌘S then does not ask the host', () => {
    const h = harness(blank([hRect('a', 0, 0, 10, 10)]))
    const request = vi.fn()
    h.ed.ctx.host.saveRequest = () => request
    h.ed.store.setState({ readOnly: true })
    expect(save().enabled!(h.ed.ctx)).toBe(false)
    expect(save().disabledReason!(h.ed.ctx)).toBe('this drawing is read-only')
    h.key('s', { meta: true })
    h.ed.ctx.run('file.save')
    expect(request).not.toHaveBeenCalled()
  })
})
