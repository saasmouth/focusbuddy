import { describe, it, expect } from 'vitest'
import { parseBrowserEnvelope, buildBrowserAgentSystemPrompt } from '../../src/main/ai/browserAgentEnvelope'
import { withCacheBreakpoint } from '../../src/main/ai/cacheControl'

describe('parseBrowserEnvelope findings', () => {
  it('captures structured findings from a round', () => {
    const env = parseBrowserEnvelope(
      JSON.stringify({
        narration: 'Reading the directory',
        status: 'working',
        action: { kind: 'scroll', dy: 600 },
        findings: {
          fields: ['name', 'rating'],
          records: [{ name: 'Studio Nine', rating: '4.8' }]
        }
      })
    )
    expect(env?.findings.records).toEqual([{ name: 'Studio Nine', rating: '4.8' }])
    expect(env?.findings.fields).toEqual(['name', 'rating'])
  })

  it('treats a round with no findings as empty rather than failing the round', () => {
    const env = parseBrowserEnvelope('{"narration":"x","status":"working","action":null}')
    expect(env).not.toBeNull()
    expect(env?.findings.records).toEqual([])
    expect(env?.findings.answer).toBe('')
  })

  it('survives a malformed findings block without losing the action', () => {
    const env = parseBrowserEnvelope(
      '{"narration":"x","status":"working","action":{"kind":"scroll","dy":10},"findings":"garbage"}'
    )
    expect(env?.action).toEqual({ kind: 'scroll', dy: 10 })
    expect(env?.findings.records).toEqual([])
  })

  it('carries a prose answer for question-shaped tasks', () => {
    const env = parseBrowserEnvelope(
      '{"narration":"x","status":"done","action":null,"findings":{"answer":"They refund within 30 days."}}'
    )
    expect(env?.findings.answer).toBe('They refund within 30 days.')
  })
})

describe('browser agent system prompt', () => {
  it('tells the model its context is dropped, so it must record as it reads', () => {
    const p = buildBrowserAgentSystemPrompt()
    expect(p).toContain('findings')
    expect(p).toMatch(/will NOT see this page again|dropped from your context/)
  })

  it('forbids inventing values rather than leaving a field absent', () => {
    expect(buildBrowserAgentSystemPrompt()).toMatch(/never fill a field with a guess|Never fill a field with a guess/i)
  })
})

describe('withCacheBreakpoint', () => {
  it('marks the named message so the prefix can be served from cache', () => {
    const out = withCacheBreakpoint([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], 0)
    expect(out[0].content).toEqual([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }])
    expect(out[1].content).toBe('b')
  })

  it('marks the last text block of a block list', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }]
    const out = withCacheBreakpoint(msgs, 0)
    const blocks = out[0].content as Array<Record<string, unknown>>
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('leaves an image-tailed message alone rather than risking a bad request', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', source: { data: 'q' } }] }
    ]
    expect(withCacheBreakpoint(msgs, 0)).toEqual(msgs)
  })

  it('marks nothing for an out-of-range or negative index', () => {
    const msgs = [{ role: 'user', content: 'a' }]
    expect(withCacheBreakpoint(msgs, -1)).toEqual(msgs)
    expect(withCacheBreakpoint(msgs, 5)).toEqual(msgs)
  })
})
