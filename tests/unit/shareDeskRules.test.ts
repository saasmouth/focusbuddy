// The page's rules for one link's desk (src/web/api/shareDesk.ts), without a
// page around them:
//
//   - a desk another tab is showing is never replaced or removed under it
//     (Web Locks: shared while shown, exclusive to change)
//   - dropLinkCopy takes a gone link's own copy and nothing else -- and nothing
//     at all for a link this browser never unpacked
//   - a link that was the only thing here, gone while its database was open in
//     this tab, takes its rows at once and the rest of the store on the next
//     load, unless another link has been opened in between
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'https://signal.test', wsUrl: 'wss://signal.test/ws' },
  cloudAppUrl: () => 'https://plexiidesk.com/share'
}))
const worker = vi.hoisted(() => ({ calls: [] as Array<{ channel: string; args: unknown[] }>, fail: false, roots: [] as string[] }))
vi.mock('../../src/web/api/dbClient', () => ({
  startCoordinator: () => undefined,
  dbCall: async (channel: string, args: unknown[]) => {
    worker.calls.push({ channel, args })
    if (channel === 'shareCopy:rootDesks') return worker.roots
    if (worker.fail) throw new Error('shareCopy:removeDesk: the database is busy')
    return { rootId: args[0], nodes: 1, widgets: 0, documents: 0, files: [] }
  }
}))

import {
  dropLinkCopy, holdDesk, releaseDesk, withDesksToThisTab, DESK_LOCK_PREFIX
} from '../../src/web/api/shareDesk'
import { finishPendingWipe, markImported, requestWipeOnNextLoad, type ShareOffer } from '../../src/web/api/share'
import { linkRecord, readLinkRecords, untrackedDesksPossible } from '../../src/web/api/shareVersion'

const t0 = 1_760_000_000_000
const A = 'linkA_abcdefghijklmnopqrstuvwxyz'
const B = 'linkB_abcdefghijklmnopqrstuvwxyz'
const offer = (rootId: string): ShareOffer => ({ title: rootId, expiresAt: null, updatedAt: t0, sizeBytes: 1, rootId })

/**
 * A LockManager with the two modes that matter, shared and exclusive, granted
 * in request order -- the part of the spec this code relies on.
 */
function fakeLocks(): LockManager & { heldBy: Map<string, { mode: string; count: number }> } {
  const heldBy = new Map<string, { mode: string; count: number }>()
  const waiting: Array<() => void> = []
  const canTake = (name: string, mode: string): boolean => {
    const h = heldBy.get(name)
    return !h || h.count === 0 || (h.mode === 'shared' && mode === 'shared')
  }
  const wake = (): void => { for (const w of waiting.splice(0)) w() }
  const request = (name: string, opts: { mode?: string; signal?: AbortSignal }, cb: () => Promise<unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const mode = opts.mode ?? 'exclusive'
      const attempt = (): void => {
        if (opts.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
        if (!canTake(name, mode)) {
          waiting.push(attempt)
          return
        }
        const h = heldBy.get(name)
        heldBy.set(name, { mode, count: (h && h.count > 0 ? h.count : 0) + 1 })
        Promise.resolve()
          .then(cb)
          .then(resolve, reject)
          .finally(() => {
            const cur = heldBy.get(name)!
            cur.count--
            wake()
          })
      }
      opts.signal?.addEventListener('abort', () => { wake() })
      attempt()
    })
  return { request, query: async () => ({}), heldBy } as unknown as LockManager & { heldBy: Map<string, { mode: string; count: number }> }
}

const original = (navigator as Navigator & { locks?: LockManager }).locks
const setLocks = (v: unknown): void => { Object.defineProperty(navigator, 'locks', { value: v, configurable: true, writable: true }) }

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  worker.calls.length = 0
  worker.fail = false
  worker.roots = []
})
afterEach(() => setLocks(original))

describe('a desk on screen in another tab', () => {
  it('is not replaced or removed under it: the change waits, then gives up', async () => {
    const locks = fakeLocks()
    setLocks(locks)
    // "Another tab": a shared hold that is never let go.
    void locks.request(DESK_LOCK_PREFIX + 'desk-A', { mode: 'shared' }, () => new Promise(() => {}))
    const ran = vi.fn(async () => 'ran')
    expect(await withDesksToThisTab(['desk-A'], ran, 30)).toEqual({ ok: false })
    expect(ran).not.toHaveBeenCalled()
  })

  it('a tab showing a DIFFERENT desk does not stand in the way', async () => {
    const locks = fakeLocks()
    setLocks(locks)
    void locks.request(DESK_LOCK_PREFIX + 'desk-B', { mode: 'shared' }, () => new Promise(() => {}))
    expect(await withDesksToThisTab(['desk-A'], async () => 'ran', 30)).toEqual({ ok: true, value: 'ran' })
  })

  it('a tab that lets go in time (a reload) is waited for', async () => {
    const locks = fakeLocks()
    setLocks(locks)
    let release!: () => void
    void locks.request(DESK_LOCK_PREFIX + 'desk-A', { mode: 'shared' }, () => new Promise<void>((r) => (release = r)))
    setTimeout(() => release(), 10)
    expect(await withDesksToThisTab(['desk-A'], async () => 'ran', 1000)).toEqual({ ok: true, value: 'ran' })
  })

  it('this tab’s own hold is let go before it removes the desk itself', async () => {
    const locks = fakeLocks()
    setLocks(locks)
    holdDesk('desk-A')
    await Promise.resolve()
    expect(locks.heldBy.get(DESK_LOCK_PREFIX + 'desk-A')).toMatchObject({ mode: 'shared', count: 1 })
    expect(await withDesksToThisTab(['desk-A'], async () => 'ran', 30)).toEqual({ ok: false })
    releaseDesk('desk-A')
    expect(await withDesksToThisTab(['desk-A'], async () => 'ran', 1000)).toEqual({ ok: true, value: 'ran' })
  })

  it('an error from the change itself is reported as that, not as "open elsewhere"', async () => {
    setLocks(fakeLocks())
    await expect(withDesksToThisTab(['desk-A'], async () => { throw new Error('boom') }, 1000)).rejects.toThrow('boom')
  })

  it('without Web Locks (one tab at a time), the change simply runs', async () => {
    setLocks(undefined)
    expect(await withDesksToThisTab(['desk-A'], async () => 'ran')).toEqual({ ok: true, value: 'ran' })
  })
})

describe('taking a gone link’s copy out', () => {
  beforeEach(() => setLocks(undefined))

  it('a link this browser never unpacked takes nothing', async () => {
    markImported(A, t0, offer('desk-A'))
    await dropLinkCopy(B, 'wipe')
    await dropLinkCopy(B, 'forget', { databaseOpenHere: true })
    expect(worker.calls).toEqual([])
    expect(Object.keys(readLinkRecords())).toEqual([A])
  })

  it('forget: removes this link’s desk only, and its record', async () => {
    markImported(A, t0, offer('desk-A'))
    markImported(B, t0, offer('desk-B'))
    await dropLinkCopy(A, 'forget')
    expect(worker.calls).toEqual([{ channel: 'shareCopy:removeDesk', args: ['desk-A'] }])
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })

  it('forget: a desk another link still names stays; only the record goes', async () => {
    markImported(A, t0, offer('desk-A'))
    markImported(B, t0, offer('desk-A'))
    await dropLinkCopy(A, 'forget')
    expect(worker.calls).toEqual([])
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })

  it('forget: a desk that could not be removed keeps its record, so the next visit tries again', async () => {
    markImported(A, t0, offer('desk-A'))
    markImported(B, t0, offer('desk-B'))
    worker.fail = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await dropLinkCopy(A, 'forget')
    expect(linkRecord(A)).not.toBeNull()
    warn.mockRestore()
  })

  const headCopy = (): void =>
    localStorage.setItem('fb.share.links', JSON.stringify({ [A]: { version: null, declined: null, edited: null, rootId: null, offer: null } }))

  it('a copy from an older build that never said which desk it was, among several desks: all kept, said to be untracked', async () => {
    headCopy()
    worker.roots = ['desk-1', 'desk-2']
    await dropLinkCopy(A, 'forget')
    expect(worker.calls.map((c) => c.channel)).toEqual(['shareCopy:rootDesks'])
    expect(linkRecord(A)).toBeNull()
    expect(untrackedDesksPossible()).toBe(true)
  })

  it('...the only desk in the database: it can only be this link’s, so it goes, and the store with it on the next load', async () => {
    headCopy()
    worker.roots = ['desk-1']
    await dropLinkCopy(A, 'forget')
    expect(worker.calls).toEqual([
      { channel: 'shareCopy:rootDesks', args: [] },
      { channel: 'shareCopy:removeDesk', args: ['desk-1'] }
    ])
    expect(readLinkRecords()).toEqual({})
    expect(untrackedDesksPossible()).toBe(false)
    expect(localStorage.getItem('fb.share.wipePending')).toBe('1')
  })

  it('...but not while another link is recorded: then it cannot be told apart', async () => {
    headCopy()
    markImported(B, t0, offer('desk-B'))
    worker.roots = ['desk-1']
    await dropLinkCopy(A, 'forget')
    expect(worker.calls).toEqual([])
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })

  it('the tab showing a desk whose clock ran out removes it even when another tab already dropped the record', async () => {
    markImported(B, t0, offer('desk-B'))
    await dropLinkCopy(A, 'forget', { databaseOpenHere: true, showing: 'desk-A' })
    expect(worker.calls).toEqual([{ channel: 'shareCopy:removeDesk', args: ['desk-A'] }])
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })

  it('...unless another link still names that desk', async () => {
    markImported(B, t0, offer('desk-A'))
    await dropLinkCopy(A, 'forget', { databaseOpenHere: true, showing: 'desk-A' })
    expect(worker.calls).toEqual([])
  })

  it('wipe, database not open here: the whole store, every record, without asking the database', async () => {
    markImported(A, t0, offer('desk-A'))
    await dropLinkCopy(A, 'wipe')
    expect(worker.calls).toEqual([])
    expect(readLinkRecords()).toEqual({})
  })

  it('wipe, database open here (the clock ran out on screen): the rows now, the rest on the next load', async () => {
    markImported(A, t0, offer('desk-A'))
    await dropLinkCopy(A, 'wipe', { databaseOpenHere: true })
    expect(worker.calls).toEqual([{ channel: 'shareCopy:removeDesk', args: ['desk-A'] }])
    expect(readLinkRecords()).toEqual({})
    expect(localStorage.getItem('fb.share.wipePending')).toBe('1')
  })
})

describe('the wipe a closing page asks the next load for', () => {
  it('is done when nothing has been unpacked since, and asked for once', async () => {
    requestWipeOnNextLoad()
    localStorage.setItem('fb.share.untracked', '1')
    await finishPendingWipe()
    expect(localStorage.getItem('fb.share.wipePending')).toBeNull()
    expect(localStorage.getItem('fb.share.untracked')).toBeNull() // the store went, records and all
  })

  it('is not done once another link has been opened: that desk is not the old link’s to take', async () => {
    requestWipeOnNextLoad()
    markImported(B, t0, offer('desk-B'))
    await finishPendingWipe()
    expect(localStorage.getItem('fb.share.wipePending')).toBeNull()
    expect(Object.keys(readLinkRecords())).toEqual([B])
  })
})
