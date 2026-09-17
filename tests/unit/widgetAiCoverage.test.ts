import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { widgetToText, docBodyToText, ATTACHABLE_WIDGET_KINDS } from '../../src/shared/widgetText'
import type { Widget, WidgetKind } from '../../src/shared/types'

// Every widget kind the product ships, read from the type itself so a kind
// added later is covered here the moment it exists.
function allKinds(): WidgetKind[] {
  const src = readFileSync('src/shared/types.ts', 'utf8')
  const block = /export type WidgetKind =\n((?:\s*(?:\/\/.*|\|\s*'[^']+'.*)\n)+)/.exec(src)
  if (!block) throw new Error('could not read WidgetKind from types.ts')
  return [...block[1].matchAll(/\|\s*'([^']+)'/g)].map((m) => m[1] as WidgetKind)
}

// Kinds that legitimately hold no content: they render UI, not information.
// Anything NOT on this list must extract something real.
const CHROME: ReadonlySet<string> = new Set([
  'section', 'minimap', 'shape', 'local-app-launcher', 'color', 'timer',
  'task-link', 'portal', 'calculator', 'streamdeck', 'scratchpad'
])

const widget = (kind: WidgetKind, content: string, title = ''): Widget =>
  ({ id: 'w1', kind, title, content }) as Widget

describe('every widget kind is readable by the AI', () => {
  // The extractor's default arm renders "(kind)" or "(kind: title)". A kind
  // landing there is a kind nothing handles — the assistant cannot read it
  // however plainly the user points at it. An empty widget returning an empty
  // string is fine and honest; falling to the default is not.
  const TITLE = 'Probe'
  const fellThrough = (kind: string, text: string): boolean =>
    text === `(${kind})` || text === `(${kind}: ${TITLE})`

  for (const kind of allKinds()) {
    if (CHROME.has(kind)) continue
    it(`handles a ${kind} widget rather than falling through`, () => {
      const r = widgetToText(widget(kind, '', TITLE))
      expect(fellThrough(kind, r.text)).toBe(false)
    })
  }

  // Guard the guard: the chrome kinds SHOULD hit the default, so if the check
  // above ever stops detecting it, this fails and says so.
  it('still detects the fall-through it is looking for', () => {
    const r = widgetToText(widget('section' as WidgetKind, '', TITLE))
    expect(r.text).toBe('(section: Probe)')
  })
})

describe('content-bearing kinds can ride as @ context', () => {
  const MUST_ATTACH: WidgetKind[] = [
    'note', 'page', 'table', 'doc', 'sheet', 'slides', 'map', 'design', 'draw',
    'voice-recorder', 'stat-card', 'metrics', 'location-map', 'task-list'
  ]
  for (const kind of MUST_ATTACH) {
    it(`${kind} is attachable`, () => {
      expect(ATTACHABLE_WIDGET_KINDS.has(kind)).toBe(true)
    })
  }

  it('does not attach pure chrome', () => {
    for (const kind of ['section', 'minimap', 'shape', 'timer', 'color']) {
      expect(ATTACHABLE_WIDGET_KINDS.has(kind as WidgetKind)).toBe(false)
    }
  })
})

describe('the kinds that were silently unreadable', () => {
  // A voice note's whole value is its transcript, and it sat in content
  // untouched while the extractor returned "(voice-recorder)".
  it('reads a voice note transcript', () => {
    const r = widgetToText(
      widget('voice-recorder', JSON.stringify({ transcript: 'Ring the supplier about the March invoice.', durationSec: 12 }))
    )
    expect(r.text).toContain('Ring the supplier about the March invoice.')
  })

  it('prefers the processed text the user chose to keep', () => {
    const r = widgetToText(
      widget('voice-recorder', JSON.stringify({ transcript: 'umm so like the thing', processedText: 'Call the supplier.' }))
    )
    expect(r.text).toContain('Call the supplier.')
    expect(r.text).not.toContain('umm so like')
  })

  it('reads the figures off a stat card, and says whether they are measured', () => {
    const typed = widgetToText(
      widget('stat-card', JSON.stringify({ title: 'Target', series: [{ label: 'MRR', value: 4200, unit: 'AUD' }] }))
    )
    expect(typed.text).toContain('MRR: 4200 AUD')
    expect(typed.text).toContain('entered by hand')

    const bound = widgetToText(
      widget('stat-card', JSON.stringify({ series: [{ label: 'Rows', value: 9 }], binding: { tableId: 't1' } }))
    )
    expect(bound.text).toContain('measured from a table')
  })

  it('reads metrics cells', () => {
    const r = widgetToText(
      widget('metrics', JSON.stringify({ title: 'Q3', cells: [{ label: 'Signups', value: 120 }], source: 'Stripe' }))
    )
    expect(r.text).toContain('Signups: 120')
    expect(r.text).toContain('Source: Stripe')
  })

  it('reads a place, and surfaces a mismatch between asked and matched', () => {
    const r = widgetToText(
      widget('location-map', JSON.stringify({ query: 'adelaide studio', label: 'Adelaide SA 5000, Australia' }))
    )
    expect(r.text).toContain('Adelaide SA 5000')
    expect(r.text).toContain('searched for "adelaide studio"')
  })

  // PlexiDraw shipped without a case, so every drawing was unreadable — the
  // same defect design had, one app later.
  it('reads the words drawn on a PlexiDraw artwork', () => {
    const body = {
      layers: [
        { name: 'Type', kind: 'vector', objects: [{ type: 'text', text: 'Grand Opening' }, { type: 'path' }] },
        { name: 'Background', kind: 'raster', src: '' }
      ]
    }
    const text = docBodyToText('draw', body)
    expect(text).toContain('Grand Opening')
    expect(text).toContain('2 layers')
    expect(text).toContain('Layers: Type, Background')
  })

  it('never fabricates content for an empty widget', () => {
    for (const kind of ['stat-card', 'metrics', 'location-map', 'gallery', 'voice-recorder'] as WidgetKind[]) {
      const r = widgetToText(widget(kind, ''))
      expect(r.text).toMatch(/^\(|empty|not transcribed|no place/i)
    }
  })
})
