// @vitest-environment node
// The notice the MCP server's widget writes send to the renderer
// (main/widgetEvents.ts): which desks changed, coalesced so an agent that adds
// ten widgets in one turn causes one reload per desk, not ten.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

import { createWidgetChangeNotifier } from '../../src/main/widgetEvents'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('widget change notifier', () => {
  it('coalesces a burst into ONE notice naming each desk once', () => {
    const send = vi.fn()
    const n = createWidgetChangeNotifier(send, 40)
    n.notify(['desk-1'])
    n.notify(['desk-1', 'desk-2'])
    n.notify(['desk-1'])
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(40)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0].sort()).toEqual(['desk-1', 'desk-2'])
  })

  it('a later change after the notice is a new notice', () => {
    const send = vi.fn()
    const n = createWidgetChangeNotifier(send, 40)
    n.notify(['desk-1'])
    vi.advanceTimersByTime(40)
    n.notify(['desk-3'])
    vi.advanceTimersByTime(40)
    expect(send.mock.calls.map((c) => c[0])).toEqual([['desk-1'], ['desk-3']])
  })

  it('ignores missing desk ids and sends nothing for nothing', () => {
    const send = vi.fn()
    const n = createWidgetChangeNotifier(send, 40)
    n.notify([null, undefined, ''])
    vi.advanceTimersByTime(100)
    expect(send).not.toHaveBeenCalled()
  })

  it('flush sends what is pending at once', () => {
    const send = vi.fn()
    const n = createWidgetChangeNotifier(send, 40)
    n.notify(['desk-9'])
    n.flush()
    expect(send).toHaveBeenCalledWith(['desk-9'])
    vi.advanceTimersByTime(100)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('the MCP adapter tells the renderer about every widget write', () => {
  // liveWorkspaceDeps wires the real stores, so its wrappers are pinned at the
  // source: each widget-writing dep notifies. The e2e (mcpLiveDesk.spec) proves
  // the whole path over the wire.
  it('createWidget, updateWidget, placeWidgetFile and updateWidgetFile each notify', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(`${process.cwd()}/src/main/mcpServer.ts`, 'utf8')
    const deps = src.slice(src.indexOf('export function liveWorkspaceDeps'))
    for (const name of ['createWidget', 'updateWidget', 'placeWidgetFile', 'updateWidgetFile']) {
      const at = deps.indexOf(`    ${name}: (`)
      expect(at, `${name} is a wrapper, not a bare store method`).toBeGreaterThan(0)
      const body = deps.slice(at, deps.indexOf('\n    },', at))
      expect(body, `${name} notifies the renderer`).toContain('notifyWidgetsChanged(')
    }
  })
})
