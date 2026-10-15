// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEGMENT_APPS } from '../../src/renderer/src/lib/segmentApps'

// "Migrate and merge desk, office, people, brain tab menus into one single
// vertical accordion menu."
//
// There were four menus and a tab strip above each, so the thing you wanted was
// usually in a menu you could not see. This is the one menu. The assertions
// here are the properties that are invisible until someone notices a row
// missing, which is exactly when a source-level guard earns its keep.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const accordion = read('renderer/src/components/nav/AreaAccordion.tsx')
const sidebar = read('renderer/src/components/Sidebar.tsx')
const office = read('renderer/src/components/office/PlexiOfficeShell.tsx')
const segment = read('renderer/src/components/segment/SegmentShell.tsx')

describe('one menu, mounted everywhere', () => {
  it('every shell renders it', () => {
    for (const [name, src] of [
      ['desk sidebar', sidebar],
      ['office shell', office],
      ['segment shell', segment]
    ] as const) {
      expect(src, `${name} mounts the one menu`).toContain('<AreaAccordion')
    }
  })

  it('none of them still draws its own area tab strip', () => {
    for (const src of [sidebar, office, segment]) {
      expect(src).not.toContain('<SegmentSwitcher />')
    }
  })

  it('the desk sidebar passes its richer desk list in as the Desk section body', () => {
    // The registry-built Desk list is flat. The sidebar's is not: Attention
    // carries six state/due filters and Rooms expands. So it is passed in as
    // the section's body rather than replaced (which would cost both) or left
    // outside the accordion (which cost the Desk section header, and with it
    // the one-click switch back to the desk).
    expect(sidebar).toContain('deskSlot={deskNav}')
    expect(sidebar).toContain('data-testid="sidebar-attention-filters"')
    expect(accordion).toContain('{deskSlot ?? (')
  })
})

describe('the areas stay one click away', () => {
  // c581655d folded the areas into a dropdown and put a dozen-times-an-hour
  // action behind a rarely-used one; it was reverted. An accordion that shipped
  // collapsed, or whose header only folded, would be the same mistake again.
  it('sections default to open', () => {
    expect(accordion).toContain('desk: true')
    expect(accordion).toContain('apps: true')
    expect(accordion).toContain('people: true')
    expect(accordion).toContain('brain: true')
  })

  it('an unreadable stored preference still shows everything', () => {
    expect(accordion).toContain('return allOpen')
  })

  it('each section header still carries the tab strip’s testid and job', () => {
    for (const kind of ['plexidesk', 'office', 'plexipeople', 'plexibrain']) {
      expect(accordion, `${kind} is reachable`).toContain(`kind="${kind}"`)
    }
    expect(accordion).toContain('data-testid={`switch-${kind}`}')
    // Navigating is the header's job; folding is the chevron's.
    expect(accordion).toContain('onActivate()')
    expect(accordion).toContain('if (!open) onToggle()')
  })

  it('an area you are not entitled to says why instead of vanishing', () => {
    expect(accordion).toContain('data-locked="true"')
    expect(accordion).toContain('onLockedClick')
    // Desk is the floor, as it was in the strip.
    expect(accordion).toContain("kind === 'plexidesk' || ent.enabled")
  })
})

describe('Apps — what the operator asked for, in order', () => {
  it('is titled Apps, not Office', () => {
    expect(accordion).toContain('label="Apps"')
  })

  it('lists PlexiiApps as a grid of icons', () => {
    const appsBlock = accordion.slice(accordion.indexOf('<SubHeading label="PlexiiApps"'))
    expect(appsBlock).toContain('<TileGrid>')
    expect(accordion).toContain('PLEXII_APP_KEYS')
  })

  it('then the tools, as rows', () => {
    expect(accordion.indexOf('label="PlexiiApps"')).toBeLessThan(
      accordion.indexOf('label="Tools"')
    )
  })

  it('then connected apps, as a grid, underneath', () => {
    expect(accordion.indexOf('label="Tools"')).toBeLessThan(
      accordion.indexOf('label="Connected apps"')
    )
    const connected = accordion.slice(accordion.indexOf('label="Connected apps"'))
    expect(connected).toContain('<TileGrid>')
    expect(connected).toContain('<AppLogo')
  })

  it('then People and Brain, with their subsections', () => {
    expect(accordion.indexOf('label="Connected apps"')).toBeLessThan(
      accordion.indexOf('label="People"')
    )
    expect(accordion.indexOf('label="People"')).toBeLessThan(accordion.indexOf('label="Brain"'))
    // Their subsections are the registry's, not a second copy.
    expect(accordion).toContain('SEGMENT_APPS.plexipeople')
    expect(accordion).toContain('SEGMENT_APPS.plexibrain')
  })

  it('says so honestly when there are no connected apps', () => {
    // A grid that renders nothing reads as broken, and sample tiles would be
    // worse than an empty state.
    expect(accordion).toContain('None yet')
  })
})

describe('the Vault moved into Apps', () => {
  it('is registered as an Apps surface', () => {
    const vault = SEGMENT_APPS.office.find((a) => a.key === 'vault')
    expect(vault, 'the Vault is an office app').toBeTruthy()
    expect(vault!.label).toBe('Vault')
  })

  it('renders inside the shell rather than throwing you out of Apps', () => {
    const comms = office.slice(office.indexOf('const COMMS_APPS'), office.indexOf('COMMS_VIEW_KIND'))
    expect(comms).toContain("key: 'vault'")
    expect(comms).toContain("section: 'apps'")
    expect(comms).toContain('<VaultView />')
  })

  it('is still gated on the capability the standalone view checks', () => {
    // Moving it must not become a way around password_vault.
    expect(office).toContain("vault: 'vault'")
    expect(SEGMENT_APPS.office.find((a) => a.key === 'vault')!.gateKind).toBe('vault')
  })

  it('is listed with the tools, where a place you open belongs', () => {
    expect(accordion).toContain("'vault'")
    expect(accordion).toContain('TOOL_KEYS')
  })
})

describe('the registry is the single source', () => {
  it('no row is a dead affordance: every gated one is hidden', () => {
    expect(accordion).toContain('!a.gateKind || enabled(a.gateKind)')
  })

  it('gates live on the registry, not in a third copy', () => {
    const segments = read('renderer/src/components/segment/segments.tsx')
    // segments.tsx used to set them inline and the office shell kept its own
    // map; two copies is how one ends up missing an entry.
    expect(segments).not.toMatch(/gateKind: '[a-z-]+'/)
  })

  it('Calendar and Files are listed in ONE area, not two', () => {
    // 4.3.25 moved them into Office, but the desk registry kept copies — so
    // both were listed twice and two tray tabs read "Calendar".
    const deskKeys = SEGMENT_APPS.plexidesk.map((a) => a.key)
    expect(deskKeys).not.toContain('calendar')
    expect(deskKeys).not.toContain('files')
    const officeKeys = SEGMENT_APPS.office.map((a) => a.key)
    expect(officeKeys).toContain('calendar')
    expect(officeKeys).toContain('files')
  })
})
