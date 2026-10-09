// The desk's bottom corners, where chrome kept landing on chrome.
//
// Bottom-right holds three controls: the Plexii pill (window-fixed, the primary
// action), the minimap, and the automations button (both on the canvas). After
// the pill grew to 52px it sat on the minimap's toggle, so a click meant for the
// minimap opened Plexii; and the automations button, moved up to clear the pill,
// covered the open minimap panel's close button — the WCAG target-size failure
// in plxA11yWcagZoom. Bottom-left holds the zoom pill, which sits inside the
// edge-pan margins and was not tagged as floating chrome, so hovering it to
// reach − / + slid the desk out from under the pointer.
//
// The e2e specs measure the real layout; this holds the numbers they rest on,
// so a change to any one of them fails here first and says which.

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({
  default: ({ name }: { name: string }) => <i data-icon={name} />
}))
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: (sel: (s: unknown) => unknown) =>
    sel({ zoom: 1, setZoom: vi.fn(), resetView: vi.fn() })
}))

import ZoomControls from '../../src/renderer/src/components/ZoomControls'
import {
  FLOATING_CHROME_SELECTOR,
  isOverFloatingChrome
} from '../../src/renderer/src/lib/floatingChrome'
import {
  PILL_CANVAS_INSET_PX,
  PILL_CLEAR_RIGHT_PX,
  PILL_RIGHT_PX,
  PILL_SIZE_PX,
  PILL_STACK_BOTTOM_PX,
  pillCornerVars
} from '../../src/renderer/src/components/assistant/pillGeometry'

const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const OVERLAY = read('src/renderer/src/components/assistant/AssistantOverlay.tsx')
const MINIMAP = read('src/renderer/src/components/CanvasMinimapFAB.tsx')
const AUTOMATIONS = read('src/renderer/src/components/AutomationsFAB.tsx')
const EDGE_PAN = read('src/renderer/src/lib/useEdgePan.ts')

// Rects measured from the canvas's bottom-right corner: `r` is the distance of
// the right edge from the canvas's right edge, `b` the bottom edge from the
// canvas's bottom edge. Both grow toward the middle of the desk.
interface CornerRect {
  r: number
  b: number
  w: number
  h: number
}
const overlaps = (a: CornerRect, c: CornerRect): boolean =>
  a.r < c.r + c.w && c.r < a.r + a.w && a.b < c.b + c.h && c.b < a.b + a.h

const MINIMAP_INSET = 12 // bottom-3, and right-3 when the pill is hidden
const FAB = 32 // w-8 h-8, both the minimap toggle and the automations button
const PANEL_W = Number(/const PANEL_W = (\d+)/.exec(MINIMAP)?.[1])
const PANEL_H = Number(/const PANEL_H = (\d+)/.exec(MINIMAP)?.[1])
const AUTOMATIONS_FALLBACK_BOTTOM = Number(
  /bottom: 'var\(--fb-corner-stack-bottom, (\d+)px\)'/.exec(AUTOMATIONS)?.[1]
)

describe('the pill footprint is one set of numbers', () => {
  it('matches the classes the pill actually wears', () => {
    expect(OVERLAY).toContain(`right-[${PILL_RIGHT_PX}px]`)
    expect(OVERLAY).toContain(`h-[${PILL_SIZE_PX}px] w-[${PILL_SIZE_PX}px]`)
  })

  it('is published by the pill, and only while it renders', () => {
    expect(OVERLAY).toMatch(/const pillShowing = !open && !focusModeShowing && !hubShowing/)
    expect(OVERLAY).toMatch(/if \(!pillShowing\) return[\s\S]{0,200}pillCornerVars\(\)/)
    // Removed on the way out, or the minimap would keep dodging a pill that is gone.
    expect(OVERLAY).toMatch(/root\.removeProperty\(name\)/)
    expect(pillCornerVars()).toEqual({
      '--fb-pill-clear-right': `${PILL_CLEAR_RIGHT_PX}px`,
      '--fb-corner-stack-bottom': `${PILL_STACK_BOTTOM_PX}px`
    })
  })

  it('is read by the corner chrome, with the corner itself as the fallback', () => {
    expect(MINIMAP).toContain("right: 'var(--fb-pill-clear-right, 12px)'")
    expect(MINIMAP).not.toMatch(/absolute bottom-3 right-3/)
    expect(AUTOMATIONS).toContain("bottom: 'var(--fb-corner-stack-bottom, ")
    // No fixed bottom class left on the root alongside the variable (the
    // comment above it still tells the bottom-[76px] story, so match the class).
    expect(AUTOMATIONS).not.toMatch(/className="fb-floating-chrome absolute[^"]*\bbottom-/)
  })
})

describe('bottom-right: nothing sits on anything', () => {
  const pill: CornerRect = { r: PILL_RIGHT_PX, b: PILL_CANVAS_INSET_PX, w: PILL_SIZE_PX, h: PILL_SIZE_PX }

  it('reads the real panel size', () => {
    expect(PANEL_W).toBeGreaterThan(0)
    expect(PANEL_H).toBeGreaterThan(0)
    expect(AUTOMATIONS_FALLBACK_BOTTOM).toBeGreaterThan(0)
  })

  it('with the pill showing: the minimap beside it, the automations button above it', () => {
    const minimapIcon: CornerRect = { r: PILL_CLEAR_RIGHT_PX, b: MINIMAP_INSET, w: FAB, h: FAB }
    const minimapPanel: CornerRect = { r: PILL_CLEAR_RIGHT_PX, b: MINIMAP_INSET, w: PANEL_W, h: PANEL_H }
    const automations: CornerRect = { r: 12, b: PILL_STACK_BOTTOM_PX, w: FAB, h: FAB }

    expect(overlaps(pill, minimapIcon), 'the pill covers the minimap toggle').toBe(false)
    expect(overlaps(pill, minimapPanel), 'the pill covers the open minimap').toBe(false)
    expect(overlaps(pill, automations), 'the pill covers the automations button').toBe(false)
    expect(overlaps(automations, minimapPanel), 'automations covers the open minimap').toBe(false)
    expect(overlaps(automations, minimapIcon)).toBe(false)
  })

  it('with the pill hidden: the minimap is back in the corner and automations clears it open', () => {
    const minimapPanel: CornerRect = { r: MINIMAP_INSET, b: MINIMAP_INSET, w: PANEL_W, h: PANEL_H }
    const automations: CornerRect = { r: 12, b: AUTOMATIONS_FALLBACK_BOTTOM, w: FAB, h: FAB }
    expect(overlaps(automations, minimapPanel), 'automations covers the open minimap').toBe(false)
  })

  it('the close button on the minimap panel is a 24px target', () => {
    // WCAG 2.2 SC 2.5.8: 24 x 24, or spacing the 160px panel cannot give it.
    const close = /<button[^>]*?\n?[^<]*?title="Close minimap"/.exec(MINIMAP)?.[0] ?? ''
    expect(close).toContain('w-6 h-6')
    expect(close).not.toContain('w-4 h-4')
  })
})

describe('bottom-left: the zoom pill is floating chrome', () => {
  let host: HTMLDivElement
  let reactRoot: ReturnType<typeof createRoot>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    reactRoot = createRoot(host)
  })
  afterEach(() => {
    act(() => reactRoot.unmount())
    host.remove()
  })

  it('edge-pan uses the shared predicate, not a private copy of it', () => {
    expect(EDGE_PAN).toMatch(/import \{ isOverFloatingChrome \} from '\.\/floatingChrome'/)
    expect(EDGE_PAN).not.toContain("closest('.fb-floating-chrome, [data-floating-menu]')")
  })

  it('so the camera stands down while the pointer is over it', async () => {
    await act(async () => {
      reactRoot.render(<ZoomControls />)
    })
    const pill = host.querySelector('[data-testid="zoom-controls"]')
    expect(pill).not.toBeNull()
    expect(pill!.matches(FLOATING_CHROME_SELECTOR)).toBe(true)
    // And from anything inside it — the pointer is usually over a child.
    const inner = pill!.querySelector('*') ?? pill!
    expect(isOverFloatingChrome(inner)).toBe(true)
    // The predicate is not vacuous: bare canvas is not chrome.
    const bare = document.createElement('div')
    host.appendChild(bare)
    expect(isOverFloatingChrome(bare)).toBe(false)
  })
})
