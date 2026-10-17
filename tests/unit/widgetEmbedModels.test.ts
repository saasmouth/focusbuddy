import { describe, it, expect } from 'vitest'
import { migrateSlidesBody } from '@shared/slidesMigrate'
import { normalizeDesignBody, designToHtml } from '@shared/design'
import { normalizeMapBody } from '@shared/mapGraph'
import type { SlidesBody, SlideWidgetElement } from '@shared/types'
// 4.3.32 lexicon standard: user-facing text says “work widget”. The string pins in
// this file that read “widget” were rewritten to the new wording (owner ruling).

// The widget-embed element ('widget') must survive every body normaliser and
// migration untouched: an old document opens unchanged, and a document that
// carries an embed never loses it on a load/save round trip.

const widgetEl: SlideWidgetElement = { id: 'w1', type: 'widget', widgetId: 'wid-123', x: 10, y: 20, w: 300, h: 200, z: 3 }

describe('widget embed model tolerance', () => {
  it('migrateSlidesBody passes a v2 deck containing a widget element through unchanged', () => {
    const body: SlidesBody = {
      schemaVersion: 2,
      slides: [{ id: 's1', notes: '', schemaVersion: 2, elements: [widgetEl] }]
    }
    const out = migrateSlidesBody(body)
    expect(out).toBe(body)
    expect(out.slides[0].elements).toEqual([widgetEl])
  })

  it('migrateSlidesBody still converts a legacy v1 deck (no widget elements involved)', () => {
    const out = migrateSlidesBody({ slides: [{ id: 's1', title: 'T', bullets: ['a'], notes: '' }] })
    expect(out.schemaVersion).toBe(2)
    expect(out.slides[0].elements!.length).toBeGreaterThan(0)
  })

  it('normalizeDesignBody keeps a widget element intact', () => {
    const out = normalizeDesignBody({ schemaVersion: 1, width: 1080, height: 1080, elements: [widgetEl] })
    expect(out.elements).toEqual([widgetEl])
  })

  it('designToHtml renders a widget element as an honest labelled frame, not fake content', () => {
    const html = designToHtml({ schemaVersion: 1, width: 400, height: 400, elements: [widgetEl] })
    expect(html).toContain('Embedded work widget')
  })

  it('normalizeMapBody keeps a widget node and its widgetId', () => {
    const out = normalizeMapBody({
      version: 1,
      nodes: [{ id: 'n1', x: 5, y: 6, label: '', shape: 'widget', color: '#111', widgetId: 'wid-123' }],
      edges: []
    })
    expect(out.nodes[0].shape).toBe('widget')
    expect(out.nodes[0].widgetId).toBe('wid-123')
  })

  it('normalizeMapBody drops a non-string widgetId rather than inventing one', () => {
    const out = normalizeMapBody({
      version: 1,
      nodes: [{ id: 'n1', x: 0, y: 0, label: '', shape: 'widget', color: '#111', widgetId: 42 }],
      edges: []
    })
    expect(out.nodes[0].widgetId).toBeUndefined()
  })
})
