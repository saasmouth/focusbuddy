// Phone in-app browsers can accept a service worker registration and never
// activate it. navigator.serviceWorker.ready then never settles, and the share
// page waited on it before opening the desk: "Opening the desk..." for good.
// The worker only serves pictures and media, so the wait is bounded.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { installFileServer, FILE_SERVER_WAIT_MS } from '../../src/web/api/bridge'

describe('file server start on a browser whose service worker never activates', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('gives up after the bound instead of waiting for ever', async () => {
    vi.useFakeTimers()
    const never = new Promise<never>(() => {})
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn(async () => ({})), ready: never }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let done = false
    const p = installFileServer().then(() => { done = true })
    await vi.advanceTimersByTimeAsync(FILE_SERVER_WAIT_MS - 1)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await p
    expect(done).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('file server not ready'))
  })
})
