import { describe, it, expect, vi } from 'vitest'

// A main-side write must never fail because there is no Electron window to tell.
// Each broadcast is called after its write has already succeeded (db/tables.ts,
// db/snippets.ts, mcpServer widget writes); if BrowserWindow is unusable the
// broadcast must degrade to silence, not throw and take the write down.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => {
      throw new Error('no Electron here')
    }
  }
}))

describe('main-process change broadcasts without Electron', () => {
  it('notifyRowsChanged does not throw', async () => {
    const { notifyRowsChanged } = await import('../../src/main/tableEvents')
    expect(() => notifyRowsChanged('t1')).not.toThrow()
  })
  it('notifySnippetChanged does not throw', async () => {
    const { notifySnippetChanged } = await import('../../src/main/snippetEvents')
    expect(() => notifySnippetChanged('s1')).not.toThrow()
  })
  it('notifyDocumentChanged does not throw', async () => {
    const { notifyDocumentChanged } = await import('../../src/main/documentEvents')
    expect(() => notifyDocumentChanged('d1', 1)).not.toThrow()
  })
  it('the widget notifier flush does not throw', async () => {
    vi.useFakeTimers()
    const { notifyWidgetsChanged } = await import('../../src/main/widgetEvents')
    notifyWidgetsChanged(['desk1'])
    expect(() => vi.runAllTimers()).not.toThrow()
    vi.useRealTimers()
  })
})
