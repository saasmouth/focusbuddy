// @vitest-environment node
//
// A reload is not an app open.
//
// The free-launch allowance (three opens without an account, the fourth
// requires one) is counted from the main window's ready-to-show. Electron fires
// ready-to-show again on every renderer reload — measured on Electron 37, two
// reloads gave two events — so View → Reload, the error screen's Reload button
// and a restore from backup were each spending a free open, and a few reloads in
// one sitting put someone behind the account wall mid-session. (It surfaced as
// restyleVisual stalling: its fourth themed reload met a sign-in modal with no
// way past it.)
//
// This drives the real module against a real file in a temp profile, rather
// than pinning source text: the property is "a second call in the same process
// does not count", and only calling it twice shows that.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let profile = ''

vi.mock('electron', () => ({
  app: { getPath: () => profile },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  }
}))

const stored = (): { anonLaunches?: number } =>
  JSON.parse(readFileSync(join(profile, 'account-session.json'), 'utf8'))

// A fresh import of the module is a fresh main process: module state (the
// once-per-process flag, the parse cache) starts over, the file on disk does not.
async function freshProcess(): Promise<typeof import('../../src/main/db/account')> {
  vi.resetModules()
  return import('../../src/main/db/account')
}

beforeEach(() => {
  profile = mkdtempSync(join(tmpdir(), 'plexii-anon-launch-'))
})
afterEach(() => {
  rmSync(profile, { recursive: true, force: true })
})

describe('the anonymous launch counter', () => {
  it('counts the first ready-to-show of a process', async () => {
    const account = await freshProcess()
    expect(account.recordAnonLaunch()).toBe(1)
    expect(stored().anonLaunches).toBe(1)
  })

  it('does not count a reload: later calls in the same process are free', async () => {
    const account = await freshProcess()
    account.recordAnonLaunch()
    // Three reloads in one sitting.
    expect(account.recordAnonLaunch()).toBe(1)
    expect(account.recordAnonLaunch()).toBe(1)
    expect(account.recordAnonLaunch()).toBe(1)
    expect(stored().anonLaunches).toBe(1)
  })

  it('still counts every real launch, so the fourth open still requires an account', async () => {
    for (let launch = 1; launch <= 4; launch++) {
      const account = await freshProcess()
      expect(account.recordAnonLaunch()).toBe(launch)
      account.recordAnonLaunch() // a reload in that launch
    }
    expect(stored().anonLaunches).toBe(4)
    expect(4).toBeGreaterThan((await freshProcess()).ANON_LAUNCH_LIMIT)
  })

  it('a signed-in launch is not counted, and its reloads are not either', async () => {
    writeFileSync(
      join(profile, 'account-session.json'),
      JSON.stringify({ encryptedToken: 'abc', skippedAt: null, cachedEmail: null, anonLaunches: 2 })
    )
    const account = await freshProcess()
    expect(account.recordAnonLaunch()).toBe(2)
    expect(account.recordAnonLaunch()).toBe(2)
    expect(stored().anonLaunches).toBe(2)
  })
})
