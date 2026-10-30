import { describe, it, expect } from 'vitest'

// Two conversations can run at once (asked for 2026-10-30).
//
// The assistant was single-flight because of ONE boolean. Everything else in
// the store was already per-thread — messages, traces, drafts, mentions — so
// the limit lived entirely in `sending`, plus a single `liveRequestId` slot
// that a second send would overwrite, orphaning the first thread's Stop.
//
// Asserted against the source because exercising the real store needs the
// Electron IPC bridge; what has to stay true is structural, and that is what
// this checks. The matching behaviour — that a thread releases only itself —
// is read out of the settle path below.

const { readFileSync } = require('node:fs') as typeof import('node:fs')
const { join } = require('node:path') as typeof import('node:path')

const STORE = readFileSync(join(__dirname, '../..', 'src/renderer/src/stores/chat.ts'), 'utf-8')

describe('the chat store is per-thread, not single-flight', () => {
  it('has no global sending flag left to block a second conversation', () => {
    expect(STORE).toContain('sendingByThread: Record<string, boolean>')
    expect(STORE).not.toMatch(/^\s*sending: boolean$/m)
    expect(STORE).not.toMatch(/\bsending: (true|false)\b/)
  })

  it('tracks one live requestId PER thread, so each Stop aborts its own turn', () => {
    expect(STORE).toContain('liveRequestByThread: Record<string, string>')
    expect(STORE).not.toMatch(/liveRequestId/)
  })

  it('marks only the sending thread busy', () => {
    expect(STORE).toContain('sendingByThread: { ...get().sendingByThread, [key]: true }')
  })

  it('releases only the finishing thread, never the whole map', () => {
    // The bug this prevents: a second conversation's reply clearing the flag
    // and ending the first one's spinner while it is still streaming.
    expect(STORE).toContain('const stillSending = { ...get().sendingByThread }')
    expect(STORE).toContain('delete stillSending[key]')
    expect(STORE).toContain('delete stillLive[key]')
    expect(STORE).not.toContain('sendingByThread: {}, liveRequestByThread: {} }')
  })

  it('Stop defaults to the thread it was pressed in', () => {
    expect(STORE).toContain('cancelSend: (threadKey) => {')
    expect(STORE).toContain('const key = threadKey ?? get().conversationKey()')
    expect(STORE).toContain('get().liveRequestByThread[key]')
  })
})

describe('every composer asks about its OWN thread', () => {
  const FILES = [
    'src/renderer/src/components/ChatPanel.tsx',
    'src/renderer/src/components/assistant/AssistantOverlay.tsx',
    'src/renderer/src/components/focus/FocusChatSurface.tsx',
    'src/renderer/src/components/views/StartOrAskPlexi.tsx'
  ]

  it.each(FILES)('%s reads no global sending flag', (rel) => {
    const src = readFileSync(join(__dirname, '../..', rel), 'utf-8')
    // `s.sending` / `chat.sending` would be the global flag coming back.
    expect(src).not.toMatch(/\b(?:s|chat|getState\(\))\.sending\b/)
  })

  it('the Stop button names the thread it belongs to', () => {
    const panel = readFileSync(
      join(__dirname, '../..', 'src/renderer/src/components/ChatPanel.tsx'),
      'utf-8'
    )
    // Bare `onClick={cancelSend}` would also pass the MouseEvent as the key.
    expect(panel).toContain('onClick={() => cancelSend(thread.key)}')
    expect(panel).not.toContain('onClick={cancelSend}')
  })
})
