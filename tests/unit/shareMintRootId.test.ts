// A link names the desk or room it was made from (4.3.56).
//
// The owner, 24 Nov 2026: deleting a desk or room ends its links at once. The
// signal does that when the desk's tombstone arrives (endLinksOfDeletedNode), for
// "use" links and live desks, which already name their desk. A copy/read link
// (POST /share) named none, in its row or its snapshot, so it outlived the desk
// until it was revoked or expired. a0's aa6d1cfc stores an optional rootId on
// the share and ends the share with that node; this is the app sending it.
//
// A room's delete trashes every desk under it, and each of those tombstones ends
// that desk's links, so the id to send is the node the link was made from. A
// widget's link names its desk: deleting the desk takes the widget with it.
// Documents, folders of documents and Drive files are not desks; they send none.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/lib/signalConfig', async (orig) => {
  const real = await orig<{ signalConfig: Record<string, unknown> }>()
  return { ...real, signalConfig: { ...real.signalConfig, useRemote: true, httpUrl: 'https://signal.test' } }
})

let posted: Array<Record<string, unknown>>
const widgets: Record<string, { id: string; taskId: string }> = {
  w_1: { id: 'w_1', taskId: 'desk_7' }
}

beforeEach(() => {
  posted = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (new URL(String(url)).pathname === '/share' && init.method === 'POST') {
        posted.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ ok: true, viewerUrl: 'https://view.test/share/x' }), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    })
  )
  ;(globalThis as unknown as { window: unknown }).window ??= globalThis
  ;(window as unknown as { api: unknown }).api = {
    shares: {
      create: vi.fn(async (input: Record<string, unknown>) => ({ id: `s_${input.token}`, revoked: false, ...input }))
    },
    widgets: { get: vi.fn(async (id: string) => widgets[id] ?? null) }
  }
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function mint(kind: string, entityId: string): Promise<Record<string, unknown>> {
  const { useSharesStore } = await import('@renderer/stores/shares')
  await useSharesStore.getState().createFor({
    kind: kind as never,
    entityId,
    label: 'L',
    scope: 'copy',
    snapshot: { any: 1 },
    fromHandle: 'h'
  })
  expect(posted, 'the snapshot went up').toHaveLength(1)
  return posted[0]
}

describe('a copy/read link names the desk or room it was made from', () => {
  it('a desk: its own id', async () => {
    expect((await mint('task', 'desk_1')).rootId).toBe('desk_1')
  })

  it('a room: its own id (its desks end with their own tombstones)', async () => {
    expect((await mint('folder', 'room_1')).rootId).toBe('room_1')
  })

  it('a widget: the desk it is on', async () => {
    expect((await mint('widget', 'w_1')).rootId).toBe('desk_7')
  })

  it('a widget the app can no longer find: none, and the link is still made', async () => {
    expect((await mint('widget', 'w_gone')).rootId).toBeUndefined()
  })

  it('not a desk (documents, document folders, files): none', async () => {
    for (const kind of ['document', 'docfolder', 'file']) {
      posted = []
      expect((await mint(kind, 'x_1')).rootId).toBeUndefined()
    }
  })
})
