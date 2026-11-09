// The "Set up with AI" chip keeps clear of what you would press.
import { describe, it, expect } from 'vitest'
import { chooseChipSlot, type Box } from '../../src/renderer/src/lib/setupChipSlot'

const body: Box = { left: 0, top: 0, width: 200, height: 300 }
const chip = { width: 110, height: 24 }
const choose = (controls: Box[]): ReturnType<typeof chooseChipSlot> => chooseChipSlot({ body, chip, controls, inset: 8 })

describe('where the chip sits', () => {
  it('is at the bottom when nothing is there', () => {
    expect(choose([])).toBe('bottom')
  })

  it('stays at the bottom when the only control is elsewhere', () => {
    expect(choose([{ left: 10, top: 10, width: 40, height: 40 }])).toBe('bottom')
  })

  it('moves to the top when a control is under it at the bottom', () => {
    expect(choose([{ left: 80, top: 262, width: 40, height: 30 }])).toBe('top')
  })

  it('goes away when controls fill both places', () => {
    expect(
      choose([
        { left: 80, top: 262, width: 40, height: 30 },
        { left: 80, top: 6, width: 40, height: 30 }
      ])
    ).toBeNull()
  })

  it('ignores a control that is the whole surface', () => {
    expect(choose([{ left: 0, top: 0, width: 200, height: 300 }])).toBe('bottom')
  })

  it('counts a control that only just touches it', () => {
    expect(choose([{ left: 0, top: 262, width: 46, height: 30 }])).toBe('top')
  })

  it('does not count one that clears it to the side', () => {
    expect(choose([{ left: 0, top: 262, width: 44, height: 30 }])).toBe('bottom')
  })
})
