// @vitest-environment node
// Signing in when the server cannot be reached (main/db/offlineSignIn.ts).
//
// Owner, 2026-11-07: "Do not allow anyone to open plexii without signing in
// first as a rule." Offline, the password typed is checked against the one last
// used to sign in on this computer; nothing that could be replayed is kept, and
// without OS encryption nothing is kept at all.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'offline-signin-'))
let encryption = true
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => encryption,
    // A stand-in keychain: reversible, and visibly not plain text.
    encryptString: (s: string) => Buffer.from(`KC:${Buffer.from(s).toString('hex')}`),
    decryptString: (b: Buffer) => {
      const t = b.toString()
      if (!t.startsWith('KC:')) throw new Error('not ours')
      return Buffer.from(t.slice(3), 'hex').toString()
    }
  }
}))

import {
  forgetOfflineSignIn, offlineSignInEmail, rememberOfflineSignIn, verifyOfflineSignIn
} from '../../src/main/db/offlineSignIn'

const FILE = join(dir, 'account-offline.json')

beforeEach(() => {
  encryption = true
  forgetOfflineSignIn()
})

describe('after an online sign-in', () => {
  it('keeps a check of the password, never the password', async () => {
    expect(await rememberOfflineSignIn('Sam@Example.com ', 'correct horse battery')).toBe(true)
    const onDisk = readFileSync(FILE, 'utf8')
    expect(onDisk).not.toContain('correct horse battery')
    expect(onDisk).not.toContain('sam@example.com')
    expect(offlineSignInEmail()).toBe('sam@example.com')
  })

  it('keeps nothing when the OS cannot encrypt it', async () => {
    encryption = false
    expect(await rememberOfflineSignIn('sam@example.com', 'pw')).toBe(false)
    expect(existsSync(FILE)).toBe(false)
  })

  it('one account per computer: the newest sign-in replaces the record', async () => {
    await rememberOfflineSignIn('sam@example.com', 'first password')
    await rememberOfflineSignIn('alex@example.com', 'second password')
    expect(offlineSignInEmail()).toBe('alex@example.com')
    expect(await verifyOfflineSignIn('sam@example.com', 'first password')).toBe(false)
  })
})

describe('offline', () => {
  it('lets in the right password for the right email, and nothing else', async () => {
    await rememberOfflineSignIn('sam@example.com', 'correct horse battery')
    expect(await verifyOfflineSignIn('SAM@example.com', 'correct horse battery')).toBe(true)
    expect(await verifyOfflineSignIn('sam@example.com', 'correct horse batter')).toBe(false)
    expect(await verifyOfflineSignIn('sam@example.com', '')).toBe(false)
    expect(await verifyOfflineSignIn('someone@else.com', 'correct horse battery')).toBe(false)
  })

  it('a computer that never signed in online lets nobody in', async () => {
    expect(offlineSignInEmail()).toBeNull()
    expect(await verifyOfflineSignIn('sam@example.com', 'anything')).toBe(false)
  })

  it('a record the keychain cannot open lets nobody in', async () => {
    await rememberOfflineSignIn('sam@example.com', 'pw-one')
    encryption = false
    expect(offlineSignInEmail()).toBeNull()
    expect(await verifyOfflineSignIn('sam@example.com', 'pw-one')).toBe(false)
  })
})
