// The Vault in the browser: visible, and honestly locked.
//
// The desktop Vault derives a key from the master password with PBKDF2 and
// encrypts each entry with AES-256-GCM, synchronously, through Node's crypto.
// The browser has both primitives in Web Crypto -- but only asynchronously,
// while every call site here is synchronous and sits behind a synchronous data
// layer. Bridging that means making the Vault's own API async on BOTH runtimes.
//
// The alternative is implementing AES-GCM and PBKDF2 in JavaScript so they can
// stay synchronous, and that is not a reasonable thing to do to a module whose
// job is protecting the user's passwords. A subtle mistake in a cipher is not a
// rendering glitch; it is a silent, total loss of the guarantee.
//
// So this reports what is true and refuses the rest. The metadata read is real
// SQL against the same table, so the UI can say whether a vault exists and show
// it locked; unlocking says why it cannot happen here. Making it work is a
// scoped piece of work -- turn the Vault's crypto async and await it in both
// runtimes -- not a shim.
import { getDb } from '../../../main/db/database'

export interface VaultMeta {
  exists: boolean
  iterations: number
  salt: string
  verifierIv: string
  verifierCiphertext: string
  createdAt?: number
  updatedAt?: number
}

interface MetaRow {
  iterations: number
  salt: string
  verifier_iv: string
  verifier_ciphertext: string
  created_at: number
  updated_at: number
}

const ITERATIONS = 210_000

/** Real, and the same query the desktop runs: does a vault exist here? */
export function getVaultMeta(): VaultMeta {
  const row = getDb().prepare('SELECT * FROM vault_meta WHERE id = 1').get() as MetaRow | undefined
  if (!row) {
    return { exists: false, iterations: ITERATIONS, salt: '', verifierIv: '', verifierCiphertext: '' }
  }
  return {
    exists: true,
    iterations: row.iterations,
    salt: row.salt,
    verifierIv: row.verifier_iv,
    verifierCiphertext: row.verifier_ciphertext,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** Never, here: nothing in this runtime can derive the key that unlocks it. */
export function isUnlocked(): boolean {
  return false
}

export function lockVault(): void {
  // Already locked, and nothing holds a key to release.
}

/** Locked, so the desktop returns nothing here too -- this matches, not stubs. */
export function listEntries(): [] {
  return []
}

const NEEDS_ASYNC_CRYPTO =
  'The Vault cannot be unlocked in the browser yet: its AES-GCM and PBKDF2 are ' +
  'synchronous, and the browser provides them only asynchronously. Use the desktop app.'

export function unlockVault(_master: string): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function createVault(_master: string): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function changeMasterPassword(): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function createEntry(): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function updateEntry(): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function deleteEntry(): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function encryptWithMaster(_plaintext: string): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
export function decryptWithMaster(): never { throw new Error(NEEDS_ASYNC_CRYPTO) }
