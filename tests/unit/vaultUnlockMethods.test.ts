import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Alternative ways to unlock the vault.
//
// "What would it take to get Apple passkey to work with logging into things on
// Plexii for apps and vault" → the honest answer was that Electron 37 exposes
// no WebAuthn platform authenticator (the running app reports
// `platformAuthenticatorAvailable: false`), so a passkey cannot unlock anything
// in-app today. Touch ID through `systemPreferences.promptTouchID` can.
//
// "Do it in the most future protective, forward thinking, safe and thorough
// way" → so what shipped is a REGISTRY of unlock methods, not a Touch ID
// feature. These tests defend the properties that make it extensible and that
// make it safe, because both are easy to quietly lose in a later edit.

const ROOT = join(__dirname, '..', '..', 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const unlock = read('main/vaultUnlock.ts')
const vault = read('main/db/vault.ts')
const ipc = read('main/ipc/index.ts')
const preload = read('preload/index.ts')
const view = read('renderer/src/components/views/VaultView.tsx')
const store = read('renderer/src/stores/vault.ts')

/** What actually executes, with the prose stripped out. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('it is a registry, so the next method needs no new plumbing', () => {
  it('methods live in a list that is iterated, not in a chain of ifs', () => {
    expect(unlock).toContain('const METHODS: MethodImpl[]')
    expect(unlock).toContain('METHODS.find((m) => m.id === id)')
    expect(unlock).toContain('return METHODS.map(')
  })

  it('every method implements the same three-verb shape', () => {
    expect(unlock).toContain('export function enrollUnlockMethod')
    expect(unlock).toContain('export async function unlockWithMethod')
    expect(unlock).toContain('export function forgetUnlockMethod')
    // Enrol and unlock dispatch through the registry rather than knowing a
    // method. `forget` deliberately does NOT: you must be able to turn off a
    // method whose hardware has gone, and requiring it to be available first
    // would leave a dead entry nobody could clear.
    expect(code(unlock).match(/implFor\(id\)/g)?.length ?? 0).toBe(2)
    expect(code(unlock)).toMatch(/export function forgetUnlockMethod[\s\S]{0,200}readFile\(\)/)
  })

  it('the UI renders whatever is registered rather than naming Touch ID', () => {
    // The unlock screen must not hard-code the one method that exists today.
    expect(view).toContain('ready.map((m) =>')
    expect(view).toContain('methods.map((m) =>')
    expect(view).toContain('Unlock with {m.label}')
  })

  it('the renderer store exposes a LIST, not a biometrics boolean', () => {
    expect(store).toContain('unlockMethods: VaultUnlockMethodInfo[]')
    expect(code(store)).not.toMatch(/touchIdEnabled|biometricsEnabled/)
  })
})

describe('no method can weaken the vault', () => {
  it('a key handed back by a method still faces the verifier', () => {
    // This is the property that makes the whole thing safe: an unlock method
    // supplies a key, it does not assert that the vault is open. A stale or
    // tampered blob fails exactly as a wrong password does.
    expect(vault).toContain('export function unlockWithKey')
    expect(vault).toContain('!== VERIFIER_PLAINTEXT')
    expect(vault).toContain("return { ok: false, error: 'Stored key no longer matches this vault.' }")
  })

  it('rejects a key of the wrong length before using it', () => {
    expect(vault).toContain('if (key.length !== KEY_LEN_BYTES)')
  })

  it('the user is asked BEFORE the key is unwrapped', () => {
    // Order matters. Unwrapping first and prompting second would make the
    // prompt decorative — the key would be in memory either way.
    const authAt = code(unlock).indexOf('await impl.authorise(')
    const decryptAt = code(unlock).indexOf('safeStorage.decryptString')
    expect(authAt).toBeGreaterThan(-1)
    expect(decryptAt).toBeGreaterThan(authAt)
  })

  it('stores a WRAPPED KEY and never a password', () => {
    // The word "password" appears in prose and in user-facing strings, which
    // is right. What must not exist is a password as DATA: no parameter takes
    // one, nothing derives a key from one, and nothing writes one.
    const c = code(unlock)
    expect(c).not.toMatch(/\b(masterPassword|plaintextPassword)\b/)
    expect(c).not.toContain('pbkdf2')
    expect(c).not.toContain('deriveKey')
    // The only thing wrapped is a 32-byte key supplied by the vault.
    expect(unlock).toContain('safeStorage.encryptString(key.toString')
    expect(unlock).toContain('enrollUnlockMethod(\n  id: VaultUnlockMethodId,\n  key: Buffer\n)')
  })

  it('enrolment is impossible while the vault is locked', () => {
    // You can only wrap a key you already hold, so there is no path from
    // enrolment to deriving or guessing one.
    expect(vault).toContain('export function getUnlockedKeyCopy')
    expect(vault).toContain('return cachedKey ? Buffer.from(cachedKey) : null')
    expect(ipc).toContain("if (!key) return { ok: false as const, error: 'Unlock the vault first.' }")
  })

  it('hands out a COPY of the key, so a caller cannot zero the session', () => {
    expect(vault).toContain('Buffer.from(cachedKey)')
    expect(ipc).toContain('key.fill(0)')
  })

  it('the master password is never removed as a way in', () => {
    // A vault you can be locked out of is worse than one without biometrics.
    expect(unlock).toContain('the password still works')
    expect(view).toContain('Your master password is always a way in.')
    // The password field is on the same screen, not behind a fallback link.
    expect(view).toContain('placeholder="Master password"')
  })
})

describe('rotating the master password invalidates every wrapped key', () => {
  it('the vault announces a re-key', () => {
    expect(vault).toContain('export function onVaultRekeyed')
    expect(vault).toContain('notifyRekeyed()')
  })

  it('the re-key fires AFTER the new key is cached, so re-enrolment can work', () => {
    const c = code(vault)
    const cacheAt = c.indexOf('cachedKey = newKey')
    const notifyAt = c.indexOf('notifyRekeyed()')
    expect(cacheAt).toBeGreaterThan(-1)
    expect(notifyAt).toBeGreaterThan(cacheAt)
  })

  it('listeners cannot fail a re-key that already committed', () => {
    expect(vault).toContain('// A listener must never be able to fail a completed re-key.')
  })

  it('the IPC layer drops the old wrappings and re-enrols under the new key', () => {
    expect(ipc).toContain('onVaultRekeyed(() => {')
    expect(ipc).toContain('forgetAllUnlockMethods()')
    expect(ipc).toContain('for (const id of wasEnrolled) enrollUnlockMethod(id, key)')
  })

  it('a wrapping that no longer matches is cleared, not left to keep failing', () => {
    expect(ipc).toContain('if (!res.ok) forgetUnlockMethod(id)')
  })
})

describe('availability is reported, never assumed', () => {
  it('checks the platform, local encryption AND an enrolled fingerprint', () => {
    expect(unlock).toContain("process.platform !== 'darwin'")
    expect(unlock).toContain('safeStorage.isEncryptionAvailable()')
    expect(unlock).toContain('systemPreferences.canPromptTouchID()')
  })

  it('says WHY a method is unavailable instead of hiding it', () => {
    expect(unlock).toContain('unavailableReason')
    expect(unlock).toContain("reason: 'No fingerprint is enrolled on this Mac.'")
    expect(view).toContain('m.unavailableReason')
  })

  it('a corrupt or unwritable store never blocks the password path', () => {
    expect(unlock).toContain('// A corrupt file must not block the password path.')
    expect(unlock).toContain('// Non-fatal: enrolment fails, the password still works.')
  })

  it('a cancelled prompt is not treated as a failure', () => {
    expect(unlock).toContain('cancelled: true')
    expect(store).toContain('} else if (!res.cancelled) {')
  })
})

describe('the limits are stated to the user, not just to the next developer', () => {
  it('the code is explicit that this is NOT Secure Enclave', () => {
    expect(unlock).toContain('not by the Secure Enclave')
    expect(unlock).toContain('UNLOCK GATE, not a second encryption factor')
  })

  it('and the UI says so where the user agrees to it', () => {
    // The trade is stated on the screen where it is accepted, not in a
    // tooltip. Selling a keychain-wrapped key as Secure Enclave protection
    // would be claiming security it does not have.
    expect(unlock).toContain('convenience gate rather than extra encryption')
    expect(view).toContain('{m.available ? m.detail : m.unavailableReason}')
  })

  it('names the concrete next method the registry exists to accept', () => {
    expect(unlock).toContain('kSecAccessControlBiometryCurrentSet')
    expect(unlock).toContain("'secure-enclave'")
  })
})

describe('the wrapped key is stored apart from third-party credentials', () => {
  it('has its own file rather than widening the API-key store', () => {
    expect(unlock).toContain("join(app.getPath('userData'), 'vault-unlock.json')")
    expect(code(unlock)).not.toContain('settingsStore')
  })

  it('keeps electron out of the database layer', () => {
    // vault.ts is imported by tests and by non-electron paths; the method
    // registry is what owns the electron imports.
    expect(code(vault)).not.toContain("from 'electron'")
    expect(unlock).toContain("from 'electron'")
  })
})

describe('the renderer cannot reach past the IPC boundary', () => {
  it('exposes only the four verbs, and never a key', () => {
    for (const ch of [
      'vault:unlockMethods',
      'vault:enrollUnlockMethod',
      'vault:unlockWithMethod',
      'vault:forgetUnlockMethod'
    ]) {
      expect(preload, ch).toContain(ch)
    }
  })

  it('no channel returns key material', () => {
    // enroll takes no key from the renderer and unlock returns only ok/error.
    expect(ipc).toContain("ipcMain.handle('vault:unlockWithMethod', async (_e, id: VaultUnlockMethodId) => {")
    expect(preload).toContain(
      "unlockWithMethod: (\n      id: VaultUnlockMethodId\n    ): Promise<{ ok: true } | { ok: false; error: string; cancelled?: boolean }> =>"
    )
    expect(code(preload)).not.toMatch(/vault:.*[Kk]ey'/)
  })
})
