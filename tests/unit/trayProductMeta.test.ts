// Opening PlexiiSearch from the PlexiiSuite launcher left a tray tab reading
// "Plexisearch" with a generic box (inventory_2): the tab humanised the product
// key instead of reading the catalog. Every launcher tile did the same. The tab
// now reads the catalog's canonical name and icon, as the tile does.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allProducts } from '../../src/shared/plexiSuite'
import { trayProductMeta } from '../../src/renderer/src/lib/trayProductMeta'
import { resolveEntityIcon, suiteProductEntity } from '../../src/renderer/src/lib/plexiiIconMap'

describe('a product opened from the launcher: its tray tab', () => {
  it('PlexiiSearch reads "PlexiiSearch" with its own icon, not "Plexisearch" in a box', () => {
    const m = trayProductMeta('plexisearch')
    expect(m.label).toBe('PlexiiSearch')
    expect(m.icon).not.toBe('inventory_2')
    expect(m.entity).toEqual({ kind: 'tool', id: 'search' })
  })

  it('the renamed office apps read their canonical names (app-names table)', () => {
    expect(trayProductMeta('plexidocs').label).toBe('PlexiiWrite')
    expect(trayProductMeta('plexisheets').label).toBe('PlexiiCells')
    expect(trayProductMeta('plexislides').label).toBe('PlexiiDeck')
    expect(trayProductMeta('pleximeet').label).toBe('PlexiiCall')
    expect(trayProductMeta('plexichat').label).toBe('PlexiiChat')
    expect(trayProductMeta('plexivault').label).toBe('PlexiiVault')
    expect(trayProductMeta('plexibrain').label).toBe('PlexiiBrain')
  })

  for (const p of allProducts()) {
    it(`${p.key}: the tile's name and icon, and the tile's PlexiiIcon`, () => {
      const m = trayProductMeta(p.key)
      expect(m.label).toBe(p.name)
      expect(m.icon).toBe(p.icon)
      expect(m.icon).not.toBe('inventory_2')
      // Same entity the launcher tile draws, and it resolves to a named icon.
      expect(m.entity).toEqual(suiteProductEntity(p.key))
      expect(m.entity, `${p.key} has no PlexiiIcon entity`).not.toBeNull()
      expect(resolveEntityIcon(m.entity!.kind, m.entity!.id).label).not.toBe(m.entity!.id)
    })
  }

  it('an unknown key is humanised, never printed raw', () => {
    expect(trayProductMeta('desk-pro-annual')).toEqual({ label: 'Desk pro annual', icon: 'inventory_2', entity: null, accent: null })
  })

  it('the tray reads it for product views', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'OpenTray.tsx'), 'utf8')
    const product = src.slice(src.indexOf("case 'product':"), src.indexOf("case 'knowledge':"))
    expect(product).toContain('trayProductMeta(v.productKey)')
    expect(product).toContain('entity: p.entity')
    expect(product).not.toContain('humaniseKey')
  })
})
