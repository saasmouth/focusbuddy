// Sharing a desk sends its name (rootTitle), so the sharer's credit notice can
// say what they shared (share credit, 4.3.52; server: desk_invites.root_title).
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../src/renderer/src/lib/workspaceSync', () => ({ syncWorkspaceOnce: vi.fn(async () => 0) }))
vi.mock('../../src/renderer/src/lib/crdtBridge', () => ({ crdtSeedDeskLinks: vi.fn() }))

import { rootTitleFor, shareDeskLive } from '../../src/renderer/src/lib/deskShareClient'
import { useAccountStore } from '../../src/renderer/src/stores/account'
import { useNodeStore } from '../../src/renderer/src/stores/nodes'

type Body = { rootId: string; rootTitle?: string; invites: unknown[]; permission: string }

function seedNode(id: string, title: string): void {
  useNodeStore.setState({ nodes: [{ id, title, kind: 'task' } as never] })
}

let bodies: Body[] = []
beforeEach(() => {
  bodies = []
  useAccountStore.setState({ sessionToken: 'tok' } as never)
  ;(window as unknown as { api: unknown }).api = { workspaceSync: { stampSharedDesk: vi.fn(async () => undefined) } }
  globalThis.fetch = vi.fn(async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}') as Body)
    return new Response(JSON.stringify({ ok: true, access: { grants: [] } }), { status: 200 })
  }) as unknown as typeof fetch
})

describe('the shared desk’s name goes with the share', () => {
  it('a desk’s title is sent as rootTitle, trimmed', async () => {
    seedNode('d1', '  Launch plan  ')
    expect((await shareDeskLive('d1', [{ email: 'bea@example.test' }])).ok).toBe(true)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ rootId: 'd1', rootTitle: 'Launch plan', permission: 'edit' })
  })

  it('a room (a folder node) is named the same way', async () => {
    useNodeStore.setState({ nodes: [{ id: 'r1', title: 'Acme Team', kind: 'folder' } as never] })
    await shareDeskLive('r1', [{ email: 'tom@example.test' }], 'view')
    expect(bodies[0].rootTitle).toBe('Acme Team')
  })

  it('at most 200 characters', () => {
    seedNode('d2', 'x'.repeat(250))
    expect(rootTitleFor('d2')).toHaveLength(200)
  })

  it('a blank name, or a desk not in this workspace, sends no rootTitle at all', async () => {
    seedNode('d3', '   ')
    await shareDeskLive('d3', [{ email: 'a@example.test' }])
    await shareDeskLive('missing', [{ email: 'a@example.test' }])
    expect(bodies.map((b) => 'rootTitle' in b)).toEqual([false, false])
  })
})
