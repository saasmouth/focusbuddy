// The bottom-right corner as a stack.
//
// Six overlays dock there — two call states, a meeting invite, the local-AI
// notice, the completion toast, the feature-spotlight card — and each was
// written `fixed bottom-5 right-5`, so they landed on each other and on the
// desk's controls underneath. None is click-transparent, so whatever lost was
// dead: no panel, no feedback, nothing to say why.
//
// These are the rules that replace that: priority decides the order, a live
// call can never be pushed off, and anything that will not fit waits rather
// than overlapping.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CORNER_PRIORITY,
  STACK_GAP,
  footprint,
  isBottomDocked,
  placeCornerStack,
  stackBase,
  stackInsetRight,
  type Box,
  type StackItem
} from '@renderer/lib/cornerStack'

const WIN_H = 900
const AVAILABLE = WIN_H - 56 // the top margin

const item = (id: string, priority: number, height: number): StackItem => ({ id, priority, height })
const byId = (ps: ReturnType<typeof placeCornerStack>, id: string): { bottom: number; right: number; visible: boolean } =>
  ps.find((p) => p.id === id)!

describe('the order of the stack', () => {
  it('puts the lowest priority number nearest the corner, and stacks upward', () => {
    const ps = placeCornerStack(
      [item('spotlight', CORNER_PRIORITY.featureSpotlight, 128), item('call', CORNER_PRIORITY.call, 200)],
      100,
      AVAILABLE
    )
    expect(byId(ps, 'call').bottom, 'the call takes the slot just above the chrome').toBe(100)
    expect(byId(ps, 'spotlight').bottom, 'and the card sits above the call').toBe(100 + 200 + STACK_GAP)
  })

  it('does not depend on the order they were registered in', () => {
    const a = placeCornerStack([item('call', 0, 200), item('toast', 3, 60)], 100, AVAILABLE)
    const b = placeCornerStack([item('toast', 3, 60), item('call', 0, 200)], 100, AVAILABLE)
    expect(a).toEqual(b)
  })

  it('breaks a tie by id, so two things appearing together do not reshuffle', () => {
    const a = placeCornerStack([item('bbb', 2, 40), item('aaa', 2, 40)], 0, AVAILABLE)
    expect(a.map((p) => p.id)).toEqual(['aaa', 'bbb'])
  })

  it('stacks the whole set without a single overlap', () => {
    const ps = placeCornerStack(
      [
        item('call', CORNER_PRIORITY.call, 220),
        item('invite', CORNER_PRIORITY.meetingInvite, 120),
        item('notice', CORNER_PRIORITY.notice, 48),
        item('toast', CORNER_PRIORITY.toast, 56),
        item('spotlight', CORNER_PRIORITY.featureSpotlight, 128)
      ],
      100,
      5_000 // a tall window: everything fits
    )
    const shown = ps.filter((p) => p.visible)
    expect(shown).toHaveLength(5)
    // Each one's bottom is at or above the previous one's top.
    const heights: Record<string, number> = { call: 220, invite: 120, notice: 48, toast: 56, spotlight: 128 }
    for (let i = 1; i < shown.length; i++) {
      const below = shown[i - 1]!
      const here = shown[i]!
      expect(here.bottom, `${here.id} must start above ${below.id}`).toBeGreaterThanOrEqual(
        below.bottom + heights[below.id]!
      )
    }
  })
})

describe('when they do not all fit', () => {
  it('queues the item rather than overlapping, and says so', () => {
    // Room for the call and nothing else.
    const ps = placeCornerStack([item('call', 0, 300), item('spotlight', 4, 300)], 100, 420)
    expect(byId(ps, 'call').visible).toBe(true)
    expect(byId(ps, 'spotlight').visible, 'queued, not squeezed in on top of the call').toBe(false)
  })

  it('NEVER queues the live call, whatever else is up', () => {
    // The owner's ruling: a call is the top of the stack and is never pushed
    // off-screen. It is placed first, so the only way to lose is a window too
    // small for it alone.
    const everything = [
      item('spotlight', CORNER_PRIORITY.featureSpotlight, 400),
      item('toast', CORNER_PRIORITY.toast, 400),
      item('notice', CORNER_PRIORITY.notice, 400),
      item('invite', CORNER_PRIORITY.meetingInvite, 400),
      item('call', CORNER_PRIORITY.call, 220)
    ]
    const ps = placeCornerStack(everything, 100, 420)
    expect(byId(ps, 'call').visible).toBe(true)
    expect(ps.filter((p) => p.visible).map((p) => p.id), 'only the call fits').toEqual(['call'])
  })

  it('lets a SHORT item take the next slot when a tall one above it could not', () => {
    // Skipped, not ended: the tall card standing down should not also cost the
    // one-line notice its place. It can only ever take a slot ABOVE a
    // higher-priority item, so nothing is displaced.
    const ps = placeCornerStack([item('call', 0, 200), item('tall', 1, 900), item('short', 2, 40)], 100, 400)
    expect(byId(ps, 'call').visible).toBe(true)
    expect(byId(ps, 'tall').visible).toBe(false)
    expect(byId(ps, 'short').visible, 'the short one still fits above the call').toBe(true)
    expect(byId(ps, 'short').bottom).toBe(100 + 200 + STACK_GAP)
  })

  it('still places an unmeasured item, or it could never earn a height', () => {
    // Height 0 is "not measured yet": hiding it would stop it rendering, so it
    // would never be measured, so it would never be shown.
    const ps = placeCornerStack([item('fresh', 2, 0)], 100, 420)
    expect(byId(ps, 'fresh').visible).toBe(true)
  })
})

describe('where the stack starts', () => {
  const WIN_W = 1700
  const COLUMN = { left: WIN_W - 20 - 360, right: WIN_W - 20 } // a 360-wide right-docked item
  const chrome = (fromBottom: number, height: number): Box => ({
    left: 1600,
    right: 1680,
    top: WIN_H - fromBottom - height,
    bottom: WIN_H - fromBottom
  })

  it('clears the TALLEST piece of chrome under it, plus a gap', () => {
    const pill = chrome(42, 52) // top 806
    const automations = chrome(104, 32) // top 764 — reaches higher
    expect(stackBase([pill, automations], COLUMN, WIN_H, 0)).toBe(WIN_H - 764 + STACK_GAP)
  })

  it('ignores chrome that is BESIDE the column, not under it', () => {
    // THE ONE THAT WOULD HAVE HURT, and it is not hypothetical: the sidebar's
    // resize strip measures 10x935, reaching y=39. A base that took the
    // tallest thing it found regardless of where it was would start the stack
    // 935px up and push every item off the top of the window at once. Found by
    // enumerating what is actually docked at the edges, not by assuming.
    const sidebarResize: Box = { left: 262, right: 272, top: 39, bottom: 974 }
    expect(stackBase([sidebarResize], COLUMN, WIN_H, 20)).toBe(20)
    // The bottom-left zoom pill is beside it too.
    const zoom: Box = { left: 284, right: 321, top: WIN_H - 29, bottom: WIN_H }
    expect(stackBase([zoom], COLUMN, WIN_H, 20)).toBe(20)
  })

  it('ignores hidden chrome, which reports an empty rect at the origin', () => {
    const hidden: Box = { left: 0, right: 0, top: 0, bottom: 0 }
    expect(stackBase([hidden], COLUMN, WIN_H, 20)).toBe(20)
    expect(stackBase([hidden, chrome(42, 52)], COLUMN, WIN_H, 0)).toBe(WIN_H - 806 + STACK_GAP)
  })

  it('never goes below the floor it is given', () => {
    expect(stackBase([], COLUMN, WIN_H, 20)).toBe(20)
  })
})

describe('a rail down the right edge is gone AROUND, not over', () => {
  const WIN_W = 1700

  // The real one, from the edge inventory: the floating toolbar, 40x56,
  // fixed at the right edge roughly halfway up the window.
  const toolbar: Box = { left: 1642, right: 1682, top: 494, bottom: 550 }

  it('insets the column past it', () => {
    expect(stackInsetRight([toolbar], WIN_W, WIN_H, 20)).toBe(WIN_W - 1642 + STACK_GAP)
  })

  it('does NOT try to clear it vertically', () => {
    // Clearing the toolbar by lifting would start the stack ~480px up the
    // window, which is why the two axes are separate. Once the column is
    // inset past it, it is no longer under the stack at all.
    const inset = stackInsetRight([toolbar], WIN_W, WIN_H, 20)
    const column = { left: WIN_W - inset - 360, right: WIN_W - inset }
    expect(stackBase([toolbar], column, WIN_H, 20), 'beside the column now').toBe(20)
  })

  it('leaves the BOTTOM-docked chrome to be cleared by lifting instead', () => {
    // The pill is on the right edge too, but it is in the corner: insetting
    // for it would shove the stack sideways for no reason, and it is already
    // handled by the base.
    const pill: Box = { left: 1628, right: 1680, top: WIN_H - 94, bottom: WIN_H - 42 }
    expect(isBottomDocked(pill, WIN_H)).toBe(true)
    expect(stackInsetRight([pill], WIN_W, WIN_H, 20), 'no sideways shift for corner chrome').toBe(20)
  })

  it('ignores anything that is not on the right edge', () => {
    const zoom: Box = { left: 284, right: 321, top: WIN_H - 29, bottom: WIN_H }
    const sidebarResize: Box = { left: 262, right: 272, top: 39, bottom: 974 }
    expect(stackInsetRight([zoom, sidebarResize], WIN_W, WIN_H, 20)).toBe(20)
  })

  it('ignores a hidden rail', () => {
    expect(stackInsetRight([{ left: 0, right: 0, top: 0, bottom: 0 }], WIN_W, WIN_H, 20)).toBe(20)
  })
})

describe('a chrome root\u2019s footprint includes what hangs out of it', () => {
  // THE DEFECT THIS EXISTS FOR, found by probing elementsFromPoint rather than
  // by reading the DOM: the minimap's desk-jump list is `absolute bottom-full`
  // INSIDE the minimap container, deliberately out of flow so it cannot
  // disturb the popLayout measurement that once stranded the map mid-screen.
  // An out-of-flow child contributes nothing to its parent's border box, so
  // the container measured 160x100 while 216x57 of clickable desk names sat
  // above it, unseen by the arithmetic and underneath the lifted card.
  function el(rect: Partial<Box> & { width?: number; height?: number }, children: Element[] = []): Element {
    const node = document.createElement('div')
    for (const c of children) node.appendChild(c)
    const r = { left: 0, right: 0, top: 0, bottom: 0, ...rect }
    node.getBoundingClientRect = (): DOMRect =>
      ({ ...r, width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON: () => r }) as DOMRect
    return node
  }

  it('unions an out-of-flow child that sits ABOVE its parent', () => {
    // The real numbers from the probe.
    const list = el({ left: 1402, right: 1618, top: 798, bottom: 855 })
    const container = el({ left: 1458, right: 1618, top: 861, bottom: 961 }, [list])
    const box = footprint(container)
    expect(box.top, 'the footprint reaches up to the list, not just the panel').toBe(798)
    expect(box.left, 'and out to the left, where the list is wider').toBe(1402)
    expect(box.bottom).toBe(961)
  })

  it('is just the element when it has no children', () => {
    expect(footprint(el({ left: 10, right: 42, top: 100, bottom: 132 }))).toEqual({
      left: 10,
      right: 42,
      top: 100,
      bottom: 132
    })
  })

  it('ignores an EMPTY child rect, which is what an unmounted child reports', () => {
    // Without this the footprint is dragged to the origin and the whole stack
    // is pushed off the top of the window.
    const hidden = el({ left: 0, right: 0, top: 0, bottom: 0 })
    const container = el({ left: 1458, right: 1618, top: 861, bottom: 961 }, [hidden])
    expect(footprint(container).top).toBe(861)
  })
})

describe('every overlay in that corner takes a slot', () => {
  // Six places used to say `fixed bottom-5 right-5` independently. The point
  // of the stack is that none of them does any more — a seventh written the
  // old way is the way this comes back.
  const files = {
    'CallOverlay.tsx': 'src/renderer/src/components/CallOverlay.tsx',
    'MeetingOverlay.tsx': 'src/renderer/src/components/MeetingOverlay.tsx',
    'CompletionToast.tsx': 'src/renderer/src/components/CompletionToast.tsx',
    'LocalAiPrompts.tsx': 'src/renderer/src/components/LocalAiPrompts.tsx',
    'FeatureSpotlightPopup.tsx': 'src/renderer/src/components/onboarding/FeatureSpotlightPopup.tsx'
  }
  const code = (p: string): string =>
    readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  for (const [name, path] of Object.entries(files)) {
    it(`${name} asks the stack where to sit`, () => {
      const src = code(path)
      expect(src.length, 'file not read').toBeGreaterThan(400)
      expect(src).toMatch(/useCornerSlot\(/)
      expect(src, 'the slot must reach the style, not just be computed').toMatch(/bottom:\s*\w*[Cc]orner\.bottom/)
    })

    it(`${name} no longer pins itself to the window's BOTTOM-RIGHT with a class`, () => {
      // Narrow on purpose, and it took two goes to get right. It must flag a
      // WINDOW-FIXED bottom-right dock and nothing else:
      //   - LocalAiPrompts has a grounding notice at `bottom-4 left-4` and the
      //     intro at `bottom-12 left-1/2` — a different corner, not this stack;
      //   - CallOverlay has `absolute bottom-2 right-2` for the picture-in-
      //     picture INSIDE the call window, and MeetingOverlay `bottom-0
      //     right-0` for a dock side. Both are positioned within their own
      //     parent and have nothing to do with the window's corner.
      // So each class string is judged on its own, and only `fixed` ones count.
      const offenders = [...code(path).matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1]!)
        .filter((cls) => /\bfixed\b/.test(cls) && /\bbottom-\d/.test(cls) && /\bright-\d/.test(cls))
      expect(offenders, 'a bottom-N class cannot be stacked and would win over the style').toEqual([])
    })
  }

  it('a live call is never gated on there being room', () => {
    // Priority 0 means it is placed first, but the ruling is stronger than
    // that: it must not carry the `visible` gate the others do, so no future
    // change to the stack can make a ringing call disappear.
    const call = code(files['CallOverlay.tsx'])
    expect(call).not.toMatch(/if \(!corner\.visible\) return null/)
    // While the ones that may stand down DO carry it.
    expect(code(files['CompletionToast.tsx'])).toMatch(/if \(!corner\.visible\) return null/)
    expect(code(files['FeatureSpotlightPopup.tsx'])).toMatch(/if \(!corner\.visible\) return null/)
  })
})
