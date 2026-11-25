// The widget host's window.api: a private Worker per page (F2 item 3).
//
// The share app routes every call through dbClient, which elects ONE tab per
// origin over a Web Lock and a BroadcastChannel to hold the workspace. Two
// PlexiiLite tiles are two pages from one origin, so they would have shared a
// database through whichever tile won the lock -- and a tile closing would have
// failed the other's calls in flight. The host's transport talks to its own
// Worker only: no lock, no channel, no other page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWorkerTransport } from '../../src/web/widgetHost/hostTransport'

class FakeWorker {
  sent: unknown[] = []
  onmessage: ((ev: MessageEvent) => void) | null = null
  postMessage(m: unknown): void { this.sent.push(m) }
  reply(data: unknown): void { this.onmessage?.({ data } as MessageEvent) }
}

let locksUsed = 0
let channelsMade = 0
beforeEach(() => {
  locksUsed = 0
  channelsMade = 0
  vi.stubGlobal('BroadcastChannel', class { constructor() { channelsMade++ } })
  vi.stubGlobal('navigator', { ...globalThis.navigator, locks: { request: () => { locksUsed++ } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('the widget host transport', () => {
  it('hands the Worker a signed-out session before anything else', () => {
    const w = new FakeWorker()
    createWorkerTransport(w as unknown as Worker)
    expect(w.sent[0]).toEqual({ kind: 'init', session: { sessionToken: null, skippedAt: null, cachedEmail: null } })
  })

  it('a call goes to its own Worker and comes back by id', async () => {
    const w = new FakeWorker()
    const t = createWorkerTransport(w as unknown as Worker)
    const a = t.call('widgetFiles:get', ['f1'])
    const b = t.call('documents:get', ['d1'])
    const [ra, rb] = w.sent.slice(1) as Array<{ id: number; channel: string; args: unknown[] }>
    expect(ra).toMatchObject({ channel: 'widgetFiles:get', args: ['f1'] })
    expect(rb).toMatchObject({ channel: 'documents:get', args: ['d1'] })
    w.reply({ id: rb.id, ok: true, value: { id: 'd1' }, channel: 'documents:get' })
    w.reply({ id: ra.id, ok: true, value: { id: 'f1' }, channel: 'widgetFiles:get' })
    await expect(a).resolves.toEqual({ id: 'f1' })
    await expect(b).resolves.toEqual({ id: 'd1' })
  })

  it('a refusal rejects with its message, and an unserved channel is counted', async () => {
    const w = new FakeWorker()
    const t = createWorkerTransport(w as unknown as Worker)
    const p = t.call('workItems:list', [])
    const req = w.sent[1] as { id: number }
    w.reply({ id: req.id, ok: false, unserved: true, error: 'workItems:list is not available in the browser runtime yet', channel: 'workItems:list' })
    await expect(p).rejects.toThrow('workItems:list is not available')
    expect(t.unserved()).toEqual([{ channel: 'workItems:list', calls: 1 }])
  })

  it('pushes reach their subscribers and the any-change listener; unsubscribing stops them', () => {
    const w = new FakeWorker()
    const t = createWorkerTransport(w as unknown as Worker)
    const seen: unknown[][] = []
    const any: string[] = []
    const off = t.subscribe('tables:changed', (...args) => seen.push(args))
    t.onPush((event) => any.push(event))
    w.reply({ event: 'tables:changed', args: ['t1'] })
    w.reply({ event: 'documents:changed', args: ['d1'] })
    off()
    w.reply({ event: 'tables:changed', args: ['t2'] })
    expect(seen).toEqual([['t1']])
    expect(any).toEqual(['tables:changed', 'documents:changed', 'tables:changed'])
  })

  it('never takes a Web Lock or opens a BroadcastChannel', async () => {
    const w = new FakeWorker()
    const t = createWorkerTransport(w as unknown as Worker)
    void t.call('widgetFiles:list', [])
    expect(locksUsed).toBe(0)
    expect(channelsMade).toBe(0)
  })
})
