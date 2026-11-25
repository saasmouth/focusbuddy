// The chat store's side of the desk hello gate (main/deskWelcomeGate.ts).
// With Background AI tasks off, main answers an unasked hello with
// { ok: false, reason: 'background_ai_off' }. That is not an error: the store
// adds nothing and shows nothing. And the store passes the caller's options
// through, so the Pre-Task Bridge's click arrives in main as { asked: true }.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatResponse, ProactiveWelcomeOpts } from '../../src/shared/types'
import { useChatStore } from '../../src/renderer/src/stores/chat'

const TASK = 'desk-1'
let answer: ChatResponse = { ok: false, reason: 'background_ai_off' }
const proactiveWelcome = vi.fn(async (_taskId: string, _opts?: ProactiveWelcomeOpts) => answer)

beforeEach(() => {
  proactiveWelcome.mockClear()
  ;(window as unknown as { api: unknown }).api = { chat: { proactiveWelcome } }
  useChatStore.setState({ messagesByTask: {}, hasApiKey: true })
})

describe('the desk hello in the chat store', () => {
  it('unasked, it asks main with no options (main decides)', async () => {
    await useChatStore.getState().sendProactiveWelcome(TASK)
    expect(proactiveWelcome).toHaveBeenCalledWith(TASK, undefined)
  })

  it('a click passes { asked: true } through', async () => {
    await useChatStore.getState().sendProactiveWelcome(TASK, { asked: true })
    expect(proactiveWelcome).toHaveBeenCalledWith(TASK, { asked: true })
  })

  it('Background AI tasks off: nothing is added, and no error lands anywhere in the store', async () => {
    answer = { ok: false, reason: 'background_ai_off' }
    const before = useChatStore.getState()
    const errors = vi.spyOn(console, 'error')
    await useChatStore.getState().sendProactiveWelcome(TASK)
    const after = useChatStore.getState()
    expect(after.messagesByTask[TASK]).toBeUndefined()
    // No other part of the store changed either (no error text, no flag).
    expect(Object.keys(after).filter((k) => (after as never)[k] !== (before as never)[k])).toEqual([])
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('switch on: the hello is added as the first assistant message', async () => {
    answer = { ok: true, message: { role: 'assistant', content: 'Start with the outline.', ts: 1 } }
    await useChatStore.getState().sendProactiveWelcome(TASK)
    expect(useChatStore.getState().messagesByTask[TASK]).toEqual([answer.message])
  })
})
