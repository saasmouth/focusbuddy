// The connection vault (SPEC-CONNECTIONS.md §3): local-only credentials,
// encrypted with the OS credential store.
//
// Same mechanism as Plexii's existing secrets.json (Electron safeStorage, whose
// key lives in the macOS Keychain), but a separate file keyed by vault
// reference, because Connections holds many identities per provider and the
// existing store has one slot each. Writes are atomic (temp file + rename) so
// a crash mid-write can't leave half a rotated token.
//
// Nothing here logs, returns or throws a secret value. The renderer has no
// path to `get`: only the broker in main calls it.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface VaultCrypto {
  available(): boolean
  encrypt(plain: string): Buffer
  decrypt(cipher: Buffer): string
}

export interface Vault {
  available(): boolean
  set(ref: string, secret: string): void
  get(ref: string): string | null
  has(ref: string): boolean
  clear(ref: string): void
}

export class VaultUnavailableError extends Error {
  constructor() {
    super('This Mac can’t encrypt credentials right now, so Plexii won’t store one.')
    this.name = 'VaultUnavailableError'
  }
}

interface VaultFile {
  v: 1
  entries: Record<string, string>
}

export function createVault(filePath: string, crypto: VaultCrypto): Vault {
  function read(): VaultFile {
    if (!existsSync(filePath)) return { v: 1, entries: {} }
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as VaultFile
      return parsed && parsed.entries ? parsed : { v: 1, entries: {} }
    } catch {
      return { v: 1, entries: {} }
    }
  }

  function write(f: VaultFile): void {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 })
    renameSync(tmp, filePath)
  }

  return {
    available: () => crypto.available(),
    set(ref, secret) {
      if (!crypto.available()) throw new VaultUnavailableError()
      if (!secret) throw new Error('Nothing to store.')
      const f = read()
      f.entries[ref] = crypto.encrypt(secret).toString('base64')
      write(f)
    },
    get(ref) {
      const enc = read().entries[ref]
      if (!enc || !crypto.available()) return null
      try {
        return crypto.decrypt(Buffer.from(enc, 'base64'))
      } catch {
        return null
      }
    },
    has(ref) {
      return Boolean(read().entries[ref])
    },
    clear(ref) {
      const f = read()
      if (!(ref in f.entries)) return
      delete f.entries[ref]
      write(f)
    }
  }
}

// Vault references. One per connection for its key or token; MCP OAuth tokens
// are stored as one JSON value so a refresh rotation lands atomically.
export const vaultRef = {
  key: (connectionId: string) => `conn:${connectionId}:key`,
  oauth: (connectionId: string) => `conn:${connectionId}:oauth`
}

let electronVault: Vault | null = null

// The app's vault: userData/connection-secrets.json via safeStorage. Loaded
// lazily so tests and the web runtime never import electron.
export async function getElectronVault(): Promise<Vault> {
  if (electronVault) return electronVault
  const { app, safeStorage } = await import('electron')
  const { join } = await import('node:path')
  electronVault = createVault(join(app.getPath('userData'), 'connection-secrets.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b)
  })
  return electronVault
}
