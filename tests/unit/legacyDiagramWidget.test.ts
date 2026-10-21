// 4.3.40: the legacy 'diagram' desk widget is no longer OFFERED. PlexiiDiagrams
// (the 'map' kind) supersedes it. It must still RENDER on desks that already
// have one, and keep its Build with AI action, until a later release migrates
// those widgets to diagram documents.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { catalogFor, groupedPickerEntries } from '../../src/renderer/src/lib/widgetCatalog'
import { tileWidgetKind, widgetMenuEntries } from '../../src/renderer/src/lib/widgetMenu'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'

const src = (p: string): string => readFileSync(join(__dirname, '../../src/renderer/src', p), 'utf-8')

describe('legacy Diagram widget', () => {
  it('is not offered by the widget picker or the side menu', () => {
    expect(catalogFor('diagram')?.hideFromPicker).toBe(true)
    const picker = groupedPickerEntries().flatMap((g) => g.entries.map((e) => e.kind))
    expect(picker).not.toContain('diagram')
    expect(widgetMenuEntries().map((e) => e.kind)).not.toContain('diagram')
  })

  it('PlexiiDiagrams is still offered in its place', () => {
    const picker = groupedPickerEntries().flatMap((g) => g.entries.map((e) => e.kind))
    expect(picker).toContain('map')
  })

  it('existing Diagram widgets still render and keep Build with AI', () => {
    expect(src('components/widgets/renderWidget.tsx')).toMatch(/case 'diagram':[\s\S]{0,80}<DiagramWidget/)
    expect(src('lib/contextMenu/providers.ts')).toContain("'mindmap', 'diagram'")
    expect(src('lib/widgetSetup.ts')).toContain("'diagram',")
  })

  it('no app tile is a back door to it: dragging or adding the PlexiiDiagrams tile places a diagram document', () => {
    // Found by the help writer: the tile's first widget kind was 'diagram', so
    // "Add PlexiiDiagrams to this desk" and dragging the tile made the legacy widget.
    expect(tileWidgetKind(SEGMENT_APPS.office.find((a) => a.key === 'diagrams')!)).toBe('map')
    for (const kind of Object.keys(SEGMENT_APPS) as (keyof typeof SEGMENT_APPS)[]) {
      for (const app of SEGMENT_APPS[kind]) {
        const placed = tileWidgetKind(app)
        if (placed) expect(catalogFor(placed)?.hideFromPicker, `${kind}:${app.key} places ${placed}`).toBeFalsy()
      }
    }
  })
})

