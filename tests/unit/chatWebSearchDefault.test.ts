// Chat web search sends the chat message to DuckDuckGo. From 4.3.34 it is OFF
// unless the person turns the globe on; their last choice seeds new chats. And no
// path that never asked for it (dashboard cards, field AI, Stream Deck, scheduled
// flows and reports) may search: the model layer reads a missing flag as on, so
// the flag is made explicit at the IPC boundary and in the schedulers.

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withWebSearchOptIn } from '../../src/main/webSearchOptIn'
import { WEB_SEARCH_DEFAULT_KEY, webSearchDefault } from '../../src/renderer/src/stores/chat'

const src = (p: string): string => readFileSync(join(__dirname, '..', '..', 'src', p), 'utf8')

beforeEach(() => localStorage.clear())

describe('the default', () => {
  it('is off for a person who never chose', () => {
    expect(webSearchDefault()).toBe(false)
  })

  it('remembers the last choice', () => {
    localStorage.setItem(WEB_SEARCH_DEFAULT_KEY, 'on')
    expect(webSearchDefault()).toBe(true)
    localStorage.setItem(WEB_SEARCH_DEFAULT_KEY, 'off')
    expect(webSearchDefault()).toBe(false)
  })

  it('the store and panel fall back to off, and a flip is stored as the new default', () => {
    const store = src('renderer/src/stores/chat.ts')
    expect(store).toContain('pendingWebSearch: webSearchDefault()')
    expect(store).toContain('?.webSearch ?? false')
    expect(store).not.toContain('pendingWebSearch: true')
    expect(store).toMatch(/setWebSearch: \(on\) => \{\s*\/\/[^\n]*\n\s*setWebSearchDefault\(on\)/)
    expect(src('renderer/src/components/ChatPanel.tsx')).toContain('(activeMeta?.webSearch ?? false)')
  })

  it('a conversation created without a flag is stored with web search off', () => {
    expect(src('main/db/aiChat.ts')).toContain('const webSearch = input.webSearch === true')
  })
})

describe('only an explicit true searches', () => {
  it('withWebSearchOptIn', () => {
    expect(withWebSearchOptIn({ taskId: null }).webSearch).toBe(false)
    expect(withWebSearchOptIn({ webSearch: undefined }).webSearch).toBe(false)
    expect(withWebSearchOptIn({ webSearch: false }).webSearch).toBe(false)
    expect(withWebSearchOptIn({ webSearch: true }).webSearch).toBe(true)
  })

  it('both chat IPC handlers apply it', () => {
    const ipc = src('main/ipc/index.ts')
    expect(ipc).toContain('return sendChat(withWebSearchOptIn(req))')
    expect(ipc).toContain('withWebSearchOptIn(chatReq)')
  })

  it('scheduled flows and reports never search', () => {
    for (const f of ['main/db/flows.ts', 'main/db/reports.ts']) {
      const s = src(f)
      const calls = s.match(/sendChat\(\{[\s\S]*?\}\)/g) ?? []
      expect(calls.length).toBeGreaterThan(0)
      for (const c of calls) expect(c).toContain('webSearch: false')
    }
  })
})
