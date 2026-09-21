import { describe, it, expect } from 'vitest'
import { isAdvancedKind, entriesByCategory, WIDGET_SHORTCUTS } from '../../src/renderer/src/lib/widgetCatalog'

// Locks the partial-alignment to product spec §2.4 (core-14): Design and a single
// configurable utility slot (Field) are promoted to the CORE first-run set, while
// custom-block and the dedicated Diagram/Mindmap stay in Advanced (Flowchart/map
// remains the core diagram tool). Guards against a silent re-demotion.

describe('widget catalogue tiering (spec §2.4 partial align)', () => {
  it('promotes Design and Field to core', () => {
    expect(isAdvancedKind('design')).toBe(false)
    expect(isAdvancedKind('field')).toBe(false)
  })

  it('keeps custom-block and dedicated Diagram/Mindmap in advanced', () => {
    expect(isAdvancedKind('custom-block')).toBe(true)
    expect(isAdvancedKind('diagram')).toBe(true)
    expect(isAdvancedKind('mindmap')).toBe(true)
  })

  it('keeps Flowchart (map) as a core diagram tool', () => {
    expect(isAdvancedKind('map')).toBe(false)
  })

  it('surfaces the newly-core widgets in the picker categories', () => {
    const shown = Object.values(entriesByCategory()).flat()
    expect(shown.some((e) => e.kind === 'design')).toBe(true)
    expect(shown.some((e) => e.kind === 'field')).toBe(true)
  })

  it('gives Field a quick-add key but not Design (office-class opens a full surface)', () => {
    expect(WIDGET_SHORTCUTS.field).toBe('F')
    expect(WIDGET_SHORTCUTS.design).toBeUndefined()
  })
})

// Three ways to put a number on a desk — Metrics, Chart and Stat card — were all
// core, with nothing in the picker to tell a first-time user which to take. Stat
// card is Metrics with one cell (they share the metric binding layer), so it is
// demoted rather than removed: the presentation is real and someone will want it.
describe('the numbers cluster', () => {
  it('keeps Metrics and Chart core and demotes Stat card', () => {
    expect(isAdvancedKind('metrics')).toBe(false)
    expect(isAdvancedKind('chart')).toBe(false)
    expect(isAdvancedKind('stat-card')).toBe(true)
  })

  it('still offers Stat card — demoted is not removed', () => {
    // Guards the distinction this whole tier exists to make. A widget that
    // vanished from the catalogue would break every canvas already holding one.
    const all = Object.values(entriesByCategory()).flat()
    expect(all.some((e) => e.kind === 'stat-card')).toBe(true)
  })
})
