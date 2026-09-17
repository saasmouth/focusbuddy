import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleMcpMessage, handleMcpBody, type McpDeps } from '../../src/main/mcpRecall'

// Recall over MCP (the G3 round). The contract under test: a spec-correct
// JSON-RPC surface (initialize / ping / tools list+call / notifications),
// three READ-ONLY tools whose every answer carries attribution, and a route
// that inherits ALL of PlexiAPI's guards rather than growing its own.
//
// History: the protocol layer moved into mcpProtocol.ts (shared with the
// workspace server, mcpServer.ts) and became async so tools may await the
// stores. The Recall tools, their names, and every refusal are unchanged;
// the pins here were rewritten to await rather than deleted.

const SEGS = [
  { id: 's1', meetingId: 'm1', meetingTitle: 'Weekly sync', speakerAccountId: 'a1', speakerName: 'Dana', startMs: 30000, endMs: 33000, text: 'the contract must be countersigned by Friday', rank: -1 }
]
const MEETING = {
  id: 'm1', title: 'Weekly sync', transcript: '', summary: 'Contract discussed.',
  actionItems: ['Countersign the contract'], durationSec: 300, record: null, deskNodeId: null,
  seriesId: null, blockId: null, createdAt: 1756700000000, updatedAt: 1756700000000
}
function deps(over: Partial<McpDeps> = {}): McpDeps {
  return {
    searchSegments: () => SEGS,
    getMeeting: (id: string) => (id === 'm1' ? MEETING : null),
    listMeetings: () => [MEETING],
    listSegments: () => [
      { id: 's1', meetingId: 'm1', speakerAccountId: 'a1', speakerName: 'Dana', startMs: 30000, endMs: 33000, text: 'the contract must be countersigned by Friday', confidence: 0.9 }
    ],
    serverVersion: '9.9.9',
    ...over
  } as McpDeps
}
const call = (method: string, params?: Record<string, unknown>): ReturnType<typeof handleMcpMessage> =>
  handleMcpMessage({ jsonrpc: '2.0', id: 1, method, params }, deps())
type Reply = Awaited<ReturnType<typeof handleMcpMessage>>

describe('the JSON-RPC surface', async () => {
  it('initialize echoes a known protocol version and names the server', async () => {
    const r = (await call('initialize', { protocolVersion: '2025-06-18' })) as { result: Record<string, unknown> }
    expect(r.result.protocolVersion).toBe('2025-06-18')
    expect(r.result.serverInfo).toEqual({ name: 'plexii-recall', version: '9.9.9' })
    expect(r.result.capabilities).toEqual({ tools: {} })
  })

  it('an unknown offered version gets our default, not a lie', async () => {
    const r = (await call('initialize', { protocolVersion: '2099-01-01' })) as { result: { protocolVersion: string } }
    expect(r.result.protocolVersion).toBe('2025-06-18')
  })

  it('notifications get no body (the 202 path), alone or in a batch', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps())).toBeNull()
    expect(await handleMcpBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }], deps())).toBeNull()
  })

  it('ping pongs; invalid and unknown are proper JSON-RPC errors', async () => {
    expect(((await call('ping')) as { result: unknown }).result).toEqual({})
    const bad = (await handleMcpMessage({ id: 1, method: 'x' }, deps())) as { error: { code: number } }
    expect(bad.error.code).toBe(-32600)
    const unknown = (await call('no/such')) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32601)
  })

  it('tools/list offers exactly the three read-only tools', async () => {
    const r = (await call('tools/list')) as { result: { tools: Array<{ name: string; description: string }> } }
    expect(r.result.tools.map((t) => t.name)).toEqual(['recall_search', 'recall_meeting', 'recall_recent_meetings'])
    for (const t of r.result.tools) expect(t.description).toContain('Read-only')
  })
})

describe('the tools — attributed answers, honest failures', async () => {
  const text = (r: Reply): string =>
    ((r as { result: { content: Array<{ text: string }> } }).result.content[0] ?? { text: '' }).text

  it('recall_search returns the attributed line WITH its meeting identity', async () => {
    const out = text(await call('tools/call', { name: 'recall_search', arguments: { query: 'contract' } }))
    expect(out).toContain('[0:30] Dana: the contract must be countersigned by Friday')
    expect(out).toContain('“Weekly sync” (meetingId: m1)')
  })

  it('an empty search is an honest zero, not a failure', async () => {
    const r = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_search', arguments: { query: 'zzz' } } },
      deps({ searchSegments: () => [] })
    )) as { result: { isError?: boolean; content: Array<{ text: string }> } }
    expect(r.result.isError).toBeUndefined()
    expect(r.result.content[0].text).toContain('an honest zero')
  })

  it('recall_meeting renders summary, action items and the attributed transcript', async () => {
    const out = text(await call('tools/call', { name: 'recall_meeting', arguments: { meetingId: 'm1' } }))
    expect(out).toContain('# Weekly sync')
    expect(out).toContain('Contract discussed.')
    expect(out).toContain('- Countersign the contract')
    expect(out).toContain('[0:30] Dana:')
  })

  it('a very long transcript truncates WITH a note, never silently', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      id: `s${i}`, meetingId: 'm1', speakerAccountId: 'a1', speakerName: 'Dana',
      startMs: i * 1000, endMs: i * 1000 + 900, text: 'a fairly long spoken line about the project status', confidence: null
    }))
    const r = (await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall_meeting', arguments: { meetingId: 'm1' } } },
      deps({ listSegments: () => many })
    ))
    expect(text(r)).toContain('[… truncated — the full transcript lives in Plexii]')
  })

  it('unknown meeting and unknown tool answer isError, not an exception', async () => {
    const gone = (await call('tools/call', { name: 'recall_meeting', arguments: { meetingId: 'nope' } })) as {
      result: { isError?: boolean }
    }
    expect(gone.result.isError).toBe(true)
    const unk = (await call('tools/call', { name: 'delete_everything', arguments: {} })) as { result: { isError?: boolean } }
    expect(unk.result.isError).toBe(true)
  })
})

// ── source pins ─────────────────────────────────────────────────────────────

const ROOT = join(__dirname, '..', '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

describe('MCP wiring pins', async () => {
  const server = read('src/main/apiServer.ts')
  const mcp = read('src/main/mcpRecall.ts')
  const access = read('src/shared/apiAccess.ts')
  const view = read('src/renderer/src/components/views/PlexiApiView.tsx')

  it('the route mounts BEHIND PlexiAPI auth and asks for read scope explicitly', async () => {
    const authIdx = server.indexOf('const scopes = authScopes(req)')
    const mcpIdx = server.indexOf("if (path === '/mcp')")
    const writeGateIdx = server.indexOf("const needWrite = method === 'POST'")
    expect(authIdx).toBeGreaterThan(-1)
    expect(mcpIdx).toBeGreaterThan(authIdx)
    expect(mcpIdx).toBeLessThan(writeGateIdx)
    expect(server).toContain("if (!scopes.includes('read') && !scopes.includes('write'))")
    expect(server).toContain("return send(res, 405, { error: 'MCP speaks POST here.' })")
  })

  it('the refusals are stated where they are enforced', async () => {
    expect(mcp).toContain('READ-ONLY forever: no tool on this surface writes, files, or sends')
    expect(mcp).toContain('No audio: bytes never leave the machine')
    expect(mcp).toContain('loopback only, token required')
  })

  it('the endpoint is documented, and the view teaches the client config', async () => {
    expect(access).toContain("path: '/mcp', scope: 'read'")
    expect(view).toContain('data-testid="mcp-howto"')
    expect(view).toContain('claude mcp add --transport http plexii ')
  })
})
