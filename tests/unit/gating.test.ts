import { describe, it, expect } from 'vitest'
import {
  isEnabledValue,
  isCapabilityEnabled,
  limitForValue,
  limitFor,
  canCreateMore,
  canCreateWidget,
  capabilityForWidgetKind,
  limitLabel,
  defaultsForTier,
  type CapabilityMap
} from '@renderer/lib/gating'

// These tests are the contract: "the capability matrix governs access."
// If an admin flips a tick-box or changes a numeric limit, the resolved map
// the server returns changes, and these functions must change their verdict.

describe('isEnabledValue', () => {
  it('booleans pass through', () => {
    expect(isEnabledValue(true)).toBe(true)
    expect(isEnabledValue(false)).toBe(false)
  })
  it('numbers: >0 is on, 0 is off', () => {
    expect(isEnabledValue(3)).toBe(true)
    expect(isEnabledValue(0)).toBe(false)
  })
  it('strings: non-empty/not "off" is on', () => {
    expect(isEnabledValue('Unlimited')).toBe(true)
    expect(isEnabledValue('$5/mo')).toBe(true)
    expect(isEnabledValue('off')).toBe(false)
    expect(isEnabledValue('')).toBe(false)
  })
  it('undefined is off', () => {
    expect(isEnabledValue(undefined)).toBe(false)
  })
})

describe('isCapabilityEnabled — boolean gates from the matrix', () => {
  it('free user cannot use a Pro-only capability by default', () => {
    // Uses caps that remain Pro-gated under the land-grab pricing. Real-time
    // collaboration (chat, meet, calls, presence, sharing) is now free to drive
    // adoption; the paid wall is heavy-consumption and convenience — cloud vault
    // backup, the live AI body double, and unlimited workspace history.
    const free = defaultsForTier('free')
    expect(isCapabilityEnabled(free, 'vault_backup')).toBe(false)
    expect(isCapabilityEnabled(free, 'body_double')).toBe(false)
    expect(isCapabilityEnabled(free, 'workspace_history')).toBe(false)
  })
  it('pro user can use Pro capabilities', () => {
    const pro = defaultsForTier('pro')
    expect(isCapabilityEnabled(pro, 'vault_backup')).toBe(true)
    expect(isCapabilityEnabled(pro, 'body_double')).toBe(true)
  })
  it('an ADMIN OVERRIDE that enables a cap for free flips the verdict', () => {
    // Simulates the server having merged an admin override: free user, but
    // widget_table turned on for them in the matrix.
    const freeWithOverride: CapabilityMap = { ...defaultsForTier('free'), widget_table: true }
    expect(isCapabilityEnabled(freeWithOverride, 'widget_table')).toBe(true)
  })
  it('an ADMIN OVERRIDE that disables a cap for pro flips the verdict', () => {
    const proWithOverride: CapabilityMap = { ...defaultsForTier('pro'), body_double: false }
    expect(isCapabilityEnabled(proWithOverride, 'body_double')).toBe(false)
  })
})

describe('limitForValue — numeric limits', () => {
  it('a number is the literal limit', () => {
    expect(limitForValue(3)).toBe(3)
    expect(limitForValue(1)).toBe(1)
  })
  it('"Unlimited" (and other non-numeric truthy strings) → null = unlimited', () => {
    expect(limitForValue('Unlimited')).toBeNull()
  })
  it('numeric strings parse', () => {
    expect(limitForValue('5')).toBe(5)
  })
  it('false / "off" → 0 (feature off)', () => {
    expect(limitForValue(false)).toBe(0)
    expect(limitForValue('off')).toBe(0)
  })
  it('boolean true → null = unlimited', () => {
    expect(limitForValue(true)).toBeNull()
  })
})

describe('canCreateMore — numeric limit logic', () => {
  // Tests the limit LOGIC with explicit maps, independent of what any tier is
  // priced at (the free desk count is now Unlimited under land-grab pricing, so
  // we assert the function, not a specific tier value).
  const capped: CapabilityMap = { multiple_desks: 3 }
  const unlimited: CapabilityMap = { multiple_desks: 'Unlimited' }

  it('a numeric limit allows up to the limit and blocks at it', () => {
    expect(limitFor(capped, 'multiple_desks')).toBe(3)
    expect(canCreateMore(capped, 'multiple_desks', 0)).toBe(true)
    expect(canCreateMore(capped, 'multiple_desks', 2)).toBe(true) // creating the 3rd
    expect(canCreateMore(capped, 'multiple_desks', 3)).toBe(false) // would be the 4th
    expect(canCreateMore(capped, 'multiple_desks', 5)).toBe(false)
  })
  it('Unlimited never blocks', () => {
    expect(limitFor(unlimited, 'multiple_desks')).toBeNull()
    expect(canCreateMore(unlimited, 'multiple_desks', 999)).toBe(true)
  })
  it('free tier is capped at three desks under current pricing', () => {
    // Was asserted as unlimited, which is what the configuration said while the
    // creation path carried a check and a comment describing a three-desk cap.
    // The test was faithful to the config and the config was the thing that was
    // wrong, so neither could catch it. Pricing now matches the intent.
    expect(limitFor(defaultsForTier('free'), 'multiple_desks')).toBe(3)
    expect(canCreateMore(defaultsForTier('free'), 'multiple_desks', 2)).toBe(true)
    expect(canCreateMore(defaultsForTier('free'), 'multiple_desks', 3)).toBe(false)
  })
})

describe('canCreateWidget — palette gating', () => {
  const free = defaultsForTier('free')
  const pro = defaultsForTier('pro')

  it('maps known kinds to capability keys', () => {
    expect(capabilityForWidgetKind('table')).toBe('widget_table')
    expect(capabilityForWidgetKind('note')).toBe('widget_notes')
    expect(capabilityForWidgetKind('totally-unknown')).toBeNull()
  })
  it('a widget whose capability is off is blocked; ungated + enabled kinds allowed', () => {
    // Explicit map so this tests the gating logic, not a tier price point (all
    // widgets are free under current pricing).
    const gated: CapabilityMap = { widget_table: false, widget_notes: true }
    expect(canCreateWidget(gated, 'table')).toBe(false)
    expect(canCreateWidget(gated, 'note')).toBe(true)
    expect(canCreateWidget(gated, 'image')).toBe(true) // ungated kind
  })
  it('widgets are all creatable on the free tier under current pricing', () => {
    expect(canCreateWidget(free, 'table')).toBe(true)
    expect(canCreateWidget(free, 'note')).toBe(true)
  })
  it('pro user can create the Table widget', () => {
    expect(canCreateWidget(pro, 'table')).toBe(true)
  })
  it('admin override disabling widget_table for a user locks the palette tile', () => {
    const override: CapabilityMap = { ...free, widget_table: false }
    expect(canCreateWidget(override, 'table')).toBe(false)
  })
})

describe('limitLabel', () => {
  it('renders numeric + unlimited', () => {
    expect(limitLabel({ multiple_desks: 3 } as CapabilityMap, 'multiple_desks')).toBe('3')
    expect(limitLabel({ multiple_desks: 'Unlimited' } as CapabilityMap, 'multiple_desks')).toBe('Unlimited')
  })
})

// The canvas guarantee (product decision): the five office document types can
// always be created ON THE CANVAS as widgets, regardless of PlexiOffice
// entitlement. Office licensing gates the standalone suite (the Office area,
// Drive, quick-create), never the desk canvas. If someone ever adds one of
// these to WIDGET_KIND_CAPABILITY, this test fails on purpose.
describe('canvas office-doc widgets are never gated by Office', () => {
  const officeOff: CapabilityMap = {
    product_office: false,
    office_docs: false,
    office_sheets: false,
    office_slides: false,
    office_draw: false,
    office_design: false
  }
  for (const kind of ['doc', 'sheet', 'slides', 'map', 'design']) {
    it(`allows creating a ${kind} widget on the canvas with Office fully off`, () => {
      expect(capabilityForWidgetKind(kind)).toBeNull()
      expect(canCreateWidget(officeOff, kind)).toBe(true)
    })
  }
})
