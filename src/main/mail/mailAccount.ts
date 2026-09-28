// Mail account config — the IMAP connection details for the user's own
// mailbox. PlexiDesk talks to the mail server directly from the desktop, so
// the credentials live locally and never touch the signal server. The password
// is encrypted at rest with Electron safeStorage, exactly like the API keys in
// settingsStore; the rest of the config (host, port, user) is non-secret and
// stored in clear so the Settings panel can show what's connected.
//
// This is deliberately IMAP-only for now. OAuth (Gmail/Outlook) can layer on
// later as an alternative way to populate the same account record.

import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getActiveOrgId, PERSONAL_ORG_ID } from '../db/activeOrg'

export interface MailAccountConfig {
  // IMAP server, e.g. imap.gmail.com / outlook.office365.com / mail.fastmail.com
  host: string
  port: number
  // true for implicit TLS (993), false for STARTTLS/plain (143)
  secure: boolean
  // The full login, usually the email address.
  user: string
  // App-specific password for providers that require one (Gmail, iCloud,
  // Fastmail with 2FA). Stored encrypted, never returned to the renderer.
  password: string
  // The from-address shown in the UI; defaults to `user` when blank.
  email?: string
}

// What the renderer is allowed to see — everything except the password.
export type MailAccountPublic = Omit<MailAccountConfig, 'password'> & {
  configured: boolean
}

interface StoredEnvelope {
  host: string
  port: number
  secure: boolean
  user: string
  email?: string
  // Base64 safeStorage ciphertext of the password.
  passwordCipher: string
  v: 1
}

// Each organisation has its own mailbox on this device, so the account file is
// keyed by the active org. The pre-multi-org single file (mail-account.json)
// belongs to the user's Personal space, so it is migrated to the personal-org
// file the first time Personal is active and the new file doesn't exist yet.
function legacyFilePath(): string {
  return join(app.getPath('userData'), 'mail-account.json')
}

function filePath(): string {
  const orgId = getActiveOrgId()
  const path = join(app.getPath('userData'), `mail-account-${orgId}.json`)
  if (orgId === PERSONAL_ORG_ID && !existsSync(path)) {
    const legacy = legacyFilePath()
    if (existsSync(legacy)) {
      try {
        renameSync(legacy, path)
      } catch {
        return legacy
      }
    }
  }
  return path
}

function read(): StoredEnvelope | null {
  try {
    if (!existsSync(filePath())) return null
    const parsed = JSON.parse(readFileSync(filePath(), 'utf-8')) as Partial<StoredEnvelope>
    if (!parsed.host || !parsed.user || !parsed.passwordCipher) return null
    return {
      host: parsed.host,
      port: typeof parsed.port === 'number' ? parsed.port : 993,
      secure: parsed.secure !== false,
      user: parsed.user,
      email: parsed.email,
      passwordCipher: parsed.passwordCipher,
      v: 1
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailAccount] read failed:', err)
    return null
  }
}

/** True when an account is saved AND its password can be decrypted. */
export function isConfigured(): boolean {
  return read() !== null && safeStorage.isEncryptionAvailable()
}

/** The renderer-safe view: host/port/user/email + a configured flag. */
export function getPublic(): MailAccountPublic {
  const env = read()
  if (!env) {
    return { configured: false, host: '', port: 993, secure: true, user: '', email: '' }
  }
  return {
    configured: true,
    host: env.host,
    port: env.port,
    secure: env.secure,
    user: env.user,
    email: env.email || env.user
  }
}

/** The full config including the decrypted password — main-process only. */
/**
 * The connected login, lowercased, or null when no mailbox is connected.
 *
 * Separate from getFull() because the local mail store needs only the account KEY
 * — to know which partition of the store to read — and getFull() decrypts the
 * password to hand back a whole config. Decrypting a secret to read a username is
 * the wrong trade when it happens on every widget summary.
 */
export function getAccountKey(): string | null {
  const env = read()
  return env ? env.user.trim().toLowerCase() : null
}

export function getFull(): MailAccountConfig | null {
  const env = read()
  if (!env) return null
  if (!safeStorage.isEncryptionAvailable()) return null
  let password: string
  try {
    password = safeStorage.decryptString(Buffer.from(env.passwordCipher, 'base64'))
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailAccount] decrypt failed:', err)
    return null
  }
  return {
    host: env.host,
    port: env.port,
    secure: env.secure,
    user: env.user,
    email: env.email || env.user,
    password
  }
}

/** Persist an account. Throws if OS encryption is unavailable. */
export function save(config: MailAccountConfig): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable on this machine, so PlexiDesk will ' +
        'not store your mail password in plaintext. Set a login keychain (macOS) ' +
        'or install libsecret (Linux) and try again.'
    )
  }
  const passwordCipher = safeStorage.encryptString(config.password).toString('base64')
  const envelope: StoredEnvelope = {
    host: config.host.trim(),
    port: config.port,
    secure: config.secure,
    user: config.user.trim(),
    email: (config.email || config.user).trim(),
    passwordCipher,
    v: 1
  }
  writeFileSync(filePath(), JSON.stringify(envelope, null, 2), 'utf-8')
}

/** Forget the connected account. */
export function clear(): void {
  try {
    if (existsSync(filePath())) unlinkSync(filePath())
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mailAccount] clear failed:', err)
  }
}
