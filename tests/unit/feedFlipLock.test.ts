// @vitest-environment node
// The feed-flip lock (scripts/feed-flip-lock.sh): one release at a time may
// change the live update feeds, and anything reading them can tell. Driven
// through macOS's own /bin/bash (3.2), which is what runs release-mac.sh.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const LOCK_SH = resolve(__dirname, '../../scripts/feed-flip-lock.sh')
const RELEASE_SH = resolve(__dirname, '../../scripts/release-mac.sh')

let dir = ''
let lock = ''
let holders: ChildProcess[] = []

function bash(script: string, env: Record<string, string> = {}): { status: number | null; stderr: string } {
  const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail; source "${LOCK_SH}"; ${script}`], {
    env: { ...process.env, FEED_FLIP_LOCK: lock, ...env },
    encoding: 'utf8'
  })
  return { status: r.status, stderr: r.stderr }
}
const owner = (): Record<string, string> =>
  Object.fromEntries(
    readFileSync(join(lock, 'owner'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string])
  )

/** A live release holding the lock: bash takes it, then sleeps. */
async function liveHolder(version: string): Promise<ChildProcess> {
  const p = spawn('/bin/bash', ['-c', `source "${LOCK_SH}"; trap feed_lock_release EXIT; feed_lock_take ${version}; sleep 30`], {
    env: { ...process.env, FEED_FLIP_LOCK: lock },
    stdio: 'ignore'
  })
  holders.push(p)
  for (let i = 0; i < 100 && !existsSync(join(lock, 'owner')); i++) await new Promise((r) => setTimeout(r, 20))
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feed-flip-lock-'))
  lock = join(dir, 'plexii-work', '.feed-flip.lock')
  holders = []
})
afterEach(() => {
  for (const p of holders) p.kill('SIGTERM')
  rmSync(dir, { recursive: true, force: true })
})

describe('the feed-flip lock', () => {
  it('taking it makes the directory, with who holds it and for which version', () => {
    const r = bash('feed_lock_take 4.3.52; echo held')
    expect(r.status).toBe(0)
    expect(existsSync(lock)).toBe(true)
    const o = owner()
    expect(o.version).toBe('4.3.52')
    expect(o.pid).toMatch(/^\d+$/)
    expect(o.started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(o.by).toBe('release-mac.sh')
  })

  it('a second release is refused while a live one holds it, and leaves its lock alone', async () => {
    const holder = await liveHolder('4.3.52')
    const r = bash('feed_lock_take 4.3.53')
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('being flipped by another release')
    expect(r.stderr).toContain('version=4.3.52')
    expect(owner()).toMatchObject({ pid: String(holder.pid), version: '4.3.52' })
  })

  it('a lock whose owner is gone is taken over, and says so', () => {
    mkdirSync(lock, { recursive: true })
    // A pid that has finished: its own bash, already exited.
    const dead = spawnSync('/bin/bash', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
    writeFileSync(join(lock, 'owner'), `pid=${dead}\nversion=4.3.51\n`)
    const r = bash('feed_lock_take 4.3.52')
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('Taking over a stale feed-flip lock')
    expect(owner().version).toBe('4.3.52')
  })

  it('a release that fails mid-upload still lets go (the EXIT trap)', () => {
    const r = bash('trap feed_lock_release EXIT; feed_lock_take 4.3.52; false')
    expect(r.status).not.toBe(0)
    expect(existsSync(lock)).toBe(false)
  })

  it('a process that did not take it never removes it', async () => {
    await liveHolder('4.3.52')
    const r = bash('feed_lock_release; feed_lock_release')
    expect(r.status).toBe(0)
    expect(existsSync(lock)).toBe(true)
  })

  it('release-mac.sh refuses to start while a flip is in progress, before touching GitHub', async () => {
    await liveHolder('4.3.52')
    const r = spawnSync('/bin/bash', [RELEASE_SH, '9.9.9'], {
      env: { ...process.env, FEED_FLIP_LOCK: lock, PATH: '/usr/bin:/bin' },
      encoding: 'utf8'
    })
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('being flipped by another release')
    expect(existsSync(lock)).toBe(true)
  })
})
