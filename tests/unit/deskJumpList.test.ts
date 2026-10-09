import { describe, it, expect } from 'vitest'
import { jumpTargets, sinceLabel } from '../../src/renderer/src/components/DeskJumpList'
import type { Widget } from '@shared/types'

// ── 2026-10-09 — camera shortcuts from the minimap ─────────────────────────
//
// The minimap shows WHERE things are and not WHAT they are: at 160×100 every
// widget is a grey rectangle, so finding "the sheet I was in ten minutes ago"
// means recognising a shape. Hovering it now lists every item by name, newest
// touched first.

const w = (p: Partial<Widget>): Widget =>
  ({
    id: 'w', taskId: 't', kind: 'note', title: '', content: '',
    x: 0, y: 0, width: 100, height: 100, zIndex: 0,
    archived: false, pinned: false, parentSectionId: null,
    createdAt: 0, updatedAt: 0,
    ...p
  }) as Widget

describe('jumpTargets', () => {
  it('puts the most recently touched first', () => {
    const out = jumpTargets([
      w({ id: 'old', updatedAt: 100 }),
      w({ id: 'newest', updatedAt: 900 }),
      w({ id: 'mid', updatedAt: 500 })
    ])
    expect(out.map((x) => x.id)).toEqual(['newest', 'mid', 'old'])
  })

  it('uses updatedAt, which the store already bumps — no new bookkeeping', () => {
    // If this ever needs its own "lastTouched" field, the two can disagree.
    const out = jumpTargets([w({ id: 'a', updatedAt: 1, createdAt: 999 })])
    expect(out[0].id).toBe('a')
  })

  it('leaves the minimap out — jumping to the thing you are pointing at is not a shortcut', () => {
    const out = jumpTargets([w({ id: 'm', kind: 'minimap' as Widget['kind'] }), w({ id: 'n' })])
    expect(out.map((x) => x.id)).toEqual(['n'])
  })

  it('leaves archived items out', () => {
    const out = jumpTargets([w({ id: 'gone', archived: true }), w({ id: 'here' })])
    expect(out.map((x) => x.id)).toEqual(['here'])
  })

  it('KEEPS pinned widgets, unlike the minimap itself', () => {
    // A pinned widget is fixed to the screen, so it has nowhere to fly to —
    // but it is still an item on the desk, and omitting it would make the list
    // look like it had lost something.
    const out = jumpTargets([w({ id: 'p', pinned: true })])
    expect(out.map((x) => x.id)).toEqual(['p'])
  })

  it('does not mutate the array it was given', () => {
    const input = [w({ id: 'a', updatedAt: 1 }), w({ id: 'b', updatedAt: 2 })]
    jumpTargets(input)
    expect(input.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('survives a widget with no timestamp rather than sorting it randomly', () => {
    const out = jumpTargets([
      w({ id: 'none', updatedAt: undefined as unknown as number }),
      w({ id: 'has', updatedAt: 5 })
    ])
    expect(out[0].id).toBe('has')
  })
})

describe('sinceLabel', () => {
  const now = 1_000_000_000
  it('reads as a glance, not a timestamp', () => {
    expect(sinceLabel(now, now)).toBe('now')
    expect(sinceLabel(now - 30_000, now)).toBe('now')
    expect(sinceLabel(now - 5 * 60_000, now)).toBe('5m')
    expect(sinceLabel(now - 3 * 3_600_000, now)).toBe('3h')
    expect(sinceLabel(now - 2 * 86_400_000, now)).toBe('2d')
    expect(sinceLabel(now - 21 * 86_400_000, now)).toBe('3w')
  })

  it('never shows "0m" — a thing touched 50 seconds ago reads as a minute', () => {
    expect(sinceLabel(now - 50_000, now)).toBe('1m')
  })

  it('clamps a future timestamp instead of printing a negative', () => {
    expect(sinceLabel(now + 60_000, now)).toBe('now')
  })
})
