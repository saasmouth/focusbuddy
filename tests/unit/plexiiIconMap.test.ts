// Every entity has an icon: the owner's asset, or a fallback someone DECLARED.
//
// The Plexii icon set (scripts/build-plexii-icons.mjs) covers most apps, work
// widget kinds, tools and connected apps, not all of them. An entity that maps
// to a key the index does not have would draw its Material fallback with no
// one having chosen that, and an entity with no entry at all could draw
// nothing. This walks every one of them, fails on either, and prints the full
// table (entity -> asset or fallback) so the coverage is readable in the log.

import { describe, expect, it } from 'vitest'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'
import { WIDGET_CATALOG } from '../../src/renderer/src/lib/widgetCatalog'
import { STANDARD_APPS } from '../../src/renderer/src/lib/standardApps'
import {
  APP_ICONS,
  TOOL_ICONS,
  WIDGET_ICON_ASSETS,
  CONNECTED_ICON_ASSETS,
  resolveEntityIcon,
  segmentAppEntity,
  viewKindEntity,
  type PlexiiIconKind
} from '../../src/renderer/src/lib/plexiiIconMap'
import {
  PLEXII_ICON_ASSETS,
  PLEXII_ICON_MISSING,
  PLEXII_ICON_NEEDS_REEXPORT
} from '../../src/renderer/src/lib/plexiiIconAssets.generated'

type Row = { entity: string; asset: string | null; fallback: string; note?: string }

function row(kind: PlexiiIconKind, id: string, assetKey: string | null, note?: string): Row {
  const r = resolveEntityIcon(kind, id)
  return { entity: `${kind}:${id}`, asset: assetKey, fallback: r.fallback, note }
}

const apps: Row[] = Object.entries(APP_ICONS).map(([id, e]) => row('app', id, e.asset))
const tools: Row[] = Object.entries(TOOL_ICONS).map(([id, e]) => row('tool', id, e.asset))
const widgets: Row[] = Object.entries(WIDGET_ICON_ASSETS).map(([kind, e]) => row('widget', kind, e.asset, e.note))
const connected: Row[] = STANDARD_APPS.map((a) => row('connected', a.id, CONNECTED_ICON_ASSETS[a.id] ?? null))
const ALL = [...apps, ...tools, ...widgets, ...connected]

describe('Plexii entity icon coverage', () => {
  it('every mapped asset key exists in the generated index (no silent fallback)', () => {
    const dangling = ALL.filter((r) => r.asset && !PLEXII_ICON_ASSETS[r.asset])
    expect(dangling, `asset keys missing from plexiiIconAssets.generated.ts: ${JSON.stringify(dangling)}`).toEqual([])
  })

  it('every entity without an asset has a declared, non-empty fallback glyph', () => {
    for (const r of ALL) expect(r.fallback, `${r.entity} has no fallback`).toMatch(/\S/)
    const undeclared = widgets.filter((r) => !r.asset && !r.note)
    expect(undeclared, 'a widget kind with no asset must say why').toEqual([])
  })

  it('resolves every entity to something drawable', () => {
    for (const r of ALL) {
      const [kind, ...rest] = r.entity.split(':')
      const got = resolveEntityIcon(kind as PlexiiIconKind, rest.join(':'))
      expect(!!got.asset || !!got.fallback, r.entity).toBe(true)
      if (r.asset) expect(got.asset?.slug, r.entity).toBe(PLEXII_ICON_ASSETS[r.asset].slug)
    }
  })

  it('covers every Office app in the segment registry', () => {
    for (const a of SEGMENT_APPS.office) {
      if (a.hub) continue
      expect(segmentAppEntity('office', a.key), `office:${a.key}`).toEqual({ kind: 'app', id: a.key })
      expect(APP_ICONS[a.key as keyof typeof APP_ICONS].asset, `office:${a.key}`).toBeTruthy()
    }
  })

  it('names the apps the owner listed', () => {
    // Write, Cells, Deck, Design, Diagrams, Draw, Call, Chat, Vault, Brain,
    // Assist, Sign, Desk, Files, Browser, Mail, Inbox, Calendar.
    const listed = ['docs', 'sheets', 'slides', 'design', 'diagrams', 'draw', 'meet', 'chat', 'vault', 'plexibrain', 'assist', 'sign', 'plexidesk', 'files', 'browser', 'mail', 'inbox', 'calendar']
    for (const id of listed) expect(APP_ICONS[id as keyof typeof APP_ICONS]?.asset, id).toBeTruthy()
  })

  it('covers every work widget kind in the catalogue, and every kind an app stands for', () => {
    for (const e of WIDGET_CATALOG) expect(e.kind in WIDGET_ICON_ASSETS, e.kind).toBe(true)
    for (const a of SEGMENT_APPS.office) {
      for (const k of (a as { widgetKinds?: readonly string[] }).widgetKinds ?? []) {
        expect(k in WIDGET_ICON_ASSETS, `${a.key} -> ${k}`).toBe(true)
      }
    }
  })

  it('maps the Attention asset to the Focus widget kind without renaming the id (DEC-144)', () => {
    expect(WIDGET_ICON_ASSETS.attention.asset).toBe('widgets/attention')
    expect(resolveEntityIcon('widget', 'attention').label).toBe('Focus')
  })

  it('covers every connected app in the standard catalogue', () => {
    for (const a of STANDARD_APPS) expect(CONNECTED_ICON_ASSETS[a.id], a.id).toBeTruthy()
  })

  it('covers the nine tools, and the registry rows and views that open them', () => {
    expect(Object.keys(TOOL_ICONS).sort()).toEqual(
      ['all-tasks', 'collaborations', 'flows', 'forms', 'organisation', 'people-map', 'projects', 'search', 'shared'].sort()
    )
    for (const t of Object.values(TOOL_ICONS)) expect(t.asset).toBeTruthy()
    expect(segmentAppEntity('plexibrain', 'search')).toEqual({ kind: 'tool', id: 'search' })
    expect(segmentAppEntity('plexibrain', 'flows')).toEqual({ kind: 'tool', id: 'flows' })
    expect(segmentAppEntity('plexipeople', 'workspaces')).toEqual({ kind: 'tool', id: 'organisation' })
    expect(segmentAppEntity('plexipeople', 'map')).toEqual({ kind: 'tool', id: 'people-map' })
    expect(segmentAppEntity('plexidesk', 'plans')).toEqual({ kind: 'tool', id: 'projects' })
    expect(segmentAppEntity('plexidesk', 'tasks')).toEqual({ kind: 'tool', id: 'all-tasks' })
    expect(viewKindEntity('forms')).toEqual({ kind: 'tool', id: 'forms' })
    expect(viewKindEntity('collaborations')).toEqual({ kind: 'tool', id: 'collaborations' })
    // Places are not entities: they keep their glyph.
    expect(segmentAppEntity('office', 'home')).toBeNull()
    expect(segmentAppEntity('plexibrain', 'insights')).toBeNull()
  })

  it('never resolves an unknown id to nothing', () => {
    for (const kind of ['app', 'widget', 'tool', 'connected'] as const) {
      const r = resolveEntityIcon(kind, 'no-such-entity')
      expect(r.asset).toBeNull()
      expect(r.fallback).toMatch(/\S/)
    }
  })

  it('reports the coverage table and the items needing re-export', () => {
    const table = ALL.map((r) => `${r.entity.padEnd(26)} ${r.asset ? `asset ${r.asset}` : `FALLBACK ${r.fallback}`}${r.note ? `  (${r.note})` : ''}`)
    console.log(`Plexii entity icons (${ALL.filter((r) => r.asset).length} asset / ${ALL.filter((r) => !r.asset).length} declared fallback):\n${table.join('\n')}`)
    console.log(`Needs re-export: ${PLEXII_ICON_NEEDS_REEXPORT.join(', ') || 'none'}; missing: ${Object.keys(PLEXII_ICON_MISSING).join(', ') || 'none'}`)
    expect(ALL.length).toBeGreaterThan(90)
  })
})
