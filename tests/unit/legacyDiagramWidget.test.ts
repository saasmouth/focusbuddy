// 4.3.40: the legacy 'diagram' desk widget is no longer OFFERED. PlexiiDiagrams
// (the 'map' kind) supersedes it. It must still RENDER on desks that already
// have one, and keep its Build with AI action, until a later release migrates
// those widgets to diagram documents.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { catalogFor, groupedPickerEntries } from '../../src/renderer/src/lib/widgetCatalog'
import { widgetMenuEntries } from '../../src/renderer/src/lib/widgetMenu'

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
})
