// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── Update checks: when, whether, and what they send ───────────────────────
//
// History. 2026-10-08: a release took up to four hours to appear for someone
// already running the app, so the poll went from 4 h to 5 min. 4.3.34 (honest
// privacy): 5 minutes is 288 requests a day from every install, a usage signal in
// itself, and there was no way to turn it off. Now: 30 s after launch, every
// 6 hours and on wake, only while "Check for updates automatically" is on
// (Settings > Data > Privacy, default on), plus "Check now" there and in the
// footer. And electron-updater's per-install `x-user-staging-id` header is
// stripped, so a check carries no identifier.

const SRC = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'autoUpdate.ts'), 'utf-8')

const state = vi.hoisted(() => ({
  prefs: { autoUpdateChecks: true },
  listeners: [] as Array<(p: { autoUpdateChecks: boolean }) => void>,
  resume: [] as Array<() => void>,
  checks: 0
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getName: () => 'PlexiiDesk' },
  autoUpdater: { removeAllListeners: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: (ev: string, fn: () => void) => ev === 'resume' && state.resume.push(fn) }
}))
vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(() => {
      state.checks++
      return Promise.resolve(undefined)
    }),
    quitAndInstall: vi.fn(),
    computeFinalHeaders(h: Record<string, unknown>) {
      return h
    }
  }
}))
vi.mock('../../src/main/appMode', () => ({ detectPreviewBuild: () => false }))
vi.mock('../../src/main/sessionPersistence', () => ({ flushBeforeUpdate: vi.fn() }))
vi.mock('../../src/main/privacyPrefs', () => ({
  autoUpdateChecksEnabled: () => state.prefs.autoUpdateChecks,
  onPrivacyPrefsChange: (fn: (p: { autoUpdateChecks: boolean }) => void) => {
    state.listeners.push(fn)
    return () => {}
  }
}))

describe('update check cadence (source pins)', () => {
  it('checks 30 s after launch, then every 6 hours', () => {
    expect(SRC).toContain('export const FIRST_CHECK_MS = 30 * 1000')
    expect(SRC).toContain('export const POLL_MS = 6 * 60 * 60 * 1000')
    expect(SRC).not.toContain('5 * 60 * 1000')
  })

  it('only polls from idle, none or error', () => {
    expect(SRC).toContain("const POLLABLE = new Set<UpdateState['kind']>(['idle', 'none', 'error'])")
    const block = SRC.slice(SRC.indexOf('export type UpdateState ='), SRC.indexOf('let current: UpdateState'))
    const all = [...block.matchAll(/kind: '([a-z]+)'/g)].map((m) => m[1]).sort()
    expect(all).toEqual(['available', 'checking', 'downloading', 'error', 'idle', 'none', 'ready'])
  })
})

describe('automatic checks follow the switch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    state.prefs.autoUpdateChecks = true
    state.listeners.length = 0
    state.resume.length = 0
    state.checks = 0
  })
  afterEach(() => vi.useRealTimers())

  it('on: checks at 30 s, not again at 5 min, again at 6 h, and on wake', async () => {
    const m = await import('../../src/main/autoUpdate')
    m.installAutoUpdater()
    expect(state.checks).toBe(0)
    vi.advanceTimersByTime(30_000)
    expect(state.checks).toBe(1)
    vi.advanceTimersByTime(5 * 60_000)
    expect(state.checks).toBe(1)
    vi.advanceTimersByTime(6 * 60 * 60_000)
    expect(state.checks).toBe(2)
    state.resume.forEach((fn) => fn())
    expect(state.checks).toBe(3)
  })

  it('off: no automatic check at launch, on the interval or on wake; Check now still works', async () => {
    state.prefs.autoUpdateChecks = false
    const m = await import('../../src/main/autoUpdate')
    m.installAutoUpdater()
    vi.advanceTimersByTime(24 * 60 * 60_000)
    state.resume.forEach((fn) => fn())
    expect(state.checks).toBe(0)
    m.checkForUpdates()
    expect(state.checks).toBe(1)
  })

  it('turning the switch back on checks once', async () => {
    state.prefs.autoUpdateChecks = false
    const m = await import('../../src/main/autoUpdate')
    m.installAutoUpdater()
    state.prefs.autoUpdateChecks = true
    state.listeners.forEach((fn) => fn({ autoUpdateChecks: true }))
    expect(state.checks).toBe(1)
  })
})

describe('what a check sends', () => {
  it('strips the per-install staging id electron-updater adds', async () => {
    const m = await import('../../src/main/autoUpdate')
    expect(m.stripUpdaterIdentifiers({ 'x-user-staging-id': 'abc', 'Cache-Control': 'no-cache' })).toEqual({
      'Cache-Control': 'no-cache'
    })
    expect(m.stripUpdaterIdentifiers({ 'X-User-Staging-Id': 'abc' })).toEqual({})
  })

  it('hardenUpdaterRequests wraps computeFinalHeaders so the id never goes out', async () => {
    const m = await import('../../src/main/autoUpdate')
    const updater = {
      requestHeaders: { 'x-extra': '1' },
      computeFinalHeaders(this: { requestHeaders: Record<string, string> }, h: Record<string, unknown>) {
        return Object.assign(h, this.requestHeaders)
      }
    }
    m.hardenUpdaterRequests(updater)
    expect(updater.computeFinalHeaders({ 'x-user-staging-id': 'uuid' })).toEqual({ 'x-extra': '1' })
  })

  it('the installed electron-updater still adds the header where we strip it', () => {
    // If a future electron-updater moves the header elsewhere, this fails and
    // the stripping has to move with it.
    const appUpdater = readFileSync(
      join(__dirname, '..', '..', 'node_modules', 'electron-updater', 'out', 'AppUpdater.js'),
      'utf-8'
    )
    expect(appUpdater).toContain('this.computeFinalHeaders({ "x-user-staging-id": stagingUserId })')
  })
})
