import { describe, it, expect } from 'vitest'
import { pageOfUids, uidRange } from '../../src/main/mail/mailPaging'

// A mailbox with gaps, the way a real one looks after archiving and deleting.
const MAILBOX = [2, 3, 5, 8, 13, 21, 34, 55, 89, 144]

describe('pageOfUids', () => {
  it('opens on the newest messages', () => {
    const p = pageOfUids(MAILBOX, 3)
    expect(p.uids).toEqual([55, 89, 144])
    expect(p.hasMore).toBe(true)
    expect(p.nextCursor).toBe(55)
  })

  it('walks backwards a page at a time, never repeating a message', () => {
    const seen: number[] = []
    let cursor: number | undefined
    for (let i = 0; i < 10; i++) {
      const p = pageOfUids(MAILBOX, 3, cursor)
      seen.push(...p.uids)
      if (!p.hasMore) break
      cursor = p.nextCursor ?? undefined
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(MAILBOX)
    expect(new Set(seen).size).toBe(MAILBOX.length)
  })

  it('says there is no more once the oldest message is in hand', () => {
    const p = pageOfUids(MAILBOX, 3, 5)
    expect(p.uids).toEqual([2, 3])
    expect(p.hasMore).toBe(false)
  })

  it('is exclusive of the cursor, so the boundary message is never shown twice', () => {
    const p = pageOfUids(MAILBOX, 4, 34)
    expect(p.uids).not.toContain(34)
    expect(p.uids).toEqual([5, 8, 13, 21])
  })

  it('does not skip or repeat when new mail arrives mid-paging', () => {
    // The whole reason paging is by uid value and not by position: a message
    // landing between two calls shifts every index, but shifts no uid.
    const first = pageOfUids(MAILBOX, 3)
    const grown = [...MAILBOX, 200, 201]
    const second = pageOfUids(grown, 3, first.nextCursor ?? undefined)
    expect(second.uids).toEqual([13, 21, 34])
    for (const u of second.uids) expect(first.uids).not.toContain(u)
  })

  it('does not lose a page when messages are deleted mid-paging', () => {
    const first = pageOfUids(MAILBOX, 3)
    const shrunk = MAILBOX.filter((u) => u !== 34 && u !== 21)
    const second = pageOfUids(shrunk, 3, first.nextCursor ?? undefined)
    expect(second.uids).toEqual([5, 8, 13])
    expect(second.hasMore).toBe(true)
  })

  it('sorts whatever order the server answered in', () => {
    expect(pageOfUids([144, 2, 89, 13], 2).uids).toEqual([89, 144])
  })

  it('handles a mailbox smaller than one page', () => {
    const p = pageOfUids([7, 9], 40)
    expect(p.uids).toEqual([7, 9])
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBe(7)
  })

  it('handles an empty mailbox without claiming there is more', () => {
    const p = pageOfUids([], 40)
    expect(p.uids).toEqual([])
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })

  it('returns nothing, and no cursor, once past the oldest message', () => {
    const p = pageOfUids(MAILBOX, 5, 2)
    expect(p.uids).toEqual([])
    expect(p.hasMore).toBe(false)
    expect(p.nextCursor).toBeNull()
  })

  it('refuses a nonsense limit rather than fetching nothing forever', () => {
    for (const bad of [0, -5, NaN]) {
      expect(pageOfUids(MAILBOX, bad).uids.length).toBe(1)
    }
  })

  it('ignores values that are not real uids', () => {
    expect(pageOfUids([5, NaN, 8, Infinity], 10).uids).toEqual([5, 8])
  })
})

describe('uidRange', () => {
  it('collapses consecutive uids into runs', () => {
    expect(uidRange([4, 5, 6, 9])).toBe('4:6,9')
  })

  it('leaves isolated uids alone', () => {
    expect(uidRange([2, 5, 9])).toBe('2,5,9')
  })

  it('writes a single uid without a colon', () => {
    expect(uidRange([7])).toBe('7')
  })

  it('collapses one long run', () => {
    expect(uidRange([1, 2, 3, 4, 5])).toBe('1:5')
  })

  it('sorts and de-duplicates first', () => {
    expect(uidRange([9, 4, 5, 4, 6])).toBe('4:6,9')
  })

  it('returns empty for no uids, so the caller must skip the fetch', () => {
    // An empty IMAP range string is a protocol error, not an empty result.
    expect(uidRange([])).toBe('')
  })
})
