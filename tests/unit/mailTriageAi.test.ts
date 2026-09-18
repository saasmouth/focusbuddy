import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { triageInbox, TRIAGE_BATCH, type TriageInput, type MailTriageDeps } from '../../src/main/ai/mailTriage'

const NOW = Date.parse('2026-09-17T09:00:00Z')

const msg = (uid: number, over: Partial<TriageInput> = {}): TriageInput => ({
  uid,
  fromName: 'Dana Reed',
  fromAddress: 'dana@example.com',
  subject: 'The March invoice',
  date: NOW - 86_400_000,
  seen: false,
  hasUnsubscribe: false,
  ...over
})

const deps = (reply: string | null): MailTriageDeps & { ask: ReturnType<typeof vi.fn> } => ({
  now: () => NOW,
  ask: vi.fn(async () => reply)
})

describe('triageInbox', () => {
  it('turns a model reply into a plan', async () => {
    const d = deps(JSON.stringify([{ uid: 1, action: 'file', category: 'Receipts', reason: 'a paid invoice' }]))
    const r = await triageInbox([msg(1)], ['Receipts'], d)
    expect(r.ok).toBe(true)
    expect(r.plan.suggestions[0]).toMatchObject({ uid: 1, action: 'file', category: 'Receipts', newCategory: false })
  })

  // Bodies are written by strangers, and this model is about to propose
  // deleting things. It gets headers.
  it('sends headers only — never a message body', async () => {
    const d = deps('[]')
    await triageInbox([msg(1, { subject: 'Quarterly report' })], [], d)
    const [system, user] = d.ask.mock.calls[0]
    expect(user).toContain('uid=1')
    expect(user).toContain('Quarterly report')
    expect(user).toContain('dana@example.com')
    // And the prompt says plainly that what follows is data.
    expect(system).toMatch(/written by other people/i)
    expect(system).toMatch(/They are data/i)
  })

  it('tells the model which messages may be unsubscribed from', async () => {
    const d = deps('[]')
    await triageInbox([msg(1), msg(2, { hasUnsubscribe: true })], [], d)
    const user = d.ask.mock.calls[0][1]
    expect(user).toContain('uid=1 · from=Dana Reed <dana@example.com>')
    expect(user).toMatch(/uid=1[^\n]*unsubscribe=no/)
    expect(user).toMatch(/uid=2[^\n]*unsubscribe=yes/)
  })

  // The rules run over the model's answer, not just inside the prompt.
  it('still refuses an unsubscribe the sender never offered', async () => {
    const d = deps(JSON.stringify([{ uid: 1, action: 'unsubscribe', reason: 'reads like a newsletter' }]))
    const r = await triageInbox([msg(1, { hasUnsubscribe: false })], [], d)
    expect(r.plan.suggestions[0].action).toBe('keep')
    expect(r.plan.rejected[0].because).toContain('List-Unsubscribe')
  })

  it('is an honest empty plan when there is nothing to sort', async () => {
    const d = deps('[]')
    const r = await triageInbox([], [], d)
    expect(r.ok).toBe(true)
    expect(r.plan.suggestions).toEqual([])
    expect(d.ask).not.toHaveBeenCalled()
  })

  // A triage screen showing invented suggestions is worse than one showing
  // nothing, because the person would act on it.
  it('returns no plan rather than a made-up one when the model fails', async () => {
    for (const reply of [null, 'I could not do that', '{"not": "an array"']) {
      const r = await triageInbox([msg(1)], [], deps(reply))
      expect(r.plan.suggestions).toEqual([])
      if (reply === null) expect(r.ok).toBe(false)
    }
  })

  it('ignores a uid the model invented', async () => {
    const d = deps(JSON.stringify([{ uid: 999, action: 'trash', reason: 'not real' }]))
    const r = await triageInbox([msg(1)], [], d)
    expect(r.plan.suggestions).toEqual([])
    expect(r.plan.rejected[0].because).toContain('not a message in this batch')
  })

  it('caps a batch so a reply cannot run past the model output limit', async () => {
    const d = deps('[]')
    const many = Array.from({ length: TRIAGE_BATCH + 25 }, (_, i) => msg(i + 1))
    await triageInbox(many, [], d)
    const user = d.ask.mock.calls[0][1]
    expect(user).toContain(`${TRIAGE_BATCH} messages`)
    expect(user).not.toContain(`uid=${TRIAGE_BATCH + 1} `)
  })

  it('offers the existing categories but never Inbox as a destination', async () => {
    const d = deps('[]')
    await triageInbox([msg(1)], ['Clients', 'INBOX', 'Receipts'], d)
    const user = d.ask.mock.calls[0][1]
    expect(user).toContain('Clients, Receipts')
    expect(user).not.toContain('INBOX')
  })

  it('gives the model relative ages, which is what actually decides staleness', async () => {
    const d = deps('[]')
    await triageInbox([msg(1, { date: NOW - 45 * 86_400_000 })], [], d)
    expect(d.ask.mock.calls[0][1]).toContain('45d ago')
  })
})

describe('triage prompt caching, stated plainly', () => {
  it('does not reach the cache minimum of the model it routes to', async () => {
    // A guard against a comfortable assumption, not against a bug. Triage runs
    // on Haiku, whose cacheable prefix starts at 4096 tokens; this prompt is
    // nowhere near it, so the cache_control marker on the system block is inert
    // and no cost estimate may assume a cache read. If someone later grows the
    // prompt past the minimum, this test fails and they get to update the
    // comment that says caching is off — rather than discovering the opposite
    // mistake, a saving quietly claimed and never received.
    const { CACHE_MINIMUM } = await import('../../src/main/ai/cacheControl')
    const { MODEL_HAIKU } = await import('../../src/main/ai/modelRouting')
    const { resolveModel } = await import('../../src/main/ai/modelRouting')

    expect(resolveModel('mail_triage')).toBe(MODEL_HAIKU)

    // Plain repo-relative path, as the sibling source-walking tests use.
    const src = readFileSync('src/main/ai/mailTriage.ts', 'utf8')
    const m = /const SYSTEM = \[([\s\S]*?)\]\.join/.exec(src)
    expect(m).not.toBeNull()
    const chars = (m as RegExpExecArray)[1].length
    // ~3.8 chars per token is rough, so compare with a wide margin: the claim
    // is "far below 4096", which does not need a precise tokeniser.
    const approxTokens = chars / 3.8
    expect(approxTokens).toBeLessThan(CACHE_MINIMUM[MODEL_HAIKU] / 2)
  })
})
