// The renderer half of chatGroundingPersist.test.ts: opening a saved
// conversation puts each turn's saved "check this" marks back, exactly as
// saved, and never runs a grounding check to make new ones.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnswerGrounding } from '../../src/shared/types'

const MARKS: AnswerGrounding = {
  path: 'local',
  repaired: [{ span: '24/7', kind: 'time', confidence: 'high', reason: 'Not in your documents' }],
  flagged: [{ span: '3 March', kind: 'date', confidence: 'medium', reason: 'No source gives this date' }]
}

describe('the chat store restores the marks as saved, and never computes them', () => {
  it('openConversation puts each saved finding back on its turn; turns without one get none', async () => {
    const getConversation = vi.fn(async () => ({
      meta: { id: 'c1', taskId: null, title: 'T', createdAt: 1, updatedAt: 1, linkedDesks: [] },
      messages: [
        { id: 'm1', role: 'user', content: 'Q', ts: 10, proposals: [], applied: {}, sources: [], question: null, trace: null, mentions: [], blocks: [], grounding: null },
        { id: 'm2', role: 'assistant', content: 'A', ts: 11, proposals: [], applied: {}, sources: [], question: null, trace: null, mentions: [], blocks: [], grounding: MARKS },
        // An older backend that never sends the field.
        { id: 'm3', role: 'assistant', content: 'B', ts: 12, proposals: [], applied: {}, sources: [], question: null, trace: null, mentions: [], blocks: [] }
      ]
    }))
    ;(window as unknown as { api: unknown }).api = { aiChat: { getConversation } }
    const { useChatStore } = await import('../../src/renderer/src/stores/chat')
    useChatStore.setState({ groundingByMessage: {} })
    await useChatStore.getState().openConversation('c1')
    const g = useChatStore.getState().groundingByMessage
    expect(g['11']).toEqual(MARKS)
    expect(g['10']).toBeUndefined()
    expect(g['12']).toBeUndefined()
  })

  it('the finished turn is saved with the response\'s grounding (source check)', async () => {
    const src = readFileSync(join(__dirname, '../../src/renderer/src/stores/chat.ts'), 'utf8')
    expect(src).toContain("grounding: resp.ok ? (resp.grounding ?? null) : null")
    // Reopen never calls a grounding check.
    const open = src.slice(src.indexOf('openConversation: async'), src.indexOf('openConversation: async') + 4000)
    expect(open).not.toMatch(/checkInventedSpecifics|groundAnswer|answerGrounding/)
  })
})
