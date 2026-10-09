import { describe, expect, it } from 'vitest'
import {
  WIDGET_CATALOG,
  WIDGET_USE_CASE_GROUPS,
  groupedPickerEntries,
  useCaseGroupOf
} from '../../src/renderer/src/lib/widgetCatalog'

const visible = WIDGET_CATALOG.filter((e) => !e.hideFromPicker)

describe('widget use-case groups', () => {
  it('places every pickable widget in exactly one group', () => {
    const ungrouped = visible.filter((e) => useCaseGroupOf(e.kind) === null).map((e) => e.kind)
    expect(ungrouped, 'ungrouped pickable kinds').toEqual([])

    const counts = new Map<string, number>()
    for (const g of WIDGET_USE_CASE_GROUPS) {
      for (const k of g.kinds) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([k]) => k)
    expect(duplicated, 'kinds listed in more than one group').toEqual([])
  })

  it('does not list kinds that are absent from the catalog or hidden', () => {
    const pickable = new Set(visible.map((e) => e.kind))
    const bogus = WIDGET_USE_CASE_GROUPS.flatMap((g) => g.kinds).filter((k) => !pickable.has(k))
    expect(bogus, 'grouped kinds that are not pickable').toEqual([])
  })

  it('returns every widget across the groups, and no empty group', () => {
    const groups = groupedPickerEntries(visible)
    expect(groups.flatMap((g) => g.entries)).toHaveLength(visible.length)
    expect(groups.every((g) => g.entries.length > 0)).toBe(true)
    // The "More" fallback exists for safety; nothing should be falling into it.
    expect(groups.map((g) => g.name)).not.toContain('More')
  })

  it('falls back to More rather than dropping an ungrouped widget', () => {
    // A widget added to the catalog but forgotten in the groups must still be
    // reachable — silently vanishing from the picker is the bad failure here.
    const stray = { ...visible[0], kind: 'definitely-not-grouped' } as (typeof visible)[number]
    const groups = groupedPickerEntries([...visible, stray])
    const more = groups.find((g) => g.name === 'More')
    expect(more?.entries.map((e) => e.kind)).toEqual(['definitely-not-grouped'])
    expect(groups.flatMap((g) => g.entries)).toHaveLength(visible.length + 1)
  })
})
