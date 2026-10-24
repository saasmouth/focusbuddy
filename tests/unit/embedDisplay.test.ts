// The per-placement display of an embedded work widget ('data' = the content
// alone, 'object' = the original with its frame) must SURVIVE every host's
// load. Each host normalises its document through a whitelist, and a field
// missing from a whitelist is silently dropped on the next open — the way
// Design once lost its swatches. So each host is round-tripped here.
import { describe, expect, it } from 'vitest'
import { embedDisplayField, normaliseEmbedDisplay } from '@shared/embedDisplay'
import { normalizeNode } from '@shared/diagram/normalize'
import { normalizeDrawDoc } from '@shared/draw/normalize'
import { normalizeDrawBody } from '@shared/draw'
import { normalizeDesignBody } from '@shared/design'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import { normalizeBody as normalizeSheetBody } from '../../src/renderer/src/lib/sheetBody'
import { wheelBelongsToDeskView } from '../../src/renderer/src/lib/wheelChaining'

describe('embed display value', () => {
  it('defaults to data, and only the two real values pass', () => {
    expect(normaliseEmbedDisplay(undefined)).toBe('data')
    expect(normaliseEmbedDisplay('object')).toBe('object')
    expect(normaliseEmbedDisplay('data')).toBe('data')
    expect(normaliseEmbedDisplay('frame')).toBe('data')
  })
  it('is only written when it differs from the default', () => {
    expect(embedDisplayField('object')).toEqual({ embedDisplay: 'object' })
    expect(embedDisplayField('data')).toEqual({})
    expect(embedDisplayField(undefined)).toEqual({})
  })
})

describe('every host keeps a placement’s display through a load', () => {
  it('Diagrams (map node)', () => {
    const n = normalizeNode({ id: 'n1', x: 0, y: 0, label: '', shape: 'widget', widgetId: 'w1', embedDisplay: 'object' })
    expect(n?.embedDisplay).toBe('object')
  })
  it('Draw (v2 document)', () => {
    const doc = normalizeDrawDoc({
      schemaVersion: 2,
      layers: [{ id: 'L1', kind: 'vector', name: 'L', objects: [{ id: 'o1', type: 'widget', widgetId: 'w1', x: 0, y: 0, w: 100, h: 80, embedDisplay: 'object' }] }]
    }) as unknown as { layers: Array<{ objects?: Array<{ type: string; embedDisplay?: string }> }> }
    const node = doc.layers.flatMap((l) => l.objects ?? []).find((o) => o.type === 'widget')
    expect(node?.embedDisplay).toBe('object')
    // Checked, not merely carried: an unknown value does not ride through.
    const bad = normalizeDrawDoc({
      schemaVersion: 2,
      layers: [{ id: 'L1', kind: 'vector', name: 'L', objects: [{ id: 'o1', type: 'widget', widgetId: 'w1', x: 0, y: 0, w: 100, h: 80, embedDisplay: 'frame' }] }]
    }) as unknown as { layers: Array<{ objects?: Array<{ type: string; embedDisplay?: string }> }> }
    expect(bad.layers.flatMap((l) => l.objects ?? []).find((o) => o.type === 'widget')?.embedDisplay).toBeUndefined()
  })
  it('Draw (v1 body)', () => {
    const body = normalizeDrawBody({
      size: { w: 800, h: 600 },
      layers: [{ id: 'L1', type: 'vector', name: 'L', objects: [{ id: 'o1', type: 'widget', widgetId: 'w1', x: 0, y: 0, w: 100, h: 80, embedDisplay: 'object' }] }]
    }) as unknown as { layers: Array<{ objects?: Array<{ embedDisplay?: string }> }> }
    const obj = body.layers.flatMap((l) => l.objects ?? []).find(Boolean)
    expect(obj?.embedDisplay).toBe('object')
  })
  it('Design', () => {
    const d = normalizeDesignBody({
      schemaVersion: 1,
      width: 1080,
      height: 1080,
      elements: [{ id: 'e1', type: 'widget', widgetId: 'w1', x: 0, y: 0, w: 100, h: 80, z: 1, embedDisplay: 'object' }]
    }) as unknown as { elements: Array<{ id: string; embedDisplay?: string }> }
    expect(d.elements.find((e) => e.id === 'e1')?.embedDisplay).toBe('object')
  })
  it('Deck', () => {
    const b = migrateSlidesBody({
      slides: [{ id: 's1', schemaVersion: 2, elements: [{ id: 'e1', type: 'widget', widgetId: 'w1', x: 0, y: 0, w: 100, h: 80, z: 1, embedDisplay: 'object' }] }]
    } as never) as unknown as { slides: Array<{ elements: Array<{ id: string; embedDisplay?: string }> }> }
    expect(b.slides[0].elements.find((e) => e.id === 'e1')?.embedDisplay).toBe('object')
  })
  it('Cells', () => {
    const b = normalizeSheetBody({
      version: 2,
      activeSheet: 0,
      sheets: [{ id: 't1', name: 'Sheet1', columns: ['A', 'B'], rows: [['', '']], widgets: [{ id: 'p1', widgetId: 'w1', mode: 'float', x: 0, y: 0, w: 100, h: 80, embedDisplay: 'object' }] }]
    } as never) as unknown as { sheets: Array<{ widgets?: Array<{ embedDisplay?: string }> }> }
    expect(b.sheets[0].widgets?.[0].embedDisplay).toBe('object')
  })
})

describe('the desk stands aside for a full-screen desk view', () => {
  const at = (insideView: boolean) =>
    ({ closest: (sel: string) => (insideView && sel === '[data-desk-view-host]' ? {} : null) }) as unknown as EventTarget
  it('a wheel inside Workcentre, Columns or a data layout is the view’s', () => {
    expect(wheelBelongsToDeskView(at(true))).toBe(true)
  })
  it('a wheel on the desk itself is still the desk’s', () => {
    expect(wheelBelongsToDeskView(at(false))).toBe(false)
    expect(wheelBelongsToDeskView(null)).toBe(false)
  })
})
