// What the free plan's "3 desks" actually counts.
//
// multiple_desks is { free: 3 }, and it was enforced against the wrong object.
// isDesk read `kind === 'folder'`, which was a desk when the comment
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
import { countDesks, isDesk } from '@renderer/stores/nodes'
import { canCreateMore, limitFor } from '@renderer/lib/gating'

const FREE = { multiple_desks: 3 }
const desk = (parentId: string | null = null, archived = false) => ({ parentId, kind: 'task' as const, archived })
const room = (parentId: string | null = null, archived = false) => ({ parentId, kind: 'folder' as const, archived })
const workItem = () => ({ parentId: 'desk-1', kind: 'work_item' as const, archived: false })

describe('what counts as a desk', () => {
  // The three kinds, with the code that says so:
  //   task      = a DESK (SPEC-044 vocabulary quarantine: "create-task" has
  //               always meant a desk; types.ts says "Task nodes (Desks)")
  //   folder    = a ROOM, uncapped
  //   work_item = "NOT a desk ... a LEAF node, excluded from every desk/room
  //               surface" (types.ts)
  it('a TASK is a desk', () => {
    expect(isDesk(desk())).toBe(true)
  })

  it('a FOLDER is a room, and is not capped', () => {
    expect(isDesk(room())).toBe(false)
  })

  it('a work_item is never a desk', () => {
    // Counting these would cap people on their to-dos.
    expect(isDesk(workItem())).toBe(false)
  })

  it('A DESK INSIDE A ROOM IS STILL A DESK', () => {
    // The correction (owner, 2026-10-24): "3 desks" is every desk, not every
    // top-level one. Counting only top-level desks let someone keep making
    // them inside rooms forever.
    expect(isDesk(desk('room-1'))).toBe(true)
  })

  it('counts desks at EVERY depth, ignoring rooms and work items', () => {
    const nodes = [desk(), desk('room-1'), desk('room-2'), room(), room('room-1'), workItem()]
    expect(countDesks(nodes)).toBe(3)
  })

  it('does not count an archived desk', () => {
    // A judgement, stated in nodes.ts: archived is "put away" and the Home
    // dashboard's own tally excludes it, so archiving frees the slot.
    expect(countDesks([desk(), desk(null, true), desk('room-1', true)])).toBe(1)
  })
})

describe("the owner's three rules", () => {
  it('refuses a FOURTH desk on Free', () => {
    const nodes = [desk(), desk(), desk()]
    expect(countDesks(nodes)).toBe(3)
    expect(canCreateMore(FREE, 'multiple_desks', countDesks(nodes))).toBe(false)
  })

  it('refuses the fourth even when the first three are spread across rooms', () => {
    const nodes = [desk(), desk('room-1'), desk('room-2')]
    expect(countDesks(nodes)).toBe(3)
    expect(canCreateMore(FREE, 'multiple_desks', countDesks(nodes))).toBe(false)
  })

  it('allows a fourth ROOM on Free — rooms are unlimited', () => {
    const nodes = [room(), room(), room()]
    // No desks at all, so the cap has nothing to count and a new room is not
    // even a candidate for it.
    expect(countDesks(nodes)).toBe(0)
    expect(isDesk(room())).toBe(false)
    expect(canCreateMore(FREE, 'multiple_desks', countDesks(nodes))).toBe(true)
  })

  it('lets someone already above the limit KEEP what they have, and only blocks new ones', () => {
    // "Users already above 3 keep them but can't create more; nothing is
    // deleted or hidden." The gate is asked only on create, so the five stay
    // five and the sixth is refused.
    const five = [desk(), desk(), desk(), desk(), desk()]
    expect(countDesks(five), 'all five still counted, none dropped').toBe(5)
    expect(canCreateMore(FREE, 'multiple_desks', 5)).toBe(false)
  })

  it('still reports the limit as 3, so the message stays true', () => {
    expect(limitFor(FREE, 'multiple_desks')).toBe(3)
  })

  it('caps nothing on a paid tier', () => {
    expect(canCreateMore({ multiple_desks: 'Unlimited' }, 'multiple_desks', 99)).toBe(true)
  })
})
