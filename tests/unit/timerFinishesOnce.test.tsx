// "Something broke in the UI — Minified React error #185" on every launch
// (owner, 2026-11-03). Found live in the installed app: the "Opening range
// timer (15 min)" was written to the widget store ~100 times in a second, only
// updatedAt changing, from TimerWidget's threshold effect.
//
// That effect runs after EVERY render. When a running timer is past zero it
// finishes the run: setData(done) — an ordinary-priority update — and a widget
// store write, whose subscribers re-render SYNCHRONOUSLY. The synchronous
// render does not include the ordinary update, so the timer still reads
// "running", the effect runs again and finishes the same run again, and again,
// until React's nested-update limit. Reached on launch whenever a timer comes
// back "running" with its time already up (closed mid-run, or a synced copy).
//
// Reproduced here exactly: the store write forces a synchronous re-render
// (flushSync), as a useSyncExternalStore subscription does.
import { act, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/renderer/src/components/Icon', () => ({ default: () => null }))
vi.mock('../../src/renderer/src/components/widgets/WidgetFrame', () => ({ default: ({ children }: { children: unknown }) => <div>{children as never}</div> }))
const sounds = vi.hoisted(() => ({ alarm: vi.fn(), beep: vi.fn() }))
vi.mock('../../src/renderer/src/lib/audioBeep', () => sounds)

// The store: update() records the write and re-renders the timer's host synchronously.
const writes: Array<{ id: string; patch: Record<string, unknown> }> = []
let rerenderHost: () => void = () => undefined
vi.mock('../../src/renderer/src/stores/widgets', () => ({
  useWidgetStore: (sel: (s: { update: (id: string, p: Record<string, unknown>) => Promise<void> }) => unknown) =>
    sel({
      update: async (id, patch) => {
        writes.push({ id, patch })
        if (writes.length > 200) throw new Error('runaway')
        flushSync(() => rerenderHost())
      }
    })
}))

import TimerWidget from '../../src/renderer/src/components/widgets/TimerWidget'

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  writes.length = 0
  sounds.alarm.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const widget = (content: string, n: number): unknown => ({ id: 'timer-1', kind: 'timer', title: 'Opening range timer', content, x: 0, y: 0, width: 224, height: 224, updatedAt: n })

describe('a timer whose time ran out while it was away finishes ONCE', () => {
  it('one write, no late alarm, and the app stays up', () => {
    // Started 20 minutes ago on a 15-minute run: it is past zero on arrival.
    const running = JSON.stringify({ targetSec: 900, elapsedSec: 0, state: 'running', startedAt: Date.now() - 20 * 60_000 })
    function Host(): JSX.Element {
      const [n, setN] = useState(0)
      rerenderHost = () => setN((x) => x + 1)
      // A store write hands the widget back as a new object (updatedAt moves).
      return <TimerWidget widget={widget(running, n) as never} inline />
    }
    expect(() => act(() => root.render(<Host />))).not.toThrow()
    expect(writes.length, `writes: ${writes.length}`).toBe(1)
    expect(JSON.parse(writes[0]!.patch.content as string)).toMatchObject({ state: 'done', elapsedSec: 900, startedAt: null })
    // It ran out five minutes ago, while the app was closed: done, quietly.
    expect(sounds.alarm).toHaveBeenCalledTimes(0)
  })

  it('a run that runs out NOW sounds the alarm, once', () => {
    // A 15-minute run that ended a second ago.
    const running = JSON.stringify({ targetSec: 900, elapsedSec: 0, state: 'running', startedAt: Date.now() - 901_000 })
    function Host(): JSX.Element {
      const [n, setN] = useState(0)
      rerenderHost = () => setN((x) => x + 1)
      return <TimerWidget widget={widget(running, n) as never} inline />
    }
    act(() => root.render(<Host />))
    expect(writes.length).toBe(1)
    expect(sounds.alarm).toHaveBeenCalledTimes(1)
  })

  it('the same run handed back "running" (a synced copy) shows done, with no second write or alarm', () => {
    const run = { targetSec: 900, elapsedSec: 0, state: 'running', startedAt: Date.now() - 901_000 }
    let content = JSON.stringify(run)
    function Host(): JSX.Element {
      const [n, setN] = useState(0)
      rerenderHost = () => setN((x) => x + 1)
      return <TimerWidget widget={widget(content, n) as never} inline />
    }
    act(() => root.render(<Host />))
    expect(writes.length).toBe(1)
    // The store now holds "done"...
    content = writes[0]!.patch.content as string
    act(() => rerenderHost())
    // ...then sync hands back the stale "running" copy of the SAME run.
    content = JSON.stringify(run)
    act(() => rerenderHost())
    expect(writes.length, `writes: ${writes.length}`).toBe(1)
    expect(sounds.alarm).toHaveBeenCalledTimes(1)
    // Settled as done: "Again" is offered, "Pause" is not.
    expect(host.textContent).toContain('Again')
    expect(host.textContent).not.toContain('Pause')
  })

  it('a NEW run started afterwards can finish too', () => {
    const t0 = Date.now()
    const first = JSON.stringify({ targetSec: 60, elapsedSec: 0, state: 'running', startedAt: t0 - 120_000 })
    let content = first
    function Host(): JSX.Element {
      const [n, setN] = useState(0)
      rerenderHost = () => setN((x) => x + 1)
      return <TimerWidget widget={widget(content, n) as never} inline />
    }
    act(() => root.render(<Host />))
    expect(writes.length).toBe(1)
    // Another run, also already past zero (a different startedAt).
    content = JSON.stringify({ targetSec: 60, elapsedSec: 0, state: 'running', startedAt: t0 - 90_000 })
    act(() => rerenderHost())
    expect(writes.length).toBe(2)
  })
})
