// Where a new work widget goes when nobody chose a spot: the placement half of
// the owner's "Plexii starting sizes" standard (2026-11-09).
//
// It only ever answers for an add with no chosen position: a side-menu click,
// the quick-add keys, an agent, MCP, Build with AI. A drag or a right-click has
// already said where the widget goes, and those paths never come here.
//
// Pure and shared, because the renderer places into the view on screen and the
// main process places onto a desk that may not be open at all.
//
// Everything lands on the canvas's 20 px grid, inside the view, clear of what is
// already there. When a zone has no room this returns null and the caller keeps
// its older rule, so a busy desk behaves as it always did.

export type StartZone = 'main' | 'second' | 'right' | 'left' | 'top' | 'corner' | 'around'

const inZone = (zone: StartZone, kinds: string[]): Array<[string, StartZone]> =>
  kinds.map((kind) => [kind, zone])

export const WIDGET_START_ZONES: Readonly<Record<string, StartZone>> = Object.fromEntries([
  // Main stage: the thing you came to work on, at the left edge beside the menu.
  ...inZone('main', ['doc', 'sheet', 'slides', 'draw', 'map', 'design', 'webview', 'table', 'mindmap', 'diagram']),
  // Second column: reading and reference, next to the main item.
  ...inZone('second', [
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
  ]),
  // Right rail: lists that read top to bottom.
  ...inZone('right', ['inbox', 'calendar', 'chat-thread', 'task-list', 'attention', 'agent', 'mail-thread']),
  // Left rail: where things come from.
  ...inZone('left', ['drive', 'contacts']),
  // Top band: numbers across the top.
  ...inZone('top', ['metrics', 'stat-card', 'streamdeck']),
  // Top-right corner: small things, stacked.
  ...inZone('corner', [
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
  ]),
  // Around what it groups: a section frames other things.
  ...inZone('around', ['section'])
])

/** The zone the standard gives this kind, or null for a kind it does not place. */
export function zoneFor(kind: string): StartZone | null {
  return WIDGET_START_ZONES[kind] ?? null
}

export const PLACEMENT_GRID = 20
const MARGIN = PLACEMENT_GRID
const GAP = PLACEMENT_GRID

// The most positions tried along one axis, so a desk zoomed far out costs the
// same as one at 100%.
const MAX_STEPS = 120

export interface PlacementRect {
  x: number
  y: number
  width: number
  height: number
  kind?: string
}

/** The part of the canvas to place into, in canvas units. */
export interface PlacementView {
  left: number
  top: number
  width: number
  height: number
}

// The default window's workspace, for a desk that is not on screen: an agent or
// MCP adding to it has no view to place into.
export const REFERENCE_VIEW: Readonly<PlacementView> = { left: 0, top: 0, width: 1328, height: 891 }

const up = (v: number): number => Math.ceil(v / PLACEMENT_GRID) * PLACEMENT_GRID
const down = (v: number): number => Math.floor(v / PLACEMENT_GRID) * PLACEMENT_GRID

function steps(from: number, to: number): number[] {
  const step = Math.max(PLACEMENT_GRID, up((to - from) / MAX_STEPS))
  const out: number[] = []
  for (let v = from; v < to; v += step) out.push(v)
  out.push(to)
  return out
}

// A second-column item sits right after the main item on screen; with no main
// item it starts at the middle of the view.
function secondColumnStart(view: PlacementView, obstacles: PlacementRect[]): number {
  const mains = obstacles.filter(
    (o) =>
      o.kind !== undefined &&
      zoneFor(o.kind) === 'main' &&
      o.x < view.left + view.width &&
      o.x + o.width > view.left &&
      o.y < view.top + view.height &&
      o.y + o.height > view.top
  )
  if (mains.length === 0) return up(view.left + view.width / 2)
  return up(Math.max(...mains.map((o) => o.x + o.width)) + GAP)
}

export function placeInZone(args: {
  zone: StartZone
  width: number
  height: number
  view: PlacementView
  obstacles: PlacementRect[]
}): { x: number; y: number } | null {
  const { zone, width, height, view, obstacles } = args
  const minX = up(view.left + MARGIN)
  const minY = up(view.top + MARGIN)
  const maxX = down(view.left + view.width - MARGIN - width)
  const maxY = down(view.top + view.height - MARGIN - height)
  if (maxX < minX || maxY < minY) return null

  const clear = (x: number, y: number): boolean =>
    obstacles.every(
      (o) =>
        x + width + GAP <= o.x || x >= o.x + o.width + GAP || y + height + GAP <= o.y || y >= o.y + o.height + GAP
    )
  const xs = steps(minX, maxX)
  const ys = steps(minY, maxY)

  const rowsFirst = (rows: number[], cols: number[]): { x: number; y: number } | null => {
    for (const y of rows) for (const x of cols) if (clear(x, y)) return { x, y }
    return null
  }
  const columnsFirst = (cols: number[], rows: number[]): { x: number; y: number } | null => {
    for (const x of cols) for (const y of rows) if (clear(x, y)) return { x, y }
    return null
  }

  switch (zone) {
    case 'main':
    case 'top':
      return rowsFirst(ys, xs)
    case 'right':
    case 'corner':
      return columnsFirst([...xs].reverse(), ys)
    case 'left':
      return columnsFirst(xs, ys)
    case 'second': {
      const start = secondColumnStart(view, obstacles)
      const rightward = xs.filter((x) => x >= start)
      const leftward = xs.filter((x) => x < start).reverse()
      return columnsFirst([...rightward, ...leftward], ys)
    }
    case 'around': {
      const cx = view.left + view.width / 2 - width / 2
      const cy = view.top + view.height / 2 - height / 2
      const nearest = xs
        .flatMap((x) => ys.map((y) => ({ x, y, d: (x - cx) ** 2 + (y - cy) ** 2 })))
        .sort((a, b) => a.d - b.d)
      const hit = nearest.find((c) => clear(c.x, c.y))
      return hit ? { x: hit.x, y: hit.y } : null
    }
  }
}

/**
 * Place on a desk where going off the bottom of the view is acceptable: in the
 * zone if it has room, else lower down in the same zone, else below everything.
 * For a desk that is not being looked at, or a batch the camera will frame after.
 */
export function placeOnDesk(args: {
  kind: string
  width: number
  height: number
  view: PlacementView
  obstacles: PlacementRect[]
}): { x: number; y: number; view: PlacementView } {
  const { kind, width, height, view, obstacles } = args
  const zone = zoneFor(kind) ?? 'second'
  const inView = placeInZone({ zone, width, height, view, obstacles })
  if (inView) return { ...inView, view }
  const bottom = obstacles.reduce((max, o) => Math.max(max, o.y + o.height), view.top)
  const grown = { ...view, height: Math.max(view.height, up(bottom + GAP) + height + MARGIN - view.top) }
  const lower = placeInZone({ zone, width, height, view: grown, obstacles })
  if (lower) return { ...lower, view: grown }
  return { x: up(view.left + MARGIN), y: up(bottom + GAP), view: grown }
}

const ZONE_ORDER: readonly StartZone[] = ['main', 'top', 'second', 'left', 'right', 'corner', 'around']

/**
 * Lay out a whole batch at once (Build with AI): big things claim the main stage
 * first and small things fill in around them. Positions come back in the order
 * the items were given. Whatever does not fit goes lower down in its own zone,
 * and the area grows with it so what follows can sit beside it.
 */
export function planZoneLayout(
  items: ReadonlyArray<{ kind: string; width: number; height: number }>,
  view: PlacementView,
  obstacles: ReadonlyArray<PlacementRect> = []
): Array<{ x: number; y: number }> {
  const rank = (kind: string): number => ZONE_ORDER.indexOf(zoneFor(kind) ?? 'second')
  const order = items.map((_, i) => i).sort((a, b) => rank(items[a].kind) - rank(items[b].kind) || a - b)
  const placed: PlacementRect[] = [...obstacles]
  const spots: Array<{ x: number; y: number }> = new Array(items.length)
  let area: PlacementView = { ...view }
  for (const i of order) {
    const { kind, width, height } = items[i]
    const at = placeOnDesk({ kind, width, height, view: area, obstacles: placed })
    area = at.view
    const spot = { x: at.x, y: at.y }
    placed.push({ ...spot, width, height, kind })
    spots[i] = spot
  }
  return spots
}
