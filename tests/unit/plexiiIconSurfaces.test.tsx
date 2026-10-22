// The second pass of the owner's icon set ("every icon, system wide"): the
// surfaces beyond the side menu and pickers resolve their app, tool or work
// widget through the same declared maps, so a document, a search hit, a suite
// product card or a dashboard widget wears the owner's icon wherever it is
// listed — and anything that is not an entity keeps its glyph.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name, className }: { name: string; className?: string }) => <i data-icon={name} className={className} />
}))

import { PlexiiChipIcon, PlexiiDocIcon } from '../../src/renderer/src/components/PlexiiIcon'
import {
  APP_ICONS,
  DOC_TYPE_APP,
  HOME_WIDGET_ENTITY,
  SUITE_PRODUCT_ENTITY,
  docTypeEntity,
  homeWidgetEntity,
  resolveEntityIcon,
  searchHitEntity,
  suiteProductEntity
} from '../../src/renderer/src/lib/plexiiIconMap'
import { PLEXI_DESK, PLEXI_PRODUCTS } from '../../src/shared/plexiSuite'
import { HOME_WIDGET_DEFS } from '../../src/renderer/src/components/views/homeWidgetDefs'

describe('Plexii icon surfaces: declared maps', () => {
  it('maps every office document type to its app, and a widget file to its kind', () => {
    for (const docType of ['doc', 'sheet', 'slides', 'map', 'design', 'draw']) {
      const ent = docTypeEntity(docType)
      expect(ent?.kind, docType).toBe('app')
      expect(resolveEntityIcon('app', ent!.id).asset, docType).toBeTruthy()
    }
    expect(docTypeEntity('doc')).toEqual({ kind: 'app', id: 'docs' })
    expect(docTypeEntity('map')).toEqual({ kind: 'app', id: 'diagrams' })
    expect(docTypeEntity('widget', 'sticky')).toEqual({ kind: 'widget', id: 'sticky' })
    // No kind, no type, or something unknown: the call site keeps its glyph.
    expect(docTypeEntity('widget')).toBeNull()
    expect(docTypeEntity(undefined)).toBeNull()
    expect(docTypeEntity('canvas')).toBeNull()
    for (const app of Object.values(DOC_TYPE_APP)) expect(app in APP_ICONS, app).toBe(true)
  })

  it('maps suite product cards only to real products, each with an asset', () => {
    const keys = new Set([PLEXI_DESK.key, ...PLEXI_PRODUCTS.map((p) => p.key)])
    for (const [key, ent] of Object.entries(SUITE_PRODUCT_ENTITY)) {
      expect(keys.has(key), `${key} is not a suite product`).toBe(true)
      expect(resolveEntityIcon(ent.kind, ent.id).asset, key).toBeTruthy()
    }
    expect(suiteProductEntity('plexidocs')).toEqual({ kind: 'app', id: 'docs' })
    // The nine products that are neither an app nor a tool wear their own
    // product tiles (22 Oct 2026), never a borrowed app icon.
    for (const key of ['plexiagents', 'plexidash', 'plexitables', 'plexireports', 'plexibuild', 'plexiwidgets', 'plexiapi', 'pleximarketplace', 'plexiops']) {
      expect(suiteProductEntity(key)?.kind, key).toBe('product')
    }
    expect(suiteProductEntity('no-such-product')).toBeNull()
  })

  it('maps dashboard widget defs only to real defs, each with an asset', () => {
    const ids = new Set(HOME_WIDGET_DEFS.map((d) => d.id as string))
    for (const [id, ent] of Object.entries(HOME_WIDGET_ENTITY)) {
      expect(ids.has(id), `${id} is not a dashboard widget`).toBe(true)
      expect(resolveEntityIcon(ent.kind, ent.id).asset, id).toBeTruthy()
    }
    // DEC-144: the dashboard "Focus" widget is the Focus (Attention) work widget.
    expect(homeWidgetEntity('attention')).toEqual({ kind: 'widget', id: 'attention' })
    // Summaries are not entities.
    expect(homeWidgetEntity('standup')).toBeNull()
    expect(homeWidgetEntity('pulse')).toBeNull()
  })

  it('maps search hits to the app or widget they belong to', () => {
    expect(searchHitEntity({ type: 'document', docType: 'sheet' })).toEqual({ kind: 'app', id: 'sheets' })
    expect(searchHitEntity({ type: 'widget', widgetKind: 'task-list' })).toEqual({ kind: 'widget', id: 'task-list' })
    expect(searchHitEntity({ type: 'knowledge' })).toEqual({ kind: 'app', id: 'plexibrain' })
    expect(searchHitEntity({ type: 'event' })).toEqual({ kind: 'app', id: 'calendar' })
    expect(searchHitEntity({ type: 'meeting' })).toEqual({ kind: 'app', id: 'meet' })
    expect(searchHitEntity({ type: 'sign' })).toEqual({ kind: 'app', id: 'sign' })
    expect(searchHitEntity({ type: 'mail' })).toEqual({ kind: 'app', id: 'mail' })
    // Minimap has its own icon now; an unknown kind and the non-entity hit types keep their glyph.
    expect(searchHitEntity({ type: 'widget', widgetKind: 'minimap' })).toEqual({ kind: 'widget', id: 'minimap' })
    expect(searchHitEntity({ type: 'widget', widgetKind: 'no-such-kind' })).toBeNull()
    for (const type of ['task', 'folder', 'file', 'table-row']) expect(searchHitEntity({ type }), type).toBeNull()
  })
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})
const render = (el: JSX.Element): void => act(() => root.render(el))

describe('PlexiiDocIcon', () => {
  it("draws a document's app tile", () => {
    render(<PlexiiDocIcon docType="sheet" size={18} fallback="table_chart" />)
    const img = host.querySelector('img')!
    expect(img.getAttribute('data-plexii-icon')).toBe('app:sheets')
    expect(img.getAttribute('width')).toBe('18')
  })

  it("draws a widget file's kind", () => {
    render(<PlexiiDocIcon docType="widget" widgetKind="sticky" size={18} fallback="widgets" />)
    expect(host.querySelector('[data-plexii-icon]')!.getAttribute('data-plexii-icon')).toBe('widget:sticky')
  })

  it('keeps the call site glyph for a type with no app', () => {
    render(<PlexiiDocIcon docType="canvas" size={18} fallback="space_dashboard" fallbackClassName="text-accent" />)
    expect(host.querySelector('[data-plexii-icon]')).toBeNull()
    const glyph = host.querySelector('i')!
    expect(glyph.getAttribute('data-icon')).toBe('space_dashboard')
    expect(glyph.className).toContain('text-accent')
  })
})

describe('PlexiiChipIcon', () => {
  it('wears an entity tile bare at the chip size (no chip behind a tile)', () => {
    render(<PlexiiChipIcon entity={{ kind: 'app', id: 'mail' }} fallback="mail" size={28} glyphSize={15} chipClassName="chip bg-rose-500/10" />)
    expect(host.querySelector('.chip')).toBeNull()
    const img = host.querySelector('img')!
    expect(img.getAttribute('data-plexii-icon')).toBe('app:mail')
    expect(img.getAttribute('width')).toBe('28')
  })

  it('keeps the tinted chip and glyph for a non-entity or an entity with no asset', () => {
    render(<PlexiiChipIcon entity={null} fallback="bolt" size={28} glyphSize={15} chipClassName="chip" />)
    expect(host.querySelector('.chip i')!.getAttribute('data-icon')).toBe('bolt')
    render(<PlexiiChipIcon entity={{ kind: 'widget', id: 'no-such-kind' }} fallback="map" size={28} glyphSize={15} chipClassName="chip" />)
    expect(host.querySelector('.chip i')!.getAttribute('data-icon')).toBe('map')
  })
})
