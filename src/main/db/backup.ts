import { app } from 'electron'
import Database from 'better-sqlite3'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync
} from 'fs'
import { join } from 'path'
import { closeDb, databaseFilePath, getDb } from './database'

// Backup / export / restore for the single-file SQLite database.
//
// "Backup" here is a transactionally-consistent online snapshot via
// better-sqlite3's backup() — safe to take while the app is running and in WAL
// mode, and it consolidates into ONE self-contained file with no -wal/-shm
// sidecars, so a backup is a single portable artifact the user can move,
// archive, or restore on another machine.
//
// NOT included, and deliberately so: API keys live in the OS keychain via
// Electron safeStorage (machine-bound), not in this database, so they can't be
// carried in a portable file. The UI says so; the user re-enters keys after a
// cross-machine restore.

const BACKUP_EXT = 'fbbackup'
const AUTO_PREFIX = 'auto-'
const RESTORE_SNAPSHOT_PREFIX = 'before-restore-'
const KEEP_AUTO = 7 // rotate: keep the last 7 automatic snapshots
const AUTO_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000 // at most one auto-backup / 12h

export interface BackupFile {
  name: string
  path: string
  mtimeMs: number
  size: number
}

export function backupsDir(): string {
  return join(app.getPath('userData'), 'backups')
}

function ensureBackupsDir(): string {
  const dir = backupsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Filesystem-safe, sortable timestamp: 2026-06-15T18-30-12.
function timestamp(): string {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '')
}

export function defaultExportName(): string {
  return `PlexiiDesk-backup-${timestamp()}.${BACKUP_EXT}`
}

/** Consistent online snapshot of the live database to destPath. */
export async function createBackup(destPath: string): Promise<void> {
  await getDb().backup(destPath)
}

/**
 * Validate that a file is a usable PlexiDesk database before we let the user
 * restore from it: open read-only, run an integrity check, and confirm a core
 * table exists. Returns a reason on failure so the UI can explain rather than
 * silently refuse.
 */
export function validateBackupFile(
  path: string
): { ok: true } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: 'That file no longer exists.' }
  let probe: Database.Database | null = null
  try {
    probe = new Database(path, { readonly: true, fileMustExist: true })
    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      return {
        ok: false,
        error: 'That backup failed an integrity check and may be corrupt.'
      }
    }
    const core = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'")
      .get()
    if (!core) {
      return { ok: false, error: 'That file is a database, but not a PlexiiDesk backup.' }
    }
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: `Could not read that file as a database: ${(e as Error).message}`
    }
  } finally {
    probe?.close()
  }
}

function removeDbFiles(livePath: string): void {
  for (const sidecar of ['', '-wal', '-shm']) {
    const p = `${livePath}${sidecar}`
    if (existsSync(p)) rmSync(p)
  }
}

/**
 * Replace the live database with the contents of srcPath. Safety first: snapshot
 * the CURRENT database to the backups folder before overwriting, so a regretted
 * restore is itself recoverable. Close the handle, swap the file (and its WAL/
 * SHM sidecars), reopen against the restored data. If the swap fails, roll back
 * from the just-made safety snapshot so the user is never left empty. The caller
 * reloads the UI afterwards so every view re-reads the new database.
 */
export async function restoreFromFile(
  srcPath: string
): Promise<{ ok: true; safetyBackupPath: string } | { ok: false; error: string }> {
  const valid = validateBackupFile(srcPath)
  if (!valid.ok) return valid

  const dir = ensureBackupsDir()
  const safetyBackupPath = join(dir, `${RESTORE_SNAPSHOT_PREFIX}${timestamp()}.${BACKUP_EXT}`)
  try {
    await createBackup(safetyBackupPath)
  } catch (e) {
    return {
      ok: false,
      error: `Could not back up your current data before restoring, so nothing was changed: ${(e as Error).message}`
    }
  }

  const livePath = databaseFilePath()
  try {
    closeDb()
    removeDbFiles(livePath)
    copyFileSync(srcPath, livePath)
  } catch (e) {
    // Roll back from the safety snapshot so the user keeps their data.
    try {
      removeDbFiles(livePath)
      copyFileSync(safetyBackupPath, livePath)
    } catch {
      /* best effort — the safety snapshot still exists on disk regardless */
    }
    getDb()
    return {
      ok: false,
      error: `Restore failed and your previous data was put back: ${(e as Error).message}`
    }
  }

  getDb() // reopen against restored data
  return { ok: true, safetyBackupPath }
}

export function listBackups(dir = backupsDir()): BackupFile[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => n.endsWith(`.${BACKUP_EXT}`))
    .map((name) => {
      const path = join(dir, name)
      const st = statSync(path)
      return { name, path, mtimeMs: st.mtimeMs, size: st.size }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function listAutoBackups(dir: string): BackupFile[] {
  return listBackups(dir).filter((b) => b.name.startsWith(AUTO_PREFIX))
}

function pruneAutoBackups(dir: string): void {
  for (const old of listAutoBackups(dir).slice(KEEP_AUTO)) {
    try {
      rmSync(old.path)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Automatic rotating backup, called once at launch. Skips if a recent auto-
 * backup already exists (so quick relaunches don't spam), skips a brand-new
 * empty database (nothing to protect yet), and prunes to the newest KEEP_AUTO.
 * Never throws — a failed safety backup must never block boot.
 */
export function autoBackupOnLaunch(): void {
  try {
    const dir = ensureBackupsDir()
    const autos = listAutoBackups(dir)
    const newest = autos[0]
    if (newest && Date.now() - newest.mtimeMs < AUTO_MIN_INTERVAL_MS) return

    const hasData = getDb().prepare('SELECT 1 FROM nodes LIMIT 1').get() != null
    if (!hasData && autos.length === 0) return

    const dest = join(dir, `${AUTO_PREFIX}${timestamp()}.${BACKUP_EXT}`)
    void getDb()
      .backup(dest)
      .then(
        () => pruneAutoBackups(dir),
        () => {
          /* best-effort safety net */
        }
      )
  } catch {
    /* never block boot */
  }
}

/** Summary for the settings UI. */
export function backupInfo(): { dir: string; count: number; lastBackupMs: number | null } {
  const all = listBackups()
  return { dir: backupsDir(), count: all.length, lastBackupMs: all[0]?.mtimeMs ?? null }
}
