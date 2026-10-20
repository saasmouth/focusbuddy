// The server enforces the same opt-in as the app (focusbuddy-signal, 4.3.34):
//   - every /telemetry and /crash post carries `consent: true`, and the server
//     refuses one without it;
//   - the person's two choices reach PUT /account/privacy when a switch flips,
//     and after sign-in only when they differ from what the server last heard
//     (it starts at off/off), so a person who never opted in sends nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pushPrivacyChoices } from '../../src/renderer/src/lib/privacyServer'
import { setCrashReportsEnabled, setTelemetryEnabled } from '../../src/renderer/src/lib/telemetryPrefs'

const lib = (f: string): string => readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'src', 'lib', f), 'utf8')

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
}

beforeEach(() => localStorage.clear())

describe('reports carry consent', () => {
  it('usage snapshot, first launch and crash bodies all say consent: true', () => {
    expect(lib('telemetryReport.ts')).toContain('JSON.stringify({ ...snapshot, consent: true })')
    expect(lib('firstLaunch.ts')).toContain('JSON.stringify({ ...snapshot, consent: true })')
    expect(lib('crashReport.ts')).toContain('JSON.stringify({ crashes, consent: true })')
  })
})

describe('pushPrivacyChoices', () => {
  it('sends nothing for a person who never opted in (the server already holds off/off)', async () => {
    const f = okFetch()
    expect(await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test' })).toBe(true)
    expect(f).not.toHaveBeenCalled()
  })

  it('sends the two booleans, and only once while they stay the same', async () => {
    setTelemetryEnabled(true)
    const f = okFetch()
    await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test/' })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.test/account/privacy')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ usageReporting: true, crashReports: false })
    await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('a flipped switch is sent even when unchanged (force), including turning both off', async () => {
    setTelemetryEnabled(true)
    setCrashReportsEnabled(true)
    const f = okFetch()
    await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test' })
    setTelemetryEnabled(false)
    setCrashReportsEnabled(false)
    await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test', force: true })
    expect(JSON.parse(String((f.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      usageReporting: false,
      crashReports: false
    })
  })

  it('a refused push is retried next time rather than remembered', async () => {
    setCrashReportsEnabled(true)
    const bad = vi.fn(async () => new Response('', { status: 500 }))
    expect(await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: bad, httpUrl: 'https://api.test' })).toBe(false)
    const f = okFetch()
    await pushPrivacyChoices('tok', { accountKey: 'a1', fetchImpl: f, httpUrl: 'https://api.test' })
    expect(f).toHaveBeenCalledTimes(1)
  })
})
