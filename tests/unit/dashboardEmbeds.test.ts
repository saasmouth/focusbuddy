import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOME_WIDGET_DEFS, widgetDef, DASHBOARD_SURFACES } from '../../src/renderer/src/components/views/homeWidgetDefs'

// Desk objects and office documents, live on a dashboard, for Home, Office,
// People and Brain.
//
// Two things make this more than a link tile. The card renders the REAL
// component -- the same dispatcher the canvas uses, the same editor the Office
// app uses -- so what you type is written to the same row the desk reads. And
// the object is rendered on an "embedded" surface, which fills the card and
// disables drag and resize, because an object on a dashboard has no meaningful
// desk coordinates and must never write nonsense ones back to the desk it
// still belongs to.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

describe('the new dashboard widgets', () => {
  it('offers a desk object and an office document', () => {
    const desk = widgetDef('desk-widget')
    const doc = widgetDef('office-document')
    expect(desk.id).toBe('desk-widget')
    expect(doc.id).toBe('office-document')
    // Both can appear more than once: several objects, several documents.
    expect(desk.multi).toBe(true)
    expect(doc.multi).toBe(true)
    // Both need a target before they can be placed.
    expect(desk.config).toBe('desk-widget')
    expect(doc.config).toBe('document')
  })

  it('offers them on every dashboard', () => {
    // No `surfaces` means every surface, which is the point of the request.
    expect(widgetDef('desk-widget').surfaces).toBeUndefined()
    expect(widgetDef('office-document').surfaces).toBeUndefined()
  })

  it('scopes People\'s former home page to People', () => {
    expect(widgetDef('people-home').surfaces).toEqual(['people'])
  })

  it('knows all four dashboards', () => {
    expect(DASHBOARD_SURFACES).toEqual(['home', 'office', 'people', 'brain'])
  })

  it('every def either names its surfaces or is valid everywhere', () => {
    for (const d of HOME_WIDGET_DEFS) {
      if (!d.surfaces) continue
      for (const s of d.surfaces) expect(DASHBOARD_SURFACES).toContain(s)
    }
  })
})

describe('the cards render the real thing', () => {
  const src = read('renderer/src/components/views/dashboardEmbeds.tsx')

  it('a desk object goes through the same dispatcher the canvas uses', () => {
    expect(src).toContain("import { renderWidget } from '../widgets/renderWidget'")
    expect(src).toContain('{renderWidget(widget)}')
  })

  it('an office document goes through the real editor', () => {
    expect(src).toContain("import OfficeDocWidget from '../widgets/OfficeDocWidget'")
    expect(src).toContain('<OfficeDocWidget widget={synthetic} inline />')
  })

  it('prefers the store copy when the desk is open, so both surfaces move together', () => {
    expect(src).toContain('const fromStore = useWidgetStore((s) => s.widgets.find((w) => w.id === widgetId))')
    expect(src).toContain('const widget = fromStore ?? fetched')
  })

  it('shows an honest empty state rather than a blank card', () => {
    // A deleted object must say so, not spin forever or render nothing.
    expect(src).toContain('Object unavailable')
    expect(src).toContain('Document unavailable')
    expect(src).toContain('No object chosen')
  })
})

describe('embedded objects cannot be dragged, resized or mispositioned', () => {
  const frame = read('renderer/src/components/widgets/WidgetFrame.tsx')

  it('WidgetFrame fills its card instead of using desk coordinates', () => {
    expect(frame).toContain("useWidgetSurface() === 'embedded'")
    expect(frame).toContain('position={embedded ? { x: 0, y: 0 } : controlledPos}')
    expect(frame).toContain("size={embedded ? { width: '100%', height: '100%' } : controlledSize}")
  })

  it('drag and resize are off, so nothing writes back to the desk', () => {
    expect(frame).toContain('disableDragging={embedded || dragDisabled}')
    // `embedded` leads the enableResizing condition, whatever else joins it.
    // Written as a pattern rather than one literal because the condition grew
    // when section children gained resizing (2026-10-30) without the rule
    // here changing: an embedded object still cannot be resized.
    expect(frame).toMatch(/enableResizing=\{[\s\S]{0,400}?embedded \|\|/)
  })

  it('the dashboard card is what declares the embedded surface', () => {
    const src = read('renderer/src/components/views/dashboardEmbeds.tsx')
    expect(src).toContain('<WidgetSurfaceContext.Provider value="embedded">')
  })

  it('defaults to canvas, so the desk is unaffected', () => {
    expect(read('renderer/src/lib/widgetSurface.ts')).toContain(
      "createContext<WidgetSurface>('canvas')"
    )
  })
})

describe('all four dashboards run the one engine', () => {
  const dash = read('renderer/src/components/views/HomeDashboard.tsx')

  it('keeps Home on its original storage key so existing layouts survive', () => {
    expect(dash).toContain("return surface === 'home' ? 'home.layout.v3' : `home.layout.v3.${surface}`")
  })

  it('gives each dashboard its own stock layout', () => {
    expect(dash).toContain('const STOCK_BY_SURFACE:')
    expect(dash).toContain('function stockFlatFor(surface: DashboardSurface)')
  })

  it('only migrates the legacy layout for Home, which is the only one that has one', () => {
    expect(dash).toContain("if (surface !== 'home') return stock")
  })

  it('filters the widget gallery by surface', () => {
    expect(dash).toContain('if (d.surfaces && !d.surfaces.includes(surface)) return false')
  })

  it('is wired into People, Brain and Office', () => {
    const segments = read('renderer/src/components/segment/segments.tsx')
    expect(segments).toContain('<HomeDashboard surface="people" />')
    expect(segments).toContain('<HomeDashboard surface="brain" />')
    expect(read('renderer/src/components/office/PlexiOfficeShell.tsx')).toContain(
      '<HomeDashboard surface="office" />'
    )
    // Home keeps its bare call.
    expect(segments).toContain('render: () => <HomeDashboard /> }')
  })

  it('keeps the People page whole by making it a widget on its own dashboard', () => {
    expect(dash).toContain("case 'people-home':")
    expect(dash).toContain('<PeopleHomeView />')
  })
})
