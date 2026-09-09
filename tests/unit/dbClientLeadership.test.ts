// The multi-tab coordinator, at the point where it can lose or duplicate work.
//
// OPFS lets exactly one tab hold the database, so every other tab sends its
// calls to that one. The interesting states are the two edges: a call made
// before any tab is serving, and a call that was already running when the tab
// serving it disappeared. The first must be sent on -- it never ran, so it is
// simply waiting. The second must NOT be sent on: its write may have committed
// in the instant before the tab closed, and re-sending would turn one
// nodes:create into two desks. These tests hold that distinction in place.
//
// Only the follower half is exercised. The leader half constructs a real
// Worker, which needs a browser; it is covered by the two-tab run in
// scripts/verify-cloud-roundtrip.mjs.
import { describe, it, expect, beforeEach, vi } from 'vitest'

interface Posted { kind: string; [k: string]: unknown }

class FakeBroadcastChannel {
  static live: FakeBroadcastChannel[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  posted: Posted[] = []
  constructor(public name: string) {
    FakeBroadcastChannel.live.push(this)
  }
  postMessage(msg: Posted): void {
    this.posted.push(msg)
  }
  /** Simulate a message arriving from another tab. */
  deliver(msg: unknown): void {
    this.onmessage?.({ data: msg } as MessageEvent)
  }
  close(): void {}
}

/** A lock that is never granted, so the tab under test stays a follower. */
const neverGranted = { request: vi.fn(() => new Promise<never>(() => {})) }

async function freshClient(): Promise<typeof import('../../src/web/api/dbClient')> {
  vi.resetModules()
  FakeBroadcastChannel.live = []
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  vi.stubGlobal('navigator', { locks: neverGranted })
  const mod = await import('../../src/web/api/dbClient')
  mod.startCoordinator()
  return mod
}

const channel = (): FakeBroadcastChannel => FakeBroadcastChannel.live[0]
const reqs = (): Posted[] => channel().posted.filter((m) => m.kind === 'req')

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('a follower with no leader yet', () => {
  it('asks whether anyone is serving, rather than assuming', async () => {
    await freshClient()
    expect(channel().posted.map((m) => m.kind)).toContain('who')
  })

  it('holds calls instead of broadcasting into an empty channel', async () => {
    const { dbCall } = await freshClient()
    void dbCall('nodes:create', [{ title: 'a desk' }])
    // BroadcastChannel does not queue. A message sent with nobody listening is
    // gone, and marking it sent would later fail a call that never ran.
    expect(reqs()).toHaveLength(0)
  })

  it('sends what it was holding once a leader announces itself', async () => {
    const { dbCall } = await freshClient()
    void dbCall('nodes:create', [{ title: 'a desk' }])
    channel().deliver({ kind: 'leader' })
    expect(reqs()).toHaveLength(1)
    expect(reqs()[0].channel).toBe('nodes:create')
  })

  it('resolves the call when the leader answers it', async () => {
    const { dbCall } = await freshClient()
    const call = dbCall('nodes:list', [])
    channel().deliver({ kind: 'leader' })
    const sent = reqs()[0]
    channel().deliver({ kind: 'res', tab: sent.tab, id: sent.id, ok: true, value: [{ id: 'n1' }], channel: 'nodes:list' })
    await expect(call).resolves.toEqual([{ id: 'n1' }])
  })
})

describe('when the tab serving the database disappears', () => {
  it('fails a call that was already running rather than repeating it', async () => {
    const { dbCall } = await freshClient()
    channel().deliver({ kind: 'leader' })
    const call = dbCall('nodes:create', [{ title: 'once, please' }])
    expect(reqs()).toHaveLength(1)

    // A different tab won the lock: the previous one is gone and its answer
    // with it. Whether the insert committed is unknowable from here.
    channel().deliver({ kind: 'leader' })

    await expect(call).rejects.toThrow(/closed while this was running/)
    // The decisive assertion: it was not sent a second time.
    expect(reqs()).toHaveLength(1)
  })

  it('still sends a call that had only been queued, which cannot have run', async () => {
    const { dbCall } = await freshClient()
    const queued = dbCall('nodes:create', [{ title: 'never left the tab' }])
    expect(reqs()).toHaveLength(0)
    channel().deliver({ kind: 'leader' })
    expect(reqs()).toHaveLength(1)
    const sent = reqs()[0]
    channel().deliver({ kind: 'res', tab: sent.tab, id: sent.id, ok: true, value: { id: 'n2' }, channel: 'nodes:create' })
    await expect(queued).resolves.toEqual({ id: 'n2' })
  })
})

describe('refusals and pushes', () => {
  it('records a refused channel by name so the parity gap is measurable', async () => {
    const { dbCall, unservedChannels } = await freshClient()
    const call = dbCall('mail:getAccount', [])
    channel().deliver({ kind: 'leader' })
    const sent = reqs()[0]
    channel().deliver({
      kind: 'res', tab: sent.tab, id: sent.id, ok: false, unserved: true,
      channel: 'mail:getAccount', error: 'mail:getAccount is not available in the browser runtime yet'
    })
    await expect(call).rejects.toThrow(/not available/)
    expect(unservedChannels()).toEqual([{ channel: 'mail:getAccount', calls: 1 }])
  })

  it('delivers a push from the serving tab to a subscriber here', async () => {
    const { dbSubscribe } = await freshClient()
    const seen: unknown[] = []
    dbSubscribe('tables:rowsChanged', (id) => seen.push(id))
    channel().deliver({ kind: 'push', event: 'tables:rowsChanged', args: ['tbl_7'] })
    expect(seen).toEqual(['tbl_7'])
  })

  it('stops delivering after unsubscribe', async () => {
    const { dbSubscribe } = await freshClient()
    const seen: unknown[] = []
    const off = dbSubscribe('tables:rowsChanged', (id) => seen.push(id))
    off()
    channel().deliver({ kind: 'push', event: 'tables:rowsChanged', args: ['tbl_7'] })
    expect(seen).toEqual([])
  })
})
