import { describe, it, expect, vi } from 'vitest'
import { deliverTelemetry } from '../../src/renderer/src/lib/telemetryReport'

const snapshot = { appVersion: '2.5.25', platform: 'mac', widgetTotal: 3 }
const collect = () => Promise.resolve(snapshot)
// These cover delivery mechanics for a person who opted in; the consent gate
// itself is held by telemetryOptIn.test.tsx.
const enabled = (): boolean => true
const noWait = async (): Promise<void> => {}

function okFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
}

describe('deliverTelemetry — robust telemetry delivery', () => {
  it('posts the snapshot to /telemetry with the bearer token on the first try', async () => {
    const f = okFetch()
    const ok = await deliverTelemetry({ httpUrl: 'https://sig.test', token: 'tok123', collect, fetchImpl: f, enabled })
    expect(ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://sig.test/telemetry')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer tok123')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ widgetTotal: 3 })
  })

  it('retries after a failed POST and succeeds on a later attempt', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: false }) // first attempt: server rejects
      .mockRejectedValueOnce(new Error('network')) // retry 1: throws
      .mockResolvedValueOnce({ ok: true }) // retry 2: succeeds
    const ok = await deliverTelemetry({
      httpUrl: 'https://sig.test',
      token: 't',
      collect,
      enabled,
      fetchImpl: f as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      sleep: noWait
    })
    expect(ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('gives up after exhausting retries and reports failure (no throw)', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false })
    const ok = await deliverTelemetry({
      httpUrl: 'https://sig.test',
      token: 't',
      collect,
      enabled,
      fetchImpl: f as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      sleep: noWait
    })
    expect(ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(3) // 1 attempt + 2 retries
  })

  it('a thrown fetch is swallowed, never escaping as an unhandled rejection', async () => {
    const f = vi.fn().mockRejectedValue(new Error('offline'))
    const ok = await deliverTelemetry({
      httpUrl: 'https://sig.test',
      token: 't',
      collect,
      enabled,
      fetchImpl: f as unknown as typeof fetch,
      retryDelaysMs: [],
      sleep: noWait
    })
    expect(ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('stops immediately when cancelled before the first attempt completes', async () => {
    const f = okFetch()
    const ok = await deliverTelemetry({
      httpUrl: 'https://sig.test',
      token: 't',
      collect,
      enabled,
      fetchImpl: f,
      isCancelled: () => true
    })
    // collect+post still runs once but the cancelled guard prevents counting a
    // late success and prevents any retry loop.
    expect(ok).toBe(false)
  })
})
