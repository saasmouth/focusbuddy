// A saved Draw snippet opened as a drawing and written back
// (src/shared/draw/snippetBody.ts), for "Open original" edit sessions.
//
// The snippets here are made by Draw's own capture (drawBodyFromSelection, the
// "Save selection as snippet…" path), so the inverse is checked against the
// real format, not a hand-written idea of it. The round trip goes through the
// real DrawStudio (mounted, with its host stub) and the real headless editor.

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: () => null
}))
vi.mock('../../src/renderer/src/components/documents/editor/DrawStudioMenuBar', () => ({
  default: () => null
}))
vi.mock('../../src/renderer/src/lib/googleFonts', () => ({
  loadGoogleFont: vi.fn(),
  familyLabel: (v: string | undefined) => v ?? 'Default',
  fontFamilyValue: (v: string) => v,
  GOOGLE_FONTS: []
}))
vi.mock('../../src/renderer/src/components/documents/draw/raster', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../../src/renderer/src/components/documents/draw/raster')
  >()),
  loadIntoCanvas: vi.fn(async () => {})
}))

import DrawStudio from '../../src/renderer/src/components/documents/DrawStudio'
import type { DrawSnippetBody } from '../../src/shared/snippets'
import { assetIdFor } from '../../src/shared/draw/assets'
import { drawDocCompatibility } from '../../src/shared/draw/compat'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import type {
  DrawDoc,
  DrawDocVectorLayer,
  DrawImageNode,
  DrawNode,
  DrawPathNode
} from '../../src/shared/draw/model'
import { mapObjects, nodesBounds } from '../../src/shared/draw/ops'
import {
  SNIPPET_ARTBOARD_MARGIN,
  SNIPPET_EMPTY_ARTBOARD,
  drawBodyFromSnippet,
  snippetArtboardBox,
  snippetFromDrawBody
} from '../../src/shared/draw/snippetBody'
import { drawBodyFromSelection } from '../../src/renderer/src/components/documents/draw/editor/drawSnippets'
import { harness, rect } from './drawTools/harness'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_ID = assetIdFor(PNG)
const PNG2 = PNG.replace('AAAAAE', 'AAAAAF')
const PNG2_ID = assetIdFor(PNG2)

function v2(objects: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      {
        id: 'ab1',
        name: 'Artboard 1',
        x: 0,
        y: 0,
        w: 400,
        h: 300,
        background: { type: 'solid', color: '#ffffff' }
      }
    ],
    activeLayerId: 'L1',
    layers: [
      {
        id: 'L1',
        kind: 'vector',
        name: 'Layer 1',
        visible: true,
        locked: false,
        opacity: 1,
        blend: 'normal',
        objects
      }
    ],
    assets: {},
    swatches: [],
    guides: [],
    settings: {},
    ...extra
  }
}

function ring(id: string, x: number, y: number): Record<string, unknown> {
  const sq = (a: number, b: number, s: number) => ({
    closed: true,
    nodes: [
      { x: a, y: b },
      { x: a + s, y: b },
      { x: a + s, y: b + s },
      { x: a, y: b + s }
    ]
  })
  return {
    id,
    type: 'path',
    path: { subpaths: [sq(x, y, 40), sq(x + 10.3, y + 10.7, 20.1)], fillRule: 'evenodd' },
    fill: { type: 'solid', color: '#123456' }
  }
}

/**
 * A drawing holding everything a snippet must carry: a group with a
 * swatch-painted, stroked rect and an image (an asset reference), a clipping
 * group, a compound path with fractional coordinates, a ROTATED text object
 * (its bounds come from trigonometry), and an unused swatch and asset.
 */
function richDoc(): Record<string, unknown> {
  const img = { id: 'img', type: 'image', x: 150, y: 60, w: 20, h: 10, assetId: PNG_ID }
  const group = {
    id: 'g',
    type: 'group',
    name: 'Logo lockup',
    children: [
      rect('gr', 100, 50, 30, 30, {
        fill: { type: 'swatch', id: 'sw1' },
        stroke: { paint: { type: 'swatch', id: 'sw1', tint: 0.5 }, width: 6 }
      }),
      img
    ]
  }
  const clip = {
    id: 'clip',
    type: 'group',
    clip: true,
    children: [
      rect('inside', 200, 100, 80, 80, { fill: { type: 'solid', color: '#ff00ff' } }),
      rect('mask', 210, 110, 40, 40)
    ]
  }
  const text = {
    id: 't',
    type: 'text',
    x: 120.25,
    y: 200.5,
    w: 120,
    rotation: 17,
    text: 'Hello snippet',
    fontSize: 18,
    fill: { type: 'solid', color: '#000000' }
  }
  return v2([group, clip, ring('ring', 300, 20), text], {
    assets: {
      [PNG_ID]: { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 },
      [PNG2_ID]: { mime: 'image/png', dataUrl: PNG2, w: 1, h: 1 }
    },
    swatches: [
      { id: 'sw1', name: 'Brand', color: '#ff0000', global: true },
      { id: 'unused', name: 'Unused', color: '#00ff00' }
    ]
  })
}

/** The snippet "Save selection as snippet…" writes for the rich drawing. */
function captured(): DrawSnippetBody {
  const body = drawBodyFromSelection(normalizeDrawDoc(richDoc()), ['g', 'clip', 'ring', 't'])
  expect(body).not.toBeNull()
  return body!
}

const objectsOf = (d: DrawDoc): DrawNode[] =>
  (d.layers.find((l) => l.kind === 'vector') as DrawDocVectorLayer).objects
/** Every node in a list, group members included, in tree order. */
function allNodes(nodes: unknown[]): DrawNode[] {
  return (nodes as DrawNode[]).flatMap((n) => [
    n,
    ...(n.type === 'group' ? allNodes(n.children) : [])
  ])
}
const byId = (nodes: unknown[], id: string): DrawNode => allNodes(nodes).find((n) => n.id === id)!

/** Every object reachable from a value. */
function reachable(v: unknown, out: Set<object> = new Set()): Set<object> {
  if (!v || typeof v !== 'object' || out.has(v)) return out
  out.add(v)
  for (const x of Object.values(v)) reachable(x, out)
  return out
}

function sharesNothing(a: unknown, b: unknown): boolean {
  const ra = reachable(a)
  for (const o of reachable(b)) if (ra.has(o)) return false
  return true
}

// ── Snippet -> drawing ───────────────────────────────────────────────────────

describe('drawBodyFromSnippet', () => {
  it('opens the snippet as one vector layer, objects exactly where the snippet puts them', () => {
    const snip = captured()
    const doc = drawBodyFromSnippet(snip)
    expect(doc.schemaVersion).toBe(2)
    expect(doc.layers).toHaveLength(1)
    expect(doc.layers[0].kind).toBe('vector')
    expect(doc.activeLayerId).toBe(doc.layers[0].id)
    // Ids and coordinates untouched, every kind intact (group, clip, compound, rotated text, image).
    expect(objectsOf(doc)).toEqual(snip.objects)
    expect((byId(objectsOf(doc), 'clip') as { clip?: boolean }).clip).toBe(true)
    expect(byId(objectsOf(doc), 'img')).toMatchObject({ type: 'image', assetId: PNG_ID })
    // The asset store and swatches are the snippet's.
    expect(doc.assets).toEqual(snip.assets)
    expect(doc.swatches).toEqual(snip.swatches)
  })

  it('sizes one transparent artboard to the visible bounds plus the margin', () => {
    const snip = captured()
    const doc = drawBodyFromSnippet(snip)
    const b = nodesBounds(snip.objects as DrawNode[])
    // Capture puts the art's top-left at the origin.
    expect(b.x).toBeCloseTo(0, 9)
    expect(b.y).toBeCloseTo(0, 9)
    // Half the widest stroke (6) is 3; then the margin.
    const pad = 3 + SNIPPET_ARTBOARD_MARGIN
    expect(doc.artboards).toEqual([
      {
        id: doc.activeArtboardId,
        name: 'Snippet',
        x: Math.floor(b.x) - pad,
        y: Math.floor(b.y) - pad,
        w: Math.ceil(b.x + b.w) + pad - (Math.floor(b.x) - pad),
        h: Math.ceil(b.y + b.h) + pad - (Math.floor(b.y) - pad),
        background: { type: 'none' }
      }
    ])
    // The art sits inside the artboard, the margin clear on every side.
    const a = doc.artboards[0]
    expect(b.x - a.x).toBeGreaterThanOrEqual(pad)
    expect(b.y - a.y).toBeGreaterThanOrEqual(pad)
    expect(a.x + a.w - (b.x + b.w)).toBeGreaterThanOrEqual(pad)
    expect(a.y + a.h - (b.y + b.h)).toBeGreaterThanOrEqual(pad)
    expect(
      Number.isInteger(a.x) &&
        Number.isInteger(a.y) &&
        Number.isInteger(a.w) &&
        Number.isInteger(a.h)
    ).toBe(true)
  })

  it('an empty snippet opens on the empty-snippet artboard at the origin', () => {
    const doc = drawBodyFromSnippet({ kind: 'draw', objects: [] })
    expect(objectsOf(doc)).toEqual([])
    expect(doc.artboards[0]).toMatchObject({
      x: 0,
      y: 0,
      w: SNIPPET_EMPTY_ARTBOARD.w,
      h: SNIPPET_EMPTY_ARTBOARD.h
    })
    expect(snippetArtboardBox([])).toEqual({
      x: 0,
      y: 0,
      w: SNIPPET_EMPTY_ARTBOARD.w,
      h: SNIPPET_EMPTY_ARTBOARD.h
    })
  })

  it("passes Draw's own normalize unchanged, and opens writable", () => {
    const doc = drawBodyFromSnippet(captured())
    expect(normalizeDrawDoc(doc)).toEqual(doc)
    expect(drawDocCompatibility(doc).readOnly).toBe(false)
  })

  it("shares no object with the snippet: not even fields Draw doesn't know, or a newer PlexiiDraw's objects", () => {
    // normalize keeps unknown fields and unknown node types verbatim, by
    // reference: without a copy first, the drawing would hold the snippet's own objects.
    const snip: DrawSnippetBody = {
      kind: 'draw',
      objects: [
        rect('r', 0, 0, 10, 10, { future: { deep: [1, 2] } }),
        { id: 'h', type: 'hologram', beams: [{ n: 1 }] }
      ],
      assets: {},
      swatches: []
    }
    const doc = drawBodyFromSnippet(snip)
    expect(sharesNothing(doc, snip)).toBe(true)
    const back = snippetFromDrawBody(doc, snip).body
    expect(back.objects).toEqual(snip.objects)
    expect(sharesNothing(back, doc)).toBe(true)
    expect(sharesNothing(back, snip)).toBe(true)
  })

  it('shares no object with the snippet, either way', () => {
    const snip = captured()
    const before = structuredClone(snip)
    const doc = drawBodyFromSnippet(snip)
    expect(sharesNothing(doc, snip)).toBe(true)
    // Editing the drawing in place never reaches the snippet ...
    ;(objectsOf(doc)[0] as { name?: string }).name = 'changed'
    ;(doc.assets[PNG_ID] as { dataUrl: string }).dataUrl = 'data:,'
    doc.swatches[0].color = '#000000'
    expect(snip).toEqual(before)
    // ... nor the snippet the drawing.
    const doc2 = drawBodyFromSnippet(snip)
    ;(snip.objects[0] as { name?: string }).name = 'also changed'
    expect((objectsOf(doc2)[0] as { name?: string }).name).toBe('Logo lockup')
  })
})

// ── Round trips ──────────────────────────────────────────────────────────────

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

describe('snippet -> drawing -> real DrawStudio -> snippet', () => {
  beforeEach(() => {
    ;(HTMLElement.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture =
      () => {}
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('with no edits, gives back the same snippet and loses nothing', async () => {
    const snip = { ...captured(), note: 'kept by the editor' } as DrawSnippetBody
    const onChange = vi.fn()
    await act(async () => {
      root.render(
        createElement(DrawStudio, {
          content: drawBodyFromSnippet(snip),
          title: 'Snippet',
          onChange,
          onSaveRequest: vi.fn(),
          session: { kind: 'snippet' }
        })
      )
    })
    // The studio emits only on an edit: draw a shape and undo it, so what it
    // hands the host is the drawing exactly as opened.
    const key = async (k: string, init: KeyboardEventInit = {}): Promise<void> => {
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })
        )
      })
    }
    const stage = host.querySelector('[data-testid="draw-stage"]') as HTMLElement
    await key('1', { metaKey: true, code: 'Digit1' })
    await key('m')
    for (const [type, x, y] of [
      ['pointerdown', 10, 10],
      ['pointermove', 40, 40],
      ['pointerup', 60, 60]
    ] as const) {
      await act(async () => {
        stage.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: 0,
            pointerId: 1
          })
        )
      })
    }
    const drawn = onChange.mock.calls.length
    expect(drawn).toBeGreaterThan(0)
    expect(objectsOf(normalizeDrawDoc(onChange.mock.calls.at(-1)![0]))).toHaveLength(
      snip.objects.length + 1
    )
    await key('z', { metaKey: true, code: 'KeyZ' })
    expect(onChange.mock.calls.length).toBeGreaterThan(drawn)
    const emitted = onChange.mock.calls.at(-1)![0]

    const back = snippetFromDrawBody(emitted, snip)
    expect(back.lost).toEqual([])
    expect(back.body).toEqual(snip)
    // Equal after normalisation too (the snippet as the clipboard parser reads it).
    expect(objectsOf(drawBodyFromSnippet(back.body))).toEqual(objectsOf(drawBodyFromSnippet(snip)))
    // And it shares nothing with what the studio emitted.
    expect(sharesNothing(back.body, emitted)).toBe(true)
  })

  it('opening and saving a hundred times does not creep', () => {
    const snip = captured()
    let s = snip
    for (let i = 0; i < 100; i++) s = snippetFromDrawBody(drawBodyFromSnippet(s), s).body
    expect(s).toEqual(snip)
  })
})

describe('snippet -> drawing -> edits in the real editor -> snippet', () => {
  it('a move, a recolour and a new shape come back as the expected snippet', () => {
    const snip = captured()
    const h = harness(drawBodyFromSnippet(snip))
    const ringBefore = byId(snip.objects, 'ring') as DrawPathNode
    // Move: select the ring and nudge it 10 right (⇧→).
    h.ed.ctx.select(['ring'])
    h.key('ArrowRight', { shift: true, code: 'ArrowRight' })
    // Recolour it, as the Fill control commits.
    h.ed.ctx.history.commit(
      mapObjects(
        h.doc(),
        ['ring'],
        (n) => ({ ...n, fill: { type: 'solid', color: '#00aa55' } }) as DrawNode
      ),
      'Fill'
    )
    // Add a shape inside the art's bounds (Rectangle, M).
    h.ed.ctx.select([])
    h.tool('rect')
    h.drag([20, 20], [50, 40])
    expect(h.emitted.length).toBeGreaterThanOrEqual(3)

    const { body, lost } = snippetFromDrawBody(h.emitted.at(-1), snip)
    expect(lost).toEqual([])
    expect(body.kind).toBe('draw')
    const objs = body.objects as DrawNode[]
    expect(objs).toHaveLength(snip.objects.length + 1)
    // The untouched objects are exactly as they were (the bounds' origin did not move).
    for (const id of ['g', 'clip', 't']) expect(byId(objs, id)).toEqual(byId(snip.objects, id))
    // The ring moved 10 right and is recoloured.
    const ringAfter = byId(objs, 'ring') as DrawPathNode
    expect(ringAfter.fill).toEqual({ type: 'solid', color: '#00aa55' })
    const xs = (r: DrawPathNode) => r.path.subpaths.flatMap((sp) => sp.nodes.map((n) => n.x))
    expect(xs(ringAfter)).toEqual(xs(ringBefore).map((x) => x + 10))
    // The new rectangle, on top, where it was drawn.
    const added = objs.at(-1) as DrawPathNode
    expect(added.type).toBe('path')
    expect(nodesBounds([added])).toEqual({ x: 20, y: 20, w: 30, h: 20 })
    // Assets and swatches: exactly what the objects use.
    expect(Object.keys(body.assets!)).toEqual([PNG_ID])
    expect((body.swatches as Array<{ id: string }>).map((s) => s.id)).toEqual(['sw1'])
  })

  it('art moved past the top-left is moved back so the bounds start at the origin, as capture leaves them', () => {
    const snip = captured()
    const h = harness(drawBodyFromSnippet(snip))
    h.tool('rect')
    h.drag([-25, -15], [-5, 5])
    const { body, lost } = snippetFromDrawBody(h.emitted.at(-1), snip)
    expect(lost).toEqual([])
    const b = nodesBounds(body.objects as DrawNode[])
    expect(b.x).toBeCloseTo(0, 9)
    expect(b.y).toBeCloseTo(0, 9)
    // Everything moved by the same (25, 15).
    expect(nodesBounds(body.objects.slice(-1) as DrawNode[])).toEqual({ x: 0, y: 0, w: 20, h: 20 })
    const ringIn = byId(snip.objects, 'ring') as DrawPathNode
    const ringOut = byId(body.objects, 'ring') as DrawPathNode
    expect(ringOut.path.subpaths[0].nodes[0].x).toBeCloseTo(
      ringIn.path.subpaths[0].nodes[0].x + 25,
      9
    )
    expect(ringOut.path.subpaths[0].nodes[0].y).toBeCloseTo(
      ringIn.path.subpaths[0].nodes[0].y + 15,
      9
    )
  })
})

// ── Assets, swatches, aliasing ───────────────────────────────────────────────

describe('the asset store and swatches', () => {
  it('an image keeps its asset; an image added in the session brings its own; unused ones stay behind', () => {
    const snip = captured()
    const doc = drawBodyFromSnippet(snip)
    const added: DrawImageNode = {
      id: 'img2',
      type: 'image',
      x: 5,
      y: 5,
      w: 10,
      h: 10,
      assetId: PNG2_ID
    }
    const edited: DrawDoc = {
      ...doc,
      assets: {
        ...doc.assets,
        [PNG2_ID]: { mime: 'image/png', dataUrl: PNG2, w: 1, h: 1 },
        orphan: { mime: 'image/png', dataUrl: PNG2 }
      },
      layers: [{ ...(doc.layers[0] as DrawDocVectorLayer), objects: [...objectsOf(doc), added] }]
    }
    const { body, lost } = snippetFromDrawBody(edited, snip)
    expect(lost).toEqual([])
    expect(byId(body.objects, 'img')).toMatchObject({ assetId: PNG_ID })
    expect(body.assets).toEqual({
      [PNG_ID]: { mime: 'image/png', dataUrl: PNG, w: 1, h: 1 },
      [PNG2_ID]: { mime: 'image/png', dataUrl: PNG2, w: 1, h: 1 }
    })
  })

  it('swatches the objects use are kept (fills, tinted strokes, appearance stacks); unused ones are reported', () => {
    const snip = captured()
    const doc = drawBodyFromSnippet(snip)
    const appearing = {
      ...(rect('ap', 0, 0, 10, 10) as object),
      fill: { type: 'none' },
      appearance: {
        fills: [{ id: 'f1', paint: { type: 'swatch', id: 'sw2' } }],
        strokes: [],
        effects: []
      }
    } as unknown as DrawNode
    const edited: DrawDoc = {
      ...doc,
      swatches: [
        ...doc.swatches,
        { id: 'sw2', name: 'Accent', color: '#0000ff' },
        { id: 'sw3', name: 'Spare', color: '#abcdef' }
      ],
      layers: [
        {
          ...(doc.layers[0] as DrawDocVectorLayer),
          objects: [...objectsOf(doc), normalizeObj(appearing)]
        }
      ]
    }
    const { body, lost } = snippetFromDrawBody(edited, snip)
    expect(body.swatches).toEqual([
      { id: 'sw1', name: 'Brand', color: '#ff0000', global: true },
      { id: 'sw2', name: 'Accent', color: '#0000ff' }
    ])
    expect(lost).toEqual([
      '1 swatch no object uses is not kept: a snippet keeps the swatches its objects use.'
    ])
  })

  it('the snippet shares no object with the drawing it came from, nor with prev', () => {
    const snip = captured()
    const doc = drawBodyFromSnippet(snip)
    const docBefore = structuredClone(doc)
    const snipBefore = structuredClone(snip)
    const { body } = snippetFromDrawBody(doc, snip)
    expect(sharesNothing(body, doc)).toBe(true)
    expect(sharesNothing(body, snip)).toBe(true)
    ;(body.objects[0] as { name?: string }).name = 'x'
    ;(body.assets![PNG_ID] as { dataUrl: string }).dataUrl = 'data:,'
    ;(body.swatches![0] as { color: string }).color = '#000'
    expect(doc).toEqual(docBefore)
    expect(snip).toEqual(snipBefore)
  })

  it("keeps prev's own fields and kind 'draw'", () => {
    const snip = { ...captured(), version: 3, meta: { by: 'someone' } } as DrawSnippetBody
    const { body } = snippetFromDrawBody(drawBodyFromSnippet(snip), snip)
    expect(body).toMatchObject({ kind: 'draw', version: 3, meta: { by: 'someone' } })
    expect((body as unknown as { meta: object }).meta).not.toBe(
      (snip as unknown as { meta: object }).meta
    )
  })
})

// ── What the snippet cannot hold ─────────────────────────────────────────────

describe('lost content is reported, never dropped quietly', () => {
  function withExtras(fn: (d: DrawDoc) => DrawDoc): {
    body: DrawSnippetBody
    lost: string[]
    snip: DrawSnippetBody
  } {
    const snip = captured()
    const r = snippetFromDrawBody(fn(drawBodyFromSnippet(snip)), snip)
    return { ...r, snip }
  }

  it('a paint layer is kept as a picture object where its pixels lay, and reported', () => {
    const { body, lost, snip } = withExtras((d) => ({
      ...d,
      assets: { ...d.assets, [PNG2_ID]: { mime: 'image/png', dataUrl: PNG2, w: 30, h: 20 } },
      layers: [
        ...d.layers,
        {
          id: 'paint1',
          kind: 'raster',
          name: 'Paint 1',
          visible: true,
          locked: false,
          opacity: 0.5,
          blend: 'multiply',
          assetId: PNG2_ID,
          frame: { x: 10, y: 15, w: 30, h: 20 }
        }
      ]
    }))
    expect(lost).toEqual([
      "Paint layer “Paint 1” is kept as a picture: a snippet holds objects, so it can't be painted on as a layer.",
      "The drawing's 2 layers are flattened into one stack of objects, in the same order."
    ])
    expect(body.objects).toHaveLength(snip.objects.length + 1)
    expect(body.objects.at(-1)).toEqual({
      id: 'paint1',
      type: 'image',
      name: 'Paint 1',
      x: 10,
      y: 15,
      w: 30,
      h: 20,
      assetId: PNG2_ID,
      opacity: 0.5,
      blend: 'multiply'
    })
    expect(body.assets![PNG2_ID]).toBeDefined()
  })

  it('an empty paint layer loses nothing and says nothing', () => {
    const { lost } = withExtras((d) => ({
      ...d,
      layers: [
        ...d.layers,
        {
          id: 'p',
          kind: 'raster',
          name: 'Paint 1',
          visible: true,
          locked: false,
          opacity: 1,
          blend: 'normal'
        }
      ]
    }))
    expect(lost).toEqual([])
  })

  it('an extra artboard is reported; the art on it is kept', () => {
    const { body, lost, snip } = withExtras((d) => ({
      ...d,
      artboards: [
        ...d.artboards,
        {
          id: 'ab2',
          name: 'Artboard 2',
          x: 1000,
          y: 0,
          w: 200,
          h: 200,
          background: { type: 'none' }
        }
      ],
      layers: [
        {
          ...(d.layers[0] as DrawDocVectorLayer),
          objects: [...objectsOf(d), normalizeObj(rect('far', 1050, 50, 20, 20))]
        }
      ]
    }))
    expect(lost).toEqual([
      '1 more artboard is not kept: a snippet has no artboards. The art on them is kept.'
    ])
    expect(body.objects).toHaveLength(snip.objects.length + 1)
    expect(nodesBounds([byId(body.objects, 'far')])).toEqual({ x: 1050, y: 50, w: 20, h: 20 })
  })

  it('an artboard background, a hidden layer, layer opacity and a template layer are each reported', () => {
    const { body, lost } = withExtras((d) => ({
      ...d,
      artboards: [{ ...d.artboards[0], background: { type: 'solid', color: '#ffffff' } }],
      layers: [
        {
          id: 'tpl',
          kind: 'vector',
          name: 'Trace me',
          visible: true,
          locked: true,
          opacity: 0.5,
          blend: 'normal',
          template: true,
          objects: [normalizeObj(rect('traced', 0, 0, 5, 5))]
        },
        d.layers[0],
        {
          id: 'hid',
          kind: 'vector',
          name: 'Notes',
          visible: false,
          locked: false,
          opacity: 0.4,
          blend: 'normal',
          objects: [normalizeObj(rect('note', 1, 1, 5, 5))]
        }
      ]
    }))
    expect(lost).toEqual([
      'Template layer “Trace me” is left out: a template is a tracing guide, not part of the art.',
      'Layer “Notes” is hidden, so its objects are kept hidden.',
      "Layer “Notes”'s opacity and blending are not kept: a snippet holds objects, not layers.",
      "The drawing's 2 layers are flattened into one stack of objects, in the same order.",
      'The artboard background is not kept: a snippet has no page of its own.'
    ])
    expect(body.objects.some((o) => (o as DrawNode).id === 'traced')).toBe(false)
    expect(byId(body.objects, 'note')).toMatchObject({ hidden: true })
  })

  it('objects a newer PlexiiDraw made go back as the JSON they came as (the drawing opens read-only)', () => {
    const future = { id: 'f1', type: 'hologram', x: 0, y: 0, beams: 3 }
    const snip: DrawSnippetBody = {
      kind: 'draw',
      objects: [rect('r', 0, 0, 10, 10), future],
      assets: {},
      swatches: []
    }
    const doc = drawBodyFromSnippet(snip)
    expect(drawDocCompatibility(doc).readOnly).toBe(true)
    const { body, lost } = snippetFromDrawBody(doc, snip)
    expect(lost).toEqual([])
    expect(body.objects[1]).toEqual(future)
  })

  it('objects in the saved snippet that could not be opened are reported', () => {
    const snip: DrawSnippetBody = {
      kind: 'draw',
      objects: [
        rect('r', 0, 0, 10, 10),
        { id: 'broken', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: 'missing' },
        { id: 'nopath', type: 'path', path: { subpaths: [] } }
      ],
      assets: {},
      swatches: []
    }
    const { body, lost } = snippetFromDrawBody(drawBodyFromSnippet(snip), snip)
    expect(body.objects).toHaveLength(1)
    expect(lost).toEqual([
      '2 objects in the saved snippet could not be read (damaged data, or a picture with no image) and are not kept.'
    ])
  })
})

function normalizeObj(o: unknown): DrawNode {
  return objectsOf(normalizeDrawDoc(v2([o])))[0]
}

// ── Hostile and malformed bodies ─────────────────────────────────────────────

describe('hostile and malformed snippet bodies', () => {
  const cyclic: Record<string, unknown> = { id: 'cy', type: 'group', children: [] }
  ;(cyclic.children as unknown[]).push(cyclic)
  let deep: Record<string, unknown> = rect('leaf', 0, 0, 1, 1)
  for (let i = 0; i < 300; i++) deep = { id: `d${i}`, type: 'group', children: [deep] }
  const throwing = {
    get objects(): unknown {
      throw new Error('boom')
    },
    kind: 'draw'
  }

  const bodies: Array<[string, unknown]> = [
    ['null', null],
    ['a number', 42],
    ['a string', 'draw'],
    ['an array', []],
    ['no objects', { kind: 'draw' }],
    ['objects not a list', { kind: 'draw', objects: 'x', assets: 7, swatches: {} }],
    [
      'junk objects',
      {
        kind: 'draw',
        objects: [null, 1, 'a', [], { type: 'group', children: 'x' }, { type: 'text' }]
      }
    ],
    [
      'non-finite numbers',
      {
        kind: 'draw',
        objects: [
          {
            id: 'n',
            type: 'path',
            path: {
              subpaths: [
                {
                  closed: true,
                  nodes: [
                    { x: Number.NaN, y: Infinity },
                    { x: 1, y: 1 }
                  ]
                }
              ]
            }
          }
        ]
      }
    ],
    ['huge coordinates', { kind: 'draw', objects: [rect('big', -1e300, -1e300, 1e300, 1e300)] }],
    [
      'unsafe ids and markup',
      {
        kind: 'draw',
        objects: [
          rect('"><script>alert(1)</script>', 0, 0, 5, 5, {
            fill: { type: 'solid', color: 'url(javascript:alert(1))' }
          })
        ]
      }
    ],
    [
      'duplicate ids',
      {
        kind: 'draw',
        objects: [
          rect('dup', 0, 0, 5, 5),
          rect('dup', 10, 0, 5, 5),
          { id: 'dup', type: 'group', children: [rect('dup', 20, 0, 5, 5)] }
        ]
      }
    ],
    [
      'a script asset',
      {
        kind: 'draw',
        objects: [{ id: 'i', type: 'image', x: 0, y: 0, w: 5, h: 5, assetId: 'a1' }],
        assets: { a1: { dataUrl: 'javascript:alert(1)' }, 'bad id!': { dataUrl: PNG } }
      }
    ],
    [
      'hostile swatches',
      {
        kind: 'draw',
        objects: [rect('s', 0, 0, 5, 5, { fill: { type: 'swatch', id: 'x' } })],
        swatches: [{ id: 'x', color: 'expression(alert(1))' }, null, 'red']
      }
    ],
    [
      'prototype pollution',
      JSON.parse(
        '{"kind":"draw","objects":[{"__proto__":{"polluted":true},"id":"p","type":"path","path":{"subpaths":[]}}],"__proto__":{"polluted":true}}'
      )
    ],
    ['deep nesting', { kind: 'draw', objects: [deep] }],
    ['a cycle', { kind: 'draw', objects: [cyclic] }],
    ['a throwing getter', throwing],
    ['a function', { kind: 'draw', objects: [() => 1] }]
  ]

  it.each(bodies)('%s: opens as a valid drawing, writes back, and nothing throws', (_name, raw) => {
    const snip = raw as DrawSnippetBody
    let doc!: DrawDoc
    expect(() => (doc = drawBodyFromSnippet(snip))).not.toThrow()
    expect(doc.schemaVersion).toBe(2)
    expect(doc.layers.length).toBeGreaterThan(0)
    expect(doc.artboards).toHaveLength(1)
    const a = doc.artboards[0]
    expect([a.x, a.y, a.w, a.h].every(Number.isFinite)).toBe(true)
    // Normalize is idempotent on it: it already is what Draw would store.
    expect(normalizeDrawDoc(doc)).toEqual(doc)
    // Ids are unique.
    const ids = allNodes(objectsOf(doc)).map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    let back!: ReturnType<typeof snippetFromDrawBody>
    expect(() => (back = snippetFromDrawBody(doc, snip))).not.toThrow()
    expect(back.body.kind).toBe('draw')
    expect(Array.isArray(back.body.objects)).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('duplicate ids get fresh ones after the first', () => {
    const doc = drawBodyFromSnippet(
      bodies.find((b) => b[0] === 'duplicate ids')![1] as DrawSnippetBody
    )
    const ids = allNodes(objectsOf(doc)).map((n) => n.id)
    expect(ids[0]).toBe('dup')
    expect(ids.filter((i) => i === 'dup')).toHaveLength(1)
    expect(ids).toHaveLength(4)
  })

  it('markup never survives into an id or a paint', () => {
    const doc = drawBodyFromSnippet(
      bodies.find((b) => b[0] === 'unsafe ids and markup')![1] as DrawSnippetBody
    )
    expect(JSON.stringify(doc)).not.toMatch(/script|javascript/)
  })

  it('a drawing that cannot be read leaves the snippet as it was, and says so', () => {
    const snip = captured()
    // Not an object, an object that is not a drawing (no layers), a cycle.
    for (const bad of [null, 7, 'x', [], { kind: 'draw' }, { layers: 'x' }, cyclic]) {
      const r = snippetFromDrawBody(bad, snip)
      expect(r.body).toEqual(snip)
      expect(r.lost).toEqual([
        'The edited drawing could not be read, so the snippet is left as it was.'
      ])
    }
    expect(snippetFromDrawBody(null).body).toEqual({
      kind: 'draw',
      objects: [],
      assets: {},
      swatches: []
    })
  })
})
