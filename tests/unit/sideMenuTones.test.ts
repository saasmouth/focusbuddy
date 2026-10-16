import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AREA_TONES, attentionFilterTone, type AreaId } from '../../src/renderer/src/lib/areaTones'
import { ATTENTION_FILTERS } from '../../src/renderer/src/lib/attentionQueues'

// "Make sure every option in the side menu is coloured and consistent, eg,
// home, attention, rooms and their sub menus."
//
// Two separate faults sat behind that. The desk half of the menu rendered
// through `NavRow`, which took a `tone` prop and DELIBERATELY ignored it — the
// hues had been stripped on the reasoning that per-row colour is noise, which
// held for a flat list of twelve peers and stopped holding when the four menus
// merged into one long sectioned list. And the tone map had been forked twice,
// so the same concept arrived in two colours depending on which component drew
// it: Rooms was sky in one and teal in the other.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const tones = read('renderer/src/lib/areaTones.ts')
const sidebar = read('renderer/src/components/Sidebar.tsx')
const accordion = read('renderer/src/components/nav/AreaAccordion.tsx')

describe('every side-menu row is actually coloured', () => {
  it('NavRow honours its tone instead of voiding it', () => {
    // The literal bug: `void tone` meant every prop below was decorative.
    expect(sidebar).not.toContain('void tone')
    expect(sidebar).toContain("active ? '' : (tone ?? 'text-[var(--ink-50)]')")
  })

  it('and renders filled icons, like the other half of the same menu', () => {
    // An outline at 17px reads as grey whatever colour it is given, and an
    // outlined icon beside a filled one reads as a different kind of thing.
    expect(sidebar).toContain('<Icon name={icon} size={17} filled />')
    expect(accordion).toContain('<Icon name={icon} size={17} filled />')
  })

  it('the active row still wins over the icon’s own hue', () => {
    for (const [name, src] of [
      ['sidebar', sidebar],
      ['accordion', accordion]
    ] as const) {
      expect(src, name).toContain("active ? '' : (tone ?? ")
    }
  })
})

describe('one tone map, not three', () => {
  it('neither menu carries its own colour literals', () => {
    // Both render into the SAME menu — the accordion's own desk list when there
    // is no `deskSlot`, the Sidebar's when there is — so a literal in either is
    // a fork waiting to drift.
    const deskViews = accordion.slice(
      accordion.indexOf('const DESK_VIEWS'),
      accordion.indexOf('type SectionId')
    )
    expect(deskViews).not.toMatch(/tone:\s*'text-/)
    const sections = accordion.slice(
      accordion.indexOf('const SECTIONS'),
      accordion.indexOf('const OPEN_KEY') > -1
        ? accordion.indexOf('const OPEN_KEY')
        : accordion.indexOf('function readOpen')
    )
    expect(sections).not.toMatch(/tone:\s*'text-/)
  })

  it('both read from AREA_TONES', () => {
    expect(accordion).toContain("import { AREA_TONES } from '../../lib/areaTones'")
    expect(sidebar).toContain("import { AREA_TONES, attentionFilterTone } from '../lib/areaTones'")
  })

  it('the clash that proved the fork is gone', () => {
    // Rooms was sky here and teal there; Desks was teal here and sky there.
    // Whatever they are now, they must be ONE value each.
    expect(AREA_TONES.rooms).not.toBe(AREA_TONES.desks)
    const roomsLiterals = (accordion + sidebar).match(/tone:\s*'text-(sky|teal)-500'/g) ?? []
    expect(roomsLiterals).toHaveLength(0)
  })
})

describe('the rows the operator named have their own tone', () => {
  it('Home, Attention, Rooms and Trash are each distinct', () => {
    const named: AreaId[] = ['home', 'attention', 'rooms', 'desks', 'shared', 'trash']
    const used = named.map((n) => AREA_TONES[n])
    expect(new Set(used).size, `duplicate tones among ${named.join(', ')}`).toBe(named.length)
  })

  it('Attention no longer borrows the Desks tone', () => {
    // It had none of its own, so it wore teal — the one row whose job is to
    // say "something needs you" looked like a filing location.
    expect(sidebar).toContain('tone={AREA_TONES.attention}')
    expect(AREA_TONES.attention).toBe('text-amber-500')
  })

  it('Trash is deliberately drab rather than accidentally uncoloured', () => {
    expect(sidebar).toContain('tone={AREA_TONES.trash}')
    expect(AREA_TONES.trash).toContain('slate')
    expect(tones).toContain('a coloured bin competes with real work')
  })

  it('the collapsed rail agrees with the expanded rows', () => {
    // Same destination, same hue, whichever width the sidebar is at. The rail
    // had voided its tone too, while the prop's own comment claimed otherwise.
    const rail = sidebar.slice(sidebar.indexOf('<CollapsedNavIcon'))
    expect(rail).toContain('label="Attention"    tone={AREA_TONES.attention}')
    expect(rail).toContain('label="Trash"        tone={AREA_TONES.trash}')
    expect(sidebar).toContain(
      "`${tone ?? 'text-[var(--ink-50)]'} hover:bg-[var(--surface-sunken)]`"
    )
  })
})

describe('the sub-menus are coloured too, which was the other half of the ask', () => {
  it('every Attention filter resolves to a tone', () => {
    for (const f of ATTENTION_FILTERS) {
      expect(attentionFilterTone(f.id), f.id).toMatch(/^text-/)
    }
  })

  it('and they are not all the same hue', () => {
    // Six different questions had looked like one row repeated.
    const used = new Set(ATTENTION_FILTERS.map((f) => attentionFilterTone(f.id)))
    expect(used.size).toBeGreaterThan(4)
  })

  it('the sidebar asks per filter rather than passing one tone for all six', () => {
    expect(sidebar).toContain('tone={attentionFilterTone(f.id)}')
  })

  it('a filter added without a colour falls back to Attention, not to grey', () => {
    expect(attentionFilterTone('a-filter-nobody-has-written-yet')).toBe(AREA_TONES.attention)
  })

  it('overdue is the warning colour and closed is resolved', () => {
    // The set should read as a temperature rather than as six arbitrary hues.
    expect(attentionFilterTone('overdue')).toContain('red')
    expect(attentionFilterTone('closed-7d')).toContain('emerald')
  })
})

describe('the reversal is recorded, not quietly made', () => {
  it('NavRow explains why the hues came back', () => {
    // An earlier decision in this same file removed them with a stated reason.
    // Flipping that silently would leave the next person to rediscover both
    // arguments from scratch.
    expect(sidebar).toContain('This reverses an earlier decision')
    expect(sidebar).toContain('It stopped holding when the four area menus merged')
  })

  it('areaTones says why it is the source of truth', () => {
    expect(tones).toContain('it was forked twice')
  })
})

// ── Dragging onto a desk ──────────────────────────────────────────────────
// "I'm no longer able to drag tools, apps and connected apps to the desks
// from the sidebar."
//
// Connected apps WERE draggable at 4.3.26, from the row list and the
// collapsed rail. Removing the duplicate row list took the affordance with
// it, because the grid that replaced it never had one — and I claimed twice
// that dragging "still works from the grid tiles" without checking. These
// assert the wiring exists rather than trusting that again.

describe('tiles can be dragged onto a desk', () => {
  const accordion = read('renderer/src/components/nav/AreaAccordion.tsx')
  const canvas = read('renderer/src/components/Canvas.tsx')

  it('a connected app sets the three types the canvas reads', () => {
    expect(accordion).toContain('e.dataTransfer.setData(CONNECTED_APP_DRAG_MIME, app.id)')
    expect(accordion).toContain("e.dataTransfer.setData('text/uri-list', app.url)")
    expect(accordion).toContain("e.dataTransfer.setData('text/plain', app.url)")
  })

  it('and the canvas still reads that type, so the drop lands', () => {
    // The pair that matters: a source setting a MIME nothing consumes is the
    // same bug in a different place.
    expect(canvas).toContain('e.dataTransfer.getData(CONNECTED_APP_DRAG_MIME)')
  })

  it('apps and tools drag as widget kinds', () => {
    expect(accordion).toContain('e.dataTransfer.setData(DRAG_MIME, kind)')
    expect(accordion).toContain('onDragStart={tileDrag(a.key)}')
    expect(canvas).toContain('e.dataTransfer.getData(DRAG_MIME)')
  })

  it('every mapped kind is a real widget in the catalogue', () => {
    // A mapping to a kind that does not exist would drop nothing, silently.
    const catalog = read('renderer/src/lib/widgetCatalog.ts')
    const map = accordion.slice(
      accordion.indexOf('const TILE_WIDGET_KIND'),
      accordion.indexOf('}', accordion.indexOf('const TILE_WIDGET_KIND'))
    )
    const kinds = [...map.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1])
    expect(kinds.length).toBeGreaterThan(5)
    for (const k of kinds) {
      expect(catalog, `no widget kind '${k}' in the catalogue`).toContain(`kind: '${k}'`)
    }
  })

  it('a tile with no widget equivalent is NOT draggable', () => {
    // sign, meet and vault have nowhere to land. A grab cursor that does
    // nothing on release is worse than no affordance at all.
    const map = accordion.slice(
      accordion.indexOf('const TILE_WIDGET_KIND'),
      accordion.indexOf('}', accordion.indexOf('const TILE_WIDGET_KIND'))
    )
    // Matched at a line boundary: a plain substring check for "sign:" also
    // matches "design: 'design'", which is a real mapping.
    for (const key of ['sign', 'meet', 'vault']) {
      expect(
        new RegExp(`^\\s*${key}:`, 'm').test(map),
        `${key} should have no widget mapping`
      ).toBe(false)
    }
    expect(accordion).toContain('if (!kind) return undefined')
  })

  it('the Tile only advertises dragging when it can actually drag', () => {
    expect(accordion).toContain('draggable={!!onDragStart}')
    expect(accordion).toContain("onDragStart ? 'cursor-grab active:cursor-grabbing ' : ''")
  })

  it('the collapsed rail kept its drag, which never broke', () => {
    const sidebar = read('renderer/src/components/Sidebar.tsx')
    expect(sidebar).toContain('e.dataTransfer.setData(CONNECTED_APP_DRAG_MIME, app.id)')
  })
})
