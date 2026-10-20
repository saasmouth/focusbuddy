// Usage reporting and crash reports are OPT-IN (default off). This file fails if
// any reporting send can happen while the person's preference is unset or off.
//
// Three layers, because a gate in only one place is how the old opt-out broke:
//   1. the preference itself: only a stored 'on' counts as consent;
//   2. each transport (deliverTelemetry, deliverCrashes, reportFirstLaunch)
//      refuses to post on its own, whoever calls it;
//   3. the mounted TelemetryReporter, driven through its real timers and focus
//      trigger, posts nothing for a signed-in user who never chose;
// plus a source scan, so a new fetch to /telemetry or /crash added anywhere
// else in the app fails here until it goes through a gated transport.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/src/stores/account', () => ({
  useAccountStore: (sel: (s: unknown) => unknown) => sel({ sessionToken: 'tok-signed-in' })
}))
vi.mock('../../src/renderer/src/lib/signalConfig', () => ({
  signalConfig: { useRemote: true, httpUrl: 'https://signal.test', wsUrl: 'wss://signal.test/ws' }
}))

import TelemetryReporter from '../../src/renderer/src/components/TelemetryReporter'
import {
  CRASH_KEY,
  USAGE_KEY,
  crashReportsChoice,
  crashReportsEnabled,
  setCrashReportsEnabled,
  setTelemetryEnabled,
  telemetryChoice,
  telemetryEnabled
} from '../../src/renderer/src/lib/telemetryPrefs'
import { deliverTelemetry } from '../../src/renderer/src/lib/telemetryReport'
import { deliverCrashes } from '../../src/renderer/src/lib/crashReport'
import { reportFirstLaunch } from '../../src/renderer/src/lib/firstLaunch'

const snapshot = { appVersion: '4.3.34', platform: 'mac', widgetTotal: 3 }
const crash = {
  id: 'c1',
  ts: 1,
  source: 'renderer',
  kind: 'window-error',
  message: 'boom',
  stack: null,
  componentStack: null,
  appVersion: '4.3.34',
  context: null
}

// Every unset/off state a real install can be in. The garbage value covers a
// hand-edited or corrupted store: anything that is not exactly 'on' is off.
const NOT_CONSENTED: Array<[string, string | null]> = [
  ['never chose (nothing stored)', null],
  ['chose off', 'off'],
  ['corrupt value', 'yes'],
  ['legacy truthy-looking value', 'true']
]

function setRaw(key: string, v: string | null): void {
  if (v === null) localStorage.removeItem(key)
  else localStorage.setItem(key, v)
}

const fetchSpy = vi.fn()
let unforwarded: ReturnType<typeof vi.fn>
let markForwarded: ReturnType<typeof vi.fn>
let collectTelemetry: ReturnType<typeof vi.fn>

beforeEach(() => {
  localStorage.clear()
  fetchSpy.mockReset()
  fetchSpy.mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchSpy)
  unforwarded = vi.fn().mockResolvedValue([crash])
  markForwarded = vi.fn().mockResolvedValue(undefined)
  collectTelemetry = vi.fn().mockResolvedValue(snapshot)
  ;(window as unknown as { api: unknown }).api = {
    ai: { collectTelemetry },
    crash: { unforwarded, markForwarded }
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Calls that reached the network for a given signal path.
const sendsTo = (path: string): unknown[][] =>
  fetchSpy.mock.calls.filter(([url]) => String(url).endsWith(path))

describe('the preference: opt-in, only an explicit on counts', () => {
  it.each(NOT_CONSENTED)('usage reporting is off when %s', (_label, raw) => {
    setRaw(USAGE_KEY, raw)
    expect(telemetryEnabled()).toBe(false)
  })

  it.each(NOT_CONSENTED)('crash reports are off when %s', (_label, raw) => {
    setRaw(CRASH_KEY, raw)
    expect(crashReportsEnabled()).toBe(false)
  })

  it('a person who never chose reads as unset (and off), not as a choice', () => {
    expect(telemetryChoice()).toBe('unset')
    expect(crashReportsChoice()).toBe('unset')
  })

  it('an explicit on is kept, and the two switches are independent', () => {
    setTelemetryEnabled(true)
    expect(telemetryEnabled()).toBe(true)
    // Consenting to usage reporting is not consent to crash reports.
    expect(crashReportsEnabled()).toBe(false)
    setCrashReportsEnabled(true)
    expect(crashReportsEnabled()).toBe(true)
    setTelemetryEnabled(false)
    expect(telemetryEnabled()).toBe(false)
    expect(crashReportsEnabled()).toBe(true)
  })

  it('an unreadable store means off, never on', () => {
    const real = localStorage.getItem
    localStorage.getItem = () => {
      throw new Error('blocked')
    }
    try {
      expect(telemetryEnabled()).toBe(false)
      expect(crashReportsEnabled()).toBe(false)
    } finally {
      localStorage.getItem = real
    }
  })
})

describe('each transport refuses to send without consent, whoever calls it', () => {
  it.each(NOT_CONSENTED)('deliverTelemetry posts nothing when %s', async (_l, raw) => {
    setRaw(USAGE_KEY, raw)
    const f = vi.fn().mockResolvedValue({ ok: true })
    const collect = vi.fn().mockResolvedValue(snapshot)
    const ok = await deliverTelemetry({
      httpUrl: 'https://signal.test',
      token: 't',
      collect,
      fetchImpl: f as unknown as typeof fetch,
      retryDelaysMs: [0, 0]
    })
    expect(ok).toBe(false)
    expect(f).not.toHaveBeenCalled()
    // It does not even read the snapshot.
    expect(collect).not.toHaveBeenCalled()
  })

  it('deliverTelemetry posts once the person opted in', async () => {
    setTelemetryEnabled(true)
    const f = vi.fn().mockResolvedValue({ ok: true })
    const ok = await deliverTelemetry({
      httpUrl: 'https://signal.test',
      token: 't',
      collect: () => Promise.resolve(snapshot),
      fetchImpl: f as unknown as typeof fetch
    })
    expect(ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('turning usage reporting off mid-retry stops the remaining attempts', async () => {
    setTelemetryEnabled(true)
    const f = vi.fn().mockImplementation(async () => {
      setTelemetryEnabled(false) // the person switches it off while we retry
      return { ok: false }
    })
    await deliverTelemetry({
      httpUrl: 'https://signal.test',
      token: 't',
      collect: () => Promise.resolve(snapshot),
      fetchImpl: f as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      sleep: async () => {}
    })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it.each(NOT_CONSENTED)('deliverCrashes posts nothing when %s', async (_l, raw) => {
    setRaw(CRASH_KEY, raw)
    setTelemetryEnabled(true) // usage consent must not leak into crash consent
    const sent = await deliverCrashes({ httpUrl: 'https://signal.test', token: 't' })
    expect(sent).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(unforwarded).not.toHaveBeenCalled()
  })

  it('deliverCrashes posts once the person opted in to crash reports', async () => {
    setCrashReportsEnabled(true)
    const sent = await deliverCrashes({ httpUrl: 'https://signal.test', token: 't' })
    expect(sent).toBe(1)
    expect(sendsTo('/crash')).toHaveLength(1)
  })

  it.each(NOT_CONSENTED)('first_launch posts nothing when %s', async (_l, raw) => {
    setRaw(USAGE_KEY, raw)
    const f = vi.fn().mockResolvedValue({ ok: true })
    const outcome = await reportFirstLaunch({
      httpUrl: 'https://signal.test',
      token: 't',
      accountId: 'a1',
      enabled: telemetryEnabled,
      storage: localStorage,
      fetchImpl: f as unknown as typeof fetch,
      props: () => Promise.resolve(snapshot)
    })
    expect(outcome).toBe('disabled')
    expect(f).not.toHaveBeenCalled()
  })
})

describe('the mounted reporter, signed in, through its real triggers', () => {
  let host: HTMLDivElement
  let root: Root

  async function mountAndRunTriggers(): Promise<void> {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(<TelemetryReporter />))
    // The post-sign-in report (8 s), the 6-hour interval, and a focus return.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    })
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(10_000)
    })
  }

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('sends nothing at all for a person who never chose', async () => {
    await mountAndRunTriggers()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(collectTelemetry).not.toHaveBeenCalled()
    expect(unforwarded).not.toHaveBeenCalled()
  })

  it('sends nothing at all for a person who chose off for both', async () => {
    setTelemetryEnabled(false)
    setCrashReportsEnabled(false)
    await mountAndRunTriggers()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('usage on, crashes unset: usage snapshots go, crash reports do not', async () => {
    setTelemetryEnabled(true)
    await mountAndRunTriggers()
    expect(sendsTo('/telemetry').length).toBeGreaterThan(0)
    expect(sendsTo('/crash')).toHaveLength(0)
    expect(unforwarded).not.toHaveBeenCalled()
  })

  it('crashes on, usage unset: crash reports go, usage snapshots do not', async () => {
    setCrashReportsEnabled(true)
    await mountAndRunTriggers()
    expect(sendsTo('/crash').length).toBeGreaterThan(0)
    expect(sendsTo('/telemetry')).toHaveLength(0)
    expect(collectTelemetry).not.toHaveBeenCalled()
  })
})

describe('no ungated reporting path exists anywhere in the app source', () => {
  // The only files allowed to post to the signal server's reporting endpoints
  // are the gated transports above. A new send elsewhere fails this test.
  const ALLOWED = new Set([
    'src/renderer/src/lib/telemetryReport.ts',
    'src/renderer/src/lib/crashReport.ts',
    'src/renderer/src/lib/firstLaunch.ts'
  ])
  const repo = join(__dirname, '..', '..')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) files.push(p)
    }
  }
  walk(join(repo, 'src'))

  // A URL ending in /telemetry or /crash: `${base}/telemetry`, 'https://h/crash',
  // or a bare '/telemetry' path literal. Module paths like '../db/telemetry'
  // are not URLs and do not match.
  const ENDPOINT = /(?:\}|https?:\/\/[^'"`\s]*)\/(?:telemetry|crash)\b|['"`]\/(?:telemetry|crash)['"`?]/

  it('the scan recognises a reporting URL when it sees one', () => {
    expect(ENDPOINT.test('fetch(`${signalConfig.httpUrl}/telemetry`)')).toBe(true)
    expect(ENDPOINT.test("fetch('https://api.example.com/crash', {})")).toBe(true)
    expect(ENDPOINT.test("post('/telemetry', body)")).toBe(true)
    expect(ENDPOINT.test("import { recordAiCall } from '../db/telemetry'")).toBe(false)
  })

  it('only the gated transports name the /telemetry or /crash endpoints', () => {
    const offenders = files
      .map((p) => relative(repo, p))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => ENDPOINT.test(read(rel)))
    expect(offenders).toEqual([])
  })

  it('the Electron crash reporter is never started (it would upload minidumps)', () => {
    const offenders = files
      .map((p) => relative(repo, p))
      .filter((rel) => /crashReporter\.start\s*\(/.test(read(rel)))
    expect(offenders).toEqual([])
  })

  function read(rel: string): string {
    return readFileSync(join(repo, rel), 'utf8')
  }
})
