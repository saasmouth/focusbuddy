// The e2e real-input lock (tests/e2e/_realInputLock.ts): one spec at a time may
// own the screen and keyboard across Playwright workers.
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
let lock: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'real-input-lock-'))
  lock = join(dir, 'lock')
  vi.stubEnv('PLEXII_REAL_INPUT_LOCK', lock)
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const load = (): Promise<typeof import('../e2e/_realInputLock')> => import('../e2e/_realInputLock')

/** A lock held by another, LIVE process (our parent outlives this test). */
function heldBy(pid: number): void {
  mkdirSync(lock)
  writeFileSync(join(lock, 'pid'), String(pid))
  writeFileSync(join(lock, 'label'), 'otherSpec')
}

describe('real-input lock', () => {
  it('takes a free lock, records the holder, and releases it', async () => {
    const { acquireRealInput, releaseRealInput } = await load()
    await acquireRealInput('mine', 2_000)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid))
    releaseRealInput()
    expect(existsSync(lock)).toBe(false)
  })

  it('waits while a live process holds it, and names the holder when it gives up', async () => {
    heldBy(process.ppid)
    const { acquireRealInput } = await load()
    await expect(acquireRealInput('mine', 1_500)).rejects.toThrow(/held by otherSpec/)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.ppid))
  })

  it('takes over a lock whose holder has died', async () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    heldBy(dead)
    const { acquireRealInput } = await load()
    await acquireRealInput('mine', 5_000)
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid))
  })

  it('never releases a lock someone else holds', async () => {
    heldBy(process.ppid)
    const { releaseRealInput } = await load()
    releaseRealInput()
    expect(existsSync(lock)).toBe(true)
  })
})
