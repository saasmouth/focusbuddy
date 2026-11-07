// Moving and resizing on a shared desk open "Download this desk on Plexii"
// (owner, 2026-11-07: "yes" to "Should moving and resizing also show the
// gate?"). Refused where the gesture starts (renderer lib/shareGate.ts), so a
// widget never moves on screen while its save is refused -- and a press that
// is a click stays a click.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let recipient = true
let canAdd = true
vi.mock('../../src/renderer/src/lib/shareMode', () => ({
  isShareRecipient: () => recipient,
  shareCanAdd: () => !recipient || canAdd
}))

import {
  ARRANGING, DRAG_SLOP_PX, MOVING, SHARE_GATE_EVENT, arrangingIsGated, arrangingMenuItem, shareGate, shareGateOnDrag
} from '../../src/renderer/src/lib/shareGate'

const gates: string[] = []
const onGate = (e: Event): void => {
  gates.push((e as CustomEvent<{ what: string }>).detail.what)
}

beforeEach(() => {
  recipient = true
  canAdd = true
  gates.length = 0
  window.addEventListener(SHARE_GATE_EVENT, onGate)
})
afterEach(() => window.removeEventListener(SHARE_GATE_EVENT, onGate))

const press = (x = 100, y = 100, button = 0): { clientX: number; clientY: number; button: number } => ({ clientX: x, clientY: y, button })
const move = (x: number, y: number): void => {
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }))
}
const release = (): void => {
  window.dispatchEvent(new MouseEvent('pointerup'))
}

describe('a press on something that drags', () => {
  it('on the desktop: nothing is taken over -- the caller drags as it always did', () => {
    recipient = false
    expect(arrangingIsGated()).toBe(false)
    expect(shareGateOnDrag(press(), MOVING)).toBe(false)
    move(300, 300)
    release()
    expect(gates).toEqual([])
  })

  it('on a shared desk: the caller starts nothing, and a press that travels is the gate, once', () => {
    expect(arrangingIsGated()).toBe(true)
    expect(shareGateOnDrag(press(100, 100), MOVING)).toBe(true)
    move(100 + DRAG_SLOP_PX - 1, 100)
    expect(gates).toEqual([]) // a hand's tremble is not a drag
    move(100 + DRAG_SLOP_PX, 100)
    expect(gates).toEqual([MOVING])
    move(400, 400)
    release()
    expect(gates).toEqual([MOVING]) // once per press
  })

  it('a press that does not travel is a click (selecting a widget, opening its menu): no gate', () => {
    expect(shareGateOnDrag(press(), MOVING)).toBe(true)
    release()
    move(500, 500) // after the release: another gesture's, not this one's
    expect(gates).toEqual([])
  })

  it('a right or middle press is never a drag', () => {
    expect(shareGateOnDrag(press(100, 100, 2), MOVING)).toBe(true)
    move(300, 300)
    expect(gates).toEqual([])
  })
})

describe('the right-click menu', () => {
  it('names the items that only arrange the desk; the rest are decided at the bridge', () => {
    expect(arrangingMenuItem('core/front')).toBe(ARRANGING)
    expect(arrangingMenuItem('core/eject')).toBe(ARRANGING)
    expect(arrangingMenuItem('core/pin')).toBe('Pinning things on this desk')
    expect(arrangingMenuItem('core/pin/off')).toBe('Pinning things on this desk')
    expect(arrangingMenuItem('core/duplicate')).toBeNull()
    expect(arrangingMenuItem('core/frontier')).toBeNull() // a word, not a prefix
    expect(arrangingMenuItem(undefined)).toBeNull()
  })
})

describe('the plain gate', () => {
  it('opens on a shared desk and tells the caller to stop; elsewhere it is not there', () => {
    expect(shareGate('Settings')).toBe(true)
    expect(gates).toEqual(['Settings'])
    recipient = false
    expect(shareGate('Settings')).toBe(false)
    expect(gates).toEqual(['Settings'])
  })
})
