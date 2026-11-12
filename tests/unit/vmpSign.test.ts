// @vitest-environment node
// VMP signing with castLabs EVS (build/vmp.cjs): sign when there is an account,
// skip with one clear line when there is not, fail when told to require it.
// The runner is driven against a stand-in `python` so the exact EVS commands,
// their order and the recorded outcome are checked without an account.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const vmp = require('../../build/vmp.cjs') as {
  vmpDecision: (i: { mode?: string; platform: string; credentials: object | null; client: string | null; python: string }) => {
    action: string
    reason: string
  }
  evsCredentials: (o: { env: Record<string, string | undefined>; home: string; readFile?: (p: string) => string }) => {
    source: string
    account: string
  } | null
  evsPython: (o: { env: Record<string, string | undefined>; home: string; exists: (p: string) => boolean }) => string
  vmpSignPackage: (o: {
    platform: string
    pkgDir: string
    nameHint?: string
    resourcesDir: string
    env: Record<string, string | undefined>
    log?: (s: string) => void
  }) => string
  removeDevelopmentSig: (app: string) => boolean
  macFrameworkSig: (app: string) => string
}

const creds = { source: 'config', account: 'plexii' }

describe('the decision', () => {
  it('signs when there is an account and the EVS client', () => {
    expect(vmp.vmpDecision({ platform: 'darwin', credentials: creds, client: '1.3.3', python: 'python3' })).toEqual({
      action: 'sign',
      reason: 'EVS account plexii (config), castlabs-evs 1.3.3'
    })
    expect(vmp.vmpDecision({ platform: 'win32', credentials: creds, client: '1.3.3', python: 'python' }).action).toBe('sign')
  })

  it('SKIPS with a clear reason and the sign-up command when there is no account', () => {
    const d = vmp.vmpDecision({ platform: 'darwin', credentials: null, client: null, python: 'python3' })
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/no castLabs EVS account/)
    expect(d.reason).toMatch(/Netflix and other commercial services will refuse it/)
    expect(d.reason).toContain('castlabs_evs.account signup')
  })

  it('skips when the client is missing, naming the python it looked in', () => {
    const d = vmp.vmpDecision({ platform: 'darwin', credentials: creds, client: null, python: '/x/bin/python3' })
    expect(d.action).toBe('skip')
    expect(d.reason).toContain('castlabs-evs client is not installed for /x/bin/python3')
  })

  it('FAILS instead of skipping under PLEXII_VMP=require', () => {
    expect(vmp.vmpDecision({ mode: 'require', platform: 'darwin', credentials: null, client: null, python: 'p' }).action).toBe('fail')
    expect(vmp.vmpDecision({ mode: 'require', platform: 'darwin', credentials: creds, client: '1.3.3', python: 'p' }).action).toBe('sign')
  })

  it('never signs under PLEXII_VMP=off, on Linux, or with a misspelt mode', () => {
    expect(vmp.vmpDecision({ mode: 'off', platform: 'darwin', credentials: creds, client: '1', python: 'p' }).action).toBe('skip')
    expect(vmp.vmpDecision({ platform: 'linux', credentials: creds, client: '1', python: 'p' }).action).toBe('skip')
    expect(vmp.vmpDecision({ mode: 'yes', platform: 'darwin', credentials: creds, client: '1', python: 'p' }).action).toBe('fail')
  })
})

describe('credentials, as the EVS client finds them', () => {
  const home = '/Users/someone'
  it('from the environment (CI)', () => {
    expect(vmp.evsCredentials({ env: { EVS_ACCOUNT_NAME: 'a', EVS_PASSWD: 'p' }, home, readFile: () => '' })).toEqual({
      source: 'env',
      account: 'a'
    })
  })
  it('from ~/.config/evs/config.json after signup: an account name AND a refresh token', () => {
    const files: Record<string, string> = {
      [`${home}/.config/evs/config.json`]: JSON.stringify({ Auth: { AccountName: 'plexii', RefreshToken: 'r', AccessToken: 'a' } })
    }
    const readFile = (p: string): string => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    }
    expect(vmp.evsCredentials({ env: {}, home, readFile })).toMatchObject({ source: 'config', account: 'plexii' })
    files[`${home}/.config/evs/config.json`] = JSON.stringify({ Auth: { AccountName: 'plexii', RefreshToken: null } })
    expect(vmp.evsCredentials({ env: {}, home, readFile })).toBeNull()
  })
  it('none at all', () => {
    expect(vmp.evsCredentials({ env: {}, home, readFile: () => { throw new Error('ENOENT') } })).toBeNull()
    expect(vmp.evsCredentials({ env: { EVS_ACCOUNT_NAME: 'a' }, home, readFile: () => { throw new Error('ENOENT') } })).toBeNull()
  })
  it('finds the python: PLEXII_EVS_PYTHON, then ~/.castlabs-evs, then python3', () => {
    expect(vmp.evsPython({ env: { PLEXII_EVS_PYTHON: '/opt/py' }, home, exists: () => true })).toBe('/opt/py')
    expect(vmp.evsPython({ env: {}, home, exists: (p) => p === `${home}/.castlabs-evs/bin/python3` })).toBe(`${home}/.castlabs-evs/bin/python3`)
    expect(vmp.evsPython({ env: {}, home, exists: () => false })).toBe('python3')
  })
})

describe('the runner', () => {
  let dir: string
  let resources: string
  let callLog: string
  let python: string

  /** A stand-in python: answers the client check, logs every EVS command. */
  function fakePython(opts: { verifyExit?: number } = {}): void {
    writeFileSync(
      python,
      `#!/bin/sh
if [ "$2" = "-c" ]; then printf '1.3.3'; exit 0; fi
echo "$@" >> "${callLog}"
case "$*" in *verify-pkg*) exit ${opts.verifyExit ?? 0};; esac
exit 0
`
    )
    chmodSync(python, 0o755)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vmp-test-'))
    resources = join(dir, 'PlexiiDesk.app', 'Contents', 'Resources')
    mkdirSync(resources, { recursive: true })
    callLog = join(dir, 'calls.log')
    python = join(dir, 'python')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const env = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH,
    HOME: dir,
    EVS_CONFIG_FILE: join(dir, 'none.json'),
    PLEXII_EVS_PYTHON: python,
    ...extra
  })

  it('without an account: no EVS command at all, a SKIPPED line, and "none" recorded for the app', () => {
    fakePython()
    const lines: string[] = []
    expect(vmp.vmpSignPackage({ platform: 'darwin', pkgDir: dir, nameHint: 'PlexiiDesk', resourcesDir: resources, env: env(), log: (s) => lines.push(s) })).toBe('skipped')
    expect(existsSync(callLog)).toBe(false)
    expect(lines.join('\n')).toMatch(/^\[vmp\] SKIPPED VMP signing: no castLabs EVS account/m)
    expect(JSON.parse(readFileSync(join(resources, 'vmp.json'), 'utf8')).vmp).toBe('none')
  })

  it('with an account: sign-pkg, then verify-pkg, non-interactive, for THIS app; "production" recorded', () => {
    fakePython()
    const out = vmp.vmpSignPackage({
      platform: 'darwin',
      pkgDir: dir,
      nameHint: 'PlexiiDesk',
      resourcesDir: resources,
      env: env({ EVS_ACCOUNT_NAME: 'plexii', EVS_PASSWD: 'secret' }),
      log: () => undefined
    })
    expect(out).toBe('signed')
    const calls = readFileSync(callLog, 'utf8').trim().split('\n')
    expect(calls).toEqual([
      `-I -m castlabs_evs.vmp --no-ask sign-pkg --name-hint PlexiiDesk ${dir}`,
      `-I -m castlabs_evs.vmp --no-ask verify-pkg --name-hint PlexiiDesk ${dir}`
    ])
    expect(JSON.parse(readFileSync(join(resources, 'vmp.json'), 'utf8'))).toMatchObject({ vmp: 'production', kind: 'streaming' })
  })

  it('a signature that does not verify fails the build and is never recorded as production', () => {
    fakePython({ verifyExit: 3 })
    expect(() =>
      vmp.vmpSignPackage({
        platform: 'darwin',
        pkgDir: dir,
        nameHint: 'PlexiiDesk',
        resourcesDir: resources,
        env: env({ EVS_ACCOUNT_NAME: 'plexii', EVS_PASSWD: 'secret' }),
        log: () => undefined
      })
    ).toThrow(/verify-pkg exited 3/)
    expect(existsSync(join(resources, 'vmp.json'))).toBe(false)
  })

  it('PLEXII_VMP=require without an account fails the build', () => {
    fakePython()
    expect(() =>
      vmp.vmpSignPackage({ platform: 'darwin', pkgDir: dir, resourcesDir: resources, env: env({ PLEXII_VMP: 'require' }), log: () => undefined })
    ).toThrow(/PLEXII_VMP=require, but no castLabs EVS account/)
  })

  it("removes castLabs' development signature from a slice (it differs per arch and the fuses invalidate it)", () => {
    const app = join(dir, 'PlexiiDesk.app')
    const sig = vmp.macFrameworkSig(app)
    mkdirSync(join(sig, '..'), { recursive: true })
    writeFileSync(sig, 'dev signature')
    expect(vmp.removeDevelopmentSig(app)).toBe(true)
    expect(existsSync(sig)).toBe(false)
    expect(vmp.removeDevelopmentSig(app)).toBe(false)
  })
})
