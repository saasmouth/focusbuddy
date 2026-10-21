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

// 4.3.32: the Tile, TileGrid and SubHeading the accordion draws moved to
// nav/menuParts.tsx so the new Widgets section could share them. The menu is
// still one menu, so its source is read as the two files together.
const accordion =
  read('renderer/src/components/nav/AreaAccordion.tsx') + '\n' + read('renderer/src/components/nav/menuParts.tsx')
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
    // The heading now names the active org — apps are org-scoped, and a tile
    // that does not say whose account it is is a trap — so the anchor is the
    // stable part of a heading that is otherwise built per org.
    expect(accordion.indexOf('label="Tools"')).toBeLessThan(
      accordion.indexOf("'Connected apps — ")
    )
    const connected = accordion.slice(accordion.indexOf("'Connected apps — "))
    expect(connected).toContain('<TileGrid>')
    expect(connected).toContain('<AppLogo')
  })

  it('Work widgets sit directly under the office apps and directly above connected apps (4.3.32)', () => {
    // Owner: "move the Work widgets section so it sits directly UNDER the
    // office apps section and directly ABOVE the connected apps section".
    // Connected apps became their own section to make that possible.
    const tools = accordion.indexOf('label="Tools"')
    const widgets = accordion.indexOf('id="widgets"', accordion.indexOf('export default function AreaAccordion'))
    const connected = accordion.indexOf('id="connected"')
    expect(tools).toBeGreaterThan(-1)
    expect(widgets).toBeGreaterThan(tools)
    expect(connected).toBeGreaterThan(widgets)
    expect(accordion.indexOf("'Connected apps — ")).toBeGreaterThan(connected)
    // Nothing between them: the Apps section closes, Work widgets opens.
    const between = accordion.slice(tools, widgets)
    expect(between.match(/<Section\b/g) ?? []).toHaveLength(1)
  })

  it('an existing user who had Apps folded keeps connected apps folded; nothing else is reset', () => {
    // Only open/closed is persisted (never an order), so the move needs no
    // migration; the new section inherits the old Apps choice once.
    expect(accordion).toContain('connected: parsed.connected ?? parsed.apps ?? true')
    expect(accordion).toContain('widgets: parsed.widgets ?? true')
  })

  it('then People and Brain, with their subsections', () => {
    expect(accordion.indexOf("'Connected apps — ")).toBeLessThan(
      accordion.indexOf('label="People"')
    )
    expect(accordion.indexOf('label="People"')).toBeLessThan(accordion.indexOf('label="PlexiiBrain"'))
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
    expect(vault!.label).toBe('PlexiiVault')
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

// ── The second pass on the menu ───────────────────────────────────────────
// "All icons have colour; PlexiiApps full colour not just outlined; tools a
// grid too with the same rules; titles must never wrap — drop grid columns
// instead; remove the duplicate organisation selector; move the library to the
// office dashboard."

describe('every icon carries colour', () => {
  const registry = read('renderer/src/lib/segmentApps.ts')

  it('the colour lives on the one registry, not per menu', () => {
    // It was in segments.tsx and twice more in the Office shell, which is how
    // the same app could be sky in one place and grey in another.
    expect(registry).toContain('tone?: string')
    expect((registry.match(/tone: 'text-/g) ?? []).length).toBeGreaterThanOrEqual(30)
  })

  it('rows, tiles and section headers all use it', () => {
    expect(accordion).toContain('tone={a.tone}')
    expect(accordion).toContain('tone={d.tone}')
    expect(accordion).toContain('SECTION_TONE[id]')
  })

  it('icons are FILLED, since an outline reads grey at this size', () => {
    expect((accordion.match(/filled/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('the active item still wins over the icon’s own hue', () => {
    expect(accordion).toContain("active ? '' : (tone ?? ")
  })
})

describe('three grids on the same rules', () => {
  it('Tools is a grid, like PlexiiApps and Connected apps', () => {
    const tools = accordion.slice(
      accordion.indexOf('<SubHeading label="Tools" />'),
      accordion.indexOf("'Connected apps — ")
    )
    expect(tools).toContain('<TileGrid>')
    expect(tools).toContain('<Tile')
    expect(tools).not.toContain('<Row')
  })

  it('all three use the same TileGrid', () => {
    expect((accordion.match(/<TileGrid>/g) ?? []).length).toBe(3)
  })
})

describe('a name never wraps', () => {
  it('tile labels are single-line and truncate', () => {
    expect(accordion).toContain('truncate whitespace-nowrap')
    // The old behaviour: two lines per tile.
    expect(accordion).not.toContain('line-clamp-2')
  })

  it('row labels do not wrap either', () => {
    expect(accordion).toContain('min-w-0 truncate text-left whitespace-nowrap')
  })

  it('the COLUMN COUNT gives way instead, following the menu width', () => {
    // auto-fit + a minimum tile width drops 4 columns to 3 to 2 as the menu
    // narrows, in CSS, so it also tracks a live drag-resize.
    expect(accordion).toContain('repeat(auto-fit, minmax(')
    expect(accordion).toContain('TILE_MIN')
    // The fixed four-column grid is gone from the CODE. The phrase survives in
    // a comment explaining what it used to be, which is worth keeping — so
    // this asserts the class is not applied, not that the words are absent.
    expect(accordion).not.toContain('className="grid grid-cols-4')
  })

  it('the full name survives in the tooltip when it is clipped', () => {
    // And, in the personal aggregate, which org's account it is — a clipped
    // label plus an org label is two things the tooltip has to carry.
    // 4.3.32: the tooltip may carry a second line (a Work widgets tile's hint),
    // but its first line is still the full name, with the org when there is one.
    expect(accordion).toContain('title={[note ? `${label} — ${note}` : label, hint].filter(Boolean).join')
  })
})

describe('the duplicate organisation selector is gone', () => {
  it('the office menu mounts exactly one', () => {
    expect((office.match(/<WorkspaceSwitcher \/>/g) ?? []).length).toBe(1)
  })

  it('and so does every other menu', () => {
    for (const [name, src] of [
      ['desk sidebar', sidebar],
      ['segment shell', segment]
    ] as const) {
      expect((src.match(/<WorkspaceSwitcher \/>/g) ?? []).length, name).toBe(1)
    }
  })
})

describe('the library moved to the office dashboard', () => {
  it('is rendered on the dashboard, beside the documents it filters', () => {
    expect(office).toContain('data-testid="office-library-nav"')
    expect(office).toContain('LIBRARY_PAGES')
  })

  it('is no longer a block inside the menu', () => {
    // Again: the prop is gone, though a comment still records where it went.
    expect(accordion).not.toContain('appsExtra?:')
    expect(accordion).not.toContain('{appsExtra}')
    expect(office).not.toContain('appsExtra={')
  })

  it('still reaches the same pages, so nothing became unreachable', () => {
    // The testid is templated, so assert the template plus the page list that
    // feeds it rather than six literal strings that do not appear in source.
    expect(office).toContain('data-testid={`office-nav-${n.id}`}')
    const block = office.slice(office.indexOf('const LIBRARY_PAGES'))
    for (const id of ['recent', 'starred', 'shared', 'templates', 'trash']) {
      expect(block, `${id} page`).toContain(`id: '${id}'`)
    }
  })
})

describe('the Desk section offers nothing twice (owner, 2026-10-21)', () => {
  // "Remove [Workspaces, Agentic Ops, Recent, Desks] — they are duplicates of
  // other menu functions. Move Home to the top." Each removed row names where
  // the same place is reached, so a future reader can check the claim.
  const desk = SEGMENT_APPS.plexidesk
  const byKey = (k: string) => desk.find((a) => a.key === k)

  it('Home is the first row of the Desk section, and the only Home in it', () => {
    const body = accordion.slice(accordion.indexOf('{deskSlot ?? ('))
    expect(body.indexOf('label="Home"')).toBeGreaterThan(-1)
    expect(body.indexOf('label="Home"')).toBeLessThan(body.indexOf('DESK_VIEWS.map'))
    expect(byKey('home')!.notInMenu).toBeTruthy()
  })

  it('hides the four duplicates, each with its reason, and keeps My Desk and Plans', () => {
    for (const k of ['workspaces', 'tasks', 'recent']) {
      expect(byKey(k)!.notInMenu, `${k} says where it lives instead`).toMatch(/\w{4,}/)
    }
    // Agentic Ops is not hidden but MOVED: it left the Desk registry entirely.
    expect(byKey('ops')).toBeUndefined()
    expect(byKey('desk')!.notInMenu).toBeUndefined()
    expect(byKey('plans')!.notInMenu).toBeUndefined()
    expect(accordion).toContain('!a.notInMenu &&')
  })

  it('keeps the hidden apps registered, so old links and tray tabs still open', () => {
    const segments = read('renderer/src/components/segment/segments.tsx')
    for (const k of ['workspaces', 'tasks', 'recent']) {
      expect(segments).toContain(`appMeta('plexidesk', '${k}')`)
    }
  })

  it('Agentic Ops moved to PlexiiBrain and opens the same console there', () => {
    // Brain's Agents is a different page (AgentsView); without this row the
    // Agentic Ops console would have had no menu route at all.
    const brainOps = SEGMENT_APPS.plexibrain.find((a) => a.key === 'ops')
    expect(brainOps?.label).toBe('Agentic Ops')
    expect(brainOps?.notInMenu).toBeUndefined()
    const segments = read('renderer/src/components/segment/segments.tsx')
    expect(segments).toMatch(/appMeta\('plexibrain', 'ops'\)[^\n]*<AgenticOpsView \/>/)
    // and it does not share Agents' icon, so the two rows can be told apart
    expect(brainOps!.icon).not.toBe(SEGMENT_APPS.plexibrain.find((a) => a.key === 'agents')!.icon)
  })

  it('old Agentic Ops links, saved views and tray tabs forward to PlexiiBrain', async () => {
    const { MOVED_APPS, movedApp } = await import('../../src/renderer/src/lib/segmentApps')
    expect(MOVED_APPS['plexidesk:ops']).toEqual({ kind: 'plexibrain', app: 'ops' })
    expect(movedApp('plexidesk', 'ops')).toEqual({ kind: 'plexibrain', app: 'ops' })
    expect(movedApp('plexidesk', 'plans')).toEqual({ kind: 'plexidesk', app: 'plans' })
    const view = read('renderer/src/stores/view.ts')
    expect(view).toContain("goPlexiDesk: (app) => commit(movedApp('plexidesk', app)")
    expect(view).toContain('movedApp(loose.kind, app)')
    expect(read('renderer/src/stores/openTray.ts')).toContain('.map(forwardMoved)')
  })
})
