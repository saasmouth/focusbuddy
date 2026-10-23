// What the free plan's "3 desks" actually counts.
//
// multiple_desks is { free: 3 }, and it was enforced against the wrong object.
// isTopLevelDesk read `kind === 'folder'`, which was a desk when the comment
// above it was written — but the Rooms/Desks rename made a top-level FOLDER a
// ROOM and a DESK a top-level task (stores/nodes.ts: `kind === 'folder' ?
// 'room' : 'desk'`), while Sidebar.requestCreateDesk creates kind: 'task'.
// So the cap never fired on the path people actually use, and a fourth ROOM
// was refused with a message about desks.
//
// The owner's ruling (2026-10-24): 3 desks on Free, rooms unlimited, anyone
// already above 3 keeps what they have and simply cannot create more, and the
// message stays "3-desk limit". These are those rules, in that order.

import { describe, expect, it } from 'vitest'
import { countTopLevelDesks, isTopLevelDesk } from '@renderer/stores/nodes'
import { canCreateMore, limitFor } from '@renderer/lib/gating'

const FREE = { multiple_desks: 3 }
const desk = (parentId: string | null = null): { parentId: string | null; kind: 'task' } => ({ parentId, kind: 'task' })
const room = (parentId: string | null = null): { parentId: string | null; kind: 'folder' } => ({ parentId, kind: 'folder' })

describe('what counts as a desk', () => {
  it('a top-level TASK is a desk', () => {
    expect(isTopLevelDesk(desk())).toBe(true)
  })

  it('a top-level FOLDER is a room, and is not capped', () => {
    // The whole defect in one assertion.
    expect(isTopLevelDesk(room())).toBe(false)
  })

  it('a task inside something is not a top-level desk', () => {
    expect(isTopLevelDesk(desk('parent-1'))).toBe(false)
  })

  it('counts only top-level desks, ignoring rooms and nested tasks', () => {
    const nodes = [desk(), desk(), room(), room(), desk('r1'), { parentId: null, kind: 'work_item' as const }]
    expect(countTopLevelDesks(nodes)).toBe(2)
  })
})

describe("the owner's three rules", () => {
  it('refuses a FOURTH desk on Free', () => {
    const nodes = [desk(), desk(), desk()]
    expect(countTopLevelDesks(nodes)).toBe(3)
    expect(canCreateMore(FREE, 'multiple_desks', countTopLevelDesks(nodes))).toBe(false)
  })

  it('allows a fourth ROOM on Free — rooms are unlimited', () => {
    const nodes = [room(), room(), room()]
    // No desks at all, so the cap has nothing to count and a new room is not
    // even a candidate for it.
    expect(countTopLevelDesks(nodes)).toBe(0)
    expect(isTopLevelDesk(room())).toBe(false)
    expect(canCreateMore(FREE, 'multiple_desks', countTopLevelDesks(nodes))).toBe(true)
  })

  it('lets someone already above the limit KEEP what they have, and only blocks new ones', () => {
    // "Users already above 3 keep them but can't create more; nothing is
    // deleted or hidden." The gate is asked only on create, so the five stay
    // five and the sixth is refused.
    const five = [desk(), desk(), desk(), desk(), desk()]
    expect(countTopLevelDesks(five), 'all five still counted, none dropped').toBe(5)
    expect(canCreateMore(FREE, 'multiple_desks', 5)).toBe(false)
  })

  it('still reports the limit as 3, so the message stays true', () => {
    expect(limitFor(FREE, 'multiple_desks')).toBe(3)
  })

  it('caps nothing on a paid tier', () => {
    expect(canCreateMore({ multiple_desks: 'Unlimited' }, 'multiple_desks', 99)).toBe(true)
  })
})
