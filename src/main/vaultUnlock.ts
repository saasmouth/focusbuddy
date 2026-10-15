// Alternative ways to unlock the vault, as a registry rather than a feature.
//
// WHY A REGISTRY AND NOT "ADD TOUCH ID". The master password is the only way in
// today, and the obvious change is to bolt Touch ID beside it. That ages badly:
// the next method (Secure Enclave with biometric-bound keys, a passkey, a
// hardware key, a phone approval) would each bolt on the same way, and the
// unlock screen would grow a branch per method. So the vault knows about
// METHODS, not about Touch ID. Adding one later means registering it here; no
// call site changes, and the UI lists whatever is registered and available.
//
// THE SHAPE EVERY METHOD SHARES — key wrapping, never password storage:
//
//   enroll(key)  wrap the vault's AES key with whatever that method protects
//                with, and store the wrapped blob. Requires an unlocked vault,
//                because you can only wrap a key you already hold.
//   unlock()     satisfy the method (a Touch ID prompt, a passkey assertion),
//                then unwrap and return the key.
//   forget()     drop the wrapped blob.
//
// The master password is NEVER stored by any of this, and the derived key never
// leaves the main process. A method that cannot wrap, or whose hardware has
// gone, simply reports unavailable and the password still works — a vault you
// can be locked out of is worse than one without biometrics.
//
// WHAT TOUCH ID HERE IS, HONESTLY. `safeStorage` is protected by the login
// keychain, not by the Secure Enclave with biometric access control. So Touch
// ID is an UNLOCK GATE, not a second encryption factor: someone with your
// unlocked Mac and this file could unwrap the key without presenting a finger.
// That is a real limit and it is stated in the UI rather than implied away.
// Genuine Secure-Enclave binding needs LAContext +
// kSecAccessControlBiometryCurrentSet through a native module — which is
// exactly the kind of method this registry exists to accept later, as
// 'secure-enclave', without disturbing anything else.

import { app, safeStorage, systemPreferences } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import type { VaultUnlockMethodId, VaultUnlockMethodInfo } from '@shared/types'

export type { VaultUnlockMethodId, VaultUnlockMethodInfo }

interface MethodImpl {
  id: VaultUnlockMethodId
  label: string
  detail: string
  isAvailable: () => { ok: true } | { ok: false; reason: string }
  /** Prove the user is present. Resolves to continue, rejects to refuse. */
  authorise: (reason: string) => Promise<void>
}

// ── Where wrapped keys live ──────────────────────────────────────────────────
// Its own file, not the API-key store: that store's SecretName union is about
// third-party credentials, and widening it for this would tangle two concerns
// that have different lifetimes and different blast radii.

interface WrappedFile {
  v: 1
  wrapped: Partial<Record<VaultUnlockMethodId, string>>
}

function filePath(): string {
  return join(app.getPath('userData'), 'vault-unlock.json')
}

function readFile(): WrappedFile {
  try {
    if (!existsSync(filePath())) return { v: 1, wrapped: {} }
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<WrappedFile>
    return { v: 1, wrapped: parsed.wrapped ?? {} }
  } catch {
    // A corrupt file must not block the password path.
    return { v: 1, wrapped: {} }
  }
}

function writeFileSafe(data: WrappedFile): void {
  try {
    writeFileSync(filePath(), JSON.stringify(data), 'utf-8')
  } catch {
    // Non-fatal: enrolment fails, the password still works.
  }
}

// ── The methods ──────────────────────────────────────────────────────────────

const METHODS: MethodImpl[] = [
  {
    id: 'biometric',
    label: 'Touch ID',
    detail:
      'Unlock with your fingerprint instead of typing the master password. The key is kept in your login keychain, so this is a convenience gate rather than extra encryption — your master password still works, and is still what protects the vault.',
    isAvailable: () => {
      if (process.platform !== 'darwin') {
        return { ok: false, reason: 'Touch ID is macOS only.' }
      }
      if (!safeStorage.isEncryptionAvailable()) {
        return { ok: false, reason: 'This machine cannot encrypt locally, so the key cannot be stored safely.' }
      }
      try {
        if (!systemPreferences.canPromptTouchID()) {
          return { ok: false, reason: 'No fingerprint is enrolled on this Mac.' }
        }
      } catch {
        return { ok: false, reason: 'Touch ID is not available on this Mac.' }
      }
      return { ok: true }
    },
    authorise: (reason) => systemPreferences.promptTouchID(reason)
  }
]

function implFor(id: VaultUnlockMethodId): MethodImpl | null {
  return METHODS.find((m) => m.id === id) ?? null
}

/** Every registered method, with its real availability and enrolment state. */
export function listUnlockMethods(): VaultUnlockMethodInfo[] {
  const file = readFile()
  return METHODS.map((m) => {
    const avail = m.isAvailable()
    return {
      id: m.id,
      label: m.label,
      detail: m.detail,
      available: avail.ok,
      enrolled: typeof file.wrapped[m.id] === 'string',
      unavailableReason: avail.ok ? undefined : avail.reason
    }
  })
}

/**
 * Wrap the live vault key for a method.
 *
 * The caller passes the key because only the vault module holds it; this module
 * deliberately has no way to derive or read it otherwise.
 */
export function enrollUnlockMethod(
  id: VaultUnlockMethodId,
  key: Buffer
): { ok: true } | { ok: false; error: string } {
  const impl = implFor(id)
  if (!impl) return { ok: false, error: `Unknown unlock method "${id}".` }
  const avail = impl.isAvailable()
  if (!avail.ok) return { ok: false, error: avail.reason }
  try {
    const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
    const file = readFile()
    file.wrapped[id] = wrapped
    writeFileSafe(file)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

/**
 * Satisfy a method and return the vault key it was holding.
 *
 * Order matters: the user is asked FIRST and the blob is unwrapped only after
 * they are present. Unwrapping first and then prompting would make the prompt
 * decorative, since the key would already be in memory either way.
 *
 * The returned key is NOT trusted by itself — the vault verifies it against the
 * verifier before accepting it, so a stale or tampered blob fails closed.
 */
export async function unlockWithMethod(
  id: VaultUnlockMethodId,
  reason: string
): Promise<{ ok: true; key: Buffer } | { ok: false; error: string; cancelled?: boolean }> {
  const impl = implFor(id)
  if (!impl) return { ok: false, error: `Unknown unlock method "${id}".` }
  const avail = impl.isAvailable()
  if (!avail.ok) return { ok: false, error: avail.reason }
  const wrapped = readFile().wrapped[id]
  if (!wrapped) return { ok: false, error: 'Not set up on this machine.' }

  try {
    await impl.authorise(reason)
  } catch {
    // Cancelled or failed. Not an error state to shout about — the password
    // field is right there.
    return { ok: false, error: 'Cancelled.', cancelled: true }
  }

  try {
    const b64 = safeStorage.decryptString(Buffer.from(wrapped, 'base64'))
    const key = Buffer.from(b64, 'base64')
    if (key.length !== 32) {
      return { ok: false, error: 'Stored key is malformed.' }
    }
    return { ok: true, key }
  } catch {
    return { ok: false, error: 'The stored key could not be read. Use your master password.' }
  }
}

/** Drop a method's wrapped key. */
export function forgetUnlockMethod(id: VaultUnlockMethodId): void {
  const file = readFile()
  if (!(id in file.wrapped)) return
  delete file.wrapped[id]
  writeFileSafe(file)
}

/**
 * Drop EVERY wrapped key.
 *
 * Called when the master password changes, because rotation derives a new key
 * and every stored wrapping is now of the old one. Leaving them would hand back
 * a key that fails the verifier — safe, but it would present as "Touch ID is
 * broken" rather than "Touch ID needs setting up again". The vault re-enrols
 * straight afterwards when it can, so in practice this is invisible.
 */
export function forgetAllUnlockMethods(): void {
  try {
    if (existsSync(filePath())) unlinkSync(filePath())
  } catch {
    // Best effort; a stale blob still fails the verifier and is refused.
  }
}

/** Is any method enrolled? Lets the unlock screen decide what to offer. */
export function hasAnyEnrolledMethod(): boolean {
  return Object.keys(readFile().wrapped).length > 0
}
