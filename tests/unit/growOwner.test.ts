// A widget's height is grown by exactly one hook, against one ceiling.
// WidgetFrame runs useAutoGrowHeight for the kinds in its allowlist; a few
// widgets run useGrowToFit themselves. The sticky ran both: its own call
// measured a box that never overflows (so it never fired) and the frame's hook
// grew it against a flat 900, past the sticky's documented 640 (714 in a busy
// e2e run). Now the frame is the sticky's only owner and takes each kind's
// GROW_MAX_HEIGHT as its ceiling.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { autoGrowsHeight, autoGrowMax } from '../../src/renderer/src/lib/useAutoGrowHeight'
import { GROW_MAX_HEIGHT } from '../../src/renderer/src/lib/useGrowToFit'

const DIR = join(process.cwd(), 'src/renderer/src/components/widgets')

function selfGrownKinds(): string[] {
  const kinds: string[] = []
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.tsx'))) {
    const src = readFileSync(join(DIR, f), 'utf8')
    if (!src.includes('useGrowToFit(')) continue
    for (const m of src.matchAll(/GROW_MAX_HEIGHT(?:\.([a-z]+)|\['([a-z-]+)'\])/g)) kinds.push((m[1] ?? m[2])!)
  }
  return [...new Set(kinds)].sort()
}

describe('one grow owner per widget kind', () => {
  it('finds the widgets that grow themselves (the guard is not vacuous)', () => {
    expect(selfGrownKinds()).toEqual(expect.arrayContaining(['markdown', 'custom-block']))
  })

  it('no self-grown kind is also grown by the frame', () => {
    expect(selfGrownKinds().filter((k) => autoGrowsHeight(k as never))).toEqual([])
  })

  it('the frame grows the sticky, the card, the field and the task link', () => {
    for (const k of ['sticky', 'card', 'field', 'task-link']) expect(autoGrowsHeight(k as never), k).toBe(true)
  })
})

describe('the frame grows each kind to its own ceiling', () => {
  it('a kind with a GROW_MAX_HEIGHT stops there', () => {
    expect(autoGrowMax('sticky' as never)).toBe(GROW_MAX_HEIGHT.sticky)
    expect(GROW_MAX_HEIGHT.sticky).toBe(640)
    expect(autoGrowMax('card' as never)).toBe(GROW_MAX_HEIGHT.card)
    expect(autoGrowMax('field' as never)).toBe(GROW_MAX_HEIGHT.field)
  })

  it('a kind without one keeps the frame default', () => {
    expect(GROW_MAX_HEIGHT['task-link']).toBeUndefined()
    expect(autoGrowMax('task-link' as never)).toBe(900)
  })
})

describe('a height the person set is theirs (autoGrowTarget)', () => {
  // sticky: min 120, cap 640. cur = stored height; natural/client = the body's
  // scrollHeight / clientHeight; overhead (header) = cur - client.
  it('content grows the widget, but only up to the cap', async () => {
    const { autoGrowTarget } = await import('../../src/renderer/src/lib/useAutoGrowHeight')
    expect(autoGrowTarget(160, 400, 130, 120, 640)).toBe(430) // 400 content + 30 header
    expect(autoGrowTarget(160, 2000, 130, 120, 640)).toBe(640) // a runaway paste stops at the cap
  })

  it('a widget the person grew past the cap keeps its height, whatever the content', async () => {
    const { autoGrowTarget } = await import('../../src/renderer/src/lib/useAutoGrowHeight')
    // grown to 1200 by hand; little content (no overflow) → left alone, not pulled back to 640
    expect(autoGrowTarget(1200, 1170, 1170, 120, 640)).toBeNull()
    // and typing more (still within the box) does not move it either
    expect(autoGrowTarget(1200, 1170, 1170, 120, 640)).toBeNull()
  })

  it('a hand-set height is kept only up to GROW_CEILING', async () => {
    const { autoGrowTarget } = await import('../../src/renderer/src/lib/useAutoGrowHeight')
    const { GROW_CEILING } = await import('../../src/shared/widgetSizing')
    expect(autoGrowTarget(GROW_CEILING.h + 500, 100, 100, 120, 640)).toBe(GROW_CEILING.h)
    expect(autoGrowTarget(GROW_CEILING.h, 100, 100, 120, 640)).toBeNull()
  })

  it('below the cap nothing changes: no overflow, no move (a hand-set height under the cap sticks too)', async () => {
    const { autoGrowTarget } = await import('../../src/renderer/src/lib/useAutoGrowHeight')
    expect(autoGrowTarget(500, 470, 470, 120, 640)).toBeNull()
  })
})
