// @vitest-environment node
// Regression: rewriting a request body must not keep the SDK's content-length
// for the old body. undici refuses such a request outright, and the SDK reports
// it as "Connection error." — every Haiku 5.5 call failed this way in
// 4.3.30–4.3.33 (found by the local-AI eval's cloud reference run).
import { describe, it, expect } from 'vitest'
import { rewriteJsonBody } from '../../src/main/ai/modelClient'
import { withModelDefaults } from '../../src/main/ai/modelRouting'

describe('rewriteJsonBody', () => {
  it('drops a stale content-length when the body changes', () => {
    const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 5, messages: [] })
    const init = { method: 'POST', headers: { 'content-length': String(body.length), 'x-api-key': 'k' }, body }
    const next = rewriteJsonBody(init, (b) => withModelDefaults(b))!
    const h = new Headers(next.headers as HeadersInit)
    expect(h.get('content-length')).toBeNull()
    expect(h.get('x-api-key')).toBe('k')
    expect(JSON.parse(next.body as string).thinking).toEqual({ type: 'disabled' })
  })

  it('leaves an unchanged request exactly as it was', () => {
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', messages: [] })
    const init = { headers: { 'content-length': String(body.length) }, body }
    expect(rewriteJsonBody(init, (b) => withModelDefaults(b))).toBe(init)
  })

  it('a rewritten body is accepted by fetch (no length mismatch)', async () => {
    const body = JSON.stringify({ model: 'claude-haiku-5-5', messages: [] })
    const init = { method: 'POST', headers: { 'content-length': String(body.length) }, body }
    const next = rewriteJsonBody(init, (b) => withModelDefaults(b))!
    // A Request validates the same way the network layer does.
    const req = new Request('http://localhost/v1/messages', next as RequestInit)
    expect(await req.text()).toBe(next.body)
  })
})
