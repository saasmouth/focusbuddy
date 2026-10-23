// The renderer deps snippet conversion runs on (lib/snippetConvertDeps.ts),
// wired to the apps' own engines, and the Diagrams table shape a sheet block
// lands as.

import { describe, expect, it } from 'vitest'
import { drawBodyToSvg, evaluateSheetBlock, importSvgAsDraw, snippetConvertDeps } from '../../src/renderer/src/lib/snippetConvertDeps'
import { getShape } from '../../src/shared/diagram/shapes'
import { mapToSvg } from '../../src/shared/mapExport'
import { convertSnippetBody } from '../../src/shared/snippetConvert'
import type { DiagramSnippetBody } from '../../src/shared/snippets'
import type { MapNode } from '../../src/shared/types'
import * as F from './snippetConvertFixtures'

describe('evaluateSheetBlock (Cells’ formula engine over the saved block)', () => {
  it('computes formulas whose references are inside the block, wherever the block was saved from', () => {
    const ev = evaluateSheetBlock(F.sheet())
    expect(ev.values).toEqual([
      ['Item', 'Qty', 'Price', 'Total'],
      ['Pens', '2', '3', '6'],
      ['Pads', '4', '5', '20'],
      ['Sum', '', '', '26']
    ])
    expect(ev).toMatchObject({ formulas: 3, outside: 0 })
  })

  it('absolute references are moved with the data, because the data moved', () => {
    const ev = evaluateSheetBlock({ kind: 'sheet', rows: [['5'], ['=$C$3*2']], origin: { r: 2, c: 2 } })
    expect(ev.values).toEqual([['5'], ['10']])
  })

  it('a reference outside the saved cells shows #REF!, as does a formula depending on it, and is counted', () => {
    const ev = evaluateSheetBlock({ kind: 'sheet', rows: [['=A1*10', '=A3+1']], origin: { r: 2, c: 0 } })
    expect(ev.values).toEqual([['#REF!', '#REF!']])
    expect(ev.outside).toBe(1)
  })

  it('a reference to another sheet is never read from this block', () => {
    const ev = evaluateSheetBlock({ kind: 'sheet', rows: [['7', '=Sheet2!A1']], origin: { r: 0, c: 0 } })
    expect(ev.values).toEqual([['7', '#REF!']])
    expect(ev.outside).toBe(1)
  })

  it('a block with no origin is read where it stands', () => {
    expect(evaluateSheetBlock({ kind: 'sheet', rows: [['2', '3', '=A1+B1']] }).values).toEqual([['2', '3', '5']])
  })

  it('errors stay errors', () => {
    expect(evaluateSheetBlock({ kind: 'sheet', rows: [['0', '=1/A1']] }).values[0][1]).toBe('#DIV/0!')
  })
})

describe('drawBodyToSvg (Draw’s own clipboard picture)', () => {
  it('draws the objects, cropped to the art', () => {
    const pic = drawBodyToSvg(F.draw())!
    expect(pic.svg).toContain('<svg')
    expect(pic.svg).toContain('Logo mark')
    expect(pic.width).toBeGreaterThanOrEqual(160)
    expect(pic.height).toBeGreaterThanOrEqual(60)
  })

  it('nothing to draw is null, not an empty picture', () => {
    expect(drawBodyToSvg({ kind: 'draw', objects: [] })).toBeNull()
  })

  it('is deterministic', () => {
    expect(drawBodyToSvg(F.draw())).toEqual(drawBodyToSvg(F.draw()))
  })
})

describe('importSvgAsDraw (Draw’s SVG importer)', () => {
  it('imports vectors with ids derived per call, so a re-run is identical', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="10" y="10" width="30" height="20" fill="#ff0000"/><text x="50" y="30">Hi</text></svg>'
    const a = importSvgAsDraw(svg, F.parseXml)!
    const b = importSvgAsDraw(svg, F.parseXml)!
    expect(a).toEqual(b)
    expect(a.objects.map((o) => (o as { type: string }).type)).toEqual(['path', 'text'])
    expect(a.pictured).toBe(0)
  })

  it('what cannot be vectors (a filter) is kept as its own SVG bytes, counted, ready at once', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs><rect x="10" y="10" width="30" height="20" fill="#00f" filter="url(#f)"/></svg>'
    const out = importSvgAsDraw(svg, F.parseXml)!
    expect(out.pictured).toBe(1)
    const img = out.objects.find((o) => (o as { type: string }).type === 'image') as { assetId: string }
    expect((out.assets[img.assetId] as { dataUrl: string }).dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true)
  })

  it('not SVG is null, not an empty drawing', () => {
    expect(importSvgAsDraw('<html/>', F.parseXml)).toBeNull()
  })

  it('the app wiring hands over all three', () => {
    const d = snippetConvertDeps()
    expect(typeof d.evaluateSheet).toBe('function')
    expect(typeof d.drawToSvg).toBe('function')
    expect(typeof d.svgToDraw).toBe('function')
  })
})

describe('the Diagrams table shape a sheet block lands as', () => {
  const lines = (g: ReturnType<ReturnType<typeof getShape>['draw']>): number => g.parts.filter((p) => p.paint === 'stroke').map((p) => (p.d.match(/M/g) ?? []).length).reduce((a, b) => a + b, 0)

  it('its grid follows the cells it holds, not the id’s default counts', () => {
    const def = getShape('table-header')
    // A new table: the id's 3 columns × 4 rows → 2 + 3 inner lines.
    expect(lines(def.draw(300, 200))).toBe(5)
    // Holding 4 × 4 cells → 3 + 3 inner lines, none of them stale.
    const cells = [['a', 'b', 'c', 'd'], ['1', '2', '3', '4'], ['', '', '', ''], ['x', '', '', 'y']]
    expect(lines(def.draw(400, 128, { cells }))).toBe(6)
  })

  it('renders its computed cells in the SVG export', () => {
    const r = convertSnippetBody(F.sheet(), 'diagram', F.DEPS)
    if (!r.ok) throw new Error(r.reason)
    const node = (r.body as DiagramSnippetBody).nodes[0] as MapNode
    const svg = mapToSvg({ version: 1, nodes: [node], edges: [] }).svg
    for (const t of ['Item', 'Total', 'Pens', '26']) expect(svg).toContain(`>${t}<`)
    // A 4 × 4 grid: the shape's 3 + 3 inner lines plus the table renderer's 3 + 3, on the same positions.
    const xs = [...svg.matchAll(/<line x1="([\d.]+)" y1="0"/g)].map((m) => m[1])
    expect(new Set(xs)).toEqual(new Set(['120', '240', '360']))
  })
})
