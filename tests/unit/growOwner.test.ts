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
