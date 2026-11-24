// @vitest-environment node
// Reversible workspace actions (SPEC-AI-SPACE §5 Undo): filing a capture and
// judging a possible match can be undone, and Impact honours the person's most
// recent judgement.

import { describe, expect, it } from 'vitest'
import { memSqlDb } from './_memdb'
import { createAiSpaceStore } from '../../src/main/aispace/store'
import { computeImpact } from '../../src/shared/aispace/impact'

function setup() {
  let t = Date.UTC(2026, 10, 24, 1)
  let n = 0
  const store = createAiSpaceStore(memSqlDb(), { now: () => (t += 1000), newId: (p) => `${p}_${++n}` })
  const [ws] = store.ensureDefaultWorkspaces()
  return { store, ws }
}

describe('undo', () => {
  it('unfiling puts a capture back in the inbox', () => {
    const { store, ws } = setup()
    const p = store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const { thread } = store.captureChat({ workspaceId: ws.id, projectId: null, url: 'https://claude.ai/chat/abc', title: 'Pricing chat', provider: 'claude_web' })
    store.fileThread(thread.id, p.id)
    expect(store.listThreads({ workspaceIds: [ws.id] }, null)).toHaveLength(0)
    store.unfileThread(thread.id)
    expect(store.listThreads({ workspaceIds: [ws.id] }, null).map((x) => x.id)).toEqual([thread.id])
  })

  it('a dismissed match shows again after undo, and the latest judgement wins', () => {
    const { store, ws } = setup()
    const p = store.createProject({ workspaceId: ws.id, title: 'Launch' })
    const blog = store.createOutput({ projectId: p.id, kind: 'document', title: 'Blog' })
    store.addVersion({ outputId: blog.id, content: 'Our 14-day trial', author: 'user:me' })
    store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial 14', value: '14 days', status: 'approved' })
    const d = store.recordDecision({ projectId: p.id, topic: 'trial', title: 'Trial 30', value: '30 days', status: 'approved' })
    const changeId = `chg_${d.id}`
    const item = () => computeImpact(store.loadProjectState(p.id)).rows.find((r) => r.change.id === changeId)!.affected.find((a) => a.ref.id === blog.id)
    expect(item()?.relation).toBe('possible')

    const judge = (related: boolean) => {
      const { suggestion } = store.createSuggestion({ projectId: p.id, fromActor: 'user:me', recipient: 'agent:Project Manager', target: { type: 'output', id: blog.id }, targetVersionId: null, evidence: [], proposedAction: `${related ? 'Related to' : 'Not related to'} ${changeId}`, sourceEventId: `match:${changeId}` })
      store.resolveSuggestion(suggestion.id, related ? 'acted' : 'dismissed', 'user:me')
      return suggestion.id
    }
    const dismissed = judge(false)
    expect(item()).toBeUndefined()
    store.reopenSuggestion(dismissed)
    expect(item()?.relation).toBe('possible')
    // Dismiss, then later confirm: the confirmation (most recent) wins.
    judge(false)
    judge(true)
    expect(item()?.relation).toBe('recorded')
    expect(item()?.evidence[0].text).toBe('You confirmed this match.')
  })
})
