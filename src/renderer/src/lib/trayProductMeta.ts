// What a tray tab reads for a product page opened from the PlexiiSuite
// launcher (view { kind: 'product', productKey }).
//
// It used to humanise the key and wear a generic box: opening PlexiiSearch from
// the launcher left a tab reading "Plexisearch" with the inventory_2 icon, and
// every other launcher tile did the same ("Plexidocs" for PlexiiWrite,
// "Pleximeet" for PlexiiCall). The catalog (shared/plexiSuite.ts) is the one
// place a product's canonical display name and icon live — the launcher tile
// and the product page read it — so the tab reads it too, and the product's
// entity (plexiiIconMap.suiteProductEntity) gives it the same PlexiiIcon the
// tile wears. A key not in the catalog is humanised, never printed raw.
import { productByKey } from '@shared/plexiSuite'
import { suiteProductEntity, type EntityRef } from './plexiiIconMap'

export interface TrayProductMeta {
  label: string
  /** Material Symbols fallback, used when the entity has no PlexiiIcon. */
  icon: string
  entity: EntityRef | null
  /** The product's accent, for the tab's tone. Null when unknown. */
  accent: string | null
}

/** "desk-pro-annual" → "Desk pro annual". Better than printing the slug. */
export function humaniseKey(key: string): string {
  const t = String(key || '').replace(/[-_]+/g, ' ').trim()
  if (!t) return 'Product'
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function trayProductMeta(productKey: string): TrayProductMeta {
  const p = productByKey(productKey)
  if (!p) return { label: humaniseKey(productKey), icon: 'inventory_2', entity: null, accent: null }
  return { label: p.name, icon: p.icon, entity: suiteProductEntity(p.key), accent: p.accent }
}
