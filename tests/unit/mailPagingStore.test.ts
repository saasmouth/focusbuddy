import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useMailStore } from '../../src/renderer/src/stores/mail'
import type { MailListItem } from '@shared/types'

// Show more has to fetch from the SERVER, not reveal rows the app already had.
// These cover the three ways that goes wrong: asking with the wrong cursor (so
// the same page comes back forever), merging carelessly (so a message appears
// twice), and guessing at whether more exists instead of believing the server.

const msg = (uid: number, date = uid * 1000): MailListItem =>
  ({
    uid,
    fromName: `Sender ${uid}`,
    fromAddress: `s${uid}@example.com`,
    subject: `Subject ${uid}`,
    date,
    seen: true,
    flagged: false,
    hasAttachments: false,
    messageId: `<${uid}@example.com>`,
    inReplyTo: null,
    references: []
  }) as MailListItem

interface ListCall {
  limit?: number
  beforeUid?: number
}

function stubMail(
  list: (limit?: number, beforeUid?: number) => Promise<unknown>
): ListCall[] {
  const calls: ListCall[] = []
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      mail: {
        list: (limit?: number, beforeUid?: number) => {
          calls.push({ limit, beforeUid })
          return list(limit, beforeUid)
        }
      }
    }
  }
  return calls
}

const connected = { configured: true, email: 'me@example.com' } as never

describe('mail store paging', () => {
  beforeEach(() => {
    useMailStore.setState({
      account: connected,
      messages: [],
      hasMore: false,
      nextCursor: null,
      loadingMore: false,
      loadingList: false,
      total: 0,
      error: null
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('records what the server said about there being more', async () => {
    stubMail(async () => ({
      ok: true,
      items: [msg(10), msg(9)],
      hasMore: true,
      nextCursor: 9,
      total: 120
    }))
    await useMailStore.getState().refresh()
    const s = useMailStore.getState()
    expect(s.messages.map((m) => m.uid)).toEqual([10, 9])
    expect(s.hasMore).toBe(true)
    expect(s.nextCursor).toBe(9)
    // The count is what makes "40 loaded" legible as not "40 emails exist".
    expect(s.total).toBe(120)
  })

  it('asks for the next page using the cursor the server gave it', async () => {
    const calls = stubMail(async (_l, beforeUid) =>
      beforeUid === undefined
        ? { ok: true, items: [msg(10), msg(9)], hasMore: true, nextCursor: 9, total: 4 }
        : { ok: true, items: [msg(8), msg(7)], hasMore: false, nextCursor: 7, total: 4 }
    )
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    expect(calls[0].beforeUid).toBeUndefined()
    expect(calls[1].beforeUid).toBe(9)
    const s = useMailStore.getState()
    expect(s.messages.map((m) => m.uid)).toEqual([10, 9, 8, 7])
    expect(s.hasMore).toBe(false)
  })

  it('keeps the list newest-first after appending a page', async () => {
    stubMail(async (_l, beforeUid) =>
      beforeUid === undefined
        ? { ok: true, items: [msg(10, 500), msg(9, 400)], hasMore: true, nextCursor: 9, total: 3 }
        : // An older uid with a NEWER date -- a redelivered or mis-stamped
          // message, which a plain append would leave out of order.
          { ok: true, items: [msg(8, 900)], hasMore: false, nextCursor: 8, total: 3 }
    )
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    const dates = useMailStore.getState().messages.map((m) => m.date)
    expect(dates).toEqual([...dates].sort((a, b) => b - a))
  })

  it('never lists the same message twice', async () => {
    stubMail(async (_l, beforeUid) =>
      beforeUid === undefined
        ? { ok: true, items: [msg(10), msg(9)], hasMore: true, nextCursor: 9, total: 3 }
        : // A server that rounds the range outward hands back the boundary again.
          { ok: true, items: [msg(9), msg(8)], hasMore: false, nextCursor: 8, total: 3 }
    )
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    const uids = useMailStore.getState().messages.map((m) => m.uid)
    expect(uids).toEqual([10, 9, 8])
    expect(new Set(uids).size).toBe(uids.length)
  })

  it('does nothing when the server already said that is everything', async () => {
    const calls = stubMail(async () => ({
      ok: true,
      items: [msg(10)],
      hasMore: false,
      nextCursor: 10,
      total: 1
    }))
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    expect(calls).toHaveLength(1)
  })

  it('does not fire twice on a double click', async () => {
    let resolve: ((v: unknown) => void) | null = null
    const calls = stubMail((_l, beforeUid) =>
      beforeUid === undefined
        ? Promise.resolve({ ok: true, items: [msg(10)], hasMore: true, nextCursor: 10, total: 5 })
        : new Promise((r) => {
            resolve = r
          })
    )
    await useMailStore.getState().refresh()
    const first = useMailStore.getState().loadMore()
    const second = useMailStore.getState().loadMore()
    resolve?.({ ok: true, items: [msg(9)], hasMore: false, nextCursor: 9, total: 5 })
    await Promise.all([first, second])
    expect(calls.filter((c) => c.beforeUid !== undefined)).toHaveLength(1)
  })

  it('keeps what is already loaded when a page fails', async () => {
    stubMail(async (_l, beforeUid) =>
      beforeUid === undefined
        ? { ok: true, items: [msg(10), msg(9)], hasMore: true, nextCursor: 9, total: 9 }
        : { ok: false, error: 'Connection reset' }
    )
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    const s = useMailStore.getState()
    expect(s.messages.map((m) => m.uid)).toEqual([10, 9])
    expect(s.error).toBe('Connection reset')
    expect(s.loadingMore).toBe(false)
    // Still offered, so a transient failure is retryable rather than terminal.
    expect(s.hasMore).toBe(true)
  })

  it('survives the IPC rejecting outright', async () => {
    stubMail(async (_l, beforeUid) => {
      if (beforeUid !== undefined) throw new Error('reply was never sent')
      return { ok: true, items: [msg(10)], hasMore: true, nextCursor: 10, total: 9 }
    })
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    const s = useMailStore.getState()
    expect(s.messages.map((m) => m.uid)).toEqual([10])
    expect(s.error).toBe('reply was never sent')
    expect(s.loadingMore).toBe(false)
  })

  it('drops paged-in mail on refresh rather than merging it', async () => {
    // Merging an old page under a fresh first page would leave a hole wherever
    // mail was archived in between, and the hole looks like a normal list.
    stubMail(async (_l, beforeUid) =>
      beforeUid === undefined
        ? { ok: true, items: [msg(10)], hasMore: true, nextCursor: 10, total: 2 }
        : { ok: true, items: [msg(9)], hasMore: false, nextCursor: 9, total: 2 }
    )
    await useMailStore.getState().refresh()
    await useMailStore.getState().loadMore()
    expect(useMailStore.getState().messages).toHaveLength(2)
    await useMailStore.getState().refresh()
    const s = useMailStore.getState()
    expect(s.messages.map((m) => m.uid)).toEqual([10])
    expect(s.hasMore).toBe(true)
    expect(s.nextCursor).toBe(10)
  })

  it('does not page when no mailbox is connected', async () => {
    useMailStore.setState({ account: null, hasMore: true, nextCursor: 5 })
    const calls = stubMail(async () => ({ ok: true, items: [], hasMore: false, nextCursor: null, total: 0 }))
    await useMailStore.getState().loadMore()
    expect(calls).toHaveLength(0)
  })
})
