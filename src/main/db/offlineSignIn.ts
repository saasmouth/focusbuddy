// Signing in when the server cannot be reached.
//
// Owner, 2026-11-07: "Do not allow anyone to open plexii without signing in
// first as a rule." Every launch starts signed out (clearSessionForNewLaunch),
// and until now an unreachable server offered "Continue offline for now" to
// anyone this computer had seen sign in before -- a way in with no password at
// all. The app is local-first, so an outage must not lock people out of their
// own desks; but getting in still means proving who you are.
//
// So the last successful sign-in on this computer leaves a VERIFIER behind: a
// scrypt hash of the password with its own salt, encrypted with the OS keychain
// (safeStorage), in a file of its own. Offline, the password typed is checked
// against it. Nothing that could be replayed is kept -- not the password, not a
// token -- and without OS encryption nothing is kept at all.
//
// Kept apart from account-session.json on purpose: that file's writers rebuild
// it field by field, and a field they do not know would be dropped by them.
//
// One account per computer: the newest sign-in replaces the record. A password
// changed elsewhere still opens this computer offline until the next online
// sign-in here replaces it, like any cached credential.
import { app, safeStorage } from 'electron'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** scrypt cost: about a tenth of a second here, ruinous at scale for a guesser. */
const PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEY_BYTES = 32

interface Verifier {
  v: 1
  email: string
  salt: string
  hash: string
}

function fileFor(): string {
  return join(app.getPath('userData'), 'account-offline.json')
}

const normalise = (email: string): string => String(email ?? '').trim().toLowerCase()

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_BYTES, PARAMS, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

function readVerifier(): Verifier | null {
  try {
    if (!existsSync(fileFor())) return null
    if (!safeStorage.isEncryptionAvailable()) return null
    const raw = JSON.parse(readFileSync(fileFor(), 'utf8')) as { data?: unknown }
    if (typeof raw.data !== 'string') return null
    const plain = JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64'))) as Partial<Verifier>
    if (plain.v !== 1 || typeof plain.email !== 'string' || typeof plain.salt !== 'string' || typeof plain.hash !== 'string') return null
    return plain as Verifier
  } catch {
    return null
  }
}

/**
 * After a successful online sign-in: keep what is needed to check this
 * password offline. False when the OS cannot encrypt it (then nothing is kept).
 */
export async function rememberOfflineSignIn(email: string, password: string): Promise<boolean> {
  const who = normalise(email)
  if (!who || !password) return false
  if (!safeStorage.isEncryptionAvailable()) return false
  const salt = randomBytes(16)
  const hash = await derive(String(password), salt)
  const verifier: Verifier = { v: 1, email: who, salt: salt.toString('base64'), hash: hash.toString('base64') }
  const data = safeStorage.encryptString(JSON.stringify(verifier)).toString('base64')
  mkdirSync(dirname(fileFor()), { recursive: true })
  writeFileSync(fileFor(), JSON.stringify({ v: 1, data }), 'utf8')
  return true
}

/** The email that can sign in offline on this computer, or null. */
export function offlineSignInEmail(): string | null {
  return readVerifier()?.email ?? null
}

/** Offline: is this the password last used to sign in here, for this email? */
export async function verifyOfflineSignIn(email: string, password: string): Promise<boolean> {
  const v = readVerifier()
  if (!v || normalise(email) !== v.email || !password) return false
  const expected = Buffer.from(v.hash, 'base64')
  const got = await derive(String(password), Buffer.from(v.salt, 'base64'))
  return got.length === expected.length && timingSafeEqual(got, expected)
}

/** Forget it (closing an account, or a test). */
export function forgetOfflineSignIn(): void {
  try {
    rmSync(fileFor(), { force: true })
  } catch {
    /* nothing to remove */
  }
}
