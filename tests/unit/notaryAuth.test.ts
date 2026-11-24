// @vitest-environment node
//
// The app-specific password stays off notarytool's command line.
//
// @electron/notarize runs `notarytool submit … --apple-id … --password <it>`,
// and a process's arguments are readable by every other process on the Mac
// (`ps`, `pgrep -fl`) for the whole upload. It was seen there, in two agent
// sessions' tool output. A notarytool keychain profile (stored once, typed at
// notarytool's own prompt) puts only `--keychain-profile <name>` on the line.
//
// The trap: electron-builder 26 (MacTargetHelper.getNotarizeOptions) uses the
// Apple ID + password whenever EITHER is in the environment, before it looks at
// an API key or a profile. So adding a profile is not enough: the password has
// to be taken OUT of the build's environment. These tests hold the three gates
// to that: release-env.mjs (what the build is given), require-signing-env.mjs
// (refuses a signed build that would put the password on the line) and
// electron-builder.cjs (strips it in the builder's own process, last).
//
// Every value here is fake. `security` is replaced by a stub on PATH that
// "knows" the profiles named in FAKE_NOTARY_PROFILES, so no test reads the real
// keychain.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = join(__dirname, '..', '..')
const FAKE_PASSWORD = 'fake-app-pw-0000-test'
const FAKE_APPLE_ID = 'notary.test@example.com'
const TEAM = 'TEAMID0000'

let dir = ''
let fakeBin = ''
let fakeEnvFile = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'notary-auth-'))
  fakeBin = join(dir, 'bin')
  spawnSync('mkdir', ['-p', fakeBin])
  const security = join(fakeBin, 'security')
  writeFileSync(
    security,
    [
      '#!/bin/sh',
      '# Stub `security`: a notarytool profile exists if it is named in FAKE_NOTARY_PROFILES.',
      'acct=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-a" ]; then acct="$2"; shift; fi; shift; done',
      'for p in $FAKE_NOTARY_PROFILES; do [ "$acct" = "com.apple.gke.notary.tool.saved-creds.$p" ] && exit 0; done',
      'exit 44',
      ''
    ].join('\n')
  )
  chmodSync(security, 0o755)
  // An empty .env, so release-env reads nothing from a real one.
  fakeEnvFile = join(dir, 'empty.env')
  writeFileSync(fakeEnvFile, '# nothing\n')
})

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** A clean environment: the stub first on PATH, node reachable, nothing Apple inherited. */
function envWith(extra: Record<string, string>, profiles: string[] = []): NodeJS.ProcessEnv {
  return {
    PATH: `${fakeBin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: dir,
    RELEASE_ENV_FILE: fakeEnvFile,
    FAKE_NOTARY_PROFILES: profiles.join(' '),
    ...extra
  }
}

const PASSWORD_SET = { APPLE_ID: FAKE_APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD: FAKE_PASSWORD, APPLE_TEAM_ID: TEAM }

function run(args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` }
}

// ── release-env.mjs: what the build process is handed ───────────────────────
const SHOW_ENV = `console.log('ENV=' + JSON.stringify({
  password: 'APPLE_APP_SPECIFIC_PASSWORD' in process.env,
  appleId: 'APPLE_ID' in process.env,
  profile: process.env.APPLE_KEYCHAIN_PROFILE || null,
  team: process.env.APPLE_TEAM_ID || null
}))`

function releaseEnv(env: NodeJS.ProcessEnv) {
  const r = run(['scripts/release-env.mjs', 'node', '-e', SHOW_ENV], env)
  const line = r.out.split('\n').find((l) => l.startsWith('ENV='))
  return { ...r, child: line ? JSON.parse(line.slice(4)) : null }
}

describe('release-env.mjs', () => {
  it('with a stored profile, the build gets the profile and NOT the password or Apple ID', () => {
    const r = releaseEnv(envWith(PASSWORD_SET, ['plexii-notary']))
    expect(r.child, r.out).toEqual({ password: false, appleId: false, profile: 'plexii-notary', team: TEAM })
    expect(r.out).toMatch(/notarisation: keychain profile plexii-notary/)
  })

  it('an explicit APPLE_KEYCHAIN_PROFILE that is not stored stops the build', () => {
    const r = releaseEnv(envWith({ ...PASSWORD_SET, APPLE_KEYCHAIN_PROFILE: 'not-stored' }, ['plexii-notary']))
    expect(r.code).not.toBe(0)
    expect(r.child).toBeNull()
    expect(r.out).toMatch(/not-stored/)
  })

  it('password only, no profile: refuses, and says how to store one', () => {
    const r = releaseEnv(envWith(PASSWORD_SET))
    expect(r.code).not.toBe(0)
    expect(r.child).toBeNull()
    expect(r.out).toMatch(/store-credentials/)
    expect(r.out).not.toContain(FAKE_PASSWORD)
  })

  it('password only with NOTARY_PASSWORD_IN_ARGV=1: the old path, on purpose, with a loud warning', () => {
    const r = releaseEnv(envWith({ ...PASSWORD_SET, NOTARY_PASSWORD_IN_ARGV: '1' }))
    expect(r.child, r.out).toEqual({ password: true, appleId: true, profile: null, team: TEAM })
    expect(r.out).toMatch(/WARNING/)
    expect(r.out).not.toContain(FAKE_PASSWORD)
  })

  it('never prints a value', () => {
    const r = releaseEnv(envWith(PASSWORD_SET, ['plexii-notary']))
    expect(r.out).not.toContain(FAKE_PASSWORD)
    expect(r.out).not.toContain(FAKE_APPLE_ID)
  })
})

// ── require-signing-env.mjs: the gate inside `npm run dist:*:signed` ─────────
describe('require-signing-env.mjs', () => {
  const gate = (env: NodeJS.ProcessEnv) => run(['scripts/require-signing-env.mjs'], env)

  it('a stored profile is enough to sign', () => {
    const r = gate(envWith({ APPLE_KEYCHAIN_PROFILE: 'plexii-notary', APPLE_TEAM_ID: TEAM }, ['plexii-notary']))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/keychain profile/)
  })

  it('password only, no profile: refuses (the password would be on the command line)', () => {
    const r = gate(envWith(PASSWORD_SET))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/command line/)
  })

  it('password only with NOTARY_PASSWORD_IN_ARGV=1: allowed, loudly', () => {
    const r = gate(envWith({ ...PASSWORD_SET, NOTARY_PASSWORD_IN_ARGV: '1' }))
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/WARNING/)
  })

  it('an explicit profile that is not stored: refuses', () => {
    const r = gate(envWith({ APPLE_KEYCHAIN_PROFILE: 'not-stored', APPLE_TEAM_ID: TEAM }))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not-stored/)
  })

  it('nothing at all: refuses as before', () => {
    const r = gate(envWith({}))
    expect(r.code).toBe(1)
  })
})

// ── electron-builder.cjs: inside the builder, where notarize reads the env ───
// Loads the real config and asks electron-builder's own MacTargetHelper what it
// would hand @electron/notarize, in the same process.
const PROBE = `
let c
try { c = require('./electron-builder.cjs') } catch (e) { console.log('THREW=' + e.message.replace(/\\s+/g, ' ')); process.exit(3) }
const { MacTargetHelper } = require('app-builder-lib/out/mac/MacTargetHelper.js')
const o = MacTargetHelper.getNotarizeOptions('/x.app') || {}
console.log('PROBE=' + JSON.stringify({
  notarize: c.mac.notarize === true,
  adhoc: c.mac.identity === null,
  envPassword: 'APPLE_APP_SPECIFIC_PASSWORD' in process.env,
  optPassword: 'appleIdPassword' in o,
  keychainProfile: o.keychainProfile || null
}))`

// argv as the electron-builder CLI would see it: [node, cli, ...flags].
function builder(env: NodeJS.ProcessEnv, flags: string[] = ['--mac']) {
  const r = run(['-e', PROBE, '--', 'electron-builder', ...flags], env)
  const line = r.out.split('\n').find((l) => l.startsWith('PROBE='))
  return { ...r, probe: line ? JSON.parse(line.slice(6)) : null }
}

describe('electron-builder.cjs', () => {
  it('password AND a stored profile: notarize gets the profile; the password is gone from the builder', () => {
    const r = builder(envWith(PASSWORD_SET, ['plexii-notary']))
    expect(r.probe, r.out).toEqual({
      notarize: true,
      adhoc: false,
      envPassword: false,
      optPassword: false,
      keychainProfile: 'plexii-notary'
    })
  })

  it('a profile alone signs and notarises (not ad-hoc)', () => {
    const r = builder(envWith({ APPLE_KEYCHAIN_PROFILE: 'plexii-notary', APPLE_TEAM_ID: TEAM }, ['plexii-notary']))
    expect(r.probe, r.out).toMatchObject({ notarize: true, adhoc: false, keychainProfile: 'plexii-notary' })
  })

  it('password only, no profile: the config refuses to load', () => {
    const r = builder(envWith(PASSWORD_SET))
    expect(r.code).toBe(3)
    expect(r.out).toMatch(/THREW=.*command line/)
  })

  it('password only with NOTARY_PASSWORD_IN_ARGV=1: the old path, explicitly', () => {
    const r = builder(envWith({ ...PASSWORD_SET, NOTARY_PASSWORD_IN_ARGV: '1' }))
    expect(r.probe, r.out).toMatchObject({ notarize: true, optPassword: true, keychainProfile: null })
  })

  it('no credentials, a mac build: refuses loudly (it used to come out ad-hoc and exit 0)', () => {
    const r = builder(envWith({}))
    expect(r.code).toBe(3)
    expect(r.out).toMatch(/THREW=.*REFUSING a mac build/)
  })

  it('no credentials with SKIP_SIGNING_CHECK=1: ad-hoc, on purpose', () => {
    const r = builder(envWith({ SKIP_SIGNING_CHECK: '1' }))
    expect(r.probe, r.out).toMatchObject({ notarize: false, adhoc: true })
  })

  it('no credentials, loaded by a test or script rather than electron-builder: read, not refused', () => {
    const r = run(['-e', PROBE, '--', 'some-script.mjs'], envWith({}))
    expect(r.code, r.out).toBe(0)
  })

  it('no credentials, a Windows build: not stopped (nothing to notarise)', () => {
    const r = builder(envWith({}), ['--win'])
    expect(r.probe, r.out).toMatchObject({ notarize: false })
  })

  it('an API key AND a password: the key, and the password is gone (electron-builder would pick the password)', () => {
    const r = builder(
      envWith({ ...PASSWORD_SET, APPLE_API_KEY: '/x/AuthKey.p8', APPLE_API_KEY_ID: 'KEYID', APPLE_API_ISSUER: 'issuer' })
    )
    expect(r.probe, r.out).toMatchObject({ notarize: true, envPassword: false, optPassword: false })
  })
})

// ── every gate decides through notary-auth.cjs ──────────────────────────────
// build/harden.cjs (afterPack) had its own copy of the old check. Once the
// config takes APPLE_ID out of the environment, a copy that still asks for it
// reads "no credentials" and ad-hoc signs a build that is about to notarise.
describe('one decision', () => {
  it('no build script or hook checks APPLE_ID / the password for itself', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const files = [
      // electron-builder.cjs and every other target's config (electron-builder.aispace.cjs, …)
      ...readdirSync(root).filter((f) => /^electron-builder.*\.cjs$/.test(f)),
      ...readdirSync(join(root, 'build')).filter((f) => /\.(c?js|mjs)$/.test(f)).map((f) => `build/${f}`),
      ...readdirSync(join(root, 'scripts')).filter((f) => /\.(c?js|mjs|sh)$/.test(f)).map((f) => `scripts/${f}`)
    ].filter((f) => f !== 'scripts/notary-auth.cjs')
    const deciding = files.filter((f) =>
      /process\.env\.(APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD)\b|env\[?['"]?APPLE_APP_SPECIFIC_PASSWORD/.test(
        readFileSync(join(root, f), 'utf8')
      )
    )
    expect(deciding).toEqual([])
    for (const f of ['electron-builder.cjs', 'build/harden.cjs', 'scripts/release-env.mjs', 'scripts/require-signing-env.mjs']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toContain('notary-auth.cjs')
    }
  })
})
