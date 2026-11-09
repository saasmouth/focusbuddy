// Best placement: the half of the owner's starting-sizes standard that says
// where a new widget goes when nobody chose a spot.
import { describe, it, expect } from 'vitest'
import { GRID } from '../../src/renderer/src/lib/canvasGrid'
import { WIDGET_START_SIZES } from '../../src/shared/widgetStartSizes'
import {
  PLACEMENT_GRID,
  REFERENCE_VIEW,
  WIDGET_START_ZONES,
  placeInZone,
  placeOnDesk,
  planZoneLayout,
  zoneFor,
  type PlacementRect,
  type StartZone
} from '../../src/shared/widgetPlacement'

const VIEW = REFERENCE_VIEW
const place = (
  zone: StartZone,
  width: number,
  height: number,
  obstacles: PlacementRect[] = [],
  view = VIEW
): { x: number; y: number } | null => placeInZone({ zone, width, height, view, obstacles })

// Spelled out rather than imported, so a change to the table shows up here.
const STANDARD: Record<StartZone, string[]> = {
  main: ['doc', 'sheet', 'slides', 'draw', 'map', 'design', 'webview', 'table', 'mindmap', 'diagram'],
  second: [
    'note',
    'page',
    'chart',
    'markdown',
    'living-doc',
    'custom',
    'gallery',
    'scratchpad',
    'image-gen',
    'location-map',
    'custom-block',
    'portal',
    'pdf',
    'gdoc',
    'gsheet',
    'gslide',
    'email',
    'image',
    'video'
  ],
  right: ['inbox', 'calendar', 'chat-thread', 'task-list', 'attention', 'agent', 'mail-thread'],
  left: ['drive', 'contacts'],
  top: ['metrics', 'stat-card', 'streamdeck'],
  corner: [
    'sticky',
    'timer',
    'card',
    'voice-recorder',
    'file',
    'webhook',
    'inbound-hook',
    'field',
    'task-link',
    'calculator',
    'color',
    'shape',
    'local-app-launcher'
  ],
  around: ['section']
}

describe('the zones in the standard', () => {
  it('uses the canvas grid', () => {
    expect(PLACEMENT_GRID).toBe(GRID)
  })

  it.each(Object.entries(STANDARD))('%s holds what the standard puts there', (zone, kinds) => {
    for (const kind of kinds) expect(zoneFor(kind), kind).toBe(zone)
  })

  it('covers every kind in the size table except the two the standard does not place', () => {
    const unplaced = Object.keys(WIDGET_START_SIZES).filter((k) => !zoneFor(k))
    expect(unplaced.sort()).toEqual(['meeting-record', 'minimap'])
  })

  it('has no kind beyond the standard', () => {
    expect(Object.keys(WIDGET_START_ZONES).sort()).toEqual(Object.values(STANDARD).flat().sort())
  })

  it('has no zone for an unknown kind', () => {
    expect(zoneFor('not-a-kind')).toBeNull()
  })
})

describe('an empty view', () => {
  it('puts the main item at the left edge', () => {
    expect(place('main', 960, 660)).toEqual({ x: 20, y: 20 })
  })

  it('runs a top-band item along the top from the left', () => {
    expect(place('top', 420, 240)).toEqual({ x: 20, y: 20 })
  })

  it('puts a left-rail item at the left edge', () => {
    expect(place('left', 300, 340)).toEqual({ x: 20, y: 20 })
  })

  it('puts a right-rail item against the right edge, on the grid', () => {
    expect(place('right', 420, 420)).toEqual({ x: 880, y: 20 })
  })

  it('puts a corner item in the top-right corner', () => {
    expect(place('corner', 200, 200)).toEqual({ x: 1100, y: 20 })
  })

  it('starts the second column at the middle when there is no main item', () => {
    expect(place('second', 420, 420)).toEqual({ x: 680, y: 20 })
  })

  it('centres a section', () => {
    const at = place('around', 740, 340)!
    expect(Math.abs(at.x + 370 - 664)).toBeLessThanOrEqual(20)
    expect(Math.abs(at.y + 170 - 445)).toBeLessThanOrEqual(20)
  })
})

describe('with things already there', () => {
  it('stacks corner items down the corner', () => {
    const first: PlacementRect = { x: 1100, y: 20, width: 200, height: 200 }
    expect(place('corner', 200, 200, [first])).toEqual({ x: 1100, y: 240 })
  })

  it('stacks the right rail top to bottom', () => {
    const first: PlacementRect = { x: 880, y: 20, width: 420, height: 420 }
    expect(place('right', 420, 380, [first])).toEqual({ x: 880, y: 460 })
  })

  it('moves the corner to the next column when the first is full', () => {
    const col: PlacementRect = { x: 1100, y: 20, width: 200, height: 860 }
    expect(place('corner', 200, 200, [col])).toEqual({ x: 880, y: 20 })
  })

  it('puts a second-column item right after the main item', () => {
    const main: PlacementRect = { x: 20, y: 20, width: 740, height: 440, kind: 'table' }
    expect(place('second', 420, 420, [main])).toEqual({ x: 780, y: 20 })
  })

  it('ignores a main item that is off screen', () => {
    const far: PlacementRect = { x: 4000, y: 4000, width: 740, height: 440, kind: 'table' }
    expect(place('second', 420, 420, [far])).toEqual({ x: 680, y: 20 })
  })

  it('moves a main item along the top past one already there', () => {
    const first: PlacementRect = { x: 20, y: 20, width: 300, height: 860 }
    expect(place('main', 740, 440, [first])).toEqual({ x: 340, y: 20 })
  })

  it('returns null when the zone has no room, so the caller can use its older rule', () => {
    const wall: PlacementRect = { x: 0, y: 0, width: 1328, height: 891 }
    expect(place('corner', 200, 200, [wall])).toBeNull()
  })

  it('returns null when the item is bigger than the view', () => {
    expect(place('main', 2000, 660)).toBeNull()
  })
})

describe('wherever the camera is', () => {
  const view = { left: -513, top: 307, width: 1100, height: 700 }

  it('stays inside the view', () => {
    for (const zone of Object.keys(STANDARD) as StartZone[]) {
      const at = place(zone, 300, 200, [], view)!
      expect(at.x, zone).toBeGreaterThanOrEqual(view.left)
      expect(at.y, zone).toBeGreaterThanOrEqual(view.top)
      expect(at.x + 300, zone).toBeLessThanOrEqual(view.left + view.width)
      expect(at.y + 200, zone).toBeLessThanOrEqual(view.top + view.height)
    }
  })

  it('stays on the grid even when the view does not', () => {
    for (const zone of Object.keys(STANDARD) as StartZone[]) {
      const at = place(zone, 300, 200, [], view)!
      expect(Math.abs(at.x % GRID), zone).toBe(0)
      expect(Math.abs(at.y % GRID), zone).toBe(0)
    }
  })

  it('still answers on a desk zoomed far out', () => {
    const huge = { left: 0, top: 0, width: 40000, height: 30000 }
    expect(place('corner', 200, 200, [], huge)).toEqual({ x: 39780, y: 20 })
  })
})

const clashes = (a: PlacementRect, b: PlacementRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('never on top of anything', () => {
  it('holds across a hundred scattered desks', () => {
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 16807) % 2147483647
      return seed % n
    }
    const zones = Object.keys(STANDARD) as StartZone[]
    for (let round = 0; round < 100; round++) {
      const obstacles: PlacementRect[] = Array.from({ length: next(12) }, () => ({
        x: next(1200),
        y: next(800),
        width: 100 + next(400),
        height: 100 + next(300)
      }))
      const width = 200 + next(300)
      const height = 120 + next(240)
      const at = place(zones[round % zones.length], width, height, obstacles)
      if (!at) continue
      for (const o of obstacles) expect(clashes({ ...at, width, height }, o)).toBe(false)
    }
  })
})

describe('laying out a whole batch', () => {
  it('gives the main stage to the editor even when it is listed last', () => {
    const spots = planZoneLayout(
      [
        { kind: 'sticky', width: 200, height: 200 },
        { kind: 'doc', width: 960, height: 660 }
      ],
      VIEW
    )
    expect(spots[1]).toEqual({ x: 20, y: 20 })
    expect(spots[0]).toEqual({ x: 1100, y: 20 })
  })

  it('sets a document beside its sources, as the standard draws it', () => {
    const [doc, files, people] = planZoneLayout(
      [
        { kind: 'doc', width: 960, height: 660 },
        { kind: 'drive', width: 300, height: 340 },
        { kind: 'contacts', width: 300, height: 300 }
      ],
      VIEW
    )
    expect(doc).toEqual({ x: 20, y: 20 })
    expect(files).toEqual({ x: 1000, y: 20 })
    expect(people).toEqual({ x: 1000, y: 380 })
  })

  it('keeps a list on the right when there is no room for it in the first row', () => {
    const [table, note, mail] = planZoneLayout(
      [
        { kind: 'table', width: 740, height: 440 },
        { kind: 'note', width: 420, height: 420 },
        { kind: 'inbox', width: 420, height: 420 }
      ],
      VIEW
    )
    expect(table).toEqual({ x: 20, y: 20 })
    expect(note).toEqual({ x: 780, y: 20 })
    expect(mail).toEqual({ x: 880, y: 460 })
  })

  it('sends what does not fit further down, and lets the rest sit beside it', () => {
    const items = [
      { kind: 'doc', width: 960, height: 660 },
      { kind: 'sheet', width: 960, height: 620 },
      { kind: 'sticky', width: 200, height: 200 }
    ]
    const [doc, sheet, sticky] = planZoneLayout(items, VIEW)
    expect(doc).toEqual({ x: 20, y: 20 })
    expect(sheet).toEqual({ x: 20, y: 700 })
    expect(sticky).toEqual({ x: 1100, y: 20 })
  })

  it('never overlaps, however many things come', () => {
    const kinds = ['doc', 'table', 'note', 'page', 'inbox', 'calendar', 'drive', 'metrics', 'sticky', 'timer', 'chart', 'section']
    const items = kinds.map((kind) => ({ kind, ...WIDGET_START_SIZES[kind] }))
    const spots = planZoneLayout(items, VIEW)
    const boxes = items.map((it, i) => ({ ...spots[i], width: it.width, height: it.height }))
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach((b) => expect(clashes(a, b)).toBe(false)))
  })

  it('keeps clear of what is already on the desk', () => {
    const there: PlacementRect = { x: 20, y: 20, width: 960, height: 660, kind: 'doc' }
    const [next] = planZoneLayout([{ kind: 'table', width: 740, height: 440 }], VIEW, [there])
    expect(clashes({ ...next, width: 740, height: 440 }, there)).toBe(false)
  })

  it('treats a kind with no zone as reading material', () => {
    expect(planZoneLayout([{ kind: 'meeting-record', width: 420, height: 440 }], VIEW)).toEqual([{ x: 680, y: 20 }])
  })
})

describe('placing on a desk that is not on screen', () => {
  it('uses the zone when there is room', () => {
    const at = placeOnDesk({ kind: 'inbox', width: 420, height: 420, view: VIEW, obstacles: [] })
    expect({ x: at.x, y: at.y }).toEqual({ x: 880, y: 20 })
  })

  it('carries on lower down the same zone when it is full', () => {
    const full: PlacementRect = { x: 0, y: 20, width: 1328, height: 840 }
    const at = placeOnDesk({ kind: 'inbox', width: 420, height: 420, view: VIEW, obstacles: [full] })
    expect({ x: at.x, y: at.y }).toEqual({ x: 880, y: 880 })
  })

  it('never lands on what is there, even at the origin', () => {
    const wall: PlacementRect = { x: 0, y: 0, width: 1328, height: 891 }
    const at = placeOnDesk({ kind: 'sticky', width: 200, height: 200, view: VIEW, obstacles: [wall] })
    expect(clashes({ x: at.x, y: at.y, width: 200, height: 200 }, wall)).toBe(false)
  })
})
