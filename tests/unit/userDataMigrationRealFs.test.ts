// The workspace move against a REAL filesystem.
//
// resolveUserDataDir is unit-tested against a fake fs for every branch, which
// is the right way to pin the decisions. This is the companion check that the
// decision survives contact with the actual syscalls: that the rename moves a
// populated directory, that the pointer left at the old name really resolves to
// the new one, and that data written before the move is readable through BOTH
// paths afterwards. Getting this wrong does not throw — it silently presents an
// empty app — so it is worth proving on disk once.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, symlinkSync, rmSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CURRENT_DIR_NAME,
  LEGACY_DIR_NAMES,
  resolveUserDataDir,
  type UserDataFs
} from '../../src/main/userDataMigration'

let scratch: string | null = null
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = null
})

/** The same operations index.ts hands the resolver, unmocked. */
const realFs: UserDataFs = {
  exists: (p) => existsSync(p),
  rename: (from, to) => renameSync(from, to),
  isNonEmpty: (p) => {
    try {
      return readdirSync(p).length > 0
    } catch {
      return false
    }
  },
  linkBack: (target, at) => symlinkSync(target, at, 'dir')
}

describe('resolveUserDataDir on a real filesystem', () => {
  it('moves a populated workspace and leaves a working pointer behind', () => {
    scratch = mkdtempSync(join(tmpdir(), 'plexii-userdata-'))
    const newestLegacy = LEGACY_DIR_NAMES[LEGACY_DIR_NAMES.length - 1]!
    const legacyDir = join(scratch, newestLegacy)
    mkdirSync(legacyDir)
    // Stand in for the database and a blob beside it.
    writeFileSync(join(legacyDir, 'focusbuddy.db'), 'PRETEND-SQLITE')
    mkdirSync(join(legacyDir, 'files'))
    writeFileSync(join(legacyDir, 'files', 'a.bin'), 'BLOB')

    const { dir, outcome } = resolveUserDataDir(scratch, realFs, join)

    expect(outcome).toBe('migrated')
    expect(dir).toBe(join(scratch, CURRENT_DIR_NAME))

    // The data is at the new name, intact.
    expect(readFileSync(join(dir, 'focusbuddy.db'), 'utf8')).toBe('PRETEND-SQLITE')
    expect(readFileSync(join(dir, 'files', 'a.bin'), 'utf8')).toBe('BLOB')

    // The old name is a symlink, not a copy.
    expect(lstatSync(legacyDir).isSymbolicLink()).toBe(true)

    // And an older build, which pins the old name, reads the same workspace
    // through it — the downgrade path.
    expect(readFileSync(join(legacyDir, 'focusbuddy.db'), 'utf8')).toBe('PRETEND-SQLITE')

    // A write through the old path is visible at the new one: one workspace,
    // two names, not two diverging copies.
    writeFileSync(join(legacyDir, 'written-via-old-name'), 'x')
    expect(existsSync(join(dir, 'written-via-old-name'))).toBe(true)
  })

  it('is a no-op on a fresh install', () => {
    scratch = mkdtempSync(join(tmpdir(), 'plexii-userdata-'))
    const { dir, outcome } = resolveUserDataDir(scratch, realFs, join)
    expect(outcome).toBe('default')
    expect(dir).toBe(join(scratch, CURRENT_DIR_NAME))
    // Nothing is created just by deciding.
    expect(existsSync(dir)).toBe(false)
  })

  it('touches nothing when both names already exist', () => {
    scratch = mkdtempSync(join(tmpdir(), 'plexii-userdata-'))
    const newestLegacy = LEGACY_DIR_NAMES[LEGACY_DIR_NAMES.length - 1]!
    const legacyDir = join(scratch, newestLegacy)
    const currentDir = join(scratch, CURRENT_DIR_NAME)
    mkdirSync(legacyDir)
    writeFileSync(join(legacyDir, 'old.db'), 'OLD')
    mkdirSync(currentDir)
    writeFileSync(join(currentDir, 'new.db'), 'NEW')

    const { dir, outcome } = resolveUserDataDir(scratch, realFs, join)

    // Merging two databases is how data gets lost, so a human decides.
    expect(outcome).toBe('both-exist')
    expect(dir).toBe(legacyDir)
    expect(readFileSync(join(legacyDir, 'old.db'), 'utf8')).toBe('OLD')
    expect(readFileSync(join(currentDir, 'new.db'), 'utf8')).toBe('NEW')
    expect(lstatSync(legacyDir).isSymbolicLink()).toBe(false)
  })
})
