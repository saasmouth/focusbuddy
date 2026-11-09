// The owner's "Plexii starting sizes" standard (2026-11-09). This list is the
// standard as written, kept apart from the code on purpose: a change to the
// table has to be made here too, by someone who meant it.
import { describe, it, expect } from 'vitest'
import { WIDGET_START_SIZES, startSizeFor, sizeWhenMoved } from '../../src/shared/widgetStartSizes'
import { minSizeFor, tableBornWidth, tableFitWidth } from '../../src/shared/widgetSizing'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'

const STANDARD: Record<string, [number, number]> = {
  doc: [960, 660], sheet: [960, 620], slides: [960, 620], draw: [960, 620], map: [840, 600], design: [740, 560],
  webview: [1060, 600], inbox: [420, 420], calendar: [420, 380], 'chat-thread': [300, 620], drive: [300, 340],
  sticky: [200, 200], note: [420, 420], 'task-list': [420, 380], table: [740, 440], page: [520, 380],
  mindmap: [740, 520], chart: [620, 380], timer: [200, 300],
  attention: [420, 480], agent: [300, 480], contacts: [300, 300], metrics: [420, 240], 'stat-card': [300, 160],
  streamdeck: [740, 260], markdown: [520, 420], 'living-doc': [520, 420], custom: [520, 420], gallery: [520, 340],
  scratchpad: [620, 420], 'image-gen': [420, 480], 'location-map': [420, 340], 'custom-block': [420, 340],
  portal: [420, 300], card: [300, 200], 'voice-recorder': [300, 240], file: [300, 240], webhook: [300, 200],
  'inbound-hook': [300, 160], field: [300, 120], 'task-link': [300, 120], calculator: [200, 300], color: [200, 240],
  shape: [200, 160], 'local-app-launcher': [200, 120], section: [740, 340],
  'mail-thread': [420, 460], pdf: [620, 660], gdoc: [620, 500], gsheet: [620, 480], gslide: [620, 420],
  email: [620, 500], image: [420, 300], video: [520, 300], diagram: [740, 520]
}

describe('the starting-sizes standard', () => {
  it.each(Object.entries(STANDARD))('%s starts at its standard size', (kind, [w, h]) => {
    expect(startSizeFor(kind)).toEqual({ width: w, height: h })
  })

  it('every entry in the table is in the standard, and the minimap is unchanged', () => {
    const extra = Object.keys(WIDGET_START_SIZES).filter((k) => !(k in STANDARD))
    expect(extra).toEqual(['minimap'])
    expect(startSizeFor('minimap')).toEqual({ width: 220, height: 160 })
  })

  it('every size lands on the canvas 20 px grid', () => {
    for (const [kind, s] of Object.entries(WIDGET_START_SIZES)) {
      expect(s.width % 20, `${kind} width`).toBe(0)
      expect(s.height % 20, `${kind} height`).toBe(0)
    }
  })

  it('no kind starts below the smallest it can be', () => {
    for (const [kind, s] of Object.entries(WIDGET_START_SIZES)) {
      const min = minSizeFor(kind)
      expect(s.width, `${kind} width`).toBeGreaterThanOrEqual(min.w)
      expect(s.height, `${kind} height`).toBeGreaterThanOrEqual(min.h)
    }
  })

  it('the catalog offers exactly the table, for every kind it lists', () => {
    for (const e of WIDGET_CATALOG) {
      expect(startSizeFor(e.kind), e.kind).toEqual({ width: e.defaultWidth, height: e.defaultHeight })
    }
  })
})

describe('moving a widget to another desk', () => {
  it('takes the standard when it is still at its old starting size', () => {
    expect(sizeWhenMoved('doc', 860, 760)).toEqual({ width: 960, height: 660 })
    expect(sizeWhenMoved('webview', 1920, 1080)).toEqual({ width: 1060, height: 600 })
    expect(sizeWhenMoved('sticky', 240, 200)).toEqual({ width: 200, height: 200 })
  })

  it('keeps a size somebody chose', () => {
    expect(sizeWhenMoved('doc', 700, 500)).toEqual({ width: 700, height: 500 })
    expect(sizeWhenMoved('sticky', 240, 201)).toEqual({ width: 240, height: 201 })
  })

  it('leaves a kind the standard does not cover alone', () => {
    expect(sizeWhenMoved('meeting-record', 420, 440)).toEqual({ width: 420, height: 440 })
  })
})

describe('tables open wide enough for their columns', () => {
  it('four columns is the standard 740, six is about 1,060', () => {
    expect(tableFitWidth(4)).toBe(740)
    expect(tableFitWidth(6)).toBe(1060)
  })

  it('a new table is never born under the standard', () => {
    expect(tableBornWidth(1)).toBe(740)
    expect(tableBornWidth(3)).toBe(740)
    expect(tableBornWidth(6)).toBe(1060)
  })

  it('an open table is not pushed up to the new floor', () => {
    // TableWidget widens to tableFitWidth; a 3-column table already on a desk at
    // the old 680 must stay as it is.
    expect(tableFitWidth(3)).toBeLessThanOrEqual(680)
  })

  it('lands on the grid when columns carry their own widths', () => {
    expect(tableFitWidth([{ widthHint: 173 }, { widthHint: 201 }, {}, {}]) % 20).toBe(0)
  })

  it('is still capped, so a huge table scrolls rather than opening wider than the desk', () => {
    expect(tableFitWidth(40)).toBe(1280)
  })
})
