// No PlexiiDraw operation that makes nodes out of existing ones may leave one
// object reachable twice in the drawing.
//
// A drawing is saved through IPC as a strict tree. When two shapes held the same
// paint object (Duplicate's shallow copy, 4.3.39-local.6), the payload check saw
// that object twice and refused documents:update, so the drawing could no longer
// be saved. The contracts fix now tolerates shared references and the store
// copies repeats (drawDocForStorage), but every op is still held to a strict
// tree here, so a shared mutable object can never come back as a latent bug: an
// edit to one shape's paint must never be able to change another's.
//
// Each case starts from a drawing with no sharing, runs one node-creating op (or
// a sequence), and asserts no object in the result is reachable twice.

import { describe, expect, it } from 'vitest'
import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { shapePath } from '../../src/shared/draw'
import { drawDocForStorage } from '../../src/shared/draw/compat'
import type { DrawDoc, DrawNode } from '../../src/shared/draw/model'
import { normalizeDrawDoc } from '../../src/shared/draw/normalize'
import {
  addMidpointAnchors,
  allAnchorsOf,
  averageAnchors,
  booleanObjects,
  cutAtAnchors,
  cutPathAt,
  deleteAnchorsBreak,
  duplicateObjects,
  erasePaths,
  groupNodes,
  joinEndpoints,
  joinPaths,
  joinPathsByEnds,
  knifeCut,
  makeClipMask,
  makeCompoundPath,
  openEndpoints,
  pickForGrouping,
  editableIds,
  releaseClipMask,
  releaseCompoundPath,
  roundAnchorCorners,
  simplifyPaths,
  transformEach,
  transformObjects,
  TRANSFORM_EACH_DEFAULTS,
  ungroupNodes
} from '../../src/shared/draw/ops'
import type { XmlDocument } from '../../src/shared/draw/import/svg'
import { altDragDuplicate, buildClipboard, insertInLayer, landPayload, parseClipboardPayload } from '../../src/renderer/src/components/documents/draw/editor/clipboard'
import { prepareFile, type ImportDeps } from '../../src/renderer/src/components/documents/draw/editor/importFiles'
import { placeIntoDoc } from '../../src/renderer/src/components/documents/draw/editor/place'
import { checkArgs } from '../../src/main/ipc/contracts'

/** Paths (from the root) at which an object already seen turns up again. */
function reachedTwice(root: unknown): string[] {
  const seen = new Map<object, string>()
  const out: string[] = []
  const walk = (v: unknown, path: string): void => {
    if (!v || typeof v !== 'object') return
    const first = seen.get(v)
    if (first !== undefined) {
      out.push(`${path} is also ${first}`)
      return
    }
    seen.set(v, path)
    for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
  }
  walk(root, '$')
  return out
}

// Every node is built fresh, so the starting drawing shares nothing.
const paint = (c: string): Record<string, unknown> => ({ type: 'solid', color: c })
const stroke = (): Record<string, unknown> => ({ paint: paint('#111111'), width: 2, dash: [4, 2] })
const rect = (id: string, x: number, y: number, w: number, h: number): Record<string, unknown> => ({
  id,
  type: 'path',
  path: shapePath('rect', { x, y, w, h }),
  fill: paint('#ff0000'),
  stroke: stroke(),
  shapeKind: 'rect'
})
const line = (id: string, pts: Array<[number, number]>): Record<string, unknown> => ({
  id,
  type: 'path',
  path: { subpaths: [{ closed: false, nodes: pts.map(([x, y]) => ({ x, y })) }] },
  fill: paint('#00ff00'),
  stroke: stroke()
})

function start(): DrawDoc {
  return normalizeDrawDoc({
    schemaVersion: 2,
    minWriterVersion: 2,
    artboards: [
      { id: 'ab1', name: 'A', x: 0, y: 0, w: 400, h: 300, background: { type: 'solid', color: '#ffffff' } },
      { id: 'ab2', name: 'B', x: 500, y: 0, w: 400, h: 300, background: { type: 'none' } }
    ],
    activeArtboardId: 'ab1',
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
        objects: [
          rect('a', 10, 10, 40, 40),
          rect('b', 30, 30, 40, 40),
          line('l1', [[0, 100], [100, 100]]),
          line('l2', [[120, 120], [200, 120], [260, 160]]),
          {
            id: 'g',
            type: 'group',
            transform: [2, 0, 0, 2, 0, 0],
            children: [rect('ga', 100, 10, 20, 20), { id: 't', type: 'text', x: 100, y: 60, w: 80, text: 'Hi', fontSize: 12, fill: paint('#0000ff') }]
          }
        ]
      }
    ],
    assets: {},
    swatches: [],
    guides: [],
    settings: {}
  })
}

const clean = (d: DrawDoc, what: string): void => {
  expect(reachedTwice(d), what).toEqual([])
  // And it is exactly what the save path sends: accepted.
  expect(checkArgs([{ kind: 'string' }, { kind: 'any' }], ['doc-id', { body: drawDocForStorage(d) }]), what).toBeNull()
}

describe('no node-creating op leaves an object reachable twice', () => {
  it('the starting drawing shares nothing (so a failure below is the op’s)', () => {
    clean(start(), 'start')
  })

  it('Duplicate (top level, a group, a member inside its group)', () => {
    let d = start()
    d = duplicateObjects(d, ['a', 'g']).doc
    d = duplicateObjects(d, ['ga']).doc
    clean(d, 'duplicate')
  })

  it('transform copies: Alt-drag, Move/Rotate/Scale with Copy, Transform Each with Copy, Transform Again (repeated)', () => {
    let d = start()
    d = altDragDuplicate(d, ['a', 'l1'], 30, 10).doc
    d = transformObjects(d, ['b', 'g'], [0, 1, -1, 0, 200, 0], {}, true).doc
    d = transformObjects(d, ['ga'], [1.5, 0, 0, 1.5, 0, 0], { scaleStrokes: true }, true).doc
    d = transformEach(d, ['a', 'b', 'l2'], { ...TRANSFORM_EACH_DEFAULTS, rotate: 30, moveH: 5 }, {}, true).doc
    for (let i = 0; i < 3; i++) d = transformObjects(d, ['a'], [1, 0, 0, 1, 10, 0], {}, true).doc
    clean(d, 'transform copies')
  })

  it('Copy then Paste, twice, and Paste on every artboard', () => {
    let d = start()
    const built = buildClipboard(d, ['a', 'g'])!
    for (let i = 0; i < 2; i++) {
      const parsed = parseClipboardPayload(built.json)!
      const landed = landPayload(d, parsed)
      d = insertInLayer(landed.doc, 'L1', landed.nodes, 'top')
    }
    clean(d, 'paste')
  })

  it('path surgery: Cut at anchors, Scissors, Knife, Path Eraser, Delete anchors (break)', () => {
    let d = start()
    d = cutAtAnchors(d, allAnchorsOf(d, 'l2').slice(1, 2)).doc
    d = cutPathAt(d, 'a', [{ si: 0, seg: 1, t: 0.5 }]).doc
    d = knifeCut(d, ['b'], [{ x: 0, y: 50 }, { x: 120, y: 50 }]).doc
    d = erasePaths(d, editableIds(d, ['l1']), [{ x: 40, y: 100 }, { x: 60, y: 100 }], 5).doc
    d = deleteAnchorsBreak(d, allAnchorsOf(d, 'ga').slice(0, 1)).doc
    clean(d, 'path surgery')
  })

  it('Join, Average, Average & Join, Add anchor points, Round corners, Simplify', () => {
    let d = start()
    const ends = openEndpoints(d, ['l1', 'l2'])
    const a = ends.find((e) => e.id === 'l1' && e.end === 'end')!
    const b = ends.find((e) => e.id === 'l2' && e.end === 'start')!
    d = joinEndpoints(d, a, b)!.doc
    clean(d, 'join endpoints')
    let e = start()
    e = joinPathsByEnds(e, ['l1', 'l2'], true)!.doc
    e = averageAnchors(e, allAnchorsOf(e, 'a').slice(0, 2), 'both')
    e = addMidpointAnchors(e, ['b'])
    e = roundAnchorCorners(e, allAnchorsOf(e, 'b').slice(0, 2), 4).doc
    e = simplifyPaths(e, ['b'], { curvePrecision: 50, angleThreshold: 0, straightLines: false } as never)
    e = joinPaths(e, ['a']).doc
    clean(e, 'average and join')
  })

  it('Pathfinder, compound paths, groups and clipping masks, made and released', () => {
    let d = start()
    d = booleanObjects(d, ['a', 'b'], 'union').doc
    clean(d, 'unite')
    let e = start()
    e = makeCompoundPath(e, ['a', 'b']).doc
    e = releaseCompoundPath(e, editableIds(e, e.layers.flatMap((l) => (l.kind === 'vector' ? l.objects.map((o) => o.id) : [])))).doc
    const grouped = groupNodes(e, pickForGrouping(e, ['l1', 'l2'], editableIds))
    e = grouped.doc
    e = ungroupNodes(e, [grouped.groupId!]).doc
    const clip = makeClipMask(e, ['l1', 'l2'])
    e = clip.doc
    e = releaseClipMask(e, clip.groupId ? [clip.groupId] : []).doc
    clean(e, 'objects')
  })

  it('Place and Import SVG: the same file placed twice', async () => {
    const parseXml = (s: string): XmlDocument =>
      new XmlDomParser({ errorHandler: { warning: () => {}, error: () => {}, fatalError: () => {} } } as never).parseFromString(s, 'image/svg+xml') as unknown as XmlDocument
    const deps: ImportDeps = {
      parseXml,
      rasterize: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      pdfPage: async () => ({ ok: false, error: 'not used' }),
      gunzip: async () => {
        throw new Error('not used')
      }
    }
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><rect width="50" height="50" fill="url(#g)"/><circle cx="25" cy="25" r="10" fill="url(#g)" stroke="#000"/></svg>'
    let n = 0
    const item = await prepareFile({ name: 'art.svg', bytes: new TextEncoder().encode(svg) }, deps, { structure: 'v2', newId: (p) => `${p}-${++n}` })
    if ('error' in item) throw new Error(item.error)
    let d = start()
    d = placeIntoDoc(d, item, { x: 0, y: 0, w: 50, h: 50 }, { newId: (p) => `${p}-${++n}` }).doc
    d = placeIntoDoc(d, item, { x: 60, y: 0, w: 50, h: 50 }, { newId: (p) => `${p}-${++n}` }).doc
    clean(d, 'place twice')
  })

  it('a long random sequence of all of the above stays a strict tree', () => {
    let seed = 7
    const r = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    let d = start()
    const ids = (): string[] => d.layers.flatMap((l) => (l.kind === 'vector' ? l.objects.map((o: DrawNode) => o.id) : []))
    for (let i = 0; i < 40; i++) {
      const pick = ids()
      const some = pick.filter(() => r() < 0.4).slice(0, 3)
      if (!some.length) continue
      switch (i % 4) {
        case 0:
          d = duplicateObjects(d, some).doc
          break
        case 1:
          d = transformObjects(d, some, [1, 0, 0, 1, r() * 20, r() * 20], {}, true).doc
          break
        case 2:
          d = altDragDuplicate(d, some, 5, 5).doc
          break
        default: {
          const built = buildClipboard(d, some)
          if (built) {
            const landed = landPayload(d, parseClipboardPayload(built.json)!)
            d = insertInLayer(landed.doc, 'L1', landed.nodes, 'top')
          }
        }
      }
    }
    clean(d, 'random sequence')
  })
})

describe('drawing tools never hand two shapes the same paint object', () => {
  it('three rectangles, an ellipse, a star, a line, a pen path and type, all with the current fill and stroke', async () => {
    const { harness, blank } = await import('./drawTools/harness')
    const h = harness(blank([]))
    h.ed.ctx.set({ snapOn: false })
    for (const [tool, from, to] of [
      ['rect', [10, 10], [60, 60]],
      ['rect', [80, 10], [130, 60]],
      ['rect', [150, 10], [200, 60]],
      ['ellipse', [10, 100], [60, 150]],
      ['star', [80, 100], [130, 150]],
      ['line', [150, 100], [200, 150]]
    ] as Array<[string, [number, number], [number, number]]>) {
      h.tool(tool)
      h.drag(from, to)
    }
    h.tool('pen')
    h.click(10, 200)
    h.click(60, 220)
    h.click(110, 200)
    h.key('Enter')
    expect(h.objects().length).toBeGreaterThanOrEqual(7)
    expect(reachedTwice(h.doc())).toEqual([])
    expect(reachedTwice(h.emitted.at(-1))).toEqual([])
  })
})
