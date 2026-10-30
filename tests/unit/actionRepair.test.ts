import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { buildChatResponse, needsActionRepair, repairMissingActions } from '../../src/main/ai/anthropic'

// The bug this covers, reported 2026-10-30: the assistant says it built a
// table on the desk and no card appears, so there is nothing to apply. The
// envelope came back with prose and an empty `actions` array. Telling the user
// "nothing was created" is honest but still leaves them without their table —
// so we ask the model once more for the actions, using its own description as
// the specification.

const CLAIM = JSON.stringify({
  reply: "I've gone ahead and created an Episodes table on your desk with Title, Status and Date columns, and added the twelve rows.",
  actions: []
})

function reply(json: string): Anthropic.Message {
  return {
    content: [{ type: 'text', text: json }],
    usage: { input_tokens: 10, output_tokens: 10 }
  } as unknown as Anthropic.Message
}

/** A client that records what it was asked and answers with `json`. */
function fakeClient(json: string | Error): {
  client: Anthropic
  calls: Array<{ messages: Array<{ role: string; content: unknown }> }>
} {
  const calls: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const client = {
    messages: {
      create: async (args: { messages: Array<{ role: string; content: unknown }> }) => {
        calls.push(args)
        if (json instanceof Error) throw json
        return reply(json)
      }
    }
  } as unknown as Anthropic
  return { client, calls }
}

const GATE = { discovery: false, greenLit: true }

describe('needsActionRepair', () => {
  it('is true for a claim with no card and no question', () => {
    const built = buildChatResponse(CLAIM, [], [], GATE)
    expect(built).toBeTruthy()
    // The correction notice is the signal: this is exactly what the user sees.
    expect(built!.message!.content).toContain('Nothing above was actually created.')
    expect(needsActionRepair(built!)).toBe(true)
  })

  it('is false when the model did emit an action', () => {
    const withCard = JSON.stringify({
      reply: "I've created the Episodes table.",
      actions: [{ kind: 'create-table', title: 'Episodes', columns: ['Title', 'Status'] }]
    })
    const built = buildChatResponse(withCard, [], [], GATE)
    expect(built!.proposals?.length).toBeGreaterThan(0)
    expect(needsActionRepair(built!)).toBe(false)
  })

  it('is false for an offer, which claims nothing', () => {
    const offer = JSON.stringify({ reply: 'I can create a table for that if you like.', actions: [] })
    expect(needsActionRepair(buildChatResponse(offer, [], [], GATE)!)).toBe(false)
  })
})

describe('repairMissingActions', () => {
  const GOOD = JSON.stringify({
    reply: 'Here is the Episodes table.',
    actions: [
      { kind: 'create-table', id: 'eps', title: 'Episodes', columns: ['Title', 'Status', 'Date'] },
      { kind: 'add-table-row', tableId: '$eps', cells: { Title: 'Pilot', Status: 'Draft', Date: '2026-01-01' } }
    ]
  })

  it('turns the empty claim into real, applicable cards', async () => {
    const { client } = fakeClient(GOOD)
    const repaired = await repairMissingActions(client, [], [{ role: 'user', content: 'build me an episodes table' }], CLAIM, [], [], GATE)
    expect(repaired).toBeTruthy()
    expect(repaired!.proposals?.map((p) => p.kind)).toEqual(['create-table', 'add-table-row'])
    // And the apology is gone, because there is now something to apply.
    expect(repaired!.message!.content).not.toContain('Nothing above was actually created.')
  })

  it('hands the model its own prose back as the specification', async () => {
    const { client, calls } = fakeClient(GOOD)
    await repairMissingActions(client, [], [{ role: 'user', content: 'build it' }], CLAIM, [], [], GATE)
    expect(calls).toHaveLength(1)
    const msgs = calls[0].messages
    // original turn, the claim it made, then the demand for the actions
    expect(msgs[0]).toEqual({ role: 'user', content: 'build it' })
    expect(msgs[1]).toEqual({ role: 'assistant', content: CLAIM })
    expect(String(msgs[2].content)).toContain('`actions` array was empty')
    expect(msgs[2].role).toBe('user')
  })

  it('keeps the correction notice when the retry is also empty', async () => {
    const { client } = fakeClient(JSON.stringify({ reply: 'Done, the table is ready.', actions: [] }))
    expect(await repairMissingActions(client, [], [], CLAIM, [], [], GATE)).toBeNull()
  })

  it('keeps the correction notice when the retry is unparseable', async () => {
    const { client } = fakeClient('not json at all')
    expect(await repairMissingActions(client, [], [], CLAIM, [], [], GATE)).toBeNull()
  })

  it('keeps the correction notice when the retry throws', async () => {
    const { client } = fakeClient(new Error('network down'))
    expect(await repairMissingActions(client, [], [], CLAIM, [], [], GATE)).toBeNull()
  })

  it('retries exactly once — no loop', async () => {
    const { client, calls } = fakeClient(JSON.stringify({ reply: 'Created the table.', actions: [] }))
    await repairMissingActions(client, [], [], CLAIM, [], [], GATE)
    expect(calls).toHaveLength(1)
  })
})

// The repair only helps if every chat path runs it. Both entry points build a
// ChatResponse from the model's envelope, and both can hit the empty-actions
// claim; a third path added later must not quietly skip the check. Asserted
// against the source because the entry points themselves need a live client,
// retrieval and the workspace store to run.
describe('both chat paths run the repair', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs')
  const { join } = require('node:path') as typeof import('node:path')
  const src = readFileSync(join(__dirname, '../..', 'src/main/ai/anthropic.ts'), 'utf-8')

  /** The body of a top-level exported function, up to the next one. */
  function bodyOf(name: string): string {
    const at = src.indexOf(`export async function ${name}(`)
    expect(at, `${name} not found`).toBeGreaterThan(-1)
    const next = src.indexOf('\nexport ', at + 1)
    return src.slice(at, next === -1 ? src.length : next)
  }

  it.each(['sendChat', 'sendChatStream'])('%s checks needsActionRepair', (name) => {
    const body = bodyOf(name)
    expect(body).toContain('buildChatResponse(')
    expect(body).toContain('needsActionRepair(')
    expect(body).toContain('repairMissingActions(')
  })
})
