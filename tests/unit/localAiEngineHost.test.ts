// @vitest-environment node
// The utility-process host: lazy start, load once, idle unload, cancel, and an
// honest error when the worker dies mid-request.
import { describe, it, expect, vi } from 'vitest'
import { EngineHost, type WorkerHandle } from '../../src/main/ai/local/engineHost'
import type { WorkerReply, WorkerRequest } from '../../src/main/ai/local/localWorker'

function fakeWorker(behaviour: (m: WorkerRequest, reply: (r: WorkerReply) => void, exit: (code: number) => void) => void) {
  const forks: Array<{ sent: WorkerRequest[]; killed: boolean }> = []
  const fork = (): WorkerHandle => {
    const rec = { sent: [] as WorkerRequest[], killed: false }
    forks.push(rec)
    let onMsg: (m: WorkerReply) => void = () => undefined
    let onExit: (c: number) => void = () => undefined
    return {
      postMessage: (m) => {
        rec.sent.push(m)
        queueMicrotask(() => behaviour(m, (r) => onMsg(r), (c) => onExit(c)))
      },
      on: ((ev: string, fn: (x: never) => void) => {
        if (ev === 'message') onMsg = fn as never
        else onExit = fn as never
      }) as WorkerHandle['on'],
      kill: () => {
        rec.killed = true
        return true
      }
    }
  }
  return { fork, forks }
}

const okWorker = (m: WorkerRequest, reply: (r: WorkerReply) => void): void => {
  if (m.type === 'load') reply({ id: m.id, type: 'done', ok: true, value: { loaded: true, loadMs: 5, gpu: 'metal', contextSize: 8192 } })
  if (m.type === 'generate') {
    reply({ id: m.id, type: 'text', delta: 'he' })
    reply({ id: m.id, type: 'text', delta: 'llo' })
    reply({ id: m.id, type: 'done', ok: true, value: { text: 'hello', inputTokens: 3, outputTokens: 2, stopReason: 'end_turn', ttftMs: 1, totalMs: 2 } })
  }
}
const REQ = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 5 }

describe('EngineHost', () => {
  it('starts nothing until the first request, then loads once and streams', async () => {
    const w = fakeWorker(okWorker)
    const host = new EngineHost({ fork: w.fork, idleMs: 60_000 })
    host.setModel('/m.gguf', 8192)
    expect(w.forks).toHaveLength(0)
    const deltas: string[] = []
    const r = await host.generate(REQ, { onText: (d) => deltas.push(d) })
    await host.generate(REQ)
    expect(r.text).toBe('hello')
    expect(deltas).toEqual(['he', 'llo'])
    expect(w.forks).toHaveLength(1)
    expect(w.forks[0].sent.filter((m) => m.type === 'load')).toHaveLength(1)
    expect(host.state).toBe('ready')
    await host.stop()
  })

  it('kills the worker after the idle period, and restarts it on the next request', async () => {
    vi.useFakeTimers()
    try {
      const w = fakeWorker(okWorker)
      const host = new EngineHost({ fork: w.fork, idleMs: 1000 })
      host.setModel('/m.gguf', 8192)
      await host.generate(REQ)
      expect(host.running()).toBe(true)
      vi.advanceTimersByTime(1001)
      await Promise.resolve()
      expect(w.forks[0].killed).toBe(true)
      expect(host.running()).toBe(false)
      await host.generate(REQ)
      expect(w.forks).toHaveLength(2)
      await host.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards cancel to the worker as an abort of that request', async () => {
    let genId = 0
    const w = fakeWorker((m, reply) => {
      if (m.type === 'load') reply({ id: m.id, type: 'done', ok: true, value: { loadMs: 1, gpu: false, contextSize: 1 } })
      if (m.type === 'generate') genId = m.id
      if (m.type === 'abort' && m.target === genId) {
        reply({ id: genId, type: 'done', ok: true, value: { text: 'part', inputTokens: 1, outputTokens: 1, stopReason: 'aborted', ttftMs: 1, totalMs: 1 } })
      }
    })
    const host = new EngineHost({ fork: w.fork, idleMs: 60_000 })
    host.setModel('/m.gguf', 8192)
    const ctrl = new AbortController()
    const p = host.generate(REQ, { signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 5))
    ctrl.abort()
    const r = await p
    expect(r.stopReason).toBe('aborted')
    expect(w.forks[0].sent.some((m) => m.type === 'abort')).toBe(true)
    await host.stop()
  })

  it('fails the in-flight request honestly when the worker dies, and recovers on the next', async () => {
    let die = true
    const w = fakeWorker((m, reply, exit) => {
      if (m.type === 'load') reply({ id: m.id, type: 'done', ok: true, value: { loadMs: 1, gpu: false, contextSize: 1 } })
      if (m.type === 'generate') {
        if (die) {
          die = false
          exit(137)
        } else okWorker(m, reply)
      }
    })
    const host = new EngineHost({ fork: w.fork, idleMs: 60_000 })
    host.setModel('/m.gguf', 8192)
    await expect(host.generate(REQ)).rejects.toThrow(/stopped unexpectedly .*137.*memory/)
    expect(host.state).toBe('error')
    const r = await host.generate(REQ)
    expect(r.text).toBe('hello')
    expect(w.forks).toHaveLength(2)
    await host.stop()
  })

  it('refuses plainly with no model selected', async () => {
    const host = new EngineHost({ fork: fakeWorker(okWorker).fork, idleMs: 1000 })
    await expect(host.generate(REQ)).rejects.toThrow(/No on-device model/)
  })
})

describe('EngineHost: warm-up state and preload', () => {
  it('reports loading with a waiting request, then ready with the load time; a warm request waits on nothing', async () => {
    const w = fakeWorker(okWorker)
    const states: Array<{ state: string; waiting: number; lastLoadMs: number | null }> = []
    const host = new EngineHost({ fork: w.fork, idleMs: 60_000, onState: (s) => states.push({ state: s.state, waiting: s.waiting, lastLoadMs: s.lastLoadMs }) })
    host.setModel('/m.gguf', 8192)
    await host.generate(REQ)
    expect(states).toContainEqual({ state: 'loading', waiting: 1, lastLoadMs: null })
    expect(states.at(-1)).toEqual({ state: 'ready', waiting: 0, lastLoadMs: 5 })
    const before = states.length
    await host.generate(REQ)
    expect(states.slice(before).some((s) => s.waiting > 0)).toBe(false)
    await host.stop()
  })

  it('preload loads ahead of the first request, which then waits on nothing; the idle timer still unloads it', async () => {
    vi.useFakeTimers()
    const w = fakeWorker(okWorker)
    const states: Array<{ state: string; waiting: number }> = []
    const host = new EngineHost({ fork: w.fork, idleMs: 1_000, onState: (s) => states.push({ state: s.state, waiting: s.waiting }) })
    host.setModel('/m.gguf', 8192)
    expect(await host.preload()).toBe(5)
    expect(states.some((s) => s.waiting > 0)).toBe(false) // nobody was waiting
    expect(host.state).toBe('ready')
    const n = states.length
    await host.generate(REQ)
    expect(states.slice(n).some((s) => s.state === 'loading')).toBe(false)
    expect(w.forks[0].sent.filter((m) => m.type === 'load')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(w.forks[0].killed).toBe(true)
    vi.useRealTimers()
  })
})
