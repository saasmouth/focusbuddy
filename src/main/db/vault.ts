import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID
} from 'crypto'
import { getDb } from './database'
import { getActiveOrgId } from './activeOrg'
import type {
  VaultEntryDraft,
  VaultEntryPatch,
  VaultEntryStored,
  VaultMeta
} from '@shared/types'

// ── Crypto constants ─────────────────────────────────────────────────────────
// PBKDF2-SHA256, 600k iterations = OWASP 2023 recommendation. Increase over time.
const ITERATIONS = 600_000
const KEY_LEN_BYTES = 32 // AES-256
const SALT_LEN_BYTES = 16
const IV_LEN_BYTES = 12 // GCM standard
const VERIFIER_PLAINTEXT = 'fb-vault-v1' // known-plaintext check after derivation

function deriveKey(masterPassword: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(masterPassword, salt, iterations, KEY_LEN_BYTES, 'sha256')
}

interface AesGcmResult {
  iv: string
  ciphertext: string // ciphertext || authTag — both base64
}

function aesGcmEncrypt(key: Buffer, plaintext: string): AesGcmResult {
  const iv = randomBytes(IV_LEN_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([enc, tag])
  return { iv: iv.toString('base64'), ciphertext: blob.toString('base64') }
}

function aesGcmDecrypt(key: Buffer, ivB64: string, ciphertextB64: string): string {
  const iv = Buffer.from(ivB64, 'base64')
  const blob = Buffer.from(ciphertextB64, 'base64')
  const tag = blob.subarray(blob.length - 16)
  const enc = blob.subarray(0, blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return dec.toString('utf8')
}

// ── Master key state — held in memory only ───────────────────────────────────
// Unlock derives the key once and caches it here; lock zeros it out.

let cachedKey: Buffer | null = null

export function isUnlocked(): boolean {
  return cachedKey !== null
}

export function lockVault(): void {
  if (cachedKey) cachedKey.fill(0)
  cachedKey = null
}

// ── Vault meta (existence + verifier) ────────────────────────────────────────

interface MetaRow {
  id: number
  salt: string
  verifier_iv: string
  verifier_ciphertext: string
  iterations: number
  created_at: number
  updated_at: number
}

export function getVaultMeta(): VaultMeta {
  const db = getDb()
  const row = db.prepare('SELECT * FROM vault_meta WHERE id = 1').get() as
    | MetaRow
    | undefined
  if (!row) {
    return {
      exists: false,
      iterations: ITERATIONS,
      salt: '',
      verifierIv: '',
      verifierCiphertext: ''
    }
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

/**
 * Initialize the vault with a master password. Generates a fresh salt, derives the
 * encryption key, encrypts a known plaintext as the verifier. Fails if a vault
 * already exists (use `changeMasterPassword` to re-key).
 */
export function createVault(
  masterPassword: string
): { ok: true } | { ok: false; error: string } {
  if (!masterPassword || masterPassword.length < 8) {
    return { ok: false, error: 'Master password must be at least 8 characters.' }
  }
  const db = getDb()
  const existing = db.prepare('SELECT id FROM vault_meta WHERE id = 1').get()
  if (existing) {
    return { ok: false, error: 'Vault already exists. Use unlock instead.' }
  }
  const salt = randomBytes(SALT_LEN_BYTES)
  const key = deriveKey(masterPassword, salt, ITERATIONS)
  const verifier = aesGcmEncrypt(key, VERIFIER_PLAINTEXT)
  const now = Date.now()
  db.prepare(
    `INSERT INTO vault_meta (id, salt, verifier_iv, verifier_ciphertext, iterations, created_at, updated_at)
     VALUES (1, @salt, @iv, @ct, @it, @now, @now)`
  ).run({
    salt: salt.toString('base64'),
    iv: verifier.iv,
    ct: verifier.ciphertext,
    it: ITERATIONS,
    now
  })
  cachedKey = key
  return { ok: true }
}

/**
 * Try to unlock the vault. Derives a key from the supplied password + stored salt,
 * decrypts the verifier blob — if it matches the known plaintext, the password
 * was correct and the key is cached in memory. Otherwise returns an error.
 */
export function unlockVault(
  masterPassword: string
): { ok: true } | { ok: false; error: string } {
  const meta = getVaultMeta()
  if (!meta.exists) return { ok: false, error: 'No vault yet. Create one first.' }
  const salt = Buffer.from(meta.salt, 'base64')
  const key = deriveKey(masterPassword, salt, meta.iterations)
  try {
    const plain = aesGcmDecrypt(key, meta.verifierIv, meta.verifierCiphertext)
    if (plain !== VERIFIER_PLAINTEXT) {
      key.fill(0)
      return { ok: false, error: 'Incorrect master password.' }
    }
    cachedKey = key
    return { ok: true }
  } catch {
    key.fill(0)
    return { ok: false, error: 'Incorrect master password.' }
  }
}

/**
 * Rotate the master password. Verifies the current password, derives a fresh key
 * from the new password against a NEW salt (and the latest iteration count, so an
 * older vault's KDF cost is upgraded in passing), then re-encrypts the verifier
 * AND every entry's secret under the new key.
 *
 * Correctness is the whole point here: a half-rotated vault, some entries under
 * the old key and some under the new, is unrecoverable. So every secret is
 * re-encrypted in memory FIRST (a decryption failure aborts before any write),
 * and the meta row plus all entry rows are rewritten inside a single
 * transaction that rolls back entirely on any error. On success the session
 * stays unlocked under the new key.
 */
export function changeMasterPassword(
  currentPassword: string,
  newPassword: string
): { ok: true } | { ok: false; error: string } {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: 'New master password must be at least 8 characters.' }
  }
  const meta = getVaultMeta()
  if (!meta.exists) return { ok: false, error: 'No vault yet. Create one first.' }

  // Verify the current password against the stored verifier.
  const oldSalt = Buffer.from(meta.salt, 'base64')
  const oldKey = deriveKey(currentPassword, oldSalt, meta.iterations)
  try {
    if (aesGcmDecrypt(oldKey, meta.verifierIv, meta.verifierCiphertext) !== VERIFIER_PLAINTEXT) {
      oldKey.fill(0)
      return { ok: false, error: 'Current master password is incorrect.' }
    }
  } catch {
    oldKey.fill(0)
    return { ok: false, error: 'Current master password is incorrect.' }
  }

  const newSalt = randomBytes(SALT_LEN_BYTES)
  const newKey = deriveKey(newPassword, newSalt, ITERATIONS)

  const db = getDb()
  const rows = db
    .prepare('SELECT id, iv, ciphertext FROM vault_entries')
    .all() as Array<{ id: string; iv: string; ciphertext: string }>

  // Re-encrypt every secret under the new key up front. If any entry can't be
  // decrypted with the old key, abort before touching the database.
  const reEncrypted: Array<{ id: string; iv: string; ciphertext: string }> = []
  try {
    for (const r of rows) {
      const secret = aesGcmDecrypt(oldKey, r.iv, r.ciphertext)
      const enc = aesGcmEncrypt(newKey, secret)
      reEncrypted.push({ id: r.id, iv: enc.iv, ciphertext: enc.ciphertext })
    }
  } catch {
    oldKey.fill(0)
    newKey.fill(0)
    return {
      ok: false,
      error: 'Could not re-encrypt an existing entry, so nothing was changed. Your vault is unchanged.'
    }
  }

  const newVerifier = aesGcmEncrypt(newKey, VERIFIER_PLAINTEXT)
  const now = Date.now()

  try {
    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE vault_meta SET salt = @salt, verifier_iv = @iv, verifier_ciphertext = @ct,
           iterations = @it, updated_at = @now WHERE id = 1`
      ).run({
        salt: newSalt.toString('base64'),
        iv: newVerifier.iv,
        ct: newVerifier.ciphertext,
        it: ITERATIONS,
        now
      })
      const upd = db.prepare(
        'UPDATE vault_entries SET iv = @iv, ciphertext = @ct, updated_at = @now WHERE id = @id'
      )
      for (const e of reEncrypted) {
        upd.run({ id: e.id, iv: e.iv, ct: e.ciphertext, now })
      }
    })
    apply()
  } catch (e) {
    oldKey.fill(0)
    newKey.fill(0)
    return { ok: false, error: `Re-keying failed and was rolled back: ${(e as Error).message}` }
  }

  // Keep the session unlocked under the new key.
  if (cachedKey) cachedKey.fill(0)
  oldKey.fill(0)
  cachedKey = newKey
  // Every alternative unlock method is holding a wrapping of the OLD key. Those
  // would now fail the verifier — correctly, but they would present as "Touch
  // ID is broken" rather than "Touch ID needs setting up again", so they are
  // dropped here and re-enrolled by the caller while the vault is still open.
  notifyRekeyed()
  return { ok: true }
}

// ── Unlocking by key, for alternative unlock methods ─────────────────────────
// See `main/vaultUnlock.ts`. A method (Touch ID today; Secure Enclave, a
// passkey or a hardware key later) stores the derived key wrapped, and hands it
// back here once the user has satisfied it.
//
// This module deliberately knows nothing about those methods — it only knows
// how to accept a key and how to hand one out. That keeps the crypto in one
// place and lets methods be added without touching it, and it keeps the
// electron imports those methods need out of the database layer.

/**
 * Unlock with a key that something else was holding, rather than a password.
 *
 * The key is NOT trusted on arrival: it is checked against the same verifier a
 * password goes through, so a stale wrapping (from before a master-password
 * change) or a tampered blob is refused exactly as a wrong password is. There
 * is no shortcut here that a password does not also take.
 */
export function unlockWithKey(key: Buffer): { ok: true } | { ok: false; error: string } {
  const meta = getVaultMeta()
  if (!meta.exists) return { ok: false, error: 'No vault yet. Create one first.' }
  if (key.length !== KEY_LEN_BYTES) return { ok: false, error: 'Stored key is malformed.' }
  try {
    if (aesGcmDecrypt(key, meta.verifierIv, meta.verifierCiphertext) !== VERIFIER_PLAINTEXT) {
      return { ok: false, error: 'Stored key no longer matches this vault.' }
    }
  } catch {
    return { ok: false, error: 'Stored key no longer matches this vault.' }
  }
  if (cachedKey) cachedKey.fill(0)
  cachedKey = Buffer.from(key)
  return { ok: true }
}

/**
 * A copy of the live key, for an unlock method to wrap at enrolment time.
 *
 * A copy rather than the key itself, so that a caller zeroing what it was given
 * cannot lock the session out from under the user. Returns null when locked —
 * you can only enrol a vault you have already opened.
 */
export function getUnlockedKeyCopy(): Buffer | null {
  return cachedKey ? Buffer.from(cachedKey) : null
}

/**
 * Called after the master password changes, because every wrapped copy of the
 * old key is now useless. Registered by the IPC layer rather than imported
 * here, to keep this module free of electron.
 */
type RekeyListener = () => void
const rekeyListeners: RekeyListener[] = []

export function onVaultRekeyed(fn: RekeyListener): void {
  rekeyListeners.push(fn)
}

function notifyRekeyed(): void {
  for (const fn of rekeyListeners) {
    try {
      fn()
    } catch {
      // A listener must never be able to fail a completed re-key.
    }
  }
}

// ── Entry CRUD ───────────────────────────────────────────────────────────────

interface EntryRow {
  id: string
  title: string
  url: string | null
  username: string | null
  iv: string
  ciphertext: string
  sort_order: number
  created_at: number
  updated_at: number
}

function rowToEntry(row: EntryRow): VaultEntryStored {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    username: row.username,
    iv: row.iv,
    ciphertext: row.ciphertext,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listEntries(): VaultEntryStored[] {
  if (!isUnlocked()) return []
  const db = getDb()
  const rows = db
    .prepare(
      'SELECT * FROM vault_entries WHERE org_id = ? ORDER BY sort_order ASC, created_at ASC'
    )
    .all(getActiveOrgId()) as EntryRow[]
  return rows.map(rowToEntry)
}

function nextSortOrder(): number {
  const db = getDb()
  const r = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM vault_entries WHERE org_id = ?')
    .get(getActiveOrgId()) as { next: number }
  return r.next
}

export function createEntry(draft: VaultEntryDraft): VaultEntryStored | null {
  if (!isUnlocked()) return null
  const db = getDb()
  const id = randomUUID()
  const now = Date.now()
  db.prepare(
    `INSERT INTO vault_entries (id, title, url, username, iv, ciphertext, sort_order, created_at, updated_at, org_id)
     VALUES (@id, @title, @url, @username, @iv, @ct, @sortOrder, @now, @now, @orgId)`
  ).run({
    id,
    title: draft.title,
    url: draft.url ?? null,
    username: draft.username ?? null,
    iv: draft.iv,
    ct: draft.ciphertext,
    sortOrder: nextSortOrder(),
    orgId: getActiveOrgId(),
    now
  })
  const row = db
    .prepare('SELECT * FROM vault_entries WHERE id = ?')
    .get(id) as EntryRow
  return rowToEntry(row)
}

export function updateEntry(
  id: string,
  patch: VaultEntryPatch
): VaultEntryStored | null {
  if (!isUnlocked()) return null
  const db = getDb()
  const fields: string[] = []
  const params: Record<string, unknown> = { id, now: Date.now() }
  const cols: Array<[keyof VaultEntryPatch, string]> = [
    ['title', 'title'],
    ['url', 'url'],
    ['username', 'username'],
    ['iv', 'iv'],
    ['ciphertext', 'ciphertext']
  ]
  for (const [key, col] of cols) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = @${key}`)
      params[key] = patch[key]
    }
  }
  if (fields.length === 0) {
    const row = db
      .prepare('SELECT * FROM vault_entries WHERE id = ?')
      .get(id) as EntryRow | undefined
    return row ? rowToEntry(row) : null
  }
  fields.push('updated_at = @now')
  // Scope by the active org too, so an id from one org cannot be mutated while
  // another org is active (the by-id mutations were previously org-blind).
  params.orgId = getActiveOrgId()
  db.prepare(`UPDATE vault_entries SET ${fields.join(', ')} WHERE id = @id AND org_id = @orgId`).run(params)
  const row = db
    .prepare('SELECT * FROM vault_entries WHERE id = ? AND org_id = ?')
    .get(id, getActiveOrgId()) as EntryRow | undefined
  return row ? rowToEntry(row) : null
}

export function deleteEntry(id: string): boolean {
  if (!isUnlocked()) return false
  const db = getDb()
  const r = db.prepare('DELETE FROM vault_entries WHERE id = ? AND org_id = ?').run(id, getActiveOrgId())
  return r.changes > 0
}

// ── Encryption helpers exposed via IPC ───────────────────────────────────────
// Renderer never sees the key. It sends plaintext for encryption, gets ciphertext
// back, and sends ciphertext for decryption, getting plaintext back. Both fail if
// the vault is locked.

export function encryptWithMaster(plaintext: string): AesGcmResult | null {
  if (!cachedKey) return null
  return aesGcmEncrypt(cachedKey, plaintext)
}

export function decryptWithMaster(iv: string, ciphertext: string): string | null {
  if (!cachedKey) return null
  try {
    return aesGcmDecrypt(cachedKey, iv, ciphertext)
  } catch {
    return null
  }
}
